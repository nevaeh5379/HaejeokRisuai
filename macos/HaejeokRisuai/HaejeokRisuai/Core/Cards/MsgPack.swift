import Foundation

/// A minimal MessagePack decoder used by the legacy `.risu` save importer.
/// Produces a plain value tree: NSNull, Bool, Int64/UInt64/Double, String, Data,
/// [Any] and [String: Any].
enum MsgPack {
    enum MsgPackError: LocalizedError {
        case truncated
        case unsupported(UInt8)

        var errorDescription: String? {
            switch self {
            case .truncated: return "MessagePack data is truncated."
            case .unsupported(let b): return "Unsupported MessagePack byte 0x\(String(b, radix: 16))"
            }
        }
    }

    static func decode(_ data: Data) throws -> Any? {
        var offset = 0
        return try decodeValue([UInt8](data), &offset)
    }

    private static func decodeValue(_ b: [UInt8], _ o: inout Int) throws -> Any? {
        guard o < b.count else { throw MsgPackError.truncated }
        let byte = b[o]
        o += 1

        switch byte {
        case 0xC0: return nil
        case 0xC2: return false
        case 0xC3: return true
        case 0xC4, 0xC5, 0xC6: // bin8/16/32
            let len = try readLength(&o, b, base: byte, offsets: (0xC4, 1, 0xC5, 2, 0xC6, 4))
            guard o + len <= b.count else { throw MsgPackError.truncated }
            defer { o += len }
            return Data(b[o..<(o + len)])
        case 0xC7, 0xC8, 0xC9: // ext 8/16/32
            let len = try readLength(&o, b, base: byte, offsets: (0xC7, 1, 0xC8, 2, 0xC9, 4))
            let typeByte = try readU8(b, &o)
            guard o + len <= b.count else { throw MsgPackError.truncated }
            defer { o += len }
            return decodeExt(type: typeByte, data: Data(b[o..<(o + len)]))
        case 0xD4, 0xD5, 0xD6, 0xD7, 0xD8: // fixext 1/2/4/8/16
            let len: Int
            switch byte {
            case 0xD4: len = 1
            case 0xD5: len = 2
            case 0xD6: len = 4
            case 0xD7: len = 8
            default: len = 16
            }
            let typeByte = try readU8(b, &o)
            guard o + len <= b.count else { throw MsgPackError.truncated }
            defer { o += len }
            return decodeExt(type: typeByte, data: Data(b[o..<(o + len)]))
        case 0xCA: // float32
            guard o + 4 <= b.count else { throw MsgPackError.truncated }
            let bits = UInt32(b[o]) << 24 | UInt32(b[o+1]) << 16 | UInt32(b[o+2]) << 8 | UInt32(b[o+3])
            o += 4
            return Double(Float(bitPattern: bits))
        case 0xCB: // float64
            guard o + 8 <= b.count else { throw MsgPackError.truncated }
            var bits: UInt64 = 0
            for i in 0..<8 { bits = (bits << 8) | UInt64(b[o + i]) }
            o += 8
            return Double(bitPattern: bits)
        case 0xCC: return Int(try readU8(b, &o))
        case 0xCD: return Int(try readU16(b, &o))
        case 0xCE: return Int(try readU32(b, &o))
        case 0xCF:
            let v = try readU64(b, &o)
            return v <= UInt64(Int.max) ? Int(v) : Double(v)
        case 0xD0: return Int(Int8(bitPattern: try readU8(b, &o)))
        case 0xD1: return Int(Int16(bitPattern: try readU16(b, &o)))
        case 0xD2: return Int(Int32(bitPattern: try readU32(b, &o)))
        case 0xD3:
            let v = try readU64(b, &o)
            return Int(truncatingIfNeeded: v)
        case 0xD9, 0xDA, 0xDB: // str8/16/32
            let len = try readLength(&o, b, base: byte, offsets: (0xD9, 1, 0xDA, 2, 0xDB, 4))
            guard o + len <= b.count else { throw MsgPackError.truncated }
            defer { o += len }
            return String(decoding: b[o..<(o + len)], as: UTF8.self)
        case 0xDC: // array16
            let n = Int(try readU16(b, &o))
            return try readArray(n, b, &o)
        case 0xDD: // array32
            let n = Int(try readU32(b, &o))
            return try readArray(n, b, &o)
        case 0xDE: // map16
            let n = Int(try readU16(b, &o))
            return try readMap(n, b, &o)
        case 0xDF: // map32
            let n = Int(try readU32(b, &o))
            return try readMap(n, b, &o)
        default:
            if byte <= 0x7F { return Int(byte) }              // positive fixint
            if byte >= 0xE0 { return Int(Int8(bitPattern: byte)) } // negative fixint
            if byte >= 0x80 && byte <= 0x8F {                  // fixmap
                return try readMap(Int(byte & 0x0F), b, &o)
            }
            if byte >= 0x90 && byte <= 0x9F {                  // fixarray
                return try readArray(Int(byte & 0x0F), b, &o)
            }
            if byte >= 0xA0 && byte <= 0xBF {                  // fixstr
                let len = Int(byte & 0x1F)
                guard o + len <= b.count else { throw MsgPackError.truncated }
                defer { o += len }
                return String(decoding: b[o..<(o + len)], as: UTF8.self)
            }
            throw MsgPackError.unsupported(byte)
        }
    }

    private static func readArray(_ n: Int, _ b: [UInt8], _ o: inout Int) throws -> [Any?] {
        var arr: [Any?] = []
        arr.reserveCapacity(n)
        for _ in 0..<n {
            arr.append(try decodeValue(b, &o))
        }
        return arr
    }

