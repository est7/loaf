// Phase 16 SC-14 — production render wrapper for `loaf tui`.
//
// Default `MainDeps.renderTui` impl. Tests inject a stub that asserts
// the App was constructed with the right rows + resolves immediately
// per codex r355 / r356 Q3 boundary.

import type { ReactElement } from "react";

export type RenderTui = (app: ReactElement) => Promise<void>;

export async function defaultRenderTui(app: ReactElement): Promise<void> {
  // Dynamic import keeps Ink off the cold-start path for non-TUI
  // commands. Production loads Ink only when `loaf tui` actually runs.
  const { render } = await import("ink");
  const instance = render(app);
  await instance.waitUntilExit();
}
