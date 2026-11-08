import Foundation

/// Japanese reasons for a failed Drive write. Drive's own English messages are
/// kept in `server` for diagnostics but never shown on screen.
enum KMDriveUploadError: Error, LocalizedError {
    case notSignedIn
    case unauthorized
    case server(status: Int, message: String?)
    case invalidResponse
    case network(any Error)

    var errorDescription: String? {
        switch self {
        case .notSignedIn:
            return "Google Driveと連携していません。"
        case .unauthorized:
            return "Google Driveの認証が切れています。連携し直してください。"
        case .server(let status, _):
            return "Google Driveがエラーを返しました（\(status)）。時間をおいてもう一度お試しください。"
        case .invalidResponse:
            return "Google Driveからの応答を確認できませんでした。"
        case .network:
            return "Google Driveへ接続できませんでした。通信状態を確認してください。"
        }
    }
}

/// The one write path used by `KMDriveSyncModel`. Tests substitute a stub so the
/// model never needs Google Sign-In or a real HTTP connection.
@MainActor
protocol KMDriveSnapshotWriting {
    func upload(data: Data) async throws
}

/// Writes `KakeiMatch/snapshot.json` through the Drive REST API. The app never
/// reads the file back and never deletes it. Only three operations are used:
/// create the folder, create the file, and replace the file's media.
///
/// The scopes are `drive.file`, so this code can only see files this app made.
/// Tokens, Authorization headers, and snapshot bodies must not be logged.
@MainActor
struct KMDriveSnapshotWriter: KMDriveSnapshotWriting {
    typealias AccessTokenProvider = @MainActor () async throws -> String
    typealias Send = @MainActor (URLRequest) async throws -> (Data, HTTPURLResponse)

    static let folderName = "KakeiMatch"
    static let fileName = "snapshot.json"

    static let filesBase = "https://www.googleapis.com/drive/v3/files"
    static let uploadBase = "https://www.googleapis.com/upload/drive/v3/files"

    private static let folderMimeType = "application/vnd.google-apps.folder"

    private let accessToken: AccessTokenProvider
    private let send: Send

    init(accessToken: @escaping AccessTokenProvider,
         send: @escaping Send = KMDriveSnapshotWriter.liveSend) {
        self.accessToken = accessToken
        self.send = send
    }

    /// The token closure itself calls `refreshTokensIfNeeded()`, so each attempt
    /// starts from the freshest token.
    func upload(data: Data) async throws {
        var didRetry = false
        while true {
            do {
                try await uploadOnce(data: data)
                return
            } catch KMDriveUploadError.unauthorized {
                // Only a 401 is retried, and only once. Server errors and network
                // failures are reported as they are so the caller does not hammer
                // Drive while the user is not looking.
                guard !didRetry else { throw KMDriveUploadError.unauthorized }
                didRetry = true
            }
        }
    }

    private func uploadOnce(data: Data) async throws {
        let token = try await accessToken()
        let folderID = try await ensureFolder(accessToken: token)
        if let fileID = try await findSnapshotFile(accessToken: token, folderID: folderID) {
            try await updateFile(accessToken: token, fileID: fileID, data: data)
        } else {
            try await createFile(accessToken: token, folderID: folderID, data: data)
        }
    }

    /// Returns the app folder's id, creating it only when the search finds none.
    private func ensureFolder(accessToken: String) async throws -> String {
        let query = "name='\(Self.folderName)' and mimeType='\(Self.folderMimeType)' and trashed=false"
        if let id = try await findFile(accessToken: accessToken, query: query,
                                       orderBy: "createdTime", includeSpaces: true) {
            return id
        }
        let metadata: [String: Any] = ["name": Self.folderName, "mimeType": Self.folderMimeType]
        guard let body = try? JSONSerialization.data(withJSONObject: metadata) else {
            throw KMDriveUploadError.invalidResponse
        }
        let object = try await requestJSON(
            accessToken: accessToken, method: "POST",
            url: URL(string: Self.filesBase)!, body: body, contentType: "application/json")
        guard let id = object["id"] as? String, !id.isEmpty else {
            throw KMDriveUploadError.invalidResponse
        }
        return id
    }

    private func findSnapshotFile(accessToken: String, folderID: String) async throws -> String? {
        let query = "name='\(Self.fileName)' and '\(folderID)' in parents and trashed=false"
        return try await findFile(accessToken: accessToken, query: query,
                                  orderBy: "createdTime", includeSpaces: false)
    }

