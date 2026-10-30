/**
 * The playground's backend: `presigned-multipart-upload/server`, on S3 via
 * LocalStack, mounted on Node's http server. This is the whole of it.
 */
import { createServer } from "node:http";

import { S3Client } from "@aws-sdk/client-s3";
import { createUploadHandler, toNodeHandler } from "presigned-multipart-upload/server";

const PORT = Number(process.env.PORT ?? 8787);

const s3 = new S3Client({
  endpoint: process.env.S3_ENDPOINT ?? "http://localhost:4566",
  region: "us-east-1",
  forcePathStyle: true,
  credentials: { accessKeyId: "test", secretAccessKey: "test" },
  // Without this, presigned upload urls carry an empty body's checksum.
  requestChecksumCalculation: "WHEN_REQUIRED",
  responseChecksumValidation: "WHEN_REQUIRED",
});

const handler = createUploadHandler({ s3, bucket: process.env.BUCKET ?? "pmu-playground" });

createServer(toNodeHandler(handler)).listen(PORT, () =>
  console.log(`backend on http://localhost:${PORT}`),
);
