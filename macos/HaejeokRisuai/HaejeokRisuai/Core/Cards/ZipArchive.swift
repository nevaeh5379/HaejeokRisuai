import Compression
import Foundation

/// Minimal ZIP archive reader/writer used for `.charx` character card files.
/// Supports STORE (0) and DEFLATE (8) methods — the only ones produced by card tools.
enum ZipArchive {
    struct Entry {
        var path: String
        var data: Data
    }

    enum ZipError: LocalizedError {
        case notZip
        case unsupportedMethod(UInt16)
        case corrupted(String)

        var errorDescription: String? {
            switch self {
            case .notZip: return "Not a ZIP archive."
            case .unsupportedMethod(let m): return "Unsupported zip compression method \(m)."
            case .corrupted(let why): return "Corrupted zip archive: \(why)"
            }
        }
    }

    // MARK: - Reading

    static func read(_ data: Data) throws -> [Entry] {
        let bytes = [UInt8](data)
        guard bytes.count >= 22 else { throw ZipError.notZip }

        // Locate End Of Central Directory record (scan backwards; comment may follow).
        var eocdOffset = -1
        let scanStart = max(0, bytes.count - 22 - 65536)
        var i = bytes.count - 22
        while i >= scanStart {
            if bytes[i] == 0x50, bytes[i + 1] == 0x4B, bytes[i + 2] == 0x05, bytes[i + 3] == 0x06 {
                eocdOffset = i
                break
            }
            i -= 1
        }
        guard eocdOffset >= 0 else { throw ZipError.notZip }

        let entryCount = Int(readU16(bytes, eocdOffset + 10))
        var cdOffset = Int(readU32(bytes, eocdOffset + 16))

        var entries: [Entry] = []
        for _ in 0..<entryCount {
            guard cdOffset + 46 <= bytes.count else { break }
            guard readU32(bytes, cdOffset) == 0x02014B50 else { break }
            let method = readU16(bytes, cdOffset + 10)
            let compressedSize = Int(readU32(bytes, cdOffset + 20))
            let uncompressedSize = Int(readU32(bytes, cdOffset + 24))
            let nameLen = Int(readU16(bytes, cdOffset + 28))
            let extraLen = Int(readU16(bytes, cdOffset + 30))
            let commentLen = Int(readU16(bytes, cdOffset + 32))
            let localOffset = Int(readU32(bytes, cdOffset + 42))
            let nameStart = cdOffset + 46
            guard nameStart + nameLen <= bytes.count else { break }
            let name = String(decoding: bytes[nameStart..<(nameStart + nameLen)], as: UTF8.self)

            // Read local header to find data start.
            let lh = localOffset
            guard lh + 30 <= bytes.count, readU32(bytes, lh) == 0x04034B50 else {
                cdOffset += 46 + nameLen + extraLen + commentLen
                continue
            }
            let lNameLen = Int(readU16(bytes, lh + 26))
            let lExtraLen = Int(readU16(bytes, lh + 28))
            let dataStart = lh + 30 + lNameLen + lExtraLen

            if name.hasSuffix("/") {
                cdOffset += 46 + nameLen + extraLen + commentLen
                continue
            }

            guard dataStart + compressedSize <= bytes.count else {
                throw ZipError.corrupted("entry \(name) overruns file")
            }
            let payload = Array(bytes[dataStart..<(dataStart + compressedSize)])

            let content: Data
            switch method {
            case 0:
                content = Data(payload)
            case 8:
                guard let inflated = inflateDeflate(payload, expectedSize: max(uncompressedSize, 64)) else {
                    throw ZipError.corrupted("cannot inflate \(name)")
                }
                content = inflated
            default:
                throw ZipError.unsupportedMethod(method)
            }

            entries.append(Entry(path: normalizePath(name), data: content))
            cdOffset += 46 + nameLen + extraLen + commentLen
        }

        return entries
    }

