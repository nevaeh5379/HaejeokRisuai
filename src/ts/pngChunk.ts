import { Buffer } from "buffer";
import crc32 from "crc/crc32";
import {
  AppendableBuffer,
  VirtualWriter,
  type LocalWriter,
} from "./globalApi.svelte";
import { blobToUint8Array } from "./util";

const textDecoder = new TextDecoder();
const textEncoder = new TextEncoder();

const TEXT_TYPE_BYTES = textEncoder.encode("tEXt");
const IEND_TYPE_BYTES = textEncoder.encode("IEND");
const ZERO_BYTE = new Uint8Array([0]);
const IEND_LENGTH_BYTES = new Uint8Array([0, 0, 0, 0]);
const IEND_CRC_BYTES = new Uint8Array([0xae, 0x42, 0x60, 0x82]);

function computeCrc32(data: Uint8Array | Buffer, previous?: number): number {
  return crc32(data as unknown as Buffer, previous);
}

function isIendChunk(data: Uint8Array, offset: number): boolean {
  return (
    data[offset] === 0x49 &&
    data[offset + 1] === 0x45 &&
    data[offset + 2] === 0x4e &&
    data[offset + 3] === 0x44
  );
}

function isTextChunk(data: Uint8Array, offset: number): boolean {
  return (
    data[offset] === 0x74 &&
    data[offset + 1] === 0x45 &&
    data[offset + 2] === 0x58 &&
    data[offset + 3] === 0x74
  );
}

class StreamChunkWriter {
  constructor(
    private data: Uint8Array,
    private writer:
      LocalWriter | WritableStreamDefaultWriter<Uint8Array> | VirtualWriter,
  ) {}
  async pushData(data: Uint8Array) {
    await this.writer.write(data);
  }
  async init() {
    let pos = 8;
    const data = this.data;
    await this.pushData(data.subarray(0, 8));

    while (pos < data.length) {
      const len =
        ((data[pos] << 24) |
          (data[pos + 1] << 16) |
          (data[pos + 2] << 8) |
          data[pos + 3]) >>>
        0;
      if (isIendChunk(data, pos + 4)) {
        break;
      }
      if (isTextChunk(data, pos + 4)) {
        const endPos = 12 + len + pos;
        let key = "";
        const maxKeyPos = Math.min(endPos, pos + 15);
        let scanPos = pos + 8;
        while (scanPos < maxKeyPos && data[scanPos] !== 0) {
          key += String.fromCharCode(data[scanPos]);
          scanPos++;
        }

        if (key !== "ccv3" && key !== "chara") {
          await this.pushData(data.subarray(pos, endPos));
        }
        pos = endPos;
      } else {
        await this.pushData(data.subarray(pos, pos + 12 + len));
        pos += 12 + len;
      }
    }
  }
  async write(key: string, val: string | Uint8Array) {
    const keyData = textEncoder.encode(key);
    const value = typeof val === "string" ? Buffer.from(val) : val;
    const lenNum = value.byteLength + keyData.byteLength + 1;
    const length = new Uint8Array([
      (lenNum >>> 24) & 0xff,
      (lenNum >>> 16) & 0xff,
      (lenNum >>> 8) & 0xff,
      lenNum & 0xff,
    ]);
    await this.pushData(length);
    await this.pushData(TEXT_TYPE_BYTES);
    await this.pushData(keyData);
    await this.pushData(ZERO_BYTE);
    await this.pushData(value);
    const crc = computeCrc32(
      value,
      computeCrc32(ZERO_BYTE, computeCrc32(keyData, computeCrc32(TEXT_TYPE_BYTES))),
    );
    await this.pushData(
      new Uint8Array([
        (crc >>> 24) & 0xff,
        (crc >>> 16) & 0xff,
        (crc >>> 8) & 0xff,
        crc & 0xff,
      ]),
    );
  }
  async end() {
    await this.pushData(IEND_LENGTH_BYTES);
    await this.pushData(IEND_TYPE_BYTES);
    await this.pushData(IEND_CRC_BYTES);
    this.writer.close();
  }
}

