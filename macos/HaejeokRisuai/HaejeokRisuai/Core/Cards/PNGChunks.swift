import Compression
import Foundation

/// Reads and writes PNG ancillary text chunks (tEXt / zTXt / iTXt),
/// used for the `chara`, `ccv3` and `chara-ext-asset_*` keys of character cards.
enum PNGChunks {
    struct Chunk {
        var key: String
        var value: String
    }

    static let signature: [UInt8] = [0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]

    enum PNGError: LocalizedError {
        case notPNG
        case corrupted

        var errorDescription: String? {
            switch self {
            case .notPNG: return "The file is not a valid PNG image."
            case .corrupted: return "The PNG file is corrupted."
            }
        }
    }

    /// Extracts all tEXt/zTXt/iTXt chunks from a PNG file.
    static func readTextChunks(_ data: Data) throws -> [Chunk] {
        let bytes = [UInt8](data)
        guard bytes.count > 8, Array(bytes.prefix(8)) == signature else {
            throw PNGError.notPNG
        }

        var chunks: [Chunk] = []
        var offset = 8

        while offset + 8 <= bytes.count {
            let length = readUInt32(bytes, offset)
            let typeData = Array(bytes[(offset + 4)..<(offset + 8)])
            let type = String(bytes: typeData, encoding: .ascii) ?? ""
            let dataStart = offset + 8
            let dataEnd = dataStart + Int(length)

            guard dataEnd + 4 <= bytes.count else { throw PNGError.corrupted }

            if type == "tEXt" || type == "zTXt" || type == "iTXt" {
                let chunkData = Array(bytes[dataStart..<dataEnd])
                if let chunk = parseTextChunk(chunkData, type: type) {
                    chunks.append(chunk)
                }
            }

            if type == "IEND" { break }
            offset = dataEnd + 4 // skip CRC
        }

        return chunks
    }

    private static func parseTextChunk(_ data: [UInt8], type: String) -> Chunk? {
        guard let nul = data.firstIndex(of: 0) else { return nil }
        guard let key = String(bytes: data[..<nul], encoding: .isoLatin1) else { return nil }
        var payload = Array(data[(nul + 1)...])

        switch type {
        case "tEXt":
            break
        case "zTXt":
            // compression method byte (0 = zlib), then compressed text
            guard !payload.isEmpty else { return nil }
            let method = payload.removeFirst()
            guard method == 0, let inflated = inflateRaw(Data(payload)) else { return nil }
            payload = [UInt8](inflated)
        case "iTXt":
            // compression flag, compression method, language tag \0, translated keyword \0
            guard payload.count >= 2 else { return nil }
            let compressionFlag = payload[0]
            payload.removeFirst(2)
            // language tag
            if let langNul = payload.firstIndex(of: 0) {
                payload = Array(payload[(langNul + 1)...])
            } else { return nil }
            // translated keyword
            if let transNul = payload.firstIndex(of: 0) {
                payload = Array(payload[(transNul + 1)...])
            } else { return nil }
            if compressionFlag == 1, let inflated = inflateRaw(Data(payload)) {
                payload = [UInt8](inflated)
            }
        default:
            return nil
        }

        let value = decodeLatin1OrUTF8(payload)
        return Chunk(key: key, value: value)
    }

    /// Writes `chunks` as tEXt records into an existing PNG (after IHDR).
    static func writeTextChunks(to pngData: Data, chunks: [Chunk]) -> Data {
        var bytes = [UInt8](pngData)
        guard bytes.count > 8, Array(bytes.prefix(8)) == signature else { return pngData }

        var newChunks: [UInt8] = []
        for chunk in chunks where !chunk.key.contains("\u{0}") && !chunk.key.isEmpty {
            let keyBytes = Array(chunk.key.utf8)
            // tEXt values must be Latin-1; fall back to stripping non-latin chars.
            var valueBytes: [UInt8] = chunk.value.map { $0.asciiValue ?? 63 }
            if chunk.value.allSatisfy({ $0.isASCII }) {
                valueBytes = Array(chunk.value.utf8)
            } else if let encoded = encodeUTF8IfPossible(chunk.value) {
                // Use UTF-8 when content is non-ASCII; most card tools accept it.
                valueBytes = encoded
            }
            let body = keyBytes + [0] + valueBytes
            newChunks += writeChunk(type: Array("tEXt".utf8), data: body)
        }

        // Insert after IHDR chunk (signature + length + "IHDR" + data + crc = 8+4+4+13+4)
        let insertAt = 8 + 4 + 4 + 13 + 4
        guard insertAt <= bytes.count else { return pngData }
        bytes.insert(contentsOf: newChunks, at: insertAt)
        return Data(bytes)
    }

