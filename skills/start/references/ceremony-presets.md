# Ceremony presets

The kernel ships four built-in presets (`loaf start --ceremony <label>`). Each
expands to the six-flag `Ceremony` object below — the values are ground truth
from `src/cli/commands/lifecycle.tsx` `PRESETS` (do not paraphrase from memory; re-check if the
kernel changes them).

| preset | spec_phase | verify_phase | settle_phase | strict_spec_review | lessons_required | strict_drift_check |
|---|---|---|---|---|---|---|
| `quick` | false | false | false | false | `skip` | false |
| `light` | true | false | false | false | `skip` | false |
| `standard` | true | true | false | false | `skip` | false |
| `deep` | true | true | true | true | `must` | true |

The presets are **monotonic** — each one turns on the next phase:

```
quick     TRIAGE → EXECUTE → DONE
light     TRIAGE → SPEC → EXECUTE → DONE
standard  TRIAGE → SPEC → EXECUTE → VERIFY → DONE
deep      TRIAGE → SPEC → EXECUTE → VERIFY → SETTLE → DONE   (+ strict trio)
```

`quick` has no SPEC phase, so it has no task graph: `tasks submit` / `tasks add`
are rejected and the session delivers from `EXECUTE.done`.

`deep`'s "strict trio": `strict_spec_review` makes verify-accept check 5 a hard
gate (independent spec-review evidence). `lessons_required: must` blocks delivery
from SETTLE.lessons until the session contains an admitted lesson entry.
`strict_drift_check` remains recorded but is not enforced by the kernel.

The preset is a **label only**. The kernel stores the expanded six flags in the
journal and enforces everything off those flags; the label is for display. You
pass the label; the kernel expands it. `loaf start` accepts only these four
labels (anything else is `INVALID_PRESET`).

## Score → preset mapping (your suggestion in TRIAGE.score)

This mapping is the **skill's** policy, not the protocol's — tune it per
workflow. Default bias is *coarse over fine* (avoid over-ceremony on small
work):

| complexity score | suggested preset | typical signal |
|---|---|---|
| 0–20 | `quick` | one or two files, no API/schema/security surface |
| 21–45 | `light` | needs a written spec, but verify is overkill |
| 46–75 | `standard` | real API/schema surface, wants verify lanes |
| 76–100 | `deep` | concurrency or security surface, or high blast radius |

Score the work across **files / api / schema / concurrency / security**. Any
non-trivial **security** or **concurrency** dimension should pull the
suggestion up at least one level regardless of the raw total — those are the
dimensions where skipping VERIFY/SETTLE hurts most.

The score only *suggests*. The human confirms or overrides the preset before
`loaf start` (step 3 of `/loaf:start`).
