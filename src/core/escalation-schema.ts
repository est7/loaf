// Canonical EscalationTrigger, EscalationDetection, ESCALATION_DETECTIONS contract owner.

import { z } from "zod";

export const EscalationTrigger = z.enum([
  "scope_expansion",
  "public_api_touched",
  "schema_change",
  "concurrency_touched",
  "security_touched",
]);

export const EscalationDetection = z.object({
  // CLI checks: if any of these triggers fires, raise
  // pending(kind=profile_escalation) + skill maps to new preset.
  triggers: z.array(EscalationTrigger).min(1),
  // What ceremony fields SHOULD turn on after escalation:
  // (skill consults this when building new Ceremony object after
  // user confirms; CLI does not enforce specific values, just the
  // pending raise.)
  recommend_enable: z
    .array(
      z.enum([
        "spec_phase",
        "verify_phase",
        "settle_phase",
        "strict_spec_review",
        "strict_drift_check",
      ]),
    )
    .default([]),
});

export const ESCALATION_DETECTIONS: Array<z.infer<typeof EscalationDetection>> = [
  // scope_expansion / public_api_touched: light → spec_phase
  {
    triggers: ["scope_expansion"],
    recommend_enable: ["spec_phase"],
  },
  // public_api_touched / schema_change / concurrency_touched / security_touched:
  // → spec_phase + verify_phase + settle_phase (full ceremony)
  {
    triggers: ["public_api_touched", "schema_change", "concurrency_touched", "security_touched"],
    recommend_enable: ["spec_phase", "verify_phase", "settle_phase"],
  },
];
