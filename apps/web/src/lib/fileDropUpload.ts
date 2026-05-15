// Pure classification helper for drop-upload (M11.5a). The
// FileTree component's `onDrop` handler reads `DataTransfer.files`,
// hands the list of filenames here, and gets back two arrays:
// names ready to call `onUploadFile(name, await file.text())` on,
// and rejections with a short human-readable reason matching the
// inline picker-flow validation in `FileTree.svelte`. Async I/O
// (reading file contents) stays in the .svelte handler — this
// module is pure so it can be unit-tested without a DOM.

import { MAIN_DOC_NAME, validateProjectFileName } from "@tex-center/protocol";

export interface DropClassification {
  accepted: string[];
  rejected: { name: string; reason: string }[];
}

/**
 * Classify dropped filenames against the current project files.
 * Mirrors the picker-flow `rejectionReason` logic in
 * `FileTree.svelte`: trim, run the shared validator, reject the
 * reserved MAIN_DOC_NAME, dedup against `existing`. Also dedups
 * within the same drop so two copies of the same filename in one
 * drop don't both pass.
 */
export function classifyDroppedNames(
  names: readonly string[],
  existing: readonly string[],
): DropClassification {
  const accepted: string[] = [];
  const rejected: { name: string; reason: string }[] = [];
  const seen = new Set(existing);
  for (const raw of names) {
    const trimmed = typeof raw === "string" ? raw.trim() : "";
    if (!trimmed) {
      rejected.push({ name: raw, reason: "empty name" });
      continue;
    }
    const validationReason = validateProjectFileName(trimmed);
    if (validationReason) {
      rejected.push({ name: trimmed, reason: validationReason });
      continue;
    }
    if (trimmed === MAIN_DOC_NAME) {
      rejected.push({ name: trimmed, reason: "name reserved" });
      continue;
    }
    if (seen.has(trimmed)) {
      rejected.push({ name: trimmed, reason: "already exists" });
      continue;
    }
    seen.add(trimmed);
    accepted.push(trimmed);
  }
  return { accepted, rejected };
}
