"use client";

// This only prevents accidental repeat selection in the current unlocked tab.
// It is not a content hash or a cross-device duplicate claim.
export function selectionKey(file: Pick<File, "name" | "size" | "lastModified" | "type">): string {
  return JSON.stringify([file.name.normalize("NFC"), file.size, file.lastModified, file.type]);
}

export function dedupeSelection(files: Iterable<File>, seen: Set<string>): { accepted: File[]; skipped: number } {
  const accepted: File[] = [];
  let skipped = 0;
  for (const file of files) {
    const key = selectionKey(file);
    if (seen.has(key)) { skipped++; continue; }
    seen.add(key);
    accepted.push(file);
  }
  return { accepted, skipped };
}