    private func findFile(accessToken: String, query: String, orderBy: String,
                          includeSpaces: Bool) async throws -> String? {
        var components = URLComponents(string: Self.filesBase)!
        var items = [
            URLQueryItem(name: "q", value: query),
            URLQueryItem(name: "orderBy", value: orderBy),
            URLQueryItem(name: "pageSize", value: "1"),
            URLQueryItem(name: "fields", value: "files(id)"),
        ]
        if includeSpaces { items.append(URLQueryItem(name: "spaces", value: "drive")) }
        components.queryItems = items
        let object = try await requestJSON(
            accessToken: accessToken, method: "GET", url: components.url!)
        let files = object["files"] as? [[String: Any]] ?? []
        return files.first?["id"] as? String
    }

    /// Replaces the existing file's media without touching its metadata.
    private func updateFile(accessToken: String, fileID: String, data: Data) async throws {
        var components = URLComponents(string: "\(Self.uploadBase)/\(fileID)")!
        components.queryItems = [URLQueryItem(name: "uploadType", value: "media")]
        var request = URLRequest(url: components.url!)
        request.httpMethod = "PATCH"
        request.setValue("Bearer \(accessToken)", forHTTPHeaderField: "Authorization")
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.httpBody = data
        let (responseData, response) = try await sendHTTP(request)
        try checkStatus(response, data: responseData)
    }

    /// Creates the file with its parent folder in the same multipart request.
    private func createFile(accessToken: String, folderID: String, data: Data) async throws {
        var components = URLComponents(string: Self.uploadBase)!
        components.queryItems = [URLQueryItem(name: "uploadType", value: "multipart")]
        let metadata: [String: Any] = [
            "name": Self.fileName, "parents": [folderID], "mimeType": "application/json",
        ]
        guard let metadataData = try? JSONSerialization.data(withJSONObject: metadata) else {
            throw KMDriveUploadError.invalidResponse
        }
        let boundary = "KakeiMatchBoundary-\(UUID().uuidString)"
        var request = URLRequest(url: components.url!)
        request.httpMethod = "POST"
        request.setValue("Bearer \(accessToken)", forHTTPHeaderField: "Authorization")
        request.setValue("multipart/related; boundary=\(boundary)", forHTTPHeaderField: "Content-Type")
        request.httpBody = Self.multipartBody(metadata: metadataData, media: data, boundary: boundary)
        let (responseData, response) = try await sendHTTP(request)
        try checkStatus(response, data: responseData)
    }

    /// Drive's `multipart/related` layout: metadata part, media part, closing
    /// boundary with the trailing `--`.
    static func multipartBody(metadata: Data, media: Data, boundary: String) -> Data {
        var body = Data()
        body.append(Data("--\(boundary)\r\n".utf8))
        body.append(Data("Content-Type: application/json; charset=UTF-8\r\n\r\n".utf8))
        body.append(metadata)
        body.append(Data("\r\n--\(boundary)\r\n".utf8))
        body.append(Data("Content-Type: application/json\r\n\r\n".utf8))
        body.append(media)
        body.append(Data("\r\n--\(boundary)--\r\n".utf8))
        return body
    }

    private func requestJSON(accessToken: String, method: String, url: URL,
                             body: Data? = nil, contentType: String? = nil) async throws
        -> [String: Any] {
        var request = URLRequest(url: url)
        request.httpMethod = method
        request.setValue("Bearer \(accessToken)", forHTTPHeaderField: "Authorization")
        if let body { request.httpBody = body }
        if let contentType { request.setValue(contentType, forHTTPHeaderField: "Content-Type") }
        let (data, response) = try await sendHTTP(request)
        try checkStatus(response, data: data)
        guard let object = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any] else {
            throw KMDriveUploadError.invalidResponse
        }
        return object
    }

    private func sendHTTP(_ request: URLRequest) async throws -> (Data, HTTPURLResponse) {
        do {
            return try await send(request)
        } catch let error as KMDriveUploadError {
            throw error
        } catch {
            throw KMDriveUploadError.network(error)
        }
    }

    private func checkStatus(_ response: HTTPURLResponse, data: Data) throws {
        switch response.statusCode {
        case 200...299:
            return
        case 401:
            throw KMDriveUploadError.unauthorized
        default:
            let message = (((try? JSONSerialization.jsonObject(with: data)) as? [String: Any])?["error"]
                as? [String: Any])?["message"] as? String
            throw KMDriveUploadError.server(status: response.statusCode, message: message)
        }
    }

    static func liveSend(_ request: URLRequest) async throws -> (Data, HTTPURLResponse) {
        let (data, response) = try await URLSession.shared.data(for: request)
        guard let http = response as? HTTPURLResponse else {
            throw KMDriveUploadError.invalidResponse
        }
        return (data, http)
    }
}
