import { createRequire } from 'node:module'
import { Writable } from 'node:stream'
import { unzipSync } from 'fflate'
import { describe, expect, it } from 'vitest'

const require = createRequire(import.meta.url)
const { streamZip } = require('./zipStream.cjs')

class CollectingWriter extends Writable {
    chunks: Buffer[] = []

    constructor() {
        super({ highWaterMark: 8 })
    }

    _write(chunk: Buffer, _encoding: BufferEncoding, callback: (error?: Error | null) => void) {
        this.chunks.push(Buffer.from(chunk))
        setTimeout(callback, 0)
    }
}

describe('streamZip', () => {
    it('creates a valid archive from chunked sources while honoring backpressure', async () => {
        const output = new CollectingWriter()
        const firstChunks = [Buffer.from('streamed-'), Buffer.from('asset')]

        const result = await streamZip(output, [{
            name: 'assets/example.bin',
            size: 14,
            open: async function* () {
                for (const chunk of firstChunks) yield chunk
            },
        }, {
            name: 'card.json',
            size: 14,
            source: Buffer.from('{"name":"봇"}'),
        }])
        output.end()

        const archive = Buffer.concat(output.chunks)
        const files = unzipSync(archive)
        expect(Buffer.from(files['assets/example.bin']).toString()).toBe('streamed-asset')
        expect(Buffer.from(files['card.json']).toString()).toBe('{"name":"봇"}')
        expect(result.entriesWritten).toBe(2)
        expect(result.bytesWritten).toBe(BigInt(archive.length))
    })

    it('rejects a source that exceeds its declared size without buffering it', async () => {
        const output = new CollectingWriter()

        await expect(streamZip(output, [{
            name: 'large.bin',
            size: 3,
            source: Buffer.from('too large'),
        }])).rejects.toThrow('exceeded declared size')
    })

    it('writes valid offsets when the ZIP follows a JPEG prefix', async () => {
        const output = new CollectingWriter()
        const prefix = Buffer.from([0xff, 0xd8, 0xff, 0xd9])
        output.write(prefix)

        await streamZip(output, [{
            name: 'card.json',
            size: 2,
            source: Buffer.from('{}'),
        }], { initialOffset: prefix.length })
        output.end()

        const file = Buffer.concat(output.chunks)
        expect(file.subarray(0, prefix.length)).toEqual(prefix)
        expect(Buffer.from(unzipSync(file)['card.json']).toString()).toBe('{}')
    })
})