export const PngChunk = {
  read: (
    data: Uint8Array,
    chunkName: string[],
    arg: { checkCrc?: boolean } = {},
  ) => {
    let pos = 8;
    const chunks: { [key: string]: string } = {};
    while (pos < data.length) {
      const len =
        ((data[pos] << 24) |
          (data[pos + 1] << 16) |
          (data[pos + 2] << 8) |
          data[pos + 3]) >>>
        0;
      if (arg.checkCrc) {
        const crc =
          ((data[pos + 8 + len] << 24) |
            (data[pos + 9 + len] << 16) |
            (data[pos + 10 + len] << 8) |
            data[pos + 11 + len]) >>>
          0;
        const crcCheck = computeCrc32(
          data.subarray(pos + 4, pos + 8 + len),
        );
        if (crc !== crcCheck) {
          throw new Error("crc check failed");
        }
      }
      if (isIendChunk(data, pos + 4)) {
        break;
      }
      if (isTextChunk(data, pos + 4)) {
        const chunkData = data.subarray(pos + 8, pos + 8 + len);
        let key = "";
        let value = "";
        const maxSearch = Math.min(70, chunkData.length);
        for (let i = 0; i < maxSearch; i++) {
          if (chunkData[i] === 0) {
            key = textDecoder.decode(chunkData.subarray(0, i));
            value = textDecoder.decode(chunkData.subarray(i + 1));
            break;
          }
        }
        if (chunkName.includes(key)) {
          chunks[key] = value;
        }
      }
      pos += 12 + len;
    }
    return chunks;
  },

  readGenerator: async function* (
    data: File | Uint8Array | ReadableStream<Uint8Array>,
    arg: { checkCrc?: boolean; returnTrimed?: boolean } = {},
  ): AsyncGenerator<{ key: string; value: string } | AppendableBuffer, null> {
    if (data instanceof File) {
      if (typeof data.stream === "function") {
        data = data.stream();
      } else {
        data = await blobToUint8Array(data);
      }
    }
    const reader = data instanceof ReadableStream ? data.getReader() : null;
    let readableStreamData = new AppendableBuffer();
    const trimedData = new AppendableBuffer();

    function appendTrimed(chunk: Uint8Array) {
      if (arg.returnTrimed) {
        trimedData.append(chunk);
      }
    }

    async function slice(start: number, end: number): Promise<Uint8Array> {
      if (data instanceof Uint8Array) {
        return data.subarray(start, end);
      } else {
        while (end > readableStreamData.length()) {
          const rs = await reader.read();
          if (!rs.value && rs.done) {
            return new Uint8Array(0);
          }
          if (!rs.value) {
            continue;
          }
          readableStreamData.append(rs.value);
        }
        const chunk = readableStreamData.slice(start, end);

        if (start - readableStreamData.deapended > 200000) {
          readableStreamData.deappend(50000);
        }

        return chunk;
      }
    }

    await appendTrimed(await slice(0, 8));
    let pos = 8;
    const size = data instanceof Uint8Array ? data.length : Infinity;
    while (pos < size) {
      const dataPart = await slice(pos, pos + 4);
      const len =
        ((dataPart[0] << 24) |
          (dataPart[1] << 16) |
          (dataPart[2] << 8) |
          dataPart[3]) >>>
        0;
      const type = await slice(pos + 4, pos + 8);
      if (arg.checkCrc && !(data instanceof ReadableStream)) {
        //crc check is not supported for stream
        const crcPart = await slice(pos + 8 + len, pos + 12 + len);
        const crc =
          ((crcPart[0] << 24) |
            (crcPart[1] << 16) |
            (crcPart[2] << 8) |
            crcPart[3]) >>>
          0;
        const crcCheck = computeCrc32(
          await slice(pos + 4, pos + 8 + len),
        );
        if (crc !== crcCheck) {
          throw new Error("crc check failed");
        }
      }
      if (isIendChunk(type, 0)) {
        await appendTrimed(await slice(pos, pos + 12 + len));
        break;
      } else if (isTextChunk(type, 0)) {
        const chunkData = await slice(pos + 8, pos + 8 + len);
        let key = "";
        let value = "";
        const maxSearch = Math.min(70, chunkData.length);
        for (let i = 0; i < maxSearch; i++) {
          if (chunkData[i] === 0) {
            key = textDecoder.decode(chunkData.subarray(0, i));
            value = textDecoder.decode(chunkData.subarray(i + 1));
            break;
          }
        }
        yield { key, value };
      } else {
        await appendTrimed(await slice(pos, pos + 12 + len));
      }
      pos += 12 + len;
    }
    if (arg.returnTrimed) {
      yield trimedData;
    }
    return null;
  },

  trim: (data: Uint8Array) => {
    let pos = 8;
    const newData: Uint8Array[] = [];
    while (pos < data.length) {
      const len =
        ((data[pos] << 24) |
          (data[pos + 1] << 16) |
          (data[pos + 2] << 8) |
          data[pos + 3]) >>>
        0;
      if (isIendChunk(data, pos + 4)) {
        newData.push(data.subarray(pos, pos + 12 + len));
        break;
      }
      if (isTextChunk(data, pos + 4)) {
        pos += 12 + len;
      } else {
        newData.push(data.subarray(pos, pos + 12 + len));
        pos += 12 + len;
      }
    }
    newData.push(data.subarray(pos));
    return Buffer.concat(newData);
  },

  write: async (
    data: Uint8Array,
    chunks: { [key: string]: string },
    options: { writer?: LocalWriter } = {},
  ): Promise<void | Buffer> => {
    let pos = 8;
    const newData: Uint8Array[] = [];

    async function pushData(chunk: Uint8Array) {
      if (options.writer) {
        await options.writer.write(chunk);
      } else {
        newData.push(chunk);
      }
    }

    await pushData(data.subarray(0, 8));

    while (pos < data.length) {
      const len =
        ((data[pos] << 24) |
          (data[pos + 1] << 16) |
          (data[pos + 2] << 8) |
          data[pos + 3]) >>>
        0;
      if (isIendChunk(data, pos + 4)) {
        break;
      }
      if (isTextChunk(data, pos + 4)) {
        pos += 12 + len;
      } else {
        await pushData(data.subarray(pos, pos + 12 + len));
        pos += 12 + len;
      }
    }
    for (const key in chunks) {
      const keyData = textEncoder.encode(key);
      const value = Buffer.from(chunks[key]);
      const lenNum = value.byteLength + keyData.byteLength + 1;
      const length = new Uint8Array([
        (lenNum >>> 24) & 0xff,
        (lenNum >>> 16) & 0xff,
        (lenNum >>> 8) & 0xff,
        lenNum & 0xff,
      ]);
      await pushData(length);
      await pushData(TEXT_TYPE_BYTES);
      await pushData(keyData);
      await pushData(ZERO_BYTE);
      await pushData(value);
      const crc = computeCrc32(
        value,
        computeCrc32(ZERO_BYTE, computeCrc32(keyData, computeCrc32(TEXT_TYPE_BYTES))),
      );
      await pushData(
        new Uint8Array([
          (crc >>> 24) & 0xff,
          (crc >>> 16) & 0xff,
          (crc >>> 8) & 0xff,
          crc & 0xff,
        ]),
      );
    }
    // IEND chunk
    await pushData(IEND_LENGTH_BYTES);
    await pushData(IEND_TYPE_BYTES);
    await pushData(IEND_CRC_BYTES);

    if (options.writer) {
      await options.writer.close();
    } else {
      return Buffer.concat(newData);
    }
  },
  streamWriter: StreamChunkWriter,
};