    private static func inflateDeflate(_ payload: [UInt8], expectedSize: Int) -> Data? {
        var capacity = max(expectedSize, 65536)
        for _ in 0..<5 {
            var dst = Data(count: capacity)
            let written = dst.withUnsafeMutableBytes { dstPtr -> Int in
                payload.withUnsafeBufferPointer { srcPtr -> Int in
                    guard let base = srcPtr.baseAddress else { return 0 }
                    return compression_decode_buffer(
                        dstPtr.bindMemory(to: UInt8.self).baseAddress!, capacity,
                        base, payload.count,
                        nil,
                        COMPRESSION_ZLIB
                    )
                }
            }
            if written > 0 && written < capacity {
                return dst.prefix(written)
            }
            if written == capacity {
                capacity *= 2
                continue
            }
            return nil
        }
        return nil
    }

    private static func normalizePath(_ p: String) -> String {
        var parts = p.split(separator: "/").map(String.init)
        parts.removeAll(where: { $0 == "." || $0 == ".." })
        return parts.joined(separator: "/")
    }

    // MARK: - Writing (STORE method)

    /// Writes entries as a stored (uncompressed) zip — valid charx output.
    static func write(entries: [Entry]) -> Data {
        var out: [UInt8] = []
        var centralDirectory: [UInt8] = []
        var offset: UInt32 = 0

        func pushU16(_ v: UInt16) {
            out.append(UInt8(v & 0xFF)); out.append(UInt8(v >> 8))
        }
        func pushU32(_ v: UInt32) {
            out.append(UInt8(v & 0xFF)); out.append(UInt8((v >> 8) & 0xFF))
            out.append(UInt8((v >> 16) & 0xFF)); out.append(UInt8((v >> 24) & 0xFF))
        }

        for entry in entries {
            let nameBytes = Array(entry.path.utf8)
            let crc = CRC32.checksum([UInt8](entry.data))
            let size = UInt32(entry.data.count)

            let localHeaderOffset = offset

            // Local file header
            pushU32(0x04034B50)
            pushU16(20)          // version needed
            pushU16(0x0800)      // flags: UTF-8 names
            pushU16(0)           // method: store
            pushU16(0); pushU16(0) // time, date
            pushU32(crc)
            pushU32(size)        // compressed
            pushU32(size)        // uncompressed
            pushU16(UInt16(nameBytes.count))
            pushU16(0)
            out.append(contentsOf: nameBytes)
            out.append(contentsOf: [UInt8](entry.data))

            offset += UInt32(30 + nameBytes.count + entry.data.count)

            // Central directory record
            var cd: [UInt8] = []
            func cPushU16(_ v: UInt16) { cd.append(UInt8(v & 0xFF)); cd.append(UInt8(v >> 8)) }
            func cPushU32(_ v: UInt32) {
                cd.append(UInt8(v & 0xFF)); cd.append(UInt8((v >> 8) & 0xFF))
                cd.append(UInt8((v >> 16) & 0xFF)); cd.append(UInt8((v >> 24) & 0xFF))
            }
            cPushU32(0x02014B50)
            cPushU16(20)         // version made by
            cPushU16(20)         // version needed
            cPushU16(0x0800)
            cPushU16(0)
            cPushU16(0); cPushU16(0)
            cPushU32(crc)
            cPushU32(size)
            cPushU32(size)
            cPushU16(UInt16(nameBytes.count))
            cPushU16(0) // extra
            cPushU16(0) // comment
            cPushU16(0) // disk number
            cPushU16(0) // internal attrs
            cPushU32(0) // external attrs
            cPushU32(localHeaderOffset)
            cd.append(contentsOf: nameBytes)
            centralDirectory.append(contentsOf: cd)
        }

        let cdOffset = offset
        let cdSize = UInt32(centralDirectory.count)
        out.append(contentsOf: centralDirectory)

        // EOCD
        pushU32(0x06054B50)
        pushU16(0); pushU16(0)
        pushU16(UInt16(entries.count))
        pushU16(UInt16(entries.count))
        pushU32(cdSize)
        pushU32(cdOffset)
        pushU16(0)

        return Data(out)
    }

    // MARK: - Byte helpers

    private static func readU16(_ b: [UInt8], _ o: Int) -> UInt16 {
        UInt16(b[o]) | (UInt16(b[o + 1]) << 8)
    }

    private static func readU32(_ b: [UInt8], _ o: Int) -> UInt32 {
        UInt32(b[o]) | (UInt32(b[o + 1]) << 8) | (UInt32(b[o + 2]) << 16) | (UInt32(b[o + 3]) << 24)
    }
}
