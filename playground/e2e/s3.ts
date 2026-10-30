import {
  GetObjectCommand,
  HeadObjectCommand,
  ListMultipartUploadsCommand,
  S3Client,
} from "@aws-sdk/client-s3";

const BUCKET = "pmu-playground";
const s3 = new S3Client({
  endpoint: "http://localhost:4566",
  region: "us-east-1",
  forcePathStyle: true,
  credentials: { accessKeyId: "test", secretAccessKey: "test" },
});

export const storedBytes = async (key: string): Promise<Buffer> => {
  const object = await s3.send(new GetObjectCommand({ Bucket: BUCKET, Key: key }));
  return Buffer.from(await object.Body!.transformToByteArray());
};

export const contentTypeOf = async (key: string): Promise<string | undefined> =>
  (await s3.send(new HeadObjectCommand({ Bucket: BUCKET, Key: key }))).ContentType;

export const exists = async (key: string): Promise<boolean> =>
  s3.send(new HeadObjectCommand({ Bucket: BUCKET, Key: key })).then(
    () => true,
    () => false,
  );

export const openMultipartKeys = async (): Promise<string[]> =>
  ((await s3.send(new ListMultipartUploadsCommand({ Bucket: BUCKET }))).Uploads ?? []).map(
    (u) => u.Key!,
  );

/** Deterministic bytes, so a wrongly ordered part shows up as a mismatch. */
export const bytesOf = (size: number, seed: number): Buffer => {
  const buffer = Buffer.alloc(size);
  for (let i = 0; i < size; i += 1) buffer[i] = (i * seed + (i >> 12)) % 251;
  return buffer;
};
