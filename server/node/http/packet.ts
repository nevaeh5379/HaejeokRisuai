import { once } from "node:events";

/** Binary packets used by the bulk asset transfer protocol. */
export const Packet = {
  createHeader(fileId: number, name: string, fileSize: number): Buffer {
    const nameBuffer: Buffer = Buffer.from(name, "utf8");
    const packet: Buffer = Buffer.alloc(1 + 4 + 4 + nameBuffer.length + 8);
    let offset: number = 0;

    packet.writeUInt8(0x01, offset);
    offset += 1;
    packet.writeUInt32BE(fileId, offset);
    offset += 4;
    packet.writeUInt32BE(nameBuffer.length, offset);
    offset += 4;

    nameBuffer.copy(packet, offset);
    offset += nameBuffer.length;
    packet.writeBigUint64BE(BigInt(fileSize), offset);

    return packet;
  },

  createChunk(fileId: number, data: Buffer): Buffer {
    const header: Buffer = Buffer.alloc(1 + 4 + 4);
    header.writeUInt8(0x02, 0);
    header.writeUInt32BE(fileId, 1);
    header.writeUint32BE(data.length, 5);

    return Buffer.concat([header, data]);
  },

  createEnd(fileId: number): Buffer {
    const packet: Buffer = Buffer.alloc(1 + 4);
    packet.writeInt8(0x03, 0);
    packet.writeInt32BE(fileId, 1);

    return packet;
  },

  async write(output: NodeJS.WritableStream, packet: Buffer): Promise<void> {
    if (!output.write(packet)) {
      await once(output, "drain");
    }
  },
};
