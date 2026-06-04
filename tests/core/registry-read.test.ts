// L4 — shared registry-read primitives. readRegistryEntry returns the FINEST
// error granularity (io-error / corrupt-json / schema-invalid) so the lenient
// caller (sessions-list) maps each → its warning and the strict caller
// (session-dispatch) collapses any failure → its coarse parse message. The
// schema-invalid variant must carry BOTH detail surfaces because the two
// callers format the Zod error differently (codex L4 plan-first).
//
// RED: imports from registry-read.js, which does not exist yet.

import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";

import { readRegistryEntry, tryRealpath } from "../../src/core/registry-read.js";
import { PROJECTION_SCHEMA_VERSION, type RegistryFile } from "../../src/core/projection-schema.js";

let dir: string;
beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "loaf-regread-"));
});
afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

const validFile = (session_id: string): RegistryFile => ({
  schema_version: PROJECTION_SCHEMA_VERSION,
  at: "2026-05-28T14:00:00.000Z",
  session_id,
  session_label: "",
  feature: "auth-refresh",
  cwd: "/tmp",
  workspace: "default",
  phase: "TRIAGE",
  sub_state: "TRIAGE.score",
  iteration: 1,
  active_tasks: [],
  pending: null,
  pending_queue_depth: 0,
  ceremony_label: "standard",
});

describe("readRegistryEntry", () => {
  const ID = "550e8400-e29b-41d4-a716-000000000001";

  test("valid file → { ok: true, file }", async () => {
    await fs.writeFile(path.join(dir, `${ID}.json`), JSON.stringify(validFile(ID)));
    const r = await readRegistryEntry(dir, ID);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.file.session_id).toBe(ID);
    expect(r.file.feature).toBe("auth-refresh");
  });

  test("missing file → { ok: false, reason: io-error }", async () => {
    const r = await readRegistryEntry(dir, "does-not-exist");
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toBe("io-error");
    expect(r.warningDetail).toBeTruthy();
    expect(r.strictDetail).toBe(r.warningDetail); // io: both surfaces share err.message
  });

  test("garbage bytes → { ok: false, reason: corrupt-json }", async () => {
    await fs.writeFile(path.join(dir, `${ID}.json`), "{ not json");
    const r = await readRegistryEntry(dir, ID);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toBe("corrupt-json");
    expect(r.strictDetail).toBe(r.warningDetail);
  });

  test("valid JSON, wrong shape → schema-invalid with DISTINCT warning + strict detail", async () => {
    await fs.writeFile(path.join(dir, `${ID}.json`), JSON.stringify({ session_id: ID })); // missing fields
    const r = await readRegistryEntry(dir, ID);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toBe("schema-invalid");
    expect(r.warningDetail).toBeTruthy();
    expect(r.strictDetail).toBeTruthy();
    // The two callers format the Zod error differently — they MUST differ so
    // neither call site's observable error text drifts.
    expect(r.warningDetail).not.toBe(r.strictDetail);
  });
});

describe("tryRealpath", () => {
  test("existing path → canonical resolution", async () => {
    const resolved = await tryRealpath(dir);
    expect(resolved).toBe(await fs.realpath(dir));
  });

  test("missing path → null", async () => {
    expect(await tryRealpath(path.join(dir, "nope"))).toBeNull();
  });
});
