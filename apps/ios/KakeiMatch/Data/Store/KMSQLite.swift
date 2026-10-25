import Foundation
import SQLite3

/// Small, bound-parameter SQLite boundary. SQL and table names are never taken from an archive.
/// Owned by MainActor; no connection escapes into a View or a service.
@MainActor final class KMSQLite {
    // Connection is only used on MainActor. Unsafe annotation permits Swift 6's nonisolated deinit to close it.
    nonisolated(unsafe) private var handle: OpaquePointer?
    enum Value { case text(String), integer(Int), blob(Data), null }
    struct Row {
        var values: [String: Value]
        func string(_ key: String) -> String? { if case .text(let value) = values[key] { return value }; return nil }
        func int(_ key: String) -> Int? { if case .integer(let value) = values[key] { return value }; return nil }
        func data(_ key: String) -> Data? { if case .blob(let value) = values[key] { return value }; return nil }
        func required(_ key: String) throws -> String {
            guard let value = string(key), !value.isEmpty else { throw KMDataError.invalidData("端末DBの文字列が不正です。") }; return value
        }
        func yen(_ key: String) throws -> Int {
            guard let value = int(key) else { throw KMDataError.invalidData("端末DBの金額が整数ではありません。") }; return try KMYen.checked(value)
        }
    }
    init(url: URL, readOnly: Bool = false) throws {
        let flags = (readOnly ? SQLITE_OPEN_READONLY : SQLITE_OPEN_READWRITE | SQLITE_OPEN_CREATE) | SQLITE_OPEN_NOFOLLOW
        guard sqlite3_open_v2(url.path, &handle, flags, nil) == SQLITE_OK else {
            if let handle { sqlite3_close(handle) }; handle = nil
            throw KMDataError.invalidData("端末DBを開けません。保存済みデータは削除しないでください。")
        }
        sqlite3_busy_timeout(handle, 3000)
        sqlite3_limit(handle, SQLITE_LIMIT_LENGTH, 128 * 1024 * 1024)
        do {
            try execute("PRAGMA trusted_schema=OFF")
            if readOnly { try execute("PRAGMA query_only=ON") }
        } catch { sqlite3_close(handle); handle = nil; throw error }
    }
    deinit { if let handle { sqlite3_close(handle) } }
    func execute(_ sql: String, _ bindings: [Value] = []) throws { _ = try rows(sql, bindings) }
    func rows(_ sql: String, _ bindings: [Value] = []) throws -> [Row] {
        var statement: OpaquePointer?
        // Do not expose SQLite messages: imported schema may contain household values.
        guard sqlite3_prepare_v2(handle, sql, -1, &statement, nil) == SQLITE_OK, let statement else { throw storageError() }
        defer { sqlite3_finalize(statement) }
        guard sqlite3_bind_parameter_count(statement) == bindings.count else { throw storageError() }
        let transient = unsafeBitCast(-1, to: sqlite3_destructor_type.self)
        for (index, value) in bindings.enumerated() {
            let position = Int32(index + 1)
            let code: Int32
            switch value {
            case .text(let value): code = sqlite3_bind_text(statement, position, value, -1, transient)
            case .integer(let value): code = sqlite3_bind_int64(statement, position, Int64(value))
            case .blob(let value):
                code = value.isEmpty ? sqlite3_bind_zeroblob(statement, position, 0) : value.withUnsafeBytes {
                    sqlite3_bind_blob(statement, position, $0.baseAddress, Int32($0.count), transient)
                }
            case .null: code = sqlite3_bind_null(statement, position)
            }
            guard code == SQLITE_OK else { throw storageError() }
        }
        var result: [Row] = []
        while true {
            let code = sqlite3_step(statement)
            if code == SQLITE_DONE { return result }
            guard code == SQLITE_ROW else { throw storageError() }
            var values: [String: Value] = [:]
            for column in 0..<sqlite3_column_count(statement) {
                let name = String(cString: sqlite3_column_name(statement, column))
                switch sqlite3_column_type(statement, column) {
                case SQLITE_INTEGER: values[name] = .integer(Int(sqlite3_column_int64(statement, column)))
                case SQLITE_TEXT:
                    let count = Int(sqlite3_column_bytes(statement, column))
                    if let bytes = sqlite3_column_text(statement, column), let text = String(bytes: UnsafeBufferPointer(start: bytes, count: count), encoding: .utf8) { values[name] = .text(text) }
                    else { throw storageError() }
                case SQLITE_BLOB:
                    let count = Int(sqlite3_column_bytes(statement, column))
                    values[name] = .blob(sqlite3_column_blob(statement, column).map { Data(bytes: $0, count: count) } ?? Data())
                case SQLITE_NULL: values[name] = .null
                // REAL is intentionally not converted to a yen integer. Sort columns are sorted by SQL, not read.
                default: break
                }
            }
            result.append(Row(values: values))
        }
    }
    func transaction<T>(_ operation: () throws -> T) throws -> T {
        try execute("BEGIN IMMEDIATE")
        do { let value = try operation(); try execute("COMMIT"); return value }
        catch {
            do { try execute("ROLLBACK") } catch { throw KMDataError.invalidData("端末DBの書き込みと取り消しに失敗しました。再起動して確認してください。") }
            throw error
        }
    }
    private func storageError() -> KMDataError {
        .invalidData(sqlite3_errcode(handle) == SQLITE_FULL ? "端末の空き容量が不足しています。変更は保存されていません。" : "端末DBの読み書きに失敗しました。保存済みデータを削除せず再試行してください。")
    }
}
