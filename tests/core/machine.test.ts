import { describe, expect, test } from "vitest";

import { MACHINE, defineMachine } from "../../src/core/machine.js";
import { SubState } from "../../src/core/journal-entry.js";

describe("MACHINE", () => {
  test("state keys stay in declaration-order lockstep with SubState", () => {
    expect(Object.keys(MACHINE)).toEqual(SubState.options);
  });
});

// Compile-time contract: defineMachine accepts exactly the SubState key set.
// Keep these calls unreachable; tsc still checks both negative cases.
if (false) {
  const { "DONE.abandoned": omitted, ...missingState } = MACHINE;
  void omitted;

  // @ts-expect-error missing state keys are rejected
  defineMachine(missingState);

  defineMachine({
    ...MACHINE,
    // @ts-expect-error extra state keys are rejected
    "EXTRA.state": MACHINE["DONE.abandoned"],
  });
}
