import Foundation
import Testing
@testable import KakeiMatchCore

@MainActor
private final class DriveRequestRecorder {
    enum Reply {
        case status(Int, Data)
        case json(String)
    }

    private(set) var requests: [URLRequest] = []
    private(set) var bodies: [Data?] = []
    var reply: (URLRequest) throws -> Reply

    init(reply: @escaping (URLRequest) throws -> Reply) {
        self.reply = reply
    }

    func send(_ request: URLRequest) async throws -> (Data, HTTPURLResponse) {
        requests.append(request)
        bodies.append(request.httpBody)
        switch try reply(request) {
        case .status(let code, let data):
            return (data, HTTPURLResponse(
                url: request.url!, statusCode: code, httpVersion: nil, headerFields: nil)!)
        case .json(let value):
            return (Data(value.utf8), HTTPURLResponse(
                url: request.url!, statusCode: 200, httpVersion: nil, headerFields: nil)!)
        }
    }

    var methods: [String] { requests.map { $0.httpMethod ?? "" } }
}

@MainActor
private final class DriveTokenCounter {
    private(set) var count = 0
    private(set) var forceRefreshCalls: [Bool] = []

    func next(forceRefresh: Bool) -> String {
        count += 1
        forceRefreshCalls.append(forceRefresh)
        return "access-token-\(count)"
    }
}

/// Simulates the real bug: the SDK returns its cached token on a normal call,
/// and only a forced refresh produces a different token.
@MainActor
private final class DriveCachedTokenProvider {
    private(set) var forceRefreshCalls: [Bool] = []

    func next(forceRefresh: Bool) -> String {
        forceRefreshCalls.append(forceRefresh)
        return forceRefresh ? "fresh-token" : "stale-token"
    }
}

private func jsonData(_ value: String) -> Data { Data(value.utf8) }

private func queryValue(_ request: URLRequest, named name: String) -> String? {
    URLComponents(url: request.url!, resolvingAgainstBaseURL: false)?
        .queryItems?.first { $0.name == name }?.value
}

@MainActor
struct KMDriveSnapshotWriterTests {
    /// Empty Drive: GET folder, POST folder, GET file, POST multipart file.
    private func makeEmptyDrive(_ recorder: DriveRequestRecorder) -> (KMDriveSnapshotWriter, DriveTokenCounter) {
        let tokens = DriveTokenCounter()
        let writer = KMDriveSnapshotWriter(
            accessToken: { forceRefresh in tokens.next(forceRefresh: forceRefresh) },
            send: recorder.send)
        return (writer, tokens)
    }

