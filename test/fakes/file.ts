/**
 * Deterministic file fixtures.
 *
 * Bytes are a repeating ramp so a wrongly-sliced Part shows up as wrong content
 * in a failure message, rather than as an opaque length mismatch.
 */
export const makeFile = (size: number, name = "clip.mov"): File => {
  const bytes = new Uint8Array(size);
  for (let i = 0; i < size; i += 1) bytes[i] = i % 251;
  return new File([bytes], name, {
    type: "video/quicktime",
    lastModified: 1_700_000_000_000,
  });
};

export const KB = 1024;
export const MB = 1024 * 1024;
