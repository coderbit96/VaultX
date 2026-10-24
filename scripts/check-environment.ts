import { loadEnvConfig } from "@next/env";
import { checkEnvironment } from "../src/lib/config/environment";

loadEnvConfig(process.cwd());
const status = checkEnvironment();
console.log(`MongoDB configuration: ${status.mongodb}`);
console.log(`Cloudinary configuration: ${status.cloudinary}`);
console.log(`Auth.js configuration: ${status.auth}`);
for (const issue of status.issues) console.error(issue);
if (status.issues.length) process.exitCode = 1;