    @Test func createsFolderThenMultipartFileWhenDriveIsEmpty() async throws {
        let recorder = DriveRequestRecorder { request in
            if request.httpMethod == "GET" { return .json(#"{"files":[]}"#) }
            if request.httpMethod == "POST", request.url!.path.hasSuffix("/upload/drive/v3/files") {
                return .json(#"{"id":"new-file"}"#)
            }
            if request.httpMethod == "POST" { return .json(#"{"id":"folder-1"}"#) }
            return .json("{}")
        }
        let (writer, tokens) = makeEmptyDrive(recorder)

        try await writer.upload(data: jsonData(#"{"kind":"kakeimatch-snapshot"}"#))

        #expect(recorder.methods == ["GET", "POST", "GET", "POST"])
        #expect(tokens.count == 1)
        #expect(queryValue(recorder.requests[0], named: "fields") == "files(id)")
        #expect(queryValue(recorder.requests[0], named: "spaces") == "drive")
        #expect(queryValue(recorder.requests[0], named: "q")?.contains("mimeType='application/vnd.google-apps.folder'") == true)
        #expect(queryValue(recorder.requests[2], named: "q")?.contains("'folder-1' in parents") == true)
        #expect(queryValue(recorder.requests[3], named: "uploadType") == "multipart")

        let folderBody = try #require(try JSONSerialization.jsonObject(with: recorder.bodies[1]!) as? [String: Any])
        #expect(folderBody["name"] as? String == "KakeiMatch")
        #expect(folderBody["mimeType"] as? String == "application/vnd.google-apps.folder")
    }

    @Test func updatesExistingFileWithMediaPatchAndNeverCreates() async throws {
        let recorder = DriveRequestRecorder { request in
            if request.httpMethod == "GET" {
                let query = queryValue(request, named: "q") ?? ""
                if query.contains("mimeType=") {
                    return .json(#"{"files":[{"id":"folder-1"}]}"#)
                }
                return .json(#"{"files":[{"id":"file-1"}]}"#)
            }
            return .json("{}")
        }
        let (writer, tokens) = makeEmptyDrive(recorder)

        try await writer.upload(data: jsonData(#"{"kind":"kakeimatch-snapshot"}"#))

        #expect(recorder.methods == ["GET", "GET", "PATCH"])
        #expect(tokens.count == 1)
        #expect(recorder.requests.allSatisfy {
            !($0.httpMethod == "POST")
        })
        let patch = recorder.requests[2]
        #expect(patch.url?.path.hasSuffix("/upload/drive/v3/files/file-1") == true)
        #expect(queryValue(patch, named: "uploadType") == "media")
        #expect(patch.value(forHTTPHeaderField: "Content-Type") == "application/json")
        #expect(patch.httpBody == jsonData(#"{"kind":"kakeimatch-snapshot"}"#))
    }

    @Test func retriesOnceAfter401WithAFreshToken() async throws {
        var returned401 = false
        let recorder = DriveRequestRecorder { request in
            if request.httpMethod == "GET", !returned401 {
                returned401 = true
                return .status(401, Data())
            }
            if request.httpMethod == "GET" { return .json(#"{"files":[]}"#) }
            if request.httpMethod == "POST", request.url!.path.hasSuffix("/upload/drive/v3/files") {
                return .json(#"{"id":"new-file"}"#)
            }
            if request.httpMethod == "POST" { return .json(#"{"id":"folder-1"}"#) }
            return .json("{}")
        }
        let (writer, tokens) = makeEmptyDrive(recorder)

        try await writer.upload(data: jsonData("{}"))

        #expect(tokens.count == 2)
        #expect(tokens.forceRefreshCalls == [false, true])
        #expect(recorder.methods == ["GET", "GET", "POST", "GET", "POST"])
        #expect(recorder.requests[1].value(forHTTPHeaderField: "Authorization") == "Bearer access-token-2")
    }

    @Test func retryAfter401UsesAForcedRefreshInsteadOfTheCachedToken() async throws {
        let recorder = DriveRequestRecorder { request in
            if request.httpMethod == "GET",
               request.value(forHTTPHeaderField: "Authorization") == "Bearer stale-token" {
                return .status(401, Data())
            }
            if request.httpMethod == "GET" { return .json(#"{"files":[]}"#) }
            if request.httpMethod == "POST", request.url!.path.hasSuffix("/upload/drive/v3/files") {
                return .json(#"{"id":"new-file"}"#)
            }
            if request.httpMethod == "POST" { return .json(#"{"id":"folder-1"}"#) }
            return .json("{}")
        }
        let tokens = DriveCachedTokenProvider()
        let writer = KMDriveSnapshotWriter(
            accessToken: { forceRefresh in tokens.next(forceRefresh: forceRefresh) },
            send: recorder.send)

        try await writer.upload(data: jsonData("{}"))

        #expect(tokens.forceRefreshCalls == [false, true])
        #expect(recorder.requests[1].value(forHTTPHeaderField: "Authorization") == "Bearer fresh-token")
        #expect(recorder.methods == ["GET", "GET", "POST", "GET", "POST"])
    }

    @Test func second401StopsWithUnauthorized() async throws {
        let recorder = DriveRequestRecorder { _ in .status(401, Data()) }
        let (writer, tokens) = makeEmptyDrive(recorder)

        do {
            try await writer.upload(data: jsonData("{}"))
            Issue.record("two 401 responses should throw")
        } catch let error as KMDriveUploadError {
            guard case .unauthorized = error else {
                Issue.record("expected .unauthorized, got \(error)")
                return
            }
        }
        #expect(tokens.count == 2)
        #expect(recorder.requests.count == 2, "401の再試行は1回だけにする")
    }

    @Test func serverErrorIsNotRetried() async throws {
        let recorder = DriveRequestRecorder { _ in
            .status(500, jsonData(#"{"error":{"message":"backend exploded"}}"#))
        }
        let (writer, tokens) = makeEmptyDrive(recorder)

        do {
            try await writer.upload(data: jsonData("{}"))
            Issue.record("500 should throw")
        } catch let error as KMDriveUploadError {
            guard case .server(let status, let message) = error else {
                Issue.record("expected .server, got \(error)")
                return
            }
            #expect(status == 500)
            #expect(message == "backend exploded")
            // Drive's English message stays out of the user-facing description.
            #expect(error.errorDescription?.contains("backend exploded") != true)
            #expect(error.errorDescription?.contains("500") == true)
        }
        #expect(tokens.count == 1)
        #expect(recorder.requests.count == 1)
    }

    @Test func multipartBodyHasTwoPartsAndClosingBoundary() async throws {
        let media = jsonData(#"{"kind":"kakeimatch-snapshot"}"#)
        let recorder = DriveRequestRecorder { request in
            if request.httpMethod == "GET" { return .json(#"{"files":[]}"#) }
            if request.httpMethod == "POST", request.url!.path.hasSuffix("/upload/drive/v3/files") {
                return .json(#"{"id":"new-file"}"#)
            }
            if request.httpMethod == "POST" { return .json(#"{"id":"folder-1"}"#) }
            return .json("{}")
        }
        let (writer, _) = makeEmptyDrive(recorder)

        try await writer.upload(data: media)

        let request = recorder.requests[3]
        let contentType = try #require(request.value(forHTTPHeaderField: "Content-Type"))
        #expect(contentType.hasPrefix("multipart/related; boundary="))
        let boundary = contentType.components(separatedBy: "boundary=").last ?? ""
        let body = try #require(request.httpBody)
        let text = String(decoding: body, as: UTF8.self)

        #expect(text.hasPrefix("--\(boundary)\r\n"))
        #expect(text.contains("Content-Type: application/json; charset=UTF-8\r\n\r\n"))
        #expect(text.contains("\r\n--\(boundary)\r\nContent-Type: application/json\r\n\r\n"))
        #expect(text.hasSuffix("\r\n--\(boundary)--\r\n"))

        let parts = text.components(separatedBy: "--\(boundary)")
        #expect(parts.count == 4) // preamble, metadata part, media part, closing "--"
        let metadataPart = parts[1]
        let metadataJSON = String(metadataPart.split(separator: "\r\n\r\n", maxSplits: 1).last ?? "")
        let metadata = try #require(try JSONSerialization.jsonObject(with: Data(metadataJSON.utf8)) as? [String: Any])
        #expect(metadata["name"] as? String == "snapshot.json")
        #expect(metadata["parents"] as? [String] == ["folder-1"])
        #expect(metadata["mimeType"] as? String == "application/json")
        #expect(parts[2].hasSuffix(String(decoding: media, as: UTF8.self) + "\r\n"))
    }

    @Test func everyRequestUsesOnlyDriveWriteEndpointsAndMethods() async throws {
        let recorder = DriveRequestRecorder { request in
            if request.httpMethod == "GET" {
                let query = queryValue(request, named: "q") ?? ""
                if query.contains("mimeType=") {
                    return .json(#"{"files":[{"id":"folder-1"}]}"#)
                }
                return .json(#"{"files":[{"id":"file-1"}]}"#)
            }
            return .json("{}")
        }
        let (writer, _) = makeEmptyDrive(recorder)

        try await writer.upload(data: jsonData("{}"))

        for request in recorder.requests {
            let url = try #require(request.url?.absoluteString)
            #expect(url.hasPrefix("https://www.googleapis.com/drive/v3/files")
                || url.hasPrefix("https://www.googleapis.com/upload/drive/v3/files"))
            #expect(!url.contains("alt=media"))
            #expect(["GET", "POST", "PATCH"].contains(request.httpMethod))
            #expect(request.value(forHTTPHeaderField: "Authorization") == "Bearer access-token-1")
        }
    }

    @Test func unauthorizedDescriptionAsksToConnectAgain() {
        #expect(KMDriveUploadError.notSignedIn.errorDescription == "Google Driveと連携していません。")
        #expect(KMDriveUploadError.unauthorized.errorDescription?.contains("連携し直してください") == true)
        #expect(KMDriveUploadError.invalidResponse.errorDescription?.contains("応答") == true)
        #expect(KMDriveUploadError.network(URLError(.notConnectedToInternet)).errorDescription?.contains("通信状態") == true)
    }
}