    private static func encodeUTF8IfPossible(_ s: String) -> [UInt8]? {
        let arr = Array(s.utf8)
        return arr.isEmpty ? nil : arr
    }

    private static func writeChunk(type: [UInt8], data: [UInt8]) -> [UInt8] {
        var out: [UInt8] = []
        let length = UInt32(data.count).bigEndian
        withUnsafeBytes(of: length) { out.append(contentsOf: $0) }
        out.append(contentsOf: type)
        out.append(contentsOf: data)
        var crcInput = type
        crcInput.append(contentsOf: data)
        let crc = CRC32.checksum(crcInput).bigEndian
        withUnsafeBytes(of: crc) { out.append(contentsOf: $0) }
        return out
    }

    private static func readUInt32(_ bytes: [UInt8], _ offset: Int) -> Int {
        let v = (UInt32(bytes[offset]) << 24) | (UInt32(bytes[offset + 1]) << 16)
            | (UInt32(bytes[offset + 2]) << 8) | UInt32(bytes[offset + 3])
        return Int(v)
    }

    private static func decodeLatin1OrUTF8(_ bytes: [UInt8]) -> String {
        if let s = String(bytes: bytes, encoding: .utf8) { return s }
        return String(bytes: bytes, encoding: .isoLatin1) ?? ""
    }

    // MARK: - Raw deflate

    static func inflateRaw(_ data: Data) -> Data? {
        guard !data.isEmpty else { return nil }
        let dstCapacity = max(data.count * 8, 65536)
        for multiplier in [1, 4, 16, 64] {
            var dst = Data(count: dstCapacity * multiplier)
            let written = dst.withUnsafeMutableBytes { dstPtr -> Int in
                data.withUnsafeBytes { srcPtr -> Int in
                    compression_decode_buffer(
                        dstPtr.bindMemory(to: UInt8.self).baseAddress!, dstPtr.count,
                        srcPtr.bindMemory(to: UInt8.self).baseAddress!, srcPtr.count,
                        nil,
                        COMPRESSION_ZLIB
                    )
                }
            }
            if written > 0 {
                return dst.prefix(written)
            }
        }
        return nil
    }

    static func deflateRaw(_ data: Data) -> Data? {
        guard !data.isEmpty else { return nil }
        let dstCapacity = data.count + data.count / 2 + 256
        var dst = Data(count: dstCapacity)
        let written = dst.withUnsafeMutableBytes { dstPtr -> Int in
            data.withUnsafeBytes { srcPtr -> Int in
                compression_encode_buffer(
                    dstPtr.bindMemory(to: UInt8.self).baseAddress!, dstPtr.count,
                    srcPtr.bindMemory(to: UInt8.self).baseAddress!, srcPtr.count,
                    nil,
                    COMPRESSION_ZLIB
                )
            }
        }
        guard written > 0 else { return nil }
        return dst.prefix(written)
    }
}

enum CRC32 {
    static func checksum(_ bytes: [UInt8]) -> UInt32 {
        var crc: UInt32 = 0xFFFFFFFF
        for byte in bytes {
            crc ^= UInt32(byte)
            for _ in 0..<8 {
                crc = (crc & 1) != 0 ? (crc >> 1) ^ 0xEDB88320 : crc >> 1
            }
        }
        return crc ^ 0xFFFFFFFF
    }
}
