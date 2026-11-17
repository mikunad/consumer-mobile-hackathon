import { Buffer } from "node:buffer";
import { crc32, deflateSync } from "node:zlib";

export function makePng(targetLength) {
  const chunk = (name, data) => {
    const type = Buffer.from(name, "ascii");
    const result = Buffer.alloc(data.length + 12);
    result.writeUInt32BE(data.length, 0);
    type.copy(result, 4);
    data.copy(result, 8);
    result.writeUInt32BE(crc32(Buffer.concat([type, data])), result.length - 4);
    return result;
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(1, 0);
  header.writeUInt32BE(1, 4);
  header[8] = 8;
  header[9] = 6;
  const parts = [Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", header), chunk("IDAT", deflateSync(Buffer.from([0, 255, 255, 255, 255])))];
  const end = chunk("IEND", Buffer.alloc(0));
  const base = Buffer.concat([...parts, end]);
  if (targetLength !== undefined && targetLength !== base.length) {
    if (!Number.isSafeInteger(targetLength) || targetLength < base.length + 15) throw new Error("PNG target length is too small");
    const data = Buffer.alloc(targetLength - base.length - 12, 81);
    data.write("QA\0", "ascii");
    parts.push(chunk("tEXt", data));
  }
  return new Uint8Array(Buffer.concat([...parts, end])).buffer;
}
