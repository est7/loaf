// Canonical V1_DONE_CRITERIA contract owner.

export const V1_DONE_CRITERIA = {
  standard_features_completed: 3,
  deep_features_completed: 1,
  forbidden_during_v1: [
    "schema_version bump",
    "new phase",
    "new sub_state",
    "new top-level artifact type",
    "new hook surface",
    "new top-level CLI subcommand",
  ],
  release_action: "tag v1.0.0",
  on_violation: "downgrade to v0.x; no RC iteration allowed",
} as const;
