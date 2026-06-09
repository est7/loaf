// prune — filesystem-safe trash bucket timestamp. The bucket lives at
// <trashDir>/<ts>/<session_id>/; `ts` must be a valid path segment (no `:`) AND
// parseable back to a Date for retention GC (slice 5). Shared by the CLI surface
// (which stamps execute's bucket key) and gcTrash.

/** ISO 8601 with `:` → `-` (e.g. 2026-06-09T12-34-56.789Z). Path-segment safe. */
export function toTrashTs(d: Date): string {
  return d.toISOString().replace(/:/g, "-");
}

/**
 * Reverse `toTrashTs`. Only the HH-MM-SS dashes in the time part are turned back
 * into colons (the date part keeps its dashes; the `.sssZ` millis has no dash).
 * Returns null for anything that does not parse — callers must not GC a bucket
 * they cannot date.
 */
export function fromTrashTs(name: string): Date | null {
  const tIdx = name.indexOf("T");
  if (tIdx < 0) return null;
  const datePart = name.slice(0, tIdx);
  const timePart = name.slice(tIdx + 1).replace(/-/g, ":");
  const ms = Date.parse(`${datePart}T${timePart}`);
  return Number.isNaN(ms) ? null : new Date(ms);
}