    private static func readMap(_ n: Int, _ b: [UInt8], _ o: inout Int) throws -> [String: Any?] {
        var map: [String: Any?] = [:]
        map.reserveCapacity(n)
        for _ in 0..<n {
            let key = try decodeValue(b, &o)
            let value = try decodeValue(b, &o)
            let keyString: String
            switch key {
            case let s as String: keyString = s
            case let i as Int: keyString = String(i)
            case nil: keyString = "null"
            case let other: keyString = "\(other)"
            }
            map[keyString] = value
        }
        return map
    }

    private static func readLength(
        _ o: inout Int, _ b: [UInt8],
        base: UInt8, offsets: (UInt8, Int, UInt8, Int, UInt8, Int)
    ) throws -> Int {
        switch base {
        case offsets.0: return Int(try readU8(b, &o))
        case offsets.2: return Int(try readU16(b, &o))
        case offsets.4: return Int(try readU32(b, &o))
        default: throw MsgPackError.unsupported(base)
        }
    }

    private static func readU8(_ b: [UInt8], _ o: inout Int) throws -> UInt8 {
        guard o < b.count else { throw MsgPackError.truncated }
        defer { o += 1 }
        return b[o]
    }

    private static func readU16(_ b: [UInt8], _ o: inout Int) throws -> UInt16 {
        let hi = try readU8(b, &o)
        let lo = try readU8(b, &o)
        return UInt16(hi) << 8 | UInt16(lo)
    }

    private static func readU32(_ b: [UInt8], _ o: inout Int) throws -> UInt32 {
        var v: UInt32 = 0
        for _ in 0..<4 { v = v << 8 | UInt32(try readU8(b, &o)) }
        return v
    }

    private static func readU64(_ b: [UInt8], _ o: inout Int) throws -> UInt64 {
        var v: UInt64 = 0
        for _ in 0..<8 { v = v << 8 | UInt64(try readU8(b, &o)) }
        return v
    }

    /// Decodes MessagePack ext types. Timestamp (type 0xFF) → Double (unix seconds);
    /// other exts → Data blob.
    private static func decodeExt(type: UInt8, data: Data) -> Any {
        if type == 0xFF {
            // MessagePack timestamp: 32-bit (float seconds), 64-bit (nano + 30-bit seconds),
            // or 96-bit (nano + 64-bit seconds).
            let bytes = [UInt8](data)
            switch data.count {
            case 4:
                let secs = UInt32(bytes[0]) << 24 | UInt32(bytes[1]) << 16 | UInt32(bytes[2]) << 8 | UInt32(bytes[3])
                return Double(secs)
            case 8:
                let nano = UInt32(bytes[0]) << 24 | UInt32(bytes[1]) << 16 | UInt32(bytes[2]) << 8 | UInt32(bytes[3])
                let secs = UInt32(bytes[4]) << 24 | UInt32(bytes[5]) << 16 | UInt32(bytes[6]) << 8 | UInt32(bytes[7])
                return Double(secs) + Double(nano) / 1e9
            case 12:
                let nano = UInt32(bytes[0]) << 24 | UInt32(bytes[1]) << 16 | UInt32(bytes[2]) << 8 | UInt32(bytes[3])
                var secs: UInt64 = 0
                for i in 4..<12 { secs = secs << 8 | UInt64(bytes[i]) }
                return Double(secs) + Double(nano) / 1e9
            default:
                break
            }
        }
        return data
    }
}

// MARK: - Value tree helpers

extension Dictionary where Key == String, Value == Any? {
    /// Safely fetches a string field trying multiple legacy keys.
    func stringField(_ names: [String]) -> String {
        for name in names {
            if let v = self[name] {
                return ValueTree.asString(v)
            }
        }
        return ""
    }

    func optionalStringField(_ name: String) -> String? {
        guard let v = self[name] else { return nil }
        let s = ValueTree.asString(v)
        return s.isEmpty ? nil : s
    }

    func numberField(_ names: [String], fallback: Double) -> Double {
        for name in names {
            if let v = self[name], let d = ValueTree.asNumber(v) {
                return d
            }
        }
        return fallback
    }

    func boolField(_ names: [String], fallback: Bool) -> Bool {
        for name in names {
            if let v = self[name], let d = ValueTree.asBool(v) {
                return d
            }
        }
        return fallback
    }

    func arrayField(_ name: String) -> [[String: Any?]] {
        guard let arr = self[name] as? [Any?] else { return [] }
        return arr.compactMap { $0 as? [String: Any?] }
    }

    func stringArrayField(_ name: String) -> [String] {
        guard let arr = self[name] as? [Any?] else { return [] }
        return arr.map { ValueTree.asString($0) }
    }
}

enum ValueTree {
    static func asString(_ v: Any?) -> String {
        switch v {
        case let s as String: return s
        case let n as Int: return String(n)
        case let d as Double: return String(d)
        case let b as Bool: return b ? "true" : "false"
        default: return ""
        }
    }

    static func asNumber(_ v: Any?) -> Double? {
        switch v {
        case let i as Int: return Double(i)
        case let d as Double: return d
        case let b as Bool: return b ? 1 : 0
        case let s as String: return Double(s)
        default: return nil
        }
    }

    static func asBool(_ v: Any?) -> Bool? {
        switch v {
        case let b as Bool: return b
        case let i as Int: return i != 0
        default: return nil
        }
    }
}
