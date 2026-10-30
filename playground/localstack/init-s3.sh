#!/bin/sh
# The bucket the playground uploads to, with the CORS rule the README asks for:
# browsers PUT straight to it, and multipart needs ETag readable.
set -e
awslocal s3api create-bucket --bucket pmu-playground
awslocal s3api put-bucket-cors --bucket pmu-playground --cors-configuration '{
  "CORSRules": [{
    "AllowedOrigins": ["*"],
    "AllowedMethods": ["PUT", "GET", "HEAD"],
    "AllowedHeaders": ["*"],
    "ExposeHeaders": ["ETag"]
  }]
}'
