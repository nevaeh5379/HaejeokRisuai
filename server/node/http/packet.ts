import { once } from "node:events";

/**
 * 대량 에셋 전송에 쓰이는 바이너리 패킷을 만들고 스트림에 기록합니다.
 * Creates binary packets for bulk asset transfer and writes them to a stream.
 *
 * @remarks
 * 한 파일은 헤더(0x01), 데이터 청크(0x02) 여러 개, 종료(0x03) 순서로 전송됩니다.
 * 각 패킷의 `fileId`는 같은 파일을 가리키며, 여러 파일의 패킷을 한 스트림에 이어 붙일 수 있습니다.
 * A file is sent as a header (0x01), zero or more data chunks (0x02), and an end
 * packet (0x03). The shared `fileId` identifies the file across those packets;
 * packets for multiple files can be concatenated in one stream.
 *
 * 모든 다중 바이트 정수는 빅 엔디언으로 기록됩니다. 이 객체는 패킷을 인코딩하며,
 * 전송 순서나 입력값의 범위를 검사하지 않습니다.
 * All multibyte integers use big-endian byte order. This object encodes packets;
 * it does not validate their order or the range of input values.
 */
export const Packet = {
  /**
   * 파일 이름과 전체 크기를 담은 헤더 패킷을 만듭니다.
   * Creates a header packet containing a file name and its total size.
   *
   * @remarks
   * 바이트 순서: `0x01`(1바이트), `fileId`(부호 없는 32비트), UTF-8 이름의
   * **바이트 길이**(부호 없는 32비트), 이름 바이트, `fileSize`(부호 없는 64비트).
   * 이름의 문자 수가 아닌 인코딩된 바이트 수를 기록합니다.
   * Byte layout: `0x01` (1 byte), `fileId` (unsigned 32-bit), the UTF-8 name's
   * **byte length** (unsigned 32-bit), name bytes, and `fileSize` (unsigned
   * 64-bit). The length counts encoded bytes, not characters.
   *
   * `fileSize`는 `number`에서 `BigInt`로 변환됩니다. 큰 크기를 정확히 표현하려면
   * 호출자가 JavaScript의 안전한 정수 범위 안에서 값을 전달해야 합니다.
   * `fileSize` is converted from `number` to `BigInt`; callers must stay within
   * JavaScript's safe integer range to preserve an exact size.
   *
   * @param fileId - 같은 파일의 청크 및 종료 패킷과 공유할 ID.
   *   Identifier shared with this file's chunk and end packets.
   * @param name - UTF-8로 인코딩할 파일 이름.
   *   File name to encode as UTF-8.
   * @param fileSize - 모든 청크를 합친 파일 크기(바이트).
   *   Total file size in bytes across all chunks.
   * @returns 새로 할당한 완전한 헤더 패킷.
   *   A newly allocated, complete header packet.
   */
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

  /**
   * 파일의 데이터 조각 하나를 청크 패킷으로 감쌉니다.
   * Wraps one piece of file data in a chunk packet.
   *
   * @remarks
   * 바이트 순서: `0x02`(1바이트), `fileId`(부호 없는 32비트), `data`의
   * 바이트 길이(부호 없는 32비트), 데이터 바이트입니다.
   * Byte layout: `0x02` (1 byte), `fileId` (unsigned 32-bit), the byte length
   * of `data` (unsigned 32-bit), followed by the data bytes.
   *
   * `Buffer.concat`이 데이터까지 새 버퍼에 복사하므로, 호출자는 한 번에 담을
   * 청크 크기를 제한해 메모리 사용량을 조절해야 합니다.
   * `Buffer.concat` copies the data into a new buffer. Callers should bound
   * chunk sizes to control peak memory use.
   *
   * @param fileId - 앞서 보낸 헤더와 같은 파일 ID.
   *   The file identifier from the preceding header.
   * @param data - 이 청크에 담을 원본 바이트.
   *   Source bytes for this chunk.
   * @returns 청크 헤더와 데이터를 이어 붙인 새 버퍼.
   *   A new buffer containing the chunk header and data.
   */
  createChunk(fileId: number, data: Buffer): Buffer {
    const header: Buffer = Buffer.alloc(1 + 4 + 4);
    header.writeUInt8(0x02, 0);
    header.writeUInt32BE(fileId, 1);
    header.writeUint32BE(data.length, 5);

    return Buffer.concat([header, data]);
  },

  /**
   * 한 파일의 데이터 전송이 끝났음을 알리는 패킷을 만듭니다.
   * Creates a packet marking the end of one file's data.
   *
   * @remarks
   * 바이트 순서: `0x03`(1바이트), `fileId`(부호 있는 32비트)입니다.
   * 이 형식에는 길이나 데이터가 없으며, 현재 구현은 종료 패킷의 ID를
   * `writeInt32BE`로 기록합니다. 따라서 파일 ID는 부호 있는 32비트 범위여야
   * 세 종류의 패킷 모두에 같은 값을 사용할 수 있습니다.
   * Byte layout: `0x03` (1 byte), then `fileId` (signed 32-bit). This packet
   * has no length or data field. The implementation uses `writeInt32BE` for
   * the end packet, so a file ID must fit the signed 32-bit range to be usable
   * across all three packet types.
   *
   * @param fileId - 종료할 파일의 헤더 및 청크와 같은 ID.
   *   The identifier from the file's header and chunks.
   * @returns 새로 할당한 5바이트 종료 패킷.
   *   A newly allocated five-byte end packet.
   */
  createEnd(fileId: number): Buffer {
    const packet: Buffer = Buffer.alloc(1 + 4);
    packet.writeInt8(0x03, 0);
    packet.writeInt32BE(fileId, 1);

    return packet;
  },

  /**
   * 패킷을 출력 스트림에 기록하고 배압이 풀릴 때까지 기다립니다.
   * Writes a packet to an output stream and waits for backpressure to clear.
   *
   * @remarks
   * `output.write()`가 `false`를 반환하면 내부 버퍼가 가득 찬 상태이므로
   * `drain` 이벤트를 기다립니다. 이를 `await`하면 호출자가 다음 청크를
   * 너무 빨리 만들거나 읽어 메모리를 늘리는 일을 줄일 수 있습니다.
   * If `output.write()` returns `false`, the writable buffer is full, so this
   * method waits for `drain`. Awaiting it lets the caller avoid producing or
   * reading more chunks before the stream can accept them.
   *
   * 반환된 Promise는 전송 완료를 보장하지 않으며 스트림을 종료하지도 않습니다.
   * The returned promise does not guarantee delivery or end the stream.
   *
   * @param output - 패킷을 받을 Node 쓰기 스트림.
   *   Node writable stream receiving the packet.
   * @param packet - 기록할 완전한 패킷 버퍼.
   *   Complete packet buffer to write.
   * @returns 쓰기가 즉시 수락되거나 `drain`이 발생하면 완료되는 Promise.
   *   A promise that resolves when the write is accepted immediately or `drain` fires.
   */
  async write(output: NodeJS.WritableStream, packet: Buffer): Promise<void> {
    if (!output.write(packet)) {
      await once(output, "drain");
    }
  },
};
