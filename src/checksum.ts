import { abortFailure } from "./failures.js";

/**
 * CRC32 of a Part, in the form S3 expects: the big-endian 4-byte value,
 * base64-encoded.
 *
 * CRC32 rather than anything stronger because S3, R2 and MinIO all verify it,
 * and it is cheap enough to compute on the main thread — a table lookup per
 * byte. Read from a stream where the Blob offers one, so a 200 MiB Part is
 * never held whole just to be summed, and the event loop gets a turn between
 * chunks.
 */

const TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

/** Fold `bytes` into a running CRC. Start from 0. */
const update = (crc: number, bytes: Uint8Array): number => {
  let c = ~crc >>> 0;
  for (let i = 0; i < bytes.length; i += 1) {
    c = TABLE[(c ^ bytes[i]!) & 0xff]! ^ (c >>> 8);
  }
  return ~c >>> 0;
};

const toBase64 = (value: number): string =>
  btoa(
    String.fromCharCode(
      (value >>> 24) & 0xff,
      (value >>> 16) & 0xff,
      (value >>> 8) & 0xff,
      value & 0xff,
    ),
  );

/** Rejects with an AbortError between chunks once `signal` aborts, so a Pause is not kept waiting on a read. */
export const crc32Of = async (blob: Blob, signal?: AbortSignal): Promise<string> => {
  const stopped = (): Error => abortFailure("Stopped while computing a checksum");
  if (signal?.aborted) throw stopped();
  let crc = 0;
  if (typeof blob.stream === "function") {
    const reader = blob.stream().getReader();
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (signal?.aborted) {
        await reader.cancel();
        throw stopped();
      }
      crc = update(crc, value);
    }
  } else {
    crc = update(crc, new Uint8Array(await blob.arrayBuffer()));
  }
  return toBase64(crc);
};

/** The header that carries it. Must be sent exactly as signed. */
export const CRC32_HEADER = "x-amz-checksum-crc32";
