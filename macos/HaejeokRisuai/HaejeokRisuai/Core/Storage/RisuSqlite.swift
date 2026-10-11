import Foundation
import SQLite3

/// Thin libsqlite3 wrapper used by the Risu relational storage layer.
/// No external dependencies — SQLite ships with macOS via libsqlite3.
final class RisuSqlite {
    private var handle: OpaquePointer?
    private(set) var path: String

    enum SqliteError: Error, CustomStringConvertible {
        case openFailed(String)
        case execFailed(String)
        case prepareFailed(String)
        case bindFailed
        case stepFailed(String)

        var description: String {
            switch self {
            case .openFailed(let m): return "SQLite open failed: \(m)"
            case .execFailed(let m): return "SQLite exec failed: \(m)"
            case .prepareFailed(let m): return "SQLite prepare failed: \(m)"
            case .bindFailed: return "SQLite bind failed"
            case .stepFailed(let m): return "SQLite step failed: \(m)"
            }
        }
    }

    init(path: String, readOnly: Bool = false) throws {
        self.path = path
        let flags = readOnly ? SQLITE_OPEN_READONLY : (SQLITE_OPEN_READWRITE | SQLITE_OPEN_CREATE)
        if sqlite3_open_v2(path, &handle, flags, nil) != SQLITE_OK {
            let message = String(cString: sqlite3_errmsg(handle))
            sqlite3_close(handle)
            throw SqliteError.openFailed(message)
        }
        // Recommended by the schema: WAL journal mode for concurrent reader/writer.
        try exec("PRAGMA journal_mode = WAL;")
        try exec("PRAGMA foreign_keys = ON;")
    }

    deinit {
        if let handle { sqlite3_close(handle) }
    }

    // MARK: - Low-level operations

    func exec(_ sql: String) throws {
        var errMsg: UnsafeMutablePointer<CChar>?
        if sqlite3_exec(handle, sql, nil, nil, &errMsg) != SQLITE_OK {
            let message = errMsg.map { String(cString: $0) } ?? "unknown"
            sqlite3_free(errMsg)
            throw SqliteError.execFailed(message)
        }
    }

    func transaction<T>(_ body: () throws -> T) throws -> T {
        try exec("BEGIN IMMEDIATE TRANSACTION;")
        do {
            let result = try body()
            try exec("COMMIT;")
            return result
        } catch {
            try? exec("ROLLBACK;")
            throw error
        }
    }

    /// Runs one parameterized statement, ignoring result rows.
    @discardableResult
    func execute(_ sql: String, _ bind: [SqliteValue] = []) throws -> Int {
        let stmt = try prepare(sql)
        defer { sqlite3_finalize(stmt) }
        try bindAll(stmt, bind)
        var rowsChanged = 0
        while true {
            let rc = sqlite3_step(stmt)
            if rc == SQLITE_DONE { break }
            if rc == SQLITE_ROW {
                // Some statements (RETURNING) yield rows we ignore here.
                continue
            }
            throw SqliteError.stepFailed(String(cString: sqlite3_errmsg(handle)))
        }
        rowsChanged = Int(sqlite3_changes(handle))
        return rowsChanged
    }

    /// Runs a query and maps each row with the given closure.
    func query<T>(_ sql: String, _ bind: [SqliteValue] = [], _ map: (RowReader) -> T) throws -> [T] {
        let stmt = try prepare(sql)
        defer { sqlite3_finalize(stmt) }
        try bindAll(stmt, bind)
        var out: [T] = []
        while true {
            let rc = sqlite3_step(stmt)
            if rc == SQLITE_DONE { break }
            guard rc == SQLITE_ROW else {
                throw SqliteError.stepFailed(String(cString: sqlite3_errmsg(handle)))
            }
            out.append(map(RowReader(stmt: stmt)))
        }
        return out
    }

    /// Returns the first column of the first row, or nil.
    func scalar(_ sql: String, _ bind: [SqliteValue] = []) throws -> SqliteValue {
        let stmt = try prepare(sql)
        defer { sqlite3_finalize(stmt) }
        try bindAll(stmt, bind)
        let rc = sqlite3_step(stmt)
        guard rc == SQLITE_ROW || rc == SQLITE_DONE else {
            throw SqliteError.stepFailed(String(cString: sqlite3_errmsg(handle)))
        }
        guard rc == SQLITE_ROW else { return .null }
        return RowReader(stmt: stmt).value(column: 0)
    }

