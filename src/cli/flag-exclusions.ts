// Canonical FLAG_EXCLUSIONS contract owner.

export const FLAG_EXCLUSIONS = {
  error_code: "MUTUALLY_EXCLUSIVE_FLAGS",
  exit_code: 2,

  // Each entry describes one mutually exclusive set. Parser MUST
  // reject any invocation that selects more than one option within
  // the same set with a non-equivalent value.
  sets: [
    {
      // SC-5b1: --plain ships as alias for --format text. The set
      // re-populates with --plain + --format=text + --format=json
      // normalization. Repeated --format with non-equivalent canonical
      // values also conflicts (e.g. --format text --format json).
      // Same-canonical pairs are NOT conflicts (--plain --format=text,
      // --format text --format text). RED gate at
      // tests/scripts/sc5a-surface-gate.test.ts RED #18 asserts the
      // set has --plain and no removed-alias entries.
      name: "output_format",
      normalization: {
        "--plain": "text",
        "--format=text": "text",
        "--format=json": "json",
      } as Record<string, "json" | "text">,
      conflict_examples: [
        ["--plain", "--format=json"],
        ["--format=text", "--format=json"],
      ] as ReadonlyArray<readonly string[]>,
      ok_examples: [
        ["--plain", "--format=text"],
        ["--format=text", "--format=text"],
      ] as ReadonlyArray<readonly string[]>,
    },
    {
      // Reserved entry for future verbosity exclusion (e.g., --quiet
      // and --verbose both passed in same invocation). Listed as
      // example of how this table extends; v1.0 enforcement TBD.
      name: "verbosity_reserved",
      normalization: {} as Record<string, never>,
      conflict_examples: [],
      ok_examples: [],
    },
  ],
} as const;
