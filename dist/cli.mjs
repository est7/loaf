#!/usr/bin/env node
import { Command, CommanderError } from "commander";
import { promises } from "node:fs";
import * as path$1 from "node:path";
import path from "node:path";
import os from "node:os";
import { z } from "zod";
import { execFileSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { O_APPEND, O_CREAT, O_WRONLY } from "node:constants";
import * as fs from "node:fs/promises";
import { parse, stringify } from "yaml";
//#region package.json
var version = "0.1.0";
//#endregion
//#region src/core/crash-log.ts
/** Sentinel code stamped into the JSON envelope and (when
*  `--format json` is set) onto the boundary stderr payload. Lives
*  here, not in src/cli.tsx, so the SC-0 inventory regex
*  (`code: "CODE"` scan over cli.tsx) does NOT pick it up as an
*  uncataloged DiagnosticCode emit. */
const UNEXPECTED_ERROR = "UNEXPECTED_ERROR";
z.object({
	iso: z.string(),
	version: z.string(),
	argv: z.array(z.string()),
	cwd: z.string(),
	feature: z.string().nullable(),
	phase: z.string().nullable(),
	sub_state: z.string().nullable(),
	exitCode: z.literal(1),
	error: z.object({
		name: z.string(),
		message: z.string(),
		stack: z.string().nullable()
	})
});
const DEFAULT_DEPS = {
	now: () => /* @__PURE__ */ new Date(),
	homeDir: () => os.homedir(),
	writeStderr: (s) => process.stderr.write(s)
};
/** Best-effort `--feature <NAME>` extractor. Stays in this module so the
*  boundary doesn't have to know argv shape; null on miss. */
function extractFeature$1(argv) {
	const i = argv.indexOf("--feature");
	if (i < 0 || i + 1 >= argv.length) return null;
	const v = argv[i + 1];
	return v && !v.startsWith("--") ? v : null;
}
/** ISO 8601 with `:` replaced so the filename is portable across
*  Windows/macOS/Linux without escaping. */
function safeIso(d) {
	return d.toISOString().replace(/:/g, "-");
}
/** Write a crash log envelope and return its absolute path. On any IO
*  failure (EACCES, ENOSPC, unwritable parent), emit a one-line stderr
*  diagnostic via `deps.writeStderr` and return null. Never throws —
*  the caller is already in an error boundary and a second fault would
*  obscure the original cause. */
async function writeCrashLog(input, depsPartial) {
	const deps = {
		...DEFAULT_DEPS,
		...depsPartial
	};
	const now = deps.now();
	const envelope = {
		iso: now.toISOString(),
		version: input.version,
		argv: [...input.argv],
		cwd: input.cwd,
		feature: extractFeature$1(input.argv),
		phase: input.context?.phase ?? null,
		sub_state: input.context?.sub_state ?? null,
		exitCode: 1,
		error: {
			name: input.error.name,
			message: input.error.message,
			stack: input.error.stack ?? null
		}
	};
	const dir = path.join(deps.homeDir(), ".loaf", "crashes");
	const file = path.join(dir, `${safeIso(now)}.json`);
	try {
		await promises.mkdir(dir, {
			recursive: true,
			mode: 448
		});
		await promises.chmod(dir, 448);
		await promises.writeFile(file, JSON.stringify(envelope, null, 2) + "\n", {
			encoding: "utf8",
			mode: 384
		});
		await promises.chmod(file, 384);
		return file;
	} catch (err) {
		deps.writeStderr(`loaf: crash log unwritable at ${file} — ${err.message}\n`);
		return null;
	}
}
//#endregion
//#region src/cli/command-context.ts
/** Closed value set for `--format`. Single source of truth for both the
*  argv parser and the human-readable error template. Order is
*  intentional: matches the `text|json` rendering in user-facing
*  diagnostics. */
const FORMAT_MODES = ["text", "json"];
/** Pipe-joined human form for INVALID_FORMAT i18n templates.
*  Derived explicitly — never `Array.toString()` — to keep the
*  catalog/i18n/runtime placeholder symmetry deterministic
*  (per RED #12 in tests/scripts/sc5a-surface-gate.test.ts). */
const FORMAT_MODES_HUMAN = FORMAT_MODES.join("|");
/** Scan EVERY `--format <v>` and `--format=<v>` occurrence and return
*  the first one with a value outside FORMAT_MODES. Returns null when
*  all occurrences are valid (or absent). Used by parsePresentation
*  to honor INVALID_FORMAT precedence over mutex regardless of
*  position (codex r258 F1: an invalid value AFTER a valid one must
*  still raise INVALID_FORMAT). */
function findFirstInvalidFormat(argv) {
	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i];
		if (arg === "--format") {
			const v = argv[i + 1];
			if (v === void 0 || v.startsWith("--")) continue;
			if (!FORMAT_MODES.includes(v)) return { rawValue: v };
			i++;
			continue;
		}
		if (arg.startsWith("--format=")) {
			const v = arg.slice(9);
			if (!FORMAT_MODES.includes(v)) return { rawValue: v };
		}
	}
	return null;
}
/** Returns true if `--plain` flag appears in argv. */
function parsePlainFromArgv(argv) {
	return argv.includes("--plain");
}
/** Returns true if `--quiet` OR `-q` flag appears in argv. */
function parseQuietFromArgv(argv) {
	return argv.includes("--quiet") || argv.includes("-q");
}
/** Returns cumulative verbose count: `-v` = 1, `-vv` = 2,
*  `--verbose` = 1, and multiple occurrences sum. E.g.
*  `-v --verbose` = 2, `-vv --verbose` = 3. Per protocol §10.7 +
*  codex r254 OQ3 verdict. */
function parseVerboseFromArgv(argv) {
	let count = 0;
	for (const arg of argv) {
		if (arg === "--verbose") {
			count += 1;
			continue;
		}
		if (/^-v+$/.test(arg)) count += arg.length - 1;
	}
	return count;
}
/** Returns true if any of these is true:
*  - `--no-color` in argv
*  - `env.NO_COLOR` non-empty
*  - `env.LOAF_NO_COLOR` non-empty
*  - `env.TERM === "dumb"`
*  Per protocol §10.2 (`docs/protocol.md:1512-1513`). */
function parseNoColorFromArgv(argv, env = process.env) {
	if (argv.includes("--no-color")) return true;
	if (env.NO_COLOR && env.NO_COLOR.length > 0) return true;
	if (env.LOAF_NO_COLOR && env.LOAF_NO_COLOR.length > 0) return true;
	if (env.TERM === "dumb") return true;
	return false;
}
/** Internal: collect every (entry, canonicalValue) pair from argv
*  using the FLAG_EXCLUSIONS.output_format normalization. Used to
*  detect non-equivalent multi-flag conflicts. */
function collectOutputFormatEntries(argv) {
	const out = [];
	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i];
		if (arg === "--plain") {
			out.push({
				entry: "--plain",
				canonical: "text"
			});
			continue;
		}
		if (arg === "--format") {
			const v = argv[i + 1];
			if (v && !v.startsWith("--") && FORMAT_MODES.includes(v)) out.push({
				entry: `--format ${v}`,
				canonical: v
			});
			continue;
		}
		if (arg.startsWith("--format=")) {
			const v = arg.slice(9);
			if (FORMAT_MODES.includes(v)) out.push({
				entry: arg,
				canonical: v
			});
			continue;
		}
	}
	return out;
}
function parsePresentation(argv, env = process.env) {
	const invalid = findFirstInvalidFormat(argv);
	if (invalid) return {
		ok: false,
		kind: "INVALID_FORMAT",
		rawValue: invalid.rawValue
	};
	const entries = collectOutputFormatEntries(argv);
	if (new Set(entries.map((e) => e.canonical)).size > 1) {
		const renderAsJson = entries.some((e) => e.canonical === "json");
		return {
			ok: false,
			kind: "MUTUALLY_EXCLUSIVE_FLAGS",
			conflicting: Array.from(new Set(entries.map((e) => e.entry))),
			renderAsJson
		};
	}
	return {
		ok: true,
		format: entries.length > 0 ? entries[0].canonical : "text",
		plain: parsePlainFromArgv(argv),
		quiet: parseQuietFromArgv(argv),
		verbose: parseVerboseFromArgv(argv),
		noColor: parseNoColorFromArgv(argv, env)
	};
}
/** Pre-resolve `--feature <NAME>` from argv. Best-effort; null on miss.
*  Lifted here (was duplicated in src/core/crash-log.ts) so ctx and
*  crash-log can agree on what "feature" means for a given invocation. */
function extractFeature(argv) {
	const i = argv.indexOf("--feature");
	if (i < 0 || i + 1 >= argv.length) return null;
	const v = argv[i + 1];
	return v && !v.startsWith("--") ? v : null;
}
/** Derive `phase` from a `sub_state` like "EXECUTE.work" → "EXECUTE".
*  Returns null if the sub_state has no dot (no phase prefix). */
function phaseOf(subState) {
	if (!subState) return null;
	const i = subState.indexOf(".");
	return i < 0 ? null : subState.slice(0, i);
}
function createCommandContext(argv, deps) {
	const presentation = parsePresentation(argv);
	const output = presentation.ok ? presentation.format : "text";
	const plain = presentation.ok ? presentation.plain : false;
	const quiet = presentation.ok ? presentation.quiet : false;
	const verbose = presentation.ok ? presentation.verbose : 0;
	const noColor = presentation.ok ? presentation.noColor : false;
	let exitCode = 0;
	const sessionCache = /* @__PURE__ */ new Map();
	const projectionCache = /* @__PURE__ */ new Map();
	let lastResolvedSubState = null;
	return {
		argv,
		output,
		plain,
		quiet,
		verbose,
		noColor,
		get exitCode() {
			return exitCode;
		},
		set exitCode(v) {
			exitCode = v;
		},
		async resolveSession(featureDir) {
			const cached = sessionCache.get(featureDir);
			if (cached) return cached;
			if (!deps.loadSession) throw new Error("CommandContext: loadSession dep not provided; cannot resolveSession");
			const p = deps.loadSession(featureDir).then((sess) => {
				const sub = sess.snapshot.state?.sub_state ?? null;
				if (sub) lastResolvedSubState = sub;
				return sess;
			});
			sessionCache.set(featureDir, p);
			return p;
		},
		async resolveProjections(featureDir, kinds) {
			const key = `${featureDir}::${[...kinds].sort().join(",")}`;
			const cached = projectionCache.get(key);
			if (cached) return cached;
			if (!deps.loadProjections) throw new Error("CommandContext: loadProjections dep not provided; cannot resolveProjections");
			const p = deps.loadProjections({
				feature_dir: featureDir,
				kinds
			});
			projectionCache.set(key, p);
			return p;
		},
		success(payload, textRenderer, advisories) {
			if (output === "json") deps.writeStdout(JSON.stringify(payload) + "\n");
			else {
				if (!textRenderer) throw new Error("ctx.success: text renderer required in text mode (a migrated command must always pass a text renderer; JSON mode skips it lazily)");
				deps.writeStdout(textRenderer());
			}
			if (!quiet && advisories) {
				if (advisories.stateChange) deps.writeStderr(advisories.stateChange + "\n");
				if (advisories.next !== void 0) {
					const lines = Array.isArray(advisories.next) ? advisories.next : [advisories.next];
					for (const line of lines) deps.writeStderr(`next: ${line}\n`);
				}
			}
		},
		failure(code, message, detail) {
			if (output === "json") {
				const out = {
					ok: false,
					code,
					message
				};
				if (detail !== void 0) out["detail"] = detail;
				deps.writeStderr(JSON.stringify(out) + "\n");
			} else {
				deps.writeStderr(`error: ${code} — ${message}\n`);
				const checks = detail?.["checks"];
				if (Array.isArray(checks)) for (const c of checks) deps.writeStderr(`  [check ${c.check ?? "?"}] ${c.code ?? "UNKNOWN"}: ${c.message ?? ""}\n`);
			}
			exitCode = 2;
		},
		snapshotCrashContext() {
			return {
				phase: phaseOf(lastResolvedSubState),
				sub_state: lastResolvedSubState,
				feature: extractFeature(argv),
				last_command: [...argv].join(" ")
			};
		}
	};
}
//#endregion
//#region src/cli/url-prefill.ts
const COMMAND_WORDS = new Set([
	"loaf",
	"start",
	"advance",
	"status",
	"spec",
	"tasks",
	"pending",
	"evidence",
	"finding",
	"gate",
	"deliver",
	"settle",
	"doctor",
	"archive",
	"abandon",
	"spike",
	"profile",
	"submit",
	"init",
	"add-req",
	"add-scenario",
	"add-visual",
	"claim",
	"list",
	"next",
	"step",
	"amend",
	"complete",
	"done",
	"raise",
	"resolve",
	"add",
	"close",
	"decide",
	"convert",
	"escalate"
]);
const SUB_STATE_RE = /^(TRIAGE|SPEC|EXECUTE|VERIFY|SETTLE|DONE)(\.[a-z_]+)?$/;
const GATE_NAME_RE = /^(spec-lock|verify-accept)$/;
function isSafePositional(token) {
	if (COMMAND_WORDS.has(token)) return true;
	if (SUB_STATE_RE.test(token)) return true;
	if (GATE_NAME_RE.test(token)) return true;
	return false;
}
const ALLOWLIST_VALUE_FLAGS = new Set([
	"--ceremony",
	"--format",
	"--feature"
]);
const ALWAYS_REDACT_FLAGS = new Set([
	"--input",
	"--reason",
	"--answer",
	"--summary",
	"--label"
]);
const REDACTED = "<redacted>";
function looksLikeInlineJson(s) {
	return /^[{[]/.test(s);
}
function looksLikePath(s) {
	return s.includes("/") || s.includes("\\");
}
/**
* Sanitize an argv array into a single-space-joined string safe for URL
* query inclusion. The first non-flag positional after a flag NAME is
* considered its value; if the flag is in ALWAYS_REDACT_FLAGS or the
* value matches a sensitivity heuristic (inline JSON / path), redact.
* Otherwise, if the flag is in ALLOWLIST_VALUE_FLAGS, pass the value
* through; else redact.
*/
function sanitizeArgvForUrl(argv) {
	const out = [];
	for (let i = 0; i < argv.length; i++) {
		const token = argv[i];
		if (!token.startsWith("--")) {
			out.push(isSafePositional(token) ? token : REDACTED);
			continue;
		}
		out.push(token);
		const next = argv[i + 1];
		if (next === void 0 || next.startsWith("--")) continue;
		i++;
		const flag = token;
		if (ALWAYS_REDACT_FLAGS.has(flag)) out.push(REDACTED);
		else if (looksLikeInlineJson(next) || looksLikePath(next)) out.push(REDACTED);
		else if (ALLOWLIST_VALUE_FLAGS.has(flag)) out.push(next);
		else out.push(REDACTED);
	}
	return out.join(" ");
}
/**
* Build the prefilled report URL. Query params: loaf_version /
* schema_version / phase? / sub_state? / last_command (sanitized) /
* crash_log_path?. Per codex r206 PATCH H: nulls are omitted, not
* stringified.
*/
function buildReportUrl(input) {
	const u = new URL(input.base);
	u.searchParams.set("loaf_version", input.loaf_version);
	u.searchParams.set("schema_version", input.schema_version);
	if (input.phase !== null) u.searchParams.set("phase", input.phase);
	if (input.sub_state !== null) u.searchParams.set("sub_state", input.sub_state);
	u.searchParams.set("last_command", sanitizeArgvForUrl(input.argv));
	if (input.crash_log_path !== null) u.searchParams.set("crash_log_path", input.crash_log_path);
	return u.toString();
}
//#endregion
//#region src/cli/input-source.ts
const INLINE_RE = /^[{[]/;
function parseInputSource(arg) {
	if (arg === "-") return { kind: "stdin" };
	if (INLINE_RE.test(arg)) return {
		kind: "inline",
		value: arg
	};
	return {
		kind: "file",
		path: arg
	};
}
//#endregion
//#region src/cli/input-read.ts
const DEFAULT_READ_FILE = (p) => promises.readFile(p, "utf8");
async function readJsonInput(source, deps) {
	const readFile = deps.readFile ?? DEFAULT_READ_FILE;
	let raw;
	switch (source.kind) {
		case "inline":
			raw = source.value;
			break;
		case "stdin":
			try {
				raw = await deps.readStdin();
			} catch (err) {
				const e = err;
				return {
					ok: false,
					code: "MISSING_INPUT",
					message: `cannot read stdin: ${e.message}`,
					detail: { cause: e.message }
				};
			}
			break;
		case "file":
			try {
				raw = await readFile(source.path);
			} catch (err) {
				const e = err;
				if (e.code === "ENOENT") return {
					ok: false,
					code: "INPUT_FILE_NOT_FOUND",
					message: `input file does not exist: ${source.path}`,
					detail: { path: source.path }
				};
				return {
					ok: false,
					code: "INPUT_FILE_NOT_FOUND",
					message: `input file unreadable: ${source.path} — ${e.message}`,
					detail: {
						path: source.path,
						cause: e.message
					}
				};
			}
			break;
	}
	try {
		return {
			ok: true,
			value: JSON.parse(raw)
		};
	} catch (err) {
		return {
			ok: false,
			code: "SCHEMA_VALIDATION_FAILED",
			message: `invalid JSON: ${err.message}`,
			detail: { cause: err.message }
		};
	}
}
//#endregion
//#region src/cli/stdin.ts
async function defaultReadStdin() {
	let buf = "";
	for await (const chunk of process.stdin) buf += typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8");
	return buf;
}
function defaultIsStdinTty() {
	return process.stdin.isTTY === true;
}
const SchemaVersionPayload = z.literal(2);
const ReqIdPayload = z.string().regex(/^REQ-[A-Z][A-Z0-9]*-\d{3,}$/);
const ScenIdPayload = z.string().regex(/^SCEN-[A-Z][A-Z0-9-]*-\d{3,}$/);
const VisIdPayload = z.string().regex(/^VIS-[A-Z][A-Z0-9-]*-\d{3,}$/);
const FeatureIdPayload = z.string().regex(/^F-\d{3,}$/);
const NcIdPayload = z.string().regex(/^NC-\d{3,}$/);
const MeasurablePayload = z.object({
	metric: z.string().min(3),
	threshold: z.union([z.string(), z.number()]),
	unit: z.string().optional(),
	direction: z.enum([
		"lte",
		"gte",
		"eq"
	]).default("lte")
}).passthrough();
const VerifiabilityFields = z.object({
	measurable: MeasurablePayload.optional(),
	verified_by_scenarios: z.array(ScenIdPayload).optional(),
	acceptance_na: z.literal(true).optional(),
	acceptance_na_reason: z.string().min(10).optional()
});
function hasVerifiability(req) {
	const hasMeasurable = req.measurable !== void 0;
	const hasScenarios = req.verified_by_scenarios !== void 0 && req.verified_by_scenarios.length > 0;
	const hasNa = req.acceptance_na === true && (req.acceptance_na_reason?.length ?? 0) >= 10;
	return hasMeasurable || hasScenarios || hasNa;
}
const ReqBase = z.object({ id: ReqIdPayload });
const RequirementUbiquitousShape = ReqBase.extend({
	type: z.literal("ubiquitous"),
	response: z.string().min(10)
}).and(VerifiabilityFields);
const RequirementEventDrivenShape = ReqBase.extend({
	type: z.literal("event-driven"),
	trigger: z.string().min(5),
	response: z.string().min(10)
}).and(VerifiabilityFields);
const RequirementStateDrivenShape = ReqBase.extend({
	type: z.literal("state-driven"),
	while_: z.string().min(5),
	behavior: z.string().min(10)
}).and(VerifiabilityFields);
const RequirementOptionalShape = ReqBase.extend({
	type: z.literal("optional"),
	feature: z.string().min(5),
	response: z.string().min(10)
}).and(VerifiabilityFields);
const RequirementUnwantedShape = ReqBase.extend({
	type: z.literal("unwanted"),
	condition: z.string().min(5),
	response: z.string().min(10)
}).and(VerifiabilityFields);
const RequirementEarsShape = z.union([
	RequirementUbiquitousShape,
	RequirementEventDrivenShape,
	RequirementStateDrivenShape,
	RequirementOptionalShape,
	RequirementUnwantedShape
]);
const RequirementEarsVerifiable = RequirementEarsShape.refine(hasVerifiability, { message: "REQ must declare measurable, verified_by_scenarios[], or acceptance_na+reason (≥10 chars)" });
const ScenarioGherkin = z.object({
	id: ScenIdPayload,
	name: z.string().min(3),
	tag: z.enum([
		"happy",
		"edge",
		"error",
		"e2e"
	]).optional(),
	requires_acceptance: z.boolean().optional(),
	acceptance_na: z.string().min(5).optional(),
	given: z.array(z.string().min(3)).min(1),
	when: z.array(z.string().min(3)).min(1),
	then: z.array(z.string().min(3)).min(1)
}).refine((s) => !(s.tag === "e2e" && s.acceptance_na !== void 0 && s.requires_acceptance), { message: "cannot set both requires_acceptance and acceptance_na" });
const VisualContract = z.object({
	id: VisIdPayload,
	target: z.string().min(3),
	checks: z.array(z.string().min(3)).min(1),
	requires_visual: z.boolean().optional(),
	visual_na: z.string().min(5).optional()
}).passthrough();
const NeedsClarification = z.object({
	id: NcIdPayload,
	question: z.string().min(5),
	context: z.string().optional(),
	options: z.array(z.string()).optional()
}).passthrough();
const SpecFrontmatter = z.object({
	schema_version: SchemaVersionPayload,
	spec_version: z.number().int().positive(),
	feature: z.object({
		id: FeatureIdPayload,
		name: z.string().min(3)
	}),
	intent: z.string().min(20),
	adr_refs: z.array(z.string()),
	requirements: z.array(RequirementEarsShape),
	scenarios: z.array(ScenarioGherkin),
	visual_contracts: z.array(VisualContract).optional(),
	needs_clarification: z.array(NeedsClarification)
});
const SpecSubmitInput = z.object({
	spec_version: z.number().int().positive().optional(),
	feature: z.object({
		id: FeatureIdPayload,
		name: z.string().min(3)
	}),
	intent: z.string().min(20),
	adr_refs: z.array(z.string()).default([]),
	requirements: z.array(RequirementEarsVerifiable).default([]),
	scenarios: z.array(ScenarioGherkin).default([]),
	visual_contracts: z.array(VisualContract).default([]),
	needs_clarification: z.array(NeedsClarification).default([])
}).passthrough();
const ReqIdNamespace = z.string().regex(/^REQ-[A-Z][A-Z0-9]*$/);
const ScenIdNamespace = z.string().regex(/^SCEN-[A-Z][A-Z0-9-]*$/);
const VisIdNamespace = z.string().regex(/^VIS-[A-Z][A-Z0-9-]*$/);
const rejectCallerSuppliedId = (v) => !("id" in v);
const ID_REJECTION_MESSAGE = "id_namespace expected; full id is CLI-allocated and must not be supplied in input";
const SpecAddReqInputItemShape = z.object({
	id_namespace: ReqIdNamespace,
	type: z.enum([
		"ubiquitous",
		"event-driven",
		"state-driven",
		"optional",
		"unwanted"
	])
}).passthrough().refine(rejectCallerSuppliedId, { message: ID_REJECTION_MESSAGE });
const SpecAddReqInput = z.union([SpecAddReqInputItemShape, z.array(SpecAddReqInputItemShape).min(1)]);
const SpecAddScenarioInputItemShape = z.object({
	id_namespace: ScenIdNamespace,
	name: z.string().min(3)
}).passthrough().refine(rejectCallerSuppliedId, { message: ID_REJECTION_MESSAGE });
const SpecAddScenarioInput = z.union([SpecAddScenarioInputItemShape, z.array(SpecAddScenarioInputItemShape).min(1)]);
const SpecAddVisualInputItemShape = z.object({
	id_namespace: VisIdNamespace,
	target: z.string().min(3)
}).passthrough().refine(rejectCallerSuppliedId, { message: ID_REJECTION_MESSAGE });
const SpecAddVisualInput = z.union([SpecAddVisualInputItemShape, z.array(SpecAddVisualInputItemShape).min(1)]);
/**
* Per-namespace id allocator: scan existing ids in `existing` for
* those matching `<namespace>-<digits>`, find max serial, return next.
* Used by CLI to stamp full ids on add-* invocations.
*/
function nextSerialInNamespace(existing, namespace) {
	const prefix = `${namespace}-`;
	let max = 0;
	for (const id of existing) {
		if (!id.startsWith(prefix)) continue;
		const tail = id.slice(prefix.length);
		const n = Number.parseInt(tail, 10);
		if (Number.isNaN(n)) continue;
		if (n > max) max = n;
	}
	return max + 1;
}
//#endregion
//#region src/core/task-schema.ts
const TaskIdPayload = z.string().regex(/^T-\d{3,}$/);
const EvidenceRefPayload = z.string().regex(/^EV-\d{6,}$/);
const RawDrivesRef = z.string().regex(/^(REQ|SCEN|VIS)-[A-Z][A-Z0-9-]*-\d{3,}$/);
z.union([
	ReqIdPayload,
	ScenIdPayload,
	VisIdPayload
]);
const ApplicabilityPayload = z.enum([
	"must",
	"optional",
	"na"
]);
const StepStatusPayload = z.enum([
	"na",
	"pending",
	"running",
	"passed",
	"failed",
	"waived"
]);
const TaskExecutionStepPayload = z.object({
	applicability: ApplicabilityPayload,
	status: StepStatusPayload,
	reason: z.string().optional(),
	evidence_refs: z.array(EvidenceRefPayload).default([]),
	started_at: z.string().datetime().optional()
});
const BehavioralExecutionPayload = z.object({
	red: TaskExecutionStepPayload,
	implement: TaskExecutionStepPayload,
	refactor: TaskExecutionStepPayload
});
const StructuralExecutionPayload = z.object({
	implement: TaskExecutionStepPayload,
	refactor: TaskExecutionStepPayload
});
const VisualUiExecutionPayload = z.object({
	mockup: TaskExecutionStepPayload,
	implement: TaskExecutionStepPayload,
	"screenshot-compare": TaskExecutionStepPayload
});
const DocsExecutionPayload = z.object({
	draft: TaskExecutionStepPayload,
	review: TaskExecutionStepPayload
});
const SpikeExecutionPayload = z.object({
	explore: TaskExecutionStepPayload,
	prototype: TaskExecutionStepPayload,
	record: TaskExecutionStepPayload
});
const ChoreExecutionPayload = z.object({ execute: TaskExecutionStepPayload });
const TaskStatusPayload = z.enum([
	"pending",
	"ready",
	"in_progress",
	"done",
	"abandoned"
]);
const TaskBase = z.object({
	id: TaskIdPayload,
	depends_on: z.array(TaskIdPayload).default([]),
	labels: z.array(z.string()).default([]),
	status: TaskStatusPayload
});
const TaskBehavioralPayload = TaskBase.extend({
	kind: z.literal("behavioral"),
	drives: z.array(RawDrivesRef).min(1),
	tests: z.array(z.string().min(3)).min(1),
	test_layer: z.enum([
		"unit",
		"integration",
		"e2e"
	]).optional(),
	red_test_registered: z.boolean().optional(),
	execution: BehavioralExecutionPayload,
	requires_acceptance: z.boolean().optional(),
	requires_visual: z.boolean().optional()
});
const TaskStructuralPayload = TaskBase.extend({
	kind: z.literal("structural"),
	drives: z.array(RawDrivesRef).optional(),
	no_test_rationale: z.string().min(10),
	execution: StructuralExecutionPayload
});
const TaskVisualUiPayload = TaskBase.extend({
	kind: z.literal("visual-ui"),
	drives: z.array(RawDrivesRef).optional(),
	visual_contract_refs: z.array(VisIdPayload).min(1),
	no_test_rationale: z.string().min(10).optional(),
	execution: VisualUiExecutionPayload
});
const TaskDocsPayload = TaskBase.extend({
	kind: z.literal("docs"),
	drives: z.array(RawDrivesRef).optional(),
	no_test_rationale: z.string().min(10),
	execution: DocsExecutionPayload
});
const TaskSpikePayload = TaskBase.extend({
	kind: z.literal("spike"),
	drives: z.array(RawDrivesRef).optional(),
	no_test_rationale: z.string().min(10),
	execution: SpikeExecutionPayload
});
const TaskChorePayload = TaskBase.extend({
	kind: z.literal("chore"),
	drives: z.array(RawDrivesRef).optional(),
	no_test_rationale: z.string().min(10),
	execution: ChoreExecutionPayload
});
const TaskFullPayload = z.union([
	TaskBehavioralPayload,
	TaskStructuralPayload,
	TaskVisualUiPayload,
	TaskDocsPayload,
	TaskSpikePayload,
	TaskChorePayload
]);
function extractTaskSteps(exec) {
	const out = {};
	for (const [name, step] of Object.entries(exec)) out[name] = {
		applicability: step.applicability,
		status: step.status
	};
	return out;
}
/**
* Extract a slim TaskState projection from a TaskFull payload. Body fields
* (tests / test_layer / execution.evidence_refs / reason / started_at) stay
* in the journal payload as canonical truth — only cross-cutting fields
* needed by spec-lock checks + auto-promote land in the projection.
*/
function extractTaskSlim(t) {
	const out = {
		id: t.id,
		kind: t.kind,
		status: t.status,
		steps: extractTaskSteps(t.execution),
		drives: t.drives ?? [],
		depends_on: t.depends_on,
		labels: t.labels
	};
	if (t.red_test_registered !== void 0) out.red_test_registered = t.red_test_registered;
	if (t.no_test_rationale !== void 0) out.no_test_rationale = t.no_test_rationale;
	if (t.visual_contract_refs !== void 0) out.visual_contract_refs = t.visual_contract_refs;
	if (t.requires_acceptance !== void 0) out.requires_acceptance = t.requires_acceptance;
	if (t.requires_visual !== void 0) out.requires_visual = t.requires_visual;
	return out;
}
/**
* Auto-promote predicate (codex r23 BLOCK 2 fix): a task is ready to be
* promoted to status="done" when every must-applicable step is in a
* terminal-positive state. Optional / na applicability never blocks.
*/
function shouldPromoteToDone(steps) {
	const mustSteps = Object.values(steps).filter((s) => s.applicability === "must");
	if (mustSteps.length === 0) return false;
	return mustSteps.every((s) => s.status === "passed" || s.status === "waived" || s.status === "na");
}
const TaskInputBaseShape = {
	drives: z.array(RawDrivesRef).optional(),
	depends_on: z.array(TaskIdPayload).default([]),
	labels: z.array(z.string()).default([])
};
const TaskBehavioralInput = z.object({
	...TaskInputBaseShape,
	kind: z.literal("behavioral"),
	drives: z.array(RawDrivesRef).min(1),
	tests: z.array(z.string().min(3)).min(1),
	test_layer: z.enum([
		"unit",
		"integration",
		"e2e"
	]).optional(),
	requires_acceptance: z.boolean().optional(),
	requires_visual: z.boolean().optional()
}).strict();
const TaskStructuralInput = z.object({
	...TaskInputBaseShape,
	kind: z.literal("structural"),
	no_test_rationale: z.string().min(10)
}).strict();
const TaskVisualUiInput = z.object({
	...TaskInputBaseShape,
	kind: z.literal("visual-ui"),
	visual_contract_refs: z.array(VisIdPayload).min(1),
	no_test_rationale: z.string().min(10).optional()
}).strict();
const TaskDocsInput = z.object({
	...TaskInputBaseShape,
	kind: z.literal("docs"),
	no_test_rationale: z.string().min(10)
}).strict();
const TaskSpikeInput = z.object({
	...TaskInputBaseShape,
	kind: z.literal("spike"),
	no_test_rationale: z.string().min(10)
}).strict();
const TaskChoreInput = z.object({
	...TaskInputBaseShape,
	kind: z.literal("chore"),
	no_test_rationale: z.string().min(10)
}).strict();
const TaskInput = z.union([
	TaskBehavioralInput,
	TaskStructuralInput,
	TaskVisualUiInput,
	TaskDocsInput,
	TaskSpikeInput,
	TaskChoreInput
]);
const KIND_EXECUTION_STEPS = {
	behavioral: Object.keys(BehavioralExecutionPayload.shape),
	structural: Object.keys(StructuralExecutionPayload.shape),
	"visual-ui": Object.keys(VisualUiExecutionPayload.shape),
	docs: Object.keys(DocsExecutionPayload.shape),
	spike: Object.keys(SpikeExecutionPayload.shape),
	chore: Object.keys(ChoreExecutionPayload.shape)
};
/**
* Materialize a validated `TaskInput` into a full `TaskFullPayload` by
* stamping the three CLI-owned fields: the allocated `id`, `status="pending"`,
* and a per-kind `execution` map whose every step starts at
* applicability="must", status="pending" (docs/schemas.ts §40 — `tasks
* amend --policy` is the path to narrow applicability afterward).
*/
function materializeTaskInput(input, id) {
	const execution = {};
	for (const step of KIND_EXECUTION_STEPS[input.kind]) execution[step] = {
		applicability: "must",
		status: "pending",
		evidence_refs: []
	};
	return {
		...input,
		id,
		status: "pending",
		execution
	};
}
//#endregion
//#region src/core/evidence-schema.ts
const EvidenceKind = z.enum([
	"task-summary",
	"verify-review",
	"spec-review",
	"acceptance",
	"visual-review",
	"gate-decision",
	"local-check",
	"manual",
	"waiver",
	"spike-finding"
]);
const EvidenceResult = z.enum([
	"passed",
	"failed",
	"approved",
	"rejected",
	"waived"
]);
const VerifyCheckKind = z.enum([
	"run",
	"review",
	"acceptance",
	"visual"
]);
const GateNamePayload = z.enum(["spec-lock", "verify-accept"]);
const AttachmentPayload = z.object({
	path: z.string().min(3),
	sha256: z.string().regex(/^[a-f0-9]{64}$/),
	mime: z.string().min(3),
	bytes: z.number().int().positive().optional()
}).strict();
const AttachmentRefShape = z.object({
	path: z.string().min(3),
	sha256: z.string().regex(/^[a-f0-9]{64}$/),
	size: z.number().int().nonnegative()
}).strict();
const LongTextFieldPayload = z.discriminatedUnion("mode", [z.object({
	mode: z.literal("inline"),
	text: z.string()
}).strict(), z.object({
	mode: z.literal("sidecar"),
	ref: AttachmentRefShape
}).strict()]);
const SummaryField = z.union([z.string().min(3), LongTextFieldPayload]);
const EvidenceIdPayload = z.string().regex(/^EV-\d{6,}$/);
const CoversRefPayload = z.union([
	ReqIdPayload,
	ScenIdPayload,
	VisIdPayload,
	TaskIdPayload
]);
const EvidenceFullShape = z.object({
	id: EvidenceIdPayload,
	kind: EvidenceKind,
	iteration: z.number().int().positive(),
	actor: z.string().min(1),
	result: EvidenceResult,
	summary: SummaryField,
	covers: z.array(CoversRefPayload).default([]),
	task_id: TaskIdPayload.optional(),
	check: VerifyCheckKind.optional(),
	cmd: z.string().optional(),
	exit: z.number().int().optional(),
	wall_ms: z.number().int().optional(),
	gate: GateNamePayload.optional(),
	decided_by: z.string().optional(),
	reason: z.string().optional(),
	based_on: z.object({
		spec: z.number().int().nonnegative(),
		tasks: z.number().int().nonnegative()
	}).strict().optional(),
	attachments: z.array(AttachmentPayload).optional(),
	waiver_obligation_id: z.string().optional(),
	external_ref: z.string().optional()
}).strict();
const EvidenceFullPayload = EvidenceFullShape.refine((e) => {
	if (e.kind === "manual" || e.kind === "waiver") {
		if (!e.actor.startsWith("human:")) return false;
		if (!e.reason || e.reason.length < 10) return false;
	}
	return true;
}, { message: "evidence kind=manual/waiver requires actor=human:* and reason ≥10 chars (per §5.4)" }).refine((e) => {
	if (e.kind === "visual-review") {
		if (!e.attachments || e.attachments.length === 0) return false;
	}
	return true;
}, { message: "evidence kind=visual-review requires ≥1 attachment (per §5.4 + §1695-1700)" });
const EvidenceAddInput = EvidenceFullShape.omit({ id: true }).strict();
z.union([EvidenceAddInput, z.array(EvidenceAddInput).nonempty()]);
//#endregion
//#region src/core/finding-schema.ts
const FindingId = z.string().regex(/^FND-\d{3,}$/);
const FindingCategory = z.enum([
	"spec-gap",
	"spec-defect",
	"impl-defect",
	"test-defect",
	"new-scope",
	"risk-escalation"
]);
const FindingAction = z.enum([
	"amend-spec",
	"amend-tasks",
	"fix-impl",
	"fix-test",
	"defer",
	"backlog"
]);
z.enum([
	"typical",
	"unusual",
	"incoherent"
]);
/**
* FINDING_ACTION_GRID — per-cell risk classification.
* 4 `incoherent` cells (rev 4.3 ADR-0004 A7): structurally there is no
* task target a transition can land on, so block early at preflight.
* Mirrors `docs/protocol.md §4.5 finding matrix` and `docs/schemas.ts §37
* FINDING_ACTION_GRID`.
*/
const FINDING_ACTION_GRID = {
	"spec-gap": {
		"amend-spec": "typical",
		"amend-tasks": "unusual",
		"fix-impl": "incoherent",
		"fix-test": "incoherent",
		"defer": "typical",
		"backlog": "typical"
	},
	"spec-defect": {
		"amend-spec": "typical",
		"amend-tasks": "unusual",
		"fix-impl": "unusual",
		"fix-test": "unusual",
		"defer": "typical",
		"backlog": "typical"
	},
	"impl-defect": {
		"amend-spec": "unusual",
		"amend-tasks": "typical",
		"fix-impl": "typical",
		"fix-test": "unusual",
		"defer": "typical",
		"backlog": "typical"
	},
	"test-defect": {
		"amend-spec": "unusual",
		"amend-tasks": "typical",
		"fix-impl": "unusual",
		"fix-test": "typical",
		"defer": "typical",
		"backlog": "typical"
	},
	"new-scope": {
		"amend-spec": "typical",
		"amend-tasks": "typical",
		"fix-impl": "incoherent",
		"fix-test": "incoherent",
		"defer": "typical",
		"backlog": "typical"
	},
	"risk-escalation": {
		"amend-spec": "unusual",
		"amend-tasks": "typical",
		"fix-impl": "unusual",
		"fix-test": "unusual",
		"defer": "typical",
		"backlog": "typical"
	}
};
/** Look up the (category, action) cell risk in O(1). */
function cellRisk(category, action) {
	return FINDING_ACTION_GRID[category][action];
}
const FINDING_ACTION_TARGET_MODE = {
	"amend-spec": "none",
	"amend-tasks": "task_id_optional",
	"fix-impl": "task_id_step",
	"fix-test": "task_id_step",
	"defer": "none",
	"backlog": "none"
};
/**
* For `task_id_step` actions only, the canonical step that the action's
* back-edge mutation targets. fix-impl drives the `implement` step;
* fix-test drives the `red` step (TDD failure-first lane).
*/
const FIX_ACTION_STEP = {
	"fix-impl": "implement",
	"fix-test": "red"
};
const FindingTarget = z.object({
	task_id: TaskIdPayload,
	step: z.string().min(1)
}).strict();
//#endregion
//#region src/core/journal-entry.ts
const ENTRY_BYTE_LIMIT = 64e3;
const EntryId = z.string().regex(/^JE-\d{6,}$/, { message: "entry_id must match /^JE-\\d{6,}$/ (e.g. JE-000123)" });
const ActorString = z.string().regex(/^(human|skill|ci|cli|migration):[^\s].*$/, { message: "actor must be of form '<prefix>:<id>' where prefix ∈ {human, skill, ci, cli, migration}" });
const AttachmentRef = z.object({
	path: z.string().min(1),
	sha256: z.string().regex(/^[a-f0-9]{64}$/),
	size: z.number().int().nonnegative()
}).strict();
const LongTextField = z.discriminatedUnion("mode", [z.object({
	mode: z.literal("inline"),
	text: z.string()
}).strict(), z.object({
	mode: z.literal("sidecar"),
	ref: AttachmentRef
}).strict()]);
const MigrationSnapshotImportedPayload = z.object({
	source_schema_version: z.number().int().positive(),
	migrated_at: z.string().datetime(),
	artifacts: z.object({
		state: AttachmentRef,
		tasks: AttachmentRef,
		spec_md: AttachmentRef,
		evidence: AttachmentRef,
		findings: AttachmentRef,
		pending: AttachmentRef
	}).strict()
}).strict();
const SubState = z.enum([
	"TRIAGE.score",
	"TRIAGE.confirm",
	"SPEC.proposal",
	"SPEC.spec",
	"SPEC.plan",
	"SPEC.design",
	"EXECUTE.plan",
	"EXECUTE.work",
	"EXECUTE.done",
	"VERIFY.plan",
	"VERIFY.run",
	"VERIFY.review",
	"VERIFY.acceptance",
	"VERIFY.visual",
	"VERIFY.accept",
	"SETTLE.reconcile",
	"SETTLE.lessons",
	"DONE.delivered",
	"DONE.archived",
	"DONE.abandoned"
]);
const Ceremony = z.object({
	spec_phase: z.boolean(),
	verify_phase: z.boolean(),
	settle_phase: z.boolean(),
	strict_spec_review: z.boolean(),
	lessons_required: z.enum([
		"must",
		"may",
		"skip"
	]),
	strict_drift_check: z.boolean()
}).refine((c) => !c.settle_phase || c.verify_phase, { message: "settle_phase=true requires verify_phase=true" }).refine((c) => !c.strict_spec_review || c.spec_phase, { message: "strict_spec_review=true requires spec_phase=true" }).refine((c) => c.lessons_required === "skip" || c.settle_phase, { message: "lessons_required!=skip requires settle_phase=true" }).refine((c) => !c.strict_drift_check || c.settle_phase, { message: "strict_drift_check=true requires settle_phase=true" });
const GateName = z.enum(["spec-lock", "verify-accept"]);
const EntryKind = z.enum([
	"event:phase_advanced",
	"event:ceremony_set",
	"event:tasks_planned",
	"event:tasks_amended",
	"event:task_claimed",
	"event:task_step_started",
	"event:task_step_done",
	"event:task_step_reset",
	"event:task_abandoned",
	"event:spec_req_added",
	"event:spec_scenario_added",
	"event:spec_visual_added",
	"event:spec_submitted",
	"evidence:added",
	"finding:raised",
	"finding:closed",
	"pending:added",
	"pending:resolved",
	"gate:decided",
	"session:started",
	"session:resumed",
	"session:delivered",
	"session:archived",
	"session:abandoned",
	"spike:converted",
	"migration:snapshot_imported"
]);
const JournalEntry = z.object({
	seq: z.number().int().nonnegative(),
	entry_id: EntryId,
	at: z.string().datetime(),
	actor: ActorString,
	entry_schema_version: z.number().int().positive(),
	kind: EntryKind,
	payload: z.unknown(),
	batch_id: z.string().uuid().optional(),
	batch_index: z.number().int().nonnegative().optional(),
	batch_count: z.number().int().positive().optional()
}).strict().refine((e) => {
	const present = [
		e.batch_id,
		e.batch_index,
		e.batch_count
	].filter((v) => v !== void 0).length;
	return present === 0 || present === 3;
}, { message: "batch_id, batch_index, batch_count must be all-present or all-absent" }).refine((e) => e.batch_index === void 0 || e.batch_count === void 0 || e.batch_index < e.batch_count, { message: "batch_index must be < batch_count" });
const RecordPayload = z.record(z.string(), z.unknown());
const CeremonyPayload = z.object({
	spec_phase: z.boolean(),
	verify_phase: z.boolean(),
	settle_phase: z.boolean(),
	strict_spec_review: z.boolean(),
	lessons_required: z.enum([
		"must",
		"may",
		"skip"
	]),
	strict_drift_check: z.boolean()
}).passthrough();
const SessionStartedPayload = z.object({
	session_id: z.string().min(1),
	feature: z.string().min(1),
	ceremony: CeremonyPayload,
	session_label: z.string().min(3).optional(),
	ceremony_label: z.string().optional(),
	workspace: z.string().min(1).optional(),
	loaf_version_required: z.string().regex(/^[\^~]?\d+\.\d+(\.\d+)?(-[0-9A-Za-z.-]+)?(\+[0-9A-Za-z.-]+)?$/).optional()
}).passthrough();
const BackEdgeAmendSpec = z.object({
	action: z.literal("amend-spec"),
	finding_id: FindingId
}).strict();
const BackEdgeAmendTasks = z.object({
	action: z.literal("amend-tasks"),
	finding_id: FindingId
}).strict();
const BackEdgeFixImpl = z.object({
	action: z.literal("fix-impl"),
	finding_id: FindingId
}).strict();
const BackEdgeFixTest = z.object({
	action: z.literal("fix-test"),
	finding_id: FindingId
}).strict();
const BackEdge = z.discriminatedUnion("action", [
	BackEdgeAmendSpec,
	BackEdgeAmendTasks,
	BackEdgeFixImpl,
	BackEdgeFixTest
]);
const PhaseAdvancedPayload = z.object({
	from: SubState,
	to: SubState,
	/**
	* Back-edge sponsorship (Slice B / Phase 11 Item 3). When set, `to`
	* MUST be the target dictated by `action` (amend-spec → SPEC.spec;
	* amend-tasks / fix-impl / fix-test → EXECUTE.work), and the referenced
	* finding MUST exist in snapshot.findings with matching action and
	* status="open" (preflight enforces). Absent on forward transitions
	* (the default).
	*/
	back_edge: BackEdge.optional()
}).passthrough();
const GateDecidedPayload = z.object({
	gate_kind: GateName,
	decision: z.enum(["approved", "rejected"]),
	reason: z.string().min(1)
}).passthrough();
const TaskRefPayload = z.object({ task_id: TaskIdPayload }).passthrough();
const TaskStepRefPayload = z.object({
	task_id: TaskIdPayload,
	step: z.string().min(1)
}).passthrough();
const TaskAbandonedPayload = z.object({
	task_id: TaskIdPayload,
	reason: z.string().min(1)
}).passthrough();
const TaskStepDonePayload = z.object({
	task_id: TaskIdPayload,
	step: z.string().min(1),
	result: z.enum([
		"passed",
		"failed",
		"waived",
		"na"
	]).optional(),
	red_test_registered: z.boolean().optional()
}).passthrough();
const TaskStepResetPayload = z.object({
	task_id: TaskIdPayload,
	step: z.string().min(1),
	finding_id: FindingId
}).strict();
const TasksPlannedPayload = z.object({
	based_on: z.object({ spec: z.number().int().positive() }),
	tasks: z.array(TaskFullPayload)
}).passthrough();
const TasksAmendedPayload = z.object({
	mode: z.enum(["add", "replace"]).default("replace"),
	task: TaskFullPayload,
	reason: z.string().min(10).optional(),
	sponsored_by_finding_id: FindingId.optional()
}).strict();
const EvidenceAddedPayload = EvidenceFullPayload;
const FindingRaisedPayload = z.object({
	id: FindingId,
	category: FindingCategory,
	action: FindingAction,
	summary: z.string().min(3).optional(),
	reason: z.string().optional(),
	target: FindingTarget.optional()
}).passthrough();
const FindingClosedPayload = z.object({ id: FindingId }).passthrough();
const PendingId = z.string().regex(/^PEND-\d{4,}$/);
const PendingPromptKind = z.enum([
	"ask_user_question",
	"gate_decision",
	"spec_clarification",
	"finding_decision",
	"profile_escalation"
]);
const PendingAddedPayload = z.object({
	id: PendingId,
	kind: PendingPromptKind,
	question: z.string().min(3)
}).passthrough();
const PendingResolvedPayload = z.object({ id: PendingId }).passthrough();
const SessionReasonPayload = z.object({ reason: z.string().min(1).optional() }).passthrough();
const SpikeConvertedPayload = z.object({
	to_feature: FeatureIdPayload,
	reason: z.string().min(1)
}).strict();
const BatchSpecVersion = z.number().int().positive();
const SpecSubmittedPayload = z.object({
	spec_version: BatchSpecVersion,
	feature: z.object({
		id: FeatureIdPayload,
		name: z.string().min(3)
	}).passthrough(),
	intent: z.string().min(20),
	adr_refs: z.array(z.string()),
	needs_clarification: z.array(NeedsClarification)
}).passthrough();
const PER_KIND_PAYLOAD = {
	"event:phase_advanced": PhaseAdvancedPayload,
	"event:ceremony_set": CeremonyPayload,
	"event:tasks_planned": TasksPlannedPayload,
	"event:tasks_amended": TasksAmendedPayload,
	"event:task_claimed": TaskRefPayload,
	"event:task_step_started": TaskStepRefPayload,
	"event:task_step_done": TaskStepDonePayload,
	"event:task_step_reset": TaskStepResetPayload,
	"event:task_abandoned": TaskAbandonedPayload,
	"event:spec_req_added": z.object({
		spec_version: BatchSpecVersion,
		req: RequirementEarsVerifiable
	}).passthrough(),
	"event:spec_scenario_added": z.object({
		spec_version: BatchSpecVersion,
		scenario: ScenarioGherkin
	}).passthrough(),
	"event:spec_visual_added": z.object({
		spec_version: BatchSpecVersion,
		visual: VisualContract
	}).passthrough(),
	"event:spec_submitted": SpecSubmittedPayload,
	"evidence:added": EvidenceAddedPayload,
	"finding:raised": FindingRaisedPayload,
	"finding:closed": FindingClosedPayload,
	"pending:added": PendingAddedPayload,
	"pending:resolved": PendingResolvedPayload,
	"gate:decided": GateDecidedPayload,
	"session:started": SessionStartedPayload,
	"session:resumed": RecordPayload,
	"session:delivered": SessionReasonPayload,
	"session:archived": SessionReasonPayload,
	"session:abandoned": SessionReasonPayload,
	"spike:converted": SpikeConvertedPayload,
	"migration:snapshot_imported": MigrationSnapshotImportedPayload
};
const REDUCER_IMPLEMENTED_KINDS = new Set([
	"session:started",
	"migration:snapshot_imported",
	"event:phase_advanced",
	"event:ceremony_set",
	"event:tasks_planned",
	"event:tasks_amended",
	"event:task_claimed",
	"event:task_step_started",
	"event:task_step_done",
	"event:task_step_reset",
	"event:task_abandoned",
	"event:spec_submitted",
	"event:spec_req_added",
	"event:spec_scenario_added",
	"event:spec_visual_added",
	"evidence:added",
	"finding:raised",
	"finding:closed",
	"pending:added",
	"pending:resolved",
	"gate:decided",
	"session:delivered",
	"session:archived",
	"session:abandoned",
	"spike:converted"
]);
//#endregion
//#region src/core/actor-resolver.ts
const NAMESPACE_PREFIXES = [
	"human:",
	"skill:",
	"ci:",
	"cli:",
	"migration:"
];
function buildHumanActor(rawValue) {
	if (rawValue.length === 0) return {
		ok: false,
		code: "INVALID_ACTOR_FORMAT",
		message: "actor value is empty (check $LOAF_USER)"
	};
	if (rawValue.trim().length === 0) return {
		ok: false,
		code: "INVALID_ACTOR_FORMAT",
		message: "actor value is all whitespace (check $LOAF_USER)"
	};
	if (rawValue !== rawValue.trim()) return {
		ok: false,
		code: "INVALID_ACTOR_FORMAT",
		message: "actor value has leading/trailing whitespace; trim $LOAF_USER"
	};
	if (NAMESPACE_PREFIXES.some((p) => rawValue.startsWith(p))) return {
		ok: false,
		code: "INVALID_ACTOR_FORMAT",
		message: "actor value starts with a reserved namespace prefix (human: / skill: / ci: / cli: / migration:); pass the raw identifier without prefix"
	};
	const candidate = `human:${rawValue}`;
	if (!ActorString.safeParse(candidate).success) return {
		ok: false,
		code: "INVALID_ACTOR_FORMAT",
		message: "actor candidate does not satisfy ActorString format"
	};
	return {
		ok: true,
		actor: candidate
	};
}
function resolveHumanActor(deps) {
	const envValue = deps.env.LOAF_USER;
	if (envValue !== void 0) return buildHumanActor(envValue);
	if (!deps.isInteractiveHuman) return {
		ok: false,
		code: "NO_HUMAN_ACTOR",
		message: "non-interactive context (isInteractiveHuman=false) and $LOAF_USER unset; refusing to auto-derive human actor from git config. Set LOAF_USER explicitly."
	};
	let gitEmail = null;
	try {
		gitEmail = deps.readGitConfig();
	} catch {
		gitEmail = null;
	}
	if (gitEmail === null || gitEmail.length === 0) return {
		ok: false,
		code: "NO_HUMAN_ACTOR",
		message: "no $LOAF_USER set and git config user.email unavailable or empty; set LOAF_USER or configure git user.email"
	};
	return buildHumanActor(gitEmail);
}
//#endregion
//#region src/core/reducer/transition.ts
const LEGAL_TRANSITIONS = {
	"TRIAGE.score": ["TRIAGE.confirm"],
	"TRIAGE.confirm": ["SPEC.proposal", "EXECUTE.plan"],
	"SPEC.proposal": ["SPEC.spec"],
	"SPEC.spec": ["SPEC.plan"],
	"SPEC.plan": ["SPEC.design"],
	"SPEC.design": ["EXECUTE.plan"],
	"EXECUTE.plan": ["EXECUTE.work"],
	"EXECUTE.work": ["EXECUTE.done"],
	"EXECUTE.done": ["VERIFY.plan"],
	"VERIFY.plan": ["VERIFY.run"],
	"VERIFY.run": [
		"VERIFY.review",
		"VERIFY.acceptance",
		"VERIFY.visual",
		"VERIFY.accept"
	],
	"VERIFY.review": [
		"VERIFY.acceptance",
		"VERIFY.visual",
		"VERIFY.accept"
	],
	"VERIFY.acceptance": ["VERIFY.visual", "VERIFY.accept"],
	"VERIFY.visual": ["VERIFY.accept"],
	"VERIFY.accept": ["SETTLE.reconcile"],
	"SETTLE.reconcile": ["SETTLE.lessons"],
	"SETTLE.lessons": [],
	"DONE.delivered": [],
	"DONE.archived": [],
	"DONE.abandoned": []
};
const BACK_EDGE_FROM = {
	"amend-spec": new Set([
		"EXECUTE.plan",
		"EXECUTE.work",
		"EXECUTE.done",
		"VERIFY.plan",
		"VERIFY.run",
		"VERIFY.review",
		"VERIFY.acceptance",
		"VERIFY.visual",
		"VERIFY.accept"
	]),
	"amend-tasks": new Set([
		"EXECUTE.work",
		"EXECUTE.done",
		"VERIFY.plan",
		"VERIFY.run",
		"VERIFY.review",
		"VERIFY.acceptance",
		"VERIFY.visual",
		"VERIFY.accept"
	]),
	"fix-impl": new Set([
		"EXECUTE.work",
		"EXECUTE.done",
		"VERIFY.plan",
		"VERIFY.run",
		"VERIFY.review",
		"VERIFY.acceptance",
		"VERIFY.visual",
		"VERIFY.accept"
	]),
	"fix-test": new Set([
		"EXECUTE.work",
		"EXECUTE.done",
		"VERIFY.plan",
		"VERIFY.run",
		"VERIFY.review",
		"VERIFY.acceptance",
		"VERIFY.visual",
		"VERIFY.accept"
	])
};
function validateTransition(prev, target, ctx) {
	if (ctx.back_edge !== void 0) {
		if (ctx.back_edge.action === "amend-spec") {
			if (target !== "SPEC.spec") return {
				ok: false,
				code: "TRANSITION_ILLEGAL",
				message: `back_edge action=amend-spec requires target=SPEC.spec, got ${target}`,
				detail: {
					from: prev,
					to: target,
					back_edge_action: ctx.back_edge.action,
					expected_target: "SPEC.spec",
					reason: "back_edge_target_mismatch"
				}
			};
			const allowedFrom = BACK_EDGE_FROM["amend-spec"];
			if (!allowedFrom.has(prev)) return {
				ok: false,
				code: "TRANSITION_ILLEGAL",
				message: `back_edge action=amend-spec is not legal from ${prev}; allowed from EXECUTE.* + VERIFY.*`,
				detail: {
					from: prev,
					to: target,
					back_edge_action: ctx.back_edge.action,
					allowed_from: [...allowedFrom],
					reason: "back_edge_from_not_allowed"
				}
			};
			return { ok: true };
		}
		if (ctx.back_edge.action === "amend-tasks") {
			if (target !== "EXECUTE.work") return {
				ok: false,
				code: "TRANSITION_ILLEGAL",
				message: `back_edge action=amend-tasks requires target=EXECUTE.work, got ${target}`,
				detail: {
					from: prev,
					to: target,
					back_edge_action: ctx.back_edge.action,
					expected_target: "EXECUTE.work",
					reason: "back_edge_target_mismatch"
				}
			};
			const allowedFrom = BACK_EDGE_FROM["amend-tasks"];
			if (!allowedFrom.has(prev)) return {
				ok: false,
				code: "TRANSITION_ILLEGAL",
				message: `back_edge action=amend-tasks is not legal from ${prev}; allowed from EXECUTE.work / EXECUTE.done + VERIFY.*`,
				detail: {
					from: prev,
					to: target,
					back_edge_action: ctx.back_edge.action,
					allowed_from: [...allowedFrom],
					reason: "back_edge_from_not_allowed"
				}
			};
			return { ok: true };
		}
		if (ctx.back_edge.action === "fix-impl") {
			if (target !== "EXECUTE.work") return {
				ok: false,
				code: "TRANSITION_ILLEGAL",
				message: `back_edge action=fix-impl requires target=EXECUTE.work, got ${target}`,
				detail: {
					from: prev,
					to: target,
					back_edge_action: ctx.back_edge.action,
					expected_target: "EXECUTE.work",
					reason: "back_edge_target_mismatch"
				}
			};
			const allowedFrom = BACK_EDGE_FROM["fix-impl"];
			if (!allowedFrom.has(prev)) return {
				ok: false,
				code: "TRANSITION_ILLEGAL",
				message: `back_edge action=fix-impl is not legal from ${prev}; allowed from EXECUTE.work / EXECUTE.done + VERIFY.*`,
				detail: {
					from: prev,
					to: target,
					back_edge_action: ctx.back_edge.action,
					allowed_from: [...allowedFrom],
					reason: "back_edge_from_not_allowed"
				}
			};
			return { ok: true };
		}
		if (ctx.back_edge.action === "fix-test") {
			if (target !== "EXECUTE.work") return {
				ok: false,
				code: "TRANSITION_ILLEGAL",
				message: `back_edge action=fix-test requires target=EXECUTE.work, got ${target}`,
				detail: {
					from: prev,
					to: target,
					back_edge_action: ctx.back_edge.action,
					expected_target: "EXECUTE.work",
					reason: "back_edge_target_mismatch"
				}
			};
			const allowedFrom = BACK_EDGE_FROM["fix-test"];
			if (!allowedFrom.has(prev)) return {
				ok: false,
				code: "TRANSITION_ILLEGAL",
				message: `back_edge action=fix-test is not legal from ${prev}; allowed from EXECUTE.work / EXECUTE.done + VERIFY.*`,
				detail: {
					from: prev,
					to: target,
					back_edge_action: ctx.back_edge.action,
					allowed_from: [...allowedFrom],
					reason: "back_edge_from_not_allowed"
				}
			};
			return { ok: true };
		}
		return {
			ok: false,
			code: "TRANSITION_ILLEGAL",
			message: `unknown back_edge.action ${ctx.back_edge.action}`,
			detail: {
				back_edge: ctx.back_edge,
				reason: "back_edge_action_unknown"
			}
		};
	}
	const allowed = LEGAL_TRANSITIONS[prev] ?? [];
	if (!allowed.includes(target)) return {
		ok: false,
		code: "TRANSITION_ILLEGAL",
		message: `cannot transition ${prev} → ${target}`,
		detail: {
			from: prev,
			to: target,
			allowed_forward: [...allowed]
		}
	};
	if (prev === "TRIAGE.confirm") {
		const specPhase = ctx.ceremony.spec_phase;
		if (target === "SPEC.proposal" && !specPhase) return {
			ok: false,
			code: "SPEC_PHASE_FORK_VIOLATION",
			message: "TRIAGE.confirm → SPEC.proposal requires ceremony.spec_phase=true",
			detail: {
				from: prev,
				to: target,
				spec_phase: specPhase
			}
		};
		if (target === "EXECUTE.plan" && specPhase) return {
			ok: false,
			code: "SPEC_PHASE_FORK_VIOLATION",
			message: "TRIAGE.confirm → EXECUTE.plan requires ceremony.spec_phase=false (quick); profiles with spec_phase=true must traverse SPEC.*",
			detail: {
				from: prev,
				to: target,
				spec_phase: specPhase
			}
		};
	}
	if (prev === "EXECUTE.done") {
		const verifyPhase = ctx.ceremony.verify_phase;
		if (target === "VERIFY.plan" && !verifyPhase) return {
			ok: false,
			code: "VERIFY_PHASE_FORK_VIOLATION",
			message: "EXECUTE.done → VERIFY.plan requires ceremony.verify_phase=true (standard / deep)",
			detail: {
				from: prev,
				to: target,
				verify_phase: verifyPhase
			}
		};
	}
	if (prev === "VERIFY.accept" && target === "SETTLE.reconcile") {
		if (!ctx.ceremony.settle_phase) return {
			ok: false,
			code: "SETTLE_PHASE_DISABLED",
			message: "VERIFY.accept → SETTLE.reconcile requires ceremony.settle_phase=true (deep only)",
			detail: {
				from: prev,
				to: target,
				settle_phase: ctx.ceremony.settle_phase
			}
		};
		if (!ctx.verify_accepted) return {
			ok: false,
			code: "SETTLE_NOT_ACCEPTED",
			message: "VERIFY.accept → SETTLE.reconcile requires verify_accepted=true (run `loaf gate decide verify-accept --approve` first)",
			detail: {
				from: prev,
				to: target,
				verify_accepted: !!ctx.verify_accepted
			}
		};
	}
	return { ok: true };
}
//#endregion
//#region src/core/reducer/per-kind.ts
const ANY_SUB_STATE = Symbol("any-sub-state");
const ANY_NON_DONE = Symbol("any-non-done");
const VERIFY_OR_POST_LOCK_EXECUTE = [
	"EXECUTE.plan",
	"EXECUTE.work",
	"EXECUTE.done",
	"VERIFY.plan",
	"VERIFY.run",
	"VERIFY.review",
	"VERIFY.acceptance",
	"VERIFY.visual",
	"VERIFY.accept"
];
const ALL_SPEC = [
	"SPEC.proposal",
	"SPEC.spec",
	"SPEC.plan",
	"SPEC.design"
];
const ALL_EXECUTE = [
	"EXECUTE.plan",
	"EXECUTE.work",
	"EXECUTE.done"
];
const FIX_BACK_EDGE_FROM = [
	"EXECUTE.work",
	"EXECUTE.done",
	"VERIFY.plan",
	"VERIFY.run",
	"VERIFY.review",
	"VERIFY.acceptance",
	"VERIFY.visual",
	"VERIFY.accept"
];
const PER_KIND_SUB_STATE = {
	"event:phase_advanced": ANY_SUB_STATE,
	"event:ceremony_set": new Set([
		"TRIAGE.score",
		"TRIAGE.confirm",
		...ALL_SPEC,
		...ALL_EXECUTE
	]),
	"event:tasks_planned": new Set(["SPEC.design", "EXECUTE.plan"]),
	"event:tasks_amended": new Set(VERIFY_OR_POST_LOCK_EXECUTE),
	"event:task_claimed": new Set(["EXECUTE.work"]),
	"event:task_step_started": new Set(["EXECUTE.work"]),
	"event:task_step_done": new Set(["EXECUTE.work"]),
	"event:task_step_reset": new Set(FIX_BACK_EDGE_FROM),
	"event:task_abandoned": new Set(["EXECUTE.work"]),
	"event:spec_req_added": new Set(ALL_SPEC),
	"event:spec_scenario_added": new Set(ALL_SPEC),
	"event:spec_visual_added": new Set(ALL_SPEC),
	"event:spec_submitted": new Set(ALL_SPEC),
	"evidence:added": new Set([...ALL_EXECUTE, ...VERIFY_OR_POST_LOCK_EXECUTE.filter((s) => s.startsWith("VERIFY"))]),
	"finding:raised": new Set(VERIFY_OR_POST_LOCK_EXECUTE),
	"finding:closed": new Set(VERIFY_OR_POST_LOCK_EXECUTE),
	"pending:added": ANY_SUB_STATE,
	"pending:resolved": ANY_SUB_STATE,
	"gate:decided": new Set(["SPEC.design", "VERIFY.accept"]),
	"session:started": ANY_SUB_STATE,
	"session:resumed": ANY_SUB_STATE,
	"session:delivered": new Set([
		"EXECUTE.done",
		"VERIFY.accept",
		"SETTLE.lessons"
	]),
	"session:archived": ANY_NON_DONE,
	"session:abandoned": ANY_NON_DONE,
	"spike:converted": ANY_NON_DONE,
	"migration:snapshot_imported": ANY_SUB_STATE
};
const ALL_NON_MIGRATION = [
	"human",
	"skill",
	"ci",
	"cli"
];
const HUMAN_ONLY = ["human"];
const PER_KIND_ACTOR = {
	"event:phase_advanced": ALL_NON_MIGRATION,
	"event:ceremony_set": ALL_NON_MIGRATION,
	"event:tasks_planned": ALL_NON_MIGRATION,
	"event:tasks_amended": ALL_NON_MIGRATION,
	"event:task_claimed": ALL_NON_MIGRATION,
	"event:task_step_started": ALL_NON_MIGRATION,
	"event:task_step_done": ALL_NON_MIGRATION,
	"event:task_step_reset": ["cli"],
	"event:task_abandoned": ALL_NON_MIGRATION,
	"event:spec_req_added": ALL_NON_MIGRATION,
	"event:spec_scenario_added": ALL_NON_MIGRATION,
	"event:spec_visual_added": ALL_NON_MIGRATION,
	"event:spec_submitted": ALL_NON_MIGRATION,
	"evidence:added": ALL_NON_MIGRATION,
	"finding:raised": ALL_NON_MIGRATION,
	"finding:closed": ALL_NON_MIGRATION,
	"pending:added": ALL_NON_MIGRATION,
	"pending:resolved": ALL_NON_MIGRATION,
	"gate:decided": HUMAN_ONLY,
	"session:started": ALL_NON_MIGRATION,
	"session:resumed": ALL_NON_MIGRATION,
	"session:delivered": HUMAN_ONLY,
	"session:archived": HUMAN_ONLY,
	"session:abandoned": HUMAN_ONLY,
	"spike:converted": HUMAN_ONLY,
	"migration:snapshot_imported": ["migration"]
};
function actorPrefix(actor) {
	const m = /^(human|skill|ci|cli|migration):/.exec(actor);
	return m ? m[1] : null;
}
function isSubStateAllowed(kind, subState) {
	const guard = PER_KIND_SUB_STATE[kind];
	if (guard === ANY_SUB_STATE) return true;
	if (guard === ANY_NON_DONE) return !subState.startsWith("DONE.");
	return guard.has(subState);
}
function isActorAllowed(kind, actor) {
	const prefix = actorPrefix(actor);
	if (prefix === null) return false;
	return PER_KIND_ACTOR[kind].includes(prefix);
}
//#endregion
//#region src/core/reducer/preflight.ts
const DEFAULT_SUB_STATE = "TRIAGE.score";
const DEFAULT_CEREMONY = {
	spec_phase: true,
	verify_phase: true,
	settle_phase: false,
	strict_spec_review: false,
	lessons_required: "skip",
	strict_drift_check: false
};
function arraysEqual(a, b) {
	if (a === void 0 || b === void 0) return a === b;
	return a.length === b.length && a.every((v, i) => v === b[i]);
}
function firstFrozenViolation(current, incoming) {
	if (incoming.status !== current.status) {
		if (!(current.status === "pending" && incoming.status === "ready")) return {
			field: "status",
			from: current.status,
			to: incoming.status
		};
	}
	if (incoming.kind !== current.kind) return {
		field: "kind",
		from: current.kind,
		to: incoming.kind
	};
	if (!arraysEqual(current.drives, incoming.drives)) return {
		field: "drives",
		from: current.drives,
		to: incoming.drives
	};
	if (!arraysEqual(current.depends_on, incoming.depends_on)) return {
		field: "depends_on",
		from: current.depends_on,
		to: incoming.depends_on
	};
	if (!arraysEqual(current.labels, incoming.labels)) return {
		field: "labels",
		from: current.labels,
		to: incoming.labels
	};
	if (!arraysEqual(current.visual_contract_refs, incoming.visual_contract_refs)) return {
		field: "visual_contract_refs",
		from: current.visual_contract_refs,
		to: incoming.visual_contract_refs
	};
	for (const f of [
		"red_test_registered",
		"no_test_rationale",
		"requires_acceptance",
		"requires_visual"
	]) if (current[f] !== incoming[f]) return {
		field: f,
		from: current[f],
		to: incoming[f]
	};
	const curSteps = Object.keys(current.steps).sort();
	const incSteps = Object.keys(incoming.steps).sort();
	if (!arraysEqual(curSteps, incSteps)) return {
		field: "execution.steps",
		from: curSteps,
		to: incSteps
	};
	for (const stepName of curSteps) {
		const c = current.steps[stepName];
		const i = incoming.steps[stepName];
		if (c && i && c.status !== i.status) return {
			field: `execution.${stepName}.status`,
			from: c.status,
			to: i.status
		};
	}
	return null;
}
function firstSponsoredFrozenViolation(current, incoming) {
	if (incoming.status !== current.status) return {
		field: "status",
		from: current.status,
		to: incoming.status
	};
	for (const [stepName, cur] of Object.entries(current.steps)) {
		const inc = incoming.steps[stepName];
		if (inc === void 0) {
			if (cur.status !== "pending") return {
				field: `execution.${stepName}.status`,
				from: cur.status,
				to: void 0
			};
			continue;
		}
		if (cur.status !== inc.status) return {
			field: `execution.${stepName}.status`,
			from: cur.status,
			to: inc.status
		};
	}
	for (const [stepName, inc] of Object.entries(incoming.steps)) if (current.steps[stepName] === void 0 && inc.status !== "pending") return {
		field: `execution.${stepName}.status`,
		from: void 0,
		to: inc.status
	};
	return null;
}
function firstAddFreshnessViolation(task) {
	if (task.status !== "pending") return {
		field: "status",
		value: task.status
	};
	if (task.red_test_registered === true) return {
		field: "red_test_registered",
		value: true
	};
	for (const [stepName, step] of Object.entries(task.execution)) {
		if (step.status !== "pending") return {
			field: `execution.${stepName}.status`,
			value: step.status
		};
		if (step.evidence_refs.length > 0) return {
			field: `execution.${stepName}.evidence_refs`,
			value: step.evidence_refs
		};
		if (step.started_at !== void 0) return {
			field: `execution.${stepName}.started_at`,
			value: step.started_at
		};
		if (step.reason !== void 0) return {
			field: `execution.${stepName}.reason`,
			value: step.reason
		};
	}
	return null;
}
function preflight(rawEntry, ctx) {
	const sub_state = ctx.snapshot.state?.sub_state ?? DEFAULT_SUB_STATE;
	const ceremony = ctx.snapshot.state?.ceremony ?? DEFAULT_CEREMONY;
	const verify_accepted = ctx.snapshot.state?.verify_accepted ?? false;
	const parsed = JournalEntry.safeParse(rawEntry);
	if (!parsed.success) return {
		ok: false,
		code: "INVALID_ENVELOPE",
		message: "JournalEntry failed envelope schema validation",
		detail: { issues: parsed.error.issues }
	};
	const entry = parsed.data;
	const expectedSeq = ctx.tail_seq + 1;
	if (entry.seq !== expectedSeq) return {
		ok: false,
		code: "SEQ_NOT_MONOTONIC",
		message: `entry.seq=${entry.seq} but expected ${expectedSeq} (tail seq=${ctx.tail_seq})`,
		detail: {
			got: entry.seq,
			expected: expectedSeq,
			tail_seq: ctx.tail_seq
		}
	};
	if (!isSubStateAllowed(entry.kind, sub_state)) return {
		ok: false,
		code: "SUB_STATE_AUTHORITY_VIOLATION",
		message: `kind=${entry.kind} not allowed in sub_state=${sub_state}`,
		detail: {
			kind: entry.kind,
			sub_state
		}
	};
	if (!isActorAllowed(entry.kind, entry.actor)) return {
		ok: false,
		code: "ACTOR_AUTHORITY_VIOLATION",
		message: `actor=${entry.actor} not allowed for kind=${entry.kind}`,
		detail: {
			kind: entry.kind,
			actor: entry.actor
		}
	};
	const payloadParsed = PER_KIND_PAYLOAD[entry.kind].safeParse(entry.payload);
	if (!payloadParsed.success) return {
		ok: false,
		code: "INVALID_PAYLOAD",
		message: `payload schema validation failed for kind=${entry.kind}`,
		detail: {
			kind: entry.kind,
			issues: payloadParsed.error.issues
		}
	};
	if (entry.kind === "gate:decided") {
		const gateKind = payloadParsed.data.gate_kind;
		if (gateKind === "spec-lock" && sub_state !== "SPEC.design") return {
			ok: false,
			code: "SUB_STATE_AUTHORITY_VIOLATION",
			message: `gate:decided gate_kind=spec-lock requires sub_state=SPEC.design (got ${sub_state})`,
			detail: {
				gate_kind: gateKind,
				sub_state,
				expected: "SPEC.design"
			}
		};
		if (gateKind === "verify-accept" && sub_state !== "VERIFY.accept") return {
			ok: false,
			code: "SUB_STATE_AUTHORITY_VIOLATION",
			message: `gate:decided gate_kind=verify-accept requires sub_state=VERIFY.accept (got ${sub_state})`,
			detail: {
				gate_kind: gateKind,
				sub_state,
				expected: "VERIFY.accept"
			}
		};
		if (payloadParsed.data.decision === "approved") {
			const pendingHead = ctx.snapshot.pending.find((p) => !p.resolved);
			if (pendingHead && pendingHead.kind !== "gate_decision") return {
				ok: false,
				code: "GATE_NOT_PENDING",
				message: `gate:decided ${gateKind} approve blocked: pending head ${pendingHead.id} (kind=${pendingHead.kind}) is not a gate_decision prompt; resolve it first`,
				detail: {
					gate_kind: gateKind,
					head_id: pendingHead.id,
					head_kind: pendingHead.kind
				}
			};
		}
	}
	if (entry.kind === "event:phase_advanced") {
		const payload = rawEntry.payload ?? {};
		const from = payload["from"];
		if (from !== void 0 && from !== sub_state) return {
			ok: false,
			code: "FROM_CURSOR_MISMATCH",
			message: `event:phase_advanced payload.from=${from} but current sub_state=${sub_state}`,
			detail: {
				payload_from: from,
				current_sub_state: sub_state
			}
		};
		const head = ctx.snapshot.pending.find((p) => !p.resolved);
		if (head && (head.kind === "gate_decision" || head.kind === "profile_escalation")) return {
			ok: false,
			code: "PENDING_BLOCKS_ADVANCE",
			message: `pending head ${head.id} (kind=${head.kind}) blocks \`loaf advance\` until resolved`,
			detail: {
				pending_id: head.id,
				kind: head.kind
			}
		};
		const backEdge = (rawEntry.payload ?? {})["back_edge"];
		if (backEdge !== void 0 && typeof backEdge.finding_id === "string") {
			const findingId = backEdge.finding_id;
			const finding = ctx.snapshot.findings.find((f) => f.id === findingId);
			if (!finding) return {
				ok: false,
				code: "FINDING_NOT_FOUND",
				message: `event:phase_advanced.back_edge.finding_id=${findingId} not found in projection`,
				detail: {
					id: findingId,
					reason: "not_found"
				}
			};
			if (finding.status === "closed") return {
				ok: false,
				code: "FINDING_NOT_FOUND",
				message: `event:phase_advanced.back_edge.finding_id=${findingId} is already_closed; only open findings can sponsor back-edges`,
				detail: {
					id: findingId,
					reason: "already_closed"
				}
			};
			if (finding.action !== backEdge.action) return {
				ok: false,
				code: "FINDING_NOT_FOUND",
				message: `event:phase_advanced.back_edge.action=${backEdge.action} but finding ${findingId} has action=${finding.action}`,
				detail: {
					id: findingId,
					reason: "action_mismatch",
					expected_action: backEdge.action,
					actual_action: finding.action
				}
			};
		}
		const phaseTo = payload["to"];
		if (backEdge === void 0 && sub_state === "EXECUTE.work" && phaseTo === "EXECUTE.done") {
			const nonFinal = ctx.snapshot.tasks.filter((t) => t.status !== "done" && t.status !== "abandoned").map((t) => ({
				task_id: t.id,
				status: t.status
			}));
			if (nonFinal.length > 0) return {
				ok: false,
				code: "EXECUTE_DONE_TASKS_NOT_FINAL",
				message: `cannot advance EXECUTE.work → EXECUTE.done: ${nonFinal.length} task(s) are not in a final status (` + nonFinal.map((t) => `${t.task_id}=${t.status}`).join(", ") + `); every task must be done or abandoned`,
				detail: {
					non_final: nonFinal,
					count: nonFinal.length
				}
			};
		}
	}
	if (entry.kind === "session:delivered") {
		const activeSpike = ctx.snapshot.tasks.find((t) => t.kind === "spike" && t.status !== "abandoned");
		if (activeSpike) return {
			ok: false,
			code: "DELIVER_SPIKE_TASKS",
			message: `cannot deliver: task ${activeSpike.id} is kind=spike (status=${activeSpike.status}); spike tasks must be abandoned or converted before delivery (protocol §703 / §1298)`,
			detail: {
				task_id: activeSpike.id,
				status: activeSpike.status
			}
		};
		if (sub_state === "EXECUTE.done") return {
			ok: false,
			code: "DELIVER_VERIFY_MIN_UNAVAILABLE",
			message: "quick / light deliver from EXECUTE.done requires verify-min, which is not yet implemented in this build",
			detail: {
				sub_state,
				ceremony_label: deriveCeremonyLabel(ceremony)
			}
		};
		if (sub_state === "VERIFY.accept") {
			if (ceremony.settle_phase) return {
				ok: false,
				code: "DELIVER_SETTLE_PHASE_BYPASS",
				message: "deliver from VERIFY.accept requires ceremony.settle_phase=false (standard); deep ceremony must run `loaf settle` first",
				detail: {
					sub_state,
					settle_phase: ceremony.settle_phase
				}
			};
			if (!verify_accepted) return {
				ok: false,
				code: "DELIVER_NOT_ACCEPTED",
				message: "deliver requires verify_accepted=true; run `loaf gate decide verify-accept --approve` first",
				detail: {
					sub_state,
					verify_accepted
				}
			};
		}
		if (sub_state === "SETTLE.lessons") {
			if (!verify_accepted) return {
				ok: false,
				code: "DELIVER_NOT_ACCEPTED",
				message: "deliver from SETTLE.lessons requires verify_accepted=true (gate approval missing — journal may be inconsistent)",
				detail: {
					sub_state,
					verify_accepted
				}
			};
		}
	}
	if (entry.kind === "spike:converted") {
		if (!ctx.snapshot.tasks.some((t) => t.kind === "spike" && t.status !== "abandoned")) return {
			ok: false,
			code: "SPIKE_CONVERT_NO_SPIKE_TASK",
			message: "cannot convert: the session has no non-abandoned spike task; `loaf spike convert` is a spike-task exit (protocol §8.3)"
		};
	}
	if (entry.kind === "event:ceremony_set") {
		if (!(sub_state === "TRIAGE.score" || sub_state === "TRIAGE.confirm")) {
			const head = ctx.snapshot.pending.find((p) => !p.resolved);
			if (!head || head.kind !== "profile_escalation") {
				const actualHead = head ? head.kind : "(none)";
				return {
					ok: false,
					code: "ESCALATION_NOT_PENDING",
					message: `\`loaf profile escalate --confirm --input <ceremony.json>\` requires pending head kind=profile_escalation; current head: ${actualHead}`,
					detail: { actual_head: actualHead }
				};
			}
		}
	}
	if (entry.kind === "session:archived" || entry.kind === "session:abandoned") {
		if ((rawEntry.payload ?? {})["reason"] === void 0) return {
			ok: false,
			code: "SESSION_REASON_REQUIRED",
			message: `${entry.kind}: --reason is required (the session-terminal entry must record why)`,
			detail: { kind: entry.kind }
		};
	}
	if (entry.kind === "event:tasks_planned") {
		const incoming = (rawEntry.payload ?? {})["tasks"];
		if (Array.isArray(incoming)) {
			const seenIds = /* @__PURE__ */ new Set();
			for (const t of incoming) {
				if (typeof t?.id === "string") {
					if (seenIds.has(t.id)) return {
						ok: false,
						code: "DUPLICATE_TASK_ID",
						message: `tasks_planned: task id ${t.id} appears more than once in payload`,
						detail: { task_id: t.id }
					};
					seenIds.add(t.id);
				}
				if (t?.red_test_registered === true) return {
					ok: false,
					code: "BUG_TASK_FLAG_MISUSE",
					message: `tasks_planned: task ${t.id ?? "?"} carries red_test_registered=true — a planned task is born unregistered; use \`loaf tasks register-red\` after creation`,
					detail: {
						task_id: t.id,
						kind: "event:tasks_planned"
					}
				};
			}
		}
	}
	if (entry.kind === "event:tasks_amended") {
		const amended = payloadParsed.data;
		const mode = amended.mode ?? "replace";
		const taskId = amended.task.id;
		const sponsorId = amended.sponsored_by_finding_id;
		if (sponsorId !== void 0) {
			const finding = ctx.snapshot.findings.find((f) => f.id === sponsorId);
			if (!finding) return {
				ok: false,
				code: "FINDING_NOT_FOUND",
				message: `event:tasks_amended.sponsored_by_finding_id=${sponsorId} not found in projection`,
				detail: {
					id: sponsorId,
					reason: "not_found"
				}
			};
			if (finding.status === "closed") return {
				ok: false,
				code: "FINDING_NOT_FOUND",
				message: `event:tasks_amended.sponsored_by_finding_id=${sponsorId} is already_closed; only open findings can sponsor a tasks amend`,
				detail: {
					id: sponsorId,
					reason: "already_closed"
				}
			};
			if (finding.action !== "amend-tasks") return {
				ok: false,
				code: "FINDING_NOT_FOUND",
				message: `event:tasks_amended.sponsored_by_finding_id=${sponsorId} has action=${finding.action} but only amend-tasks findings can sponsor a tasks amend`,
				detail: {
					id: sponsorId,
					reason: "action_mismatch",
					expected_action: "amend-tasks",
					actual_action: finding.action
				}
			};
			if (sub_state !== "EXECUTE.work") return {
				ok: false,
				code: "MUTATION_OUT_OF_RIGHTS",
				message: `sponsored event:tasks_amended is permitted only at EXECUTE.work (current sub_state=${sub_state})`,
				detail: {
					task_id: taskId,
					mode,
					sub_state,
					reason: "sponsored_tasks_amended_wrong_sub_state"
				}
			};
			if (mode === "add") {
				const violation = firstAddFreshnessViolation(amended.task);
				if (violation) return {
					ok: false,
					code: "MUTATION_OUT_OF_RIGHTS",
					message: `sponsored event:tasks_amended mode=add must introduce a fresh task — '${violation.field}' carries execution progress (§8.6: a sponsored amend may not fabricate completed work)`,
					detail: {
						task_id: taskId,
						mode,
						sub_state,
						field: violation.field,
						reason: "sponsored_add_not_fresh"
					}
				};
			}
			if (mode === "replace") {
				const currentTask = ctx.snapshot.tasks.find((t) => t.id === taskId);
				if (!currentTask) return {
					ok: false,
					code: "TASK_NOT_FOUND",
					message: `tasks_amended: task ${taskId} is not in the current tasks projection`,
					detail: { task_id: taskId }
				};
				const violation = firstSponsoredFrozenViolation(currentTask, extractTaskSlim(amended.task));
				if (violation) return {
					ok: false,
					code: "MUTATION_OUT_OF_RIGHTS",
					message: `sponsored event:tasks_amended on task ${taskId} changes frozen field '${violation.field}' — a graph amend may not erase or rewrite execution progress (§8.6)`,
					detail: {
						task_id: taskId,
						mode,
						sub_state,
						field: violation.field,
						from: violation.from,
						to: violation.to
					}
				};
			}
			return { ok: true };
		}
		if (mode === "add") return {
			ok: false,
			code: "MUTATION_OUT_OF_RIGHTS",
			message: `event:tasks_amended mode=add on task ${taskId} is not authorized — an add must be sponsored by an amend-tasks finding (sponsored_by_finding_id)`,
			detail: {
				task_id: taskId,
				mode,
				sub_state,
				reason: "unsponsored_add"
			}
		};
		if (sub_state !== "EXECUTE.plan") return {
			ok: false,
			code: "MUTATION_OUT_OF_RIGHTS",
			message: `event:tasks_amended mode=replace is permitted only at EXECUTE.plan (current sub_state=${sub_state})`,
			detail: {
				task_id: taskId,
				mode,
				sub_state,
				reason: "replace_outside_execute_plan"
			}
		};
		const currentTask = ctx.snapshot.tasks.find((t) => t.id === taskId);
		if (!currentTask) return {
			ok: false,
			code: "TASK_NOT_FOUND",
			message: `tasks_amended: task ${taskId} is not in the current tasks projection`,
			detail: { task_id: taskId }
		};
		const violation = firstFrozenViolation(currentTask, extractTaskSlim(amended.task));
		if (violation) return {
			ok: false,
			code: "MUTATION_OUT_OF_RIGHTS",
			message: `event:tasks_amended on task ${taskId} changes frozen field '${violation.field}' — §8.6 forbids it at EXECUTE.plan`,
			detail: {
				task_id: taskId,
				mode,
				sub_state,
				field: violation.field,
				from: violation.from,
				to: violation.to
			}
		};
	}
	if (entry.kind === "event:task_claimed" || entry.kind === "event:task_step_started" || entry.kind === "event:task_step_done") {
		const payload = rawEntry.payload ?? {};
		const task_id = payload["task_id"];
		if (!task_id) return {
			ok: false,
			code: "INVALID_PAYLOAD",
			message: `${entry.kind}: missing task_id`,
			detail: { kind: entry.kind }
		};
		const task = ctx.snapshot.tasks.find((t) => t.id === task_id);
		if (!task) return {
			ok: false,
			code: "TASK_NOT_FOUND",
			message: `${entry.kind}: task ${task_id} is not in the current tasks projection`,
			detail: {
				task_id,
				kind: entry.kind
			}
		};
		if (entry.kind === "event:task_claimed") {
			if (task.status === "in_progress") return {
				ok: false,
				code: "TASK_ALREADY_CLAIMED",
				message: `task ${task_id} is already claimed (status=in_progress)`,
				detail: {
					task_id,
					status: task.status
				}
			};
			if (task.status === "done" || task.status === "abandoned") return {
				ok: false,
				code: "TASK_NOT_CLAIMABLE",
				message: `task ${task_id} cannot be claimed (status=${task.status} — terminal state)`,
				detail: {
					task_id,
					status: task.status
				}
			};
			for (const depId of task.depends_on) {
				const dep = ctx.snapshot.tasks.find((t) => t.id === depId);
				if (!dep) return {
					ok: false,
					code: "TASK_DEPS_NOT_SATISFIED",
					message: `task ${task_id} cannot be claimed: dependency ${depId} is not in the tasks projection`,
					detail: {
						task_id,
						blocking_dep: depId,
						blocking_status: "missing"
					}
				};
				if (dep.status !== "done") return {
					ok: false,
					code: "TASK_DEPS_NOT_SATISFIED",
					message: `task ${task_id} cannot be claimed: dependency ${depId} is not done (status=${dep.status})`,
					detail: {
						task_id,
						blocking_dep: depId,
						blocking_status: dep.status
					}
				};
			}
		} else {
			const step = payload["step"];
			if (task.status !== "in_progress") return {
				ok: false,
				code: "TASK_NOT_CLAIMED",
				message: `task ${task_id} step ${step ?? "?"} mutation requires task.status=in_progress (got status=${task.status}); claim the task first`,
				detail: {
					task_id,
					step,
					status: task.status,
					kind: entry.kind
				}
			};
			if (step === "implement" && task.kind === "behavioral" && task.labels.includes("bug") && task.red_test_registered !== true) return {
				ok: false,
				code: "BUG_TASK_REQUIRES_RED",
				message: `behavioral bug task ${task_id} must register its RED test before the implement step — run \`loaf tasks register-red ${task_id}\` first`,
				detail: {
					task_id,
					step,
					kind: entry.kind
				}
			};
			if (entry.kind === "event:task_step_done" && payload["red_test_registered"] === true) {
				const result = payload["result"];
				const okResult = result === void 0 || result === "passed" || result === "waived";
				if (!(step === "red" && task.kind === "behavioral" && task.labels.includes("bug") && okResult)) return {
					ok: false,
					code: "BUG_TASK_FLAG_MISUSE",
					message: `red_test_registered=true is valid only on a red-step task_step_done for a behavioral bug task with a passed/waived result (task ${task_id}, step=${step ?? "?"}, result=${result ?? "passed"}, kind=${task.kind})`,
					detail: {
						task_id,
						step,
						result: result ?? "passed",
						kind: task.kind,
						labels: task.labels
					}
				};
			}
		}
	}
	if (entry.kind === "event:task_abandoned") {
		const task_id = (rawEntry.payload ?? {})["task_id"];
		if (!task_id) return {
			ok: false,
			code: "INVALID_PAYLOAD",
			message: `${entry.kind}: missing task_id`,
			detail: { kind: entry.kind }
		};
		const task = ctx.snapshot.tasks.find((t) => t.id === task_id);
		if (!task) return {
			ok: false,
			code: "TASK_NOT_FOUND",
			message: `${entry.kind}: task ${task_id} is not in the current tasks projection`,
			detail: {
				task_id,
				kind: entry.kind
			}
		};
		if (task.status === "done" || task.status === "abandoned") return {
			ok: false,
			code: "TASK_NOT_ABANDONABLE",
			message: `task ${task_id} cannot be abandoned (status=${task.status} — already in a final status)`,
			detail: {
				task_id,
				status: task.status
			}
		};
		const blockingDependents = ctx.snapshot.tasks.filter((t) => t.depends_on.includes(task_id) && t.status !== "done" && t.status !== "abandoned").map((t) => t.id);
		if (blockingDependents.length > 0) return {
			ok: false,
			code: "TASK_ABANDON_BLOCKED_DEPENDENTS",
			message: `task ${task_id} cannot be abandoned: ${blockingDependents.length} non-terminal task(s) depend on it (${blockingDependents.join(", ")}); abandon or complete the dependents first`,
			detail: {
				task_id,
				blocking_dependents: blockingDependents
			}
		};
	}
	if (entry.kind === "event:task_step_reset") {
		const payload = payloadParsed.data;
		const finding = ctx.snapshot.findings.find((f) => f.id === payload.finding_id);
		if (!finding) return {
			ok: false,
			code: "FINDING_NOT_FOUND",
			message: `event:task_step_reset.finding_id=${payload.finding_id} not found in projection`,
			detail: {
				id: payload.finding_id,
				reason: "not_found"
			}
		};
		if (finding.status === "closed") return {
			ok: false,
			code: "FINDING_NOT_FOUND",
			message: `event:task_step_reset.finding_id=${payload.finding_id} is already_closed; only open findings can sponsor a step reset`,
			detail: {
				id: payload.finding_id,
				reason: "already_closed"
			}
		};
		if (finding.action !== "fix-impl" && finding.action !== "fix-test") return {
			ok: false,
			code: "FINDING_NOT_FOUND",
			message: `event:task_step_reset.finding_id=${payload.finding_id} has action=${finding.action} but only fix-impl / fix-test findings can sponsor a step reset`,
			detail: {
				id: payload.finding_id,
				reason: "action_mismatch",
				expected_action: ["fix-impl", "fix-test"],
				actual_action: finding.action
			}
		};
		const expectedStep = FIX_ACTION_STEP[finding.action];
		if (payload.step !== expectedStep) return {
			ok: false,
			code: "MUTATION_OUT_OF_RIGHTS",
			message: `event:task_step_reset step="${payload.step}" but ${finding.action} resets step="${expectedStep}"`,
			detail: {
				finding_id: payload.finding_id,
				task_id: payload.task_id,
				step: payload.step,
				expected_step: expectedStep,
				reason: "task_step_reset_step_mismatch"
			}
		};
		const expectedTarget = finding.target;
		if (expectedTarget === void 0 || expectedTarget.task_id !== payload.task_id || expectedTarget.step !== payload.step) return {
			ok: false,
			code: "MUTATION_OUT_OF_RIGHTS",
			message: `event:task_step_reset target {task_id=${payload.task_id}, step=${payload.step}} does not match finding ${payload.finding_id}'s target`,
			detail: {
				finding_id: payload.finding_id,
				expected_target: expectedTarget ?? null,
				actual_target: {
					task_id: payload.task_id,
					step: payload.step
				},
				reason: "task_step_reset_target_mismatch"
			}
		};
		const task = ctx.snapshot.tasks.find((t) => t.id === payload.task_id);
		if (!task || !(payload.step in task.steps)) return {
			ok: false,
			code: "MUTATION_OUT_OF_RIGHTS",
			message: `event:task_step_reset target {task_id=${payload.task_id}, step=${payload.step}} is not present in the tasks projection`,
			detail: {
				finding_id: payload.finding_id,
				task_id: payload.task_id,
				step: payload.step,
				reason: "task_step_reset_target_mismatch"
			}
		};
		if (task.status === "abandoned") return {
			ok: false,
			code: "MUTATION_OUT_OF_RIGHTS",
			message: `event:task_step_reset cannot reset task ${payload.task_id}: status=abandoned is terminal and cannot be reactivated (a fix step reset may reopen a done task, never an abandoned one)`,
			detail: {
				finding_id: payload.finding_id,
				task_id: payload.task_id,
				status: task.status,
				reason: "task_step_reset_task_abandoned"
			}
		};
	}
	if (entry.kind === "finding:raised") {
		const payload = payloadParsed.data;
		const risk = cellRisk(payload.category, payload.action);
		if (risk === "incoherent") return {
			ok: false,
			code: "FINDING_ACTION_INCOHERENT",
			message: `finding raise category=${payload.category} × action=${payload.action} is structurally incoherent (no task target a transition can land on); amend-spec first to add target before fix-impl/fix-test`,
			detail: {
				category: payload.category,
				action: payload.action
			}
		};
		if (risk === "unusual") {
			const reasonLength = payload.reason?.length ?? 0;
			if (reasonLength < 20) return {
				ok: false,
				code: "FINDING_ACTION_UNUSUAL_REASON_REQUIRED",
				message: `finding raise category=${payload.category} × action=${payload.action} is an unusual cell; --reason ≥20 chars required (got ${reasonLength})`,
				detail: {
					category: payload.category,
					action: payload.action,
					current_reason_length: reasonLength,
					min_reason_length: 20
				}
			};
		}
		const mode = FINDING_ACTION_TARGET_MODE[payload.action];
		if (mode === "task_id_step") {
			if (!payload.target) return {
				ok: false,
				code: "FINDING_TARGET_REQUIRED",
				message: `finding raise action=${payload.action} requires --target-task + --target-step`,
				detail: {
					action: payload.action,
					reason: "missing"
				}
			};
			const expectedStep = FIX_ACTION_STEP[payload.action];
			if (expectedStep && payload.target.step !== expectedStep) return {
				ok: false,
				code: "FINDING_TARGET_REQUIRED",
				message: `finding raise action=${payload.action} requires step="${expectedStep}" (got step="${payload.target.step}")`,
				detail: {
					action: payload.action,
					task_id: payload.target.task_id,
					step: payload.target.step,
					expected_step: expectedStep,
					reason: "step_mismatch"
				}
			};
		}
		if (mode === "none" && payload.target) return {
			ok: false,
			code: "FINDING_TARGET_REQUIRED",
			message: `finding raise action=${payload.action} does not accept a target (target_payload="none"); drop --target-task / --target-step`,
			detail: {
				action: payload.action,
				task_id: payload.target.task_id,
				step: payload.target.step,
				reason: "target_not_allowed"
			}
		};
		if (mode === "task_id_step" || mode === "task_id_optional") {
			if (payload.target) {
				const task = ctx.snapshot.tasks.find((t) => t.id === payload.target.task_id);
				if (!task) return {
					ok: false,
					code: "FINDING_TARGET_REQUIRED",
					message: `finding raise target.task_id=${payload.target.task_id} not found in projection`,
					detail: {
						action: payload.action,
						task_id: payload.target.task_id,
						reason: "task_not_found"
					}
				};
				if (!(payload.target.step in task.steps)) return {
					ok: false,
					code: "FINDING_TARGET_REQUIRED",
					message: `finding raise target.step=${payload.target.step} not in task ${payload.target.task_id} (kind=${task.kind}) steps`,
					detail: {
						action: payload.action,
						task_id: payload.target.task_id,
						step: payload.target.step,
						available_steps: Object.keys(task.steps),
						reason: "step_not_found"
					}
				};
			}
		}
		if (payload.action === "amend-spec" && !ctx.snapshot.state?.spec_locked) return {
			ok: false,
			code: "FINDING_AMEND_SPEC_NOT_LOCKED",
			message: `finding raise action=amend-spec requires state.spec_locked=true; spec is not locked at sub_state=${sub_state}, edit directly via 'loaf spec submit / add-*'`,
			detail: {
				current_spec_locked: false,
				current_sub_state: sub_state,
				hint: "use loaf spec submit / add-* directly to edit spec when not locked"
			}
		};
	}
	if (new Set([
		"event:spec_submitted",
		"event:spec_req_added",
		"event:spec_scenario_added",
		"event:spec_visual_added"
	]).has(entry.kind)) {
		if (ctx.snapshot.state?.spec_locked === true) return {
			ok: false,
			code: "SPEC_LOCKED_NO_DIRECT_EDIT",
			message: `${entry.kind} blocked: spec_locked=true; walk back via \`loaf finding raise --category spec-gap --action amend-spec\` to re-enter SPEC.spec`,
			detail: {
				kind: entry.kind,
				spec_locked: true
			}
		};
		if (entry.kind !== "event:spec_submitted" && (ctx.snapshot.state?.spec_version ?? 0) === 0) return {
			ok: false,
			code: "SPEC_NOT_INITIALIZED",
			message: `${entry.kind} blocked: spec is not initialized (spec_version=0); run \`loaf spec submit --input <file>\` first to bump spec_version to 1`,
			detail: {
				kind: entry.kind,
				spec_version: ctx.snapshot.state?.spec_version ?? 0
			}
		};
	}
	if (entry.kind === "event:spec_req_added") {
		const payload = payloadParsed.data;
		if (ctx.snapshot.requirements.some((r) => r.id === payload.req.id)) return {
			ok: false,
			code: "DUPLICATE_REQ_ID",
			message: `spec_req_added: REQ ${payload.req.id} already in projection`,
			detail: { id: payload.req.id }
		};
	}
	if (entry.kind === "event:spec_scenario_added") {
		const payload = payloadParsed.data;
		if (ctx.snapshot.scenarios.some((s) => s.id === payload.scenario.id)) return {
			ok: false,
			code: "DUPLICATE_SCEN_ID",
			message: `spec_scenario_added: SCEN ${payload.scenario.id} already in projection`,
			detail: { id: payload.scenario.id }
		};
	}
	if (entry.kind === "event:spec_visual_added") {
		const payload = payloadParsed.data;
		if (ctx.snapshot.visual_contracts.some((v) => v.id === payload.visual.id)) return {
			ok: false,
			code: "DUPLICATE_VIS_ID",
			message: `spec_visual_added: VIS ${payload.visual.id} already in projection`,
			detail: { id: payload.visual.id }
		};
	}
	if (new Set([
		"event:spec_submitted",
		"event:spec_req_added",
		"event:spec_scenario_added",
		"event:spec_visual_added"
	]).has(entry.kind)) {
		const payloadVersion = payloadParsed.data.spec_version;
		const currentVersion = ctx.snapshot.state?.spec_version ?? 0;
		if (entry.kind === "event:spec_submitted") {
			if (entry.batch_index !== void 0 && entry.batch_index !== 0) return {
				ok: false,
				code: "SPEC_VERSION_BATCH_MISMATCH",
				message: `spec_submitted must appear at batch_index=0 (got ${entry.batch_index}); it is the whole-replacement entrypoint`,
				detail: {
					kind: entry.kind,
					batch_index: entry.batch_index,
					expected_batch_index: 0
				}
			};
			if (payloadVersion !== currentVersion + 1) return {
				ok: false,
				code: "SPEC_VERSION_NOT_MONOTONIC",
				message: `spec_submitted: spec_version must be ${currentVersion + 1} (current+1), got ${payloadVersion}`,
				detail: {
					kind: entry.kind,
					payload_spec_version: payloadVersion,
					current_spec_version: currentVersion,
					expected_spec_version: currentVersion + 1
				}
			};
		} else if (entry.batch_index === void 0 || entry.batch_index === 0) {
			if (payloadVersion !== currentVersion + 1) return {
				ok: false,
				code: "SPEC_VERSION_NOT_MONOTONIC",
				message: `${entry.kind}: spec_version must be ${currentVersion + 1} (current+1) at batch head, got ${payloadVersion}`,
				detail: {
					kind: entry.kind,
					payload_spec_version: payloadVersion,
					current_spec_version: currentVersion,
					expected_spec_version: currentVersion + 1,
					batch_position: "head"
				}
			};
		} else if (payloadVersion !== currentVersion) return {
			ok: false,
			code: "SPEC_VERSION_BATCH_MISMATCH",
			message: `${entry.kind}: spec_version must be ${currentVersion} at batch_index=${entry.batch_index} (batch continuation), got ${payloadVersion}`,
			detail: {
				kind: entry.kind,
				payload_spec_version: payloadVersion,
				current_spec_version: currentVersion,
				batch_index: entry.batch_index,
				batch_position: "continuation"
			}
		};
	}
	const transitionResult = checkTransition(entry.kind, rawEntry, {
		sub_state,
		ceremony,
		verify_accepted,
		actor: entry.actor
	});
	if (transitionResult && !transitionResult.ok) return {
		ok: false,
		code: transitionResult.code,
		message: transitionResult.message,
		detail: transitionResult.detail ?? {}
	};
	return { ok: true };
}
function deriveCeremonyLabel(c) {
	if (!c.spec_phase && !c.verify_phase) return "quick";
	if (c.spec_phase && !c.verify_phase) return "light";
	if (c.spec_phase && c.verify_phase && !c.settle_phase) return "standard";
	if (c.spec_phase && c.verify_phase && c.settle_phase) return "deep";
	return "custom";
}
/**
* For state-machine-edge kinds, extract (from, to) from payload and run
* validateTransition. Returns null for kinds that don't carry an edge.
*/
function checkTransition(kind, raw, ctx) {
	const payload = raw["payload"] ?? {};
	if (kind === "event:phase_advanced") {
		const from = payload["from"];
		const to = payload["to"];
		if (from === void 0 || to === void 0) return null;
		const backEdge = payload["back_edge"];
		return validateTransition(from, to, {
			ceremony: ctx.ceremony,
			actor: ctx.actor,
			verify_accepted: ctx.verify_accepted,
			...backEdge !== void 0 ? { back_edge: backEdge } : {}
		});
	}
	if (kind === "gate:decided") return null;
	return null;
}
//#endregion
//#region src/core/reducer.ts
function initialSnapshot() {
	return {
		state: null,
		tasks: [],
		evidence: [],
		findings: [],
		pending: [],
		spec_header: null,
		requirements: [],
		scenarios: [],
		visual_contracts: [],
		tasks_based_on: null
	};
}
function extractPhase(sub) {
	const idx = sub.indexOf(".");
	return sub.slice(0, idx);
}
const MIGRATION_BOOTSTRAP_CEREMONY = {
	spec_phase: true,
	verify_phase: true,
	settle_phase: false,
	strict_spec_review: false,
	lessons_required: "skip",
	strict_drift_check: false
};
function apply(prev, entry) {
	if (entry.kind === "migration:snapshot_imported") {
		if (prev.state !== null) return {
			ok: false,
			code: "ALREADY_STARTED",
			message: "migration:snapshot_imported after state already initialized"
		};
		return {
			ok: true,
			snapshot: {
				...prev,
				state: {
					session_id: "00000000-0000-0000-0000-000000000000",
					feature: "migrated",
					phase: "TRIAGE",
					sub_state: "TRIAGE.score",
					iteration: 1,
					spec_locked: false,
					verify_accepted: false,
					spec_version: 0,
					ceremony: MIGRATION_BOOTSTRAP_CEREMONY
				}
			}
		};
	}
	if (entry.kind === "session:started") {
		if (prev.state !== null) return {
			ok: false,
			code: "ALREADY_STARTED",
			message: "session:started after state already initialized"
		};
		const payload = entry.payload;
		if (!payload.session_id || !payload.feature || !payload.ceremony) return {
			ok: false,
			code: "INVALID_PAYLOAD",
			message: "session:started payload requires session_id, feature, ceremony"
		};
		return {
			ok: true,
			snapshot: {
				...prev,
				state: {
					session_id: payload.session_id,
					feature: payload.feature,
					phase: "TRIAGE",
					sub_state: "TRIAGE.score",
					iteration: 1,
					spec_locked: false,
					verify_accepted: false,
					spec_version: 0,
					ceremony: payload.ceremony
				}
			}
		};
	}
	if (prev.state === null) return {
		ok: false,
		code: "NO_SESSION",
		message: `kind=${entry.kind} requires a started session`
	};
	const pre = preflight(entry, {
		snapshot: prev,
		tail_seq: entry.seq - 1
	});
	if (!pre.ok) return {
		ok: false,
		code: pre.code,
		message: pre.message,
		detail: pre.detail ?? {}
	};
	switch (entry.kind) {
		case "event:phase_advanced": {
			const payload = entry.payload;
			const next = {
				...prev.state,
				sub_state: payload.to,
				phase: extractPhase(payload.to),
				spec_locked: payload.to === "SPEC.spec" ? false : prev.state.spec_locked,
				iteration: payload.back_edge !== void 0 ? prev.state.iteration + 1 : prev.state.iteration
			};
			return {
				ok: true,
				snapshot: {
					...prev,
					state: next
				}
			};
		}
		case "event:ceremony_set": {
			const payload = entry.payload;
			return {
				ok: true,
				snapshot: {
					...prev,
					state: {
						...prev.state,
						ceremony: payload
					}
				}
			};
		}
		case "gate:decided": {
			const payload = entry.payload;
			if (payload.gate_kind === "spec-lock") {
				if (payload.decision === "approved") return {
					ok: true,
					snapshot: {
						...prev,
						state: {
							...prev.state,
							spec_locked: true
						}
					}
				};
				return {
					ok: true,
					snapshot: prev
				};
			}
			if (payload.gate_kind === "verify-accept") {
				if (payload.decision === "approved") return {
					ok: true,
					snapshot: {
						...prev,
						state: {
							...prev.state,
							verify_accepted: true
						}
					}
				};
				return {
					ok: true,
					snapshot: prev
				};
			}
			return {
				ok: false,
				code: "INVALID_PAYLOAD",
				message: `gate:decided has unknown gate_kind: ${String(payload.gate_kind)}`
			};
		}
		case "event:tasks_planned": {
			const payload = entry.payload;
			if (typeof payload.based_on?.spec !== "number") return invalidPayload(entry.kind, "missing based_on.spec");
			const incoming = payload.tasks ?? [];
			const seenIds = /* @__PURE__ */ new Set();
			for (const t of incoming) {
				if (seenIds.has(t.id)) return invalidPayload(entry.kind, `DUPLICATE_TASK_ID: ${t.id} appears more than once in tasks_planned payload`);
				seenIds.add(t.id);
			}
			const taskList = incoming.map(extractTaskSlim);
			return {
				ok: true,
				snapshot: {
					...prev,
					tasks: taskList,
					tasks_based_on: { spec: payload.based_on.spec }
				}
			};
		}
		case "event:tasks_amended": {
			const payload = entry.payload;
			if (!payload.task) return invalidPayload(entry.kind, "missing task");
			const mode = payload.mode ?? "replace";
			const idx = prev.tasks.findIndex((t) => t.id === payload.task.id);
			if (mode === "add") {
				if (idx !== -1) return {
					ok: false,
					code: "DUPLICATE_TASK_ID",
					message: `tasks_amended add: task ${payload.task.id} is already in the projection`,
					detail: { task_id: payload.task.id }
				};
				const slim = extractTaskSlim(payload.task);
				return {
					ok: true,
					snapshot: {
						...prev,
						tasks: [...prev.tasks, slim]
					}
				};
			}
			if (idx === -1) return {
				ok: false,
				code: "TASK_NOT_FOUND",
				message: `tasks_amended: task ${payload.task.id} not in projection`,
				detail: { task_id: payload.task.id }
			};
			const slim = extractTaskSlim(payload.task);
			const tasks = prev.tasks.map((t, i) => i === idx ? slim : t);
			return {
				ok: true,
				snapshot: {
					...prev,
					tasks
				}
			};
		}
		case "event:task_claimed": {
			const payload = entry.payload;
			if (!payload.task_id) return invalidPayload(entry.kind, "missing task_id");
			if (!prev.tasks.find((t) => t.id === payload.task_id)) return {
				ok: false,
				code: "TASK_NOT_FOUND",
				message: `task_claimed: task ${payload.task_id} not in projection`,
				detail: { task_id: payload.task_id }
			};
			const tasks = prev.tasks.map((t) => t.id === payload.task_id ? {
				...t,
				status: "in_progress"
			} : t);
			return {
				ok: true,
				snapshot: {
					...prev,
					tasks
				}
			};
		}
		case "event:task_step_started": {
			const payload = entry.payload;
			if (!payload.task_id || !payload.step) return invalidPayload(entry.kind, "missing task_id/step");
			const task = prev.tasks.find((t) => t.id === payload.task_id);
			if (!task) return {
				ok: false,
				code: "TASK_NOT_FOUND",
				message: `task_step_started: task ${payload.task_id} not in projection`,
				detail: { task_id: payload.task_id }
			};
			const seeded = task.steps[payload.step];
			if (!seeded) return {
				ok: false,
				code: "TASK_STEP_NOT_FOUND",
				message: `task_step_started: step ${payload.step} not seeded on task ${payload.task_id}`,
				detail: {
					task_id: payload.task_id,
					step: payload.step
				}
			};
			const tasks = prev.tasks.map((t) => t.id === payload.task_id ? {
				...t,
				steps: {
					...t.steps,
					[payload.step]: {
						applicability: seeded.applicability,
						status: "running"
					}
				}
			} : t);
			return {
				ok: true,
				snapshot: {
					...prev,
					tasks
				}
			};
		}
		case "event:task_step_done": {
			const payload = entry.payload;
			if (!payload.task_id || !payload.step) return invalidPayload(entry.kind, "missing task_id/step");
			const task = prev.tasks.find((t) => t.id === payload.task_id);
			if (!task) return {
				ok: false,
				code: "TASK_NOT_FOUND",
				message: `task_step_done: task ${payload.task_id} not in projection`,
				detail: { task_id: payload.task_id }
			};
			const seeded = task.steps[payload.step];
			if (!seeded) return {
				ok: false,
				code: "TASK_STEP_NOT_FOUND",
				message: `task_step_done: step ${payload.step} not seeded on task ${payload.task_id}`,
				detail: {
					task_id: payload.task_id,
					step: payload.step
				}
			};
			const newStatus = payload.result ?? "passed";
			const updatedSteps = {
				...task.steps,
				[payload.step]: {
					applicability: seeded.applicability,
					status: newStatus
				}
			};
			const nextStatus = task.status === "done" ? "done" : shouldPromoteToDone(updatedSteps) ? "done" : task.status;
			const tasks = prev.tasks.map((t) => t.id === payload.task_id ? {
				...t,
				steps: updatedSteps,
				status: nextStatus,
				...payload.red_test_registered === true ? { red_test_registered: true } : {}
			} : t);
			return {
				ok: true,
				snapshot: {
					...prev,
					tasks
				}
			};
		}
		case "event:task_step_reset": {
			const payload = entry.payload;
			if (!payload.task_id || !payload.step) return invalidPayload(entry.kind, "missing task_id/step");
			const task = prev.tasks.find((t) => t.id === payload.task_id);
			if (!task) return {
				ok: false,
				code: "TASK_NOT_FOUND",
				message: `task_step_reset: task ${payload.task_id} not in projection`,
				detail: { task_id: payload.task_id }
			};
			const seeded = task.steps[payload.step];
			if (!seeded) return {
				ok: false,
				code: "TASK_STEP_NOT_FOUND",
				message: `task_step_reset: step ${payload.step} not seeded on task ${payload.task_id}`,
				detail: {
					task_id: payload.task_id,
					step: payload.step
				}
			};
			const tasks = prev.tasks.map((t) => t.id === payload.task_id ? {
				...t,
				status: "in_progress",
				steps: {
					...t.steps,
					[payload.step]: {
						applicability: seeded.applicability,
						status: "pending"
					}
				}
			} : t);
			return {
				ok: true,
				snapshot: {
					...prev,
					tasks
				}
			};
		}
		case "event:task_abandoned": {
			const payload = entry.payload;
			if (!payload.task_id) return invalidPayload(entry.kind, "missing task_id");
			const tasks = prev.tasks.map((t) => t.id === payload.task_id ? {
				...t,
				status: "abandoned"
			} : t);
			return {
				ok: true,
				snapshot: {
					...prev,
					tasks
				}
			};
		}
		case "event:spec_submitted": {
			const payload = entry.payload;
			if (typeof payload.spec_version !== "number") return invalidPayload(entry.kind, "missing spec_version");
			const versionCheck = checkSpecVersionHead(entry, payload.spec_version, prev.state.spec_version);
			if (!versionCheck.ok) return invalidPayload(entry.kind, versionCheck.message);
			const specHeader = structuredClone({
				feature: {
					id: payload.feature.id,
					name: payload.feature.name
				},
				intent: payload.intent,
				adr_refs: payload.adr_refs,
				needs_clarification: payload.needs_clarification
			});
			return {
				ok: true,
				snapshot: {
					...prev,
					state: {
						...prev.state,
						spec_version: versionCheck.nextVersion
					},
					spec_header: specHeader,
					requirements: [],
					scenarios: [],
					visual_contracts: []
				}
			};
		}
		case "event:spec_req_added": {
			const payload = entry.payload;
			if (typeof payload.spec_version !== "number" || !payload.req) return invalidPayload(entry.kind, "missing spec_version or req");
			const versionCheck = checkSpecVersion(entry, payload.spec_version, prev.state.spec_version);
			if (!versionCheck.ok) return invalidPayload(entry.kind, versionCheck.message);
			if (prev.requirements.some((r) => r.id === payload.req.id)) return invalidPayload(entry.kind, `DUPLICATE_REQ_ID: ${payload.req.id} already in projection`);
			prev.requirements.push(structuredClone(payload.req));
			return {
				ok: true,
				snapshot: versionCheck.nextVersion === prev.state.spec_version ? prev : {
					...prev,
					state: {
						...prev.state,
						spec_version: versionCheck.nextVersion
					}
				}
			};
		}
		case "event:spec_scenario_added": {
			const payload = entry.payload;
			if (typeof payload.spec_version !== "number" || !payload.scenario) return invalidPayload(entry.kind, "missing spec_version or scenario");
			const versionCheck = checkSpecVersion(entry, payload.spec_version, prev.state.spec_version);
			if (!versionCheck.ok) return invalidPayload(entry.kind, versionCheck.message);
			if (prev.scenarios.some((s) => s.id === payload.scenario.id)) return invalidPayload(entry.kind, `DUPLICATE_SCEN_ID: ${payload.scenario.id} already in projection`);
			prev.scenarios.push(structuredClone(payload.scenario));
			return {
				ok: true,
				snapshot: versionCheck.nextVersion === prev.state.spec_version ? prev : {
					...prev,
					state: {
						...prev.state,
						spec_version: versionCheck.nextVersion
					}
				}
			};
		}
		case "event:spec_visual_added": {
			const payload = entry.payload;
			if (typeof payload.spec_version !== "number" || !payload.visual) return invalidPayload(entry.kind, "missing spec_version or visual");
			const versionCheck = checkSpecVersion(entry, payload.spec_version, prev.state.spec_version);
			if (!versionCheck.ok) return invalidPayload(entry.kind, versionCheck.message);
			if (prev.visual_contracts.some((v) => v.id === payload.visual.id)) return invalidPayload(entry.kind, `DUPLICATE_VIS_ID: ${payload.visual.id} already in projection`);
			prev.visual_contracts.push(structuredClone(payload.visual));
			return {
				ok: true,
				snapshot: versionCheck.nextVersion === prev.state.spec_version ? prev : {
					...prev,
					state: {
						...prev.state,
						spec_version: versionCheck.nextVersion
					}
				}
			};
		}
		case "evidence:added": {
			const payload = entry.payload;
			if (!payload.id || !payload.kind) return invalidPayload(entry.kind, "missing id/kind");
			const ev = {
				id: payload.id,
				kind: payload.kind,
				covers: payload.covers ?? [],
				actor: payload.actor ?? entry.actor
			};
			if (payload.result !== void 0) ev.result = payload.result;
			if (payload.check !== void 0) ev.check = payload.check;
			if (payload.reason !== void 0) ev.reason = payload.reason;
			if (payload.attachments !== void 0) ev.attachments = payload.attachments;
			prev.evidence.push(ev);
			return {
				ok: true,
				snapshot: prev
			};
		}
		case "finding:raised": {
			const payload = entry.payload;
			if (!payload.id || !payload.category || !payload.action) return invalidPayload(entry.kind, "missing id/category/action");
			const f = {
				id: payload.id,
				category: payload.category,
				action: payload.action,
				status: "open"
			};
			if (payload.summary !== void 0) f.summary = payload.summary;
			if (payload.reason !== void 0) f.reason = payload.reason;
			if (payload.target !== void 0) f.target = payload.target;
			prev.findings.push(f);
			return {
				ok: true,
				snapshot: prev
			};
		}
		case "finding:closed": {
			const payload = entry.payload;
			if (!payload.id) return invalidPayload(entry.kind, "missing id");
			const idx = prev.findings.findIndex((f) => f.id === payload.id);
			if (idx === -1) return {
				ok: false,
				code: "FINDING_NOT_FOUND",
				message: `finding:closed references unknown finding id=${payload.id}`,
				detail: {
					id: payload.id,
					reason: "unknown"
				}
			};
			if (prev.findings[idx].status === "closed") return {
				ok: false,
				code: "FINDING_NOT_FOUND",
				message: `finding:closed references finding id=${payload.id} that is already closed`,
				detail: {
					id: payload.id,
					reason: "already_closed"
				}
			};
			const findings = prev.findings.map((f, i) => i === idx ? {
				...f,
				status: "closed"
			} : f);
			return {
				ok: true,
				snapshot: {
					...prev,
					findings
				}
			};
		}
		case "pending:added": {
			const payload = entry.payload;
			if (!payload.id || !payload.kind) return invalidPayload(entry.kind, "missing id/kind");
			const p = {
				id: payload.id,
				kind: payload.kind,
				resolved: false
			};
			prev.pending.push(p);
			return {
				ok: true,
				snapshot: prev
			};
		}
		case "pending:resolved": {
			const payload = entry.payload;
			if (!payload.id) return invalidPayload(entry.kind, "missing id");
			const headIdx = prev.pending.findIndex((p) => !p.resolved);
			if (headIdx === -1) return {
				ok: false,
				code: "PENDING_NOT_FOUND",
				message: `pending:resolved with no pending head`
			};
			const head = prev.pending[headIdx];
			if (head.id !== payload.id) return {
				ok: false,
				code: "PENDING_NOT_FOUND",
				message: `pending:resolved id=${payload.id} does not match head id=${head.id} (FIFO violation)`
			};
			const pending = prev.pending.map((p, i) => i === headIdx ? {
				...p,
				resolved: true
			} : p);
			return {
				ok: true,
				snapshot: {
					...prev,
					pending
				}
			};
		}
		case "session:delivered": return {
			ok: true,
			snapshot: {
				...prev,
				state: {
					...prev.state,
					sub_state: "DONE.delivered",
					phase: "DONE"
				}
			}
		};
		case "session:archived": return {
			ok: true,
			snapshot: {
				...prev,
				state: {
					...prev.state,
					sub_state: "DONE.archived",
					phase: "DONE"
				}
			}
		};
		case "session:abandoned": return {
			ok: true,
			snapshot: {
				...prev,
				state: {
					...prev.state,
					sub_state: "DONE.abandoned",
					phase: "DONE"
				}
			}
		};
		case "spike:converted": return {
			ok: true,
			snapshot: prev
		};
		default: {
			const _exhaustive = entry.kind;
			return {
				ok: false,
				code: "REDUCER_NOT_IMPLEMENTED",
				message: `reducer.apply has no handler for kind=${_exhaustive}`,
				detail: { kind: _exhaustive }
			};
		}
	}
}
function invalidPayload(kind, reason) {
	return {
		ok: false,
		code: "INVALID_PAYLOAD",
		message: `${kind}: ${reason}`
	};
}
function checkSpecVersionHead(entry, payloadVersion, currentVersion) {
	if (entry.batch_index !== void 0 && entry.batch_index !== 0) return {
		ok: false,
		message: `SPEC_VERSION_BATCH_MISMATCH: spec_submitted must appear at batch_index=0, got ${entry.batch_index}`
	};
	if (payloadVersion !== currentVersion + 1) return {
		ok: false,
		message: `SPEC_VERSION_NOT_MONOTONIC: spec_version must be ${currentVersion + 1} (current+1), got ${payloadVersion}`
	};
	return {
		ok: true,
		nextVersion: payloadVersion
	};
}
function checkSpecVersion(entry, payloadVersion, currentVersion) {
	if (entry.batch_index === void 0 || entry.batch_index === 0) {
		if (payloadVersion !== currentVersion + 1) return {
			ok: false,
			message: `SPEC_VERSION_NOT_MONOTONIC: spec_version must be ${currentVersion + 1} (current+1) at batch head, got ${payloadVersion}`
		};
		return {
			ok: true,
			nextVersion: payloadVersion
		};
	}
	if (payloadVersion !== currentVersion) return {
		ok: false,
		message: `SPEC_VERSION_BATCH_MISMATCH: spec_version must be ${currentVersion} at batch_index=${entry.batch_index}, got ${payloadVersion}`
	};
	return {
		ok: true,
		nextVersion: currentVersion
	};
}
//#endregion
//#region src/core/snapshot.ts
const HEX64 = /^[a-f0-9]{64}$/;
const ZERO_HASH = "0".repeat(64);
const SnapshotMeta = z.object({
	last_applied_seq: z.number().int().gte(-1),
	last_entry_offset: z.number().int().nonnegative(),
	last_entry_line_hash: z.string().regex(HEX64),
	rolling_checksum: z.string().regex(HEX64),
	feature_schema_version: z.number().int().positive(),
	written_at: z.string().datetime()
}).strict().refine((m) => m.last_applied_seq !== -1 || m.last_entry_offset === 0 && m.last_entry_line_hash === ZERO_HASH && m.rolling_checksum === ZERO_HASH && m.feature_schema_version === 2, { message: "last_applied_seq=-1 (empty sentinel) requires last_entry_offset=0 + line_hash/rolling_checksum=ZERO_HASH + feature_schema_version=current" });
function emptyMeta() {
	return {
		last_applied_seq: -1,
		last_entry_offset: 0,
		last_entry_line_hash: ZERO_HASH,
		rolling_checksum: ZERO_HASH,
		feature_schema_version: 2,
		written_at: (/* @__PURE__ */ new Date(0)).toISOString()
	};
}
/**
* True iff `meta` is the empty-journal sentinel — every structural field
* equals `emptyMeta()` (`written_at`, a free timestamp, is ignored).
*
* `appendMany` / `mutateBatch` require this when the journal tail is empty
* (seq -1): a fresh-prefix prior meta carrying a non-empty `rolling_checksum`
* or `last_entry_offset` would be folded into a post-append meta that no
* longer matches `replayJournal` (codex r171 BLOCK 2).
*/
function isEmptyMeta(meta) {
	const e = emptyMeta();
	return meta.last_applied_seq === e.last_applied_seq && meta.last_entry_offset === e.last_entry_offset && meta.last_entry_line_hash === e.last_entry_line_hash && meta.rolling_checksum === e.rolling_checksum && meta.feature_schema_version === e.feature_schema_version;
}
function computeLineHash(line) {
	return createHash("sha256").update(line, "utf8").digest("hex");
}
function extendRollingChecksum(prev, line) {
	return createHash("sha256").update(prev, "hex").update(line, "utf8").digest("hex");
}
async function writeMeta(metaPath, meta, fsync = true) {
	const tmp = `${metaPath}.tmp-${randomBytes(6).toString("hex")}`;
	const body = JSON.stringify(meta, null, 2);
	await promises.writeFile(tmp, body, { mode: 420 });
	if (fsync) {
		const fh = await promises.open(tmp, "r+");
		try {
			await fh.sync();
		} finally {
			await fh.close();
		}
	}
	await promises.rename(tmp, metaPath);
	if (fsync) {
		const dir = path.dirname(metaPath);
		try {
			const dh = await promises.open(dir, "r");
			try {
				await dh.sync();
			} finally {
				await dh.close();
			}
		} catch {}
	}
}
//#endregion
//#region src/core/journal-append.ts
async function readJournalTail(filePath) {
	let text;
	try {
		text = await promises.readFile(filePath, "utf8");
	} catch (err) {
		if (err.code === "ENOENT") return {
			tailSeq: -1,
			fileSize: 0,
			tailLine: null
		};
		throw err;
	}
	const fileSize = Buffer.byteLength(text, "utf8");
	const trimmed = text.trimEnd();
	if (trimmed.length === 0) return {
		tailSeq: -1,
		fileSize,
		tailLine: null
	};
	const lastNl = trimmed.lastIndexOf("\n");
	const lastLine = lastNl === -1 ? trimmed : trimmed.slice(lastNl + 1);
	const parsed = JSON.parse(lastLine);
	if (typeof parsed.seq !== "number" || !Number.isInteger(parsed.seq)) throw new AppendError("TAIL_CORRUPTION", "journal tail line has non-integer seq; rebuild required", { tail: lastLine.slice(0, 200) });
	return {
		tailSeq: parsed.seq,
		fileSize,
		tailLine: lastLine
	};
}
var AppendError = class extends Error {
	code;
	detail;
	constructor(code, message, detail) {
		super(`[${code}] ${message}`);
		this.code = code;
		this.detail = detail;
		this.name = "AppendError";
	}
};
/**
* **Internal primitive — do not call from CLI or skill code.**
*
* `appendMany` is §11.2 step 5+6 for batches: pre-validate every entry, then
* one newline-joined `write()`. It does NOT run preflight, NOT promote
* sidecars, NOT call reducer.apply. Use `mutate()` or `mutateBatch()` from
* `src/core/journal-mutate.ts` for the sanctioned mutation path —
* `mutateBatch` wraps this primitive after preflight + sidecar promotion +
* Pass-3 final dry-run on promoted entries.
*
* `priorMeta` is the `SnapshotMeta` as of the current journal tail (the
* caller's replay-accumulated meta / `_meta.json`). `appendMany` validates
* it against the actual journal tail BEFORE writing — a `last_applied_seq`
* or `last_entry_line_hash` mismatch is a hard PRIOR_META_STALE failure with
* the journal left untouched. On success the returned `SnapshotMeta` is the
* post-append meta: its `last_applied_seq` / `last_entry_offset` /
* `last_entry_line_hash` / `rolling_checksum` are byte-identical to what
* `replayJournal` would compute for the same final journal (`written_at`
* differs — a fresh timestamp).
*
* Atomicity boundary:
*   - Failures DURING prevalidation (PRIOR_META_STALE / INVALID_ENVELOPE /
*     INVALID_PAYLOAD / SEQ_NOT_MONOTONIC / ENTRY_OVERSIZE) leave the journal
*     file untouched and return NO meta (they throw).
*   - Failures DURING the write or fsync (SHORT_WRITE with `phase` detail)
*     leave the journal in a potentially-corrupt state and return NO meta.
*     The caller MUST treat this as non-recoverable in-process; `loaf doctor
*     --check-tail` handles repair.
*/
async function appendMany(filePath, entries, priorMeta, opts = {}) {
	if (entries.length === 0) throw new AppendError("INVALID_ENVELOPE", "appendMany called with empty entries array; pass at least one entry", { entries_length: 0 });
	const fsyncEnabled = opts.fsync ?? true;
	const { tailSeq, fileSize, tailLine } = await readJournalTail(filePath);
	if (tailSeq === -1) {
		if (!isEmptyMeta(priorMeta)) throw new AppendError("PRIOR_META_STALE", "journal tail is empty (seq -1) but priorMeta is not the empty sentinel; a non-empty prior meta would corrupt the post-append rolling checksum", {
			meta_seq: priorMeta.last_applied_seq,
			tail_seq: tailSeq
		});
	} else {
		if (priorMeta.last_applied_seq !== tailSeq) throw new AppendError("PRIOR_META_STALE", `priorMeta.last_applied_seq=${priorMeta.last_applied_seq} but journal tail seq=${tailSeq}; the prior meta does not describe the current journal tail`, {
			meta_seq: priorMeta.last_applied_seq,
			tail_seq: tailSeq
		});
		if (tailLine === null) throw new AppendError("TAIL_CORRUPTION", `journal tail seq=${tailSeq} but no readable tail line; rebuild required`, { tail_seq: tailSeq });
		if (computeLineHash(tailLine) !== priorMeta.last_entry_line_hash) throw new AppendError("PRIOR_META_STALE", "priorMeta.last_entry_line_hash does not match the journal tail line; the prior meta does not describe the current journal tail", {
			meta_seq: priorMeta.last_applied_seq,
			tail_seq: tailSeq
		});
		const expectedTailOffset = fileSize - Buffer.byteLength(tailLine + "\n", "utf8");
		if (priorMeta.last_entry_offset !== expectedTailOffset) throw new AppendError("PRIOR_META_STALE", `priorMeta.last_entry_offset=${priorMeta.last_entry_offset} but the journal tail line starts at byte ${expectedTailOffset}; the prior meta does not describe the current journal tail`, {
			meta_offset: priorMeta.last_entry_offset,
			expected_offset: expectedTailOffset,
			tail_seq: tailSeq
		});
	}
	let nextExpected = tailSeq + 1;
	const lineBuffers = [];
	const lineStrings = [];
	for (const entry of entries) {
		const parsed = JournalEntry.safeParse(entry);
		if (!parsed.success) throw new AppendError("INVALID_ENVELOPE", "JournalEntry failed envelope schema validation", { issues: parsed.error.issues });
		const payloadParsed = PER_KIND_PAYLOAD[parsed.data.kind].safeParse(parsed.data.payload);
		if (!payloadParsed.success) throw new AppendError("INVALID_PAYLOAD", `payload schema validation failed for kind=${parsed.data.kind}`, {
			kind: parsed.data.kind,
			issues: payloadParsed.error.issues
		});
		if (parsed.data.seq !== nextExpected) throw new AppendError("SEQ_NOT_MONOTONIC", `entry.seq=${parsed.data.seq} but expected ${nextExpected} (tail seq=${tailSeq})`, {
			got: parsed.data.seq,
			expected: nextExpected,
			tail_seq: tailSeq
		});
		const lineString = JSON.stringify(parsed.data);
		const lineBuf = Buffer.from(lineString + "\n", "utf8");
		if (lineBuf.length > 64e3) throw new AppendError("ENTRY_OVERSIZE", `entry serialized to ${lineBuf.length} bytes; limit ${ENTRY_BYTE_LIMIT}`, {
			kind: parsed.data.kind,
			bytes: lineBuf.length,
			limit: ENTRY_BYTE_LIMIT
		});
		lineBuffers.push(lineBuf);
		lineStrings.push(lineString);
		nextExpected += 1;
	}
	const buf = Buffer.concat(lineBuffers);
	if (buf.length > 64e3) throw new AppendError("ENTRY_OVERSIZE", `batch serialized to ${buf.length} bytes; per-write limit ${ENTRY_BYTE_LIMIT}`, {
		scope: "batch",
		bytes: buf.length,
		limit: ENTRY_BYTE_LIMIT,
		entries: entries.length
	});
	const fh = await promises.open(filePath, O_APPEND | O_WRONLY | O_CREAT, 420);
	try {
		const result = await fh.write(buf, 0, buf.length);
		if (result.bytesWritten !== buf.length) throw new AppendError("SHORT_WRITE", `wrote ${result.bytesWritten} of ${buf.length} bytes — append integrity broken; journal may be corrupt, run \`loaf doctor --check-tail\``, {
			phase: "write",
			wrote: result.bytesWritten,
			want: buf.length
		});
		if (fsyncEnabled) try {
			await fh.sync();
		} catch (err) {
			throw new AppendError("SHORT_WRITE", `fsync failed after write — journal may be corrupt, run \`loaf doctor --check-tail\``, {
				phase: "fsync",
				err: String(err)
			});
		}
	} finally {
		await fh.close();
	}
	let lastEntryOffset = fileSize;
	for (let i = 0; i < lineBuffers.length - 1; i++) lastEntryOffset += lineBuffers[i].length;
	let rolling = priorMeta.rolling_checksum;
	for (const lineString of lineStrings) rolling = extendRollingChecksum(rolling, lineString);
	return {
		last_applied_seq: entries[entries.length - 1].seq,
		last_entry_offset: lastEntryOffset,
		last_entry_line_hash: computeLineHash(lineStrings[lineStrings.length - 1]),
		rolling_checksum: rolling,
		feature_schema_version: 2,
		written_at: (/* @__PURE__ */ new Date()).toISOString()
	};
}
//#endregion
//#region src/core/migration.ts
const LegacyCeremonySchema = z.object({
	spec_phase: z.boolean(),
	verify_phase: z.boolean(),
	settle_phase: z.boolean(),
	strict_spec_review: z.boolean(),
	lessons_required: z.enum([
		"must",
		"may",
		"skip"
	]),
	strict_drift_check: z.boolean()
}).strict();
const LegacyTaskSchema = z.object({
	id: z.string().min(1),
	kind: z.string().min(1).optional(),
	status: z.enum([
		"pending",
		"in_progress",
		"done",
		"abandoned"
	]).optional(),
	steps: z.record(z.string(), z.object({ status: z.enum([
		"pending",
		"running",
		"passed",
		"failed",
		"waived",
		"na"
	]).optional() }).passthrough()).optional()
}).passthrough();
const LegacyStateSchema = z.object({
	phase: z.string().optional(),
	sub_state: z.string(),
	iteration: z.number().int().positive().optional(),
	spec_locked: z.boolean().optional(),
	profile: z.string().optional(),
	ceremony: LegacyCeremonySchema.optional(),
	session_id: z.string().optional(),
	feature: z.string().optional()
}).passthrough();
const LegacyTasksSchema = z.object({ tasks: z.array(LegacyTaskSchema).optional() }).passthrough();
const LegacyPendingItemSchema = z.object({
	id: z.string().min(1),
	kind: z.string().min(1),
	resolved: z.boolean().optional()
}).passthrough();
const LegacyPendingSchema = z.object({ pending: z.array(LegacyPendingItemSchema).optional() }).passthrough();
const LegacyEvidenceSchema = z.object({
	id: z.string().min(1),
	kind: z.string().min(1),
	result: EvidenceResult.optional(),
	covers: z.array(z.string()).optional(),
	actor: z.string().optional()
}).passthrough();
const LEGACY_EVIDENCE_KIND_MAP = {
	test: "local-check",
	review: "verify-review",
	visual: "visual-review",
	manual: "manual",
	waiver: "waiver",
	"gate-decision": "gate-decision"
};
const LegacyFindingSchema = z.object({
	id: z.string().min(1),
	category: z.string().min(1),
	action: z.string().min(1),
	status: z.enum(["open", "closed"]).optional()
}).passthrough();
var MigrationError = class extends Error {
	code;
	detail;
	constructor(code, message, detail) {
		super(`[${code}] ${message}`);
		this.code = code;
		this.detail = detail;
		this.name = "MigrationError";
	}
};
const DEFAULT_REHYDRATED_CEREMONY = {
	spec_phase: true,
	verify_phase: true,
	settle_phase: false,
	strict_spec_review: false,
	lessons_required: "skip",
	strict_drift_check: false
};
function isLegalSubState(value) {
	return [
		"TRIAGE.score",
		"TRIAGE.confirm",
		"SPEC.proposal",
		"SPEC.spec",
		"SPEC.plan",
		"SPEC.design",
		"EXECUTE.plan",
		"EXECUTE.work",
		"EXECUTE.done",
		"VERIFY.plan",
		"VERIFY.run",
		"VERIFY.review",
		"VERIFY.acceptance",
		"VERIFY.visual",
		"VERIFY.accept",
		"SETTLE.reconcile",
		"SETTLE.lessons",
		"DONE.delivered",
		"DONE.archived",
		"DONE.abandoned"
	].includes(value);
}
function isLegalPhase(value) {
	return [
		"TRIAGE",
		"SPEC",
		"EXECUTE",
		"VERIFY",
		"SETTLE",
		"DONE"
	].includes(value);
}
async function rehydrateMigration(featureDir, entry) {
	if (entry.kind !== "migration:snapshot_imported") throw new MigrationError("MIGRATION_INCOMPLETE", "rehydrateMigration called with non-migration entry", { kind: entry.kind });
	await verifyMigrationSidecars(featureDir, entry);
	const payload = entry.payload;
	const read = async (key) => promises.readFile(path.join(featureDir, payload.artifacts[key].path), "utf8");
	const [stateBody, tasksBody, evidenceBody, findingsBody, pendingBody] = await Promise.all([
		read("state"),
		read("tasks"),
		read("evidence"),
		read("findings"),
		read("pending")
	]);
	let legacyStateRaw;
	try {
		legacyStateRaw = JSON.parse(stateBody);
	} catch (err) {
		throw new MigrationError("MIGRATION_INCOMPLETE", `legacy state.json failed JSON parse: ${String(err)}`, {
			sidecar: "state.json",
			err: String(err)
		});
	}
	const stateParse = LegacyStateSchema.safeParse(legacyStateRaw);
	if (!stateParse.success) throw new MigrationError("MIGRATION_INCOMPLETE", `legacy state.json failed Zod validation: ${stateParse.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`, {
		sidecar: "state.json",
		issues: stateParse.error.issues
	});
	const legacyState = stateParse.data;
	if (!legacyState.sub_state || !isLegalSubState(legacyState.sub_state)) throw new MigrationError("MIGRATION_INCOMPLETE", `legacy state.json sub_state is missing or not a legal SubState: ${String(legacyState.sub_state)}`, {
		sidecar: "state.json",
		got: legacyState.sub_state
	});
	const subState = legacyState.sub_state;
	const phase = legacyState.phase && isLegalPhase(legacyState.phase) ? legacyState.phase : subState.split(".")[0];
	if (legacyState.phase && legacyState.phase !== subState.split(".")[0]) throw new MigrationError("MIGRATION_INCOMPLETE", `legacy state.json phase=${legacyState.phase} inconsistent with sub_state=${subState}`, {
		sidecar: "state.json",
		phase: legacyState.phase,
		sub_state: subState
	});
	const ceremony = legacyState.ceremony ?? DEFAULT_REHYDRATED_CEREMONY;
	const state = {
		session_id: legacyState.session_id ?? "00000000-0000-0000-0000-000000000000",
		feature: legacyState.feature ?? "migrated",
		phase,
		sub_state: subState,
		iteration: legacyState.iteration ?? 1,
		spec_locked: legacyState.spec_locked ?? false,
		verify_accepted: false,
		spec_version: 0,
		ceremony
	};
	let legacyTasksRaw;
	try {
		legacyTasksRaw = JSON.parse(tasksBody);
	} catch (err) {
		throw new MigrationError("MIGRATION_INCOMPLETE", `legacy tasks.json failed JSON parse: ${String(err)}`, {
			sidecar: "tasks.json",
			err: String(err)
		});
	}
	const tasksParse = LegacyTasksSchema.safeParse(legacyTasksRaw);
	if (!tasksParse.success) throw new MigrationError("MIGRATION_INCOMPLETE", `legacy tasks.json failed Zod validation: ${tasksParse.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`, {
		sidecar: "tasks.json",
		issues: tasksParse.error.issues
	});
	const tasks = (tasksParse.data.tasks ?? []).map((t, idx) => {
		if (!t.id) throw new MigrationError("MIGRATION_INCOMPLETE", `legacy tasks.json[${idx}] missing required id`, {
			sidecar: "tasks.json",
			index: idx
		});
		const base = {
			id: t.id,
			kind: t.kind ?? "behavioral",
			status: t.status ?? "pending",
			steps: {},
			drives: [],
			depends_on: [],
			labels: []
		};
		if (t.steps) for (const [k, v] of Object.entries(t.steps)) {
			const stepStatus = v?.status ?? "pending";
			base.steps[k] = {
				status: stepStatus,
				applicability: "must"
			};
		}
		return base;
	});
	const evidence = [];
	for (const [idx, line] of evidenceBody.split("\n").entries()) {
		if (!line.trim()) continue;
		let raw;
		try {
			raw = JSON.parse(line);
		} catch (err) {
			throw new MigrationError("MIGRATION_INCOMPLETE", `legacy evidence.jsonl line ${idx + 1} failed JSON parse: ${String(err)}`, {
				sidecar: "evidence.jsonl",
				line: idx + 1
			});
		}
		const parsed = LegacyEvidenceSchema.safeParse(raw);
		if (!parsed.success) throw new MigrationError("MIGRATION_INCOMPLETE", `legacy evidence.jsonl line ${idx + 1} failed Zod validation: ${parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`, {
			sidecar: "evidence.jsonl",
			line: idx + 1,
			issues: parsed.error.issues
		});
		const e = parsed.data;
		const normalizedKind = LEGACY_EVIDENCE_KIND_MAP[e.kind];
		if (normalizedKind === void 0) throw new MigrationError("MIGRATION_INCOMPLETE", `legacy evidence.jsonl line ${idx + 1} has unknown kind=${JSON.stringify(e.kind)}; expected one of ${Object.keys(LEGACY_EVIDENCE_KIND_MAP).join("/")} (docs/schemas.ts:741-749 + ADR-0005:716-720)`, {
			sidecar: "evidence.jsonl",
			line: idx + 1,
			legacy_kind: e.kind
		});
		const ev = {
			id: e.id,
			kind: normalizedKind,
			covers: e.covers ?? [],
			actor: e.actor ?? "migration:v0.0.x→v2"
		};
		if (e.result !== void 0) ev.result = e.result;
		evidence.push(ev);
	}
	const findings = [];
	for (const [idx, line] of findingsBody.split("\n").entries()) {
		if (!line.trim()) continue;
		let raw;
		try {
			raw = JSON.parse(line);
		} catch (err) {
			throw new MigrationError("MIGRATION_INCOMPLETE", `legacy findings.jsonl line ${idx + 1} failed JSON parse: ${String(err)}`, {
				sidecar: "findings.jsonl",
				line: idx + 1
			});
		}
		const parsed = LegacyFindingSchema.safeParse(raw);
		if (!parsed.success) throw new MigrationError("MIGRATION_INCOMPLETE", `legacy findings.jsonl line ${idx + 1} failed Zod validation: ${parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`, {
			sidecar: "findings.jsonl",
			line: idx + 1,
			issues: parsed.error.issues
		});
		const f = parsed.data;
		findings.push({
			id: f.id,
			category: f.category,
			action: f.action,
			status: f.status ?? "open"
		});
	}
	let legacyPendingRaw;
	try {
		legacyPendingRaw = JSON.parse(pendingBody);
	} catch (err) {
		throw new MigrationError("MIGRATION_INCOMPLETE", `legacy pending.json failed JSON parse: ${String(err)}`, {
			sidecar: "pending.json",
			err: String(err)
		});
	}
	const pendingParse = LegacyPendingSchema.safeParse(legacyPendingRaw);
	if (!pendingParse.success) throw new MigrationError("MIGRATION_INCOMPLETE", `legacy pending.json failed Zod validation: ${pendingParse.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`, {
		sidecar: "pending.json",
		issues: pendingParse.error.issues
	});
	return {
		state,
		tasks,
		evidence,
		findings,
		pending: (pendingParse.data.pending ?? []).map((p, idx) => {
			if (!p.id || !p.kind) throw new MigrationError("MIGRATION_INCOMPLETE", `legacy pending.json[${idx}] missing required id or kind`, {
				sidecar: "pending.json",
				index: idx,
				got: p
			});
			return {
				id: p.id,
				kind: p.kind,
				resolved: p.resolved ?? false
			};
		}),
		spec_header: null,
		requirements: [],
		scenarios: [],
		visual_contracts: [],
		tasks_based_on: null
	};
}
/**
* Verify that all sidecars referenced by a migration entry exist and match
* the recorded sha256. Used by the reducer apply path (step 5) and by
* `doctor --check-tail`.
*/
async function verifyMigrationSidecars(featureDir, entry) {
	if (entry.kind !== "migration:snapshot_imported") return;
	const payload = entry.payload;
	if (!payload.artifacts) throw new MigrationError("MIGRATION_INCOMPLETE", "migration payload missing artifacts");
	for (const [key, ref] of Object.entries(payload.artifacts)) {
		const abs = path.join(featureDir, ref.path);
		let body;
		try {
			body = await promises.readFile(abs);
		} catch (err) {
			if (err.code === "ENOENT") throw new MigrationError("MIGRATION_SIDECAR_MISSING", `migration sidecar absent: ${key}`, {
				key,
				path: ref.path
			});
			throw err;
		}
		const actualSha = createHash("sha256").update(body).digest("hex");
		if (actualSha !== ref.sha256) throw new MigrationError("MIGRATION_INCOMPLETE", `migration sidecar sha256 mismatch for ${key}`, {
			key,
			expected: ref.sha256,
			actual: actualSha
		});
	}
}
//#endregion
//#region src/core/journal-bootstrap.ts
async function replayJournal(filePath, opts = {}) {
	let contents;
	try {
		contents = await promises.readFile(filePath, "utf8");
	} catch (err) {
		if (err.code === "ENOENT") return {
			ok: true,
			snapshot: initialSnapshot(),
			meta: emptyMeta(),
			entries_applied: 0,
			...opts.collect_entries ? { entries: [] } : {}
		};
		return {
			ok: false,
			code: "JOURNAL_READ_FAILED",
			message: String(err)
		};
	}
	if (contents.length === 0) return {
		ok: true,
		snapshot: initialSnapshot(),
		meta: emptyMeta(),
		entries_applied: 0,
		...opts.collect_entries ? { entries: [] } : {}
	};
	const lines = contents.split("\n");
	const completeLines = [];
	for (let i = 0; i < lines.length; i++) {
		if (i === lines.length - 1 && lines[i] === "") continue;
		completeLines.push(lines[i]);
	}
	let snapshot = initialSnapshot();
	let lastSeq = -1;
	let lastEntryOffset = 0;
	let lastLineHash = emptyMeta().last_entry_line_hash;
	let rolling = emptyMeta().rolling_checksum;
	let offset = 0;
	let applied = 0;
	const collected = opts.collect_entries ? [] : void 0;
	for (const line of completeLines) {
		const lineBytes = Buffer.byteLength(line + "\n", "utf8");
		let entry;
		try {
			const parsed = JournalEntry.safeParse(JSON.parse(line));
			if (!parsed.success) return {
				ok: false,
				code: "INVALID_ENTRY",
				message: "journal contains entry that fails envelope schema",
				at_seq: lastSeq + 1,
				detail: {
					line: line.slice(0, 200),
					issues: parsed.error.issues
				}
			};
			entry = parsed.data;
		} catch (err) {
			return {
				ok: false,
				code: "INVALID_ENTRY",
				message: `journal line is not valid JSON: ${String(err)}`,
				at_seq: lastSeq + 1,
				detail: { line: line.slice(0, 200) }
			};
		}
		if (entry.kind === "migration:snapshot_imported") {
			if (!opts.feature_dir) return {
				ok: false,
				code: "REDUCER_REJECTED",
				message: "migration:snapshot_imported requires opts.feature_dir for sidecar rehydration; refusing to silently bootstrap default state",
				at_seq: entry.seq
			};
			try {
				snapshot = await rehydrateMigration(opts.feature_dir, entry);
			} catch (err) {
				return {
					ok: false,
					code: "REDUCER_REJECTED",
					message: `migration rehydration failed: ${String(err)}`,
					at_seq: entry.seq
				};
			}
		} else {
			const result = apply(snapshot, entry);
			if (!result.ok) return {
				ok: false,
				code: "REDUCER_REJECTED",
				message: result.message,
				at_seq: entry.seq,
				detail: result.detail ?? {}
			};
			snapshot = result.snapshot;
		}
		lastSeq = entry.seq;
		lastEntryOffset = offset;
		lastLineHash = computeLineHash(line);
		rolling = extendRollingChecksum(rolling, line);
		offset += lineBytes;
		applied++;
		collected?.push(entry);
	}
	return {
		ok: true,
		snapshot,
		meta: {
			last_applied_seq: applied === 0 ? emptyMeta().last_applied_seq : lastSeq,
			last_entry_offset: lastEntryOffset,
			last_entry_line_hash: lastLineHash,
			rolling_checksum: rolling,
			feature_schema_version: 2,
			written_at: (/* @__PURE__ */ new Date()).toISOString()
		},
		entries_applied: applied,
		...collected ? { entries: collected } : {}
	};
}
//#endregion
//#region src/core/cli-runtime.ts
const LOAF_DOCS_URL = "https://docs.loaf.invalid";
const LOAF_ISSUE_URL = "https://issues.loaf.invalid";
function helpFooter() {
	return `\ndocs:       ${LOAF_DOCS_URL}\nreport bug: ${LOAF_ISSUE_URL}\n`;
}
async function loadSession(featureDir) {
	await promises.mkdir(featureDir, { recursive: true });
	const replay = await replayJournal(path.join(featureDir, "journal.jsonl"), {
		feature_dir: featureDir,
		collect_entries: true
	});
	if (!replay.ok) throw new Error(`failed to load session at ${featureDir}: ${replay.code} — ${replay.message}`);
	if (replay.entries === void 0) throw new Error("internal invariant: replayJournal returned ok with collect_entries=true but no entries");
	return {
		feature_dir: featureDir,
		snapshot: replay.entries_applied === 0 ? initialSnapshot() : replay.snapshot,
		tail_seq: replay.meta.last_applied_seq,
		entries: replay.entries,
		meta: replay.meta
	};
}
function defaultFeatureDir(feature) {
	return path.join(process.cwd(), ".loaf", feature);
}
/**
* Read git's configured user.email. Tiny boundary helper for
* actor-resolver; resolver remains the policy owner. Returns null when
* git is unavailable or no email is configured (the resolver treats
* either case as "no git fallback available").
*
* Uses execFileSync (not execSync) so there is no shell parsing path —
* no dynamic input here, but the cleaner CLI boundary by default
* (codex r31 Q2.1).
*/
function getGitEmail() {
	try {
		const trimmed = execFileSync("git", ["config", "user.email"], {
			encoding: "utf8",
			stdio: [
				"ignore",
				"pipe",
				"ignore"
			]
		}).trim();
		return trimmed.length === 0 ? null : trimmed;
	} catch {
		return null;
	}
}
//#endregion
//#region src/core/spec-frontmatter.ts
const FRONTMATTER_RE = /^---\s*\r?\n([\s\S]*?)\r?\n---\s*(?:\r?\n|$)/;
/**
* Splits a spec.md raw string into (frontmatter_yaml, body) using the
* shared FRONTMATTER_RE grammar. `body` is everything AFTER the closing
* `---\n` (preserves trailing content verbatim). If no frontmatter block
* is present, frontmatter is null and body is the whole input.
*
* Symmetric companion to readSpecFrontmatter() that returns ONLY the
* structural split — caller validates YAML / SpecFrontmatter separately.
*/
function splitFrontmatter(raw) {
	const match = FRONTMATTER_RE.exec(raw);
	if (!match) return {
		frontmatter: null,
		body: raw
	};
	const body = raw.slice(match[0].length);
	return {
		frontmatter: match[1],
		body
	};
}
async function readSpecFrontmatter(featureDir) {
	const specPath = path$1.join(featureDir, "spec.md");
	let raw;
	try {
		raw = await fs.readFile(specPath, "utf8");
	} catch (err) {
		if (err.code === "ENOENT") return {
			ok: false,
			code: "SPEC_NOT_FOUND",
			message: `spec.md not found at ${specPath}`,
			detail: { path: specPath }
		};
		throw err;
	}
	const match = FRONTMATTER_RE.exec(raw);
	if (!match) return {
		ok: false,
		code: "SPEC_YAML_INVALID",
		message: "spec.md is missing a YAML frontmatter block fenced by `---` on the first line",
		detail: { path: specPath }
	};
	let parsed;
	try {
		parsed = parse(match[1]);
	} catch (err) {
		return {
			ok: false,
			code: "SPEC_YAML_INVALID",
			message: `spec.md frontmatter YAML failed to parse: ${err.message}`,
			detail: {
				path: specPath,
				error: err.message
			}
		};
	}
	const validated = SpecFrontmatter.safeParse(parsed);
	if (!validated.success) return {
		ok: false,
		code: "SPEC_FRONTMATTER_INVALID",
		message: "spec.md frontmatter failed SpecFrontmatter schema validation",
		detail: {
			path: specPath,
			issues: validated.error.issues
		}
	};
	return {
		ok: true,
		frontmatter: validated.data
	};
}
//#endregion
//#region src/core/gates/spec-lock-check.ts
const KINDS_REQUIRING_RATIONALE = [
	"structural",
	"docs",
	"spike",
	"chore"
];
function specLockCheck(snapshot, frontmatter) {
	const failures = [];
	if (frontmatter.needs_clarification.length > 0) failures.push({
		check: 2,
		code: "SPEC_HAS_UNCLARIFIED",
		message: `spec has ${frontmatter.needs_clarification.length} unresolved needs_clarification entries; resolve or remove them before spec-lock`,
		detail: { ids: frontmatter.needs_clarification.map((nc) => nc.id) }
	});
	let check3Failed = false;
	if (snapshot.tasks_based_on === null) {
		failures.push({
			check: 3,
			code: "TASKS_NOT_PLANNED",
			message: `tasks have not been planned yet; spec-lock requires a task graph (tasks_based_on=null in snapshot)`
		});
		check3Failed = true;
	} else if (snapshot.tasks_based_on.spec !== frontmatter.spec_version) {
		failures.push({
			check: 3,
			code: "TASKS_BASED_ON_STALE",
			message: `tasks_based_on.spec=${snapshot.tasks_based_on.spec} does not match frontmatter.spec_version=${frontmatter.spec_version}; the task graph was planned against an older spec`,
			detail: {
				tasks_based_on_spec: snapshot.tasks_based_on.spec,
				current_spec_version: frontmatter.spec_version
			}
		});
		check3Failed = true;
	}
	if (!check3Failed) {
		for (const req of frontmatter.requirements) if (!snapshot.tasks.some((t) => t.drives.includes(req.id))) failures.push({
			check: 4,
			code: "REQ_NOT_DRIVEN",
			message: `${req.id} is not referenced by any task.drives[]; add a task that drives this requirement before spec-lock`,
			detail: { req_id: req.id }
		});
	}
	for (const req of frontmatter.requirements) if (!hasVerifiability(req)) failures.push({
		check: 5,
		code: "MISSING_VERIFIABILITY",
		message: `${req.id} must declare measurable, verified_by_scenarios[], or acceptance_na+acceptance_na_reason (≥10 chars)`,
		detail: {
			req_id: req.id,
			req_type: req.type
		}
	});
	if (!check3Failed) for (const scenario of frontmatter.scenarios) {
		if (scenario.tag !== "e2e") continue;
		if (scenario.acceptance_na !== void 0) continue;
		if (!snapshot.tasks.some((t) => t.requires_acceptance === true && t.drives.includes(scenario.id))) failures.push({
			check: 6,
			code: "E2E_SCENARIO_UNBOUND",
			message: `e2e scenario ${scenario.id} has no binding task (requires_acceptance=true AND drives includes ${scenario.id}); either add a binding task or mark scenario with acceptance_na+reason`,
			detail: { scenario_id: scenario.id }
		});
	}
	if (!check3Failed) for (const visual of frontmatter.visual_contracts ?? []) {
		if (visual.visual_na !== void 0) continue;
		if (!snapshot.tasks.some((t) => t.kind === "visual-ui" && (t.visual_contract_refs ?? []).includes(visual.id))) failures.push({
			check: 7,
			code: "VISUAL_CONTRACT_UNBOUND",
			message: `visual_contract ${visual.id} has no visual-ui task with visual_contract_refs containing it; add a binding visual-ui task or mark contract with visual_na+reason`,
			detail: { visual_id: visual.id }
		});
	}
	if (snapshot.tasks.length > 0) for (const task of snapshot.tasks) {
		const reasons = [];
		if (task.kind === "visual-ui") {
			if (!task.visual_contract_refs || task.visual_contract_refs.length === 0) reasons.push("visual-ui task requires visual_contract_refs[] with ≥1 entry");
		} else if (KINDS_REQUIRING_RATIONALE.includes(task.kind)) {
			if (!task.no_test_rationale || task.no_test_rationale.length < 10) reasons.push(`kind=${task.kind} requires no_test_rationale string ≥10 chars`);
		}
		if (reasons.length > 0) failures.push({
			check: 8,
			code: "TASK_KIND_SCHEMA_VIOLATION",
			message: `task ${task.id} (kind=${task.kind}) violates projected kind-specific obligations: ${reasons.join("; ")}`,
			detail: {
				task_id: task.id,
				kind: task.kind,
				reasons
			}
		});
	}
	if (failures.length === 0) return { ok: true };
	return {
		ok: false,
		checks: failures
	};
}
//#endregion
//#region src/core/gates/spec-lock-eval.ts
async function evaluateSpecLock(snapshot, featureDir) {
	const read = await readSpecFrontmatter(featureDir);
	if (!read.ok) return {
		ok: false,
		checks: [{
			check: 1,
			code: "SPEC_FRONTMATTER_INVALID",
			message: read.message,
			detail: {
				subcode: read.code,
				...read.detail ?? {}
			}
		}]
	};
	return specLockCheck(snapshot, read.frontmatter);
}
//#endregion
//#region src/core/evidence-compat.ts
const EVIDENCE_COMPAT = {
	REQ: {
		allowed: [
			"task-summary",
			"verify-review",
			"spec-review",
			"manual",
			"waiver"
		],
		manual_requires_reason: true
	},
	SCEN: {
		allowed: [
			"acceptance",
			"manual",
			"waiver"
		],
		manual_requires_reason: true
	},
	VIS: {
		allowed: [
			"visual-review",
			"manual",
			"waiver"
		],
		manual_requires_reason: true,
		requires_attachment_for_visual_review: true
	},
	T: {
		allowed: [
			"task-summary",
			"local-check",
			"manual",
			"waiver"
		],
		manual_requires_reason: false
	},
	GATE: {
		allowed: ["gate-decision"],
		manual_requires_reason: false
	}
};
/**
* Recognize a coverage-id string and map to its IdKind. Returns null for
* malformed or unknown shapes. Strict — uses the documented regexes
* from spec-schema / task-schema, so "REQ-bad" returns null (not "REQ").
*/
function parseIdKind(coveredId) {
	if (coveredId === "GATE") return "GATE";
	if (ReqIdPayload.safeParse(coveredId).success) return "REQ";
	if (ScenIdPayload.safeParse(coveredId).success) return "SCEN";
	if (VisIdPayload.safeParse(coveredId).success) return "VIS";
	if (TaskIdPayload.safeParse(coveredId).success) return "T";
	return null;
}
/**
* Returns true iff the evidence can satisfy the given coverage id per
* protocol §5.4. Pure function over EvidenceState projection — no IO.
*
* Note: EvidenceState may be loosely-populated (legacy migration entries
* lack reason/attachments). canSatisfy double-checks the projection-level
* shape even though EvidenceFullPayload enforces it at journal append —
* defense-in-depth for any caller path that bypasses the schema gate.
*/
function canSatisfy(evidence, coveredId) {
	const idKind = parseIdKind(coveredId);
	if (idKind === null) return false;
	const rule = EVIDENCE_COMPAT[idKind];
	if (!rule.allowed.includes(evidence.kind)) return false;
	if (evidence.kind === "manual" || evidence.kind === "waiver") {
		if (rule.manual_requires_reason) {
			if (!evidence.actor.startsWith("human:")) return false;
			if (!evidence.reason || evidence.reason.length < 10) return false;
		}
	}
	if (idKind === "VIS" && evidence.kind === "visual-review") {
		if (!evidence.attachments || evidence.attachments.length === 0) return false;
	}
	return true;
}
//#endregion
//#region src/core/gates/verify-accept-check.ts
const KIND_TO_LANE_FALLBACK = {
	"local-check": "run",
	"task-summary": "run",
	"verify-review": "review",
	"spec-review": "review",
	acceptance: "acceptance",
	"visual-review": "visual"
};
const PASSING_RESULTS = new Set([
	"passed",
	"approved",
	"waived"
]);
/** Lanes that pass an evidence result-check filter. */
function isPassingResult(result) {
	return result !== void 0 && PASSING_RESULTS.has(result);
}
/**
* Derive the set of "must" lanes from the snapshot + frontmatter.
*
* Policy (codex r33 Q1(a)) — protocol does NOT cite a literal lane
* derivation table, so this is explicit policy made by reading §5.2 +
* §7 + §1196-1199:
*   - any non-acceptance_na SCEN.tag=e2e ⇒ ACCEPTANCE lane is must
*   - any non-visual_na VIS ⇒ VISUAL lane is must
*   - any done task ⇒ RUN + REVIEW lanes are must (default lanes for
*     any implementation)
*   - any non-acceptance_na REQ ⇒ REVIEW lane is must (reviewer signs off
*     on REQ-level spec_fit + quality_fit)
*
* Future protocol clarification may move some of these into spec.frontmatter
* directly (e.g. per-feature opt-out of REVIEW lane); for now the policy
* is conservative.
*/
function deriveVerifyApplicability(snapshot, frontmatter) {
	const lanes = /* @__PURE__ */ new Set();
	for (const req of frontmatter.requirements) {
		if (req.acceptance_na === true) continue;
		lanes.add("review");
	}
	for (const scen of frontmatter.scenarios) {
		if (scen.tag !== "e2e") continue;
		if (scen.acceptance_na !== void 0) continue;
		lanes.add("acceptance");
	}
	for (const vis of frontmatter.visual_contracts ?? []) {
		if (vis.visual_na !== void 0) continue;
		lanes.add("visual");
	}
	for (const task of snapshot.tasks) if (task.status === "done") {
		lanes.add("run");
		lanes.add("review");
	}
	return lanes;
}
/**
* Map an EvidenceState to its lane. Primary linkage = `evidence.check`
* (per codex r33 Q1(b)); fallback = narrow kind → lane map. Returns
* undefined if the evidence isn't relevant to any lane.
*/
function evidenceLane(ev) {
	if (ev.check !== void 0) return ev.check;
	return KIND_TO_LANE_FALLBACK[ev.kind];
}
/**
* Lane status: returns true iff any evidence is on this lane with a
* passing/waived/approved result.
*/
function laneIsPassed(lane, evidence) {
	for (const ev of evidence) {
		if (evidenceLane(ev) !== lane) continue;
		if (isPassingResult(ev.result)) return true;
	}
	return false;
}
/**
* Implementer set for check 5: actors on done-task task-summary /
* local-check evidence, EXCLUDING cli:* prefix (codex r33 Q4: cli:loaf
* local-check is not implementer). Returns empty set if no human / non-cli
* implementer can be established — caller must fail-closed.
*/
function deriveImplementers(snapshot) {
	const doneTaskIds = new Set(snapshot.tasks.filter((t) => t.status === "done").map((t) => t.id));
	const implementers = /* @__PURE__ */ new Set();
	for (const ev of snapshot.evidence) {
		if (ev.kind !== "task-summary" && ev.kind !== "local-check") continue;
		if (!ev.covers.some((c) => doneTaskIds.has(c))) continue;
		if (ev.actor.startsWith("cli:")) continue;
		implementers.add(ev.actor);
	}
	return implementers;
}
const TASK_ALLOWED_EVIDENCE_KINDS = [
	"task-summary",
	"local-check",
	"manual",
	"waiver"
];
function verifyAcceptCheck(snapshot, frontmatter) {
	const failures = [];
	const applicableLanes = deriveVerifyApplicability(snapshot, frontmatter);
	for (const lane of applicableLanes) if (!laneIsPassed(lane, snapshot.evidence)) failures.push({
		check: 1,
		code: "VERIFY_LANE_NOT_PASSED",
		message: `applicable VERIFY lane=${lane} has no evidence with passing/approved/waived result; add evidence with check=${lane} or a matching kind`,
		detail: { lane }
	});
	const open = snapshot.findings.filter((f) => f.status === "open");
	if (open.length > 0) failures.push({
		check: 2,
		code: "OPEN_FINDINGS_PRESENT",
		message: `${open.length} finding(s) still open; resolve or close before verify-accept`,
		detail: {
			count: open.length,
			open_ids: open.map((f) => f.id)
		}
	});
	const satisfiesCoverage = (ev, id) => isPassingResult(ev.result) && ev.covers.includes(id) && canSatisfy(ev, id);
	for (const req of frontmatter.requirements) {
		if (req.acceptance_na === true) continue;
		if (!snapshot.evidence.some((ev) => satisfiesCoverage(ev, req.id))) failures.push({
			check: 3,
			code: "COVERAGE_NOT_SATISFIED",
			message: `${req.id} has no evidence passing canSatisfy() + result ∈ {passed, approved, waived} — add evidence with kind in REQ-allowed list (task-summary/verify-review/spec-review/manual/waiver) covering this id`,
			detail: {
				covered_id: req.id,
				covered_kind: "REQ"
			}
		});
	}
	for (const scen of frontmatter.scenarios) {
		if (scen.acceptance_na !== void 0) continue;
		if (scen.tag !== "e2e") continue;
		if (!snapshot.evidence.some((ev) => satisfiesCoverage(ev, scen.id))) failures.push({
			check: 3,
			code: "COVERAGE_NOT_SATISFIED",
			message: `${scen.id} has no evidence passing canSatisfy() + result ∈ {passed, approved, waived} — add evidence with kind=acceptance / manual+reason / waiver+reason covering this id`,
			detail: {
				covered_id: scen.id,
				covered_kind: "SCEN"
			}
		});
	}
	for (const vis of frontmatter.visual_contracts ?? []) {
		if (vis.visual_na !== void 0) continue;
		if (!snapshot.evidence.some((ev) => satisfiesCoverage(ev, vis.id))) failures.push({
			check: 3,
			code: "COVERAGE_NOT_SATISFIED",
			message: `${vis.id} has no evidence passing canSatisfy() + result ∈ {passed, approved, waived} — add evidence with kind=visual-review+attachment / manual+reason / waiver+reason covering this id`,
			detail: {
				covered_id: vis.id,
				covered_kind: "VIS"
			}
		});
	}
	let check4PreconditionFailed = false;
	if (snapshot.tasks_based_on === null) {
		failures.push({
			check: 4,
			code: "TASKS_NOT_PLANNED",
			message: `tasks have not been planned yet; verify-accept check 4 requires a task graph (tasks_based_on=null in snapshot)`
		});
		check4PreconditionFailed = true;
	} else if (snapshot.tasks_based_on.spec !== frontmatter.spec_version) {
		failures.push({
			check: 4,
			code: "TASKS_BASED_ON_STALE",
			message: `tasks_based_on.spec=${snapshot.tasks_based_on.spec} does not match frontmatter.spec_version=${frontmatter.spec_version}; verify-accept check 4 cannot evaluate a stale task graph`,
			detail: {
				tasks_based_on_spec: snapshot.tasks_based_on.spec,
				current_spec_version: frontmatter.spec_version
			}
		});
		check4PreconditionFailed = true;
	}
	if (!check4PreconditionFailed) for (const task of snapshot.tasks) {
		if (task.status !== "done") continue;
		if (!snapshot.evidence.some((ev) => ev.covers.includes(task.id) && TASK_ALLOWED_EVIDENCE_KINDS.includes(ev.kind))) failures.push({
			check: 4,
			code: "TASK_DONE_NO_EVIDENCE",
			message: `task ${task.id} is status=done but has no evidence (kind ∈ {task-summary, local-check, manual, waiver}) covering it`,
			detail: { task_id: task.id }
		});
		if (task.kind === "behavioral" && task.labels.includes("bug") && task.red_test_registered !== true) failures.push({
			check: 4,
			code: "BUG_TASK_RED_NOT_REGISTERED",
			message: `behavioral bug task ${task.id} is status=done but never registered its RED test (red_test_registered≠true)`,
			detail: { task_id: task.id }
		});
	}
	if (snapshot.state?.ceremony.strict_spec_review === true) {
		const isPassingSpecReview = (r) => r === "passed" || r === "approved";
		const specReviews = snapshot.evidence.filter((ev) => ev.kind === "spec-review" && isPassingSpecReview(ev.result));
		if (specReviews.length === 0) failures.push({
			check: 5,
			code: "SPEC_REVIEW_MISSING",
			message: `ceremony.strict_spec_review=true requires ≥1 evidence kind=spec-review from an actor ≠ implementer; none found`
		});
		else {
			const implementers = deriveImplementers(snapshot);
			if (implementers.size === 0) failures.push({
				check: 5,
				code: "SPEC_REVIEW_IMPLEMENTER_UNKNOWN",
				message: `ceremony.strict_spec_review=true requires actor ≠ implementer comparison, but no implementer actor can be established (done-task evidence actors all cli:*); fail-closed`
			});
			else {
				const conflicts = specReviews.filter((ev) => implementers.has(ev.actor));
				if (conflicts.length > 0 && conflicts.length === specReviews.length) failures.push({
					check: 5,
					code: "SPEC_REVIEW_IMPLEMENTER_CONFLICT",
					message: `every spec-review evidence has actor ∈ implementer set; require ≥1 spec-review from an actor that did not implement done tasks`,
					detail: {
						spec_review_actors: specReviews.map((ev) => ev.actor),
						implementers: [...implementers]
					}
				});
			}
		}
	}
	if (failures.length === 0) return { ok: true };
	return {
		ok: false,
		checks: failures
	};
}
//#endregion
//#region src/core/gates/verify-accept-eval.ts
async function evaluateVerifyAccept(snapshot, featureDir) {
	const read = await readSpecFrontmatter(featureDir);
	if (!read.ok) return {
		ok: false,
		checks: [{
			check: 1,
			code: "SPEC_FRONTMATTER_INVALID",
			message: read.message,
			detail: {
				subcode: read.code,
				...read.detail ?? {}
			}
		}]
	};
	return verifyAcceptCheck(snapshot, read.frontmatter);
}
//#endregion
//#region src/core/task-history.ts
/**
* Forward-replay the plan/amend chain in `entries` and return a no-alias
* copy of `taskId`'s latest canonical `TaskFullPayload` body, or `undefined`
* if no live plan/amend entry defines it.
*
* `event:tasks_planned` is whole-replacement (reducer rebuilds the entire
* task set from its payload), so a later plan that omits `taskId` clears
* the body. `event:tasks_amended` carries a single replacement/added task;
* its `mode` is irrelevant to body recovery — both add and replace make the
* carried task the latest body once the entry is in the journal.
*/
function latestCanonicalTaskBody(entries, taskId) {
	let current;
	for (const entry of entries) if (entry.kind === "event:tasks_planned") current = entry.payload.tasks?.find((t) => t.id === taskId);
	else if (entry.kind === "event:tasks_amended") {
		const payload = entry.payload;
		if (payload.task?.id === taskId) current = payload.task;
	}
	return current === void 0 ? void 0 : structuredClone(current);
}
/**
* Overlay the live runtime state from the slim `current` projection onto a
* canonical `base` body, producing the full task to carry in a `tasks amend`
* `event:tasks_amended` payload.
*
* Overlaid from `current`: `task.status`, and each base step's `status` +
* `applicability` (where the slim projection has that step). Preserved from
* `base`: every body-only field the slim projection drops — `tests`,
* `test_layer`, kind-specific contract fields, and per-step `evidence_refs`
* / `reason` / `started_at`. The base body defines the canonical step set;
* a step absent from `current.steps` keeps its base values.
*/
function materializeTaskForAmend(base, current) {
	const out = structuredClone(base);
	out.status = current.status;
	if (current.red_test_registered !== void 0) out.red_test_registered = current.red_test_registered;
	const exec = out.execution;
	for (const stepName of Object.keys(exec)) {
		const live = current.steps[stepName];
		const step = exec[stepName];
		if (live && step) {
			step.status = live.status;
			step.applicability = live.applicability;
		}
	}
	return out;
}
/**
* Carry per-step execution PROGRESS forward from a task's current canonical
* body onto a fresh replacement graph — for a sponsored `tasks amend --input`
* (Phase 11 Item 3 SC1b, codex r136 Q4).
*
* The `--input` file is an id-less `TaskInput`; `materializeTaskInput` gives
* the replacement a fresh `execution` block (every step `pending`,
* `evidence_refs: []`, no `started_at` / `reason`). A sponsored graph amend
* must NOT erase execution history, so for every step RETAINED across the
* replacement (present in both bodies) this copies the body-only progress
* fields — `evidence_refs`, `started_at`, `reason` — from the canonical body.
* A step introduced by the replacement keeps its fresh (unstarted,
* no-evidence) values.
*
* `status` / `applicability` are NOT carried here — `materializeTaskForAmend`
* overlays those from the slim projection downstream. This helper is the
* CLI-side guard for the body-only half of the Q4 frozen-field rule:
* stable-core preflight runs against the slim `Snapshot.tasks` projection,
* which drops `evidence_refs` / `started_at` / step `reason`, so it cannot
* verify their preservation (see the §8.6 sponsored-branch comment in
* preflight.ts).
*/
function carryForwardStepProgress(replacement, canonical) {
	const out = structuredClone(replacement);
	const outExec = out.execution;
	const priorExec = canonical.execution;
	for (const stepName of Object.keys(outExec)) {
		const prior = priorExec[stepName];
		const step = outExec[stepName];
		if (!prior || !step) continue;
		step.evidence_refs = structuredClone(prior.evidence_refs);
		if (prior.started_at !== void 0) step.started_at = prior.started_at;
		if (prior.reason !== void 0) step.reason = prior.reason;
	}
	return out;
}
const SchemaVersionLiteral = z.literal(2);
const TasksJson = z.object({
	schema_version: SchemaVersionLiteral,
	version: z.number().int().positive(),
	based_on: z.object({ spec: z.number().int().positive() }),
	tasks: z.array(TaskFullPayload)
}).strict();
const EvidenceEntry = EvidenceFullShape.extend({
	schema_version: SchemaVersionLiteral,
	at: z.string().datetime()
}).strict();
const EvidenceJson = z.object({
	schema_version: SchemaVersionLiteral,
	evidence: z.array(EvidenceEntry)
}).strict();
const FindingStateShape = z.object({
	id: z.string().regex(/^FND-\d{3,}$/),
	category: FindingCategory,
	action: FindingAction,
	status: z.enum(["open", "closed"]),
	summary: z.string().optional(),
	reason: z.string().optional(),
	target: z.object({
		task_id: z.string().regex(/^T-\d{3,}$/),
		step: z.string().min(1)
	}).strict().optional()
}).strict();
const FindingsJson = z.object({
	schema_version: SchemaVersionLiteral,
	findings: z.array(FindingStateShape)
}).strict();
const PendingQueueEntry = z.object({
	pending_id: PendingId,
	kind: PendingPromptKind,
	question: z.string().min(3),
	options: z.array(z.string()).optional(),
	blocks: z.enum([
		"advance",
		"gate",
		"deliver",
		"all"
	]),
	raised_at: z.string().datetime(),
	raised_by: z.string().min(1),
	at: z.string().datetime(),
	raised_by_task_id: z.string().regex(/^T-\d{3,}$/).optional()
}).strict();
const PendingProjectionEntry = PendingQueueEntry.extend({ resolved: z.boolean() }).strict();
const PendingJson = z.object({
	schema_version: SchemaVersionLiteral,
	pending: z.array(PendingProjectionEntry)
}).strict();
const StateProjectionPhase = z.enum([
	"TRIAGE",
	"SPEC",
	"EXECUTE",
	"VERIFY",
	"SETTLE",
	"DONE"
]);
const StateProjection = z.object({
	schema_version: SchemaVersionLiteral,
	session_id: z.string().min(1),
	session_label: z.string().min(3).nullable(),
	workspace: z.string().min(1),
	loaf_version_required: z.string().regex(/^[\^~]?\d+\.\d+(\.\d+)?(-[0-9A-Za-z.-]+)?(\+[0-9A-Za-z.-]+)?$/).nullable(),
	phase: StateProjectionPhase,
	sub_state: SubState,
	iteration: z.number().int().positive(),
	spec_locked: z.boolean(),
	verify_accepted: z.boolean(),
	pending: z.array(PendingQueueEntry),
	ceremony: Ceremony,
	ceremony_label: z.string(),
	complexity_score: z.number().int().min(0).max(100).nullable(),
	based_on: z.object({
		spec: z.number().int().nonnegative(),
		tasks: z.number().int().nonnegative()
	}).strict(),
	spec_version: z.number().int().nonnegative(),
	created_at: z.string().datetime(),
	updated_at: z.string().datetime()
}).strict().refine((s) => s.sub_state.startsWith(s.phase + "."), { message: "sub_state must start with phase + '.'" }).refine((s) => !s.phase.startsWith("DONE") || s.pending.length === 0, { message: "DONE.* requires pending = [] (live queue empty at terminal)" });
//#endregion
//#region src/core/projection-writer.ts
/**
* Compose `snapshots/state.json` from a replayed snapshot + journal entries.
*
* Returns `null` when the journal carries no `session:started`
* (`snapshot.state` null — empty journal): there is no session to project,
* so the file is SKIPPED, never written empty (mirrors `composeTasksJson`).
*
* The bucket-C identity fields (`session_label` / `workspace` /
* `ceremony_label` / `loaf_version_required`) come off the `session:started`
* payload, re-parsed through `SessionStartedPayload`: a pre-SC1 (legacy)
* entry lacks them (field `undefined` → documented fallback —
* `workspace`→"default", `ceremony_label`→"", `session_label` &
* `loaf_version_required`→null), but a field PRESENT-but-malformed fails
* fast — `--rebuild` must not launder payload corruption into a fallback
* (codex r168 BLOCK 2). `complexity_score` has no journal source — always
* `null` (F-019). `created_at` is the `session:started` envelope timestamp;
* `updated_at` is the last replayed entry's. `based_on.tasks` counts
* `event:tasks_planned` + `event:tasks_amended` (= `TasksJson.version`).
*
* `pending` is the LIVE queue — `composePendingJson` minus every entry with
* a matching `pending:resolved`, mapped down to `PendingQueueEntry` (the
* `resolved` tag belongs to `pending.json`, not the public `state.json`
* contract — codex r168 BLOCK 1). The composed object is validated against
* `StateProjection` before return (defense-in-depth, mirrors the others).
*/
function composeStateProjection(snapshot, entries) {
	const state = snapshot.state;
	if (state === null) return null;
	const startEntry = entries.find((e) => e.kind === "session:started");
	if (startEntry === void 0) throw new Error("composeStateProjection: snapshot carries session state but the journal has no session:started entry — projection corruption");
	const lastEntry = entries[entries.length - 1];
	if (lastEntry === void 0) throw new Error("composeStateProjection: snapshot carries session state but the entry stream is empty — projection corruption");
	const startPayload = SessionStartedPayload.parse(startEntry.payload);
	const sessionLabel = startPayload.session_label ?? null;
	const ceremonyLabel = startPayload.ceremony_label ?? "";
	const workspace = startPayload.workspace ?? "default";
	const loafVersionRequired = startPayload.loaf_version_required ?? null;
	const tasksVersion = entries.filter((e) => e.kind === "event:tasks_planned" || e.kind === "event:tasks_amended").length;
	return StateProjection.parse({
		schema_version: 2,
		session_id: state.session_id,
		session_label: sessionLabel,
		workspace,
		loaf_version_required: loafVersionRequired,
		phase: state.phase,
		sub_state: state.sub_state,
		iteration: state.iteration,
		spec_locked: state.spec_locked,
		verify_accepted: state.verify_accepted,
		pending: composePendingJson(entries).pending.filter((p) => !p.resolved).map(({ resolved: _resolved, ...queue }) => queue),
		ceremony: state.ceremony,
		ceremony_label: ceremonyLabel,
		complexity_score: null,
		based_on: {
			spec: snapshot.tasks_based_on?.spec ?? 0,
			tasks: tasksVersion
		},
		spec_version: state.spec_version,
		created_at: startEntry.at,
		updated_at: lastEntry.at
	});
}
/**
* Compose `snapshots/tasks.json` from a replayed snapshot + journal entries.
*
* Returns `null` when no task plan has landed (`snapshot.tasks_based_on`
* null): `TasksJson.based_on.spec` is `.positive()` and unsatisfiable
* without a plan, so the file is SKIPPED, never written empty.
*
* `version` counts the whole-replacement task-plan contract's entries —
* every `event:tasks_planned` + `event:tasks_amended` on the journal.
*
* Each task body is recovered via `latestCanonicalTaskBody` (the slim
* `Snapshot.tasks` drops canonical fields) and then has the live runtime
* status/applicability overlaid via `materializeTaskForAmend`. A snapshot
* task with NO canonical journal body is projection corruption — this
* THROWS rather than inventing a body.
*
* The composed object is validated against `TasksJson` before return
* (defense-in-depth against a future reducer drift — mirrors
* spec-projection.ts's `SpecFrontmatter.parse`).
*/
function composeTasksJson(snapshot, entries) {
	if (snapshot.tasks_based_on === null) return null;
	const version = entries.filter((e) => e.kind === "event:tasks_planned" || e.kind === "event:tasks_amended").length;
	const tasks = snapshot.tasks.map((t) => {
		const body = latestCanonicalTaskBody(entries, t.id);
		if (body === void 0) throw new Error(`composeTasksJson: task ${t.id} is in the snapshot projection but has no canonical journal body — projection corruption (a rebuild must not invent a body)`);
		return materializeTaskForAmend(body, t);
	});
	return TasksJson.parse({
		schema_version: 2,
		version,
		based_on: { spec: snapshot.tasks_based_on.spec },
		tasks
	});
}
/**
* Compose `snapshots/evidence.json` from journal entries.
*
* Each `evidence:added` payload is re-parsed through the refined
* `EvidenceFullPayload`, re-asserting the manual/waiver actor+reason and
* visual-review attachment cross-field invariants: `replayJournal`
* validates only the journal envelope, not `PER_KIND_PAYLOAD`, so a
* `--rebuild` must not launder a refine-violating payload into a fresh
* projection (codex r158). The two envelope-owned fields the payload
* schema omits — `schema_version` + `at` — are re-attached, journal order
* preserved. Validated against `EvidenceJson` before return.
*/
function composeEvidenceJson(entries) {
	const evidence = entries.filter((e) => e.kind === "evidence:added").map((e) => ({
		...EvidenceFullPayload.parse(e.payload),
		schema_version: 2,
		at: e.at
	}));
	return EvidenceJson.parse({
		schema_version: 2,
		evidence
	});
}
/**
* Compose `snapshots/findings.json` from a replayed snapshot.
*
* The slim `FindingState[]` IS the projection shape — the reducer already
* projects every reader-relevant field (id / category / action / status +
* payload-derived summary / reason / target). NOT the legacy §17
* `FindingsEvent` jsonl event schema. Validated against `FindingsJson`.
*/
function composeFindingsJson(snapshot) {
	return FindingsJson.parse({
		schema_version: 2,
		findings: snapshot.findings
	});
}
/**
* Compose `snapshots/pending.json` from journal entries.
*
* First collects the resolved-id set (every `pending:resolved` payload's
* `id`), then projects each `pending:added` entry in journal order into a
* `PendingProjectionEntry`. The rich `PendingPromptEntry` fields the
* journal payload never carried are collapsed onto journal truth:
*   - `raised_at` + `at` ← the single envelope timestamp
*   - `raised_by`        ← the envelope actor
*   - `blocks`           ← the constant "advance"
*   - `resolved`         ← whether a matching `pending:resolved` exists
*
* Validated against `PendingJson` before return.
*/
function composePendingJson(entries) {
	const resolvedIds = /* @__PURE__ */ new Set();
	for (const e of entries) if (e.kind === "pending:resolved") resolvedIds.add(e.payload.id);
	const pending = [];
	for (const e of entries) {
		if (e.kind !== "pending:added") continue;
		const p = e.payload;
		const item = {
			pending_id: p.id,
			kind: p.kind,
			question: p.question,
			blocks: "advance",
			raised_at: e.at,
			raised_by: e.actor,
			at: e.at,
			resolved: resolvedIds.has(p.id)
		};
		if (p.options !== void 0) item.options = p.options;
		if (p.task_id !== void 0) item.raised_by_task_id = p.task_id;
		pending.push(item);
	}
	return PendingJson.parse({
		schema_version: 2,
		pending
	});
}
/**
* Write a single JSON projection file atomically. Pattern mirrors
* spec-projection.ts `writeDerivedSpecMd` / snapshot.ts `writeMeta`:
*   1. random tmp suffix (avoids collision / TOCTOU surprises)
*   2. write tmp + fsync the tmp file
*   3. rename tmp → final (atomic on same FS)
*   4. best-effort fsync parent dir (durability across power loss)
*/
async function writeJsonAtomic(filePath, value, fsync) {
	const body = JSON.stringify(value, null, 2);
	const tmp = `${filePath}.tmp-${randomBytes(6).toString("hex")}`;
	await fs.writeFile(tmp, body, { mode: 420 });
	if (fsync) {
		const fh = await fs.open(tmp, "r+");
		try {
			await fh.sync();
		} finally {
			await fh.close();
		}
	}
	await fs.rename(tmp, filePath);
	if (fsync) try {
		const dh = await fs.open(path$1.dirname(filePath), "r");
		try {
			await dh.sync();
		} finally {
			await dh.close();
		}
	} catch {}
}
/**
* Re-serialize the five journal-derived projection files plus `_meta.json`
* under `<featureDir>/snapshots/`.
*
* Each data file is written atomically; `_meta.json` is written LAST (via
* `writeMeta`) so a reader can never observe a fresh `_meta` pointing at
* stale projections — metadata strictly after data.
*
* `state.json` / `tasks.json` are written only when their content exists
* (`composeStateProjection` / `composeTasksJson` non-null) — an empty
* journal has no session, a planless journal has no task graph; with
* neither present the file is removed, so a `--rebuild` never leaves a
* stale projection behind.
*
* Does NOT acquire the per-feature lock — the caller (`loaf doctor
* --rebuild`, SC2) drives this from within its own critical section.
*
* Returns the basenames of the files present after the rebuild, in write
* order — `state.json` first (skipped only for an empty journal), then
* `tasks.json` when a plan existed, then evidence / findings / pending /
* `_meta.json`. The `loaf doctor --rebuild` CLI surfaces this as its
* `rebuilt` list, so it never claims a file it did not write.
*/
async function writeProjections(featureDir, input) {
	const { snapshot, entries, meta } = input;
	const fsync = input.fsync ?? true;
	const snapshotsDir = path$1.join(featureDir, "snapshots");
	await fs.mkdir(snapshotsDir, { recursive: true });
	const written = [];
	const statePath = path$1.join(snapshotsDir, "state.json");
	const stateJson = composeStateProjection(snapshot, entries);
	if (stateJson !== null) {
		await writeJsonAtomic(statePath, stateJson, fsync);
		written.push("state.json");
	} else await fs.rm(statePath, { force: true });
	const tasksPath = path$1.join(snapshotsDir, "tasks.json");
	const tasksJson = composeTasksJson(snapshot, entries);
	if (tasksJson !== null) {
		await writeJsonAtomic(tasksPath, tasksJson, fsync);
		written.push("tasks.json");
	} else await fs.rm(tasksPath, { force: true });
	await writeJsonAtomic(path$1.join(snapshotsDir, "evidence.json"), composeEvidenceJson(entries), fsync);
	written.push("evidence.json");
	await writeJsonAtomic(path$1.join(snapshotsDir, "findings.json"), composeFindingsJson(snapshot), fsync);
	written.push("findings.json");
	await writeJsonAtomic(path$1.join(snapshotsDir, "pending.json"), composePendingJson(entries), fsync);
	written.push("pending.json");
	await writeMeta(path$1.join(snapshotsDir, "_meta.json"), meta, fsync);
	written.push("_meta.json");
	return written;
}
//#endregion
//#region src/core/sidecar.ts
const ATTACHMENTS_SUBDIR = "attachments";
/**
* Walk entry.payload (one level deep) looking for LongTextField inline values.
* Any inline field whose text length > threshold is promoted to sidecar form
* with an atomic write+rename. Returns a new entry with promoted refs.
*
* `attachmentRoot` is the parent of the per-entry attachments directory — e.g.
* `.loaf/<feature>/`. The actual files land at
* `<attachmentRoot>/attachments/<entry_id>/<field>.txt`.
*/
async function promoteSidecars(entry, attachmentRoot, opts = {}) {
	const threshold = opts.threshold_bytes ?? 8192;
	const fsync = opts.fsync ?? true;
	const payload = entry.payload;
	if (typeof payload !== "object" || payload === null) return entry;
	const promotedPayload = { ...payload };
	let mutated = false;
	for (const [fieldName, value] of Object.entries(payload)) {
		if (!isLongTextFieldShape(value)) continue;
		const parsed = LongTextField.safeParse(value);
		if (!parsed.success) continue;
		const field = parsed.data;
		if (field.mode === "sidecar") continue;
		const inlineBytes = Buffer.byteLength(field.text, "utf8");
		if (inlineBytes <= threshold) continue;
		const entryDir = path.join(attachmentRoot, ATTACHMENTS_SUBDIR, entry.entry_id);
		await promises.mkdir(entryDir, { recursive: true });
		const finalRel = `${ATTACHMENTS_SUBDIR}/${entry.entry_id}/${fieldName}.txt`;
		const finalAbs = path.join(attachmentRoot, finalRel);
		const tmpAbs = `${finalAbs}.tmp-${randomBytes(6).toString("hex")}`;
		await promises.writeFile(tmpAbs, field.text, { mode: 420 });
		if (fsync) {
			const fh = await promises.open(tmpAbs, "r+");
			try {
				await fh.sync();
			} finally {
				await fh.close();
			}
		}
		await promises.rename(tmpAbs, finalAbs);
		promotedPayload[fieldName] = {
			mode: "sidecar",
			ref: {
				path: finalRel,
				sha256: createHash("sha256").update(field.text, "utf8").digest("hex"),
				size: inlineBytes
			}
		};
		mutated = true;
	}
	if (!mutated) return entry;
	return {
		...entry,
		payload: promotedPayload
	};
}
function isLongTextFieldShape(v) {
	if (typeof v !== "object" || v === null) return false;
	const obj = v;
	return obj["mode"] === "inline" || obj["mode"] === "sidecar";
}
//#endregion
//#region src/core/spec-projection.ts
/**
* Composes the spec.md content (frontmatter + preserved body) from a
* snapshot. Pure: no IO. Validates the composed frontmatter against
* SpecFrontmatter zod BEFORE stringify (codex r90 strict gate — catches
* snapshot drift from a future reducer change).
*
* Throws when `snapshot.spec_header` or `snapshot.state` is null. Callers
* must check those preconditions OR scope this call to a batch known to
* contain a spec-emitting kind. The Pass 5 wire in journal-mutate scopes
* by SPEC_EMITTING_KINDS, so an unexpected null here signals projection
* corruption and gets surfaced as PROJECTION_WRITE_FAILED.
*/
function composeSpecMdFrontmatter(snapshot, existingBody = "") {
	if (snapshot.state === null) throw new Error("composeSpecMdFrontmatter: snapshot.state is null (no session) — cannot project spec.md without spec_version");
	if (snapshot.spec_header === null) throw new Error("composeSpecMdFrontmatter: snapshot.spec_header is null — invariant violation, spec-emitting batch reached projection writer without populated header");
	const fm = {
		schema_version: 2,
		spec_version: snapshot.state.spec_version,
		feature: snapshot.spec_header.feature,
		intent: snapshot.spec_header.intent,
		adr_refs: snapshot.spec_header.adr_refs,
		requirements: snapshot.requirements,
		scenarios: snapshot.scenarios,
		visual_contracts: snapshot.visual_contracts,
		needs_clarification: snapshot.spec_header.needs_clarification
	};
	SpecFrontmatter.parse(fm);
	return `---\n${stringify(fm)}---\n${existingBody}`;
}
/**
* Writes the derived spec.md to disk atomically. Pattern mirrors
* snapshot.writeMeta:70-89 / codex r84 Q3:
*   1. random tmp suffix (avoids collision / TOCTOU surprises)
*   2. write tmp + fsync the tmp file
*   3. rename tmp → final (atomic on same FS)
*   4. best-effort fsync parent dir (durability across power loss)
*
* Preserves the existing markdown body (everything after the closing
* `---\n` of the prior frontmatter) verbatim. User-owned content;
* SC-A2 does not interpret, strip, or warn.
*
* Invariant guarantee (codex r90 Q7): final spec.md is absent or
* unchanged on failure, never partially replaced. Tmp file residue
* after mid-write failure is acceptable under the existing
* crash/doctor model; callers should not assert "no tmp leftover".
*
* Does NOT acquire the per-feature lock. Callers must invoke from
* within the outer mutateBatch critical section (MVP single-writer
* assumption — see TODO at journal-mutate.ts Pass 5).
*/
async function writeDerivedSpecMd(snapshot, featureDir) {
	const specPath = path$1.join(featureDir, "spec.md");
	let existingBody = "";
	try {
		existingBody = splitFrontmatter(await fs.readFile(specPath, "utf8")).body;
	} catch (err) {
		if (err.code !== "ENOENT") throw err;
	}
	const content = composeSpecMdFrontmatter(snapshot, existingBody);
	const tmp = `${specPath}.tmp-${randomBytes(6).toString("hex")}`;
	await fs.writeFile(tmp, content, { mode: 420 });
	let fh = await fs.open(tmp, "r+");
	try {
		await fh.sync();
	} finally {
		await fh.close();
	}
	await fs.rename(tmp, specPath);
	try {
		fh = await fs.open(path$1.dirname(specPath), "r");
		try {
			await fh.sync();
		} finally {
			await fh.close();
		}
	} catch {}
}
//#endregion
//#region src/core/journal-mutate.ts
const SPEC_EMITTING_KINDS = new Set([
	"event:spec_submitted",
	"event:spec_req_added",
	"event:spec_scenario_added",
	"event:spec_visual_added"
]);
async function mutateBatch(partials, ctx) {
	if (partials.length === 0) return {
		ok: false,
		code: "INVALID_BATCH",
		message: "mutateBatch called with empty partials array; pass at least one entry",
		detail: { partials_length: 0 }
	};
	const FORBIDDEN = [
		"seq",
		"entry_id",
		"batch_id",
		"batch_index",
		"batch_count"
	];
	for (let i = 0; i < partials.length; i++) {
		const partial = partials[i];
		for (const f of FORBIDDEN) if (f in partial) return {
			ok: false,
			code: "INVALID_BATCH",
			message: `partial at index ${i} contains forbidden field '${f}'; mutateBatch owns seq/entry_id/batch envelope`,
			failed_index: i,
			detail: {
				forbidden_field: f,
				index: i
			}
		};
	}
	const isBatch = partials.length >= 2;
	const batchId = isBatch ? crypto.randomUUID() : void 0;
	let snapshotAcc = structuredClone(ctx.snapshot);
	const candidates = [];
	for (let i = 0; i < partials.length; i++) {
		const partial = partials[i];
		const seq = ctx.tail_seq + 1 + i;
		const entry_id = `JE-${String(seq + 1).padStart(6, "0")}`;
		const candidate = isBatch ? {
			...partial,
			seq,
			entry_id,
			batch_id: batchId,
			batch_index: i,
			batch_count: partials.length
		} : {
			...partial,
			seq,
			entry_id
		};
		const pre = preflight(candidate, {
			snapshot: snapshotAcc,
			tail_seq: ctx.tail_seq + i
		});
		if (!pre.ok) return {
			ok: false,
			code: pre.code,
			message: pre.message,
			failed_index: i,
			detail: pre.detail ?? {}
		};
		if (!REDUCER_IMPLEMENTED_KINDS.has(candidate.kind)) return {
			ok: false,
			code: "REDUCER_ERROR",
			message: `reducer has no handler for kind=${candidate.kind}; refusing to append (would orphan a journal entry)`,
			failed_index: i,
			detail: { kind: candidate.kind }
		};
		const dryRun = apply(snapshotAcc, candidate);
		if (!dryRun.ok) return {
			ok: false,
			code: "REDUCER_ERROR",
			message: dryRun.message,
			failed_index: i,
			detail: {
				code: dryRun.code,
				...dryRun.detail ?? {}
			}
		};
		snapshotAcc = dryRun.snapshot;
		candidates.push(candidate);
	}
	const gateApprovals = candidates.filter((c) => c.kind === "gate:decided" && c.payload.decision === "approved");
	if (gateApprovals.length > 1) return {
		ok: false,
		code: "MULTIPLE_GATE_DECISIONS",
		message: `batch contains ${gateApprovals.length} approved gate:decided entries; protocol §10.8 requires one gate decision per atomic operation`,
		detail: {
			count: gateApprovals.length,
			gate_kinds: gateApprovals.map((c) => c.payload.gate_kind)
		}
	};
	if (gateApprovals.length === 1) {
		const gateKind = gateApprovals[0].payload.gate_kind;
		if (gateKind === "spec-lock") {
			const gateResult = await evaluateSpecLock(ctx.snapshot, ctx.feature_dir);
			if (!gateResult.ok) return {
				ok: false,
				code: "GATE_PRECONDITION_VIOLATION",
				message: `gate:decided spec-lock approval failed ${gateResult.checks.length} spec-lock check(s); see detail.checks`,
				detail: {
					gate: "spec-lock",
					failure_count: gateResult.checks.length,
					checks: gateResult.checks
				}
			};
		} else if (gateKind === "verify-accept") {
			const gateResult = await evaluateVerifyAccept(ctx.snapshot, ctx.feature_dir);
			if (!gateResult.ok) return {
				ok: false,
				code: "GATE_PRECONDITION_VIOLATION",
				message: `gate:decided verify-accept approval failed ${gateResult.checks.length} verify-accept check(s); see detail.checks`,
				detail: {
					gate: "verify-accept",
					failure_count: gateResult.checks.length,
					checks: gateResult.checks
				}
			};
		}
	}
	const promoted = [];
	for (let i = 0; i < candidates.length; i++) try {
		const p = await promoteSidecars(candidates[i], ctx.feature_dir, { fsync: ctx.fsync ?? true });
		promoted.push(p);
	} catch (err) {
		return {
			ok: false,
			code: "SIDECAR_ERROR",
			message: `sidecar finalize failed: ${String(err)}`,
			failed_index: i,
			detail: { err: String(err) }
		};
	}
	let finalSnapshot = structuredClone(ctx.snapshot);
	for (let i = 0; i < promoted.length; i++) {
		const dryRun = apply(finalSnapshot, promoted[i]);
		if (!dryRun.ok) return {
			ok: false,
			code: "REDUCER_ERROR",
			message: `final dry-run on promoted entries failed at index ${i}: ${dryRun.message}`,
			failed_index: i,
			detail: {
				code: dryRun.code,
				phase: "post-sidecar",
				...dryRun.detail ?? {}
			}
		};
		finalSnapshot = dryRun.snapshot;
	}
	if (JSON.stringify(finalSnapshot) !== JSON.stringify(snapshotAcc)) return {
		ok: false,
		code: "REDUCER_ERROR",
		message: "snapshot drift between unpromoted and promoted dry-runs — a reducer is reading LongTextField content; the batch is unsafe to append",
		detail: { phase: "drift-check" }
	};
	const ctxEntriesTailSeq = ctx.entries[ctx.entries.length - 1]?.seq ?? -1;
	const emptyPrefixMetaBad = ctx.tail_seq === -1 && !isEmptyMeta(ctx.meta);
	if (ctxEntriesTailSeq !== ctx.tail_seq || ctx.meta.last_applied_seq !== ctx.tail_seq || emptyPrefixMetaBad) return {
		ok: false,
		code: "INVALID_BATCH",
		message: `MutateContext is internally inconsistent: tail_seq=${ctx.tail_seq} but entries tail seq=${ctxEntriesTailSeq}, meta.last_applied_seq=${ctx.meta.last_applied_seq}` + (emptyPrefixMetaBad ? ", and meta is not the empty sentinel for an empty prefix" : "") + `; entries + meta must describe the same journal prefix as tail_seq`,
		detail: {
			tail_seq: ctx.tail_seq,
			entries_tail_seq: ctxEntriesTailSeq,
			meta_last_applied_seq: ctx.meta.last_applied_seq,
			empty_prefix_meta_bad: emptyPrefixMetaBad
		}
	};
	const journalPath = path.join(ctx.feature_dir, "journal.jsonl");
	let appendMeta;
	try {
		appendMeta = await appendMany(journalPath, promoted, ctx.meta, { fsync: ctx.fsync ?? true });
	} catch (err) {
		if (err instanceof AppendError) return {
			ok: false,
			code: "APPEND_ERROR",
			message: err.message,
			detail: {
				code: err.code,
				...err.detail ?? {}
			}
		};
		return {
			ok: false,
			code: "APPEND_ERROR",
			message: `append failed: ${String(err)}`,
			detail: { err: String(err) }
		};
	}
	if (promoted.some((entry) => SPEC_EMITTING_KINDS.has(entry.kind))) try {
		await writeDerivedSpecMd(finalSnapshot, ctx.feature_dir);
	} catch (err) {
		const lastSeq = promoted[promoted.length - 1].seq;
		return {
			ok: false,
			code: "PROJECTION_WRITE_FAILED",
			message: `spec.md projection write failed after journal append at last_seq=${lastSeq} (spec_version=${finalSnapshot.state?.spec_version ?? "unknown"}); journal is authoritative — run 'loaf doctor --rebuild' to resync. Cause: ${err.message}`,
			detail: {
				projection: "spec.md",
				path: path.join(ctx.feature_dir, "spec.md"),
				journal_appended: true,
				last_seq: lastSeq,
				spec_version: finalSnapshot.state?.spec_version ?? null,
				error: err.message
			}
		};
	}
	try {
		await writeProjections(ctx.feature_dir, {
			snapshot: finalSnapshot,
			entries: ctx.entries.concat(promoted),
			meta: appendMeta,
			fsync: ctx.fsync ?? true
		});
	} catch (err) {
		const lastSeq = promoted[promoted.length - 1].seq;
		return {
			ok: false,
			code: "PROJECTION_WRITE_FAILED",
			message: `snapshot projection write failed after journal append at last_seq=${lastSeq}; journal is authoritative — run 'loaf doctor --rebuild' to resync. Cause: ${err.message}`,
			detail: {
				projection: "snapshots",
				path: path.join(ctx.feature_dir, "snapshots"),
				journal_appended: true,
				last_seq: lastSeq,
				error: err.message
			}
		};
	}
	return {
		ok: true,
		snapshot: finalSnapshot,
		entries: promoted,
		meta: appendMeta
	};
}
/**
* Single-entry shorthand for `mutateBatch([partial], ctx)`. Returns the
* single produced entry under the `entry` key for API compatibility with
* callers that always emit one entry.
*/
async function mutate(partial, ctx) {
	const batch = await mutateBatch([partial], ctx);
	if (!batch.ok) return batch.detail !== void 0 ? {
		ok: false,
		code: batch.code,
		message: batch.message,
		detail: batch.detail
	} : {
		ok: false,
		code: batch.code,
		message: batch.message
	};
	return {
		ok: true,
		snapshot: batch.snapshot,
		entry: batch.entries[0],
		meta: batch.meta
	};
}
//#endregion
//#region src/core/snapshot-reader.ts
/**
* Verify that the given SnapshotMeta agrees with the on-disk journal tail.
* Caller (CLI command consuming snapshots) treats `fresh: false` as exit 2
* SNAPSHOT_STALE_REBUILD_REQUIRED; no silent fallback to cached snapshot.
*/
async function checkSnapshotFresh(meta, journalPath) {
	let stat;
	try {
		stat = await promises.stat(journalPath);
	} catch (err) {
		if (err.code === "ENOENT") return {
			fresh: false,
			code: "SNAPSHOT_STALE_REBUILD_REQUIRED",
			reason: "journal_missing",
			detail: { journal_path: journalPath }
		};
		throw err;
	}
	if (stat.size === 0) {
		if (meta.last_applied_seq === -1) return {
			fresh: true,
			last_applied_seq: -1
		};
		return {
			fresh: false,
			code: "SNAPSHOT_STALE_REBUILD_REQUIRED",
			reason: "journal_empty",
			detail: { meta_last_applied_seq: meta.last_applied_seq }
		};
	}
	const tailRead = Math.min(stat.size, ENTRY_BYTE_LIMIT);
	const fh = await promises.open(journalPath, "r");
	try {
		const buf = Buffer.alloc(tailRead);
		await fh.read(buf, 0, tailRead, stat.size - tailRead);
		const trailingText = buf.toString("utf8");
		if (!trailingText.endsWith("\n")) return {
			fresh: false,
			code: "SNAPSHOT_STALE_REBUILD_REQUIRED",
			reason: "trailing_partial_line",
			detail: { tail_bytes: trailingText.length }
		};
		const withoutTrailingNl = trailingText.slice(0, -1);
		const lastNl = withoutTrailingNl.lastIndexOf("\n");
		const tailLine = lastNl === -1 ? withoutTrailingNl : withoutTrailingNl.slice(lastNl + 1);
		const tailLineBytes = Buffer.byteLength(tailLine + "\n", "utf8");
		const tailLineOffset = stat.size - tailLineBytes;
		if (tailLineOffset !== meta.last_entry_offset) return {
			fresh: false,
			code: "SNAPSHOT_STALE_REBUILD_REQUIRED",
			reason: "tail_offset_mismatch",
			detail: {
				journal_tail_offset: tailLineOffset,
				meta_last_entry_offset: meta.last_entry_offset
			}
		};
		const actualHash = computeLineHash(tailLine);
		if (actualHash !== meta.last_entry_line_hash) return {
			fresh: false,
			code: "SNAPSHOT_STALE_REBUILD_REQUIRED",
			reason: "tail_hash_mismatch",
			detail: {
				actual: actualHash,
				expected: meta.last_entry_line_hash
			}
		};
		return {
			fresh: true,
			last_applied_seq: meta.last_applied_seq
		};
	} finally {
		await fh.close();
	}
}
//#endregion
//#region src/core/projection-loader.ts
var SnapshotStaleError = class extends Error {
	code = "SNAPSHOT_STALE_REBUILD_REQUIRED";
	reason;
	detail;
	constructor(reason, detail) {
		super(`${reason}: ${JSON.stringify(detail)}`);
		this.name = "SnapshotStaleError";
		this.reason = reason;
		this.detail = {
			reason,
			...detail
		};
	}
};
var NoSessionError = class extends Error {
	code = "NO_SESSION";
	detail;
	constructor(detail) {
		super(`NO_SESSION: ${JSON.stringify(detail)}`);
		this.name = "NoSessionError";
		this.detail = detail;
	}
};
const LEAF_SCHEMA = {
	state: StateProjection,
	tasks: TasksJson,
	evidence: EvidenceJson,
	findings: FindingsJson,
	pending: PendingJson
};
function fixForFeatureDir(featureDir) {
	return `run \`loaf doctor --rebuild --feature ${path.basename(featureDir)}\``;
}
/**
* Read + parse `snapshots/_meta.json`. Classifies meta-level failures
* upstream of `checkSnapshotFresh` so a malformed-empty-sentinel meta
* (`seq=-1` with non-empty offset/hash/checksum — runtime SnapshotMeta
* refine, codex r175) becomes `meta_invalid cause=schema`, never
* silent NO_SESSION.
*/
async function readMetaOrThrow(metaPath, featureDir) {
	let raw;
	try {
		raw = await promises.readFile(metaPath, "utf8");
	} catch (err) {
		if (err.code === "ENOENT") return { missing: true };
		throw err;
	}
	let parsed;
	try {
		parsed = JSON.parse(raw);
	} catch {
		throw new SnapshotStaleError("meta_invalid", {
			feature_dir: featureDir,
			fix: fixForFeatureDir(featureDir),
			meta_path: metaPath,
			cause: "json_parse"
		});
	}
	const result = SnapshotMeta.safeParse(parsed);
	if (!result.success) throw new SnapshotStaleError("meta_invalid", {
		feature_dir: featureDir,
		fix: fixForFeatureDir(featureDir),
		meta_path: metaPath,
		cause: "schema"
	});
	return result.data;
}
/**
* Translate `checkSnapshotFresh` result to a SnapshotStaleError carrying
* the loader's full detail envelope (feature_dir + fix + reader detail).
*/
function staleFromReader(result, featureDir) {
	if (result.fresh) return null;
	return new SnapshotStaleError(result.reason, {
		feature_dir: featureDir,
		fix: fixForFeatureDir(featureDir),
		...result.detail
	});
}
/**
* Read + parse one projection leaf. ENOENT → projection_missing. JSON
* parse fail → projection_invalid cause=json_parse. Schema fail →
* projection_invalid cause=schema.
*/
async function readLeafOrThrow(kind, snapshotsDir, featureDir) {
	const leafPath = path.join(snapshotsDir, `${kind}.json`);
	let raw;
	try {
		raw = await promises.readFile(leafPath, "utf8");
	} catch (err) {
		if (err.code === "ENOENT") throw new SnapshotStaleError("projection_missing", {
			feature_dir: featureDir,
			fix: fixForFeatureDir(featureDir),
			projection_kind: kind,
			projection_path: leafPath
		});
		throw err;
	}
	let parsed;
	try {
		parsed = JSON.parse(raw);
	} catch {
		throw new SnapshotStaleError("projection_invalid", {
			feature_dir: featureDir,
			fix: fixForFeatureDir(featureDir),
			projection_kind: kind,
			projection_path: leafPath,
			cause: "json_parse"
		});
	}
	const result = LEAF_SCHEMA[kind].safeParse(parsed);
	if (!result.success) throw new SnapshotStaleError("projection_invalid", {
		feature_dir: featureDir,
		fix: fixForFeatureDir(featureDir),
		projection_kind: kind,
		projection_path: leafPath,
		cause: "schema"
	});
	return result.data;
}
async function journalIsEmptyOrMissing(journalPath) {
	try {
		return (await promises.stat(journalPath)).size === 0;
	} catch (err) {
		if (err.code === "ENOENT") return true;
		throw err;
	}
}
/**
* Public canonical loader — no hooks, used by production callers.
* See `loadProjectionsWithHooks` for the test-only seam.
*/
async function loadProjections(input) {
	return _loadProjectionsImpl(input);
}
async function _loadProjectionsImpl(input, hooks) {
	const { feature_dir: featureDir, kinds } = input;
	const snapshotsDir = path.join(featureDir, "snapshots");
	const metaPath = path.join(snapshotsDir, "_meta.json");
	const journalPath = path.join(featureDir, "journal.jsonl");
	const metaResult = await readMetaOrThrow(metaPath, featureDir);
	if ("missing" in metaResult) {
		if (await journalIsEmptyOrMissing(journalPath)) throw new NoSessionError({
			feature_dir: featureDir,
			fix: `run \`loaf start <feature>\` first`
		});
		throw new SnapshotStaleError("meta_missing", {
			feature_dir: featureDir,
			fix: fixForFeatureDir(featureDir),
			meta_path: metaPath
		});
	}
	const M0 = metaResult;
	if (isEmptyMeta(M0)) {
		if (await journalIsEmptyOrMissing(journalPath)) throw new NoSessionError({
			feature_dir: featureDir,
			fix: `run \`loaf start <feature>\` first`
		});
	}
	const stale1 = staleFromReader(await checkSnapshotFresh(M0, journalPath), featureDir);
	if (stale1) throw stale1;
	if (hooks?.afterFirstFastCheck) await hooks.afterFirstFastCheck();
	const kindsList = kinds;
	const needsTasks = kindsList.includes("tasks");
	const needsState = kindsList.includes("state");
	let stateImplicit;
	if (needsTasks && !needsState) stateImplicit = await readLeafOrThrow("state", snapshotsDir, featureDir);
	const result = {};
	for (const kind of kindsList) if (kind === "tasks") try {
		result.tasks = await readLeafOrThrow("tasks", snapshotsDir, featureDir);
	} catch (err) {
		if (err instanceof SnapshotStaleError && err.reason === "projection_missing") {
			if ((result.state ?? stateImplicit ?? await readLeafOrThrow("state", snapshotsDir, featureDir)).based_on.tasks === 0) {
				result.tasks = null;
				continue;
			}
		}
		throw err;
	}
	else result[kind] = await readLeafOrThrow(kind, snapshotsDir, featureDir);
	const stale2 = staleFromReader(await checkSnapshotFresh(M0, journalPath), featureDir);
	if (stale2) throw stale2;
	result.meta = M0;
	return result;
}
//#endregion
//#region src/cli.tsx
const PRESETS = {
	quick: {
		spec_phase: false,
		verify_phase: false,
		settle_phase: false,
		strict_spec_review: false,
		lessons_required: "skip",
		strict_drift_check: false
	},
	light: {
		spec_phase: true,
		verify_phase: false,
		settle_phase: false,
		strict_spec_review: false,
		lessons_required: "skip",
		strict_drift_check: false
	},
	standard: {
		spec_phase: true,
		verify_phase: true,
		settle_phase: false,
		strict_spec_review: false,
		lessons_required: "skip",
		strict_drift_check: false
	},
	deep: {
		spec_phase: true,
		verify_phase: true,
		settle_phase: true,
		strict_spec_review: true,
		lessons_required: "must",
		strict_drift_check: true
	}
};
let _sigintInstalled = false;
function installSigintHandler(deps) {
	const handler = () => {
		deps.writeStderr("\nloaf: interrupted (SIGINT)\n");
		deps.exit(130);
	};
	if (_sigintInstalled) return handler;
	_sigintInstalled = true;
	process.on("SIGINT", handler);
	return handler;
}
async function main(argv = process.argv, deps = {}) {
	if (!argv.some((a) => a === "--help" || a === "-h" || a === "--version" || a === "-V")) {
		const presentation = parsePresentation(argv);
		if (!presentation.ok) {
			if (presentation.kind === "INVALID_FORMAT") process.stderr.write(`error: INVALID_FORMAT — invalid --format value '${presentation.rawValue}'; allowed: ${FORMAT_MODES_HUMAN}\n`);
			else {
				const { conflicting, renderAsJson } = presentation;
				const message = `mutually exclusive flags in the same invocation: ${conflicting.join(", ")}`;
				if (renderAsJson) process.stderr.write(JSON.stringify({
					ok: false,
					code: "MUTUALLY_EXCLUSIVE_FLAGS",
					message,
					detail: { conflicting }
				}) + "\n");
				else process.stderr.write(`error: MUTUALLY_EXCLUSIVE_FLAGS — ${message}\n`);
			}
			return 2;
		}
	}
	const readStdin = deps.readStdin ?? defaultReadStdin;
	const isStdinTty = deps.isStdinTty ?? defaultIsStdinTty;
	const program = new Command();
	program.name("loaf").description("Spec-driven development protocol CLI").version(version).option("--format <fmt>", `Output format: ${FORMAT_MODES_HUMAN} (default: text)`).option("--plain", "Alias for --format text (mechanism live; presentation migration in SC-5b2)").option("--no-color", "Disable color where implemented (reserved; no color output in v0.1)").option("-q, --quiet", "Suppress advisory stderr where implemented (SC-5b1: loaf start only)").option("-v, --verbose", "Increase advisory detail where implemented (reserved until SC-5b2)", (_value, prior) => (prior ?? 0) + 1, 0).addHelpText("after", helpFooter()).showHelpAfterError().exitOverride();
	const actor = `cli:loaf@${process.env["USER"] ?? "unknown"}`;
	const ctx = createCommandContext(argv, {
		writeStdout: (s) => process.stdout.write(s),
		writeStderr: (s) => process.stderr.write(s),
		loadSession,
		loadProjections
	});
	const useJson = ctx.output === "json";
	const fail = (code, message) => {
		ctx.failure(code, message);
	};
	const emitFailure = (code, message, detail) => {
		ctx.failure(code, message, detail);
	};
	const loadProjectionsOrFail = async (featureDir, kinds, feature) => {
		try {
			return await loadProjections({
				feature_dir: featureDir,
				kinds
			});
		} catch (err) {
			if (err instanceof NoSessionError) {
				emitFailure("NO_SESSION", `run \`loaf start ${feature}\` first`, err.detail);
				return null;
			}
			if (err instanceof SnapshotStaleError) {
				emitFailure(err.code, `snapshot stale (reason=${err.reason}) — run \`loaf doctor --rebuild --feature ${feature}\` to re-serialize from journal truth`, err.detail);
				return null;
			}
			throw err;
		}
	};
	program.command("start <feature>").description("Start a new feature session (emits session:started)").option("--ceremony <preset>", "Preset label: quick / light / standard / deep", "standard").option("--label <text>", "Human-readable session label (≥3 chars)").option("--workspace <name>", "Workspace name (multi-worktree display)", "default").option("--feature-dir <path>", "Override default .loaf/<feature> directory").action(async (feature, opts) => {
		const ceremony = PRESETS[opts.ceremony];
		if (!ceremony) {
			fail("INVALID_PRESET", `unknown ceremony preset "${opts.ceremony}" — known: ${Object.keys(PRESETS).join(", ")}`);
			return;
		}
		if (opts.label !== void 0 && opts.label.length < 3) {
			fail("USAGE", "--label must be at least 3 characters");
			return;
		}
		if (opts.workspace.length < 1) {
			fail("USAGE", "--workspace must not be empty");
			return;
		}
		const featureDir = opts.featureDir ?? defaultFeatureDir(feature);
		const session = await loadSession(featureDir);
		const sessionId = crypto.randomUUID();
		const result = await mutate({
			at: (/* @__PURE__ */ new Date()).toISOString(),
			actor,
			entry_schema_version: 1,
			kind: "session:started",
			payload: {
				session_id: sessionId,
				feature,
				ceremony,
				ceremony_label: opts.ceremony,
				workspace: opts.workspace,
				loaf_version_required: `^${version}`,
				...opts.label !== void 0 ? { session_label: opts.label } : {}
			}
		}, {
			feature_dir: featureDir,
			snapshot: session.snapshot,
			tail_seq: session.tail_seq,
			entries: session.entries,
			meta: session.meta
		});
		if (!result.ok) {
			fail(result.code, result.message);
			return;
		}
		const out = {
			ok: true,
			feature,
			session_id: sessionId,
			ceremony_label: opts.ceremony,
			workspace: opts.workspace,
			feature_dir: featureDir,
			sub_state: result.snapshot.state?.sub_state
		};
		ctx.success(out, () => `${sessionId}\n`, {
			stateChange: `start: '${feature}' created → TRIAGE.score`,
			next: "loaf advance"
		});
	});
	program.command("advance <to>").description("Advance the session cursor (emits event:phase_advanced)").requiredOption("--feature <name>", "Feature whose session to advance").option("--feature-dir <path>", "Override default .loaf/<feature> directory").action(async (to, opts) => {
		const featureDir = opts.featureDir ?? defaultFeatureDir(opts.feature);
		const session = await loadSession(featureDir);
		const from = session.snapshot.state?.sub_state;
		if (!from) {
			fail("NO_SESSION", `run \`loaf start ${opts.feature}\` first`);
			return;
		}
		const result = await mutate({
			at: (/* @__PURE__ */ new Date()).toISOString(),
			actor,
			entry_schema_version: 1,
			kind: "event:phase_advanced",
			payload: {
				from,
				to
			}
		}, {
			feature_dir: featureDir,
			snapshot: session.snapshot,
			tail_seq: session.tail_seq,
			entries: session.entries,
			meta: session.meta
		});
		if (!result.ok) {
			fail(result.code, result.message);
			return;
		}
		const out = {
			ok: true,
			from,
			to,
			sub_state: result.snapshot.state?.sub_state
		};
		process.stdout.write(useJson ? JSON.stringify(out) + "\n" : `advanced ${from} → ${to}\n`);
	});
	program.command("status").description("Show the current session snapshot (read-only)").requiredOption("--feature <name>", "Feature whose status to show").option("--feature-dir <path>", "Override default .loaf/<feature> directory").action(async (opts) => {
		const featureDir = opts.featureDir ?? defaultFeatureDir(opts.feature);
		const loaded = await loadProjectionsOrFail(featureDir, [
			"state",
			"tasks",
			"evidence",
			"findings",
			"pending"
		], opts.feature);
		if (loaded === null) return;
		const { state, tasks, evidence, findings, pending, meta } = loaded;
		const slimState = {
			session_id: state.session_id,
			feature: opts.feature,
			phase: state.phase,
			sub_state: state.sub_state,
			iteration: state.iteration,
			spec_locked: state.spec_locked,
			verify_accepted: state.verify_accepted,
			spec_version: state.spec_version,
			ceremony: state.ceremony
		};
		const out = {
			ok: true,
			feature: opts.feature,
			feature_dir: featureDir,
			tail_seq: meta.last_applied_seq,
			state: slimState,
			tasks_count: tasks ? tasks.tasks.length : 0,
			evidence_count: evidence.evidence.length,
			findings_count: findings.findings.length,
			pending_count: pending.pending.length
		};
		if (useJson) process.stdout.write(JSON.stringify(out) + "\n");
		else process.stdout.write(`feature: ${opts.feature}\nphase:   ${state.phase}.${state.sub_state.split(".")[1]}\ncursor:  ${state.sub_state}\ntail:    seq=${out.tail_seq}\ntasks=${out.tasks_count} evidence=${out.evidence_count} findings=${out.findings_count} pending=${out.pending_count}\n# snapshot as-of seq=${out.tail_seq} (projection-loader, Phase 15 SC3)\n`);
	});
	program.command("gate").description("Gate decision commands (spec-lock + verify-accept)").command("decide <gate-name>").description("Decide a gate (emits gate:decided; spec-lock approve also advances cursor)").option("--approve", "Approve the gate").option("--reject", "Reject the gate").requiredOption("--reason <text>", "Decision rationale (passed through to GateDecidedPayload)").requiredOption("--feature <name>", "Feature whose session to gate").option("--feature-dir <path>", "Override default .loaf/<feature> directory").action(async (gateName, opts) => {
		const approve = opts.approve === true;
		if (approve === (opts.reject === true)) {
			emitFailure("USAGE", "exactly one of --approve | --reject is required");
			return;
		}
		if (gateName !== "spec-lock" && gateName !== "verify-accept") {
			emitFailure("GATE_NOT_IMPLEMENTED", `gate=${gateName} is not recognized; protocol GateName enum is closed at {spec-lock, verify-accept}`, { gate: gateName });
			return;
		}
		const resolution = resolveHumanActor({
			env: process.env,
			readGitConfig: getGitEmail,
			isInteractiveHuman: process.stdin.isTTY === true
		});
		if (!resolution.ok) {
			emitFailure(resolution.code, resolution.message);
			return;
		}
		const humanActor = resolution.actor;
		const featureDir = opts.featureDir ?? defaultFeatureDir(opts.feature);
		const session = await loadSession(featureDir);
		const from = session.snapshot.state?.sub_state;
		if (!from) {
			emitFailure("NO_SESSION", `run \`loaf start ${opts.feature}\` first`);
			return;
		}
		const ctx = {
			feature_dir: featureDir,
			snapshot: session.snapshot,
			tail_seq: session.tail_seq,
			entries: session.entries,
			meta: session.meta
		};
		const now = (/* @__PURE__ */ new Date()).toISOString();
		const pendingHead = session.snapshot.pending.find((p) => !p.resolved);
		const coEmitPendingResolved = approve && pendingHead && pendingHead.kind === "gate_decision";
		if (approve) {
			if (gateName === "spec-lock") {
				const entries = [{
					at: now,
					actor: humanActor,
					entry_schema_version: 1,
					kind: "gate:decided",
					payload: {
						gate_kind: "spec-lock",
						decision: "approved",
						reason: opts.reason
					}
				}];
				if (coEmitPendingResolved && pendingHead) entries.push({
					at: now,
					actor,
					entry_schema_version: 1,
					kind: "pending:resolved",
					payload: {
						id: pendingHead.id,
						answer: "gate-decide:spec-lock:approved"
					}
				});
				entries.push({
					at: now,
					actor,
					entry_schema_version: 1,
					kind: "event:phase_advanced",
					payload: {
						from,
						to: "EXECUTE.plan"
					}
				});
				const result = await mutateBatch(entries, ctx);
				if (!result.ok) {
					emitFailure(result.code, result.message, result.detail);
					return;
				}
				const out = {
					ok: true,
					gate: "spec-lock",
					decision: "approved",
					from,
					to: "EXECUTE.plan",
					actor: humanActor,
					sub_state: result.snapshot.state?.sub_state,
					spec_locked: result.snapshot.state?.spec_locked
				};
				process.stdout.write(useJson ? JSON.stringify(out) + "\n" : `gate spec-lock approved by ${humanActor} — ${from} → EXECUTE.plan\n`);
				return;
			}
			const result = coEmitPendingResolved && pendingHead ? await mutateBatch([{
				at: now,
				actor: humanActor,
				entry_schema_version: 1,
				kind: "gate:decided",
				payload: {
					gate_kind: "verify-accept",
					decision: "approved",
					reason: opts.reason
				}
			}, {
				at: now,
				actor,
				entry_schema_version: 1,
				kind: "pending:resolved",
				payload: {
					id: pendingHead.id,
					answer: "gate-decide:verify-accept:approved"
				}
			}], ctx) : await mutate({
				at: now,
				actor: humanActor,
				entry_schema_version: 1,
				kind: "gate:decided",
				payload: {
					gate_kind: "verify-accept",
					decision: "approved",
					reason: opts.reason
				}
			}, ctx);
			if (!result.ok) {
				emitFailure(result.code, result.message, result.detail);
				return;
			}
			const out = {
				ok: true,
				gate: "verify-accept",
				decision: "approved",
				from,
				actor: humanActor,
				sub_state: result.snapshot.state?.sub_state,
				verify_accepted: result.snapshot.state?.verify_accepted
			};
			process.stdout.write(useJson ? JSON.stringify(out) + "\n" : `gate verify-accept approved by ${humanActor} — verify_accepted=true, cursor stays at ${from} (advance via \`loaf deliver\` / \`loaf settle\`)\n`);
			return;
		}
		const result = await mutate({
			at: now,
			actor: humanActor,
			entry_schema_version: 1,
			kind: "gate:decided",
			payload: {
				gate_kind: gateName,
				decision: "rejected",
				reason: opts.reason
			}
		}, ctx);
		if (!result.ok) {
			emitFailure(result.code, result.message, result.detail);
			return;
		}
		const out = {
			ok: true,
			gate: gateName,
			decision: "rejected",
			from,
			actor: humanActor,
			sub_state: result.snapshot.state?.sub_state,
			spec_locked: result.snapshot.state?.spec_locked,
			verify_accepted: result.snapshot.state?.verify_accepted
		};
		process.stdout.write(useJson ? JSON.stringify(out) + "\n" : `gate ${gateName} rejected by ${humanActor} — cursor stays at ${from}\n`);
	});
	program.command("deliver").description("Deliver the feature session (emits session:delivered → DONE.delivered)").requiredOption("--feature <name>", "Feature whose session to deliver").option("--feature-dir <path>", "Override default .loaf/<feature> directory").option("--reason <text>", "Optional rationale to record on the session:delivered entry").action(async (opts) => {
		const resolution = resolveHumanActor({
			env: process.env,
			readGitConfig: getGitEmail,
			isInteractiveHuman: process.stdin.isTTY === true
		});
		if (!resolution.ok) {
			ctx.failure(resolution.code, resolution.message);
			return;
		}
		const humanActor = resolution.actor;
		const featureDir = opts.featureDir ?? defaultFeatureDir(opts.feature);
		const session = await ctx.resolveSession(featureDir);
		const from = session.snapshot.state?.sub_state;
		if (!from) {
			ctx.failure("NO_SESSION", `run \`loaf start ${opts.feature}\` first`);
			return;
		}
		const payload = {};
		if (opts.reason !== void 0) payload["reason"] = opts.reason;
		const result = await mutate({
			at: (/* @__PURE__ */ new Date()).toISOString(),
			actor: humanActor,
			entry_schema_version: 1,
			kind: "session:delivered",
			payload
		}, {
			feature_dir: featureDir,
			snapshot: session.snapshot,
			tail_seq: session.tail_seq,
			entries: session.entries,
			meta: session.meta
		});
		if (!result.ok) {
			ctx.failure(result.code, result.message, result.detail);
			return;
		}
		const advisory = [`session complete — \`loaf start <feature>\` to begin another`];
		const out = {
			ok: true,
			feature: opts.feature,
			from,
			to: "DONE.delivered",
			actor: humanActor,
			sub_state: result.snapshot.state?.sub_state,
			advisory
		};
		ctx.success(out, () => `delivered ${opts.feature} (advisory only) — ${from} → DONE.delivered by ${humanActor}\nnext: ${advisory[0]}\n`);
	});
	program.command("archive").description("Close the feature session without delivering (emits session:archived → DONE.archived)").requiredOption("--feature <name>", "Feature whose session to archive").requiredOption("--reason <text>", "Rationale recorded on the session:archived entry").option("--feature-dir <path>", "Override default .loaf/<feature> directory").action(async (opts) => {
		const resolution = resolveHumanActor({
			env: process.env,
			readGitConfig: getGitEmail,
			isInteractiveHuman: process.stdin.isTTY === true
		});
		if (!resolution.ok) {
			emitFailure(resolution.code, resolution.message);
			return;
		}
		const humanActor = resolution.actor;
		const featureDir = opts.featureDir ?? defaultFeatureDir(opts.feature);
		const session = await loadSession(featureDir);
		const from = session.snapshot.state?.sub_state;
		if (!from) {
			emitFailure("NO_SESSION", `run \`loaf start ${opts.feature}\` first`);
			return;
		}
		const result = await mutate({
			at: (/* @__PURE__ */ new Date()).toISOString(),
			actor: humanActor,
			entry_schema_version: 1,
			kind: "session:archived",
			payload: { reason: opts.reason }
		}, {
			feature_dir: featureDir,
			snapshot: session.snapshot,
			tail_seq: session.tail_seq,
			entries: session.entries,
			meta: session.meta
		});
		if (!result.ok) {
			emitFailure(result.code, result.message, result.detail);
			return;
		}
		const out = {
			ok: true,
			feature: opts.feature,
			from,
			to: "DONE.archived",
			actor: humanActor,
			sub_state: result.snapshot.state?.sub_state
		};
		if (useJson) process.stdout.write(JSON.stringify(out) + "\n");
		else process.stdout.write(`archived ${opts.feature} — ${from} → DONE.archived by ${humanActor}\n`);
	});
	program.command("abandon").description("Abandon the feature session (emits session:abandoned → DONE.abandoned)").requiredOption("--feature <name>", "Feature whose session to abandon").requiredOption("--reason <text>", "Rationale recorded on the session:abandoned entry").option("--feature-dir <path>", "Override default .loaf/<feature> directory").action(async (opts) => {
		const resolution = resolveHumanActor({
			env: process.env,
			readGitConfig: getGitEmail,
			isInteractiveHuman: process.stdin.isTTY === true
		});
		if (!resolution.ok) {
			emitFailure(resolution.code, resolution.message);
			return;
		}
		const humanActor = resolution.actor;
		const featureDir = opts.featureDir ?? defaultFeatureDir(opts.feature);
		const session = await loadSession(featureDir);
		const from = session.snapshot.state?.sub_state;
		if (!from) {
			emitFailure("NO_SESSION", `run \`loaf start ${opts.feature}\` first`);
			return;
		}
		const result = await mutate({
			at: (/* @__PURE__ */ new Date()).toISOString(),
			actor: humanActor,
			entry_schema_version: 1,
			kind: "session:abandoned",
			payload: { reason: opts.reason }
		}, {
			feature_dir: featureDir,
			snapshot: session.snapshot,
			tail_seq: session.tail_seq,
			entries: session.entries,
			meta: session.meta
		});
		if (!result.ok) {
			emitFailure(result.code, result.message, result.detail);
			return;
		}
		const out = {
			ok: true,
			feature: opts.feature,
			from,
			to: "DONE.abandoned",
			actor: humanActor,
			sub_state: result.snapshot.state?.sub_state
		};
		if (useJson) process.stdout.write(JSON.stringify(out) + "\n");
		else process.stdout.write(`abandoned ${opts.feature} — ${from} → DONE.abandoned by ${humanActor}\n`);
	});
	program.command("spike").description("Spike-task exits (protocol §8.3)").command("convert").description("Convert a spike session — emits spike:converted then archives to DONE.archived").requiredOption("--feature <name>", "Feature whose spike session to convert").requiredOption("--to-feature <id>", "Target feature id (F-NNN) the spike learnings carry into").requiredOption("--reason <text>", "Rationale recorded on the spike:converted entry").option("--feature-dir <path>", "Override default .loaf/<feature> directory").action(async (opts) => {
		const resolution = resolveHumanActor({
			env: process.env,
			readGitConfig: getGitEmail,
			isInteractiveHuman: process.stdin.isTTY === true
		});
		if (!resolution.ok) {
			emitFailure(resolution.code, resolution.message);
			return;
		}
		const humanActor = resolution.actor;
		const featureDir = opts.featureDir ?? defaultFeatureDir(opts.feature);
		const session = await loadSession(featureDir);
		const from = session.snapshot.state?.sub_state;
		if (!from) {
			emitFailure("NO_SESSION", `run \`loaf start ${opts.feature}\` first`);
			return;
		}
		const now = (/* @__PURE__ */ new Date()).toISOString();
		const result = await mutateBatch([{
			at: now,
			actor: humanActor,
			entry_schema_version: 1,
			kind: "spike:converted",
			payload: {
				to_feature: opts.toFeature,
				reason: opts.reason
			}
		}, {
			at: now,
			actor: humanActor,
			entry_schema_version: 1,
			kind: "session:archived",
			payload: { reason: opts.reason }
		}], {
			feature_dir: featureDir,
			snapshot: session.snapshot,
			tail_seq: session.tail_seq,
			entries: session.entries,
			meta: session.meta
		});
		if (!result.ok) {
			emitFailure(result.code, result.message, result.detail);
			return;
		}
		const out = {
			ok: true,
			feature: opts.feature,
			to_feature: opts.toFeature,
			from,
			to: "DONE.archived",
			actor: humanActor,
			sub_state: result.snapshot.state?.sub_state
		};
		if (useJson) process.stdout.write(JSON.stringify(out) + "\n");
		else process.stdout.write(`converted ${opts.feature} → ${opts.toFeature} — ${from} → DONE.archived by ${humanActor}\n`);
	});
	program.command("profile").description("Ceremony profile commands (protocol §10.8)").command("escalate").description("Apply a ceremony escalation — resolve the profile_escalation pending + emit event:ceremony_set").requiredOption("--confirm", "Human acceptance of the escalation (required)").requiredOption("--input <path>", "JSON file with the escalated 6-flag Ceremony object").requiredOption("--feature <name>", "Feature whose session to escalate").option("--feature-dir <path>", "Override default .loaf/<feature> directory").action(async (opts) => {
		const resolution = resolveHumanActor({
			env: process.env,
			readGitConfig: getGitEmail,
			isInteractiveHuman: process.stdin.isTTY === true
		});
		if (!resolution.ok) {
			emitFailure(resolution.code, resolution.message);
			return;
		}
		const humanActor = resolution.actor;
		let content;
		try {
			content = await promises.readFile(opts.input, "utf8");
		} catch (err) {
			if (err.code === "ENOENT") emitFailure("INPUT_FILE_NOT_FOUND", `input file does not exist: ${opts.input}`, { path: opts.input });
			else emitFailure("INPUT_FILE_NOT_FOUND", `cannot read input file ${opts.input}: ${String(err)}`, { path: opts.input });
			return;
		}
		let ceremony;
		try {
			ceremony = JSON.parse(content);
		} catch (err) {
			emitFailure("SCHEMA_VALIDATION_FAILED", `input is not valid JSON: ${err.message}`);
			return;
		}
		const featureDir = opts.featureDir ?? defaultFeatureDir(opts.feature);
		const session = await loadSession(featureDir);
		if (!session.snapshot.state?.sub_state) {
			emitFailure("NO_SESSION", `run \`loaf start ${opts.feature}\` first`);
			return;
		}
		const head = session.snapshot.pending.find((p) => !p.resolved);
		if (!head) {
			emitFailure("ESCALATION_NOT_PENDING", "`loaf profile escalate --confirm --input <ceremony.json>` requires pending head kind=profile_escalation; current head: (none)", { actual_head: "(none)" });
			return;
		}
		const now = (/* @__PURE__ */ new Date()).toISOString();
		const result = await mutateBatch([{
			at: now,
			actor: humanActor,
			entry_schema_version: 1,
			kind: "event:ceremony_set",
			payload: ceremony
		}, {
			at: now,
			actor: humanActor,
			entry_schema_version: 1,
			kind: "pending:resolved",
			payload: { id: head.id }
		}], {
			feature_dir: featureDir,
			snapshot: session.snapshot,
			tail_seq: session.tail_seq,
			entries: session.entries,
			meta: session.meta
		});
		if (!result.ok) {
			emitFailure(result.code, result.message, result.detail);
			return;
		}
		const out = {
			ok: true,
			feature: opts.feature,
			resolved_pending: head.id,
			sub_state: result.snapshot.state?.sub_state,
			actor: humanActor
		};
		if (useJson) process.stdout.write(JSON.stringify(out) + "\n");
		else process.stdout.write(`escalated ${opts.feature} — ceremony updated, pending ${head.id} resolved (cursor ${out.sub_state})\n`);
	});
	program.command("doctor").description("Repository self-check. This release implements --rebuild only").option("--rebuild", "Full journal replay → rebuild snapshots/*.json + _meta.json").option("--feature <name>", "Feature whose snapshots to rebuild (required with --rebuild)").option("--feature-dir <path>", "Override default .loaf/<feature> directory").action(async (opts) => {
		if (!opts.rebuild) {
			emitFailure("DOCTOR_MODE_NOT_IMPLEMENTED", "only --rebuild is implemented for loaf doctor in this release");
			return;
		}
		if (!opts.feature) {
			emitFailure("DOCTOR_FEATURE_REQUIRED", "doctor --rebuild requires --feature <name>");
			return;
		}
		const featureDir = opts.featureDir ?? defaultFeatureDir(opts.feature);
		const journalPath = path.join(featureDir, "journal.jsonl");
		const replay = await replayJournal(journalPath, {
			collect_entries: true,
			feature_dir: featureDir
		});
		if (!replay.ok) {
			emitFailure(replay.code, `journal at ${journalPath} cannot be replayed — ${replay.message}`);
			return;
		}
		const entries = replay.entries;
		if (entries === void 0) {
			emitFailure("DOCTOR_REBUILD_FAILED", "internal invariant: replay returned ok without collected entries");
			return;
		}
		if (entries.some((e) => e.kind === "migration:snapshot_imported")) {
			emitFailure("DOCTOR_REBUILD_MIGRATED_UNSUPPORTED", "doctor --rebuild does not yet support v0.0.x-migrated journals (intersects doctor --migrate-v2)");
			return;
		}
		let rebuilt;
		try {
			rebuilt = await writeProjections(featureDir, {
				snapshot: replay.snapshot,
				entries,
				meta: replay.meta
			});
		} catch (err) {
			emitFailure("DOCTOR_REBUILD_FAILED", `snapshot rebuild failed — ${err.message}`);
			return;
		}
		const out = {
			ok: true,
			feature: opts.feature,
			feature_dir: featureDir,
			tail_seq: replay.meta.last_applied_seq,
			rebuilt
		};
		if (useJson) process.stdout.write(JSON.stringify(out) + "\n");
		else process.stdout.write(`rebuilt ${rebuilt.length} projection file(s) for ${opts.feature}:\n` + rebuilt.map((f) => `  snapshots/${f}\n`).join("") + `# snapshot as-of seq=${replay.meta.last_applied_seq}\n`);
	});
	const tasksCmd = program.command("tasks").description("Task lifecycle commands (Slice 2 MVP: submit / claim / step)");
	tasksCmd.command("submit").description("Submit a complete task graph from --input <src> (stdin / inline JSON / file path; whole-graph single object)").requiredOption("--input <src>", "JSON source: `-` (stdin), inline JSON literal, or file path (protocol §10.7). Whole-graph single object only.").requiredOption("--feature <name>", "Feature whose task graph to submit").option("--feature-dir <path>", "Override default .loaf/<feature> directory").action(async (opts) => {
		const source = parseInputSource(opts.input);
		if (source.kind === "stdin" && isStdinTty()) {
			ctx.failure("USAGE", "stdin is TTY — `loaf tasks submit --input -` expects piped input. Pipe JSON via `... | loaf tasks submit --input -`, OR pass inline JSON / file path. Run --help for examples.");
			return;
		}
		const read = await readJsonInput(source, { readStdin });
		if (!read.ok) {
			ctx.failure(read.code, read.message, read.detail);
			return;
		}
		const payload = read.value;
		const featureDir = opts.featureDir ?? defaultFeatureDir(opts.feature);
		const session = await ctx.resolveSession(featureDir);
		if (!session.snapshot.state) {
			ctx.failure("NO_SESSION", `run \`loaf start ${opts.feature}\` first`);
			return;
		}
		const result = await mutate({
			at: (/* @__PURE__ */ new Date()).toISOString(),
			actor,
			entry_schema_version: 1,
			kind: "event:tasks_planned",
			payload
		}, {
			feature_dir: featureDir,
			snapshot: session.snapshot,
			tail_seq: session.tail_seq,
			entries: session.entries,
			meta: session.meta
		});
		if (!result.ok) {
			ctx.failure(result.code, result.message, result.detail);
			return;
		}
		const tasks = result.snapshot.tasks;
		const taskIds = tasks.map((t) => t.id);
		const out = {
			ok: true,
			feature: opts.feature,
			sub_state: result.snapshot.state?.sub_state,
			tasks_count: tasks.length,
			task_ids: taskIds,
			tasks_based_on: result.snapshot.tasks_based_on
		};
		ctx.success(out, () => `submitted ${tasks.length} task${tasks.length === 1 ? "" : "s"}: ${taskIds.join(", ")}\n`);
	});
	tasksCmd.command("add").description("Append id-less task(s) to the graph — --input <src> with single object or array (batch); SPEC.design whole-graph, or EXECUTE.work sponsored via --finding").requiredOption("--input <src>", "JSON source for TaskInput (single object or array): `-` (stdin), inline JSON, or file path (protocol §10.7)").requiredOption("--feature <name>", "Feature whose task graph to extend").option("--feature-dir <path>", "Override default .loaf/<feature> directory").option("--finding <FND-N>", "Sponsoring amend-tasks finding (sponsored add at EXECUTE.work)").action(async (opts) => {
		const source = parseInputSource(opts.input);
		if (source.kind === "stdin" && isStdinTty()) {
			ctx.failure("USAGE", "stdin is TTY — `loaf tasks add --input -` expects piped input. Pipe JSON via `... | loaf tasks add --input -`, OR pass inline JSON / file path. Run --help for examples.");
			return;
		}
		const read = await readJsonInput(source, { readStdin });
		if (!read.ok) {
			ctx.failure(read.code, read.message, read.detail);
			return;
		}
		const parsed = read.value;
		const rawTasks = Array.isArray(parsed) ? parsed : [parsed];
		if (rawTasks.length === 0) {
			ctx.failure("SCHEMA_VALIDATION_FAILED", "tasks add input is an empty array");
			return;
		}
		const validatedInputs = [];
		for (const raw of rawTasks) {
			const p = TaskInput.safeParse(raw);
			if (!p.success) {
				ctx.failure("SCHEMA_VALIDATION_FAILED", `tasks add input is not a valid id-less task (omit id / status / execution): ${p.error.issues.map((i) => i.message).join("; ")}`, { issues: p.error.issues });
				return;
			}
			validatedInputs.push(p.data);
		}
		const featureDir = opts.featureDir ?? defaultFeatureDir(opts.feature);
		const session = await ctx.resolveSession(featureDir);
		if (!session.snapshot.state) {
			ctx.failure("NO_SESSION", `run \`loaf start ${opts.feature}\` first`);
			return;
		}
		const subState = session.snapshot.state.sub_state;
		const sponsored = opts.finding !== void 0;
		if (sponsored && subState === "SPEC.design") {
			ctx.failure("USAGE", "--finding is for the sponsored EXECUTE.work add; at SPEC.design `tasks add` is the unsponsored whole-graph path — drop --finding");
			return;
		}
		if (!sponsored && subState !== "SPEC.design") {
			ctx.failure("SUB_STATE_AUTHORITY_VIOLATION", `loaf tasks add without --finding is only valid at SPEC.design (current sub_state=${subState}); post-lock task additions go through \`loaf finding raise --action amend-tasks\` then \`tasks add --finding\``, { sub_state: subState });
			return;
		}
		let maxSerial = 0;
		for (const t of session.snapshot.tasks) {
			const m = /^T-(\d{3,})$/.exec(t.id);
			if (!m) {
				ctx.failure("REDUCER_ERROR", `internal: task id ${t.id} in the projection is not canonical T-NNN; cannot allocate the next id`, { task_id: t.id });
				return;
			}
			const n = Number.parseInt(m[1], 10);
			if (n > maxSerial) maxSerial = n;
		}
		const seededNew = validatedInputs.map((input, i) => materializeTaskInput(input, `T-${String(maxSerial + 1 + i).padStart(3, "0")}`));
		const newIds = seededNew.map((t) => t.id);
		if (sponsored) {
			const result = await mutateBatch(seededNew.map((task) => ({
				at: (/* @__PURE__ */ new Date()).toISOString(),
				actor,
				entry_schema_version: 1,
				kind: "event:tasks_amended",
				payload: {
					mode: "add",
					task,
					sponsored_by_finding_id: opts.finding
				}
			})), {
				feature_dir: featureDir,
				snapshot: session.snapshot,
				tail_seq: session.tail_seq,
				entries: session.entries,
				meta: session.meta
			});
			if (!result.ok) {
				ctx.failure(result.code, result.message, result.detail);
				return;
			}
			const out = {
				ok: true,
				feature: opts.feature,
				task_ids: newIds,
				sponsored_by_finding_id: opts.finding,
				tasks_count: result.snapshot.tasks.length,
				sub_state: result.snapshot.state?.sub_state
			};
			ctx.success(out, () => `added ${newIds.length} task${newIds.length === 1 ? "" : "s"} (sponsored by ${opts.finding}): ${newIds.join(", ")}\n`);
			return;
		}
		const existingFull = [];
		for (const t of session.snapshot.tasks) {
			const base = latestCanonicalTaskBody(session.entries, t.id);
			if (!base) {
				ctx.failure("CANONICAL_TASK_BODY_UNAVAILABLE", `task ${t.id} is in the projection but has no canonical body in the journal (migration-imported); cannot rebuild the graph to append`, {
					task_id: t.id,
					source: "migration"
				});
				return;
			}
			existingFull.push(materializeTaskForAmend(base, t));
		}
		const based_on = session.snapshot.tasks_based_on ?? { spec: session.snapshot.state.spec_version };
		const result = await mutate({
			at: (/* @__PURE__ */ new Date()).toISOString(),
			actor,
			entry_schema_version: 1,
			kind: "event:tasks_planned",
			payload: {
				based_on,
				tasks: [...existingFull, ...seededNew]
			}
		}, {
			feature_dir: featureDir,
			snapshot: session.snapshot,
			tail_seq: session.tail_seq,
			entries: session.entries,
			meta: session.meta
		});
		if (!result.ok) {
			ctx.failure(result.code, result.message, result.detail);
			return;
		}
		const out = {
			ok: true,
			feature: opts.feature,
			task_ids: newIds,
			tasks_count: result.snapshot.tasks.length,
			sub_state: result.snapshot.state?.sub_state
		};
		ctx.success(out, () => `added ${newIds.length} task${newIds.length === 1 ? "" : "s"}: ${newIds.join(", ")}\n`);
	});
	tasksCmd.command("claim <task-id>").description("Claim a ready task (pending → in_progress) at EXECUTE.work").requiredOption("--feature <name>", "Feature whose task to claim").option("--feature-dir <path>", "Override default .loaf/<feature> directory").action(async (taskId, opts) => {
		const featureDir = opts.featureDir ?? defaultFeatureDir(opts.feature);
		const session = await loadSession(featureDir);
		if (!session.snapshot.state) {
			emitFailure("NO_SESSION", `run \`loaf start ${opts.feature}\` first`);
			return;
		}
		const result = await mutate({
			at: (/* @__PURE__ */ new Date()).toISOString(),
			actor,
			entry_schema_version: 1,
			kind: "event:task_claimed",
			payload: { task_id: taskId }
		}, {
			feature_dir: featureDir,
			snapshot: session.snapshot,
			tail_seq: session.tail_seq,
			entries: session.entries,
			meta: session.meta
		});
		if (!result.ok) {
			emitFailure(result.code, result.message, result.detail);
			return;
		}
		const claimed = result.snapshot.tasks.find((t) => t.id === taskId);
		if (!claimed) {
			emitFailure("REDUCER_ERROR", `internal: task ${taskId} missing from snapshot after successful task_claimed apply`);
			return;
		}
		const status = claimed.status;
		const out = {
			ok: true,
			feature: opts.feature,
			task_id: taskId,
			status,
			sub_state: result.snapshot.state?.sub_state
		};
		if (useJson) process.stdout.write(JSON.stringify(out) + "\n");
		else process.stdout.write(`claimed ${taskId} (status=${status})\n`);
	});
	tasksCmd.command("abandon <task-id>").description("Abandon a non-terminal task (→ abandoned) at EXECUTE.work").requiredOption("--reason <text>", "Why the task is being abandoned (required)").requiredOption("--feature <name>", "Feature whose task to abandon").option("--feature-dir <path>", "Override default .loaf/<feature> directory").action(async (taskId, opts) => {
		const featureDir = opts.featureDir ?? defaultFeatureDir(opts.feature);
		const session = await loadSession(featureDir);
		if (!session.snapshot.state) {
			emitFailure("NO_SESSION", `run \`loaf start ${opts.feature}\` first`);
			return;
		}
		const result = await mutate({
			at: (/* @__PURE__ */ new Date()).toISOString(),
			actor,
			entry_schema_version: 1,
			kind: "event:task_abandoned",
			payload: {
				task_id: taskId,
				reason: opts.reason
			}
		}, {
			feature_dir: featureDir,
			snapshot: session.snapshot,
			tail_seq: session.tail_seq,
			entries: session.entries,
			meta: session.meta
		});
		if (!result.ok) {
			emitFailure(result.code, result.message, result.detail);
			return;
		}
		const abandoned = result.snapshot.tasks.find((t) => t.id === taskId);
		if (!abandoned) {
			emitFailure("REDUCER_ERROR", `internal: task ${taskId} missing from snapshot after successful task_abandoned apply`);
			return;
		}
		const status = abandoned.status;
		const out = {
			ok: true,
			feature: opts.feature,
			task_id: taskId,
			status,
			sub_state: result.snapshot.state?.sub_state
		};
		if (useJson) process.stdout.write(JSON.stringify(out) + "\n");
		else process.stdout.write(`abandoned ${taskId} (status=${status})\n`);
	});
	tasksCmd.command("list").description("List tasks (read-only); shows derived `ready` column").requiredOption("--feature <name>", "Feature whose tasks to list").option("--feature-dir <path>", "Override default .loaf/<feature> directory").option("--status <s>", "Filter by task status (pending|ready|in_progress|done|abandoned)").action(async (opts) => {
		const loaded = await loadProjectionsOrFail(opts.featureDir ?? defaultFeatureDir(opts.feature), ["state", "tasks"], opts.feature);
		if (loaded === null) return;
		const slimTasks = loaded.tasks ? loaded.tasks.tasks.map((t) => extractTaskSlim(t)) : [];
		const tasksById = new Map(slimTasks.map((t) => [t.id, t]));
		const withDerived = slimTasks.map((t) => {
			const depsAllDone = t.depends_on.length === 0 || t.depends_on.every((d) => tasksById.get(d)?.status === "done");
			return {
				...t,
				ready: t.status === "pending" && depsAllDone
			};
		});
		const validStatuses = [
			"pending",
			"ready",
			"in_progress",
			"done",
			"abandoned"
		];
		if (opts.status !== void 0 && !validStatuses.includes(opts.status)) {
			emitFailure("USAGE", `--status must be one of: ${validStatuses.join(" | ")} (got ${opts.status})`);
			return;
		}
		const filtered = withDerived.filter((t) => {
			if (!opts.status) return true;
			if (opts.status === "ready") return t.ready;
			return t.status === opts.status;
		});
		if (useJson) process.stdout.write(JSON.stringify({
			ok: true,
			feature: opts.feature,
			count: filtered.length,
			tasks: filtered
		}) + "\n");
		else if (filtered.length === 0) process.stdout.write(opts.status ? `no tasks match --status=${opts.status}\n` : `no tasks in projection (run \`loaf tasks submit\` first)\n`);
		else for (const t of filtered) {
			const ready = t.ready ? " [ready]" : "";
			process.stdout.write(`${t.id} ${t.kind} ${t.status}${ready}\n`);
		}
	});
	tasksCmd.command("next").description("Print the next ready task id (or empty if none); read-only").requiredOption("--feature <name>", "Feature whose ready task to compute").option("--feature-dir <path>", "Override default .loaf/<feature> directory").action(async (opts) => {
		const session = await loadSession(opts.featureDir ?? defaultFeatureDir(opts.feature));
		if (!session.snapshot.state) {
			emitFailure("NO_SESSION", `run \`loaf start ${opts.feature}\` first`);
			return;
		}
		const tasks = session.snapshot.tasks;
		const tasksById = new Map(tasks.map((t) => [t.id, t]));
		const ready = tasks.find((t) => {
			if (t.status !== "pending") return false;
			return t.depends_on.length === 0 || t.depends_on.every((d) => tasksById.get(d)?.status === "done");
		});
		if (useJson) process.stdout.write(JSON.stringify({
			ok: true,
			feature: opts.feature,
			task_id: ready?.id ?? null,
			kind: ready?.kind ?? null
		}) + "\n");
		else process.stdout.write(ready ? `${ready.id}\n` : "");
	});
	tasksCmd.command("complete <task-id>").description("Confirm a task has reached status=done (read-only; emits nothing)").requiredOption("--feature <name>", "Feature whose task to confirm").option("--feature-dir <path>", "Override default .loaf/<feature> directory").action(async (taskId, opts) => {
		const session = await loadSession(opts.featureDir ?? defaultFeatureDir(opts.feature));
		if (!session.snapshot.state) {
			emitFailure("NO_SESSION", `run \`loaf start ${opts.feature}\` first`);
			return;
		}
		const task = session.snapshot.tasks.find((t) => t.id === taskId);
		if (!task) {
			emitFailure("TASK_NOT_FOUND", `task ${taskId} is not in the current tasks projection`, { task_id: taskId });
			return;
		}
		if (task.status !== "done") {
			const TERMINAL_POSITIVE = [
				"passed",
				"waived",
				"na"
			];
			const blockingSteps = Object.entries(task.steps).filter(([, s]) => s.applicability === "must" && !TERMINAL_POSITIVE.includes(s.status)).map(([name]) => name);
			emitFailure("TASK_COMPLETE_PRECONDITION_VIOLATED", `task ${taskId} is not complete (status=${task.status}); must-applicable steps not terminal-positive: ${blockingSteps.join(", ") || "(none — task has no must steps to auto-promote)"}`, {
				task_id: taskId,
				status: task.status,
				blocking_steps: blockingSteps
			});
			return;
		}
		const out = {
			ok: true,
			feature: opts.feature,
			task_id: taskId,
			status: task.status
		};
		if (useJson) process.stdout.write(JSON.stringify(out) + "\n");
		else process.stdout.write(`${taskId} complete (status=done)\n`);
	});
	tasksCmd.command("amend <task-id>").description("Amend a task: --policy <step>=<applicability> (EXECUTE.plan) or --input <file> --finding <FND-N> (sponsored, EXECUTE.work)").requiredOption("--feature <name>", "Feature whose task to amend").option("--feature-dir <path>", "Override default .loaf/<feature> directory").option("--policy <step=applicability>", "Step applicability override (must|optional|na); repeatable", (val, acc) => [...acc, val], []).option("--input <file>", "New id-less task definition for a sponsored graph replacement (JSON file or '-')").option("--finding <FND-N>", "Sponsoring amend-tasks finding (required with --input)").action(async (taskId, opts) => {
		const policies = opts.policy ?? [];
		const hasPolicy = policies.length > 0;
		const hasInput = opts.input !== void 0;
		const hasFinding = opts.finding !== void 0;
		if (hasPolicy && hasInput) {
			emitFailure("USAGE", "--policy and --input are mutually exclusive: --policy narrows applicability at EXECUTE.plan, --input replaces the task graph (sponsored) at EXECUTE.work");
			return;
		}
		if (hasInput !== hasFinding) {
			emitFailure("USAGE", "--input and --finding must be specified together — a sponsored graph replacement needs the sponsoring amend-tasks finding");
			return;
		}
		if (!hasPolicy && !hasInput) {
			emitFailure("USAGE", "tasks amend needs either --policy <step>=<applicability> or --input <src> --finding <FND-N>");
			return;
		}
		if (hasInput) {
			const inputPath = opts.input;
			const findingId = opts.finding;
			const source = parseInputSource(inputPath);
			if (source.kind === "stdin" && isStdinTty()) {
				ctx.failure("USAGE", "stdin is TTY — `loaf tasks amend --input -` expects piped input. Pipe JSON via `... | loaf tasks amend --input -`, OR pass inline JSON / file path. Run --help for examples.");
				return;
			}
			const read = await readJsonInput(source, { readStdin });
			if (!read.ok) {
				ctx.failure(read.code, read.message, read.detail);
				return;
			}
			const inParsed = read.value;
			const inTask = TaskInput.safeParse(inParsed);
			if (!inTask.success) {
				ctx.failure("SCHEMA_VALIDATION_FAILED", `tasks amend --input is not a valid id-less task (omit id / status / execution): ${inTask.error.issues.map((i) => i.message).join("; ")}`, { issues: inTask.error.issues });
				return;
			}
			const sFeatureDir = opts.featureDir ?? defaultFeatureDir(opts.feature);
			const sSession = await ctx.resolveSession(sFeatureDir);
			if (!sSession.snapshot.state) {
				ctx.failure("NO_SESSION", `run \`loaf start ${opts.feature}\` first`);
				return;
			}
			const sCurrent = sSession.snapshot.tasks.find((t) => t.id === taskId);
			if (!sCurrent) {
				ctx.failure("TASK_NOT_FOUND", `task ${taskId} is not in the current tasks projection`, { task_id: taskId });
				return;
			}
			const sCanonical = latestCanonicalTaskBody(sSession.entries, taskId);
			if (!sCanonical) {
				emitFailure("CANONICAL_TASK_BODY_UNAVAILABLE", `task ${taskId} is in the projection but has no canonical body in the journal (migration-imported); cannot amend in place`, {
					task_id: taskId,
					source: "migration"
				});
				return;
			}
			const sNewGraph = materializeTaskInput(inTask.data, taskId);
			const sNewSteps = new Set(Object.keys(sNewGraph.execution));
			const sPriorExec = sCanonical.execution;
			for (const [stepName, prior] of Object.entries(sPriorExec)) {
				if (sNewSteps.has(stepName)) continue;
				if (prior.status !== "pending" || prior.evidence_refs.length > 0 || prior.started_at !== void 0 || prior.reason !== void 0) {
					ctx.failure("MUTATION_OUT_OF_RIGHTS", `sponsored tasks amend on ${taskId} drops step '${stepName}', which carries execution progress — a graph amend may not erase execution history (codex r136 Q4)`, {
						task_id: taskId,
						step: stepName,
						reason: "sponsored_amend_drops_progress_step"
					});
					return;
				}
			}
			const sMaterialized = materializeTaskForAmend(carryForwardStepProgress(sNewGraph, sCanonical), sCurrent);
			const sResult = await mutate({
				at: (/* @__PURE__ */ new Date()).toISOString(),
				actor,
				entry_schema_version: 1,
				kind: "event:tasks_amended",
				payload: {
					mode: "replace",
					task: sMaterialized,
					sponsored_by_finding_id: findingId
				}
			}, {
				feature_dir: sFeatureDir,
				snapshot: sSession.snapshot,
				tail_seq: sSession.tail_seq,
				entries: sSession.entries,
				meta: sSession.meta
			});
			if (!sResult.ok) {
				ctx.failure(sResult.code, sResult.message, sResult.detail);
				return;
			}
			const sOut = {
				ok: true,
				feature: opts.feature,
				task_id: taskId,
				sponsored_by_finding_id: findingId,
				sub_state: sResult.snapshot.state?.sub_state
			};
			ctx.success(sOut, () => `amended ${taskId} (sponsored by ${findingId})\n`);
			return;
		}
		const APPLICABILITY = [
			"must",
			"optional",
			"na"
		];
		const policyMap = /* @__PURE__ */ new Map();
		for (const p of policies) {
			const eq = p.indexOf("=");
			if (eq <= 0 || eq === p.length - 1) {
				emitFailure("SCHEMA_VALIDATION_FAILED", `malformed --policy '${p}' — expected <step>=<applicability>`);
				return;
			}
			const step = p.slice(0, eq);
			const applicability = p.slice(eq + 1);
			if (!APPLICABILITY.includes(applicability)) {
				emitFailure("SCHEMA_VALIDATION_FAILED", `--policy '${p}': applicability must be one of must | optional | na`);
				return;
			}
			if (policyMap.has(step)) {
				emitFailure("SCHEMA_VALIDATION_FAILED", `--policy step '${step}' specified more than once`);
				return;
			}
			policyMap.set(step, applicability);
		}
		const featureDir = opts.featureDir ?? defaultFeatureDir(opts.feature);
		const session = await loadSession(featureDir);
		if (!session.snapshot.state) {
			emitFailure("NO_SESSION", `run \`loaf start ${opts.feature}\` first`);
			return;
		}
		const current = session.snapshot.tasks.find((t) => t.id === taskId);
		if (!current) {
			emitFailure("TASK_NOT_FOUND", `task ${taskId} is not in the current tasks projection`, { task_id: taskId });
			return;
		}
		const base = latestCanonicalTaskBody(session.entries, taskId);
		if (!base) {
			emitFailure("CANONICAL_TASK_BODY_UNAVAILABLE", `task ${taskId} is in the projection but has no canonical body in the journal (migration-imported); cannot amend in place`, {
				task_id: taskId,
				source: "migration"
			});
			return;
		}
		const materialized = materializeTaskForAmend(base, current);
		const execution = materialized.execution;
		for (const [step, applicability] of policyMap) {
			const seeded = execution[step];
			if (!seeded) {
				emitFailure("TASK_STEP_NOT_FOUND", `step '${step}' is not in task ${taskId}'s execution set`, {
					task_id: taskId,
					step
				});
				return;
			}
			seeded.applicability = applicability;
		}
		const result = await mutate({
			at: (/* @__PURE__ */ new Date()).toISOString(),
			actor,
			entry_schema_version: 1,
			kind: "event:tasks_amended",
			payload: {
				mode: "replace",
				task: materialized
			}
		}, {
			feature_dir: featureDir,
			snapshot: session.snapshot,
			tail_seq: session.tail_seq,
			entries: session.entries,
			meta: session.meta
		});
		if (!result.ok) {
			emitFailure(result.code, result.message, result.detail);
			return;
		}
		const applied = [...policyMap].map(([s, a]) => `${s}=${a}`).join(", ");
		const out = {
			ok: true,
			feature: opts.feature,
			task_id: taskId,
			policy: Object.fromEntries(policyMap),
			sub_state: result.snapshot.state?.sub_state
		};
		if (useJson) process.stdout.write(JSON.stringify(out) + "\n");
		else process.stdout.write(`amended ${taskId} (${applied})\n`);
	});
	tasksCmd.command("register-red <task-id>").description("Register the RED test for a claimed behavioral bug task (EXECUTE.work)").requiredOption("--feature <name>", "Feature whose task to register").option("--feature-dir <path>", "Override default .loaf/<feature> directory").action(async (taskId, opts) => {
		const featureDir = opts.featureDir ?? defaultFeatureDir(opts.feature);
		const session = await loadSession(featureDir);
		if (!session.snapshot.state) {
			emitFailure("NO_SESSION", `run \`loaf start ${opts.feature}\` first`);
			return;
		}
		const result = await mutate({
			at: (/* @__PURE__ */ new Date()).toISOString(),
			actor,
			entry_schema_version: 1,
			kind: "event:task_step_done",
			payload: {
				task_id: taskId,
				step: "red",
				result: "passed",
				red_test_registered: true
			}
		}, {
			feature_dir: featureDir,
			snapshot: session.snapshot,
			tail_seq: session.tail_seq,
			entries: session.entries,
			meta: session.meta
		});
		if (!result.ok) {
			emitFailure(result.code, result.message, result.detail);
			return;
		}
		const out = {
			ok: true,
			feature: opts.feature,
			task_id: taskId,
			red_test_registered: true,
			sub_state: result.snapshot.state?.sub_state
		};
		if (useJson) process.stdout.write(JSON.stringify(out) + "\n");
		else process.stdout.write(`registered RED for ${taskId}\n`);
	});
	const stepCmd = tasksCmd.command("step").description("Task step lifecycle (start / done)");
	stepCmd.command("start").description("Mark a task step as running (task must be claimed)").requiredOption("--task <task-id>", "Task whose step to start").requiredOption("--step <step-name>", "Step name (kind-specific; see spec)").requiredOption("--feature <name>", "Feature whose task lifecycle to advance").option("--feature-dir <path>", "Override default .loaf/<feature> directory").action(async (opts) => {
		const featureDir = opts.featureDir ?? defaultFeatureDir(opts.feature);
		const session = await loadSession(featureDir);
		if (!session.snapshot.state) {
			emitFailure("NO_SESSION", `run \`loaf start ${opts.feature}\` first`);
			return;
		}
		const result = await mutate({
			at: (/* @__PURE__ */ new Date()).toISOString(),
			actor,
			entry_schema_version: 1,
			kind: "event:task_step_started",
			payload: {
				task_id: opts.task,
				step: opts.step
			}
		}, {
			feature_dir: featureDir,
			snapshot: session.snapshot,
			tail_seq: session.tail_seq,
			entries: session.entries,
			meta: session.meta
		});
		if (!result.ok) {
			emitFailure(result.code, result.message, result.detail);
			return;
		}
		const updated = result.snapshot.tasks.find((t) => t.id === opts.task);
		if (!updated) {
			emitFailure("REDUCER_ERROR", `internal: task ${opts.task} missing from snapshot after successful step_started apply`);
			return;
		}
		const stepInfo = updated.steps[opts.step];
		if (!stepInfo) {
			emitFailure("REDUCER_ERROR", `internal: step ${opts.step} missing from task ${opts.task} after successful step_started apply`);
			return;
		}
		const out = {
			ok: true,
			feature: opts.feature,
			task_id: opts.task,
			step: opts.step,
			step_status: stepInfo.status,
			sub_state: result.snapshot.state?.sub_state
		};
		if (useJson) process.stdout.write(JSON.stringify(out) + "\n");
		else process.stdout.write(`started ${opts.task} step=${opts.step} (status=running)\n`);
	});
	stepCmd.command("done").description("Mark a task step as done (--result passed|failed|waived|na; default passed)").requiredOption("--task <task-id>", "Task whose step to mark done").requiredOption("--step <step-name>", "Step name (kind-specific)").option("--result <r>", "Step result: passed (default) | failed | waived | na", "passed").option("--evidence-kind <kind>", "Evidence kind (closed EvidenceKind enum)").option("--evidence-result <r>", "Evidence result (passed | failed | approved | rejected | waived)").option("--evidence-summary <text>", "Evidence summary (≥3 chars)").option("--evidence-covers <csv>", "Comma-separated REQ/SCEN/VIS/Task ids covered by this evidence").option("--evidence-check <kind>", "Verify-check kind (run | review | acceptance | visual)").option("--evidence-reason <text>", "Evidence reason (manual/waiver require ≥10 chars)").option("--evidence-actor <actor>", "Override evidence actor (default: cli:loaf; required human:* for manual/waiver)").requiredOption("--feature <name>", "Feature whose task lifecycle to advance").option("--feature-dir <path>", "Override default .loaf/<feature> directory").action(async (opts) => {
		if (![
			"passed",
			"failed",
			"waived",
			"na"
		].includes(opts.result)) {
			emitFailure("USAGE", `--result must be one of: passed | failed | waived | na (got ${opts.result})`);
			return;
		}
		const evidenceFlagSet = opts.evidenceKind !== void 0 || opts.evidenceResult !== void 0 || opts.evidenceSummary !== void 0 || opts.evidenceCovers !== void 0 || opts.evidenceCheck !== void 0 || opts.evidenceReason !== void 0 || opts.evidenceActor !== void 0;
		if (evidenceFlagSet) {
			if (opts.evidenceKind === void 0 || opts.evidenceSummary === void 0) {
				emitFailure("USAGE", "--evidence-kind and --evidence-summary must be specified together when any --evidence-* flag is present");
				return;
			}
		}
		const featureDir = opts.featureDir ?? defaultFeatureDir(opts.feature);
		const session = await loadSession(featureDir);
		if (!session.snapshot.state) {
			emitFailure("NO_SESSION", `run \`loaf start ${opts.feature}\` first`);
			return;
		}
		const now = (/* @__PURE__ */ new Date()).toISOString();
		const stepDoneEntry = {
			at: now,
			actor,
			entry_schema_version: 1,
			kind: "event:task_step_done",
			payload: {
				task_id: opts.task,
				step: opts.step,
				result: opts.result
			}
		};
		const ctx = {
			feature_dir: featureDir,
			snapshot: session.snapshot,
			tail_seq: session.tail_seq,
			entries: session.entries,
			meta: session.meta
		};
		let result;
		let evidenceId;
		if (evidenceFlagSet) {
			const maxSerial = session.snapshot.evidence.reduce((max, e) => {
				const m = /^EV-(\d+)$/.exec(e.id);
				if (!m) return max;
				return Math.max(max, Number.parseInt(m[1], 10));
			}, 0);
			evidenceId = `EV-${String(maxSerial + 1).padStart(6, "0")}`;
			const iteration = session.snapshot.state.iteration ?? 1;
			const evidenceActor = opts.evidenceActor ?? actor;
			const evidencePayload = {
				id: evidenceId,
				kind: opts.evidenceKind,
				iteration,
				actor: evidenceActor,
				result: opts.evidenceResult ?? opts.result,
				summary: opts.evidenceSummary,
				task_id: opts.task
			};
			if (opts.evidenceCovers !== void 0) evidencePayload["covers"] = opts.evidenceCovers.split(",").map((s) => s.trim()).filter((s) => s.length > 0);
			if (opts.evidenceCheck !== void 0) evidencePayload["check"] = opts.evidenceCheck;
			if (opts.evidenceReason !== void 0) evidencePayload["reason"] = opts.evidenceReason;
			result = await mutateBatch([stepDoneEntry, {
				at: now,
				actor,
				entry_schema_version: 1,
				kind: "evidence:added",
				payload: evidencePayload
			}], ctx);
		} else result = await mutate(stepDoneEntry, ctx);
		if (!result.ok) {
			emitFailure(result.code, result.message, result.detail);
			return;
		}
		const updated = result.snapshot.tasks.find((t) => t.id === opts.task);
		if (!updated) {
			emitFailure("REDUCER_ERROR", `internal: task ${opts.task} missing from snapshot after successful step_done apply`);
			return;
		}
		const stepInfo = updated.steps[opts.step];
		if (!stepInfo) {
			emitFailure("REDUCER_ERROR", `internal: step ${opts.step} missing from task ${opts.task} after successful step_done apply`);
			return;
		}
		const out = {
			ok: true,
			feature: opts.feature,
			task_id: opts.task,
			step: opts.step,
			step_status: stepInfo.status,
			task_status: updated.status,
			sub_state: result.snapshot.state?.sub_state
		};
		if (evidenceId !== void 0) out["evidence_id"] = evidenceId;
		if (useJson) process.stdout.write(JSON.stringify(out) + "\n");
		else {
			const promote = updated.status === "done" ? " (task auto-promoted to done)" : "";
			const evidenceSuffix = evidenceId !== void 0 ? ` evidence=${evidenceId}` : "";
			process.stdout.write(`done ${opts.task} step=${opts.step} result=${opts.result}${evidenceSuffix}${promote}\n`);
		}
	});
	program.command("settle").description("Advance VERIFY.accept → SETTLE.reconcile (deep ceremony only)").requiredOption("--feature <name>", "Feature whose session to settle").option("--feature-dir <path>", "Override default .loaf/<feature> directory").action(async (opts) => {
		const featureDir = opts.featureDir ?? defaultFeatureDir(opts.feature);
		const session = await loadSession(featureDir);
		const from = session.snapshot.state?.sub_state;
		if (!from) {
			emitFailure("NO_SESSION", `run \`loaf start ${opts.feature}\` first`);
			return;
		}
		const result = await mutate({
			at: (/* @__PURE__ */ new Date()).toISOString(),
			actor,
			entry_schema_version: 1,
			kind: "event:phase_advanced",
			payload: {
				from,
				to: "SETTLE.reconcile"
			}
		}, {
			feature_dir: featureDir,
			snapshot: session.snapshot,
			tail_seq: session.tail_seq,
			entries: session.entries,
			meta: session.meta
		});
		if (!result.ok) {
			emitFailure(result.code, result.message, result.detail);
			return;
		}
		const advisory = ["complete SETTLE.* phase (loaf advance SETTLE.lessons) then `loaf deliver`"];
		const out = {
			ok: true,
			feature: opts.feature,
			from,
			to: "SETTLE.reconcile",
			sub_state: result.snapshot.state?.sub_state,
			advisory
		};
		if (useJson) process.stdout.write(JSON.stringify(out) + "\n");
		else process.stdout.write(`settled ${opts.feature} — ${from} → SETTLE.reconcile\nnext: ${advisory[0]}\n`);
	});
	const pendingCmd = program.command("pending").description("Pending queue commands (raise / list / status / resolve)");
	pendingCmd.command("raise").description("Raise a new pending entry (CLI allocates PEND-id)").requiredOption("--kind <kind>", "Pending kind (ask_user_question | gate_decision | spec_clarification | finding_decision | profile_escalation)").requiredOption("--question <text>", "Question / rationale shown to whoever resolves it (required for ALL kinds)").option("--options <csv>", "Comma-separated answer options (passthrough)").option("--task-id <id>", "Optional task association (passthrough)").requiredOption("--feature <name>", "Feature whose session to raise pending against").option("--feature-dir <path>", "Override default .loaf/<feature> directory").action(async (opts) => {
		const featureDir = opts.featureDir ?? defaultFeatureDir(opts.feature);
		const session = await loadSession(featureDir);
		if (!session.snapshot.state) {
			emitFailure("NO_SESSION", `run \`loaf start ${opts.feature}\` first`);
			return;
		}
		const maxSerial = session.snapshot.pending.reduce((max, p) => {
			const m = /^PEND-(\d+)$/.exec(p.id);
			if (!m) return max;
			return Math.max(max, Number.parseInt(m[1], 10));
		}, 0);
		const id = `PEND-${String(maxSerial + 1).padStart(4, "0")}`;
		const payload = {
			id,
			kind: opts.kind,
			question: opts.question
		};
		if (opts.options !== void 0) payload["options"] = opts.options.split(",").map((s) => s.trim()).filter((s) => s.length > 0);
		if (opts.taskId !== void 0) payload["task_id"] = opts.taskId;
		const result = await mutate({
			at: (/* @__PURE__ */ new Date()).toISOString(),
			actor,
			entry_schema_version: 1,
			kind: "pending:added",
			payload
		}, {
			feature_dir: featureDir,
			snapshot: session.snapshot,
			tail_seq: session.tail_seq,
			entries: session.entries,
			meta: session.meta
		});
		if (!result.ok) {
			emitFailure(result.code, result.message, result.detail);
			return;
		}
		if (useJson) process.stdout.write(JSON.stringify({
			ok: true,
			feature: opts.feature,
			id,
			kind: opts.kind
		}) + "\n");
		else process.stdout.write(id + "\n");
	});
	pendingCmd.command("list").description("List pending entries (FIFO; first unresolved is head)").requiredOption("--feature <name>", "Feature whose pending to list").option("--feature-dir <path>", "Override default .loaf/<feature> directory").action(async (opts) => {
		const loaded = await loadProjectionsOrFail(opts.featureDir ?? defaultFeatureDir(opts.feature), ["pending"], opts.feature);
		if (loaded === null) return;
		const entries = loaded.pending.pending;
		const headIdx = entries.findIndex((p) => !p.resolved);
		const rows = entries.map((p, i) => ({
			id: p.pending_id,
			kind: p.kind,
			resolved: p.resolved,
			head: i === headIdx
		}));
		if (useJson) process.stdout.write(JSON.stringify({
			ok: true,
			feature: opts.feature,
			count: rows.length,
			pending: rows
		}) + "\n");
		else for (const r of rows) process.stdout.write(`${r.id} ${r.kind} ${r.resolved ? "resolved" : "open"} ${r.head ? "head" : "-"}\n`);
	});
	pendingCmd.command("status").description("Status of head pending entry (default) or specific entry by --id").requiredOption("--feature <name>", "Feature whose pending to inspect").option("--id <id>", "Lookup a specific PEND-id (default: head)").option("--feature-dir <path>", "Override default .loaf/<feature> directory").action(async (opts) => {
		const session = await loadSession(opts.featureDir ?? defaultFeatureDir(opts.feature));
		if (!session.snapshot.state) {
			emitFailure("NO_SESSION", `run \`loaf start ${opts.feature}\` first`);
			return;
		}
		const headIdx = session.snapshot.pending.findIndex((p) => !p.resolved);
		let target;
		if (opts.id !== void 0) {
			const idx = session.snapshot.pending.findIndex((p) => p.id === opts.id);
			if (idx === -1) {
				emitFailure("PENDING_NOT_FOUND", `pending id=${opts.id} not found in queue`, { pending_id: opts.id });
				return;
			}
			target = {
				...session.snapshot.pending[idx],
				head: idx === headIdx
			};
		} else target = headIdx === -1 ? null : {
			...session.snapshot.pending[headIdx],
			head: true
		};
		if (useJson) process.stdout.write(JSON.stringify({
			ok: true,
			feature: opts.feature,
			pending: target
		}) + "\n");
		else if (target === null) process.stdout.write("no open pending\n");
		else process.stdout.write(`${target.id} ${target.kind} ${target.resolved ? "resolved" : "open"} ${target.head ? "head" : "-"}\n`);
	});
	pendingCmd.command("resolve").description("Resolve the head pending entry (strict FIFO; no --id flag)").requiredOption("--answer <text>", "Resolution answer (passthrough into pending:resolved payload)").requiredOption("--feature <name>", "Feature whose pending to resolve").option("--feature-dir <path>", "Override default .loaf/<feature> directory").action(async (opts) => {
		const featureDir = opts.featureDir ?? defaultFeatureDir(opts.feature);
		const session = await loadSession(featureDir);
		if (!session.snapshot.state) {
			emitFailure("NO_SESSION", `run \`loaf start ${opts.feature}\` first`);
			return;
		}
		const head = session.snapshot.pending.find((p) => !p.resolved);
		if (!head) {
			emitFailure("PENDING_NOT_FOUND", "pending:resolved called but the queue has no unresolved head");
			return;
		}
		const result = await mutate({
			at: (/* @__PURE__ */ new Date()).toISOString(),
			actor,
			entry_schema_version: 1,
			kind: "pending:resolved",
			payload: {
				id: head.id,
				answer: opts.answer
			}
		}, {
			feature_dir: featureDir,
			snapshot: session.snapshot,
			tail_seq: session.tail_seq,
			entries: session.entries,
			meta: session.meta
		});
		if (!result.ok) {
			emitFailure(result.code, result.message, result.detail);
			return;
		}
		if (useJson) process.stdout.write(JSON.stringify({
			ok: true,
			feature: opts.feature,
			resolved_id: head.id,
			kind: head.kind
		}) + "\n");
		else process.stdout.write(`resolved ${head.id} (kind=${head.kind})\n`);
	});
	program.command("evidence").description("Evidence ledger commands (Slice 3 SC2 MVP: add)").command("add").description("Append evidence entry/entries from --input <src> JSON (CLI allocates EV-id; single object or non-empty array for batch)").requiredOption("--input <src>", "JSON source for EvidenceAddInput (single object OR non-empty array for batch): `-` (stdin), inline JSON, or file path (protocol §10.7)").requiredOption("--feature <name>", "Feature whose ledger to append to").option("--feature-dir <path>", "Override default .loaf/<feature> directory").action(async (opts) => {
		const source = parseInputSource(opts.input);
		if (source.kind === "stdin" && isStdinTty()) {
			ctx.failure("USAGE", "stdin is TTY — `loaf evidence add --input -` expects piped input. Pipe JSON via `... | loaf evidence add --input -`, OR pass inline JSON / file path. Run --help for examples.");
			return;
		}
		const read = await readJsonInput(source, { readStdin });
		if (!read.ok) {
			ctx.failure(read.code, read.message, read.detail);
			return;
		}
		const parsed = read.value;
		const rawItems = Array.isArray(parsed) ? parsed : [parsed];
		if (rawItems.length === 0) {
			ctx.failure("SCHEMA_VALIDATION_FAILED", "evidence add input is an empty array (non-empty array required)");
			return;
		}
		const validatedInputs = [];
		for (let i = 0; i < rawItems.length; i++) {
			const raw = rawItems[i];
			const p = EvidenceAddInput.safeParse(raw);
			if (!p.success) {
				ctx.failure("SCHEMA_VALIDATION_FAILED", `evidence add input[${i}] failed schema validation: ${p.error.issues.map((iss) => iss.message).join("; ")}`, {
					index: i,
					issues: p.error.issues
				});
				return;
			}
			validatedInputs.push(p.data);
		}
		const featureDir = opts.featureDir ?? defaultFeatureDir(opts.feature);
		const session = await ctx.resolveSession(featureDir);
		if (!session.snapshot.state) {
			ctx.failure("NO_SESSION", `run \`loaf start ${opts.feature}\` first`);
			return;
		}
		const maxSerial = session.snapshot.evidence.reduce((max, e) => {
			const m = /^EV-(\d+)$/.exec(e.id);
			if (!m) return max;
			return Math.max(max, Number.parseInt(m[1], 10));
		}, 0);
		const evIds = validatedInputs.map((_, i) => `EV-${String(maxSerial + 1 + i).padStart(6, "0")}`);
		const now = (/* @__PURE__ */ new Date()).toISOString();
		const result = await mutateBatch(validatedInputs.map((input, i) => ({
			at: now,
			actor,
			entry_schema_version: 1,
			kind: "evidence:added",
			payload: {
				...input,
				id: evIds[i]
			}
		})), {
			feature_dir: featureDir,
			snapshot: session.snapshot,
			tail_seq: session.tail_seq,
			entries: session.entries,
			meta: session.meta
		});
		if (!result.ok) {
			ctx.failure(result.code, result.message, result.detail);
			return;
		}
		if (Array.isArray(parsed)) ctx.success({
			ok: true,
			feature: opts.feature,
			ev_ids: evIds,
			count: evIds.length,
			sub_state: result.snapshot.state?.sub_state
		}, () => `added ${evIds.length} evidence: ${evIds.join(", ")}\n`);
		else ctx.success({
			ok: true,
			feature: opts.feature,
			id: evIds[0],
			kind: validatedInputs[0].kind
		}, () => `${evIds[0]}\n`);
	});
	const findingCmd = program.command("finding").description("Finding ledger commands (Slice 3 SC3 MVP: raise / list / close)");
	findingCmd.command("raise").description("Raise a new finding (CLI allocates FND-id)").requiredOption("--category <category>", "Finding category (spec-gap | spec-defect | impl-defect | test-defect | new-scope | risk-escalation)").requiredOption("--action <action>", "Finding action (amend-spec | amend-tasks | fix-impl | fix-test | defer | backlog)").option("--summary <text>", "One-line finding summary (passthrough)").option("--reason <text>", "Justification (required ≥20 chars on unusual cells)").option("--target-task <task-id>", "Target task for fix-impl / fix-test / amend-tasks").option("--target-step <step>", "Target step (must equal action's canonical step)").requiredOption("--feature <name>", "Feature whose ledger to append to").option("--feature-dir <path>", "Override default .loaf/<feature> directory").action(async (opts) => {
		const hasTask = opts.targetTask !== void 0;
		const hasStep = opts.targetStep !== void 0;
		if (hasTask !== hasStep) {
			emitFailure("USAGE", "--target-task and --target-step must be specified together (or both omitted)");
			return;
		}
		const featureDir = opts.featureDir ?? defaultFeatureDir(opts.feature);
		const session = await loadSession(featureDir);
		if (!session.snapshot.state) {
			emitFailure("NO_SESSION", `run \`loaf start ${opts.feature}\` first`);
			return;
		}
		const maxSerial = session.snapshot.findings.reduce((max, f) => {
			const m = /^FND-(\d+)$/.exec(f.id);
			if (!m) return max;
			return Math.max(max, Number.parseInt(m[1], 10));
		}, 0);
		const id = `FND-${String(maxSerial + 1).padStart(3, "0")}`;
		const payload = {
			id,
			category: opts.category,
			action: opts.action
		};
		if (opts.summary !== void 0) payload["summary"] = opts.summary;
		if (opts.reason !== void 0) payload["reason"] = opts.reason;
		if (hasTask && hasStep) payload["target"] = {
			task_id: opts.targetTask,
			step: opts.targetStep
		};
		const nowIso = (/* @__PURE__ */ new Date()).toISOString();
		const fixResetStep = {
			"fix-impl": "implement",
			"fix-test": "red"
		}[opts.action];
		if (fixResetStep !== void 0 && hasTask && hasStep) {
			const currentSubState = session.snapshot.state.sub_state;
			const batchResult = await mutateBatch([
				{
					at: nowIso,
					actor,
					entry_schema_version: 1,
					kind: "finding:raised",
					payload
				},
				{
					at: nowIso,
					actor: "cli:loaf",
					entry_schema_version: 1,
					kind: "event:task_step_reset",
					payload: {
						task_id: opts.targetTask,
						step: fixResetStep,
						finding_id: id
					}
				},
				{
					at: nowIso,
					actor: "cli:loaf",
					entry_schema_version: 1,
					kind: "event:phase_advanced",
					payload: {
						from: currentSubState,
						to: "EXECUTE.work",
						back_edge: {
							action: opts.action,
							finding_id: id
						}
					}
				}
			], {
				feature_dir: featureDir,
				snapshot: session.snapshot,
				tail_seq: session.tail_seq,
				entries: session.entries,
				meta: session.meta
			});
			if (!batchResult.ok) {
				emitFailure(batchResult.code, batchResult.message, batchResult.detail);
				return;
			}
			if (useJson) process.stdout.write(JSON.stringify({
				ok: true,
				feature: opts.feature,
				id,
				category: opts.category,
				action: opts.action,
				back_edge: {
					from: currentSubState,
					to: "EXECUTE.work"
				}
			}) + "\n");
			else process.stdout.write(id + "\n");
			return;
		}
		const backEdgeTarget = {
			"amend-spec": "SPEC.spec",
			"amend-tasks": "EXECUTE.work"
		}[opts.action];
		if (backEdgeTarget !== void 0) {
			const currentSubState = session.snapshot.state.sub_state;
			const batchResult = await mutateBatch([{
				at: nowIso,
				actor,
				entry_schema_version: 1,
				kind: "finding:raised",
				payload
			}, {
				at: nowIso,
				actor: "cli:loaf",
				entry_schema_version: 1,
				kind: "event:phase_advanced",
				payload: {
					from: currentSubState,
					to: backEdgeTarget,
					back_edge: {
						action: opts.action,
						finding_id: id
					}
				}
			}], {
				feature_dir: featureDir,
				snapshot: session.snapshot,
				tail_seq: session.tail_seq,
				entries: session.entries,
				meta: session.meta
			});
			if (!batchResult.ok) {
				emitFailure(batchResult.code, batchResult.message, batchResult.detail);
				return;
			}
			if (useJson) process.stdout.write(JSON.stringify({
				ok: true,
				feature: opts.feature,
				id,
				category: opts.category,
				action: opts.action,
				back_edge: {
					from: currentSubState,
					to: backEdgeTarget
				}
			}) + "\n");
			else process.stdout.write(id + "\n");
			return;
		}
		const result = await mutate({
			at: nowIso,
			actor,
			entry_schema_version: 1,
			kind: "finding:raised",
			payload
		}, {
			feature_dir: featureDir,
			snapshot: session.snapshot,
			tail_seq: session.tail_seq,
			entries: session.entries,
			meta: session.meta
		});
		if (!result.ok) {
			emitFailure(result.code, result.message, result.detail);
			return;
		}
		if (useJson) process.stdout.write(JSON.stringify({
			ok: true,
			feature: opts.feature,
			id,
			category: opts.category,
			action: opts.action
		}) + "\n");
		else process.stdout.write(id + "\n");
	});
	findingCmd.command("list").description("List findings (read-only; --status filters open|closed)").requiredOption("--feature <name>", "Feature whose findings to list").option("--status <s>", "Filter by status (open | closed)").option("--feature-dir <path>", "Override default .loaf/<feature> directory").action(async (opts) => {
		if (opts.status !== void 0 && opts.status !== "open" && opts.status !== "closed") {
			emitFailure("USAGE", `--status must be one of: open | closed (got ${opts.status})`);
			return;
		}
		const loaded = await loadProjectionsOrFail(opts.featureDir ?? defaultFeatureDir(opts.feature), ["findings"], opts.feature);
		if (loaded === null) return;
		const all = loaded.findings.findings;
		const rows = opts.status ? all.filter((f) => f.status === opts.status) : all;
		if (useJson) process.stdout.write(JSON.stringify({
			ok: true,
			feature: opts.feature,
			count: rows.length,
			findings: rows
		}) + "\n");
		else for (const r of rows) process.stdout.write(`${r.id} ${r.category} ${r.action} ${r.status}\n`);
	});
	findingCmd.command("close <fnd-id>").description("Close a finding (emits finding:closed)").requiredOption("--feature <name>", "Feature whose ledger to close against").option("--feature-dir <path>", "Override default .loaf/<feature> directory").action(async (fndId, opts) => {
		const idParse = FindingId.safeParse(fndId);
		if (!idParse.success) {
			emitFailure("INVALID_PAYLOAD", `finding close id must match FindingId regex /^FND-\\d{3,}$/ (got ${fndId})`, {
				id: fndId,
				issues: idParse.error.issues
			});
			return;
		}
		const featureDir = opts.featureDir ?? defaultFeatureDir(opts.feature);
		const session = await loadSession(featureDir);
		if (!session.snapshot.state) {
			emitFailure("NO_SESSION", `run \`loaf start ${opts.feature}\` first`);
			return;
		}
		const existing = session.snapshot.findings.find((f) => f.id === fndId);
		if (!existing) {
			emitFailure("FINDING_NOT_FOUND", `finding:closed references unknown finding id=${fndId}`, {
				id: fndId,
				reason: "unknown"
			});
			return;
		}
		if (existing.status === "closed") {
			emitFailure("FINDING_NOT_FOUND", `finding:closed references finding id=${fndId} that is already closed`, {
				id: fndId,
				reason: "already_closed"
			});
			return;
		}
		const result = await mutate({
			at: (/* @__PURE__ */ new Date()).toISOString(),
			actor,
			entry_schema_version: 1,
			kind: "finding:closed",
			payload: { id: fndId }
		}, {
			feature_dir: featureDir,
			snapshot: session.snapshot,
			tail_seq: session.tail_seq,
			entries: session.entries,
			meta: session.meta
		});
		if (!result.ok) {
			emitFailure(result.code, result.message, result.detail);
			return;
		}
		if (useJson) process.stdout.write(JSON.stringify({
			ok: true,
			feature: opts.feature,
			id: fndId,
			status: "closed"
		}) + "\n");
		else process.stdout.write(`closed ${fndId}\n`);
	});
	const specCmd = program.command("spec").description("SPEC content commands (submit / add-req / add-scenario / add-visual; init in SC4)");
	specCmd.command("submit").description("Whole-replacement spec submit from JSON --input (CLI fills spec_version)").requiredOption("--input <src>", "JSON source: `-` (stdin), inline JSON literal, or file path (protocol §10.7)").requiredOption("--feature <name>", "Feature whose spec to submit").option("--feature-dir <path>", "Override default .loaf/<feature> directory").action(async (opts) => {
		const source = parseInputSource(opts.input);
		if (source.kind === "stdin" && isStdinTty()) {
			ctx.failure("USAGE", "stdin is TTY — `loaf spec submit --input -` expects piped input. Pipe JSON via `... | loaf spec submit --input -`, OR pass inline JSON / file path. Run --help for examples.");
			return;
		}
		const read = await readJsonInput(source, { readStdin });
		if (!read.ok) {
			ctx.failure(read.code, read.message, read.detail);
			return;
		}
		const parsed = read.value;
		if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
			ctx.failure("USAGE", "spec submit --input expects a JSON object (SpecFrontmatter shape)");
			return;
		}
		const inputParse = SpecSubmitInput.safeParse(parsed);
		if (!inputParse.success) {
			ctx.failure("SCHEMA_VALIDATION_FAILED", `spec submit input failed SpecSubmitInput schema validation`, { issues: inputParse.error.issues });
			return;
		}
		const input = inputParse.data;
		const featureDir = opts.featureDir ?? defaultFeatureDir(opts.feature);
		const session = await ctx.resolveSession(featureDir);
		if (!session.snapshot.state) {
			ctx.failure("NO_SESSION", `run \`loaf start ${opts.feature}\` first`);
			return;
		}
		const currentVersion = session.snapshot.state.spec_version;
		const specVersion = input.spec_version ?? currentVersion + 1;
		const reqs = input.requirements;
		const scens = input.scenarios;
		const viss = input.visual_contracts;
		const headPayload = {
			spec_version: specVersion,
			feature: input.feature,
			intent: input.intent,
			adr_refs: input.adr_refs,
			needs_clarification: input.needs_clarification
		};
		const now = (/* @__PURE__ */ new Date()).toISOString();
		const entries = [{
			at: now,
			actor,
			entry_schema_version: 1,
			kind: "event:spec_submitted",
			payload: headPayload
		}];
		for (const req of reqs) entries.push({
			at: now,
			actor,
			entry_schema_version: 1,
			kind: "event:spec_req_added",
			payload: {
				spec_version: specVersion,
				req
			}
		});
		for (const scen of scens) entries.push({
			at: now,
			actor,
			entry_schema_version: 1,
			kind: "event:spec_scenario_added",
			payload: {
				spec_version: specVersion,
				scenario: scen
			}
		});
		for (const vis of viss) entries.push({
			at: now,
			actor,
			entry_schema_version: 1,
			kind: "event:spec_visual_added",
			payload: {
				spec_version: specVersion,
				visual: vis
			}
		});
		const result = await mutateBatch(entries, {
			feature_dir: featureDir,
			snapshot: session.snapshot,
			tail_seq: session.tail_seq,
			entries: session.entries,
			meta: session.meta
		});
		if (!result.ok) {
			ctx.failure(result.code, result.message, result.detail);
			return;
		}
		const reqIds = result.snapshot.requirements.map((r) => r.id);
		const scenIds = result.snapshot.scenarios.map((s) => s.id);
		const visIds = result.snapshot.visual_contracts.map((v) => v.id);
		const out = {
			ok: true,
			feature: opts.feature,
			spec_version: result.snapshot.state?.spec_version,
			req_ids: reqIds,
			scen_ids: scenIds,
			vis_ids: visIds,
			sub_state: result.snapshot.state?.sub_state
		};
		ctx.success(out, () => `spec submitted v${out.spec_version}: ${reqIds.length} req / ${scenIds.length} scen / ${visIds.length} vis\n`);
	});
	const REGISTER_SPEC_ADD = [
		{
			name: "req",
			payloadField: "req",
			entryKind: "event:spec_req_added",
			inputSchema: SpecAddReqInput,
			snapshotKey: "requirements"
		},
		{
			name: "scenario",
			payloadField: "scenario",
			entryKind: "event:spec_scenario_added",
			inputSchema: SpecAddScenarioInput,
			snapshotKey: "scenarios"
		},
		{
			name: "visual",
			payloadField: "visual",
			entryKind: "event:spec_visual_added",
			inputSchema: SpecAddVisualInput,
			snapshotKey: "visual_contracts"
		}
	];
	specCmd.command("init").description("Write a parser-valid minimal spec.md scaffold (no journal entry)").requiredOption("--feature <name>", "Feature whose spec.md to scaffold").option("--feature-dir <path>", "Override default .loaf/<feature> directory").option("--feature-id <id>", "Override feature.id in scaffold (default: F-XXX placeholder)").option("--feature-name <text>", "Override feature.name in scaffold (default: --feature value)").option("--intent <text>", "Override intent line in scaffold (default: TODO placeholder ≥20 chars)").action(async (opts) => {
		const featureDir = opts.featureDir ?? defaultFeatureDir(opts.feature);
		const specMdPath = path.join(featureDir, "spec.md");
		try {
			await promises.access(specMdPath);
			emitFailure("SPEC_ALREADY_INITIALIZED", `spec.md already exists at ${specMdPath}; edit it directly or remove before re-init`, { spec_md_path: specMdPath });
			return;
		} catch {}
		await promises.mkdir(featureDir, { recursive: true });
		const featureId = opts.featureId ?? "F-000";
		const featureName = opts.featureName ?? (opts.feature.length >= 3 ? opts.feature : "TODO Feature Name");
		const intent = opts.intent ?? "TODO: describe the feature intent in at least twenty characters";
		const scaffoldObj = {
			schema_version: 2,
			spec_version: 1,
			feature: {
				id: featureId,
				name: featureName
			},
			intent,
			adr_refs: [],
			requirements: [],
			scenarios: [],
			visual_contracts: [],
			needs_clarification: []
		};
		const scaffoldParse = SpecFrontmatter.safeParse(scaffoldObj);
		if (!scaffoldParse.success) {
			emitFailure("SCHEMA_VALIDATION_FAILED", "spec init scaffold failed SpecFrontmatter validation; check --feature-id (/^F-\\d{3,}$/), --feature-name (≥3 chars), --intent (≥20 chars)", { issues: scaffoldParse.error.issues });
			return;
		}
		const md = `---
schema_version: 2
spec_version: 1
feature:
  id: ${JSON.stringify(featureId)}\n  name: ${JSON.stringify(featureName)}\nintent: ${JSON.stringify(intent)}\nadr_refs: []\nrequirements: []\nscenarios: []\nneeds_clarification: []\n---\n\n## Why\n\nTODO: describe motivation and scope. Edit this section, then run \`loaf spec submit --input <json>\` to record the canonical spec.\n`;
		await promises.writeFile(specMdPath, md);
		if (useJson) process.stdout.write(JSON.stringify({
			ok: true,
			feature: opts.feature,
			spec_md_path: specMdPath
		}) + "\n");
		else process.stdout.write(`spec init: wrote scaffold to ${specMdPath}\nnext: edit, then \`loaf spec submit --input <json> --feature ${opts.feature}\`\n`);
	});
	for (const cfg of REGISTER_SPEC_ADD) specCmd.command(`add-${cfg.name}`).description(`Add ${cfg.name} entries via id_namespace stamping (CLI allocates ${cfg.name.toUpperCase()} ids)`).requiredOption("--input <src>", `JSON source for SpecAdd${cfg.name[0].toUpperCase()}${cfg.name.slice(1)}Input (item or array): \`-\` (stdin), inline JSON, or file path (protocol §10.7)`).requiredOption("--feature <name>", `Feature whose spec to extend`).option("--feature-dir <path>", "Override default .loaf/<feature> directory").action(async (opts) => {
		const source = parseInputSource(opts.input);
		if (source.kind === "stdin" && isStdinTty()) {
			ctx.failure("USAGE", `stdin is TTY — \`loaf spec add-${cfg.name} --input -\` expects piped input. Pipe JSON via \`... | loaf spec add-${cfg.name} --input -\`, OR pass inline JSON / file path. Run --help for examples.`);
			return;
		}
		const read = await readJsonInput(source, { readStdin });
		if (!read.ok) {
			ctx.failure(read.code, read.message, read.detail);
			return;
		}
		const parsed = read.value;
		const inputParse = cfg.inputSchema.safeParse(parsed);
		if (!inputParse.success) {
			ctx.failure("SCHEMA_VALIDATION_FAILED", `spec add-${cfg.name} input failed schema validation`, { issues: inputParse.error.issues });
			return;
		}
		const items = Array.isArray(inputParse.data) ? inputParse.data : [inputParse.data];
		const featureDir = opts.featureDir ?? defaultFeatureDir(opts.feature);
		const session = await ctx.resolveSession(featureDir);
		if (!session.snapshot.state) {
			ctx.failure("NO_SESSION", `run \`loaf start ${opts.feature}\` first`);
			return;
		}
		const existingIds = session.snapshot[cfg.snapshotKey].map((p) => p.id);
		const counters = /* @__PURE__ */ new Map();
		const allocatedIds = [];
		const transformedItems = [];
		for (const raw of items) {
			const ns = raw.id_namespace;
			let next = counters.get(ns);
			if (next === void 0) next = nextSerialInNamespace(existingIds, ns);
			const fullId = `${ns}-${String(next).padStart(3, "0")}`;
			counters.set(ns, next + 1);
			allocatedIds.push(fullId);
			const { id_namespace: _ns, ...rest } = raw;
			transformedItems.push({
				id: fullId,
				rest
			});
		}
		const targetVersion = session.snapshot.state.spec_version + 1;
		const now = (/* @__PURE__ */ new Date()).toISOString();
		const result = await mutateBatch(transformedItems.map(({ id, rest }, _idx) => ({
			at: now,
			actor,
			entry_schema_version: 1,
			kind: cfg.entryKind,
			payload: {
				spec_version: targetVersion,
				[cfg.payloadField]: {
					id,
					...rest
				}
			}
		})), {
			feature_dir: featureDir,
			snapshot: session.snapshot,
			tail_seq: session.tail_seq,
			entries: session.entries,
			meta: session.meta
		});
		if (!result.ok) {
			ctx.failure(result.code, result.message, result.detail);
			return;
		}
		ctx.success({
			ok: true,
			feature: opts.feature,
			spec_version: result.snapshot.state?.spec_version,
			ids: allocatedIds,
			sub_state: result.snapshot.state?.sub_state
		}, () => `spec add-${cfg.name} v${result.snapshot.state?.spec_version}: ${allocatedIds.join(", ")}\n`);
	});
	try {
		await program.parseAsync(argv);
		return ctx.exitCode;
	} catch (err) {
		if (err instanceof CommanderError) {
			if (err.exitCode === 0) return 0;
			process.stderr.write(`error: ${err.code ?? "USAGE"} — ${err.message}\n`);
			return err.exitCode === 1 ? 2 : err.exitCode;
		}
		const error = err instanceof Error ? err : new Error(String(err));
		const crashContext = ctx.snapshotCrashContext();
		const crashLog = await writeCrashLog({
			argv,
			cwd: process.cwd(),
			version,
			error,
			context: {
				phase: crashContext.phase,
				sub_state: crashContext.sub_state
			}
		});
		const reportUrl = buildReportUrl({
			base: LOAF_ISSUE_URL,
			loaf_version: version,
			schema_version: "2",
			phase: crashContext.phase,
			sub_state: crashContext.sub_state,
			argv,
			crash_log_path: crashLog
		});
		if (useJson) {
			const payload = {
				ok: false,
				code: UNEXPECTED_ERROR,
				message: "unexpected internal error",
				report_url: reportUrl
			};
			if (crashLog !== null) payload["crash_log"] = crashLog;
			process.stderr.write(JSON.stringify(payload) + "\n");
		} else {
			process.stderr.write(`error: ${UNEXPECTED_ERROR} — ${error.message}\n`);
			if (crashLog !== null) process.stderr.write(`  crash log: ${crashLog}\n`);
			process.stderr.write(`  report at ${reportUrl}\n`);
		}
		return 1;
	}
}
const __URL_STAMP_PROBE__ = `${LOAF_DOCS_URL} ${LOAF_ISSUE_URL}`;
if (import.meta.main) {
	installSigintHandler({
		writeStderr: (s) => process.stderr.write(s),
		exit: (code) => process.exit(code)
	});
	const exitCode = await main(process.argv);
	process.exit(exitCode);
}
//#endregion
export { __URL_STAMP_PROBE__, installSigintHandler, main };

//# sourceMappingURL=cli.mjs.map