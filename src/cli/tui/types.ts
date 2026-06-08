// Leaf module holding the TUI status-bucket type, extracted to break the
// runtime-i18n-keys↔list-model↔sessions-list type cycle (P2/SC-7).

export type TuiStatusBucket = "done" | "blocked" | "running" | "idle";