    private func prepare(_ sql: String) throws -> OpaquePointer {
        var stmt: OpaquePointer?
        if sqlite3_prepare_v2(handle, sql, -1, &stmt, nil) != SQLITE_OK {
            throw SqliteError.prepareFailed(String(cString: sqlite3_errmsg(handle)))
        }
        return stmt!
    }

    private func bindAll(_ stmt: OpaquePointer, _ bind: [SqliteValue]) throws {
        for (index, value) in bind.enumerated() {
            let position = Int32(index + 1) // SQLite binds are 1-based.
            let rc: Int32
            switch value {
            case .null:
                rc = sqlite3_bind_null(stmt, position)
            case .integer(let i):
                rc = sqlite3_bind_int64(stmt, position, Int64(i))
            case .real(let d):
                rc = sqlite3_bind_double(stmt, position, d)
            case .text(let s):
                rc = sqlite3_bind_text(stmt, position, s, -1, unsafeBitCast(-1, to: sqlite3_destructor_type.self))
            case .blob(let data):
                rc = data.withUnsafeBytes { buffer -> Int32 in
                    sqlite3_bind_blob(stmt, position, buffer.baseAddress, Int32(buffer.count), unsafeBitCast(-1, to: sqlite3_destructor_type.self))
                }
            }
            if rc != SQLITE_OK {
                throw SqliteError.bindFailed
            }
        }
    }

    private func errorMessage() -> String {
        String(cString: sqlite3_errmsg(handle))
    }
}

// MARK: - Value & row reader

enum SqliteValue {
    case null
    case integer(Int64)
    case real(Double)
    case text(String)
    case blob(Data)

    var string: String? {
        if case .text(let s) = self { return s }
        return nil
    }
    var int: Int? {
        if case .integer(let i) = self { return Int(i) }
        if case .real(let d) = self { return Int(d) }
        return nil
    }
    var double: Double? {
        if case .real(let d) = self { return d }
        if case .integer(let i) = self { return Double(i) }
        return nil
    }
    var bool: Bool? { int.map { $0 != 0 } }
    var isNull: Bool {
        if case .null = self { return true }
        return false
    }
}

extension SqliteValue {
    /// Builds a bind value from an `Any?` JS-style value.
    init(_ any: Any?) {
        switch any {
        case nil, is NSNull: self = .null
        case let b as Bool: self = .integer(b ? 1 : 0)
        case let i as Int: self = .integer(Int64(i))
        case let i as Int64: self = .integer(i)
        case let d as Double: self = .real(d)
        case let s as String: self = .text(s)
        case let d as Data: self = .blob(d)
        default: self = .text("\(any!)")
        }
    }
}

struct RowReader {
    private let stmt: OpaquePointer
    init(stmt: OpaquePointer) { self.stmt = stmt }

    func value(column: Int32) -> SqliteValue {
        switch sqlite3_column_type(stmt, column) {
        case SQLITE_NULL: return .null
        case SQLITE_INTEGER: return .integer(sqlite3_column_int64(stmt, column))
        case SQLITE_FLOAT: return .real(sqlite3_column_double(stmt, column))
        case SQLITE_TEXT:
            if let cString = sqlite3_column_text(stmt, column) {
                return .text(String(cString: cString))
            }
            return .text("")
        case SQLITE_BLOB:
            let length = Int(sqlite3_column_bytes(stmt, column))
            guard length > 0 else { return .blob(Data()) }
            let pointer = sqlite3_column_blob(stmt, column)
            return .blob(Data(bytes: pointer!, count: length))
        default: return .null
        }
    }

    func string(_ column: Int32) -> String? { value(column: column).string }
    func int(_ column: Int32) -> Int? { value(column: column).int }
    func double(_ column: Int32) -> Double? { value(column: column).double }
    func bool(_ column: Int32) -> Bool? { value(column: column).bool }
}

// MARK: - Convenience bindings for the codec

extension RelationalNodeCodec.NodeRow {
    /// Bind values for inserting this row into a `*_extension_nodes` table
    /// (after the owner columns have already been bound).
    var nodeBind: [SqliteValue] {
        [
            .integer(Int64(nodeId)),
            parentNodeId.map { .integer(Int64($0)) } ?? .null,
            .integer(Int64(nodeOrder)),
            objectKey.map(SqliteValue.text) ?? .null,
            objectKeyEncoded.map(SqliteValue.text) ?? .null,
            .text(valueType.rawValue),
            textValue.map(SqliteValue.text) ?? .null,
            encodedTextValue.map(SqliteValue.text) ?? .null,
            numberValue.map(SqliteValue.real) ?? .null,
            booleanValue.map { .integer(Int64($0)) } ?? .null,
        ]
    }
}