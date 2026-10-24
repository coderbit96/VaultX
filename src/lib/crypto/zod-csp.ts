import { z } from "zod";

// Zod 4.6.7 otherwise probes new Function during parsing, which triggers a
// script-src CSP violation even when the caught probe fails. Keep validation
// interpreted so client crypto can run under the nonce-based policy.
z.config({ jitless: true });
