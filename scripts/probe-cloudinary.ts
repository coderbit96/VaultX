import { randomBytes, randomUUID } from "node:crypto";
import { loadEnvConfig } from "@next/env";
import { v2 as cloudinary, type UploadApiResponse } from "cloudinary";
import { readCloudinaryConfig } from "../src/lib/cloudinary/config";

type DeliveryType = "authenticated" | "private";

async function checkDelivery(url: string, expected: Buffer, range?: string) {
  const response = await fetch(url, {
    headers: range ? { Range: range } : undefined,
    redirect: "follow",
    cache: "no-store",
  });
  const body = Buffer.from(await response.arrayBuffer());
  const [first, last] = range ? range.slice(6).split("-").map(Number) : [0, 0];
  const isExpected = range
    ? response.status === 206 &&
      response.headers.get("content-range") === `bytes ${first}-${last}/${expected.length}` &&
      body.equals(expected.subarray(first, last + 1))
    : response.ok && body.equals(expected);
  return { status: response.status, isExpected };
}

async function probe(type: DeliveryType): Promise<void> {
  const payload = randomBytes(65_536);
  const candidateId = `vaultx-feasibility/${randomUUID()}.dat`;
  let publicId = candidateId;
  let uploaded = false;
  let stage = "upload";
  let signedUrl: string | null = null;

  try {
    const result = await new Promise<UploadApiResponse>((resolve, reject) => {
      const stream = cloudinary.uploader.upload_stream(
        { resource_type: "raw", type, public_id: candidateId, overwrite: false },
        (error, response) => {
          if (error || !response) reject(error ?? new Error("No upload response"));
          else resolve(response);
        },
      );
      stream.end(payload);
    });
    uploaded = true;
    publicId = result.public_id;
    console.log(`${type}: signed upload ${result.resource_type === "raw" && result.type === type && result.bytes === payload.length ? "PASS" : "FAIL"}`);

    stage = "metadata";
    const metadata = await cloudinary.api.resource(publicId, { resource_type: "raw", type });
    console.log(`${type}: provider metadata ${metadata.bytes === payload.length && metadata.type === type ? "PASS" : "FAIL"}`);

    stage = "delivery";
    const unsigned = cloudinary.url(publicId, { resource_type: "raw", type, secure: true });
    const signed = cloudinary.url(publicId, {
      resource_type: "raw",
      type,
      secure: true,
      sign_url: true,
    });

    const anonymous = await checkDelivery(unsigned, payload);
    console.log(`${type}: unsigned anonymous delivery ${anonymous.isExpected ? "FAIL (bytes exposed)" : anonymous.status >= 400 ? `PASS (HTTP ${anonymous.status})` : `INCONCLUSIVE (HTTP ${anonymous.status})`}`);

    const authorized = await checkDelivery(signed, payload);
    signedUrl = signed;
    console.log(`${type}: signed delivery ${authorized.isExpected ? "PASS" : `FAIL (HTTP ${authorized.status})`}`);

    for (const range of ["bytes=0-15", "bytes=1024-1039"]) {
      const response = await checkDelivery(signed, payload, range);
      console.log(`${type}: range ${range === "bytes=0-15" ? "start" : "middle"} ${response.isExpected ? "PASS" : `FAIL (HTTP ${response.status})`}`);
    }

    const invalidRange = await fetch(signed, {
      headers: { Range: "bytes=70000-70010" },
      cache: "no-store",
    });
    console.log(`${type}: invalid range ${invalidRange.status === 416 ? "PASS" : `INCONCLUSIVE (HTTP ${invalidRange.status})`}`);

    const unsignedAfter = await checkDelivery(unsigned, payload);
    console.log(`${type}: anonymous after signed delivery ${unsignedAfter.isExpected ? "FAIL (bytes exposed)" : unsignedAfter.status >= 400 ? `PASS (HTTP ${unsignedAfter.status})` : `INCONCLUSIVE (HTTP ${unsignedAfter.status})`}`);

    const alternate = cloudinary.url(publicId, {
      resource_type: "raw",
      type: "upload",
      secure: true,
    });
    const alternateResponse = await checkDelivery(alternate, payload);
    console.log(`${type}: alternate public delivery ${alternateResponse.isExpected ? "FAIL (bytes exposed)" : alternateResponse.status >= 400 ? `PASS (HTTP ${alternateResponse.status})` : `INCONCLUSIVE (HTTP ${alternateResponse.status})`}`);
  } catch (error) {
    const status = (error as { http_code?: unknown })?.http_code;
    const rawMessage = (error as { message?: unknown })?.message;
    const message = typeof rawMessage === "string" ? rawMessage : "";
    const category = /public.?id/i.test(message)
      ? "public ID"
      : /file|format|raw|resource/i.test(message)
        ? "file or resource type"
        : /auth|access|permission|signature/i.test(message)
          ? "authorization"
          : "unclassified";
    const clues = ["invalid", "unsupported", "not allowed", "extension", "format", "filename", "public id", "raw", "image", "video", "file size", "type"]
      .filter((word) => message.toLowerCase().includes(word));
    console.log(`${type}: ${stage} failed${typeof status === "number" ? ` (HTTP ${status})` : ""}; category ${category}; clues ${clues.join(",") || "none"}`);
  } finally {
    if (uploaded) {
      try {
        const removed = await cloudinary.uploader.destroy(publicId, {
          resource_type: "raw",
          type,
          invalidate: true,
        });
        console.log(`${type}: delete ${removed.result === "ok" ? "PASS" : "UNCONFIRMED"}`);
        const repeated = await cloudinary.uploader.destroy(publicId, {
          resource_type: "raw",
          type,
          invalidate: true,
        });
        console.log(`${type}: repeated delete ${repeated.result === "not found" ? "PASS" : "INCONCLUSIVE"}`);
        const lookup = await cloudinary.api.resource(publicId, { resource_type: "raw", type })
          .then(() => "present")
          .catch((error: { error?: { http_code?: number } }) => error.error?.http_code === 404 ? "absent" : "unknown");
        console.log(`${type}: asset lookup after delete ${lookup === "absent" ? "PASS" : lookup === "present" ? "FAIL" : "INCONCLUSIVE"}`);
        if (signedUrl) {
          const afterDelete = await checkDelivery(signedUrl, payload);
          console.log(`${type}: signed URL immediately after delete ${afterDelete.isExpected ? "CACHED_BYTES_STILL_AVAILABLE" : `HTTP ${afterDelete.status}`}`);
        }
      } catch {
        console.log(`${type}: delete FAILED; check the vaultx-feasibility folder in Cloudinary`);
      }
    }
  }
}

async function main(): Promise<void> {
  if (!process.argv.includes("--live")) {
    console.error("This sends synthetic test bytes to Cloudinary. Run with --live to confirm.");
    process.exitCode = 1;
    return;
  }

  loadEnvConfig(process.cwd(), true);
  const { cloudName, apiKey, apiSecret } = readCloudinaryConfig();
  cloudinary.config({ cloud_name: cloudName, api_key: apiKey, api_secret: apiSecret, secure: true });

  const usage = await cloudinary.api.usage();
  console.log(`plan: ${usage.plan ?? "unknown"}`);
  console.log(`raw asset cap: ${usage.media_limits?.raw_max_size_bytes ?? "unknown"} bytes`);

  await probe("authenticated");
  await probe("private");
}

void main().catch(() => {
  console.error("Cloudinary probe could not complete. No credentials or raw provider error are printed.");
  process.exitCode = 1;
});
