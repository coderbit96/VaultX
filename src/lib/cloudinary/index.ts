import "server-only";

import { v2 as cloudinary } from "cloudinary";
import { readCloudinaryConfig } from "./config";

/** Configure the backend SDK lazily. This module must never enter a client bundle. */
export function getCloudinary(): typeof cloudinary {
  const { cloudName, apiKey, apiSecret } = readCloudinaryConfig();

  cloudinary.config({
    cloud_name: cloudName,
    api_key: apiKey,
    api_secret: apiSecret,
    secure: true,
  });

  return cloudinary;
}
