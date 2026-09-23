import { PassThrough } from "node:stream";
import { expect, test } from "vitest";
import { Packet } from "./packet.js";

// 이 테스트들은 패킷을 읽는 쪽과 약속한 바이트 형식이 바뀌지 않았는지 확인한다.
// These tests protect the wire format agreed upon with packet readers.
// 여러 바이트를 쓰는 숫자는 빅 엔디언이므로 0x01020304가 01 02 03 04로 나타난다.
// Multibyte numbers use big-endian order, so 0x01020304 becomes 01 02 03 04.
const fileId: number = 0x01020304;

test("헤더의 필드 순서와 UTF-8 바이트 길이 / header fields and UTF-8 byte length", () => {
  const fileName: string = "é"; // UTF-8에서 2바이트 / two UTF-8 bytes: c3 a9
  const fileSize: number = 0x01020304050607;

  const expectedHex: string = [
    "01", // 헤더 패킷 종류 / header packet type
    "01020304", // 파일 ID: 4바이트 / file ID: 4 bytes
    "00000002", // 이름 길이: 문자 1개, UTF-8 2바이트 / name length: 1 character, 2 UTF-8 bytes
    "c3a9", // UTF-8 이름 / UTF-8 name
    "0001020304050607", // 파일 전체 크기: 8바이트 / total file size: 8 bytes
  ].join("");

  expect(Packet.createHeader(fileId, fileName, fileSize).toString("hex")).toBe(
    expectedHex,
  );
});

test("청크의 길이와 데이터 / chunk length and data", () => {
  const data: Buffer = Buffer.from([0xaa, 0xbb]);
  const expectedHex: string = [
    "02", // 청크 패킷 종류 / chunk packet type
    "01020304", // 헤더와 같은 파일 ID / same file ID as the header
    "00000002", // 데이터 길이: 2바이트 / data length: 2 bytes
    "aabb", // 데이터 자체 / data bytes
  ].join("");

  expect(Packet.createChunk(fileId, data).toString("hex")).toBe(expectedHex);
});

test("종료 패킷의 종류와 파일 ID / end packet type and file ID", () => {
  const expectedHex: string = [
    "03", // 종료 패킷 종류 / end packet type
    "01020304", // 헤더 및 청크와 같은 파일 ID / same file ID as header and chunks
  ].join("");

  expect(Packet.createEnd(fileId).toString("hex")).toBe(expectedHex);
});

test("출력 버퍼가 가득 차면 drain까지 기다린다 / waits for drain when the buffer fills", async () => {
  // 한 바이트만 써도 버퍼가 가득 차므로 write()가 false를 반환한다.
  // A single byte fills this buffer, so write() returns false.
  const output: PassThrough = new PassThrough({ highWaterMark: 1 });
  const packet: Buffer = Buffer.from([0xaa]);
  let finished: boolean = false;
  const writing: Promise<void> = Packet.write(output, packet);
  void writing.then(() => {
    finished = true;
  });

  // 다음 이벤트 루프까지 기다려도 스트림을 읽기 전에는 쓰기가 끝나면 안 된다.
  // The write must still be pending on the next event-loop turn, before any read.
  await new Promise<void>((resolve) => setImmediate(resolve));
  expect(finished).toBe(false);

  // 쌓인 바이트를 읽으면 drain이 발생하고 대기 중이던 쓰기가 끝난다.
  // Reading the buffered byte causes drain and completes the pending write.
  expect(output.read()).toEqual(packet);
  await writing;
  expect(finished).toBe(true);
  output.destroy();
});
