import { defineConfig } from "tsdown/config";

// audit r1 Blocker #7 — build-time URL stamping per docs/plan.md §15 item 5.
// Values can be overridden by env vars at build time; CI release pipeline
// MUST grep the final dist/ for the `*.invalid` sentinel and block on hit.
const DOCS_URL = process.env["LOAF_DOCS_URL"] ?? "https://docs.loaf.invalid";
const ISSUE_URL = process.env["LOAF_ISSUE_URL"] ?? "https://issues.loaf.invalid";

export default defineConfig({
  entry: {
    cli: "./src/cli.tsx",
  },
  format: ["esm"],
  platform: "node",
  target: "node22",
  clean: true,
  sourcemap: true,
  define: {
    __LOAF_DOCS_URL__: JSON.stringify(DOCS_URL),
    __LOAF_ISSUE_URL__: JSON.stringify(ISSUE_URL),
  },
});
