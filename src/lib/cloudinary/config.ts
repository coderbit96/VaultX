export class CloudinaryConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CloudinaryConfigError";
  }
}

export type CloudinaryConfig = {
  cloudName: string;
  apiKey: string;
  apiSecret: string;
};

export function readCloudinaryConfig(
  env: Record<string, string | undefined> = process.env,
): CloudinaryConfig {
  const cloudName = env.CLOUDINARY_CLOUD_NAME;
  const apiKey = env.CLOUDINARY_API_KEY;
  const apiSecret = env.CLOUDINARY_API_SECRET;

  if (!cloudName) {
    throw new CloudinaryConfigError("CLOUDINARY_CLOUD_NAME is missing. Add it to .env.local.");
  }
  if (!/^[a-zA-Z0-9_-]+$/.test(cloudName)) {
    throw new CloudinaryConfigError("CLOUDINARY_CLOUD_NAME has an invalid format.");
  }
  if (!apiKey) {
    throw new CloudinaryConfigError("CLOUDINARY_API_KEY is missing. Add it to .env.local.");
  }
  if (/\s/.test(apiKey) || /[<>]/.test(apiKey)) {
    throw new CloudinaryConfigError("CLOUDINARY_API_KEY has an invalid format.");
  }
  if (!apiSecret) {
    throw new CloudinaryConfigError("CLOUDINARY_API_SECRET is missing. Add it to .env.local.");
  }
  if (/\s/.test(apiSecret) || /[<>]/.test(apiSecret)) {
    throw new CloudinaryConfigError("CLOUDINARY_API_SECRET has an invalid format.");
  }

  return { cloudName, apiKey, apiSecret };
}
