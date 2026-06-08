// L4 — shared registry-read primitives. The strict (session-dispatch) and
// lenient (sessions-list) readers both enumerate ~/.loaf/registry/<id>.json and
// parse each entry as RegistryFile; only the POLICY differs. These primitives
// own the read + parse + canonicalize; the two policies stay in their callers.
//
// Directory scanning, prefix matching, and the readdir error policy stay with
// the callers (strict treats readdir failure as SESSION_NOT_FOUND; lenient
// treats ENOENT as empty and other failures as a warning) — they are
// policy-bearing, so NOT extracted here.

import * as fs from "node:fs/promises";
import * as path from "node:path";

import { RegistryFile } from "./projection-schema.js";

export type RegistryReadResult =
  | { ok: true; file: RegistryFile }
  | {
      ok: false;
      reason: "io-error" | "corrupt-json" | "schema-invalid";
      /** Joined human-readable issue messages — the lenient (list) warning text. */
      warningDetail: string;
      /** The full error message (Node `err.message` for io-error / corrupt-json,
       *  ZodError.message for schema-invalid) — the strict (dispatch)
       *  "cannot be parsed" text. */
      strictDetail: string;
    };

/**
 * Read + parse exactly `${id}.json` from `registryDir`. Returns the finest error
 * granularity so each caller applies its own policy. For schema-invalid the two
 * detail surfaces differ on purpose: `warningDetail` is the joined issue
 * messages (matches sessions-list), `strictDetail` is the full Zod error message
 * (matches session-dispatch's `RegistryFile.parse(...)` catch). For io / corrupt
 * the two surfaces are the same `err.message`.
 */
export async function readRegistryEntry(
  registryDir: string,
  id: string,
): Promise<RegistryReadResult> {
  let raw: string;
  try {
    raw = await fs.readFile(path.join(registryDir, `${id}.json`), "utf8");
  } catch (err) {
    const m = (err as Error).message;
    return { ok: false, reason: "io-error", warningDetail: m, strictDetail: m };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    const m = (err as Error).message;
    return { ok: false, reason: "corrupt-json", warningDetail: m, strictDetail: m };
  }

  const result = RegistryFile.safeParse(parsed);
  if (!result.success) {
    return {
      ok: false,
      reason: "schema-invalid",
      warningDetail: result.error.issues.map((i) => i.message).join("; "),
      strictDetail: result.error.message,
    };
  }
  return { ok: true, file: result.data };
}

/** Canonicalize a path via fs.realpath; null when it can't be resolved (deleted). */
export async function tryRealpath(p: string): Promise<string | null> {
  try {
    return await fs.realpath(p);
  } catch {
    return null;
  }
}
