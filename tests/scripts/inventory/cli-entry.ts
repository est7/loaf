// Entrypoint for `bun run inventory` / `bash scripts/cli-inventory.sh`.
// Codex r190 constraint: this script MUST call the same collector module
// used by tests (tests/scripts/cli-inventory.test.ts via help-collector.ts).
// No second parser in a shell wrapper — this file is the only seam.
import { collectInventory } from "./help-collector.js";

const inv = collectInventory();
process.stdout.write(`${JSON.stringify(inv, null, 2)}\n`);
