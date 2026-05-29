// Phase 16 SC-9c — `loaf check <path>` read-side surface.
//
// Pure file/schema validation for v0.1.0 artifact kinds. CI-facing — no
// session resolution, no feature dispatch, accepts any path (codex r307
// + r308 + r309 lock). 6 kinds:
//
//   --kind / basename | Schema           | Parse path
//   ------------------+------------------+---------------------
//   spec              | SpecFrontmatter  | splitFrontmatter + parseYaml
//   tasks             | TasksJson        | JSON.parse
//   evidence          | EvidenceJson     | JSON.parse
//   finding           | FindingsJson     | JSON.parse (singular CLI noun, plural file basename — codex r309 N1)
//   pending           | PendingJson      | JSON.parse
//   state             | StateProjection  | JSON.parse
//
// Failure envelope rides shared `ctx.failure(code, message, detail)`
// (codex r308 B1) with `detail.errors[]` rendered by the extended
// CommandContext text renderer (codex r309 B1).

import { promises as fsPromises } from "node:fs";
import path from "node:path";
import { parse as parseYaml } from "yaml";
import { z } from "zod";

import { splitFrontmatter } from "../core/spec-frontmatter.js";
import { SpecFrontmatter } from "../core/spec-schema.js";
import {
  EvidenceJson,
  FindingsJson,
  PendingJson,
  StateProjection,
  TasksJson,
} from "../core/projection-schema.js";

/** Codex r309 B2: cap Zod issue list at 20 to keep CI output bounded. */
export const MAX_CHECK_ERRORS = 20;

export type CheckKind =
  | "spec"
  | "tasks"
  | "evidence"
  | "finding"
  | "pending"
  | "state";

export const CHECK_KINDS: ReadonlyArray<CheckKind> = [
  "spec",
  "tasks",
  "evidence",
  "finding",
  "pending",
  "state",
] as const;

interface KindEntry {
  basename: string;
  parse: "yaml-frontmatter" | "json";
  schema: z.ZodType<unknown>;
}

/** External --kind ↔ internal projection mapping (codex r309 N1). */
export const KIND_DISPATCH: Record<CheckKind, KindEntry> = {
  spec:     { basename: "spec.md",       parse: "yaml-frontmatter", schema: SpecFrontmatter },
  tasks:    { basename: "tasks.json",    parse: "json",             schema: TasksJson },
  evidence: { basename: "evidence.json", parse: "json",             schema: EvidenceJson },
  finding:  { basename: "findings.json", parse: "json",             schema: FindingsJson },
  pending:  { basename: "pending.json",  parse: "json",             schema: PendingJson },
  state:    { basename: "state.json",    parse: "json",             schema: StateProjection },
};

/** Reverse basename → kind for auto-detection. */
const BASENAME_TO_KIND = new Map<string, CheckKind>(
  CHECK_KINDS.map((k) => [KIND_DISPATCH[k].basename, k] as const),
);

export interface CheckIssue {
  path: string;
  message: string;
  code: string;
}

export interface MapZodIssuesResult {
  errors: CheckIssue[];
  truncated: boolean;
  error_count: number;
}

/** Map Zod issues with codex r309 B2 cap. `error_count` is total; `errors`
 *  may be sliced to `MAX_CHECK_ERRORS`. */
export function mapZodIssues(err: z.ZodError): MapZodIssuesResult {
  const total = err.issues.length;
  const truncated = total > MAX_CHECK_ERRORS;
  const sliced = truncated ? err.issues.slice(0, MAX_CHECK_ERRORS) : err.issues;
  return {
    errors: sliced.map((i) => ({
      path: i.path.map(String).join("."),
      message: i.message,
      code: i.code,
    })),
    truncated,
    error_count: total,
  };
}

export type CheckResult =
  | {
      ok: true;
      kind: CheckKind;
      path: string;
    }
  | {
      ok: false;
      code:
        | "USAGE"
        | "INPUT_FILE_NOT_FOUND"
        | "SCHEMA_VALIDATION_FAILED";
      message: string;
      detail: Record<string, unknown>;
    };

export interface CheckFileOptions {
  path: string;
  kind?: CheckKind;
  /** Defaults to `process.cwd()` if not provided. */
  cwd?: string;
}

/** Resolve --kind > basename inference. Returns null when neither
 *  resolves — caller emits USAGE specify --kind. */
