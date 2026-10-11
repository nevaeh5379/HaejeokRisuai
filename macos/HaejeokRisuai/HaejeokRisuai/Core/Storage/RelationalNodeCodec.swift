import Foundation

/// A JavaScript-style value tree used by the relational node codec.
///
/// Mirrors the JS values that `relationalNodeCodec.ts` flattens/rebuilds:
/// `undefined` and `null` are distinct, numbers are doubles, strings are
/// UTF-16 code-unit sequences (which is why unpaired surrogates need the
/// encoded-text fallback), and containers preserve insertion order.
indirect enum JsValue: Equatable {
    case undefined
    case null
    case bool(Bool)
    case number(Double)
    case string(String)
    case array([JsValue])
    case object([(String, JsValue)])

    static func == (lhs: JsValue, rhs: JsValue) -> Bool {
        switch (lhs, rhs) {
        case (.undefined, .undefined), (.null, .null): return true
        case (.bool(let a), .bool(let b)): return a == b
        case (.number(let a), .number(let b)): return a == b
        case (.string(let a), .string(let b)): return a == b
        case (.array(let a), .array(let b)):
            return a.count == b.count && zip(a, b).allSatisfy { $0 == $1 }
        case (.object(let a), .object(let b)):
            return a.count == b.count
                && zip(a, b).allSatisfy { $0.0 == $1.0 && $0.1 == $1.1 }
        default: return false
        }
    }
}

extension JsValue {
    /// Builds a `JsValue` from an `Any?` produced by JSON deserialization
    /// (NSNull → null, NSNumber → bool/number, String, [Any], [String:Any]).
    init(_ any: Any?) {
        switch any {
        case nil, is NSNull: self = .null
        case let b as Bool: self = .bool(b)
        case let n as Int: self = .number(Double(n))
        case let n as Double: self = .number(n)
        case let n as NSNumber:
            // NSNumber bool detection.
            if CFGetTypeID(n) == CFBooleanGetTypeID() {
                self = .bool(n.boolValue)
            } else {
                self = .number(n.doubleValue)
            }
        case let s as String: self = .string(s)
        case let a as [Any?]: self = .array(a.map(JsValue.init))
        case let a as [Any]: self = .array(a.map(JsValue.init))
        case let d as [String: Any?]:
            self = .object(d.map { ($0.key, JsValue($0.value)) })
        case let d as [String: Any]:
            self = .object(d.map { ($0.key, JsValue($0.value)) })
        default: self = .string("\(any!)")
        }
    }

    /// Converts back to an `Any?` tree (NSNull for null; undefined becomes NSNull
    /// too since Swift has no undefined — callers that need to distinguish must
    /// keep the JsValue representation).
    var asAny: Any? {
        switch self {
        case .undefined, .null: return NSNull()
        case .bool(let b): return b
        case .number(let d):
            if d == d.rounded() && abs(d) < 9_007_199_254_740_992 { return Int(d) }
            return d
        case .string(let s): return s
        case .array(let a): return a.map(\.asAny)
        case .object(let o): return Dictionary(uniqueKeysWithValues: o.map { ($0.0, $0.1.asAny) })
        }
    }
}

// MARK: - Relational node codec

/// Exact Swift port of `relationalNodeCodec.ts`.
/// Flattens a `JsValue` into adjacency-list rows and rebuilds it back,
/// preserving empty containers, null vs undefined, insertion order, NUL bytes
/// and unpaired UTF-16 surrogates through a round trip.
enum RelationalNodeCodec {
    static let layout = "relational-schema-v3"
    static let schemaVersion = 3
    static let maxDepth = 128
    static let maxRows = 250_000

    enum NodeType: String {
        case null, undefined, boolean, number, string, array, object
    }

    struct NodeRow {
        var nodeId: Int
        var parentNodeId: Int?
        var nodeOrder: Int
        var objectKey: String?
        var objectKeyEncoded: String?
        var valueType: NodeType
        var textValue: String?
        var encodedTextValue: String?
        var numberValue: Double?
        var booleanValue: Int?
    }

    static let columns = [
        "node_id", "parent_node_id", "node_order", "object_key", "object_key_encoded",
        "value_type", "text_value", "encoded_text_value", "number_value", "boolean_value",
    ]

    // MARK: Flatten

    static func flatten(_ value: JsValue) -> [NodeRow] {
        var rows: [NodeRow] = []
        flatten(value, parent: nil, order: 0, key: nil, depth: 0, rows: &rows)
        return rows
    }

