// actor-resolver — pure policy module. Resolution order: $LOAF_USER →
// git user.email (when interactive) → fail. Empty/whitespace/control-char
// values reject as INVALID_ACTOR_FORMAT; missing inputs reject as
// NO_HUMAN_ACTOR. Format reuses canonical ActorString from journal-entry.

import { describe, expect, test } from "vitest";

import { resolveHumanActor, type ResolverDeps } from "../../src/core/actor-resolver.js";

function deps(overrides: Partial<ResolverDeps>): ResolverDeps {
  return {
    env: {},
    readGitConfig: () => null,
    isInteractiveHuman: true,
    ...overrides,
  };
}

describe("resolveHumanActor — Slice 1.0 Cycle 1", () => {
  test("#1 $LOAF_USER set + interactive → human:<value>", () => {
    const r = resolveHumanActor(deps({ env: { LOAF_USER: "alice@example.com" } }));
    expect(r).toEqual({ ok: true, actor: "human:alice@example.com" });
  });

  test("#2 $LOAF_USER unset, git config has email, interactive → human:<git email>", () => {
    const r = resolveHumanActor(deps({ readGitConfig: () => "bob@x.com" }));
    expect(r).toEqual({ ok: true, actor: "human:bob@x.com" });
  });

  test("#3 $LOAF_USER unset + no git → NO_HUMAN_ACTOR", () => {
    const r = resolveHumanActor(deps({}));
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error("unreachable");
    expect(r.code).toBe("NO_HUMAN_ACTOR");
  });

  test("#4 CI guard — $LOAF_USER unset + git set + non-interactive → NO_HUMAN_ACTOR (refuse auto-derive)", () => {
    const r = resolveHumanActor(
      deps({
        readGitConfig: () => "cathy@x.com",
        isInteractiveHuman: false,
      }),
    );
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error("unreachable");
    expect(r.code).toBe("NO_HUMAN_ACTOR");
    expect(r.message).toMatch(/non-interactive/i);
  });

  test("#5 explicit env wins in non-interactive context → human:<value>", () => {
    const r = resolveHumanActor(
      deps({
        env: { LOAF_USER: "dave@x.com" },
        isInteractiveHuman: false,
      }),
    );
    expect(r).toEqual({ ok: true, actor: "human:dave@x.com" });
  });

  test("#6 $LOAF_USER='' (explicit empty) → INVALID_ACTOR_FORMAT (not NO_HUMAN_ACTOR — user provided bad input)", () => {
    const r = resolveHumanActor(deps({ env: { LOAF_USER: "" } }));
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error("unreachable");
    expect(r.code).toBe("INVALID_ACTOR_FORMAT");
  });

  test("#7 $LOAF_USER='   ' all-whitespace → INVALID_ACTOR_FORMAT", () => {
    const r = resolveHumanActor(deps({ env: { LOAF_USER: "   " } }));
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error("unreachable");
    expect(r.code).toBe("INVALID_ACTOR_FORMAT");
  });

  test("#8 $LOAF_USER='  alice  ' leading/trailing whitespace → INVALID_ACTOR_FORMAT", () => {
    const r = resolveHumanActor(deps({ env: { LOAF_USER: "  alice  " } }));
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error("unreachable");
    expect(r.code).toBe("INVALID_ACTOR_FORMAT");
  });

  test("#9 $LOAF_USER contains newline → INVALID_ACTOR_FORMAT", () => {
    const r = resolveHumanActor(deps({ env: { LOAF_USER: "alice\nbob" } }));
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error("unreachable");
    expect(r.code).toBe("INVALID_ACTOR_FORMAT");
  });

  test("#10 $LOAF_USER='human:alice' double-prefix → INVALID_ACTOR_FORMAT", () => {
    const r = resolveHumanActor(deps({ env: { LOAF_USER: "human:alice" } }));
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error("unreachable");
    expect(r.code).toBe("INVALID_ACTOR_FORMAT");
    expect(r.message).toMatch(/prefix/i);
  });

  test("#10b other namespace prefix 'skill:x' → INVALID_ACTOR_FORMAT", () => {
    const r = resolveHumanActor(deps({ env: { LOAF_USER: "skill:x" } }));
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error("unreachable");
    expect(r.code).toBe("INVALID_ACTOR_FORMAT");
  });

  test("#11 readGitConfig throws → NO_HUMAN_ACTOR (treat as no git available)", () => {
    const r = resolveHumanActor(
      deps({
        readGitConfig: () => {
          throw new Error("git binary not found");
        },
      }),
    );
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error("unreachable");
    expect(r.code).toBe("NO_HUMAN_ACTOR");
  });

  test("#11b readGitConfig returns empty string → NO_HUMAN_ACTOR (no usable git config, not INVALID input)", () => {
    const r = resolveHumanActor(deps({ readGitConfig: () => "" }));
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error("unreachable");
    expect(r.code).toBe("NO_HUMAN_ACTOR");
  });

  test("#12 git email with interior space (uncommon but protocol-legal) → ok actor passes through", () => {
    // ActorString regex allows interior whitespace after the first non-ws char,
    // so resolver should not be stricter than protocol.
    const r = resolveHumanActor(deps({ readGitConfig: () => "Alice O'Reilly" }));
    expect(r).toEqual({ ok: true, actor: "human:Alice O'Reilly" });
  });
});
