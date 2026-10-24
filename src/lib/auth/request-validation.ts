import { ObjectId } from "mongodb";
import { z } from "zod";

// Reject MongoDB's permissive ObjectId coercions and arbitrary query objects.
export const objectIdText = z.string().regex(/^[a-f0-9]{24}$/i);

export function parseObjectId(value: unknown): ObjectId | null {
  const parsed = objectIdText.safeParse(value);
  return parsed.success ? new ObjectId(parsed.data) : null;
}

export async function readJsonRequest<T extends z.ZodType>(
  request: Request, schema: T, maxBytes = 16_384,
): Promise<{ ok: true; data: z.output<T> } | { ok: false }> {
  if (!/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(request.headers.get("content-type") ?? "")) return { ok: false };
  const declared = request.headers.get("content-length");
  if (declared && (!/^\d+$/.test(declared) || Number(declared) > maxBytes)) return { ok: false };
  const reader = request.body?.getReader();
  if (!reader) return { ok: false };
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maxBytes) return { ok: false };
      chunks.push(value);
    }
    const decoded = new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks));
    const parsed = schema.safeParse(JSON.parse(decoded));
    return parsed.success ? { ok: true, data: parsed.data } : { ok: false };
  } catch {
    return { ok: false };
  } finally {
    await reader.cancel().catch(() => undefined);
  }
}