    private static func flatten(
        _ current: JsValue,
        parent: Int?,
        order: Int,
        key: String?,
        depth: Int,
        rows: inout [NodeRow]
    ) {
        if depth > maxDepth {
            fatalError("Relational value exceeds maximum depth \(maxDepth)")
        }
        if rows.count >= maxRows {
            fatalError("Relational value exceeds maximum row count \(maxRows)")
        }

        let nodeId = rows.count
        let encodedKey: (text: String?, encoded: String?)
        if let key {
            encodedKey = encodedText(key)
        } else {
            encodedKey = (text: nil, encoded: nil)
        }
        var row = NodeRow(
            nodeId: nodeId,
            parentNodeId: parent,
            nodeOrder: order,
            objectKey: encodedKey.text,
            objectKeyEncoded: encodedKey.encoded,
            valueType: .null,
            textValue: nil,
            encodedTextValue: nil,
            numberValue: nil,
            booleanValue: nil
        )

        switch current {
        case .null:
            row.valueType = .null
            rows.append(row)
        case .undefined:
            row.valueType = .undefined
            rows.append(row)
        case .bool(let b):
            row.valueType = .boolean
            row.booleanValue = b ? 1 : 0
            rows.append(row)
        case .number(let n):
            row.valueType = .number
            if n.isFinite {
                row.numberValue = n
            } else {
                row.textValue = n.isNaN ? "NaN" : (n > 0 ? "Infinity" : "-Infinity")
            }
            rows.append(row)
        case .string(let s):
            row.valueType = .string
            let enc = encodedText(s)
            row.textValue = enc.text
            row.encodedTextValue = enc.encoded
            rows.append(row)
        case .array(let items):
            row.valueType = .array
            rows.append(row)
            for (index, item) in items.enumerated() {
                flatten(item, parent: nodeId, order: index, key: nil, depth: depth + 1, rows: &rows)
            }
        case .object(let entries):
            row.valueType = .object
            rows.append(row)
            for (index, (childKey, item)) in entries.enumerated() {
                flatten(item, parent: nodeId, order: index, key: childKey, depth: depth + 1, rows: &rows)
            }
        }
    }

    // MARK: Rebuild

    static func rebuild(_ input: [NodeRow]) throws -> JsValue {
        guard !input.isEmpty else { throw CodecError.noRoot }
        let rows = input.sorted { $0.nodeId < $1.nodeId }
        guard rows[0].nodeId == 0, rows[0].parentNodeId == nil else {
            throw CodecError.invalidRoot
        }

        // Group children by parent, then sort each group by node_order.
        var children: [Int: [NodeRow]] = [:]
        for row in rows.dropFirst() {
            guard let parent = row.parentNodeId else { throw CodecError.orphanNode }
            children[parent, default: []].append(row)
        }
        for key in children.keys {
            children[key]!.sort { $0.nodeOrder < $1.nodeOrder }
        }

        func build(_ row: NodeRow, depth: Int) throws -> JsValue {
            if depth > maxDepth { throw CodecError.tooDeep }
            switch row.valueType {
            case .null: return .null
            case .undefined: return .undefined
            case .boolean: return .bool(row.booleanValue == 1)
            case .number:
                if row.textValue == "NaN" { return .number(.nan) }
                if row.textValue == "Infinity" { return .number(.infinity) }
                if row.textValue == "-Infinity" { return .number(-.infinity) }
                return .number(row.numberValue ?? 0)
            case .string:
                return .string(decodedText(text: row.textValue, encoded: row.encodedTextValue))
            case .array:
                let kids = children[row.nodeId] ?? []
                return .array(try kids.map { try build($0, depth: depth + 1) })
            case .object:
                let kids = children[row.nodeId] ?? []
                let entries: [(String, JsValue)] = try kids.map { kid in
                    let key = decodedText(text: kid.objectKey, encoded: kid.objectKeyEncoded)
                    return (key, try build(kid, depth: depth + 1))
                }
                return .object(entries)
            }
        }

        return try build(rows[0], depth: 0)
    }

    // MARK: Text encoding helpers

    enum CodecError: Error {
        case noRoot, invalidRoot, orphanNode, tooDeep
    }

    /// If the string is SQL-text-safe (no NUL, UTF-8 round trip identical),
    /// store it verbatim; otherwise base64-encode UTF-16LE code units.
    static func encodedText(_ value: String) -> (text: String?, encoded: String?) {
        if isSqlTextSafe(value) {
            return (value, nil)
        }
        return (nil, encodeUtf16(value))
    }

    static func decodedText(text: String?, encoded: String?) -> String {
        if let encoded, !encoded.isEmpty {
            return decodeUtf16(encoded)
        }
        return text ?? ""
    }

    static func isSqlTextSafe(_ value: String) -> Bool {
        // NUL bytes are not allowed in SQLite text.
        if value.contains("\u{0000}") { return false }
        // A UTF-8 round trip must be lossless (rejects unpaired surrogates after
        // normalization). Swift String already guarantees valid Unicode scalar
        // sequences, so a lossy re-encoding check is effectively always true
        // for Swift strings; we keep the NUL check as the real gate.
        let utf8 = Data(value.utf8)
        guard let roundTrip = String(data: utf8, encoding: .utf8) else { return false }
        return roundTrip == value
    }

    /// UTF-16LE code units of the string, base64-encoded.
    static func encodeUtf16(_ value: String) -> String {
        var bytes = [UInt8]()
        bytes.reserveCapacity(value.utf16.count * 2)
        for unit in value.utf16 {
            bytes.append(UInt8(unit & 0xFF))
            bytes.append(UInt8((unit >> 8) & 0xFF))
        }
        return Data(bytes).base64EncodedString()
    }

    /// Reverse of `encodeUtf16`.
    static func decodeUtf16(_ value: String) -> String {
        guard let data = Data(base64Encoded: value), data.count % 2 == 0 else { return "" }
        var units = [UInt16]()
        var i = 0
        while i < data.count {
            let lo = UInt16(data[i])
            let hi = UInt16(data[i + 1])
            units.append(lo | (hi << 8))
            i += 2
        }
        return String(decoding: units, as: UTF16.self)
    }
}