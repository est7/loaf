// Canonical GateDiagnostic contract owner.

import { z } from "zod";

import { DiagnosticCode } from "../error-catalog.js";
import { GateName } from "../journal-entry.js";

const SchemaVersion = z.literal(2);

export const GateDiagnostic = z.object({
  schema_version: SchemaVersion,
  at: z.string().datetime(),
  gate: z.union([
    GateName,
    z.literal("submit"), // schema validation failure on `loaf X submit`
    z.literal("transition"), // illegal state transition
    z.literal("diff-guard"), // write-guard violation
  ]),
  failures: z.array(
    z.object({
      // rev 4.3: tightened from z.string().min(3) to DiagnosticCode.
      // All known protocol.md §10.5 codes are now registered in §39.
      code: z.lazy(() => DiagnosticCode),
      severity: z.enum(["block", "warn"]),
      ref: z.string().optional(), // file path or ID
      line: z.number().int().optional(), // for spec.md lint
      vars: z.record(z.string(), z.union([z.string(), z.number()])).default({}),
      suggestion: z.string().optional(), // English fallback when no bundle
    }),
  ),
});

export type GateDiagnostic = z.infer<typeof GateDiagnostic>;