function resolveKind(filePath: string, explicit?: CheckKind): CheckKind | null {
  if (explicit !== undefined) return explicit;
  const basename = path.basename(filePath).toLowerCase();
  return BASENAME_TO_KIND.get(basename) ?? null;
}

/** Detect the "loaf check tasks" mistake — literal `tasks` arg + no file.
 *  Trigger conditions (both required per codex r309 N2):
 *   - rawArg === "tasks" (NOT "./tasks", NOT "tasks.json")
 *   - file does not exist at resolved absolute path
 */
async function isDidYouMeanTasks(rawArg: string, absPath: string): Promise<boolean> {
  if (rawArg !== "tasks") return false;
  try {
    await fsPromises.stat(absPath);
    return false; // real file named "tasks" exists — let normal flow handle it
  } catch {
    return true;
  }
}

export async function checkFile(opts: CheckFileOptions): Promise<CheckResult> {
  const cwd = opts.cwd ?? process.cwd();
  const absPath = path.isAbsolute(opts.path) ? opts.path : path.resolve(cwd, opts.path);

  // did-you-mean guard (codex r309 N2)
  if (await isDidYouMeanTasks(opts.path, absPath)) {
    return {
      ok: false,
      code: "USAGE",
      message: "did you mean 'loaf tasks check'?",
      detail: { suggestion: "loaf tasks check", argument: opts.path },
    };
  }

  // Read file FIRST — file existence must precede kind resolution so that
  // missing-file cases all surface as INPUT_FILE_NOT_FOUND regardless of
  // basename (codex r311 lock). USAGE specify --kind is reserved for
  // existing files with non-inferable basenames + no --kind.
  let raw: string;
  try {
    raw = await fsPromises.readFile(absPath, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return {
        ok: false,
        code: "INPUT_FILE_NOT_FOUND",
        message: `file not found: ${absPath}`,
        detail: { path: absPath },
      };
    }
    throw err;
  }

  // Kind resolution (file exists; failure here = USAGE specify --kind)
  const kind = resolveKind(opts.path, opts.kind);
  if (kind === null) {
    return {
      ok: false,
      code: "USAGE",
      message: `cannot infer artifact kind from basename '${path.basename(opts.path)}' — specify --kind ${CHECK_KINDS.join("|")}`,
      detail: { hint: "specify --kind", path: absPath, basename: path.basename(opts.path) },
    };
  }

  const entry = KIND_DISPATCH[kind];

  // Parse
  let parsed: unknown;
  if (entry.parse === "yaml-frontmatter") {
    const { frontmatter } = splitFrontmatter(raw);
    if (frontmatter === null) {
      return {
        ok: false,
        code: "SCHEMA_VALIDATION_FAILED",
        message: `${kind} at ${absPath} is missing a YAML frontmatter block fenced by \`---\` on the first line`,
        detail: { kind, path: absPath, subcode: "missing-frontmatter" },
      };
    }
    try {
      parsed = parseYaml(frontmatter);
    } catch (err) {
      return {
        ok: false,
        code: "SCHEMA_VALIDATION_FAILED",
        message: `${kind} at ${absPath} frontmatter YAML failed to parse: ${(err as Error).message}`,
        detail: { kind, path: absPath, subcode: "invalid-yaml" },
      };
    }
  } else {
    try {
      parsed = JSON.parse(raw);
    } catch (err) {
      return {
        ok: false,
        code: "SCHEMA_VALIDATION_FAILED",
        message: `${kind} at ${absPath} JSON failed to parse: ${(err as Error).message}`,
        detail: { kind, path: absPath, subcode: "invalid-json" },
      };
    }
  }

  // Zod validate
  const result = entry.schema.safeParse(parsed);
  if (!result.success) {
    const issues = mapZodIssues(result.error);
    return {
      ok: false,
      code: "SCHEMA_VALIDATION_FAILED",
      message: `${kind} at ${absPath} failed schema validation (${issues.error_count} ${issues.error_count === 1 ? "error" : "errors"})`,
      detail: {
        kind,
        path: absPath,
        subcode: "zod",
        errors: issues.errors,
        truncated: issues.truncated,
        error_count: issues.error_count,
      },
    };
  }

  return { ok: true, kind, path: absPath };
}

/** Text-mode success line. */
export function renderSuccessText(result: { ok: true; kind: CheckKind; path: string }): string {
  return `ok: ${result.kind} at ${result.path}\n`;
}
