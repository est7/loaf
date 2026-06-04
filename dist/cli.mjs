#!/usr/bin/env node
import { Command, CommanderError } from "commander";
import { promises } from "node:fs";
import * as path$1 from "node:path";
import path from "node:path";
import os from "node:os";
import { z } from "zod";
import { createHash, randomBytes } from "node:crypto";
import * as fsp from "node:fs/promises";
import { parse, stringify } from "yaml";
import { createElement, useCallback, useEffect, useMemo, useState } from "react";
import { Box, Text, useApp, useInput } from "ink";
import { jsx, jsxs } from "react/jsx-runtime";
import picomatch from "picomatch";
import { execFileSync, spawn } from "node:child_process";
import { O_APPEND, O_CREAT, O_WRONLY } from "node:constants";
//#region package.json
var version = "0.3.0";
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
//#region i18n/en.json
var en_default = {
	_meta: {
		"schema_version": 1,
		"lang": "en",
		"note": "All keys mirror schemas.ts stable IDs. Diagnostic templates use mustache-style {var} placeholders matched to gate-diagnostic.failures[].vars."
	},
	evidence_kind: {
		"task-summary": "Task summary",
		"verify-review": "Code review",
		"spec-review": "Spec review",
		"acceptance": "Acceptance check",
		"visual-review": "Visual review",
		"gate-decision": "Gate decision",
		"local-check": "Local check",
		"manual": "Manual verification",
		"waiver": "Risk waiver",
		"spike-finding": "Spike finding"
	},
	phase: {
		"TRIAGE": "Triage",
		"SPEC": "Spec",
		"EXECUTE": "Execute",
		"VERIFY": "Verify",
		"SETTLE": "Settle",
		"DONE": "Done"
	},
	sub_state: {
		"TRIAGE": {
			"score": "Triage / score",
			"confirm": "Triage / confirm profile"
		},
		"SPEC": {
			"proposal": "Spec / proposal",
			"spec": "Spec / author EARS+Gherkin",
			"plan": "Spec / plan",
			"design": "Spec / design + tasks"
		},
		"EXECUTE": {
			"plan": "Execute / plan policies",
			"work": "Execute / running task",
			"done": "Execute / all tasks final"
		},
		"VERIFY": {
			"plan": "Verify / applicable checks",
			"run": "Verify / running checks",
			"review": "Verify / review",
			"acceptance": "Verify / acceptance",
			"visual": "Verify / visual",
			"accept": "Verify / accept gate"
		},
		"SETTLE": {
			"reconcile": "Settle / reconcile",
			"lessons": "Settle / lessons"
		},
		"DONE": {
			"delivered": "Done · delivered",
			"archived": "Done · archived",
			"abandoned": "Done · abandoned"
		}
	},
	task_kind: {
		"behavioral": "Behavioral",
		"structural": "Structural",
		"visual-ui": "Visual UI",
		"docs": "Docs",
		"spike": "Spike",
		"chore": "Chore"
	},
	task_status: {
		"pending": "pending",
		"ready": "ready",
		"in_progress": "in_progress",
		"done": "done",
		"abandoned": "abandoned"
	},
	step: {
		"red": "Red (failing test)",
		"implement": "Implement",
		"refactor": "Refactor",
		"mockup": "Mockup",
		"screenshot-compare": "Screenshot compare",
		"draft": "Draft",
		"review": "Review",
		"explore": "Explore",
		"prototype": "Prototype",
		"record": "Record",
		"execute": "Execute"
	},
	verify_check_kind: {
		"run": "Run (test + lint + typecheck)",
		"review": "Review",
		"acceptance": "Acceptance (E2E)",
		"visual": "Visual"
	},
	applicability: {
		"must": "Must",
		"optional": "Optional",
		"na": "Not applicable"
	},
	step_status: {
		"na": "N/A",
		"pending": "Pending",
		"running": "Running",
		"passed": "Passed",
		"failed": "Failed",
		"waived": "Waived"
	},
	finding_category: {
		"spec-gap": "Spec gap",
		"spec-defect": "Spec defect",
		"impl-defect": "Implementation defect",
		"test-defect": "Test defect",
		"new-scope": "New scope",
		"risk-escalation": "Risk escalation"
	},
	finding_action: {
		"amend-spec": "Amend spec",
		"amend-tasks": "Amend tasks",
		"fix-impl": "Fix implementation",
		"fix-test": "Fix test",
		"defer": "Defer (this run)",
		"backlog": "Backlog (next feature)"
	},
	finding_status: {
		"open": "open",
		"closed": "closed"
	},
	gate: {
		"spec-lock": "Spec lock",
		"verify-accept": "Verify accept"
	},
	profile: {
		"quick": "Quick",
		"standard": "Standard",
		"deep": "Deep"
	},
	pending_kind: {
		"ask_user_question": "User input requested",
		"gate_decision": "Gate awaiting human decision",
		"spec_clarification": "Spec clarification needed",
		"finding_decision": "Finding awaiting action",
		"profile_escalation": "Profile escalation pending confirm"
	},
	diagnostic: {
		"MISSING_VERIFIABILITY": "REQ {req_id} must declare measurable, verified_by_scenarios[], or acceptance_na+reason",
		"DRIVES_NOT_BOUND": "REQ {req_id} is not referenced by any task.drives[]",
		"E2E_ACCEPTANCE_UNRESOLVED": "Scenario {scen_id} (tag=e2e) lacks acceptance binding or acceptance_na+reason",
		"VISUAL_CONTRACT_UNRESOLVED": "Visual contract {vis_id} lacks visual-ui task binding or visual_na+reason",
		"TASK_KIND_SCHEMA_INVALID": "Task {task_id} does not match its kind={kind} schema: {reason}",
		"NO_OPEN_CLARIFICATIONS": "spec.md still has open clarifications: {ids}",
		"TASKS_VERSION_MISMATCH": "tasks.based_on.spec ({tasks_ver}) ≠ spec.spec_version ({spec_ver})",
		"EVIDENCE_INCOMPATIBLE": "Evidence {evidence_id} (kind={kind}) cannot satisfy {covered_id}",
		"WAIVER_MISSING_REASON": "Waiver evidence {evidence_id} requires reason ≥10 characters",
		"WAIVER_NOT_HUMAN": "Waiver evidence {evidence_id} actor must start with 'human:'; got {actor}",
		"VISUAL_REVIEW_MISSING_ATTACHMENT": "visual-review evidence {evidence_id} requires at least one attachment with sha256",
		"PATH_OUTSIDE_WRITE_GUARD": "Write to {path} not allowed in sub_state={sub_state} step={step}",
		"PENDING_BLOCKS_ADVANCE": "pending head {pending_id} (kind={kind}) blocks `loaf advance` until resolved",
		"GATE_NOT_PENDING": "`loaf gate decide {gate}` requires pending head kind=gate_decision; current head: {actual_head}",
		"ESCALATION_NOT_PENDING": "`loaf profile escalate --confirm --input <ceremony.json>` requires pending head kind=profile_escalation; current head: {actual_head}",
		"FINDING_TARGET_REQUIRED": "finding action={action} target validation failed ({reason}): task_id={task_id}, step={step}",
		"SPEC_NOT_INITIALIZED": "{kind} blocked: spec_version=0; run `loaf spec submit` first to bump spec_version to 1",
		"SPEC_ALREADY_INITIALIZED": "spec.md already exists at {spec_md_path}; refusing to overwrite",
		"SPEC_LOCKED_NO_DIRECT_EDIT": "{kind} blocked: spec_locked=true; use `loaf finding raise --category spec-gap --action amend-spec` to back-edge into SPEC.spec",
		"AMEND_REJECTED_POST_LOCK": "spec_locked=true; use `loaf finding raise` instead of `loaf amend`",
		"DELIVER_FORBIDDEN_FOR_SPIKE": "spike tasks cannot be delivered; use `loaf archive`, `loaf spike convert`, or `loaf abandon`",
		"DELIVER_NOT_ACCEPTED": "deliver requires verify_accepted=true at sub_state={sub_state}; run `loaf gate decide verify-accept --approve` first",
		"DELIVER_SETTLE_PHASE_BYPASS": "deliver from VERIFY.accept requires ceremony.settle_phase=false (standard); deep ceremony must run `loaf settle` first",
		"DELIVER_VERIFY_MIN_UNAVAILABLE": "verify-min was unavailable in this build (ceremony_label={ceremony_label}) — superseded at v0.1.1 by DELIVER_VERIFY_MIN_INCOMPLETE; no longer emitted",
		"DELIVER_VERIFY_MIN_INCOMPLETE": "verify-min: {count} done task(s) lack required evidence to deliver (ceremony_label={ceremony_label}); add evidence or waive, then re-deliver",
		"DELIVER_SPIKE_TASKS": "cannot deliver: task {task_id} is kind=spike (status={status}); spike tasks block delivery for the entire session",
		"EXECUTE_DONE_TASKS_NOT_FINAL": "cannot advance EXECUTE.work → EXECUTE.done: {count} task(s) are not in a final status (done or abandoned); finish their remaining steps or abandon out-of-scope tasks with `loaf tasks abandon <T-N> --reason \"...\"`",
		"SETTLE_NOT_ACCEPTED": "VERIFY.accept → SETTLE.reconcile requires verify_accepted=true; run `loaf gate decide verify-accept --approve` before `loaf settle`",
		"TASK_NOT_CLAIMABLE": "task {task_id} cannot be claimed (status={status} — terminal state)",
		"TASK_ALREADY_CLAIMED": "task {task_id} is already claimed (status=in_progress)",
		"TASK_DEPS_NOT_SATISFIED": "task {task_id} cannot be claimed: dependency {blocking_dep} is not done (status={blocking_status})",
		"TASK_NOT_CLAIMED": "task {task_id} step {step} mutation requires task.status=in_progress (got status={status}); claim the task first",
		"TASK_NOT_ABANDONABLE": "task {task_id} cannot be abandoned (status={status} — already in a final status)",
		"TASK_ABANDON_BLOCKED_DEPENDENTS": "task {task_id} cannot be abandoned: non-terminal task(s) {blocking_dependents} depend on it; abandon or complete the dependents first",
		"SESSION_REASON_REQUIRED": "{kind}: --reason is required (the session-terminal entry must record why)",
		"PROJECTION_WRITE_FAILED": "{projection} projection write failed after journal append at last_seq={last_seq} (spec_version={spec_version}): {error}",
		"FINDING_AMEND_SPEC_NOT_LOCKED": "finding raise action=amend-spec requires state.spec_locked=true; spec is not locked at sub_state={current_sub_state}, edit directly via `loaf spec submit / add-*`",
		"SPEC_VERSION_NOT_MONOTONIC": "{kind}: spec_version must be {expected_spec_version} (current+1), got {payload_spec_version}",
		"SPEC_VERSION_BATCH_MISMATCH": "{kind}: spec_version must be {current_spec_version} at batch_index={batch_index}, got {payload_spec_version}",
		"TASK_COMPLETE_PRECONDITION_VIOLATED": "task {task_id} is not complete (status={status}); must-applicable steps not terminal-positive: {blocking_steps}",
		"MUTATION_OUT_OF_RIGHTS": "event:tasks_amended on task {task_id} is not permitted at sub_state {sub_state} — §8.6 grants no mutation right for this change",
		"CANONICAL_TASK_BODY_UNAVAILABLE": "task {task_id} is in the projection but has no canonical body in the journal (migration-imported); a whole-task amend cannot be reconstructed",
		"BUG_TASK_REQUIRES_RED": "behavioral bug task {task_id} cannot start or complete its implement step before its RED test is registered",
		"BUG_TASK_FLAG_MISUSE": "task {task_id}: red_test_registered=true is valid only on a red-step task_step_done for a behavioral bug task (passed/waived result) — not on this entry",
		"BUG_TASK_RED_NOT_REGISTERED": "behavioral bug task {task_id} is done but never registered its RED test (red_test_registered≠true)",
		"SPIKE_CONVERT_NO_SPIKE_TASK": "cannot convert: the session has no non-abandoned spike task; `loaf spike convert` is a spike-task exit (protocol §8.3)",
		"DONE_TERMINAL_INVARIANT": "DONE.* requires state.pending.length === 0 and no task with status=\"in_progress\" in tasks.json",
		"ABANDON_REQUIRES_REASON": "loaf abandon requires --reason argument",
		"TASKS_EXECUTION_DRIFT": "Task {task_id} step={step} status={status} disagrees with evidence.jsonl",
		"COVERAGE_NOT_SATISFIED": "{covered_id} has no evidence that satisfies it (canSatisfy failed for all candidates)",
		"NO_SESSION": "no session at {feature_dir} — run `loaf start <feature>` first",
		"SNAPSHOT_STALE_REBUILD_REQUIRED": "snapshot stale (reason={reason}) at {feature_dir}; run `loaf doctor --rebuild --feature <feature>` to re-serialize from journal truth",
		"INVALID_PRESET": "invalid ceremony preset",
		"USAGE": "invalid CLI usage",
		"DOCTOR_MODE_NOT_IMPLEMENTED": "requested loaf doctor mode is not implemented in this release",
		"DOCTOR_FEATURE_REQUIRED": "loaf doctor --rebuild requires --feature <name>",
		"DOCTOR_REBUILD_FAILED": "doctor --rebuild failed",
		"DOCTOR_REBUILD_MIGRATED_UNSUPPORTED": "doctor --rebuild does not support v0.0.x-migrated journals in this release",
		"REDUCER_ERROR": "internal reducer invariant failed",
		"INVALID_FORMAT": "invalid --format value '{value}'; allowed: {allowed_values_human}",
		"INVALID_LOCALE": "invalid locale from {source}: {value} (expected {accepted})",
		"MUTUALLY_EXCLUSIVE_FLAGS": "mutually exclusive flags in the same invocation: {flags}",
		"DRY_RUN_NOT_APPLICABLE": "--dry-run not applicable to {command_type} command `{command}`",
		"HOOK_EVENT_NOT_IMPLEMENTED": "hook event `{event}` is not implemented in this loaf version (Phase 16 SC-15{sub_cycle} pending; see protocol §11)",
		"WRITE_PATH_VIOLATION": "write blocked: `{normalized_path}` is outside the allowed write paths for sub_state `{sub_state}`",
		"PROTECTED_FILE_WRITE": "write blocked: `{normalized_path}` matches protected_files entry `{matched_deny}` — protected files are never writable",
		"FEATURE_NOT_FOUND": "no feature found in cwd (.loaf/ is empty or missing, or no projection has phase != DONE)",
		"FEATURE_AMBIGUOUS": "current working directory has {count} active features and no dispatch context: {feature_list}",
		"SESSION_CWD_MISMATCH": "--session {uuid} is registered against cwd={registered_cwd}, but the current cwd is {current_cwd}",
		"SESSION_SHORT_AMBIGUOUS": "--session {prefix} matches {match_count} sessions in the registry: {candidate_list}",
		"SESSION_NOT_FOUND": "--session {uuid_or_prefix} matches no entry in the registry"
	},
	failure: {
		"sessions_list": { "selector_conflict": "sessions list does not accept {conflicting} — it lists across all sessions; use --in-cwd to filter" },
		"tui": {
			"selector_conflict": "tui does not accept {conflicting} — it lists across all sessions; selectors are nonsensical for an interactive UI",
			"interactive_only": "tui is interactive-only; use `loaf sessions list --format json` for scriptable session output"
		},
		"hook": {
			"missing_event": "loaf hook requires an event token; one of: {events}. Run `loaf hook --list-events` for the full enum",
			"unknown_event": "unknown hook event '{event}'; expected one of: {allowed}. Did you mean '{suggestion}'?",
			"stdin_parse_failed": "{reason}",
			"write_path_missing": "write-side hook requires --path <P> or a non-TTY stdin hook payload (tool_input.file_path)"
		},
		"check": {
			"selector_conflict": "check does not accept {conflicting} — it validates a file by path, independent of any feature session",
			"kind_required": "`{subject}` is not a file path. To validate a {kind} artifact, pass its path: `{suggestion}` (noun-first `loaf {kind} check` is reserved for a future release)",
			"path_missing": "file not found: {path}",
			"kind_invalid": "--kind '{value}' is not recognized; expected one of {allowed_kinds_human}"
		},
		"schema": {
			"selector_conflict": "{subject} does not accept {conflicting} — schema dumps are feature-agnostic",
			"validation": "{kind} at {path} failed schema validation ({error_count} {error_word})"
		},
		"dispatch": {
			"session_feature_dir_conflict": "{conflicting} cannot be combined with --feature-dir (session identity comes from registry; manual featureDir is contradictory)",
			"feature_dir_requires_feature": "--feature-dir requires --feature <name> or $LOAF_FEATURE to name the feature"
		},
		"start": {
			"label_too_short": "--label must be at least {min_length} characters",
			"workspace_empty": "--workspace must not be empty"
		},
		"handoff": {
			"reason_too_short": "--reason must be ≥{min_length} chars (got {reason_length})",
			"pack_validation_failed": "ResumePack failed runtime validation (builder bug or schema drift)"
		},
		"profile": {
			"input_file_missing": "input file does not exist: {path}",
			"input_file_unreadable": "cannot read input file {path}: {error}"
		},
		"tasks_add": { "empty_array": "tasks add input is an empty array" },
		"lessons": {
			"text_too_short": "lesson text must be ≥{min_length} chars (got {lesson_text_length})",
			"reason_too_short": "--reason must be ≥{min_length} chars (got {reason_length})",
			"text_file_mutex": "exactly one of --text or --file required ({provided_state})",
			"file_missing": "lesson file not found: {path}"
		},
		"finding": { "status_invalid": "--status must be one of: {allowed_statuses_human} (got {value})" },
		"write_guard": { "config_invalid": "write-guard blocked: {reason}" },
		"no_session": {
			"status": "run `loaf start {feature}` first",
			"advance": "run `loaf start {feature}` first",
			"tasks": "run `loaf start {feature}` first",
			"pending": "run `loaf start {feature}` first",
			"finding": "run `loaf start {feature}` first",
			"verify": "run `loaf start {feature}` first",
			"generic": "run `loaf start {feature}` first"
		}
	},
	success: {
		"next": {
			"advance": "loaf advance",
			"deliver": "loaf deliver",
			"settle": "loaf settle"
		},
		"start": { "state_change": "start: '{feature}' created → TRIAGE.score" },
		"advance": { "state_change": "advance: {from} → {to}" },
		"gate": {
			"spec_lock_approved_state_change": "gate decide: spec-lock approved by {actor}",
			"verify_accept_approved_state_change": "gate decide: verify-accept approved by {actor}",
			"rejected_state_change": "gate decide: {gate} rejected by {actor}"
		},
		"deliver": {
			"state_change": "deliver: {feature} — {from} → DONE.delivered by {actor}",
			"next": "session complete — `loaf start <feature>` to begin another"
		},
		"archive": { "state_change": "archive: {feature} — {from} → DONE.archived by {actor}" },
		"abandon": { "state_change": "abandon: {feature} — {from} → DONE.abandoned by {actor} (reason='{reason}')" },
		"spike": { "convert_state_change": "spike convert: {feature} → {to_feature} — {from} → DONE.archived by {actor}" },
		"profile": { "escalate_state_change": "profile escalate: ceremony updated, {pending_id} resolved" },
		"tasks": {
			"submit_text_one": "submitted {count} task: {task_ids}",
			"submit_text_many": "submitted {count} tasks: {task_ids}",
			"submit_state_change": "tasks submit: {count} tasks",
			"add_text_one": "added {count} task: {task_ids}",
			"add_text_many": "added {count} tasks: {task_ids}",
			"add_sponsored_text_one": "added {count} task (sponsored by {finding}): {task_ids}",
			"add_sponsored_text_many": "added {count} tasks (sponsored by {finding}): {task_ids}",
			"add_state_change": "tasks add: +{count} tasks (allocated {task_ids})",
			"claim_state_change": "tasks claim: {task_id} (status={status})",
			"abandon_state_change": "tasks abandon: {task_id} (status={status})",
			"register_red_state_change": "tasks register-red: {task_id}"
		},
		"doctor": {
			"rebuild_text_one": "rebuilt {count} projection file for {feature}:",
			"rebuild_text_many": "rebuilt {count} projection files for {feature}:",
			"rebuild_state_change_one": "doctor rebuild: rebuilt {count} projection file for {feature}",
			"rebuild_state_change_many": "doctor rebuild: rebuilt {count} projection files for {feature}"
		},
		"snapshot": { "as_of_seq": "# snapshot as-of seq={seq}" },
		"amend": {
			"sponsored_text": "amended {task_id} (sponsored by {finding_id})",
			"policy_text": "amended {task_id} ({applied})",
			"state_change": "amend: {task_id}"
		},
		"step": {
			"start_state_change": "step start: {task_id} {step} (running)",
			"done_text": "done {task_id} step={step} result={result}{evidence_suffix}{promote_suffix}",
			"done_evidence_suffix": " evidence={evidence_id}",
			"done_promote_suffix": " (task auto-promoted to done)",
			"done_state_change": "step done: {task_id} {step} ({result})"
		},
		"settle": {
			"text": "",
			"state_change": "settle: {from} → SETTLE.reconcile"
		},
		"resume": { "state_change": "resume: session {session_id} (sub_state={sub_state} unchanged)" },
		"handoff": { "state_change": "handoff: resume-pack.json written by {actor}" },
		"pending": {
			"raise_state_change": "pending raise: {pending_id} (kind={kind})",
			"resolve_text": "resolved {pending_id} (kind={kind})",
			"resolve_state_change": "pending resolve: {pending_id} cleared"
		},
		"waive": { "state_change": "waive: {evidence_id} obligation={obligation_id}" },
		"lessons": { "add_state_change": "lessons add: {evidence_id} recorded (kind=manual; lessons.md updated)" },
		"evidence": {
			"covers_none": "<none>",
			"add_state_change_single": "evidence add: {evidence_id} kind={kind}, covers={covers}",
			"add_state_change_batch_homogeneous": "evidence add: +{count} evidence ({evidence_ids}; kind={kind}, covers={covers})",
			"add_state_change_batch_mixed": "evidence add: +{count} evidence ({evidence_ids})"
		},
		"finding": {
			"close_text": "closed {finding_id}",
			"close_state_change": "finding close: {finding_id} → closed"
		},
		"spec": {
			"submit_text": "spec submitted v{spec_version}: {req_count} req / {scen_count} scen / {vis_count} vis",
			"submit_state_change": "spec submit: spec_version={spec_version}, locked=false",
			"submit_next": "loaf gate decide spec-lock",
			"init_state_change": "spec init: wrote scaffold to {path}",
			"init_next": "edit, then `loaf spec submit`",
			"edit_text": "spec edit: spec_version={spec_version}",
			"edit_state_change": "spec edit: spec_version={spec_version} via $EDITOR",
			"add_req_text_one": "spec add-req v{spec_version}: {ids}",
			"add_req_text_many": "spec add-req v{spec_version}: {ids}",
			"add_req_state_change_one": "spec add-req: +{count} REQ (spec_version={spec_version}; allocated {ids})",
			"add_req_state_change_many": "spec add-req: +{count} REQ (spec_version={spec_version}; allocated {ids})",
			"add_scenario_text_one": "spec add-scenario v{spec_version}: {ids}",
			"add_scenario_text_many": "spec add-scenario v{spec_version}: {ids}",
			"add_scenario_state_change_one": "spec add-scenario: +{count} SCENARIO (spec_version={spec_version}; allocated {ids})",
			"add_scenario_state_change_many": "spec add-scenario: +{count} SCENARIO (spec_version={spec_version}; allocated {ids})",
			"add_visual_text_one": "spec add-visual v{spec_version}: {ids}",
			"add_visual_text_many": "spec add-visual v{spec_version}: {ids}",
			"add_visual_state_change_one": "spec add-visual: +{count} VISUAL (spec_version={spec_version}; allocated {ids})",
			"add_visual_state_change_many": "spec add-visual: +{count} VISUAL (spec_version={spec_version}; allocated {ids})"
		}
	},
	chrome: {
		"status": {
			"feature": "feature: {feature}",
			"phase": "phase:   {phase}",
			"cursor": "cursor:  {cursor}",
			"tail": "tail:    seq={seq}",
			"counts": "tasks={tasks_count} evidence={evidence_count} findings={findings_count} pending={pending_count}",
			"snapshot_as_of_projection_loader": "# snapshot as-of seq={seq} (projection-loader, Phase 15 SC3)"
		},
		"tasks": {
			"list_empty_filtered": "no tasks match --status={status}",
			"list_empty": "no tasks in projection (run `loaf tasks submit` first)",
			"ready_marker": "ready",
			"list_row": "{task_id} {kind} {status}",
			"list_row_ready": "{task_id} {kind} {status} [{ready}]",
			"complete_text": "{task_id} complete (status={status})"
		},
		"pending": {
			"list_row": "{pending_id} {kind} {status} {head}",
			"no_open": "no open pending",
			"open": "open",
			"resolved": "resolved",
			"head": "head",
			"non_head": "-"
		},
		"finding": { "list_row": "{finding_id} {category} {action} {status}" },
		"sessions": {
			"empty": "(no sessions found)",
			"warning": "registry entry {file} {action} ({reason}{detail_suffix})",
			"action_skipped": "skipped",
			"action_filtered_out": "filtered out",
			"action_orphan_cwd": "has orphan cwd"
		},
		"relative": {
			"just_now": "just now",
			"minute_one": "{count} minute ago",
			"minute_many": "{count} minutes ago",
			"hour_one": "{count} hour ago",
			"hour_many": "{count} hours ago",
			"day_one": "{count} day ago",
			"day_many": "{count} days ago"
		},
		"check": { "ok": "ok: {kind} at {path}" },
		"verify_status": {
			"pass": "pass",
			"fail": "fail",
			"na": "na",
			"check_lane_status": "lane_status",
			"check_open_findings": "open_findings",
			"check_coverage": "coverage",
			"check_task_evidence": "task_evidence",
			"check_spec_review": "spec_review",
			"failure_summary_one": " {code}",
			"failure_summary_many": " {count} failures ({code}, …)",
			"diagnostic_only": "(diagnostic only — gate verdict not implied)"
		},
		"tui": {
			"list": {
				"title": "loaf sessions ({active_count} active / {total_count} total)",
				"sort": "sort: {sort}",
				"sort_time": "time",
				"sort_status": "status",
				"reloading": "reloading…",
				"empty": "(no sessions found)",
				"help": "[↑/↓] move · [space] fold · [a] active/all · [s] sort · [r] refresh · [q] quit",
				"row_iteration": "iter {value}"
			},
			"detail": {
				"title": "loaf detail",
				"help": "[Esc] back · [q] quit",
				"no_selected": "(no detail selected)",
				"loading": "loading…",
				"missing_title": "missing: {feature}",
				"missing_message": "run `loaf start {feature}` first",
				"stale_title": "stale: {feature}",
				"stale_message": "snapshot stale (reason={reason})",
				"error_title": "error: {feature}",
				"none": "(none)",
				"boolean_true": "true",
				"boolean_false": "false",
				"field_feature": "feature: {value}",
				"field_session": "session: {value}",
				"field_label": "label: {value}",
				"field_workspace": "workspace: {value}",
				"field_ceremony": "ceremony: {value}",
				"field_phase": "phase: {value}",
				"field_iteration": "iteration: {value}",
				"field_complexity": "complexity: {value}",
				"field_based_on": "based_on: spec {spec} / tasks {tasks}",
				"field_created": "created: {value}",
				"field_updated": "updated: {value}",
				"field_spec_locked": "spec_locked: {value}",
				"field_verify_accepted": "verify_accepted: {value}",
				"field_spec_version": "spec_version: {value}",
				"field_tail_seq": "tail_seq: {value}",
				"section_tasks": "tasks ({count})",
				"section_evidence": "evidence ({count})",
				"section_open_findings": "open findings ({count})",
				"section_pending": "pending ({count})",
				"evidence_badge_pass": "pass",
				"evidence_badge_fail": "fail",
				"evidence_badge_waived": "waived",
				"sidecar_summary": "sidecar:{path}",
				"step_summary": "{done}/{total} done",
				"row_steps": "steps {value}",
				"row_iteration": "iter {value}",
				"row_task": "task {value}",
				"row_target": "target {value}",
				"row_blocks": "blocks={value}",
				"row_options": "options={value}"
			}
		}
	},
	help: {
		"start": "Begin a new feature session in .loaf/<feature>/",
		"status": "Print current state.json + artifact health summary",
		"next": "Compute the next owner command for the current session",
		"advance": "Run next transition + diff guard (git status + write_paths AND-merge)",
		"resume": "Resume session; --fresh prints minimal context pack for next iteration",
		"handoff": "Write resume-pack.json for context overflow handoff",
		"spec_submit": "Validate spec.md against SpecFrontmatter schema and record (strict).",
		"spec_init": "Scaffold a spec.md template ready for $EDITOR",
		"spec_schema": "Dump SpecFrontmatter JSON Schema",
		"tasks_submit": "Validate tasks.json against discriminated-union TaskKind schema",
		"tasks_register_red": "Register failing test for a behavioral-bug task (required before implement)",
		"evidence_add": "Append a new evidence entry; auto-assign EV-id",
		"evidence_schema": "Dump EvidenceEntry JSON Schema",
		"waive": "Record a waiver evidence; actor must start with human: and reason must be >=10 chars",
		"finding_raise": "Raise a finding (VERIFY.* always, EXECUTE.* only post-spec-lock)",
		"verify_status": "Compute current verify check applicability + status (real-time, never reads reconcile.json)",
		"gate_decide": "Record human gate decision; writes evidence kind=gate-decision",
		"settle": "Generate reconcile.json (standard+ profile)",
		"amend": "Edit spec or tasks pre-lock (rejected post-lock; use findings instead)",
		"profile_escalate": "Confirm pending profile escalation",
		"deliver": "Close session as DONE.delivered (advisory only; no git/gh side effects)",
		"archive": "Close session as DONE.archived",
		"abandon": "Close session as DONE.abandoned (reason required)",
		"tui": "Launch session manager TUI (reads ~/.loaf/registry/)",
		"sessions_list": "List all sessions (non-TUI form)",
		"check": "Schema-only check for a given artifact or path (CI usage)",
		"check_tasks": "Reconcile tasks.execution.status (cache) with evidence.jsonl (proof)",
		"hook": "Claude Code hook entrypoint",
		"doctor": "Self-diagnose loaf-cli installation, repo layout, config"
	},
	status_indicator: {
		"ask": "‖ ask",
		"gate": "‖ gate",
		"run": "▶ run",
		"done": "✓ done",
		"fail": "✗ fail",
		"wait": "⏳ wait",
		"idle": "idle"
	}
};
//#endregion
//#region i18n/zh.json
var zh_default = {
	_meta: {
		"schema_version": 1,
		"lang": "zh",
		"note": "所有 key 对应 schemas.ts 稳定英文 ID。diagnostic 模板用 mustache 风格 {var} 占位,从 gate-diagnostic.failures[].vars 取值。"
	},
	evidence_kind: {
		"task-summary": "任务总结",
		"verify-review": "代码评审",
		"spec-review": "规格评审",
		"acceptance": "验收检查",
		"visual-review": "视觉评审",
		"gate-decision": "Gate 决策",
		"local-check": "本地检查",
		"manual": "人工验证",
		"waiver": "风险豁免",
		"spike-finding": "Spike 发现"
	},
	phase: {
		"TRIAGE": "分诊",
		"SPEC": "规格",
		"EXECUTE": "执行",
		"VERIFY": "验证",
		"SETTLE": "结算",
		"DONE": "完成"
	},
	sub_state: {
		"TRIAGE": {
			"score": "分诊 / 打分",
			"confirm": "分诊 / 确认 profile"
		},
		"SPEC": {
			"proposal": "规格 / 提案",
			"spec": "规格 / 编写 EARS+Gherkin",
			"plan": "规格 / 计划",
			"design": "规格 / 设计 + tasks"
		},
		"EXECUTE": {
			"plan": "执行 / 推导策略",
			"work": "执行 / 任务进行中",
			"done": "执行 / 所有任务终态"
		},
		"VERIFY": {
			"plan": "验证 / 计算适用检查",
			"run": "验证 / 检查进行中",
			"review": "验证 / 评审",
			"acceptance": "验证 / 验收",
			"visual": "验证 / 视觉",
			"accept": "验证 / 接收 gate"
		},
		"SETTLE": {
			"reconcile": "结算 / 对账",
			"lessons": "结算 / 经验沉淀"
		},
		"DONE": {
			"delivered": "完成 · 已交付",
			"archived": "完成 · 已归档",
			"abandoned": "完成 · 已弃置"
		}
	},
	task_kind: {
		"behavioral": "行为",
		"structural": "结构",
		"visual-ui": "视觉 UI",
		"docs": "文档",
		"spike": "探索",
		"chore": "杂务"
	},
	task_status: {
		"pending": "待处理",
		"ready": "就绪",
		"in_progress": "进行中",
		"done": "完成",
		"abandoned": "已放弃"
	},
	step: {
		"red": "红测(失败用例)",
		"implement": "实现",
		"refactor": "重构",
		"mockup": "模拟图",
		"screenshot-compare": "截图对比",
		"draft": "草稿",
		"review": "评审",
		"explore": "探索",
		"prototype": "原型",
		"record": "记录",
		"execute": "执行"
	},
	verify_check_kind: {
		"run": "运行(测试 + lint + 类型检查)",
		"review": "评审",
		"acceptance": "验收(E2E)",
		"visual": "视觉"
	},
	applicability: {
		"must": "必须",
		"optional": "可选",
		"na": "不适用"
	},
	step_status: {
		"na": "不适用",
		"pending": "待处理",
		"running": "进行中",
		"passed": "通过",
		"failed": "失败",
		"waived": "已豁免"
	},
	finding_category: {
		"spec-gap": "规格缺漏",
		"spec-defect": "规格错误",
		"impl-defect": "实现缺陷",
		"test-defect": "测试缺陷",
		"new-scope": "范围外新议",
		"risk-escalation": "风险升级"
	},
	finding_action: {
		"amend-spec": "修订规格",
		"amend-tasks": "修订任务",
		"fix-impl": "修实现",
		"fix-test": "修测试",
		"defer": "本轮延迟",
		"backlog": "进 backlog(下个 feature)"
	},
	finding_status: {
		"open": "开放",
		"closed": "已关闭"
	},
	gate: {
		"spec-lock": "规格锁定",
		"verify-accept": "验证接收"
	},
	profile: {
		"quick": "Quick(快速)",
		"standard": "Standard(标准)",
		"deep": "Deep(深度)"
	},
	pending_kind: {
		"ask_user_question": "等待用户输入",
		"gate_decision": "Gate 等待人工决策",
		"spec_clarification": "规格待澄清",
		"finding_decision": "Finding 等待 action",
		"profile_escalation": "Profile 升级待确认"
	},
	diagnostic: {
		"MISSING_VERIFIABILITY": "需求 {req_id} 必须声明 measurable、verified_by_scenarios[] 或 acceptance_na+reason 三选一",
		"DRIVES_NOT_BOUND": "需求 {req_id} 没有被任何 task.drives[] 引用",
		"E2E_ACCEPTANCE_UNRESOLVED": "场景 {scen_id}(tag=e2e)既没有 task 验收绑定,也没有 acceptance_na+reason",
		"VISUAL_CONTRACT_UNRESOLVED": "视觉合约 {vis_id} 既没有 visual-ui task 引用,也没有 visual_na+reason",
		"TASK_KIND_SCHEMA_INVALID": "任务 {task_id} 不符合 kind={kind} 的 schema:{reason}",
		"NO_OPEN_CLARIFICATIONS": "spec.md 仍有未解决的 clarifications: {ids}",
		"TASKS_VERSION_MISMATCH": "tasks.based_on.spec({tasks_ver})≠ spec.spec_version({spec_ver})",
		"EVIDENCE_INCOMPATIBLE": "证据 {evidence_id}(kind={kind})不能满足 {covered_id} 的覆盖要求",
		"WAIVER_MISSING_REASON": "豁免证据 {evidence_id} 必须有 reason(≥10 字符)",
		"WAIVER_NOT_HUMAN": "豁免证据 {evidence_id} 的 actor 必须以 'human:' 开头,当前 {actor}",
		"VISUAL_REVIEW_MISSING_ATTACHMENT": "visual-review 证据 {evidence_id} 必须带至少一个含 sha256 的 attachment",
		"PATH_OUTSIDE_WRITE_GUARD": "在 sub_state={sub_state} step={step} 下,禁止写入 {path}",
		"PENDING_BLOCKS_ADVANCE": "pending head {pending_id}(kind={kind})阻塞 `loaf advance`,需先 resolve",
		"GATE_NOT_PENDING": "`loaf gate decide {gate}` 要求 pending head kind=gate_decision;当前 head:{actual_head}",
		"ESCALATION_NOT_PENDING": "`loaf profile escalate --confirm --input <ceremony.json>` 要求 pending head kind=profile_escalation;当前 head:{actual_head}",
		"FINDING_TARGET_REQUIRED": "finding action={action} target 校验失败({reason}):task_id={task_id}, step={step}",
		"SPEC_NOT_INITIALIZED": "{kind} 被拒:spec_version=0;先跑 `loaf spec submit` 把 spec_version 升到 1",
		"SPEC_ALREADY_INITIALIZED": "spec.md 已存在于 {spec_md_path};拒绝覆盖",
		"SPEC_LOCKED_NO_DIRECT_EDIT": "{kind} 被拒:spec_locked=true;用 `loaf finding raise --category spec-gap --action amend-spec` 走 amend-spec 回退到 SPEC.spec",
		"AMEND_REJECTED_POST_LOCK": "spec_locked=true;使用 `loaf finding raise` 替代 `loaf amend`",
		"DELIVER_FORBIDDEN_FOR_SPIKE": "spike 任务不允许 deliver;使用 `loaf archive` / `loaf spike convert` / `loaf abandon`",
		"DELIVER_NOT_ACCEPTED": "deliver 要求 verify_accepted=true(sub_state={sub_state});先运行 `loaf gate decide verify-accept --approve`",
		"DELIVER_SETTLE_PHASE_BYPASS": "VERIFY.accept 直接 deliver 要求 ceremony.settle_phase=false(standard);deep ceremony 必须先运行 `loaf settle`",
		"DELIVER_VERIFY_MIN_UNAVAILABLE": "verify-min 在此 build 不可用(ceremony_label={ceremony_label})—— v0.1.1 起由 DELIVER_VERIFY_MIN_INCOMPLETE 取代,已不再触发",
		"DELIVER_VERIFY_MIN_INCOMPLETE": "verify-min:{count} 个 done task 缺少 deliver 所需 evidence(ceremony_label={ceremony_label});补 evidence 或 waive 后重试 deliver",
		"DELIVER_SPIKE_TASKS": "无法 deliver:task {task_id} 是 kind=spike(status={status});spike 任务阻塞整 session 的交付",
		"EXECUTE_DONE_TASKS_NOT_FINAL": "无法从 EXECUTE.work 推进到 EXECUTE.done:{count} 个 task 未处于终态(done 或 abandoned);跑完剩余 step,或用 `loaf tasks abandon <T-N> --reason \"...\"` 放弃超出范围的 task",
		"SETTLE_NOT_ACCEPTED": "VERIFY.accept → SETTLE.reconcile 要求 verify_accepted=true;先运行 `loaf gate decide verify-accept --approve` 再 `loaf settle`",
		"TASK_NOT_CLAIMABLE": "task {task_id} 无法 claim(status={status} — 终态)",
		"TASK_ALREADY_CLAIMED": "task {task_id} 已被 claim(status=in_progress)",
		"TASK_DEPS_NOT_SATISFIED": "task {task_id} 无法 claim:依赖 {blocking_dep} 未 done(status={blocking_status})",
		"TASK_NOT_CLAIMED": "task {task_id} step {step} 变更要求 task.status=in_progress(实际 status={status});先 `loaf tasks claim`",
		"TASK_NOT_ABANDONABLE": "task {task_id} 无法 abandon(status={status} — 已处于终态)",
		"TASK_ABANDON_BLOCKED_DEPENDENTS": "task {task_id} 无法 abandon:非终态 task {blocking_dependents} 依赖它;先 abandon 或完成这些依赖方",
		"SESSION_REASON_REQUIRED": "{kind}:必须提供 --reason(会话终态 entry 必须记录原因)",
		"PROJECTION_WRITE_FAILED": "{projection} 派生投影在 journal append (last_seq={last_seq}, spec_version={spec_version}) 后写盘失败:{error}",
		"FINDING_AMEND_SPEC_NOT_LOCKED": "finding raise action=amend-spec 要求 state.spec_locked=true;当前 sub_state={current_sub_state} 下 spec 未锁,请直接使用 `loaf spec submit / add-*`",
		"SPEC_VERSION_NOT_MONOTONIC": "{kind}: spec_version 必须等于 {expected_spec_version}(current+1),实际为 {payload_spec_version}",
		"SPEC_VERSION_BATCH_MISMATCH": "{kind}: batch_index={batch_index} 处 spec_version 必须等于 {current_spec_version},实际为 {payload_spec_version}",
		"TASK_COMPLETE_PRECONDITION_VIOLATED": "task {task_id} 尚未完成(status={status});以下 must 级 step 未达 terminal-positive:{blocking_steps}",
		"MUTATION_OUT_OF_RIGHTS": "task {task_id} 的 event:tasks_amended 在 sub_state {sub_state} 不被允许 —— §8.6 未授予该改动的 mutation right",
		"CANONICAL_TASK_BODY_UNAVAILABLE": "task {task_id} 在投影中存在,但 journal 里没有 canonical body(migration 导入);无法重建整 task 的 amend",
		"BUG_TASK_REQUIRES_RED": "behavioral bug task {task_id} 在注册 RED 测试前不能开始或完成 implement step",
		"BUG_TASK_FLAG_MISUSE": "task {task_id}:red_test_registered=true 只在 behavioral bug task 的 red-step task_step_done(passed/waived)上有效 —— 不能用在本 entry",
		"BUG_TASK_RED_NOT_REGISTERED": "behavioral bug task {task_id} 已 done 但从未注册 RED 测试(red_test_registered≠true)",
		"SPIKE_CONVERT_NO_SPIKE_TASK": "无法 convert:session 没有非-abandoned 的 spike task;`loaf spike convert` 是 spike-task 出口(protocol §8.3)",
		"DONE_TERMINAL_INVARIANT": "DONE.* 状态要求 state.pending.length === 0 且 tasks.json 中无 status=\"in_progress\" 的 task",
		"ABANDON_REQUIRES_REASON": "loaf abandon 必须带 --reason 参数",
		"TASKS_EXECUTION_DRIFT": "任务 {task_id} step={step} status={status} 与 evidence.jsonl 不一致",
		"COVERAGE_NOT_SATISFIED": "{covered_id} 没有任何证据满足覆盖(canSatisfy 对所有候选 evidence 都失败)",
		"NO_SESSION": "{feature_dir} 下没有 session — 先跑 `loaf start <feature>`",
		"SNAPSHOT_STALE_REBUILD_REQUIRED": "snapshot 失效(reason={reason}) at {feature_dir};跑 `loaf doctor --rebuild --feature <feature>` 从 journal 重建",
		"INVALID_PRESET": "ceremony preset 不合法",
		"USAGE": "CLI 用法不合法",
		"DOCTOR_MODE_NOT_IMPLEMENTED": "当前发布版本未实现该 loaf doctor 模式",
		"DOCTOR_FEATURE_REQUIRED": "loaf doctor --rebuild 必须带 --feature <name>",
		"DOCTOR_REBUILD_FAILED": "doctor --rebuild 失败",
		"DOCTOR_REBUILD_MIGRATED_UNSUPPORTED": "当前发布版本的 doctor --rebuild 不支持 v0.0.x-migrated journal",
		"REDUCER_ERROR": "reducer 内部不变量失败",
		"INVALID_FORMAT": "无效的 --format 值 '{value}';合法值:{allowed_values_human}",
		"INVALID_LOCALE": "locale 来源 {source} 的值无效:{value}(期望:{accepted})",
		"MUTUALLY_EXCLUSIVE_FLAGS": "同一次调用使用了互斥的 flags:{flags}",
		"DRY_RUN_NOT_APPLICABLE": "--dry-run 不适用于{command_type}命令 `{command}`",
		"HOOK_EVENT_NOT_IMPLEMENTED": "hook event `{event}` 在当前 loaf 版本未实装(Phase 16 SC-15{sub_cycle} 待实现;详 protocol §11)",
		"WRITE_PATH_VIOLATION": "写入被拦截:`{normalized_path}` 不在 sub_state `{sub_state}` 的允许写入路径内",
		"PROTECTED_FILE_WRITE": "写入被拦截:`{normalized_path}` 命中 protected_files 条目 `{matched_deny}` —— 受保护文件永不可写",
		"FEATURE_NOT_FOUND": "当前 cwd 找不到 feature(.loaf/ 为空或缺失,或所有 projection 已 DONE)",
		"FEATURE_AMBIGUOUS": "当前 cwd 有 {count} 个 active feature 但无 dispatch 上下文:{feature_list}",
		"SESSION_CWD_MISMATCH": "--session {uuid} 注册的 cwd={registered_cwd},当前 cwd 是 {current_cwd}",
		"SESSION_SHORT_AMBIGUOUS": "--session {prefix} 在 registry 匹配 {match_count} 个 session:{candidate_list}",
		"SESSION_NOT_FOUND": "--session {uuid_or_prefix} 在 registry 找不到任何匹配"
	},
	failure: {
		"sessions_list": { "selector_conflict": "sessions list 不接受 {conflicting} —— 它会跨全部 session 列表;如需过滤当前 cwd,使用 --in-cwd" },
		"tui": {
			"selector_conflict": "tui 不接受 {conflicting} —— 它会跨全部 session 列表;selector 对交互 UI 没有意义",
			"interactive_only": "tui 仅支持交互模式;脚本化 session 输出请使用 `loaf sessions list --format json`"
		},
		"hook": {
			"missing_event": "loaf hook 需要 event token;可选值:{events}. 运行 `loaf hook --list-events` 查看完整枚举",
			"unknown_event": "未知 hook event '{event}';期望值:{allowed}. 你是不是想输入 '{suggestion}'?",
			"stdin_parse_failed": "hook stdin payload 解析失败:{reason}",
			"write_path_missing": "write-side hook 需要 --path <P> 或非 TTY stdin hook payload(tool_input.file_path)"
		},
		"check": {
			"selector_conflict": "check 不接受 {conflicting} —— 它按路径校验文件,独立于 feature session",
			"kind_required": "`{subject}` 不是文件路径. 如需校验 {kind} artifact,需要显式路径: `{suggestion}`(noun-first `loaf {kind} check` 预留给未来版本)",
			"path_missing": "input file 不存在:{path}",
			"kind_invalid": "--kind 必须是 {allowed_kinds_human};当前为 '{value}'"
		},
		"schema": {
			"selector_conflict": "{subject} 不接受 {conflicting} —— schema dump 与 feature 无关",
			"validation": "{kind} at {path} 校验失败({error_count} {error_word})"
		},
		"dispatch": {
			"session_feature_dir_conflict": "{conflicting} 不能与 --feature-dir 一起使用(session identity 来自 registry;手动 featureDir 会矛盾)",
			"feature_dir_requires_feature": "--feature-dir 需要 --feature <name> 或 $LOAF_FEATURE 来命名 feature"
		},
		"start": {
			"label_too_short": "--label 至少需要 {min_length} 个字符",
			"workspace_empty": "--workspace 不能为空"
		},
		"handoff": {
			"reason_too_short": "--reason 必须 ≥{min_length} 字符(当前 {reason_length})",
			"pack_validation_failed": "ResumePack 运行时校验失败(builder bug 或 schema drift)"
		},
		"profile": {
			"input_file_missing": "input file 不存在:{path}",
			"input_file_unreadable": "无法读取 input file {path}:{error}"
		},
		"tasks_add": { "empty_array": "tasks add 输入不能为空数组" },
		"lessons": {
			"text_too_short": "lesson text 必须 ≥{min_length} 字符(当前 {lesson_text_length})",
			"reason_too_short": "--reason 必须 ≥{min_length} 字符(当前 {reason_length})",
			"text_file_mutex": "--text 和 --file 必须二选一({provided_state})",
			"file_missing": "lesson file 不存在:{path}"
		},
		"finding": { "status_invalid": "--status 必须是:{allowed_statuses_human}(当前 {value})" },
		"write_guard": { "config_invalid": "write-guard 被拦截:{reason}" },
		"no_session": {
			"status": "先跑 `loaf start {feature}`",
			"advance": "先跑 `loaf start {feature}`",
			"tasks": "先跑 `loaf start {feature}`",
			"pending": "先跑 `loaf start {feature}`",
			"finding": "先跑 `loaf start {feature}`",
			"verify": "先跑 `loaf start {feature}`",
			"generic": "先跑 `loaf start {feature}`"
		}
	},
	success: {
		"next": {
			"advance": "loaf advance",
			"deliver": "loaf deliver",
			"settle": "loaf settle"
		},
		"start": { "state_change": "start: '{feature}' 已创建 → TRIAGE.score" },
		"advance": { "state_change": "advance: {from} → {to}" },
		"gate": {
			"spec_lock_approved_state_change": "gate decide: spec-lock 已由 {actor} approve",
			"verify_accept_approved_state_change": "gate decide: verify-accept 已由 {actor} approve",
			"rejected_state_change": "gate decide: {gate} 已由 {actor} reject"
		},
		"deliver": {
			"state_change": "deliver: {feature} — {from} → DONE.delivered by {actor}",
			"next": "session complete — 运行 `loaf start <feature>` 开始下一个 feature"
		},
		"archive": { "state_change": "archive: {feature} — {from} → DONE.archived by {actor}" },
		"abandon": { "state_change": "abandon: {feature} — {from} → DONE.abandoned by {actor}(reason='{reason}')" },
		"spike": { "convert_state_change": "spike convert: {feature} → {to_feature} — {from} → DONE.archived by {actor}" },
		"profile": { "escalate_state_change": "profile escalate: ceremony 已更新,{pending_id} 已 resolved" },
		"tasks": {
			"submit_text_one": "已提交 {count} 个 task:{task_ids}",
			"submit_text_many": "已提交 {count} 个 task:{task_ids}",
			"submit_state_change": "tasks submit: {count} tasks",
			"add_text_one": "已添加 {count} 个 task:{task_ids}",
			"add_text_many": "已添加 {count} 个 task:{task_ids}",
			"add_sponsored_text_one": "已添加 {count} 个 task(由 {finding} sponsor):{task_ids}",
			"add_sponsored_text_many": "已添加 {count} 个 task(由 {finding} sponsor):{task_ids}",
			"add_state_change": "tasks add: +{count} tasks(allocated {task_ids})",
			"claim_state_change": "tasks claim: {task_id}(status={status})",
			"abandon_state_change": "tasks abandon: {task_id}(status={status})",
			"register_red_state_change": "tasks register-red: {task_id}"
		},
		"doctor": {
			"rebuild_text_one": "已为 {feature} 重建 {count} 个 projection file:",
			"rebuild_text_many": "已为 {feature} 重建 {count} 个 projection file:",
			"rebuild_state_change_one": "doctor rebuild: 已为 {feature} 重建 {count} 个 projection file",
			"rebuild_state_change_many": "doctor rebuild: 已为 {feature} 重建 {count} 个 projection file"
		},
		"snapshot": { "as_of_seq": "# snapshot as-of seq={seq}" },
		"amend": {
			"sponsored_text": "已修订 {task_id}(由 {finding_id} sponsor)",
			"policy_text": "已修订 {task_id}({applied})",
			"state_change": "amend: {task_id}"
		},
		"step": {
			"start_state_change": "step start: {task_id} {step}(running)",
			"done_text": "done {task_id} step={step} result={result}{evidence_suffix}{promote_suffix}",
			"done_evidence_suffix": " evidence={evidence_id}",
			"done_promote_suffix": " (task auto-promoted to done)",
			"done_state_change": "step done: {task_id} {step}({result})"
		},
		"settle": {
			"text": "",
			"state_change": "settle: {from} → SETTLE.reconcile"
		},
		"resume": { "state_change": "resume: session {session_id}(sub_state={sub_state} unchanged)" },
		"handoff": { "state_change": "handoff: resume-pack.json written by {actor}" },
		"pending": {
			"raise_state_change": "pending raise: {pending_id}(kind={kind})",
			"resolve_text": "已 resolve {pending_id}(kind={kind})",
			"resolve_state_change": "pending resolve: {pending_id} cleared"
		},
		"waive": { "state_change": "waive: {evidence_id} obligation={obligation_id}" },
		"lessons": { "add_state_change": "lessons add: {evidence_id} 已记录(kind=manual; lessons.md 已更新)" },
		"evidence": {
			"covers_none": "<none>",
			"add_state_change_single": "evidence add: {evidence_id} kind={kind}, covers={covers}",
			"add_state_change_batch_homogeneous": "evidence add: +{count} evidence({evidence_ids}; kind={kind}, covers={covers})",
			"add_state_change_batch_mixed": "evidence add: +{count} evidence({evidence_ids})"
		},
		"finding": {
			"close_text": "已关闭 {finding_id}",
			"close_state_change": "finding close: {finding_id} → closed"
		},
		"spec": {
			"submit_text": "spec submitted v{spec_version}: {req_count} req / {scen_count} scen / {vis_count} vis",
			"submit_state_change": "spec submit: spec_version={spec_version}, locked=false",
			"submit_next": "loaf gate decide spec-lock",
			"init_state_change": "spec init: 已写 scaffold 到 {path}",
			"init_next": "编辑后运行 `loaf spec submit`",
			"edit_text": "spec edit: spec_version={spec_version}",
			"edit_state_change": "spec edit: spec_version={spec_version} via $EDITOR",
			"add_req_text_one": "spec add-req v{spec_version}: {ids}",
			"add_req_text_many": "spec add-req v{spec_version}: {ids}",
			"add_req_state_change_one": "spec add-req: +{count} REQ(spec_version={spec_version}; allocated {ids})",
			"add_req_state_change_many": "spec add-req: +{count} REQ(spec_version={spec_version}; allocated {ids})",
			"add_scenario_text_one": "spec add-scenario v{spec_version}: {ids}",
			"add_scenario_text_many": "spec add-scenario v{spec_version}: {ids}",
			"add_scenario_state_change_one": "spec add-scenario: +{count} SCENARIO(spec_version={spec_version}; allocated {ids})",
			"add_scenario_state_change_many": "spec add-scenario: +{count} SCENARIO(spec_version={spec_version}; allocated {ids})",
			"add_visual_text_one": "spec add-visual v{spec_version}: {ids}",
			"add_visual_text_many": "spec add-visual v{spec_version}: {ids}",
			"add_visual_state_change_one": "spec add-visual: +{count} VISUAL(spec_version={spec_version}; allocated {ids})",
			"add_visual_state_change_many": "spec add-visual: +{count} VISUAL(spec_version={spec_version}; allocated {ids})"
		}
	},
	chrome: {
		"status": {
			"feature": "功能: {feature}",
			"phase": "阶段: {phase}",
			"cursor": "游标: {cursor}",
			"tail": "尾部: seq={seq}",
			"counts": "任务={tasks_count} 证据={evidence_count} 发现={findings_count} 待决={pending_count}",
			"snapshot_as_of_projection_loader": "# snapshot 当前 seq={seq}(projection-loader, Phase 15 SC3)"
		},
		"tasks": {
			"list_empty_filtered": "没有任务匹配 --status={status}",
			"list_empty": "projection 中没有任务(先运行 `loaf tasks submit`)",
			"ready_marker": "就绪",
			"list_row": "{task_id} {kind} {status}",
			"list_row_ready": "{task_id} {kind} {status} [{ready}]",
			"complete_text": "任务 {task_id} 已完成(status={status})"
		},
		"pending": {
			"list_row": "{pending_id} {kind} {status} {head}",
			"no_open": "没有未处理待决项",
			"open": "未处理",
			"resolved": "已解决",
			"head": "队首",
			"non_head": "-"
		},
		"finding": { "list_row": "{finding_id} {category} {action} {status}" },
		"sessions": {
			"empty": "(没有 session)",
			"warning": "registry 条目 {file} {action}({reason}{detail_suffix})",
			"action_skipped": "已跳过",
			"action_filtered_out": "被过滤",
			"action_orphan_cwd": "cwd 已孤立"
		},
		"relative": {
			"just_now": "刚刚",
			"minute_one": "{count} 分钟前",
			"minute_many": "{count} 分钟前",
			"hour_one": "{count} 小时前",
			"hour_many": "{count} 小时前",
			"day_one": "{count} 天前",
			"day_many": "{count} 天前"
		},
		"check": { "ok": "通过: {kind} 于 {path}" },
		"verify_status": {
			"pass": "通过",
			"fail": "失败",
			"na": "不适用",
			"check_lane_status": "泳道状态",
			"check_open_findings": "未关闭发现",
			"check_coverage": "覆盖",
			"check_task_evidence": "任务证据",
			"check_spec_review": "规格评审",
			"failure_summary_one": " {code}",
			"failure_summary_many": " {count} 个失败({code}, …)",
			"diagnostic_only": "(仅诊断 —— 不代表 gate 结论)"
		},
		"tui": {
			"list": {
				"title": "loaf sessions ({active_count} 活跃 / {total_count} 总计)",
				"sort": "排序: {sort}",
				"sort_time": "时间",
				"sort_status": "状态",
				"reloading": "刷新中…",
				"empty": "(没有会话)",
				"help": "[↑/↓] 移动 · [space] 折叠 · [a] 活跃/全部 · [s] 排序 · [r] 刷新 · [q] 退出",
				"row_iteration": "迭代 {value}"
			},
			"detail": {
				"title": "loaf 详情",
				"help": "[Esc] 返回 · [q] 退出",
				"no_selected": "(未选择详情)",
				"loading": "加载中…",
				"missing_title": "缺失: {feature}",
				"missing_message": "先运行 `loaf start {feature}`",
				"stale_title": "过期: {feature}",
				"stale_message": "快照过期(reason={reason})",
				"error_title": "错误: {feature}",
				"none": "(无)",
				"boolean_true": "是",
				"boolean_false": "否",
				"field_feature": "功能: {value}",
				"field_session": "会话: {value}",
				"field_label": "标签: {value}",
				"field_workspace": "工作区: {value}",
				"field_ceremony": "仪式: {value}",
				"field_phase": "阶段: {value}",
				"field_iteration": "迭代: {value}",
				"field_complexity": "复杂度: {value}",
				"field_based_on": "基于: spec {spec} / tasks {tasks}",
				"field_created": "创建: {value}",
				"field_updated": "更新: {value}",
				"field_spec_locked": "规格已锁定: {value}",
				"field_verify_accepted": "验证已接收: {value}",
				"field_spec_version": "规格版本: {value}",
				"field_tail_seq": "尾部 seq: {value}",
				"section_tasks": "任务 ({count})",
				"section_evidence": "证据 ({count})",
				"section_open_findings": "未关闭发现 ({count})",
				"section_pending": "待决 ({count})",
				"evidence_badge_pass": "通过",
				"evidence_badge_fail": "失败",
				"evidence_badge_waived": "已豁免",
				"sidecar_summary": "旁载:{path}",
				"step_summary": "{done}/{total} 已完成",
				"row_steps": "步骤 {value}",
				"row_iteration": "迭代 {value}",
				"row_task": "任务 {value}",
				"row_target": "目标 {value}",
				"row_blocks": "阻塞={value}",
				"row_options": "选项={value}"
			}
		}
	},
	help: {
		"start": "在 .loaf/<feature>/ 开启新 feature session",
		"status": "打印当前 state.json + artifact 健康摘要",
		"next": "计算当前 session 的下一条 owner command",
		"advance": "执行下一 transition + diff-guard(git status 全口径 ∩ write_paths)",
		"resume": "恢复 session;--fresh 输出本轮最小 context pack",
		"handoff": "写 resume-pack.json,context overflow 接力",
		"spec_submit": "严格按 SpecFrontmatter schema 校验并落 spec.md",
		"spec_init": "生成 spec.md 模板(适合 $EDITOR 跟进)",
		"spec_schema": "dump SpecFrontmatter JSON Schema",
		"tasks_submit": "严格按 TaskKind discriminated union 校验 tasks.json",
		"tasks_register_red": "为 behavioral+bug 任务登记失败测试(implement 之前必做)",
		"evidence_add": "追加一条 evidence;自动分配 EV-id",
		"evidence_schema": "dump EvidenceEntry JSON Schema",
		"waive": "记录一条 waiver 证据;actor 必须 human:* 起始,reason ≥10 字符",
		"finding_raise": "raise 一条 finding(VERIFY.* 始终允许,EXECUTE.* 仅 post-spec-lock 允许)",
		"verify_status": "实时计算各 verify check 的 applicability + status(永不读 reconcile.json)",
		"gate_decide": "记录人工 gate 决策;写 evidence kind=gate-decision",
		"settle": "生成 reconcile.json(standard+ profile)",
		"amend": "spec-lock 前编辑 spec / tasks(post-lock 拒绝,改走 finding)",
		"profile_escalate": "确认 pending profile 升级",
		"deliver": "标记 session 为 DONE.delivered(advisory only,不碰 git/gh)",
		"archive": "关闭 session 为 DONE.archived",
		"abandon": "关闭 session 为 DONE.abandoned(必须带 --reason)",
		"tui": "启动 session manager TUI(读取 ~/.loaf/registry/)",
		"sessions_list": "列出所有 session(非 TUI 形式)",
		"check": "纯 schema 校验(CI 用)",
		"check_tasks": "校验 tasks.execution.status(cache)与 evidence.jsonl(证据)一致性",
		"hook": "Claude Code hook 入口",
		"doctor": "自检 loaf-cli 安装、仓库结构、配置"
	},
	status_indicator: {
		"ask": "‖ 询问",
		"gate": "‖ Gate",
		"run": "▶ 运行",
		"done": "✓ 完成",
		"fail": "✗ 失败",
		"wait": "⏳ 等待",
		"idle": "空闲"
	}
};
//#endregion
//#region src/cli/i18n.ts
const LOCALES = ["en", "zh"];
const BUILTIN_BUNDLES = {
	en: en_default,
	zh: zh_default
};
const DEFAULT_I18N = createI18n("en", BUILTIN_BUNDLES);
function isLocale(value) {
	return typeof value === "string" && LOCALES.includes(value);
}
function invalidLocale(source, value) {
	return {
		ok: false,
		code: "INVALID_LOCALE",
		message: `invalid locale from ${source}: ${String(value)} (expected en or zh)`,
		detail: {
			source,
			value,
			accepted: [...LOCALES]
		}
	};
}
function parseLangArg(argv) {
	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i];
		if (arg === "--lang") return argv[i + 1];
		if (arg.startsWith("--lang=")) return arg.slice(7);
	}
}
function parseAmbientLocale(env) {
	const raw = env.LC_ALL ?? env.LC_MESSAGES ?? env.LANG;
	if (!raw || raw === "C" || raw === "POSIX") return null;
	const normalized = raw.toLowerCase();
	if (normalized.startsWith("zh")) return "zh";
	if (normalized.startsWith("en")) return "en";
	return null;
}
function resolveLocale(input) {
	const argvLocale = parseLangArg(input.argv);
	if (argvLocale !== void 0) {
		if (!isLocale(argvLocale)) return invalidLocale("--lang", argvLocale);
		return {
			ok: true,
			locale: argvLocale,
			source: "argv"
		};
	}
	const envLocale = input.env.LOAF_LANG;
	if (envLocale !== void 0) {
		if (!isLocale(envLocale)) return invalidLocale("LOAF_LANG", envLocale);
		return {
			ok: true,
			locale: envLocale,
			source: "env"
		};
	}
	if (input.userConfig?.status === "invalid") return {
		ok: false,
		code: "INVALID_LOCALE",
		message: `invalid locale config at ${input.userConfig.path}: ${input.userConfig.reason}`,
		detail: {
			source: "user-config",
			path: input.userConfig.path,
			reason: input.userConfig.reason
		}
	};
	if (input.userConfig?.status === "ok") {
		if (!isLocale(input.userConfig.locale)) return invalidLocale("user-config", input.userConfig.locale);
		return {
			ok: true,
			locale: input.userConfig.locale,
			source: "user-config"
		};
	}
	if (input.projectConfig?.locale !== void 0) return {
		ok: true,
		locale: input.projectConfig.locale,
		source: "project-config"
	};
	const ambient = parseAmbientLocale(input.env);
	if (ambient !== null) return {
		ok: true,
		locale: ambient,
		source: "ambient"
	};
	return {
		ok: true,
		locale: "en",
		source: "default"
	};
}
function lookup(bundle, keyPath) {
	let cur = bundle;
	for (const part of keyPath.split(".")) {
		if (typeof cur === "string") return void 0;
		if (typeof cur !== "object" || cur === null) return void 0;
		cur = cur[part];
		if (cur === void 0) return void 0;
	}
	return typeof cur === "string" ? cur : void 0;
}
function interpolate(template, vars) {
	return template.replace(/\{([A-Za-z0-9_]+)\}/g, (match, key) => {
		const value = vars?.[key];
		return value === void 0 ? match : String(value);
	});
}
function createI18n(locale, bundles) {
	return {
		locale,
		t(keyPath, vars) {
			return interpolate(lookup(bundles[locale], keyPath) ?? lookup(bundles.en, keyPath) ?? keyPath, vars);
		}
	};
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
const VerifiabilityFields$1 = z.object({
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
const ReqBase$1 = z.object({ id: ReqIdPayload });
const RequirementUbiquitousShape = ReqBase$1.extend({
	type: z.literal("ubiquitous"),
	response: z.string().min(10)
}).and(VerifiabilityFields$1);
const RequirementEventDrivenShape = ReqBase$1.extend({
	type: z.literal("event-driven"),
	trigger: z.string().min(5),
	response: z.string().min(10)
}).and(VerifiabilityFields$1);
const RequirementStateDrivenShape = ReqBase$1.extend({
	type: z.literal("state-driven"),
	while_: z.string().min(5),
	behavior: z.string().min(10)
}).and(VerifiabilityFields$1);
const RequirementOptionalShape = ReqBase$1.extend({
	type: z.literal("optional"),
	feature: z.string().min(5),
	response: z.string().min(10)
}).and(VerifiabilityFields$1);
const RequirementUnwantedShape = ReqBase$1.extend({
	type: z.literal("unwanted"),
	condition: z.string().min(5),
	response: z.string().min(10)
}).and(VerifiabilityFields$1);
const RequirementEarsShape = z.union([
	RequirementUbiquitousShape,
	RequirementEventDrivenShape,
	RequirementStateDrivenShape,
	RequirementOptionalShape,
	RequirementUnwantedShape
]);
const RequirementEarsVerifiable = RequirementEarsShape.refine(hasVerifiability, { message: "REQ must declare measurable, verified_by_scenarios[], or acceptance_na+reason (≥10 chars)" });
const ScenarioGherkin$1 = z.object({
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
const VisualContract$1 = z.object({
	id: VisIdPayload,
	target: z.string().min(3),
	checks: z.array(z.string().min(3)).min(1),
	requires_visual: z.boolean().optional(),
	visual_na: z.string().min(5).optional()
}).passthrough();
const NeedsClarification$1 = z.object({
	id: NcIdPayload,
	question: z.string().min(5),
	context: z.string().optional(),
	options: z.array(z.string()).optional()
}).passthrough();
const SpecFrontmatter$1 = z.object({
	schema_version: SchemaVersionPayload,
	spec_version: z.number().int().positive(),
	feature: z.object({
		id: FeatureIdPayload,
		name: z.string().min(3)
	}),
	intent: z.string().min(20),
	adr_refs: z.array(z.string()),
	requirements: z.array(RequirementEarsShape),
	scenarios: z.array(ScenarioGherkin$1),
	visual_contracts: z.array(VisualContract$1).optional(),
	needs_clarification: z.array(NeedsClarification$1)
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
	scenarios: z.array(ScenarioGherkin$1).default([]),
	visual_contracts: z.array(VisualContract$1).default([]),
	needs_clarification: z.array(NeedsClarification$1).default([])
}).passthrough();
const ReqIdNamespace$1 = z.string().regex(/^REQ-[A-Z][A-Z0-9]*$/);
const ScenIdNamespace$1 = z.string().regex(/^SCEN-[A-Z][A-Z0-9-]*$/);
const VisIdNamespace$1 = z.string().regex(/^VIS-[A-Z][A-Z0-9-]*$/);
const rejectCallerSuppliedId = (v) => !("id" in v);
const ID_REJECTION_MESSAGE = "id_namespace expected; full id is CLI-allocated and must not be supplied in input";
const SpecAddReqInputItemShape = z.object({
	id_namespace: ReqIdNamespace$1,
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
	id_namespace: ScenIdNamespace$1,
	name: z.string().min(3)
}).passthrough().refine(rejectCallerSuppliedId, { message: ID_REJECTION_MESSAGE });
const SpecAddScenarioInput = z.union([SpecAddScenarioInputItemShape, z.array(SpecAddScenarioInputItemShape).min(1)]);
const SpecAddVisualInputItemShape = z.object({
	id_namespace: VisIdNamespace$1,
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
const TaskBase$1 = z.object({
	id: TaskIdPayload,
	depends_on: z.array(TaskIdPayload).default([]),
	labels: z.array(z.string()).default([]),
	status: TaskStatusPayload
});
const TaskBehavioralPayload = TaskBase$1.extend({
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
const TaskStructuralPayload = TaskBase$1.extend({
	kind: z.literal("structural"),
	drives: z.array(RawDrivesRef).optional(),
	no_test_rationale: z.string().min(10),
	execution: StructuralExecutionPayload
});
const TaskVisualUiPayload = TaskBase$1.extend({
	kind: z.literal("visual-ui"),
	drives: z.array(RawDrivesRef).optional(),
	visual_contract_refs: z.array(VisIdPayload).min(1),
	no_test_rationale: z.string().min(10).optional(),
	execution: VisualUiExecutionPayload
});
const TaskDocsPayload = TaskBase$1.extend({
	kind: z.literal("docs"),
	drives: z.array(RawDrivesRef).optional(),
	no_test_rationale: z.string().min(10),
	execution: DocsExecutionPayload
});
const TaskSpikePayload = TaskBase$1.extend({
	kind: z.literal("spike"),
	drives: z.array(RawDrivesRef).optional(),
	no_test_rationale: z.string().min(10),
	execution: SpikeExecutionPayload
});
const TaskChorePayload = TaskBase$1.extend({
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
const TaskBehavioralInput$1 = z.object({
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
const TaskStructuralInput$1 = z.object({
	...TaskInputBaseShape,
	kind: z.literal("structural"),
	no_test_rationale: z.string().min(10)
}).strict();
const TaskVisualUiInput$1 = z.object({
	...TaskInputBaseShape,
	kind: z.literal("visual-ui"),
	visual_contract_refs: z.array(VisIdPayload).min(1),
	no_test_rationale: z.string().min(10).optional()
}).strict();
const TaskDocsInput$1 = z.object({
	...TaskInputBaseShape,
	kind: z.literal("docs"),
	no_test_rationale: z.string().min(10)
}).strict();
const TaskSpikeInput$1 = z.object({
	...TaskInputBaseShape,
	kind: z.literal("spike"),
	no_test_rationale: z.string().min(10)
}).strict();
const TaskChoreInput$1 = z.object({
	...TaskInputBaseShape,
	kind: z.literal("chore"),
	no_test_rationale: z.string().min(10)
}).strict();
const TaskInput$1 = z.union([
	TaskBehavioralInput$1,
	TaskStructuralInput$1,
	TaskVisualUiInput$1,
	TaskDocsInput$1,
	TaskSpikeInput$1,
	TaskChoreInput$1
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
const EvidenceKind$1 = z.enum([
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
const EvidenceResult$1 = z.enum([
	"passed",
	"failed",
	"approved",
	"rejected",
	"waived"
]);
const VerifyCheckKind$1 = z.enum([
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
	kind: EvidenceKind$1,
	iteration: z.number().int().positive(),
	actor: z.string().min(1),
	result: EvidenceResult$1,
	summary: SummaryField,
	covers: z.array(CoversRefPayload).default([]),
	task_id: TaskIdPayload.optional(),
	check: VerifyCheckKind$1.optional(),
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
const EvidenceAddInput$1 = EvidenceFullShape.omit({ id: true }).strict();
z.union([EvidenceAddInput$1, z.array(EvidenceAddInput$1).nonempty()]);
//#endregion
//#region src/core/finding-schema.ts
const FindingId = z.string().regex(/^FND-\d{3,}$/);
const FindingCategory$1 = z.enum([
	"spec-gap",
	"spec-defect",
	"impl-defect",
	"test-defect",
	"new-scope",
	"risk-escalation"
]);
const FindingAction$1 = z.enum([
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
const EntryId$1 = z.string().regex(/^JE-\d{6,}$/, { message: "entry_id must match /^JE-\\d{6,}$/ (e.g. JE-000123)" });
const ActorString$1 = z.string().regex(/^(human|skill|ci|cli|migration):[^\s].*$/, { message: "actor must be of form '<prefix>:<id>' where prefix ∈ {human, skill, ci, cli, migration}" });
const AttachmentRef$1 = z.object({
	path: z.string().min(1),
	sha256: z.string().regex(/^[a-f0-9]{64}$/),
	size: z.number().int().nonnegative()
}).strict();
const LongTextField$1 = z.discriminatedUnion("mode", [z.object({
	mode: z.literal("inline"),
	text: z.string()
}).strict(), z.object({
	mode: z.literal("sidecar"),
	ref: AttachmentRef$1
}).strict()]);
const MigrationSnapshotImportedPayload = z.object({
	source_schema_version: z.number().int().positive(),
	migrated_at: z.string().datetime(),
	artifacts: z.object({
		state: AttachmentRef$1,
		tasks: AttachmentRef$1,
		spec_md: AttachmentRef$1,
		evidence: AttachmentRef$1,
		findings: AttachmentRef$1,
		pending: AttachmentRef$1
	}).strict()
}).strict();
const SubState$1 = z.enum([
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
const Ceremony$1 = z.object({
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
const GateName$1 = z.enum(["spec-lock", "verify-accept"]);
const EntryKind$1 = z.enum([
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
const JournalEntry$1 = z.object({
	seq: z.number().int().nonnegative(),
	entry_id: EntryId$1,
	at: z.string().datetime(),
	actor: ActorString$1,
	entry_schema_version: z.number().int().positive(),
	kind: EntryKind$1,
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
const SessionResumedPayload = z.object({ resumed_from_pack: z.object({
	at: z.string().datetime(),
	reason: z.string().min(5),
	session_id: z.string().uuid()
}).strict() }).strict();
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
	from: SubState$1,
	to: SubState$1,
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
	gate_kind: GateName$1,
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
	category: FindingCategory$1,
	action: FindingAction$1,
	summary: z.string().min(3).optional(),
	reason: z.string().optional(),
	target: FindingTarget.optional()
}).passthrough();
const FindingClosedPayload = z.object({ id: FindingId }).passthrough();
const PendingId$1 = z.string().regex(/^PEND-\d{4,}$/);
const PendingPromptKind$1 = z.enum([
	"ask_user_question",
	"gate_decision",
	"spec_clarification",
	"finding_decision",
	"profile_escalation"
]);
const PendingAddedPayload = z.object({
	id: PendingId$1,
	kind: PendingPromptKind$1,
	question: z.string().min(3)
}).passthrough();
const PendingResolvedPayload = z.object({ id: PendingId$1 }).passthrough();
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
	needs_clarification: z.array(NeedsClarification$1)
}).passthrough();
const SpecReqAddedPayload = z.object({
	spec_version: BatchSpecVersion,
	req: RequirementEarsVerifiable
}).passthrough();
const SpecScenarioAddedPayload = z.object({
	spec_version: BatchSpecVersion,
	scenario: ScenarioGherkin$1
}).passthrough();
const SpecVisualAddedPayload = z.object({
	spec_version: BatchSpecVersion,
	visual: VisualContract$1
}).passthrough();
const SchemaVersionLiteral = z.literal(2);
const TasksJson$1 = z.object({
	schema_version: SchemaVersionLiteral,
	version: z.number().int().positive(),
	based_on: z.object({ spec: z.number().int().positive() }),
	tasks: z.array(TaskFullPayload)
}).strict();
const EvidenceEntry$1 = EvidenceFullShape.extend({
	schema_version: SchemaVersionLiteral,
	at: z.string().datetime()
}).strict();
const EvidenceJson$1 = z.object({
	schema_version: SchemaVersionLiteral,
	evidence: z.array(EvidenceEntry$1)
}).strict();
const FindingStateShape = z.object({
	id: z.string().regex(/^FND-\d{3,}$/),
	category: FindingCategory$1,
	action: FindingAction$1,
	status: z.enum(["open", "closed"]),
	summary: z.string().optional(),
	reason: z.string().optional(),
	target: z.object({
		task_id: z.string().regex(/^T-\d{3,}$/),
		step: z.string().min(1)
	}).strict().optional()
}).strict();
const FindingsJson$1 = z.object({
	schema_version: SchemaVersionLiteral,
	findings: z.array(FindingStateShape)
}).strict();
const PendingQueueEntry = z.object({
	pending_id: PendingId$1,
	kind: PendingPromptKind$1,
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
const PendingProjectionEntry$1 = PendingQueueEntry.extend({ resolved: z.boolean() }).strict();
const PendingJson$1 = z.object({
	schema_version: SchemaVersionLiteral,
	pending: z.array(PendingProjectionEntry$1)
}).strict();
const StateProjectionPhase = z.enum([
	"TRIAGE",
	"SPEC",
	"EXECUTE",
	"VERIFY",
	"SETTLE",
	"DONE"
]);
const StateProjection$1 = z.object({
	schema_version: SchemaVersionLiteral,
	session_id: z.string().min(1),
	session_label: z.string().min(3).nullable(),
	workspace: z.string().min(1),
	loaf_version_required: z.string().regex(/^[\^~]?\d+\.\d+(\.\d+)?(-[0-9A-Za-z.-]+)?(\+[0-9A-Za-z.-]+)?$/).nullable(),
	phase: StateProjectionPhase,
	sub_state: SubState$1,
	iteration: z.number().int().positive(),
	spec_locked: z.boolean(),
	verify_accepted: z.boolean(),
	pending: z.array(PendingQueueEntry),
	ceremony: Ceremony$1,
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
const RegistryFile$1 = z.object({
	schema_version: SchemaVersionLiteral,
	at: z.string().datetime(),
	session_id: z.string().uuid(),
	session_label: z.string(),
	feature: z.string().min(1),
	cwd: z.string(),
	workspace: z.string().min(1),
	phase: StateProjectionPhase,
	sub_state: SubState$1,
	iteration: z.number().int().positive(),
	active_tasks: z.array(z.string().regex(/^T-\d{3,}$/)).default([]),
	pending: PendingQueueEntry.nullable(),
	pending_queue_depth: z.number().int().nonnegative().default(0),
	ceremony_label: z.string().default("")
}).strict();
//#endregion
//#region src/core/snapshot.ts
const HEX64 = /^[a-f0-9]{64}$/;
const ZERO_HASH = "0".repeat(64);
const SnapshotMeta$1 = z.object({
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
//#endregion
//#region src/core/lessons-projection.ts
/**
* Lesson selector (codex F-024 r2): NOT every kind=manual evidence is a
* lesson — `loaf evidence add --kind manual` is a legitimate verification
* path that covers REQ/SCEN/VIS/T. A lesson (from `loaf lessons add`,
* `buildLessonsEvidencePayload`) is shaped EXACTLY as: kind=manual,
* result=passed, empty covers, no task_id / check / gate linkage, human
* actor. The shape heuristic is exact for the current emitter; an explicit
* payload marker is future hardening (needs an evidence-schema rev).
*/
function isLesson(payload) {
	return payload.kind === "manual" && payload.result === "passed" && (payload.covers?.length ?? 0) === 0 && payload.task_id === void 0 && payload.check === void 0 && payload.gate === void 0 && payload.actor.startsWith("human:");
}
/**
* Select lesson entries from the journal stream (journal order = seq order).
* Operates on the FULL journal payloads (codex F-024 r2: NOT the slim
* `Snapshot.evidence`, which drops summary / task_id / gate).
*/
function selectLessonEntries(entries) {
	const lessons = [];
	for (const e of entries) {
		if (e.kind !== "evidence:added") continue;
		const payload = EvidenceFullPayload.parse(e.payload);
		if (!isLesson(payload)) continue;
		lessons.push({
			entry_id: e.entry_id,
			at: e.at,
			summary: payload.summary
		});
	}
	return lessons;
}
/**
* IO resolver — inline `summary` strings / inline LongTextFields pass through;
* sidecar LongTextFields are read from `<featureDir>/<ref.path>` and verified
* against `ref.sha256` + `ref.size`. A missing file or hash/size mismatch
* THROWS — surfaced as PROJECTION_WRITE_FAILED at the writer boundary.
*/
async function resolveLessonBodies(featureDir, lessons) {
	const resolved = [];
	for (const lesson of lessons) {
		const { summary } = lesson;
		let body;
		if (typeof summary === "string") body = summary;
		else if (summary.mode === "inline") body = summary.text;
		else {
			const ref = summary.ref;
			const abs = path.join(featureDir, ref.path);
			const buf = await promises.readFile(abs);
			const sha256 = createHash("sha256").update(buf).digest("hex");
			if (sha256 !== ref.sha256 || buf.byteLength !== ref.size) throw new Error(`lesson sidecar ${ref.path} integrity mismatch (sha256 ${sha256 === ref.sha256 ? "ok" : "MISMATCH"}, size ${buf.byteLength}≟${ref.size})`);
			body = buf.toString("utf8");
		}
		resolved.push({
			body,
			at: lesson.at
		});
	}
	return resolved;
}
/**
* Header identity (codex F-024 Q3): prefer the spec header (id + name from
* spec.md), with a required fallback for legal no-spec / quick paths — id =
* state.feature, name = session_label (off session:started) ?? state.feature.
* Date = session:started.at date; iterations = current snapshot iteration.
* Does NOT depend on spec_header being non-null.
*/
function deriveLessonsHeader(snapshot, entries) {
	const started = entries.find((e) => e.kind === "session:started");
	const sessionLabel = started && typeof started.payload.session_label === "string" ? started.payload.session_label : void 0;
	const feature = snapshot.state?.feature ?? "(unknown)";
	return {
		id: snapshot.spec_header?.feature.id ?? feature,
		name: snapshot.spec_header?.feature.name ?? sessionLabel ?? feature,
		date: started ? started.at.slice(0, 10) : "",
		iterations: snapshot.state?.iteration ?? 1
	};
}
/**
* Pure markdown render (§4.7): one flat section per feature.
*
* ```markdown
* ## <id> <name> · <date> (iterations=N)
*
* - lesson one
* - lesson two
* ```
*
* Multi-line lesson bodies indent continuation lines under the bullet.
* Caller decides write-vs-skip when `resolved` is empty.
*/
function composeLessonsProjection(resolved, header) {
	const bullets = resolved.map((r) => `- ${r.body.trim().replace(/\n/g, "\n  ")}`).join("\n");
	return `## ${header.id} ${header.name} · ${header.date} (iterations=${header.iterations})\n\n${bullets}\n`;
}
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
	return StateProjection$1.parse({
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
	return TasksJson$1.parse({
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
	return EvidenceJson$1.parse({
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
	return FindingsJson$1.parse({
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
	return PendingJson$1.parse({
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
	await writeTextAtomic(filePath, JSON.stringify(value, null, 2), fsync);
}
/** Atomic raw-text write — the markdown projection (lessons.md, F-024)
*  shares the exact tmp+fsync+rename boundary as the JSON leaves. */
async function writeTextAtomic(filePath, body, fsync) {
	const tmp = `${filePath}.tmp-${randomBytes(6).toString("hex")}`;
	await fsp.writeFile(tmp, body, { mode: 420 });
	if (fsync) {
		const fh = await fsp.open(tmp, "r+");
		try {
			await fh.sync();
		} finally {
			await fh.close();
		}
	}
	await fsp.rename(tmp, filePath);
	if (fsync) try {
		const dh = await fsp.open(path$1.dirname(filePath), "r");
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
	await fsp.mkdir(snapshotsDir, { recursive: true });
	const written = [];
	const statePath = path$1.join(snapshotsDir, "state.json");
	const stateJson = composeStateProjection(snapshot, entries);
	if (stateJson !== null) {
		await writeJsonAtomic(statePath, stateJson, fsync);
		written.push("state.json");
	} else await fsp.rm(statePath, { force: true });
	const tasksPath = path$1.join(snapshotsDir, "tasks.json");
	const tasksJson = composeTasksJson(snapshot, entries);
	if (tasksJson !== null) {
		await writeJsonAtomic(tasksPath, tasksJson, fsync);
		written.push("tasks.json");
	} else await fsp.rm(tasksPath, { force: true });
	await writeJsonAtomic(path$1.join(snapshotsDir, "evidence.json"), composeEvidenceJson(entries), fsync);
	written.push("evidence.json");
	await writeJsonAtomic(path$1.join(snapshotsDir, "findings.json"), composeFindingsJson(snapshot), fsync);
	written.push("findings.json");
	await writeJsonAtomic(path$1.join(snapshotsDir, "pending.json"), composePendingJson(entries), fsync);
	written.push("pending.json");
	const lessonsPath = path$1.join(featureDir, "lessons.md");
	const lessonEntries = selectLessonEntries(entries);
	if (lessonEntries.length > 0) {
		await writeTextAtomic(lessonsPath, composeLessonsProjection(await resolveLessonBodies(featureDir, lessonEntries), deriveLessonsHeader(snapshot, entries)), fsync);
		written.push("lessons.md");
	} else await fsp.rm(lessonsPath, { force: true });
	await writeMeta(path$1.join(snapshotsDir, "_meta.json"), meta, fsync);
	written.push("_meta.json");
	return written;
}
//#endregion
//#region src/core/registry-writer.ts
/** Default registry directory: `~/.loaf/registry/`.
*
*  Test isolation (codex r281 P1): when `process.env.LOAF_REGISTRY_DIR`
*  is set (vitest setup file populates it with a tmp dir), it wins
*  over the home-dir default. Tests can also override per-call via
*  `writeRegistryFile`'s `registryDir` option. Production users do
*  NOT set the env var; they get the canonical `~/.loaf/registry/`. */
function defaultRegistryDir() {
	const envOverride = process.env["LOAF_REGISTRY_DIR"];
	if (envOverride && envOverride.length > 0) return envOverride;
	return path.join(os.homedir(), ".loaf", "registry");
}
/** Pure: derive RegistryFile from a journal-applied snapshot + the
*  entries that produced it. Returns null when the snapshot carries no
*  session state (pre-session:started edge case).
*
*  Throws on Zod parse failure — schema mismatch means a code defect,
*  not a stale projection (codex r280 P4). Caller in `mutateBatch`
*  step 9 catches + converts to a mutate failure result. */
function buildRegistryFile(input) {
	const { snapshot, entries, now, cwd } = input;
	const state = snapshot.state;
	if (!state || !state.session_id) return null;
	const startEntry = entries.find((e) => e.kind === "session:started");
	if (!startEntry) throw new Error("buildRegistryFile: snapshot has state.session_id but entries lacks session:started — projection corruption");
	const startPayload = SessionStartedPayload.parse(startEntry.payload);
	const sessionLabel = startPayload.session_label ?? "";
	const workspace = startPayload.workspace ?? "default";
	const ceremonyLabel = startPayload.ceremony_label ?? "";
	const unresolved = composePendingJson(entries).pending.filter((p) => !p.resolved).map(({ resolved: _resolved, ...rest }) => rest);
	const pendingHead = unresolved[0] ?? null;
	const pendingQueueDepth = unresolved.length;
	const activeTasks = snapshot.tasks.filter((t) => t.status === "in_progress").map((t) => t.id);
	const feature = startPayload.feature;
	return RegistryFile$1.parse({
		schema_version: 2,
		at: now.toISOString(),
		session_id: state.session_id,
		session_label: sessionLabel,
		feature,
		cwd,
		workspace,
		phase: state.phase,
		sub_state: state.sub_state,
		iteration: state.iteration,
		active_tasks: activeTasks,
		pending: pendingHead,
		pending_queue_depth: pendingQueueDepth,
		ceremony_label: ceremonyLabel
	});
}
/** Atomic temp+rename write to `<registryDir>/<sessionId>.json`.
*
*  Writes with mode 0o600 (per §4.12) so other users on the same host
*  cannot read cwd / session_label. Creates `<registryDir>` recursively
*  on first write (parent-dir mode is intentionally not constrained by
*  protocol — codex r280 non-blocking).
*
*  Atomicity: writes to `<registryDir>/<sessionId>.json.tmp-<random>`,
*  then renames over the target. POSIX rename(2) is atomic — readers
*  see either the old file or the new file, never a torn write.
*
*  Best-effort: throws on IO failure; the mutateBatch step 9 caller
*  catches + silences per §4.12 (registry is stale-tolerant; doctor
*  --rebuild-registry recovers). */
async function writeRegistryFile(sessionId, file, opts = {}) {
	const registryDir = opts.registryDir ?? defaultRegistryDir();
	await promises.mkdir(registryDir, { recursive: true });
	const target = path.join(registryDir, `${sessionId}.json`);
	const tmp = `${target}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
	try {
		await promises.writeFile(tmp, JSON.stringify(file), { mode: 384 });
		await promises.rename(tmp, target);
	} catch (err) {
		await promises.unlink(tmp).catch(() => void 0);
		throw err;
	}
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
	state: StateProjection$1,
	tasks: TasksJson$1,
	evidence: EvidenceJson$1,
	findings: FindingsJson$1,
	pending: PendingJson$1
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
	const result = SnapshotMeta$1.safeParse(parsed);
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
//#region src/core/registry-read.ts
/**
* Read + parse exactly `${id}.json` from `registryDir`. Returns the finest error
* granularity so each caller applies its own policy. For schema-invalid the two
* detail surfaces differ on purpose: `warningDetail` is the joined issue
* messages (matches sessions-list), `strictDetail` is the full Zod error message
* (matches session-dispatch's `RegistryFile.parse(...)` catch). For io / corrupt
* the two surfaces are the same `err.message`.
*/
async function readRegistryEntry(registryDir, id) {
	let raw;
	try {
		raw = await fsp.readFile(path$1.join(registryDir, `${id}.json`), "utf8");
	} catch (err) {
		const m = err.message;
		return {
			ok: false,
			reason: "io-error",
			warningDetail: m,
			strictDetail: m
		};
	}
	let parsed;
	try {
		parsed = JSON.parse(raw);
	} catch (err) {
		const m = err.message;
		return {
			ok: false,
			reason: "corrupt-json",
			warningDetail: m,
			strictDetail: m
		};
	}
	const result = RegistryFile$1.safeParse(parsed);
	if (!result.success) return {
		ok: false,
		reason: "schema-invalid",
		warningDetail: result.error.issues.map((i) => i.message).join("; "),
		strictDetail: result.error.message
	};
	return {
		ok: true,
		file: result.data
	};
}
/** Canonicalize a path via fs.realpath; null when it can't be resolved (deleted). */
async function tryRealpath(p) {
	try {
		return await fsp.realpath(p);
	} catch {
		return null;
	}
}
//#endregion
//#region src/core/session-dispatch.ts
const MIN_SHORT_UUID_PREFIX = 8;
/** Extract flag value (`--flag value` or `--flag=value`). Returns
*  `undefined` when absent. */
function pickFlagValue(argv, flag) {
	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i];
		if (arg === flag) {
			const v = argv[i + 1];
			if (v !== void 0 && !v.startsWith("--")) return v;
			return;
		}
		if (arg.startsWith(`${flag}=`)) return arg.slice(flag.length + 1);
	}
}
async function resolveDispatch(input) {
	const sessionFlag = pickFlagValue(input.argv, "--session");
	const featureFlag = pickFlagValue(input.argv, "--feature");
	const featureDirFlag = pickFlagValue(input.argv, "--feature-dir");
	const sessionEnv = input.env["LOAF_SESSION"];
	const featureEnv = input.env["LOAF_FEATURE"];
	if (sessionFlag !== void 0 && featureDirFlag !== void 0) return usageConflict("--session and --feature-dir are mutually exclusive", ["--session", "--feature-dir"], "session identity comes from the registry; manual --feature-dir is contradictory");
	if (sessionFlag !== void 0) return resolveBySessionId(sessionFlag, input, "session-flag");
	if (featureFlag !== void 0) return resolveByFeatureName(featureFlag, input, "feature-flag", featureDirFlag);
	if (sessionEnv !== void 0 && featureDirFlag !== void 0) return usageConflict("$LOAF_SESSION and --feature-dir are mutually exclusive", ["$LOAF_SESSION", "--feature-dir"], "session identity comes from the registry; manual --feature-dir is contradictory");
	if (sessionEnv !== void 0 && sessionEnv.length > 0) return resolveBySessionId(sessionEnv, input, "session-env");
	if (featureEnv !== void 0 && featureEnv.length > 0) return resolveByFeatureName(featureEnv, input, "feature-env", featureDirFlag);
	if (featureDirFlag !== void 0) return usageConflict("--feature-dir requires --feature <name> or $LOAF_FEATURE to name the feature", ["--feature-dir"], "pass --feature <name> alongside --feature-dir, or set $LOAF_FEATURE");
	return autoPickFromCwd(input);
}
function usageConflict(message, conflicting, fix) {
	return {
		ok: false,
		code: "USAGE",
		message: `${message}. ${fix}`,
		detail: { conflicting }
	};
}
async function resolveBySessionId(uuidOrPrefix, input, source) {
	if (uuidOrPrefix.length < MIN_SHORT_UUID_PREFIX) return {
		ok: false,
		code: "USAGE",
		message: `--session prefix '${uuidOrPrefix}' is too short (<${MIN_SHORT_UUID_PREFIX} chars). Pass ≥${MIN_SHORT_UUID_PREFIX} chars or the full UUID.`,
		detail: {
			uuid_or_prefix: uuidOrPrefix,
			min_length: MIN_SHORT_UUID_PREFIX,
			source
		}
	};
	const registryDir = input.registryDir ?? defaultRegistryDir();
	let entries;
	try {
		entries = await promises.readdir(registryDir);
	} catch {
		return {
			ok: false,
			code: "SESSION_NOT_FOUND",
			message: `--session ${uuidOrPrefix} matches no entry in the registry`,
			detail: {
				uuid_or_prefix: uuidOrPrefix,
				registry_dir: registryDir,
				source
			}
		};
	}
	const matches = [];
	for (const entry of entries) {
		if (!entry.endsWith(".json")) continue;
		const id = entry.slice(0, -5);
		if (id.startsWith(uuidOrPrefix)) matches.push(id);
	}
	if (matches.length === 0) return {
		ok: false,
		code: "SESSION_NOT_FOUND",
		message: `--session ${uuidOrPrefix} matches no entry in the registry`,
		detail: {
			uuid_or_prefix: uuidOrPrefix,
			registry_dir: registryDir,
			source
		}
	};
	if (matches.length > 1) return {
		ok: false,
		code: "SESSION_SHORT_AMBIGUOUS",
		message: `--session ${uuidOrPrefix} matches ${matches.length} sessions in the registry: ` + matches.join(", "),
		detail: {
			prefix: uuidOrPrefix,
			match_count: matches.length,
			candidate_list: matches,
			source
		}
	};
	const sessionId = matches[0];
	const read = await readRegistryEntry(registryDir, sessionId);
	if (!read.ok) return {
		ok: false,
		code: "SESSION_NOT_FOUND",
		message: `--session ${uuidOrPrefix} registry entry exists but cannot be parsed: ${read.strictDetail}`,
		detail: {
			uuid_or_prefix: uuidOrPrefix,
			session_id: sessionId,
			source
		}
	};
	const registryFile = read.file;
	if ((await tryRealpath(registryFile.cwd) ?? registryFile.cwd) !== (await tryRealpath(input.cwd) ?? input.cwd)) return {
		ok: false,
		code: "SESSION_CWD_MISMATCH",
		message: `--session ${uuidOrPrefix} is registered against cwd=${registryFile.cwd}, but the current cwd is ${input.cwd}`,
		detail: {
			uuid: sessionId,
			registered_cwd: registryFile.cwd,
			current_cwd: input.cwd,
			source
		}
	};
	const featureDir = path.join(registryFile.cwd, ".loaf", registryFile.feature);
	return {
		ok: true,
		feature: registryFile.feature,
		featureDir,
		sessionId,
		source,
		autoPickAdvisory: null
	};
}
async function resolveByFeatureName(name, input, source, featureDirOverride) {
	const featureDir = featureDirOverride ?? path.join(input.cwd, ".loaf", name);
	try {
		return {
			ok: true,
			feature: name,
			featureDir,
			sessionId: (await loadProjections({
				feature_dir: featureDir,
				kinds: ["state"]
			})).state.session_id ?? null,
			source,
			autoPickAdvisory: null
		};
	} catch (err) {
		if (err instanceof NoSessionError) return {
			ok: false,
			code: "FEATURE_NOT_FOUND",
			message: `feature '${name}' has no session at ${featureDir}`,
			detail: {
				feature: name,
				feature_dir: featureDir,
				source
			}
		};
		if (err instanceof SnapshotStaleError) return {
			ok: false,
			code: "SNAPSHOT_STALE_REBUILD_REQUIRED",
			message: `feature '${name}' projection is stale at ${featureDir} (reason: ${err.reason})`,
			detail: {
				...err.detail,
				reason: err.reason,
				dispatch_source: source
			}
		};
		throw err;
	}
}
async function autoPickFromCwd(input) {
	const loafDir = path.join(input.cwd, ".loaf");
	let candidates;
	try {
		candidates = await promises.readdir(loafDir);
	} catch {
		return {
			ok: false,
			code: "FEATURE_NOT_FOUND",
			message: "no feature found in cwd (.loaf/ is empty or missing)",
			detail: { cwd: input.cwd }
		};
	}
	const active = [];
	for (const candidate of candidates) {
		const featureDir = path.join(loafDir, candidate);
		try {
			const projection = await loadProjections({
				feature_dir: featureDir,
				kinds: ["state"]
			});
			if (projection.state.phase === "DONE") continue;
			active.push({
				feature: candidate,
				featureDir,
				sessionId: projection.state.session_id ?? null
			});
		} catch (err) {
			if (err instanceof NoSessionError) continue;
			if (err instanceof SnapshotStaleError) return {
				ok: false,
				code: "SNAPSHOT_STALE_REBUILD_REQUIRED",
				message: `auto-pick aborted: '${candidate}' projection is stale (reason: ${err.reason}). Run 'loaf doctor --rebuild --feature ${candidate}' to resync.`,
				detail: {
					feature: candidate,
					feature_dir: featureDir,
					dispatch_phase: "auto-pick",
					reason: err.reason
				}
			};
			throw err;
		}
	}
	if (active.length === 0) return {
		ok: false,
		code: "FEATURE_NOT_FOUND",
		message: "no feature found in cwd (.loaf/ is empty, missing, or all features are DONE)",
		detail: {
			cwd: input.cwd,
			candidate_count: candidates.length
		}
	};
	if (active.length >= 2) return {
		ok: false,
		code: "FEATURE_AMBIGUOUS",
		message: `current working directory has ${active.length} active features and no dispatch context: ` + active.map((a) => a.feature).join(", "),
		detail: {
			count: active.length,
			feature_list: active.map((a) => a.feature)
		}
	};
	const picked = active[0];
	return {
		ok: true,
		feature: picked.feature,
		featureDir: picked.featureDir,
		sessionId: picked.sessionId,
		source: "auto-pick",
		autoPickAdvisory: `auto-picked '${picked.feature}'`
	};
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
/** Phase 16 SC-6a — returns true if `--no-input` appears in argv.
*  Orthogonal to output_format / quiet / verbose / color (no mutex).
*  Declares non-interactive context — actor resolver refuses git-config
*  fallback; any future prompt entry must exit 2. Explicit actor input
*  via `$LOAF_USER` is NOT disabled by this flag. */
function parseNoInputFromArgv(argv) {
	return argv.includes("--no-input");
}
/** Phase 16 SC-6b — returns true if `--debug` flag OR a non-empty
*  `LOAF_DEBUG` / `DEBUG` env var triggers debug mode. Precedence:
*  `--debug` flag > `LOAF_DEBUG` > `DEBUG` (any non-empty value
*  is truthy per protocol §1547; no `0`/`false` magic). Orthogonal
*  to all other presentation flags. */
function parseDebugFromArgv(argv, env = process.env) {
	if (argv.includes("--debug")) return true;
	if (env.LOAF_DEBUG && env.LOAF_DEBUG.length > 0) return true;
	if (env.DEBUG && env.DEBUG.length > 0) return true;
	return false;
}
/** Phase 16 SC-6c — returns true if `--dry-run` or `-n` appears in argv.
*  Orthogonal to all other presentation flags (no mutex). When true,
*  mutating commands short-circuit before journal append + projection
*  refresh; read-only commands reject with DRY_RUN_NOT_APPLICABLE. */
function parseDryRunFromArgv(argv) {
	return argv.includes("--dry-run") || argv.includes("-n");
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
		noColor: parseNoColorFromArgv(argv, env),
		noInput: parseNoInputFromArgv(argv),
		debug: parseDebugFromArgv(argv, env),
		dryRun: parseDryRunFromArgv(argv)
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
	const i18n = deps.i18n ?? DEFAULT_I18N;
	const plain = presentation.ok ? presentation.plain : false;
	const quiet = presentation.ok ? presentation.quiet : false;
	const verbose = presentation.ok ? presentation.verbose : 0;
	const noColor = presentation.ok ? presentation.noColor : false;
	const noInput = presentation.ok ? presentation.noInput : false;
	const debug = presentation.ok ? presentation.debug : false;
	const dryRun = presentation.ok ? presentation.dryRun : false;
	let exitCode = 0;
	let traceTarget = null;
	const sessionCache = /* @__PURE__ */ new Map();
	const projectionCache = /* @__PURE__ */ new Map();
	let lastResolvedSubState = null;
	let lastResolvedSessionId = null;
	let cachedDispatch = null;
	const ctx = {
		argv,
		output,
		plain,
		quiet,
		verbose,
		noColor,
		noInput,
		debug,
		dryRun,
		get traceTarget() {
			return traceTarget;
		},
		recordTraceTarget(feature, featureDir) {
			traceTarget = {
				feature,
				featureDir
			};
		},
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
			const p = deps.loadSession(featureDir, { ensureDir: !dryRun }).then((sess) => {
				const sub = sess.snapshot.state?.sub_state ?? null;
				if (sub) lastResolvedSubState = sub;
				const sid = sess.snapshot.state?.session_id ?? null;
				if (sid) lastResolvedSessionId = sid;
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
				deps.writeStdout(textRenderer(i18n));
			}
			if (!quiet && advisories) {
				const renderedAdvisories = typeof advisories === "function" ? advisories(i18n) : advisories;
				if (renderedAdvisories.stateChange) deps.writeStderr(renderedAdvisories.stateChange + "\n");
				if (renderedAdvisories.next !== void 0) {
					const lines = Array.isArray(renderedAdvisories.next) ? renderedAdvisories.next : [renderedAdvisories.next];
					for (const line of lines) deps.writeStderr(`next: ${line}\n`);
				}
			}
		},
		failure(code, message, detail) {
			writeFailure(code, message, detail);
		},
		failureKeyed(code, keyPath, vars, detail) {
			writeFailure(code, output === "json" ? DEFAULT_I18N.t(keyPath, vars) : i18n.t(keyPath, vars), detail);
		},
		snapshotCrashContext() {
			return {
				phase: phaseOf(lastResolvedSubState),
				sub_state: lastResolvedSubState,
				feature: extractFeature(argv),
				session_id: lastResolvedSessionId,
				last_command: [...argv].join(" ")
			};
		},
		async resolveDispatch() {
			if (cachedDispatch) return cachedDispatch;
			cachedDispatch = resolveDispatch({
				argv,
				env: process.env,
				cwd: process.cwd(),
				...deps.registryDir !== void 0 && { registryDir: deps.registryDir }
			});
			return cachedDispatch;
		},
		advisory(line) {
			if (quiet) return;
			deps.writeStderr(`loaf: ${line}\n`);
		}
	};
	function writeFailure(code, message, detail) {
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
			const errors = detail?.["errors"];
			if (Array.isArray(errors)) {
				for (const e of errors) deps.writeStderr(`  [${e.path ?? "?"}] ${e.code ?? "UNKNOWN"}: ${e.message ?? ""}\n`);
				if (detail?.["truncated"] === true) {
					const total = detail?.["error_count"];
					deps.writeStderr(`  ... (${typeof total === "number" ? total : "?"} errors total; first ${errors.length} shown)\n`);
				}
			}
		}
		exitCode = 2;
	}
	return ctx;
}
//#endregion
//#region src/cli/trace-writer.ts
/** Flags whose value carries free-form prose, file paths, payloads,
*  or identity-bearing data — replaced with a placeholder before
*  trace.jsonl write. Closed enums / numeric identifiers / boolean
*  flags stay verbatim. */
const REDACTED_FLAG_VALUES = new Set([
	"--feature-dir",
	"--input",
	"--reason",
	"--answer",
	"--question",
	"--options",
	"--label",
	"--summary",
	"--evidence-summary",
	"--evidence-reason",
	"--feature-name",
	"--intent",
	"--workspace",
	"--evidence-actor"
]);
function placeholderFor(flag) {
	return `<${flag.slice(2)}>`;
}
/** Walks argv once, replacing each REDACTED flag's value. Handles both
*  forms: `--flag value` (two argv tokens) and `--flag=value` (single
*  token). Idempotent. */
function redactArgv(argv) {
	const out = [];
	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i];
		const eqIdx = arg.indexOf("=");
		if (arg.startsWith("--") && eqIdx > 2) {
			const flag = arg.slice(0, eqIdx);
			if (REDACTED_FLAG_VALUES.has(flag)) {
				out.push(`${flag}=${placeholderFor(flag)}`);
				continue;
			}
			out.push(arg);
			continue;
		}
		if (REDACTED_FLAG_VALUES.has(arg)) {
			out.push(arg);
			const next = argv[i + 1];
			if (next !== void 0 && !next.startsWith("--")) {
				out.push(placeholderFor(arg));
				i++;
			}
			continue;
		}
		out.push(arg);
	}
	return out;
}
/** Captured stdout slice → summary string. JSON mode parses + re-
*  stringifies (drops formatting whitespace, normalizes shape). Text
*  mode passes raw + truncates. 256-char cap. */
const STDOUT_SUMMARY_CHAR_CAP = 256;
function summarizeStdout(rawStdout, outputMode) {
	if (outputMode === "json") try {
		const parsed = JSON.parse(rawStdout);
		const s = JSON.stringify(parsed);
		return s.length <= STDOUT_SUMMARY_CHAR_CAP ? s : s.slice(0, STDOUT_SUMMARY_CHAR_CAP);
	} catch {}
	return rawStdout.length <= STDOUT_SUMMARY_CHAR_CAP ? rawStdout : rawStdout.slice(0, STDOUT_SUMMARY_CHAR_CAP);
}
function buildTraceEntry(input) {
	return {
		schema_version: 2,
		kind: "cli",
		at: input.now.toISOString(),
		feature: input.feature,
		session_id: input.sessionId,
		sub_state: input.subState,
		cmd: input.cmd,
		argv: redactArgv(input.argv),
		exit: input.exit,
		wall_ms: input.wallMs,
		stdout_summary: summarizeStdout(input.rawStdout, input.outputMode)
	};
}
/** Production trace-line writer. Best-effort `fs.appendFile`; no
*  fsync (Debug-trace is non-authoritative per §13.1). POSIX
*  O_APPEND atomic semantics for single-line writes (entries here
*  cap below 4KB after redaction + summary truncation). */
async function defaultAppendTraceLine(featureDir, entry) {
	const line = JSON.stringify(entry) + "\n";
	await promises.appendFile(path.join(featureDir, "trace.jsonl"), line, "utf8");
}
//#endregion
//#region src/cli/runtime-i18n-keys.ts
const STATUS_INDICATOR_KEYS = {
	done: "status_indicator.done",
	blocked: "status_indicator.ask",
	running: "status_indicator.run",
	idle: "status_indicator.idle"
};
const TASK_KIND_KEYS = {
	behavioral: "task_kind.behavioral",
	structural: "task_kind.structural",
	"visual-ui": "task_kind.visual-ui",
	docs: "task_kind.docs",
	spike: "task_kind.spike",
	chore: "task_kind.chore"
};
const TASK_STATUS_KEYS = {
	pending: "task_status.pending",
	ready: "task_status.ready",
	in_progress: "task_status.in_progress",
	done: "task_status.done",
	abandoned: "task_status.abandoned"
};
const EVIDENCE_KIND_KEYS = {
	"task-summary": "evidence_kind.task-summary",
	"verify-review": "evidence_kind.verify-review",
	"spec-review": "evidence_kind.spec-review",
	acceptance: "evidence_kind.acceptance",
	"visual-review": "evidence_kind.visual-review",
	"gate-decision": "evidence_kind.gate-decision",
	"local-check": "evidence_kind.local-check",
	manual: "evidence_kind.manual",
	waiver: "evidence_kind.waiver",
	"spike-finding": "evidence_kind.spike-finding"
};
const FINDING_CATEGORY_KEYS = {
	"spec-gap": "finding_category.spec-gap",
	"spec-defect": "finding_category.spec-defect",
	"impl-defect": "finding_category.impl-defect",
	"test-defect": "finding_category.test-defect",
	"new-scope": "finding_category.new-scope",
	"risk-escalation": "finding_category.risk-escalation"
};
const FINDING_ACTION_KEYS = {
	"amend-spec": "finding_action.amend-spec",
	"amend-tasks": "finding_action.amend-tasks",
	"fix-impl": "finding_action.fix-impl",
	"fix-test": "finding_action.fix-test",
	defer: "finding_action.defer",
	backlog: "finding_action.backlog"
};
const FINDING_STATUS_KEYS = {
	open: "finding_status.open",
	closed: "finding_status.closed"
};
const PENDING_KIND_KEYS = {
	ask_user_question: "pending_kind.ask_user_question",
	gate_decision: "pending_kind.gate_decision",
	spec_clarification: "pending_kind.spec_clarification",
	finding_decision: "pending_kind.finding_decision",
	profile_escalation: "pending_kind.profile_escalation"
};
const PHASE_KEYS = {
	TRIAGE: "phase.TRIAGE",
	SPEC: "phase.SPEC",
	EXECUTE: "phase.EXECUTE",
	VERIFY: "phase.VERIFY",
	SETTLE: "phase.SETTLE",
	DONE: "phase.DONE"
};
const SUB_STATE_KEYS = {
	"TRIAGE.score": "sub_state.TRIAGE.score",
	"TRIAGE.confirm": "sub_state.TRIAGE.confirm",
	"SPEC.proposal": "sub_state.SPEC.proposal",
	"SPEC.spec": "sub_state.SPEC.spec",
	"SPEC.plan": "sub_state.SPEC.plan",
	"SPEC.design": "sub_state.SPEC.design",
	"EXECUTE.plan": "sub_state.EXECUTE.plan",
	"EXECUTE.work": "sub_state.EXECUTE.work",
	"EXECUTE.done": "sub_state.EXECUTE.done",
	"VERIFY.plan": "sub_state.VERIFY.plan",
	"VERIFY.run": "sub_state.VERIFY.run",
	"VERIFY.review": "sub_state.VERIFY.review",
	"VERIFY.acceptance": "sub_state.VERIFY.acceptance",
	"VERIFY.visual": "sub_state.VERIFY.visual",
	"VERIFY.accept": "sub_state.VERIFY.accept",
	"SETTLE.reconcile": "sub_state.SETTLE.reconcile",
	"SETTLE.lessons": "sub_state.SETTLE.lessons",
	"DONE.delivered": "sub_state.DONE.delivered",
	"DONE.archived": "sub_state.DONE.archived",
	"DONE.abandoned": "sub_state.DONE.abandoned"
};
const DIAGNOSTIC_KEYS = {
	INVALID_FORMAT: "diagnostic.INVALID_FORMAT",
	MUTUALLY_EXCLUSIVE_FLAGS: "diagnostic.MUTUALLY_EXCLUSIVE_FLAGS",
	DRY_RUN_NOT_APPLICABLE: "diagnostic.DRY_RUN_NOT_APPLICABLE",
	FEATURE_NOT_FOUND: "diagnostic.FEATURE_NOT_FOUND",
	FEATURE_AMBIGUOUS: "diagnostic.FEATURE_AMBIGUOUS",
	SESSION_CWD_MISMATCH: "diagnostic.SESSION_CWD_MISMATCH",
	SESSION_SHORT_AMBIGUOUS: "diagnostic.SESSION_SHORT_AMBIGUOUS",
	SESSION_NOT_FOUND: "diagnostic.SESSION_NOT_FOUND"
};
const FAILURE_SITE_KEYS = {
	sessionsListSelectorConflict: "failure.sessions_list.selector_conflict",
	tuiSelectorConflict: "failure.tui.selector_conflict",
	tuiInteractiveOnly: "failure.tui.interactive_only",
	hookMissingEvent: "failure.hook.missing_event",
	hookUnknownEvent: "failure.hook.unknown_event",
	hookStdinParseFailed: "failure.hook.stdin_parse_failed",
	hookWritePathMissing: "failure.hook.write_path_missing",
	checkSelectorConflict: "failure.check.selector_conflict",
	checkKindRequired: "failure.check.kind_required",
	checkPathMissing: "failure.check.path_missing",
	checkKindInvalid: "failure.check.kind_invalid",
	schemaSelectorConflict: "failure.schema.selector_conflict",
	schemaValidation: "failure.schema.validation",
	dispatchSessionFeatureDirConflict: "failure.dispatch.session_feature_dir_conflict",
	dispatchFeatureDirRequiresFeature: "failure.dispatch.feature_dir_requires_feature",
	startLabelTooShort: "failure.start.label_too_short",
	startWorkspaceEmpty: "failure.start.workspace_empty",
	handoffReasonTooShort: "failure.handoff.reason_too_short",
	handoffPackValidationFailed: "failure.handoff.pack_validation_failed",
	profileInputFileMissing: "failure.profile.input_file_missing",
	profileInputFileUnreadable: "failure.profile.input_file_unreadable",
	tasksAddEmptyArray: "failure.tasks_add.empty_array",
	lessonsTextTooShort: "failure.lessons.text_too_short",
	lessonsReasonTooShort: "failure.lessons.reason_too_short",
	lessonsTextFileMutex: "failure.lessons.text_file_mutex",
	lessonsFileMissing: "failure.lessons.file_missing",
	findingStatusInvalid: "failure.finding.status_invalid",
	writeGuardConfigInvalid: "failure.write_guard.config_invalid",
	noSessionStatus: "failure.no_session.status",
	noSessionAdvance: "failure.no_session.advance",
	noSessionTasks: "failure.no_session.tasks",
	noSessionPending: "failure.no_session.pending",
	noSessionFinding: "failure.no_session.finding",
	noSessionVerify: "failure.no_session.verify",
	noSessionGeneric: "failure.no_session.generic"
};
FAILURE_SITE_KEYS.sessionsListSelectorConflict, FAILURE_SITE_KEYS.tuiSelectorConflict, FAILURE_SITE_KEYS.tuiInteractiveOnly, FAILURE_SITE_KEYS.hookMissingEvent, FAILURE_SITE_KEYS.hookUnknownEvent, FAILURE_SITE_KEYS.hookStdinParseFailed, FAILURE_SITE_KEYS.hookWritePathMissing, FAILURE_SITE_KEYS.checkSelectorConflict, FAILURE_SITE_KEYS.checkKindRequired, FAILURE_SITE_KEYS.checkPathMissing, FAILURE_SITE_KEYS.checkKindInvalid, FAILURE_SITE_KEYS.schemaSelectorConflict, FAILURE_SITE_KEYS.schemaValidation, FAILURE_SITE_KEYS.dispatchSessionFeatureDirConflict, FAILURE_SITE_KEYS.dispatchFeatureDirRequiresFeature, FAILURE_SITE_KEYS.startLabelTooShort, FAILURE_SITE_KEYS.startWorkspaceEmpty, FAILURE_SITE_KEYS.handoffReasonTooShort, FAILURE_SITE_KEYS.handoffPackValidationFailed, FAILURE_SITE_KEYS.profileInputFileMissing, FAILURE_SITE_KEYS.profileInputFileUnreadable, FAILURE_SITE_KEYS.tasksAddEmptyArray, FAILURE_SITE_KEYS.lessonsTextTooShort, FAILURE_SITE_KEYS.lessonsReasonTooShort, FAILURE_SITE_KEYS.lessonsTextFileMutex, FAILURE_SITE_KEYS.lessonsFileMissing, FAILURE_SITE_KEYS.findingStatusInvalid, FAILURE_SITE_KEYS.writeGuardConfigInvalid, FAILURE_SITE_KEYS.noSessionStatus, FAILURE_SITE_KEYS.noSessionAdvance, FAILURE_SITE_KEYS.noSessionTasks, FAILURE_SITE_KEYS.noSessionPending, FAILURE_SITE_KEYS.noSessionFinding, FAILURE_SITE_KEYS.noSessionVerify, FAILURE_SITE_KEYS.noSessionGeneric;
const SUCCESS_KEYS = {
	nextAdvance: "success.next.advance",
	nextDeliver: "success.next.deliver",
	nextSettle: "success.next.settle",
	startStateChange: "success.start.state_change",
	advanceStateChange: "success.advance.state_change",
	gateSpecLockApprovedStateChange: "success.gate.spec_lock_approved_state_change",
	gateVerifyAcceptApprovedStateChange: "success.gate.verify_accept_approved_state_change",
	gateRejectedStateChange: "success.gate.rejected_state_change",
	deliverStateChange: "success.deliver.state_change",
	deliverNext: "success.deliver.next",
	archiveStateChange: "success.archive.state_change",
	abandonStateChange: "success.abandon.state_change",
	spikeConvertStateChange: "success.spike.convert_state_change",
	profileEscalateStateChange: "success.profile.escalate_state_change",
	tasksSubmitTextOne: "success.tasks.submit_text_one",
	tasksSubmitTextMany: "success.tasks.submit_text_many",
	tasksSubmitStateChange: "success.tasks.submit_state_change",
	tasksAddTextOne: "success.tasks.add_text_one",
	tasksAddTextMany: "success.tasks.add_text_many",
	tasksAddSponsoredTextOne: "success.tasks.add_sponsored_text_one",
	tasksAddSponsoredTextMany: "success.tasks.add_sponsored_text_many",
	tasksAddStateChange: "success.tasks.add_state_change",
	tasksClaimStateChange: "success.tasks.claim_state_change",
	tasksAbandonStateChange: "success.tasks.abandon_state_change",
	doctorRebuildTextOne: "success.doctor.rebuild_text_one",
	doctorRebuildTextMany: "success.doctor.rebuild_text_many",
	doctorRebuildStateChangeOne: "success.doctor.rebuild_state_change_one",
	doctorRebuildStateChangeMany: "success.doctor.rebuild_state_change_many",
	snapshotAsOfSeq: "success.snapshot.as_of_seq",
	amendSponsoredText: "success.amend.sponsored_text",
	amendPolicyText: "success.amend.policy_text",
	amendStateChange: "success.amend.state_change",
	tasksRegisterRedStateChange: "success.tasks.register_red_state_change",
	stepStartStateChange: "success.step.start_state_change",
	stepDoneText: "success.step.done_text",
	stepDoneEvidenceSuffix: "success.step.done_evidence_suffix",
	stepDonePromoteSuffix: "success.step.done_promote_suffix",
	stepDoneStateChange: "success.step.done_state_change",
	settleStateChange: "success.settle.state_change",
	settleText: "success.settle.text",
	resumeStateChange: "success.resume.state_change",
	handoffStateChange: "success.handoff.state_change",
	pendingRaiseStateChange: "success.pending.raise_state_change",
	pendingResolveText: "success.pending.resolve_text",
	pendingResolveStateChange: "success.pending.resolve_state_change",
	waiveStateChange: "success.waive.state_change",
	lessonsAddStateChange: "success.lessons.add_state_change",
	evidenceCoversNone: "success.evidence.covers_none",
	evidenceAddStateChangeSingle: "success.evidence.add_state_change_single",
	evidenceAddStateChangeBatchHomogeneous: "success.evidence.add_state_change_batch_homogeneous",
	evidenceAddStateChangeBatchMixed: "success.evidence.add_state_change_batch_mixed",
	findingCloseText: "success.finding.close_text",
	findingCloseStateChange: "success.finding.close_state_change",
	specSubmitText: "success.spec.submit_text",
	specSubmitStateChange: "success.spec.submit_state_change",
	specSubmitNext: "success.spec.submit_next",
	specInitStateChange: "success.spec.init_state_change",
	specInitNext: "success.spec.init_next",
	specEditText: "success.spec.edit_text",
	specEditStateChange: "success.spec.edit_state_change",
	specAddReqTextOne: "success.spec.add_req_text_one",
	specAddReqTextMany: "success.spec.add_req_text_many",
	specAddReqStateChangeOne: "success.spec.add_req_state_change_one",
	specAddReqStateChangeMany: "success.spec.add_req_state_change_many",
	specAddScenarioTextOne: "success.spec.add_scenario_text_one",
	specAddScenarioTextMany: "success.spec.add_scenario_text_many",
	specAddScenarioStateChangeOne: "success.spec.add_scenario_state_change_one",
	specAddScenarioStateChangeMany: "success.spec.add_scenario_state_change_many",
	specAddVisualTextOne: "success.spec.add_visual_text_one",
	specAddVisualTextMany: "success.spec.add_visual_text_many",
	specAddVisualStateChangeOne: "success.spec.add_visual_state_change_one",
	specAddVisualStateChangeMany: "success.spec.add_visual_state_change_many"
};
const CHROME_KEYS = {
	statusFeature: "chrome.status.feature",
	statusPhase: "chrome.status.phase",
	statusCursor: "chrome.status.cursor",
	statusTail: "chrome.status.tail",
	statusCounts: "chrome.status.counts",
	statusSnapshotAsOfProjectionLoader: "chrome.status.snapshot_as_of_projection_loader",
	tasksListEmptyFiltered: "chrome.tasks.list_empty_filtered",
	tasksListEmpty: "chrome.tasks.list_empty",
	tasksListReadyMarker: "chrome.tasks.ready_marker",
	tasksListRow: "chrome.tasks.list_row",
	tasksListRowReady: "chrome.tasks.list_row_ready",
	tasksCompleteText: "chrome.tasks.complete_text",
	pendingListRow: "chrome.pending.list_row",
	pendingStatusNoOpen: "chrome.pending.no_open",
	pendingOpen: "chrome.pending.open",
	pendingResolved: "chrome.pending.resolved",
	pendingHead: "chrome.pending.head",
	pendingNonHead: "chrome.pending.non_head",
	findingListRow: "chrome.finding.list_row",
	sessionsListEmpty: "chrome.sessions.empty",
	sessionsWarning: "chrome.sessions.warning",
	sessionsActionSkipped: "chrome.sessions.action_skipped",
	sessionsActionFilteredOut: "chrome.sessions.action_filtered_out",
	sessionsActionOrphanCwd: "chrome.sessions.action_orphan_cwd",
	relativeJustNow: "chrome.relative.just_now",
	relativeMinuteOne: "chrome.relative.minute_one",
	relativeMinuteMany: "chrome.relative.minute_many",
	relativeHourOne: "chrome.relative.hour_one",
	relativeHourMany: "chrome.relative.hour_many",
	relativeDayOne: "chrome.relative.day_one",
	relativeDayMany: "chrome.relative.day_many",
	checkOk: "chrome.check.ok",
	verifyStatusPass: "chrome.verify_status.pass",
	verifyStatusFail: "chrome.verify_status.fail",
	verifyStatusNa: "chrome.verify_status.na",
	verifyStatusCheckLaneStatus: "chrome.verify_status.check_lane_status",
	verifyStatusCheckOpenFindings: "chrome.verify_status.check_open_findings",
	verifyStatusCheckCoverage: "chrome.verify_status.check_coverage",
	verifyStatusCheckTaskEvidence: "chrome.verify_status.check_task_evidence",
	verifyStatusCheckSpecReview: "chrome.verify_status.check_spec_review",
	verifyStatusFailureSummaryOne: "chrome.verify_status.failure_summary_one",
	verifyStatusFailureSummaryMany: "chrome.verify_status.failure_summary_many",
	verifyStatusDiagnosticOnly: "chrome.verify_status.diagnostic_only",
	tuiListTitle: "chrome.tui.list.title",
	tuiListSort: "chrome.tui.list.sort",
	tuiListSortTime: "chrome.tui.list.sort_time",
	tuiListSortStatus: "chrome.tui.list.sort_status",
	tuiListReloading: "chrome.tui.list.reloading",
	tuiListEmpty: "chrome.tui.list.empty",
	tuiListHelp: "chrome.tui.list.help",
	tuiListRowIteration: "chrome.tui.list.row_iteration",
	tuiDetailTitle: "chrome.tui.detail.title",
	tuiDetailHelp: "chrome.tui.detail.help",
	tuiDetailNoSelected: "chrome.tui.detail.no_selected",
	tuiDetailLoading: "chrome.tui.detail.loading",
	tuiDetailMissingTitle: "chrome.tui.detail.missing_title",
	tuiDetailMissingMessage: "chrome.tui.detail.missing_message",
	tuiDetailStaleTitle: "chrome.tui.detail.stale_title",
	tuiDetailStaleMessage: "chrome.tui.detail.stale_message",
	tuiDetailErrorTitle: "chrome.tui.detail.error_title",
	tuiDetailNone: "chrome.tui.detail.none",
	tuiDetailBooleanTrue: "chrome.tui.detail.boolean_true",
	tuiDetailBooleanFalse: "chrome.tui.detail.boolean_false",
	tuiDetailFieldFeature: "chrome.tui.detail.field_feature",
	tuiDetailFieldSession: "chrome.tui.detail.field_session",
	tuiDetailFieldLabel: "chrome.tui.detail.field_label",
	tuiDetailFieldWorkspace: "chrome.tui.detail.field_workspace",
	tuiDetailFieldCeremony: "chrome.tui.detail.field_ceremony",
	tuiDetailFieldPhase: "chrome.tui.detail.field_phase",
	tuiDetailFieldIteration: "chrome.tui.detail.field_iteration",
	tuiDetailFieldComplexity: "chrome.tui.detail.field_complexity",
	tuiDetailFieldBasedOn: "chrome.tui.detail.field_based_on",
	tuiDetailFieldCreated: "chrome.tui.detail.field_created",
	tuiDetailFieldUpdated: "chrome.tui.detail.field_updated",
	tuiDetailFieldSpecLocked: "chrome.tui.detail.field_spec_locked",
	tuiDetailFieldVerifyAccepted: "chrome.tui.detail.field_verify_accepted",
	tuiDetailFieldSpecVersion: "chrome.tui.detail.field_spec_version",
	tuiDetailFieldTailSeq: "chrome.tui.detail.field_tail_seq",
	tuiDetailSectionTasks: "chrome.tui.detail.section_tasks",
	tuiDetailSectionEvidence: "chrome.tui.detail.section_evidence",
	tuiDetailSectionOpenFindings: "chrome.tui.detail.section_open_findings",
	tuiDetailSectionPending: "chrome.tui.detail.section_pending",
	tuiDetailEvidenceBadgePass: "chrome.tui.detail.evidence_badge_pass",
	tuiDetailEvidenceBadgeFail: "chrome.tui.detail.evidence_badge_fail",
	tuiDetailEvidenceBadgeWaived: "chrome.tui.detail.evidence_badge_waived",
	tuiDetailSidecarSummary: "chrome.tui.detail.sidecar_summary",
	tuiDetailStepSummary: "chrome.tui.detail.step_summary",
	tuiDetailRowSteps: "chrome.tui.detail.row_steps",
	tuiDetailRowIteration: "chrome.tui.detail.row_iteration",
	tuiDetailRowTask: "chrome.tui.detail.row_task",
	tuiDetailRowTarget: "chrome.tui.detail.row_target",
	tuiDetailRowBlocks: "chrome.tui.detail.row_blocks",
	tuiDetailRowOptions: "chrome.tui.detail.row_options"
};
[
	...Object.values(STATUS_INDICATOR_KEYS),
	...Object.values(TASK_KIND_KEYS),
	...Object.values(TASK_STATUS_KEYS),
	...Object.values(EVIDENCE_KIND_KEYS),
	...Object.values(FINDING_CATEGORY_KEYS),
	...Object.values(FINDING_ACTION_KEYS),
	...Object.values(FINDING_STATUS_KEYS),
	...Object.values(PENDING_KIND_KEYS),
	...Object.values(PHASE_KEYS),
	...Object.values(SUB_STATE_KEYS),
	...Object.values(DIAGNOSTIC_KEYS),
	...Object.values(FAILURE_SITE_KEYS),
	...Object.values(SUCCESS_KEYS),
	...Object.values(CHROME_KEYS)
];
function statusIndicatorKey(bucket) {
	return STATUS_INDICATOR_KEYS[bucket];
}
function taskKindKey(kind) {
	return TASK_KIND_KEYS[kind];
}
function taskStatusKey(status) {
	return TASK_STATUS_KEYS[status];
}
function evidenceKindKey(kind) {
	return EVIDENCE_KIND_KEYS[kind];
}
function findingCategoryKey(category) {
	return FINDING_CATEGORY_KEYS[category];
}
function findingActionKey(action) {
	return FINDING_ACTION_KEYS[action];
}
function findingStatusKey(status) {
	return FINDING_STATUS_KEYS[status];
}
function pendingKindKey(kind) {
	return PENDING_KIND_KEYS[kind];
}
function phaseKey(phase) {
	return PHASE_KEYS[phase];
}
function subStateKey(subState) {
	return SUB_STATE_KEYS[subState];
}
function diagnosticKey(code) {
	return DIAGNOSTIC_KEYS[code];
}
//#endregion
//#region src/cli/sessions-list.ts
async function listSessions(input) {
	const registryDir = input.registryDir ?? defaultRegistryDir();
	const rows = [];
	const warnings = [];
	let entries;
	try {
		entries = await promises.readdir(registryDir);
	} catch (err) {
		if (err.code === "ENOENT") return {
			ok: true,
			rows: [],
			warnings: []
		};
		return {
			ok: true,
			rows: [],
			warnings: [{
				file: registryDir,
				reason: "io-error",
				detail: err.message
			}]
		};
	}
	for (const entry of entries) {
		if (!entry.endsWith(".json")) continue;
		const read = await readRegistryEntry(registryDir, entry.slice(0, -5));
		if (!read.ok) {
			warnings.push({
				file: entry,
				reason: read.reason,
				detail: read.warningDetail
			});
			continue;
		}
		const reg = read.file;
		const canonicalRegCwd = await tryRealpath(reg.cwd);
		if (canonicalRegCwd === null) {
			warnings.push({
				file: entry,
				reason: "orphan-cwd",
				detail: `registered cwd '${reg.cwd}' no longer exists`
			});
			if (input.filterCwd !== void 0) continue;
		} else if (input.filterCwd !== void 0 && canonicalRegCwd !== input.filterCwd) continue;
		rows.push({
			session_id: reg.session_id,
			session_id_short: reg.session_id.slice(0, 8),
			session_label: reg.session_label,
			feature: reg.feature,
			phase: reg.phase,
			sub_state: reg.sub_state,
			at: reg.at,
			cwd: reg.cwd,
			workspace: reg.workspace,
			iteration: reg.iteration,
			pending_queue_depth: reg.pending_queue_depth,
			active_tasks: reg.active_tasks,
			ceremony_label: reg.ceremony_label
		});
	}
	rows.sort((a, b) => a.at < b.at ? 1 : a.at > b.at ? -1 : 0);
	return {
		ok: true,
		rows,
		warnings
	};
}
/** Presentation helper — relative-time rendering for text mode. Returns
*  "N minutes/hours/days ago" for ≤7 days, ISO otherwise. Future
*  timestamps fall back to ISO (defensive — clock skew). */
function formatAtRelative(iso, now, i18n = DEFAULT_I18N) {
	const at = new Date(iso);
	if (Number.isNaN(at.getTime())) return iso;
	const diffMs = now.getTime() - at.getTime();
	if (diffMs < 0) return iso;
	if (diffMs >= 7 * 864e5) return iso;
	const minutes = Math.floor(diffMs / 6e4);
	if (minutes < 1) return i18n.t(CHROME_KEYS.relativeJustNow);
	if (minutes < 60) return i18n.t(minutes === 1 ? CHROME_KEYS.relativeMinuteOne : CHROME_KEYS.relativeMinuteMany, { count: minutes });
	const hours = Math.floor(minutes / 60);
	if (hours < 24) return i18n.t(hours === 1 ? CHROME_KEYS.relativeHourOne : CHROME_KEYS.relativeHourMany, { count: hours });
	const days = Math.floor(hours / 24);
	return i18n.t(days === 1 ? CHROME_KEYS.relativeDayOne : CHROME_KEYS.relativeDayMany, { count: days });
}
//#endregion
//#region src/cli/verify-status.ts
/** Build the JSON envelope from evaluateAllChecks output. */
function buildEnvelope(checks) {
	return {
		ok: true,
		all_pass: checks.every((r) => r.status !== "fail"),
		checks
	};
}
/** Presentation — fixed column widths per the §7.4 example shape. */
const CHECK_LABEL_KEYS = {
	lane_status: CHROME_KEYS.verifyStatusCheckLaneStatus,
	open_findings: CHROME_KEYS.verifyStatusCheckOpenFindings,
	coverage: CHROME_KEYS.verifyStatusCheckCoverage,
	task_evidence: CHROME_KEYS.verifyStatusCheckTaskEvidence,
	spec_review: CHROME_KEYS.verifyStatusCheckSpecReview
};
function checkLabel(check, i18n) {
	return i18n.t(CHECK_LABEL_KEYS[check]);
}
function statusGlyph(status, i18n) {
	if (status === "pass") return i18n.t(CHROME_KEYS.verifyStatusPass);
	if (status === "fail") return i18n.t(CHROME_KEYS.verifyStatusFail);
	return i18n.t(CHROME_KEYS.verifyStatusNa);
}
function failureSummary(failures, i18n) {
	if (failures.length === 0) return "";
	if (failures.length === 1) {
		const f = failures[0];
		return f ? i18n.t(CHROME_KEYS.verifyStatusFailureSummaryOne, { code: f.code }) : "";
	}
	const head = failures[0];
	return i18n.t(CHROME_KEYS.verifyStatusFailureSummaryMany, {
		count: failures.length,
		code: head?.code ?? "?"
	});
}
function renderText(env, i18n = DEFAULT_I18N) {
	const labels = Object.fromEntries(env.checks.map((row) => [row.check, checkLabel(row.check, i18n)]));
	const labelWidth = Math.max(...Object.values(labels).map((l) => l.length));
	const lines = [];
	for (const row of env.checks) {
		const label = labels[row.check].padEnd(labelWidth);
		const status = statusGlyph(row.status, i18n).padEnd(4);
		lines.push(`${label}  ${status}${failureSummary(row.failures, i18n)}`);
		if (row.status === "fail" && row.failures.length > 1) for (const f of row.failures) lines.push(`    - ${f.code}: ${f.message}`);
	}
	lines.push(env.all_pass ? "" : i18n.t(CHROME_KEYS.verifyStatusDiagnosticOnly));
	return lines.join("\n") + "\n";
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
		raw = await fsp.readFile(specPath, "utf8");
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
	const validated = SpecFrontmatter$1.safeParse(parsed);
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
//#region src/core/gates/evidence-result.ts
/** Evidence results that count as a positive proof signal. `waived` is a human
*  escape; spec-review uses a STRICTER notion (passed/approved only) and does
*  NOT go through this set. */
const PASSING_RESULTS = new Set([
	"passed",
	"approved",
	"waived"
]);
/** True when an evidence result is a positive proof signal (passed / approved /
*  waived). undefined (no result yet) is never passing. */
function isPassingResult(result) {
	return result !== void 0 && PASSING_RESULTS.has(result);
}
//#endregion
//#region src/core/gates/task-proof.ts
/**
* Per done task in `snapshot.tasks` (snapshot order, NOT sorted), compute the
* proof gaps under `policy`. A task is evidence-proven when some evidence is
* passing, covers the task, and has an accepted kind (or is a waiver). Returns
* one finding per done task that has ≥1 gap; proven tasks produce no finding.
* Iteration order is preserved so callers relying on first-gap-wins
* (verify-min's bug-RED short-circuit) stay behavior-identical.
*/
function evaluateTaskProof(snapshot, policy) {
	const findings = [];
	for (const task of snapshot.tasks) {
		if (task.status !== "done") continue;
		const accepted = policy.acceptedKinds(task);
		const gaps = [];
		if (!snapshot.evidence.some((ev) => isPassingResult(ev.result) && ev.covers.includes(task.id) && (accepted.includes(ev.kind) || ev.kind === "waiver"))) gaps.push("no-passing-evidence");
		if (task.kind === "behavioral" && task.labels.includes("bug") && task.red_test_registered !== true) gaps.push("bug-red-unregistered");
		if (gaps.length > 0) findings.push({
			task,
			gaps
		});
	}
	return findings;
}
const VERIFY_ACCEPT_KINDS = [
	"task-summary",
	"local-check",
	"manual"
];
const verifyAcceptPolicy = { acceptedKinds: () => VERIFY_ACCEPT_KINDS };
const VERIFY_MIN_REQUIRED_KINDS = {
	behavioral: ["local-check"],
	structural: ["local-check"],
	"visual-ui": ["visual-review", "manual"],
	docs: ["task-summary", "manual"],
	chore: [
		"local-check",
		"manual",
		"task-summary"
	]
};
const verifyMinPolicy = { acceptedKinds: (task) => VERIFY_MIN_REQUIRED_KINDS[task.kind] ?? [] };
//#endregion
//#region src/core/gates/verify-accept-check.ts
const VERIFY_CHECK_IDS = [
	"lane_status",
	"open_findings",
	"coverage",
	"task_evidence",
	"spec_review"
];
const KIND_TO_LANE_FALLBACK = {
	"local-check": "run",
	"task-summary": "run",
	"verify-review": "review",
	"spec-review": "review",
	acceptance: "acceptance",
	"visual-review": "visual"
};
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
function evalLaneStatus(snapshot, frontmatter) {
	const failures = [];
	const applicableLanes = deriveVerifyApplicability(snapshot, frontmatter);
	for (const lane of applicableLanes) if (!laneIsPassed(lane, snapshot.evidence)) failures.push({
		check: 1,
		code: "VERIFY_LANE_NOT_PASSED",
		message: `applicable VERIFY lane=${lane} has no evidence with passing/approved/waived result; add evidence with check=${lane} or a matching kind`,
		detail: { lane }
	});
	return failures;
}
function evalOpenFindings(snapshot) {
	const open = snapshot.findings.filter((f) => f.status === "open");
	if (open.length === 0) return [];
	return [{
		check: 2,
		code: "OPEN_FINDINGS_PRESENT",
		message: `${open.length} finding(s) still open; resolve or close before verify-accept`,
		detail: {
			count: open.length,
			open_ids: open.map((f) => f.id)
		}
	}];
}
function evalCoverage(snapshot, frontmatter) {
	const satisfiesCoverage = (ev, id) => isPassingResult(ev.result) && ev.covers.includes(id) && canSatisfy(ev, id);
	const failures = [];
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
	return failures;
}
function evalTaskEvidence(snapshot, frontmatter) {
	const failures = [];
	if (snapshot.tasks_based_on === null) {
		failures.push({
			check: 4,
			code: "TASKS_NOT_PLANNED",
			message: `tasks have not been planned yet; verify-accept check 4 requires a task graph (tasks_based_on=null in snapshot)`
		});
		return failures;
	}
	if (snapshot.tasks_based_on.spec !== frontmatter.spec_version) {
		failures.push({
			check: 4,
			code: "TASKS_BASED_ON_STALE",
			message: `tasks_based_on.spec=${snapshot.tasks_based_on.spec} does not match frontmatter.spec_version=${frontmatter.spec_version}; verify-accept check 4 cannot evaluate a stale task graph`,
			detail: {
				tasks_based_on_spec: snapshot.tasks_based_on.spec,
				current_spec_version: frontmatter.spec_version
			}
		});
		return failures;
	}
	for (const { task, gaps } of evaluateTaskProof(snapshot, verifyAcceptPolicy)) for (const gap of gaps) if (gap === "no-passing-evidence") failures.push({
		check: 4,
		code: "TASK_DONE_NO_EVIDENCE",
		message: `task ${task.id} is status=done but has no PASSING evidence (result ∈ {passed, approved, waived}; kind ∈ {task-summary, local-check, manual, waiver}) covering it`,
		detail: { task_id: task.id }
	});
	else failures.push({
		check: 4,
		code: "BUG_TASK_RED_NOT_REGISTERED",
		message: `behavioral bug task ${task.id} is status=done but never registered its RED test (red_test_registered≠true)`,
		detail: { task_id: task.id }
	});
	return failures;
}
function evalSpecReview(snapshot) {
	const isPassingSpecReview = (r) => r === "passed" || r === "approved";
	const specReviews = snapshot.evidence.filter((ev) => ev.kind === "spec-review" && isPassingSpecReview(ev.result));
	if (specReviews.length === 0) return [{
		check: 5,
		code: "SPEC_REVIEW_MISSING",
		message: `ceremony.strict_spec_review=true requires ≥1 evidence kind=spec-review from an actor ≠ implementer; none found`
	}];
	const implementers = deriveImplementers(snapshot);
	if (implementers.size === 0) return [{
		check: 5,
		code: "SPEC_REVIEW_IMPLEMENTER_UNKNOWN",
		message: `ceremony.strict_spec_review=true requires actor ≠ implementer comparison, but no implementer actor can be established (done-task evidence actors all cli:*); fail-closed`
	}];
	const conflicts = specReviews.filter((ev) => implementers.has(ev.actor));
	if (conflicts.length > 0 && conflicts.length === specReviews.length) return [{
		check: 5,
		code: "SPEC_REVIEW_IMPLEMENTER_CONFLICT",
		message: `every spec-review evidence has actor ∈ implementer set; require ≥1 spec-review from an actor that did not implement done tasks`,
		detail: {
			spec_review_actors: specReviews.map((ev) => ev.actor),
			implementers: [...implementers]
		}
	}];
	return [];
}
/**
* SC-9a-1: deterministic NA applicability rules per VerifyCheckId.
* Result feeds `evaluateAllChecks` to set PerCheckResult.status. Pure +
* fixture-friendly; same inputs as the per-check walkers above.
*
* Rules (codex r303 lock):
*   - lane_status:   na iff deriveVerifyApplicability returns ∅
*   - open_findings: ALWAYS applicable (never na)
*   - coverage:      na iff 0 non-NA REQ/SCEN/VIS obligations
*   - task_evidence: precondition runs when graph is unplanned (so
*                    `tasks_based_on === null` is still applicable, fires
*                    TASKS_NOT_PLANNED). When graph present, na iff no
*                    done task exists.
*   - spec_review:   na iff ceremony.strict_spec_review !== true
*/
function deriveCheckApplicability(snapshot, frontmatter) {
	const laneStatusApplicable = deriveVerifyApplicability(snapshot, frontmatter).size > 0;
	const coverageApplicable = frontmatter.requirements.filter((r) => r.acceptance_na !== true).length + frontmatter.scenarios.filter((s) => s.acceptance_na === void 0 && s.tag === "e2e").length + (frontmatter.visual_contracts ?? []).filter((v) => v.visual_na === void 0).length > 0;
	let taskEvidenceApplicable;
	if (snapshot.tasks_based_on === null) taskEvidenceApplicable = true;
	else taskEvidenceApplicable = snapshot.tasks.some((t) => t.status === "done");
	const specReviewApplicable = snapshot.state?.ceremony.strict_spec_review === true;
	return {
		lane_status: laneStatusApplicable,
		open_findings: true,
		coverage: coverageApplicable,
		task_evidence: taskEvidenceApplicable,
		spec_review: specReviewApplicable
	};
}
/**
* SC-9a-1: walk all 5 checks independently, return one PerCheckResult per
* VerifyCheckId in the canonical VERIFY_CHECK_IDS order. NA rows have
* empty `failures`. Behavior-preserving invariant:
*
*   verifyAcceptCheck(snap, fm).checks  // when ok=false
*     deep-equal to
*   evaluateAllChecks(snap, fm).flatMap(r => r.failures)
*
* — covers all 10 per-check codes. SPEC_FRONTMATTER_INVALID stays at the
* IO boundary (see verify-accept-eval.ts).
*/
function evaluateAllChecks(snapshot, frontmatter) {
	const applicable = deriveCheckApplicability(snapshot, frontmatter);
	const walkers = {
		lane_status: () => evalLaneStatus(snapshot, frontmatter),
		open_findings: () => evalOpenFindings(snapshot),
		coverage: () => evalCoverage(snapshot, frontmatter),
		task_evidence: () => evalTaskEvidence(snapshot, frontmatter),
		spec_review: () => evalSpecReview(snapshot)
	};
	return VERIFY_CHECK_IDS.map((id) => {
		if (!applicable[id]) return {
			check: id,
			status: "na",
			failures: []
		};
		const failures = walkers[id]();
		return {
			check: id,
			status: failures.length > 0 ? "fail" : "pass",
			failures
		};
	});
}
function verifyAcceptCheck(snapshot, frontmatter) {
	const failures = evaluateAllChecks(snapshot, frontmatter).flatMap((r) => r.failures);
	if (failures.length === 0) return { ok: true };
	return {
		ok: false,
		checks: failures
	};
}
//#endregion
//#region src/core/gates/gate-eval.ts
function specReadFailure(read) {
	return {
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
}
/**
* Build a gate-mode evaluator from a pure check. The returned evaluator reads
* frontmatter at the IO boundary, maps a read failure to a check-1 row, and
* otherwise delegates to `check`. Return type is `R | SpecReadFailure`; callers
* annotate the clean alias (FullSpecLockResult / FullVerifyAcceptResult) to
* coerce — SpecReadFailure is a subtype of both gate results' failure arm.
*/
function gateEvalFromCheck(check) {
	return async (snapshot, featureDir) => {
		const read = await readSpecFrontmatter(featureDir);
		if (!read.ok) return specReadFailure(read);
		return check(snapshot, read.frontmatter);
	};
}
//#endregion
//#region src/core/gates/verify-accept-eval.ts
const evaluateVerifyAcceptGate = gateEvalFromCheck(verifyAcceptCheck);
async function evaluateVerifyAccept(snapshot, featureDir) {
	return evaluateVerifyAcceptGate(snapshot, featureDir);
}
async function evaluateVerifyAcceptDiagnostic(snapshot, featureDir) {
	const read = await readSpecFrontmatter(featureDir);
	if (!read.ok) return {
		ok: false,
		code: "SPEC_FRONTMATTER_INVALID",
		message: read.message,
		detail: {
			subcode: read.code,
			...read.detail ?? {}
		}
	};
	return {
		ok: true,
		checks: evaluateAllChecks(snapshot, read.frontmatter)
	};
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
function gateNameForCursor(subState) {
	switch (subState) {
		case "SPEC.design": return "spec-lock";
		case "VERIFY.accept": return "verify-accept";
		default: return null;
	}
}
function buildGateDecideAction(gate) {
	return {
		command: `loaf gate decide ${gate} --approve|--reject --reason "<reason>"`,
		owner_verb: "gate decide",
		target: gate,
		blocking: true,
		reason: gate === "spec-lock" ? "SPEC_LOCK_GATE_DECISION_REQUIRED" : "VERIFY_ACCEPT_GATE_DECISION_REQUIRED"
	};
}
function nextLegalTargets(prev, ceremony, verifyAccepted = false) {
	return (LEGAL_TRANSITIONS[prev] ?? []).filter((target) => validateTransition(prev, target, {
		ceremony,
		actor: "cli:loaf",
		verify_accepted: verifyAccepted
	}).ok);
}
function transitionOwnerFor(input) {
	const { sub_state, ceremony, spec_locked, verify_accepted, verify_next_target } = input;
	const gate = gateNameForCursor(sub_state);
	if (gate === "spec-lock" && !spec_locked) return buildGateDecideAction(gate);
	if (sub_state === "VERIFY.accept") {
		if (gate !== null && !verify_accepted) return buildGateDecideAction(gate);
		if (ceremony.settle_phase) return {
			command: "loaf settle",
			owner_verb: "settle",
			target: "SETTLE.reconcile",
			blocking: false,
			reason: "VERIFY_ACCEPTED_NEEDS_SETTLE"
		};
		return {
			command: "loaf deliver",
			owner_verb: "deliver",
			target: "DONE.delivered",
			blocking: false,
			reason: "VERIFY_ACCEPTED_READY_TO_DELIVER"
		};
	}
	if (sub_state === "EXECUTE.work") return {
		command: "loaf tasks next",
		owner_verb: "tasks next",
		target: "task-level",
		blocking: false,
		reason: "EXECUTE_WORK_TASK_ROUTING"
	};
	if (sub_state === "EXECUTE.done" && !ceremony.verify_phase) return {
		command: "loaf deliver",
		owner_verb: "deliver",
		target: "DONE.delivered",
		blocking: false,
		reason: "VERIFY_PHASE_DISABLED_READY_TO_DELIVER"
	};
	if (sub_state === "SETTLE.lessons") return {
		command: "loaf deliver",
		owner_verb: "deliver",
		target: "DONE.delivered",
		blocking: false,
		reason: "SETTLE_COMPLETE_READY_TO_DELIVER"
	};
	if (sub_state.startsWith("DONE.")) return null;
	const targets = nextLegalTargets(sub_state, ceremony, verify_accepted);
	const target = verify_next_target !== void 0 && targets.includes(verify_next_target) ? verify_next_target : targets[0];
	if (target === void 0) throw new Error(`No legal next action for non-terminal sub_state=${sub_state}`);
	return {
		command: `loaf advance ${target}`,
		owner_verb: "advance",
		target,
		blocking: false,
		reason: "ADVANCE_TO_NEXT_SUB_STATE"
	};
}
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
//#region src/core/next-action.ts
const VERIFY_ORDER = [
	"VERIFY.run",
	"VERIFY.review",
	"VERIFY.acceptance",
	"VERIFY.visual"
];
const VERIFY_LANE_BY_STATE = {
	"VERIFY.run": "run",
	"VERIFY.review": "review",
	"VERIFY.acceptance": "acceptance",
	"VERIFY.visual": "visual"
};
function pendingResolveAction(head) {
	return {
		command: `loaf pending resolve --answer "<answer>"`,
		owner_verb: "pending resolve",
		target: head.kind,
		blocking: true,
		reason: "PENDING_HEAD_REQUIRES_RESOLUTION"
	};
}
function profileEscalateAction() {
	return {
		command: "loaf profile escalate --confirm --input <ceremony.json>",
		owner_verb: "profile escalate",
		target: "profile_escalation",
		blocking: true,
		reason: "PROFILE_ESCALATION_PENDING"
	};
}
function gateFromCursor(subState) {
	const gate = gateNameForCursor(subState);
	return gate === null ? null : buildGateDecideAction(gate);
}
function verifyNextTarget(subState, applicable) {
	if (!subState.startsWith("VERIFY.")) return void 0;
	if (subState === "VERIFY.accept") return void 0;
	const startIndex = subState === "VERIFY.plan" ? 0 : VERIFY_ORDER.findIndex((state) => state === subState) + 1;
	const lanes = applicable ?? new Set([
		"run",
		"review",
		"acceptance",
		"visual"
	]);
	for (const state of VERIFY_ORDER.slice(Math.max(startIndex, 0))) {
		const lane = VERIFY_LANE_BY_STATE[state];
		if (lane !== void 0 && lanes.has(lane)) return state;
	}
	return "VERIFY.accept";
}
function chooseNextAction(input) {
	const head = input.pending[0];
	if (head !== void 0) {
		if (head.kind === "gate_decision") {
			const gate = gateFromCursor(input.sub_state);
			if (gate !== null) return gate;
			return pendingResolveAction(head);
		}
		if (head.kind === "profile_escalation") return profileEscalateAction();
		return pendingResolveAction(head);
	}
	return transitionOwnerFor({
		sub_state: input.sub_state,
		ceremony: input.ceremony,
		spec_locked: input.spec_locked,
		verify_accepted: input.verify_accepted,
		verify_next_target: verifyNextTarget(input.sub_state, input.verify_applicable_lanes)
	});
}
function buildNextOutput(input) {
	const action = chooseNextAction(input);
	return {
		ok: true,
		feature: input.feature,
		feature_dir: input.feature_dir,
		cursor: {
			phase: input.phase,
			sub_state: input.sub_state
		},
		ceremony: input.ceremony,
		terminal: input.sub_state.startsWith("DONE."),
		blocked: action?.blocking ?? false,
		...action === null ? {} : { next_action: action }
	};
}
const CHECK_KINDS = [
	"spec",
	"tasks",
	"evidence",
	"finding",
	"pending",
	"state"
];
/** External --kind ↔ internal projection mapping (codex r309 N1). */
const KIND_DISPATCH = {
	spec: {
		basename: "spec.md",
		parse: "yaml-frontmatter",
		schema: SpecFrontmatter$1
	},
	tasks: {
		basename: "tasks.json",
		parse: "json",
		schema: TasksJson$1
	},
	evidence: {
		basename: "evidence.json",
		parse: "json",
		schema: EvidenceJson$1
	},
	finding: {
		basename: "findings.json",
		parse: "json",
		schema: FindingsJson$1
	},
	pending: {
		basename: "pending.json",
		parse: "json",
		schema: PendingJson$1
	},
	state: {
		basename: "state.json",
		parse: "json",
		schema: StateProjection$1
	}
};
/** Reverse basename → kind for auto-detection. */
const BASENAME_TO_KIND = new Map(CHECK_KINDS.map((k) => [KIND_DISPATCH[k].basename, k]));
/** Map Zod issues with codex r309 B2 cap. `error_count` is total; `errors`
*  may be sliced to `MAX_CHECK_ERRORS`. */
function mapZodIssues(err) {
	const total = err.issues.length;
	const truncated = total > 20;
	return {
		errors: (truncated ? err.issues.slice(0, 20) : err.issues).map((i) => ({
			path: i.path.map(String).join("."),
			message: i.message,
			code: i.code
		})),
		truncated,
		error_count: total
	};
}
/** Resolve --kind > basename inference. Returns null when neither
*  resolves — caller emits USAGE specify --kind. */
function resolveKind(filePath, explicit) {
	if (explicit !== void 0) return explicit;
	const basename = path.basename(filePath).toLowerCase();
	return BASENAME_TO_KIND.get(basename) ?? null;
}
/** Detect the "loaf check tasks" mistake — literal `tasks` arg + no file.
*  Trigger conditions (both required per codex r309 N2):
*   - rawArg === "tasks" (NOT "./tasks", NOT "tasks.json")
*   - file does not exist at resolved absolute path
*/
async function isDidYouMeanTasks(rawArg, absPath) {
	if (rawArg !== "tasks") return false;
	try {
		await promises.stat(absPath);
		return false;
	} catch {
		return true;
	}
}
async function checkFile(opts) {
	const cwd = opts.cwd ?? process.cwd();
	const absPath = path.isAbsolute(opts.path) ? opts.path : path.resolve(cwd, opts.path);
	if (await isDidYouMeanTasks(opts.path, absPath)) return {
		ok: false,
		code: "USAGE",
		message: "`tasks` is not a file path. To validate a tasks artifact, pass its path: `loaf check <path>/tasks.json --kind tasks` (noun-first `loaf tasks check` is reserved for a future release)",
		detail: {
			suggestion: "loaf check <path>/tasks.json --kind tasks",
			argument: opts.path
		}
	};
	let raw;
	try {
		raw = await promises.readFile(absPath, "utf8");
	} catch (err) {
		if (err.code === "ENOENT") return {
			ok: false,
			code: "INPUT_FILE_NOT_FOUND",
			message: `file not found: ${absPath}`,
			detail: { path: absPath }
		};
		throw err;
	}
	const kind = resolveKind(opts.path, opts.kind);
	if (kind === null) return {
		ok: false,
		code: "USAGE",
		message: `cannot infer artifact kind from basename '${path.basename(opts.path)}' — specify --kind ${CHECK_KINDS.join("|")}`,
		detail: {
			hint: "specify --kind",
			path: absPath,
			basename: path.basename(opts.path)
		}
	};
	const entry = KIND_DISPATCH[kind];
	let parsed;
	if (entry.parse === "yaml-frontmatter") {
		const { frontmatter } = splitFrontmatter(raw);
		if (frontmatter === null) return {
			ok: false,
			code: "SCHEMA_VALIDATION_FAILED",
			message: `${kind} at ${absPath} is missing a YAML frontmatter block fenced by \`---\` on the first line`,
			detail: {
				kind,
				path: absPath,
				subcode: "missing-frontmatter"
			}
		};
		try {
			parsed = parse(frontmatter);
		} catch (err) {
			return {
				ok: false,
				code: "SCHEMA_VALIDATION_FAILED",
				message: `${kind} at ${absPath} frontmatter YAML failed to parse: ${err.message}`,
				detail: {
					kind,
					path: absPath,
					subcode: "invalid-yaml"
				}
			};
		}
	} else try {
		parsed = JSON.parse(raw);
	} catch (err) {
		return {
			ok: false,
			code: "SCHEMA_VALIDATION_FAILED",
			message: `${kind} at ${absPath} JSON failed to parse: ${err.message}`,
			detail: {
				kind,
				path: absPath,
				subcode: "invalid-json"
			}
		};
	}
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
				error_count: issues.error_count
			}
		};
	}
	return {
		ok: true,
		kind,
		path: absPath
	};
}
/** Text-mode success line. */
function renderSuccessText(result, i18n = DEFAULT_I18N) {
	return i18n.t(CHROME_KEYS.checkOk, {
		kind: result.kind,
		path: result.path
	}) + "\n";
}
//#endregion
//#region docs/schemas.ts
const SCHEMA_VERSION = 2;
const SchemaVersion = z.literal(SCHEMA_VERSION);
const EntryId = z.string().regex(/^JE-\d{6,}$/, { message: "entry_id must match /^JE-\\d{6,}$/ (e.g. JE-000123)" });
const BatchId = z.string().uuid();
const ActorString = z.string().regex(/^(human|skill|ci|cli|migration):[^\s].*$/, { message: "actor must be of form '<prefix>:<id>' where prefix ∈ {human, skill, ci, cli, migration}" });
const AttachmentRef = z.object({
	path: z.string().min(1),
	sha256: z.string().regex(/^[a-f0-9]{64}$/, { message: "sha256 must be 64 lowercase hex chars" }),
	size: z.number().int().nonnegative()
}).strict();
z.discriminatedUnion("mode", [z.object({
	mode: z.literal("inline"),
	text: z.string()
}).strict(), z.object({
	mode: z.literal("sidecar"),
	ref: AttachmentRef
}).strict()]);
const SignatureEnvelope = z.object({
	alg: z.string().min(1),
	key_id: z.string().min(1),
	sig: z.string().min(1),
	signed_at: z.string().datetime()
}).strict();
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
z.object({
	seq: z.number().int().nonnegative(),
	entry_id: EntryId,
	at: z.string().datetime(),
	actor: ActorString,
	entry_schema_version: z.number().int().positive(),
	kind: EntryKind,
	payload: z.unknown(),
	batch_id: BatchId.optional(),
	batch_index: z.number().int().nonnegative().optional(),
	batch_count: z.number().int().positive().optional(),
	signature: SignatureEnvelope.optional()
}).strict().refine((e) => {
	const present = [
		e.batch_id,
		e.batch_index,
		e.batch_count
	].filter((v) => v !== void 0).length;
	return present === 0 || present === 3;
}, { message: "batch_id, batch_index, batch_count must be all-present or all-absent" }).refine((e) => e.batch_index === void 0 || e.batch_count === void 0 || e.batch_index < e.batch_count, { message: "batch_index must be < batch_count" });
z.object({
	last_applied_seq: z.number().int().gte(-1),
	last_entry_offset: z.number().int().nonnegative(),
	last_entry_line_hash: z.string().regex(/^[a-f0-9]{64}$/, { message: "last_entry_line_hash must be 64 lowercase hex chars" }),
	rolling_checksum: z.string().regex(/^[a-f0-9]{64}$/, { message: "rolling_checksum must be 64 lowercase hex chars" }),
	feature_schema_version: z.number().int().positive(),
	written_at: z.string().datetime()
}).strict().refine((m) => m.last_applied_seq !== -1 || m.last_entry_offset === 0 && m.last_entry_line_hash === "0".repeat(64) && m.rolling_checksum === "0".repeat(64) && m.feature_schema_version === SCHEMA_VERSION, { message: "last_applied_seq=-1 (empty sentinel) requires last_entry_offset=0 + line_hash/rolling_checksum=ZERO_HASH + feature_schema_version=current (mirrors runtime isEmptyMeta — codex r176 BLOCK 2)" });
const Phase = z.enum([
	"TRIAGE",
	"SPEC",
	"EXECUTE",
	"VERIFY",
	"SETTLE",
	"DONE"
]);
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
	spec_phase: z.boolean().default(false),
	verify_phase: z.boolean().default(false),
	settle_phase: z.boolean().default(false),
	strict_spec_review: z.boolean().default(false),
	lessons_required: z.enum([
		"must",
		"may",
		"skip"
	]).default("skip"),
	strict_drift_check: z.boolean().default(false)
}).refine((c) => !c.settle_phase || c.verify_phase, { message: "ceremony.settle_phase=true requires verify_phase=true (SETTLE.reconcile entry 需要 verify-accept passed)" }).refine((c) => !c.strict_spec_review || c.spec_phase, { message: "ceremony.strict_spec_review=true requires spec_phase=true (no spec, no reviewer)" }).refine((c) => c.lessons_required === "skip" || c.settle_phase, { message: "ceremony.lessons_required ≠ 'skip' requires settle_phase=true (SETTLE.lessons 才能 append)" }).refine((c) => !c.strict_drift_check || c.settle_phase, { message: "ceremony.strict_drift_check=true requires settle_phase=true (SETTLE.reconcile 才能 drift check)" });
const CeremonyLabel = z.string();
z.enum([
	"behavioral",
	"structural",
	"visual-ui",
	"docs",
	"spike",
	"chore"
]);
const BehavioralStep = z.enum([
	"red",
	"implement",
	"refactor"
]);
const StructuralStep = z.enum(["implement", "refactor"]);
const VisualUiStep = z.enum([
	"mockup",
	"implement",
	"screenshot-compare"
]);
const DocsStep = z.enum(["draft", "review"]);
const SpikeStep = z.enum([
	"explore",
	"prototype",
	"record"
]);
const ChoreStep = z.enum(["execute"]);
z.union([
	BehavioralStep,
	StructuralStep,
	VisualUiStep,
	DocsStep,
	SpikeStep,
	ChoreStep
]);
const VerifyCheckKind = z.enum([
	"run",
	"review",
	"acceptance",
	"visual"
]);
const Applicability = z.enum([
	"must",
	"optional",
	"na"
]);
const StepStatus = z.enum([
	"na",
	"pending",
	"running",
	"passed",
	"failed",
	"waived"
]);
const GateName = z.enum(["spec-lock", "verify-accept"]);
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
const ReqId = z.string().regex(/^REQ-[A-Z][A-Z0-9]*-\d{3,}$/);
const ScenId = z.string().regex(/^SCEN-[A-Z][A-Z0-9-]*-\d{3,}$/);
const VisId = z.string().regex(/^VIS-[A-Z][A-Z0-9-]*-\d{3,}$/);
const Measurable = z.object({
	metric: z.string().min(3),
	threshold: z.union([z.string(), z.number()]),
	unit: z.string().optional(),
	direction: z.enum([
		"lte",
		"gte",
		"eq"
	]).default("lte")
});
const VerifiabilityFields = z.object({
	measurable: Measurable.optional(),
	verified_by_scenarios: z.array(ScenId).optional(),
	acceptance_na: z.literal(true).optional(),
	acceptance_na_reason: z.string().min(10).optional()
}).refine((v) => {
	const hasMeasurable = v.measurable !== void 0;
	const hasScenarios = v.verified_by_scenarios && v.verified_by_scenarios.length > 0;
	const hasNa = v.acceptance_na === true && (v.acceptance_na_reason?.length ?? 0) >= 10;
	return hasMeasurable || hasScenarios || hasNa;
}, { message: "every REQ must declare measurable, verified_by_scenarios[], or acceptance_na+reason" });
const ReqBase = z.object({ id: ReqId });
const RequirementUbiquitous = ReqBase.extend({
	type: z.literal("ubiquitous"),
	response: z.string().min(10)
}).and(VerifiabilityFields);
const RequirementEventDriven = ReqBase.extend({
	type: z.literal("event-driven"),
	trigger: z.string().min(5),
	response: z.string().min(10)
}).and(VerifiabilityFields);
const RequirementStateDriven = ReqBase.extend({
	type: z.literal("state-driven"),
	while_: z.string().min(5),
	behavior: z.string().min(10)
}).and(VerifiabilityFields);
const RequirementOptional = ReqBase.extend({
	type: z.literal("optional"),
	feature: z.string().min(5),
	response: z.string().min(10)
}).and(VerifiabilityFields);
const RequirementUnwanted = ReqBase.extend({
	type: z.literal("unwanted"),
	condition: z.string().min(5),
	response: z.string().min(10)
}).and(VerifiabilityFields);
z.enum([
	"ubiquitous",
	"event-driven",
	"state-driven",
	"optional",
	"unwanted"
]);
const RequirementEars = z.union([
	RequirementUbiquitous,
	RequirementEventDriven,
	RequirementStateDriven,
	RequirementOptional,
	RequirementUnwanted
]);
const ScenarioGherkin = z.object({
	id: ScenId,
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
}).refine((s) => !(s.tag === "e2e" && s.acceptance_na && s.requires_acceptance), { message: "cannot set both requires_acceptance and acceptance_na" });
const VisualContract = z.object({
	id: VisId,
	target: z.string().min(3),
	checks: z.array(z.string().min(3)).min(1),
	requires_visual: z.boolean().optional(),
	visual_na: z.string().min(5).optional()
});
const NeedsClarification = z.object({
	id: z.string().regex(/^NC-\d{3,}$/),
	question: z.string().min(5),
	context: z.string().optional(),
	options: z.array(z.string()).optional()
});
z.object({
	schema_version: SchemaVersion,
	spec_version: z.number().int().positive(),
	feature: z.object({
		id: z.string().regex(/^F-\d{3,}$/),
		name: z.string().min(3)
	}),
	intent: z.string().min(20),
	adr_refs: z.array(z.string()).default([]),
	requirements: z.array(RequirementEars),
	scenarios: z.array(ScenarioGherkin),
	visual_contracts: z.array(VisualContract).optional(),
	needs_clarification: z.array(NeedsClarification)
});
const PendingId = z.string().regex(/^PEND-\d{4,}$/);
const PendingPromptKind = z.enum([
	"ask_user_question",
	"gate_decision",
	"spec_clarification",
	"finding_decision",
	"profile_escalation"
]);
const PendingPromptEntry = z.object({
	kind: PendingPromptKind,
	question: z.string().min(3),
	options: z.array(z.string()).optional(),
	blocks: z.enum([
		"advance",
		"gate",
		"deliver",
		"all"
	]).default("advance"),
	raised_at: z.string().datetime(),
	raised_by: z.string().min(1)
}).extend({
	pending_id: PendingId,
	at: z.string().datetime(),
	raised_by_task_id: z.string().regex(/^T-\d{3,}$/).optional()
});
const StateProjection = z.object({
	schema_version: SchemaVersion,
	loaf_version_required: z.string().regex(/^[\^~]?\d+\.\d+(\.\d+)?(-[0-9A-Za-z.-]+)?(\+[0-9A-Za-z.-]+)?$/).nullable(),
	session_id: z.string().min(1),
	session_label: z.string().min(3).nullable(),
	workspace: z.string().default("default"),
	phase: Phase,
	sub_state: SubState,
	iteration: z.number().int().positive(),
	spec_locked: z.boolean(),
	verify_accepted: z.boolean(),
	pending: z.array(PendingPromptEntry).default([]),
	ceremony: Ceremony,
	ceremony_label: CeremonyLabel.default(""),
	complexity_score: z.number().int().min(0).max(100).nullable(),
	based_on: z.object({
		spec: z.number().int().nonnegative(),
		tasks: z.number().int().nonnegative()
	}),
	spec_version: z.number().int().nonnegative().default(0),
	created_at: z.string().datetime(),
	updated_at: z.string().datetime()
}).refine((s) => s.sub_state.startsWith(s.phase + "."), { message: "sub_state must start with phase + '.'" }).refine((s) => {
	if (!s.phase.startsWith("DONE")) return true;
	return s.pending.length === 0;
}, { message: "DONE.* requires pending = [] (active-set invariant enforced cross-file by transitions.ts)" });
z.object({
	schema_version: SchemaVersion,
	session_id: z.string().min(1),
	cwd: z.string(),
	debug: z.boolean(),
	heartbeat_at: z.string().datetime()
}).strict();
z.object({
	schema_version: SchemaVersion,
	at: z.string().datetime(),
	session_id: z.string().uuid(),
	session_label: z.string(),
	feature: z.string().min(1),
	cwd: z.string(),
	workspace: z.string(),
	phase: Phase,
	sub_state: SubState,
	iteration: z.number().int().positive(),
	active_tasks: z.array(z.string().regex(/^T-\d{3,}$/)).default([]),
	pending: PendingPromptEntry.nullable(),
	pending_queue_depth: z.number().int().nonnegative().default(0),
	ceremony_label: CeremonyLabel.default("")
});
const TaskExecutionStep = z.object({
	applicability: Applicability,
	status: StepStatus,
	reason: z.string().optional(),
	evidence_refs: z.array(z.string().regex(/^EV-\d{6,}$/)).default([]),
	started_at: z.string().datetime().optional()
});
const BehavioralExecution = z.object({
	red: TaskExecutionStep,
	implement: TaskExecutionStep,
	refactor: TaskExecutionStep
});
const StructuralExecution = z.object({
	implement: TaskExecutionStep,
	refactor: TaskExecutionStep
});
const VisualUiExecution = z.object({
	mockup: TaskExecutionStep,
	implement: TaskExecutionStep,
	"screenshot-compare": TaskExecutionStep
});
const DocsExecution = z.object({
	draft: TaskExecutionStep,
	review: TaskExecutionStep
});
const SpikeExecution = z.object({
	explore: TaskExecutionStep,
	prototype: TaskExecutionStep,
	record: TaskExecutionStep
});
const ChoreExecution = z.object({ execute: TaskExecutionStep });
const TaskId = z.string().regex(/^T-\d{3,}$/);
const DrivesRef = z.string().regex(/^(REQ|SCEN|VIS)-[A-Z][A-Z0-9-]*-\d{3,}$/);
const TaskBase = z.object({
	id: TaskId,
	drives: z.array(DrivesRef).optional(),
	depends_on: z.array(TaskId).default([]),
	labels: z.array(z.string()).default([]),
	status: z.enum([
		"pending",
		"ready",
		"in_progress",
		"done",
		"abandoned"
	])
});
const TaskBehavioral = TaskBase.extend({
	kind: z.literal("behavioral"),
	drives: z.array(DrivesRef).min(1),
	tests: z.array(z.string().min(3)).min(1),
	test_layer: z.enum([
		"unit",
		"integration",
		"e2e"
	]).optional(),
	red_test_registered: z.boolean().optional(),
	execution: BehavioralExecution,
	requires_acceptance: z.boolean().optional(),
	requires_visual: z.boolean().optional()
});
const TaskStructural = TaskBase.extend({
	kind: z.literal("structural"),
	no_test_rationale: z.string().min(10),
	execution: StructuralExecution
});
const TaskVisualUi = TaskBase.extend({
	kind: z.literal("visual-ui"),
	visual_contract_refs: z.array(VisId).min(1),
	no_test_rationale: z.string().min(10).optional(),
	execution: VisualUiExecution
});
const TaskDocs = TaskBase.extend({
	kind: z.literal("docs"),
	no_test_rationale: z.string().min(10),
	execution: DocsExecution
});
const TaskSpike = TaskBase.extend({
	kind: z.literal("spike"),
	no_test_rationale: z.string().min(10),
	execution: SpikeExecution
});
const TaskChore = TaskBase.extend({
	kind: z.literal("chore"),
	no_test_rationale: z.string().min(10),
	execution: ChoreExecution
});
const Task = z.discriminatedUnion("kind", [
	TaskBehavioral,
	TaskStructural,
	TaskVisualUi,
	TaskDocs,
	TaskSpike,
	TaskChore
]);
z.object({
	schema_version: SchemaVersion,
	version: z.number().int().positive(),
	based_on: z.object({ spec: z.number().int().positive() }),
	tasks: z.array(Task)
});
const FeatureId = z.string().regex(/^F-\d{3,}$/);
const CoversRef = z.union([
	ReqId,
	ScenId,
	VisId,
	TaskId
]);
const Attachment = z.object({
	path: z.string().min(3),
	sha256: z.string().regex(/^[a-f0-9]{64}$/),
	mime: z.string().min(3),
	bytes: z.number().int().positive().optional()
});
const EvidenceEntry = z.object({
	schema_version: SchemaVersion,
	evidence_id: z.string().regex(/^EV-\d{6,}$/),
	at: z.string().datetime(),
	kind: EvidenceKind,
	iteration: z.number().int().positive(),
	actor: z.string().min(1),
	result: EvidenceResult,
	summary: z.string().min(3),
	covers: z.array(CoversRef).default([]),
	task_id: z.string().regex(/^T-\d{3,}$/).optional(),
	check: VerifyCheckKind.optional(),
	cmd: z.string().optional(),
	exit: z.number().int().optional(),
	wall_ms: z.number().int().optional(),
	gate: GateName.optional(),
	decided_by: z.string().optional(),
	reason: z.string().optional(),
	based_on: z.object({
		spec: z.number().int().nonnegative(),
		tasks: z.number().int().nonnegative()
	}).optional(),
	attachments: z.array(Attachment).optional(),
	waiver_obligation_id: z.string().optional(),
	external_ref: z.string().optional()
});
const EvidenceAddInput = EvidenceEntry.omit({
	schema_version: true,
	evidence_id: true,
	at: true
}).strict();
z.discriminatedUnion("event", [z.object({
	schema_version: SchemaVersion,
	id: z.string().regex(/^FND-\d{3,}$/),
	event: z.literal("opened"),
	at: z.string().datetime(),
	raised_in: SubState,
	raised_by: z.string(),
	iteration: z.number().int().positive(),
	category: FindingCategory,
	action: FindingAction,
	summary: z.string().min(5),
	refs: z.array(z.union([
		ReqId,
		ScenId,
		VisId,
		TaskId,
		FeatureId
	])).default([]),
	evidence_refs: z.array(z.string().regex(/^EV-\d{6,}$/)).default([]),
	cause: z.string().optional()
}).refine((f) => f.raised_in.startsWith("VERIFY.") || f.raised_in.startsWith("EXECUTE."), { message: "findings only in VERIFY.* or post-lock EXECUTE.*" }), z.object({
	schema_version: SchemaVersion,
	id: z.string().regex(/^FND-\d{3,}$/),
	event: z.literal("closed"),
	at: z.string().datetime(),
	iteration: z.number().int().positive(),
	resolution: z.string().min(3),
	drift_index: z.number().int().nonnegative().optional(),
	evidence_refs: z.array(z.string().regex(/^EV-\d{6,}$/)).default([])
})]);
z.object({
	schema_version: SchemaVersion,
	evidence: z.array(EvidenceEntry)
});
const FindingStateProjection = z.object({
	id: z.string().regex(/^FND-\d{3,}$/),
	category: FindingCategory,
	action: FindingAction,
	status: z.enum(["open", "closed"]),
	summary: z.string().optional(),
	reason: z.string().optional(),
	target: z.object({
		task_id: z.string().regex(/^T-\d{3,}$/),
		step: z.string().min(1)
	}).optional()
});
z.object({
	schema_version: SchemaVersion,
	findings: z.array(FindingStateProjection)
});
const PendingProjectionEntry = PendingPromptEntry.extend({ resolved: z.boolean() });
z.object({
	schema_version: SchemaVersion,
	pending: z.array(PendingProjectionEntry)
});
const VerifyCheckSnapshot = z.object({
	applicability: Applicability,
	status: StepStatus,
	reason: z.string().optional(),
	evidence_refs: z.array(z.string().regex(/^EV-\d{6,}$/)).default([])
});
const IterationStats = z.object({
	total: z.number().int().positive(),
	findings_total: z.number().int().nonnegative(),
	findings_by_action: z.record(FindingAction, z.number().int().nonnegative()),
	findings_by_category: z.record(FindingCategory, z.number().int().nonnegative())
});
const Drift = z.object({
	path: z.string(),
	category: z.enum(["out_of_planned", "planned_not_touched"]),
	reason: z.string().min(5),
	resolution: z.enum([
		"spec_amended",
		"carried_forward",
		"abandoned",
		"deferred"
	]),
	finding_id: z.string().regex(/^FND-\d{3,}$/).optional()
});
const AcCoverage = z.object({
	ac_id: z.string().regex(/^(REQ|SCEN|VIS)-[A-Z][A-Z0-9-]*-\d{3,}$/),
	evidence_refs: z.array(z.string().regex(/^EV-\d{6,}$/)),
	status: z.enum([
		"passed",
		"failed",
		"waived",
		"na"
	])
});
z.object({
	schema_version: SchemaVersion,
	based_on: z.object({
		spec: z.number().int().positive(),
		tasks: z.number().int().positive()
	}),
	planned_scope: z.array(z.string()),
	actual_scope: z.array(z.string()),
	drift: z.array(Drift),
	ac_coverage: z.array(AcCoverage),
	verify_checks_status: z.record(VerifyCheckKind, VerifyCheckSnapshot),
	iteration_stats: IterationStats,
	unusual_findings_count: z.number().int().nonnegative().default(0)
});
const NextOwnerVerb = z.enum([
	"advance",
	"deliver",
	"settle",
	"gate decide",
	"profile escalate",
	"pending resolve",
	"tasks next"
]);
const NextAction = z.object({
	command: z.string().min(1),
	owner_verb: NextOwnerVerb,
	target: z.union([
		SubState,
		GateName,
		PendingPromptKind,
		z.literal("task-level")
	]).optional(),
	blocking: z.boolean(),
	reason: z.string().min(1)
}).strict();
z.object({
	ok: z.literal(true),
	feature: z.string().min(1),
	feature_dir: z.string().min(1),
	cursor: z.object({
		phase: Phase,
		sub_state: SubState
	}).strict(),
	ceremony: Ceremony,
	terminal: z.boolean(),
	blocked: z.boolean(),
	next_action: NextAction.optional()
}).strict().refine((o) => o.terminal || o.next_action !== void 0, { message: "next_action is required for non-terminal states" }).refine((o) => !o.terminal || o.next_action === void 0, { message: "next_action is omitted iff terminal=true" });
z.object({
	schema_version: SchemaVersion,
	at: z.string().datetime(),
	gate: z.union([
		GateName,
		z.literal("submit"),
		z.literal("transition"),
		z.literal("diff-guard")
	]),
	failures: z.array(z.object({
		code: z.lazy(() => DiagnosticCode),
		severity: z.enum(["block", "warn"]),
		ref: z.string().optional(),
		line: z.number().int().optional(),
		vars: z.record(z.string(), z.union([z.string(), z.number()])).default({}),
		suggestion: z.string().optional()
	}))
});
const TasksActiveSummary$1 = z.object({
	task_id: z.string().regex(/^T-\d{3,}$/),
	status: z.enum([
		"pending",
		"ready",
		"in_progress",
		"done",
		"abandoned"
	]),
	current_step: z.string().nullable()
});
z.object({
	schema_version: SchemaVersion,
	at: z.string().datetime(),
	session_id: z.string().uuid(),
	reason: z.string().min(5),
	state_snapshot: StateProjection,
	tasks_active_summary: z.array(TasksActiveSummary$1).default([]),
	recent_evidence: z.array(z.string().regex(/^EV-\d{6,}$/)).max(10),
	recent_findings: z.array(z.string().regex(/^FND-\d{3,}$/)).max(10),
	open_pending: PendingPromptEntry.nullable(),
	notes: z.string().optional()
});
z.object({
	schema_version: SchemaVersion,
	protected_files: z.array(z.string()).default([]),
	stable_core: z.array(z.string()).default([]),
	paths: z.object({
		source: z.array(z.string()).default(["src/**"]),
		tests: z.array(z.string()).default(["**/test/**", "tests/**"]),
		docs: z.array(z.string()).default(["docs/**", "**/*.md"]),
		ui: z.array(z.string()).default([]),
		public_api: z.array(z.string()).default([]),
		schema: z.array(z.string()).default([]),
		security: z.array(z.string()).default([])
	}).prefault({}),
	commands: z.object({
		run: z.array(z.string()).default([]),
		lint: z.array(z.string()).default([]),
		typecheck: z.array(z.string()).default([]),
		visual: z.array(z.string()).default([]),
		acceptance: z.array(z.string()).default([]),
		build: z.array(z.string()).default([])
	}).prefault({}),
	constitution: z.object({
		tdd_strictness: z.enum([
			"strict",
			"preferred",
			"advisory"
		]).default("preferred"),
		default_ceremony_label: z.string().default("standard"),
		default_ceremony: Ceremony.optional(),
		require_red_for_behavioral: z.boolean().default(true),
		allow_manual_for_requirement: z.boolean().default(true),
		require_attachment_for_visual: z.boolean().default(true)
	}).prefault({}),
	locale: z.object({ default_lang: z.enum(["en", "zh"]).default("en") }).prefault({})
});
z.object({
	schema_version: SchemaVersion,
	at: z.string().datetime(),
	session_id: z.string().uuid(),
	iteration: z.number().int().positive(),
	sub_state: SubState,
	cmd: z.string(),
	argv: z.array(z.string()),
	exit: z.number().int(),
	wall_ms: z.number().int().nonnegative(),
	stdout_summary: z.string().optional(),
	stderr_summary: z.string().optional()
});
const EscalationTrigger = z.enum([
	"scope_expansion",
	"public_api_touched",
	"schema_change",
	"concurrency_touched",
	"security_touched"
]);
z.object({
	triggers: z.array(EscalationTrigger).min(1),
	recommend_enable: z.array(z.enum([
		"spec_phase",
		"verify_phase",
		"settle_phase",
		"strict_spec_review",
		"strict_drift_check"
	])).default([])
});
z.object({
	task_id: z.string().regex(/^T-\d{3,}$/),
	step: z.string().min(1)
});
z.object({
	action: FindingAction,
	next_sub_state: SubState.nullable(),
	iteration_delta: z.union([z.literal(0), z.literal(1)]),
	spec_version_delta: z.union([z.literal(0), z.literal(1)]),
	tasks_version_delta: z.union([z.literal(0), z.literal(1)]),
	resets_spec_locked: z.boolean(),
	may_trigger_relock: z.boolean(),
	requires_target_payload: z.enum([
		"task_id_step",
		"task_id_optional",
		"none"
	])
});
const MutationRights$1 = z.object({
	writable_fields: z.array(z.string()).default([]),
	forbidden_fields: z.array(z.string()).default([])
});
z.object({
	sub_state: SubState,
	entry: z.string(),
	exit: z.string(),
	write_paths: z.array(z.string()),
	mutation_rights: MutationRights$1.optional(),
	next: z.array(SubState),
	prompt_inject: z.string()
});
z.enum([
	"source",
	"tests",
	"docs",
	"ui",
	"public_api",
	"schema",
	"security"
]);
z.object({
	path: z.string(),
	status: z.enum([
		"added",
		"modified",
		"deleted",
		"renamed",
		"untracked",
		"submodule"
	]),
	source: z.enum([
		"worktree",
		"index",
		"untracked"
	])
});
z.enum([
	"session-start",
	"write-guard",
	"scope-track",
	"closure-check"
]);
z.enum([
	"typical",
	"unusual",
	"incoherent"
]);
z.object({
	description: z.string().min(3),
	include: z.array(z.string().min(1)),
	exclude: z.array(z.string().min(1)).default([])
});
const DiagnosticCode = z.enum([
	"INPUT_FILE_NOT_FOUND",
	"MISSING_INPUT",
	"SCHEMA_VALIDATION_FAILED",
	"SPEC_LOCKED_NO_DIRECT_EDIT",
	"SPEC_NOT_INITIALIZED",
	"SPEC_ALREADY_INITIALIZED",
	"ATTACHMENT_NOT_FOUND",
	"ATTACHMENT_NOT_FILE",
	"FINDING_ACTION_UNUSUAL_REASON_REQUIRED",
	"FINDING_ACTION_INCOHERENT",
	"FINDING_TARGET_REQUIRED",
	"MUTUALLY_EXCLUSIVE_FLAGS",
	"INVALID_ENV_VALUE",
	"INVALID_FORMAT",
	"INVALID_LOCALE",
	"DRY_RUN_NOT_APPLICABLE",
	"HOOK_EVENT_NOT_IMPLEMENTED",
	"TASK_STATUS_WITHOUT_PROOF",
	"MISSING_VERIFIABILITY",
	"VAGUE_NO_SCENARIO",
	"DRIVES_NOT_BOUND",
	"MUTATION_OUT_OF_RIGHTS",
	"LOCK_TIMEOUT",
	"LOCK_HELD_BY",
	"FEATURE_NOT_FOUND",
	"FEATURE_AMBIGUOUS",
	"SESSION_CWD_MISMATCH",
	"SESSION_SHORT_AMBIGUOUS",
	"SESSION_NOT_FOUND",
	"PENDING_BLOCKS_ADVANCE",
	"GATE_NOT_PENDING",
	"ESCALATION_NOT_PENDING",
	"ACTOR_AUTHORITY_VIOLATION",
	"FROM_CURSOR_MISMATCH",
	"INVALID_ENVELOPE",
	"INVALID_PAYLOAD",
	"SEQ_NOT_MONOTONIC",
	"SETTLE_PHASE_BYPASS",
	"SETTLE_PHASE_DISABLED",
	"SPEC_PHASE_FORK_VIOLATION",
	"SUB_STATE_AUTHORITY_VIOLATION",
	"TRANSITION_ILLEGAL",
	"VERIFY_PHASE_FORK_VIOLATION",
	"EXECUTE_DONE_TASKS_NOT_FINAL",
	"ALREADY_STARTED",
	"FINDING_NOT_FOUND",
	"NO_SESSION",
	"PENDING_NOT_FOUND",
	"REDUCER_NOT_IMPLEMENTED",
	"ENTRY_OVERSIZE",
	"SHORT_WRITE",
	"TAIL_CORRUPTION",
	"MIGRATION_BACKUP_MISSING",
	"MIGRATION_INCOMPLETE",
	"MIGRATION_REPLAY_ATTEMPT",
	"MIGRATION_SIDECAR_MISSING",
	"INVALID_ACTOR_FORMAT",
	"NO_HUMAN_ACTOR",
	"DUPLICATE_REQ_ID",
	"DUPLICATE_SCEN_ID",
	"DUPLICATE_VIS_ID",
	"SPEC_FRONTMATTER_INVALID",
	"SPEC_HAS_UNCLARIFIED",
	"TASK_NOT_FOUND",
	"TASK_STEP_NOT_FOUND",
	"DUPLICATE_TASK_ID",
	"TASKS_NOT_PLANNED",
	"TASKS_BASED_ON_STALE",
	"REQ_NOT_DRIVEN",
	"E2E_SCENARIO_UNBOUND",
	"VISUAL_CONTRACT_UNBOUND",
	"TASK_KIND_SCHEMA_VIOLATION",
	"GATE_PRECONDITION_VIOLATION",
	"MULTIPLE_GATE_DECISIONS",
	"GATE_NOT_IMPLEMENTED",
	"VERIFY_LANE_NOT_PASSED",
	"OPEN_FINDINGS_PRESENT",
	"COVERAGE_NOT_SATISFIED",
	"TASK_DONE_NO_EVIDENCE",
	"SPEC_REVIEW_MISSING",
	"SPEC_REVIEW_IMPLEMENTER_CONFLICT",
	"SPEC_REVIEW_IMPLEMENTER_UNKNOWN",
	"DELIVER_NOT_ACCEPTED",
	"DELIVER_SETTLE_PHASE_BYPASS",
	"DELIVER_VERIFY_MIN_UNAVAILABLE",
	"DELIVER_VERIFY_MIN_INCOMPLETE",
	"DELIVER_SPIKE_TASKS",
	"SETTLE_NOT_ACCEPTED",
	"TASK_NOT_CLAIMABLE",
	"TASK_ALREADY_CLAIMED",
	"TASK_DEPS_NOT_SATISFIED",
	"TASK_NOT_CLAIMED",
	"TASK_NOT_ABANDONABLE",
	"TASK_ABANDON_BLOCKED_DEPENDENTS",
	"SESSION_REASON_REQUIRED",
	"PROJECTION_WRITE_FAILED",
	"FINDING_AMEND_SPEC_NOT_LOCKED",
	"SPEC_VERSION_NOT_MONOTONIC",
	"SPEC_VERSION_BATCH_MISMATCH",
	"TASK_COMPLETE_PRECONDITION_VIOLATED",
	"CANONICAL_TASK_BODY_UNAVAILABLE",
	"BUG_TASK_REQUIRES_RED",
	"BUG_TASK_FLAG_MISUSE",
	"BUG_TASK_RED_NOT_REGISTERED",
	"SPIKE_CONVERT_NO_SPIKE_TASK",
	"SNAPSHOT_STALE_REBUILD_REQUIRED",
	"INVALID_PRESET",
	"USAGE",
	"DOCTOR_MODE_NOT_IMPLEMENTED",
	"DOCTOR_FEATURE_REQUIRED",
	"DOCTOR_REBUILD_FAILED",
	"DOCTOR_REBUILD_MIGRATED_UNSUPPORTED",
	"REDUCER_ERROR",
	"WRITE_PATH_VIOLATION",
	"PROTECTED_FILE_WRITE"
]);
z.object({
	exit_code: z.literal(2),
	message_template: z.string().min(3),
	fix_template: z.string().min(3).optional(),
	doc_anchor: z.string().min(3).optional()
});
const ReqIdNamespace = z.string().regex(/^REQ-[A-Z][A-Z0-9]*$/);
const ScenIdNamespace = z.string().regex(/^SCEN-[A-Z][A-Z0-9-]*$/);
const VisIdNamespace = z.string().regex(/^VIS-[A-Z][A-Z0-9-]*$/);
const SpecReqInputUbiquitous = z.object({
	id_namespace: ReqIdNamespace,
	type: z.literal("ubiquitous"),
	response: z.string().min(10)
}).and(VerifiabilityFields);
const SpecReqInputEventDriven = z.object({
	id_namespace: ReqIdNamespace,
	type: z.literal("event-driven"),
	trigger: z.string().min(5),
	response: z.string().min(10)
}).and(VerifiabilityFields);
const SpecReqInputStateDriven = z.object({
	id_namespace: ReqIdNamespace,
	type: z.literal("state-driven"),
	while_: z.string().min(5),
	behavior: z.string().min(10)
}).and(VerifiabilityFields);
const SpecReqInputOptional = z.object({
	id_namespace: ReqIdNamespace,
	type: z.literal("optional"),
	feature: z.string().min(5),
	response: z.string().min(10)
}).and(VerifiabilityFields);
const SpecReqInputUnwanted = z.object({
	id_namespace: ReqIdNamespace,
	type: z.literal("unwanted"),
	condition: z.string().min(5),
	response: z.string().min(10)
}).and(VerifiabilityFields);
const SpecReqInput = z.union([
	SpecReqInputUbiquitous,
	SpecReqInputEventDriven,
	SpecReqInputStateDriven,
	SpecReqInputOptional,
	SpecReqInputUnwanted
]);
const SpecScenarioInput = z.object({
	id_namespace: ScenIdNamespace,
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
}).refine((s) => !(s.tag === "e2e" && s.acceptance_na && s.requires_acceptance), { message: "cannot set both requires_acceptance and acceptance_na" });
const SpecVisualInput = z.object({
	id_namespace: VisIdNamespace,
	target: z.string().min(3),
	checks: z.array(z.string().min(3)).min(1),
	requires_visual: z.boolean().optional(),
	visual_na: z.string().min(5).optional()
});
const TaskInputBase = z.object({
	drives: z.array(DrivesRef).optional(),
	depends_on: z.array(TaskId).default([]),
	labels: z.array(z.string()).default([])
});
const TaskBehavioralInput = TaskInputBase.extend({
	kind: z.literal("behavioral"),
	drives: z.array(DrivesRef).min(1),
	tests: z.array(z.string().min(3)).min(1),
	test_layer: z.enum([
		"unit",
		"integration",
		"e2e"
	]).optional(),
	requires_acceptance: z.boolean().optional(),
	requires_visual: z.boolean().optional()
}).strict();
const TaskStructuralInput = TaskInputBase.extend({
	kind: z.literal("structural"),
	no_test_rationale: z.string().min(10)
}).strict();
const TaskVisualUiInput = TaskInputBase.extend({
	kind: z.literal("visual-ui"),
	visual_contract_refs: z.array(VisId).min(1),
	no_test_rationale: z.string().min(10).optional()
}).strict();
const TaskDocsInput = TaskInputBase.extend({
	kind: z.literal("docs"),
	no_test_rationale: z.string().min(10)
}).strict();
const TaskSpikeInput = TaskInputBase.extend({
	kind: z.literal("spike"),
	no_test_rationale: z.string().min(10)
}).strict();
const TaskChoreInput = TaskInputBase.extend({
	kind: z.literal("chore"),
	no_test_rationale: z.string().min(10)
}).strict();
const TaskInput = z.discriminatedUnion("kind", [
	TaskBehavioralInput,
	TaskStructuralInput,
	TaskVisualUiInput,
	TaskDocsInput,
	TaskSpikeInput,
	TaskChoreInput
]);
const batchOrSingle = (schema) => z.union([schema, z.array(schema).nonempty()]);
const SpecReqInputBatched = batchOrSingle(SpecReqInput);
const SpecScenarioInputBatched = batchOrSingle(SpecScenarioInput);
const SpecVisualInputBatched = batchOrSingle(SpecVisualInput);
const TaskInputBatched = batchOrSingle(TaskInput);
const EvidenceAddInputBatched = batchOrSingle(EvidenceAddInput);
z.enum([
	"spec:add-req",
	"spec:add-scenario",
	"spec:add-visual",
	"tasks:add",
	"evidence:add"
]);
const INPUT_SCHEMAS = {
	"spec:add-req": SpecReqInputBatched,
	"spec:add-scenario": SpecScenarioInputBatched,
	"spec:add-visual": SpecVisualInputBatched,
	"tasks:add": TaskInputBatched,
	"evidence:add": EvidenceAddInputBatched
};
z.discriminatedUnion("source", [
	z.object({ source: z.literal("stdin") }),
	z.object({
		source: z.literal("inline"),
		raw: z.string().min(1)
	}),
	z.object({
		source: z.literal("path"),
		path: z.string().min(1)
	})
]);
//#endregion
//#region src/cli/schema-emit.ts
const ARTIFACT_SCHEMA_KINDS = [
	"spec",
	"tasks",
	"evidence",
	"finding",
	"state"
];
/** Artifact kind → Zod schema. `finding` (singular CLI noun) maps to
*  `FindingsJson` (plural file name) — same singular/plural mismatch as
*  SC-9c check. */
const ARTIFACT_SCHEMAS = {
	spec: SpecFrontmatter$1,
	tasks: TasksJson$1,
	evidence: EvidenceJson$1,
	finding: FindingsJson$1,
	state: StateProjection$1
};
/** Emit JSON Schema for one of the 5 batch-capable mutators. */
function emitInputSchema(commandKey) {
	return z.toJSONSchema(INPUT_SCHEMAS[commandKey], { target: "draft-2020-12" });
}
/** Emit JSON Schema for one of the 5 artifact projection kinds. */
function emitArtifactSchema(kind) {
	return z.toJSONSchema(ARTIFACT_SCHEMAS[kind], { target: "draft-2020-12" });
}
/** Pretty-print a JSON Schema document for stdout. */
function formatSchema(schema) {
	return JSON.stringify(schema, null, 2) + "\n";
}
//#endregion
//#region src/cli/evidence-id-allocator.ts
/** Allocate the next `count` evidence ids (≥6-digit zero-padded). */
function allocateNextEvidenceIds(snapshot, count) {
	if (count < 1) return [];
	const maxSerial = snapshot.evidence.reduce((max, e) => {
		const m = /^EV-(\d+)$/.exec(e.id);
		if (!m) return max;
		return Math.max(max, Number.parseInt(m[1], 10));
	}, 0);
	return Array.from({ length: count }, (_, i) => `EV-${String(maxSerial + 1 + i).padStart(6, "0")}`);
}
/** Single-id convenience for SC-11 wrappers (waive / lessons add). */
function allocateNextEvidenceId(snapshot) {
	return allocateNextEvidenceIds(snapshot, 1)[0];
}
//#endregion
//#region src/cli/waive.ts
function buildWaiveEvidencePayload(args) {
	return {
		id: args.evidenceId,
		kind: "waiver",
		iteration: args.iteration,
		actor: args.actor,
		result: "waived",
		reason: args.reason,
		summary: `waiver: ${args.obligationId}`,
		covers: [args.obligationId],
		waiver_obligation_id: args.obligationId
	};
}
//#endregion
//#region src/cli/lessons-add.ts
function chooseSummary(lessonText) {
	return Buffer.byteLength(lessonText, "utf8") > 8192 ? {
		mode: "inline",
		text: lessonText
	} : lessonText;
}
function buildLessonsEvidencePayload(args) {
	return {
		id: args.evidenceId,
		kind: "manual",
		iteration: args.iteration,
		actor: args.actor,
		result: "passed",
		reason: args.reason,
		summary: chooseSummary(args.lessonText),
		covers: []
	};
}
//#endregion
//#region src/cli/spec-submit-batch.ts
/** Build the canonical spec-submit batch: 1 head `event:spec_submitted`
*  + N `event:spec_req_added` + M `event:spec_scenario_added` + K
*  `event:spec_visual_added`. All entries share `at` / `actor` /
*  `entry_schema_version` / payload's `spec_version`. */
function buildSpecSubmitBatch(args) {
	const { input, snapshot, actor, now } = args;
	const currentVersion = snapshot.state?.spec_version ?? 0;
	const specVersion = input.spec_version ?? currentVersion + 1;
	const entries = [{
		at: now,
		actor,
		entry_schema_version: 1,
		kind: "event:spec_submitted",
		payload: {
			spec_version: specVersion,
			feature: input.feature,
			intent: input.intent,
			adr_refs: input.adr_refs,
			needs_clarification: input.needs_clarification
		}
	}];
	for (const req of input.requirements) entries.push({
		at: now,
		actor,
		entry_schema_version: 1,
		kind: "event:spec_req_added",
		payload: {
			spec_version: specVersion,
			req
		}
	});
	for (const scen of input.scenarios) entries.push({
		at: now,
		actor,
		entry_schema_version: 1,
		kind: "event:spec_scenario_added",
		payload: {
			spec_version: specVersion,
			scenario: scen
		}
	});
	for (const vis of input.visual_contracts) entries.push({
		at: now,
		actor,
		entry_schema_version: 1,
		kind: "event:spec_visual_added",
		payload: {
			spec_version: specVersion,
			visual: vis
		}
	});
	return entries;
}
//#endregion
//#region src/cli/batch-builders.ts
/**
* Approval ordering invariant (historically a codex BLOCK source):
* 1. `gate:decided` (human) FIRST.
* 2. `pending:resolved` (cli) only when the unresolved head is a gate_decision
*    prompt — caller passes `pendingHeadId` exactly when that holds. It MUST sit
*    between the decision and any cursor advance so the reducer dry-run still
*    sees the head unresolved.
* 3. `event:phase_advanced` (cli) only for spec-lock (SPEC.design → EXECUTE.plan);
*    verify-accept moves NO cursor (deliver/settle advance later).
*/
function buildGateApprovalBatch(args) {
	const entries = [{
		kind: "gate:decided",
		payload: {
			gate_kind: args.gate,
			decision: "approved",
			reason: args.reason
		},
		actor: args.humanActor
	}];
	if (args.pendingHeadId !== void 0) entries.push({
		kind: "pending:resolved",
		payload: {
			id: args.pendingHeadId,
			answer: `gate-decide:${args.gate}:approved`
		},
		actor: args.cliActor
	});
	if (args.gate === "spec-lock") entries.push({
		kind: "event:phase_advanced",
		payload: {
			from: args.from,
			to: "EXECUTE.plan"
		},
		actor: args.cliActor
	});
	return entries;
}
const FIX_RESET_STEP = {
	"fix-impl": "implement",
	"fix-test": "red"
};
const BACK_EDGE_TARGET = {
	"amend-spec": "SPEC.spec",
	"amend-tasks": "EXECUTE.work"
};
/**
* finding raise co-emission shape, by `action`:
* - fix-impl/fix-test WITH a target → 3-entry reset batch (→ EXECUTE.work).
* - amend-spec/amend-tasks → 2-entry back-edge batch.
* - everything else, incl. fix-* WITHOUT a target → "none": the caller falls
*   through to its lone `finding:raised` so preflight's FINDING_TARGET_REQUIRED
*   stays the authoritative target gate (we do NOT synthesize a partial batch).
*
* Actor split: `finding:raised` carries the caller's `findingActor`
* (`cli:loaf@<user>`); the mechanical `event:task_step_reset` / phase_advanced
* siblings carry the literal machine actor `"cli:loaf"` — human attribution
* lives on the sibling finding:raised entry one journal line away.
*/
function buildFindingRaiseBatch(args) {
	const findingRaised = {
		kind: "finding:raised",
		payload: args.findingPayload,
		actor: args.findingActor
	};
	const fixResetStep = FIX_RESET_STEP[args.action];
	if (fixResetStep !== void 0 && args.target !== void 0) return {
		kind: "fix-reset",
		backEdgeTo: "EXECUTE.work",
		entries: [
			findingRaised,
			{
				kind: "event:task_step_reset",
				payload: {
					task_id: args.target.taskId,
					step: fixResetStep,
					finding_id: args.findingId
				},
				actor: "cli:loaf"
			},
			{
				kind: "event:phase_advanced",
				payload: {
					from: args.currentSubState,
					to: "EXECUTE.work",
					back_edge: {
						action: args.action,
						finding_id: args.findingId
					}
				},
				actor: "cli:loaf"
			}
		]
	};
	const backEdgeTarget = BACK_EDGE_TARGET[args.action];
	if (backEdgeTarget !== void 0) return {
		kind: "back-edge",
		backEdgeTo: backEdgeTarget,
		entries: [findingRaised, {
			kind: "event:phase_advanced",
			payload: {
				from: args.currentSubState,
				to: backEdgeTarget,
				back_edge: {
					action: args.action,
					finding_id: args.findingId
				}
			},
			actor: "cli:loaf"
		}]
	};
	return { kind: "none" };
}
/** TasksActiveSummary — mirror of docs/schemas.ts §20.
*  current_step is null when no step on the in_progress/ready task is
*  currently running (i.e. between steps or paused). */
const TasksActiveSummary = z.object({
	task_id: z.string().regex(/^T-\d{3,}$/),
	status: z.enum([
		"pending",
		"ready",
		"in_progress",
		"done",
		"abandoned"
	]),
	current_step: z.string().nullable()
}).strict();
const ResumePack = z.object({
	schema_version: z.literal(2),
	at: z.string().datetime(),
	session_id: z.string().uuid(),
	reason: z.string().min(5),
	state_snapshot: StateProjection$1,
	tasks_active_summary: z.array(TasksActiveSummary).default([]),
	recent_evidence: z.array(z.string().regex(/^EV-\d{6,}$/)).max(10),
	recent_findings: z.array(z.string().regex(/^FND-\d{3,}$/)).max(10),
	open_pending: PendingQueueEntry.nullable(),
	notes: z.string().optional()
}).strict();
//#endregion
//#region src/cli/build-resume-pack.ts
function buildResumePack(args) {
	const { snapshot, at, reason } = args;
	const state = snapshot.state;
	if (!state) throw new Error("buildResumePack: snapshot.state is null (no session started)");
	const tasksActive = [];
	for (const task of snapshot.tasks) {
		if (task.status !== "ready" && task.status !== "in_progress") continue;
		let currentStep = null;
		for (const [stepName, step] of Object.entries(task.steps ?? {})) if (step.status === "running") {
			currentStep = stepName;
			break;
		}
		tasksActive.push({
			task_id: task.id,
			status: task.status,
			current_step: currentStep
		});
	}
	const recentEvidenceIds = snapshot.evidence.map((e) => e.id).slice(-10);
	const recentFindingIds = snapshot.findings.map((f) => f.id).slice(-10);
	const stateProjection = composeStateProjection(snapshot, args.entries);
	if (stateProjection === null) throw new Error("buildResumePack: composeStateProjection returned null (state should be non-null at this point)");
	const openPending = stateProjection.pending.length > 0 ? stateProjection.pending[0] : null;
	return {
		schema_version: 2,
		at,
		session_id: state.session_id,
		reason,
		state_snapshot: stateProjection,
		tasks_active_summary: tasksActive,
		recent_evidence: recentEvidenceIds,
		recent_findings: recentFindingIds,
		open_pending: openPending,
		...args.notes !== void 0 && { notes: args.notes }
	};
}
//#endregion
//#region src/cli/tui/list-model.ts
function projectKey(cwd) {
	return `project:${cwd}`;
}
function featureKey(cwd, feature) {
	return `feature:${cwd}:${feature}`;
}
function sessionKey(sessionId) {
	return `session:${sessionId}`;
}
function statusBucket(row) {
	if (row.sub_state.startsWith("DONE.")) return "done";
	if (row.pending_queue_depth > 0) return "blocked";
	if (row.active_tasks.length > 0) return "running";
	return "idle";
}
function filterActive(rows, showAll) {
	if (showAll) return [...rows];
	return rows.filter((row) => !row.sub_state.startsWith("DONE."));
}
function groupByProjectFeature(rows) {
	const projects = /* @__PURE__ */ new Map();
	const featureIndexes = /* @__PURE__ */ new Map();
	for (const row of rows) {
		let project = projects.get(row.cwd);
		if (project === void 0) {
			project = {
				cwd: row.cwd,
				visible_session_count: 0,
				features: []
			};
			projects.set(row.cwd, project);
			featureIndexes.set(row.cwd, /* @__PURE__ */ new Map());
		}
		const projectFeatures = featureIndexes.get(row.cwd);
		let feature = projectFeatures.get(row.feature);
		if (feature === void 0) {
			feature = {
				cwd: row.cwd,
				feature: row.feature,
				visible_session_count: 0,
				sessions: []
			};
			projectFeatures.set(row.feature, feature);
			project.features.push(feature);
		}
		feature.sessions.push(row);
		feature.visible_session_count += 1;
		project.visible_session_count += 1;
	}
	return Array.from(projects.values());
}
function nextSelectableIndex(plan, currentIndex, dir) {
	if (plan.length === 0) return -1;
	if (currentIndex < 0) return 0;
	const next = currentIndex + dir;
	if (next < 0) return 0;
	if (next >= plan.length) return plan.length - 1;
	return next;
}
function resolveSelectionAfterRebuild(plan, prevSelectedKey) {
	if (plan.length === 0) return {
		selectedKey: null,
		index: -1
	};
	if (prevSelectedKey !== null) {
		const index = plan.findIndex((item) => item.key === prevSelectedKey);
		if (index >= 0) return {
			selectedKey: prevSelectedKey,
			index
		};
	}
	return {
		selectedKey: plan[0].key,
		index: 0
	};
}
function toggleCollapsed(collapsed, key) {
	const next = new Set(collapsed);
	if (next.has(key)) next.delete(key);
	else next.add(key);
	return next;
}
function buildRenderPlan(rows, options) {
	const groups = sortProjectGroups(groupByProjectFeature(filterActive(rows, options.showAll)), options.sortMode);
	const plan = [];
	for (const project of groups) {
		const pKey = projectKey(project.cwd);
		const projectCollapsed = options.collapsed.has(pKey);
		plan.push({
			kind: "project",
			key: pKey,
			cwd: project.cwd,
			visible_session_count: project.visible_session_count,
			collapsed: projectCollapsed
		});
		if (projectCollapsed) continue;
		for (const feature of project.features) {
			const fKey = featureKey(feature.cwd, feature.feature);
			const featureCollapsed = options.collapsed.has(fKey);
			plan.push({
				kind: "feature",
				key: fKey,
				cwd: feature.cwd,
				feature: feature.feature,
				visible_session_count: feature.visible_session_count,
				collapsed: featureCollapsed
			});
			if (featureCollapsed) continue;
			for (const row of feature.sessions) plan.push({
				kind: "session",
				key: sessionKey(row.session_id),
				row,
				detail_status: "unknown"
			});
		}
	}
	return plan;
}
function withTreePrefixes(plan) {
	return plan.map((item, index) => {
		switch (item.kind) {
			case "project": return {
				item,
				prefix: ""
			};
			case "feature": return {
				item,
				prefix: `${isLastFeature(plan, index) ? "└─" : "├─"} `
			};
			case "session": {
				const parentFeatureIndex = findParentFeatureIndex(plan, index);
				return {
					item,
					prefix: `${(parentFeatureIndex < 0 ? true : isLastFeature(plan, parentFeatureIndex)) ? "  " : "│ "}${isLastSession(plan, index) ? "└─" : "├─"} `
				};
			}
		}
	});
}
function sortProjectGroups(groups, sortMode) {
	for (const project of groups) {
		for (const feature of project.features) feature.sessions = [...feature.sessions].sort(compareSessions(sortMode));
		project.features = [...project.features].sort(compareFeatures);
	}
	return [...groups].sort(compareProjects);
}
function compareProjects(a, b) {
	return compareIsoDesc(latestAtForProject(a), latestAtForProject(b)) || a.cwd.localeCompare(b.cwd);
}
function compareFeatures(a, b) {
	return compareIsoDesc(latestAtForFeature(a), latestAtForFeature(b)) || a.feature.localeCompare(b.feature);
}
function compareSessions(sortMode) {
	return (a, b) => {
		if (sortMode === "status") {
			const byStatus = statusBucketRank(statusBucket(a)) - statusBucketRank(statusBucket(b));
			if (byStatus !== 0) return byStatus;
		}
		return compareIsoDesc(a.at, b.at) || a.session_id.localeCompare(b.session_id);
	};
}
function latestAtForProject(project) {
	let latest = "";
	for (const feature of project.features) {
		const candidate = latestAtForFeature(feature);
		if (compareIsoDesc(candidate, latest) < 0) latest = candidate;
	}
	return latest;
}
function latestAtForFeature(feature) {
	let latest = "";
	for (const row of feature.sessions) if (compareIsoDesc(row.at, latest) < 0) latest = row.at;
	return latest;
}
function compareIsoDesc(a, b) {
	return a < b ? 1 : a > b ? -1 : 0;
}
function statusBucketRank(bucket) {
	switch (bucket) {
		case "blocked": return 0;
		case "running": return 1;
		case "idle": return 2;
		case "done": return 3;
	}
}
function isLastFeature(plan, index) {
	if (plan[index]?.kind !== "feature") return true;
	for (let cursor = index + 1; cursor < plan.length; cursor += 1) {
		const next = plan[cursor];
		if (next.kind === "project") return true;
		if (next.kind === "feature") return false;
	}
	return true;
}
function isLastSession(plan, index) {
	if (plan[index]?.kind !== "session") return true;
	for (let cursor = index + 1; cursor < plan.length; cursor += 1) {
		const next = plan[cursor];
		if (next.kind === "project" || next.kind === "feature") return true;
		if (next.kind === "session") return false;
	}
	return true;
}
function findParentFeatureIndex(plan, index) {
	for (let cursor = index - 1; cursor >= 0; cursor -= 1) {
		const item = plan[cursor];
		if (item.kind === "feature") return cursor;
		if (item.kind === "project") return -1;
	}
	return -1;
}
//#endregion
//#region src/cli/tui/format-row.ts
/** PHASE.SUB column — localized sub_state label. */
function formatPhaseSub(row, i18n) {
	return i18n.t(subStateKey(row.sub_state));
}
/** ITER column — iteration as decimal string. */
function formatIteration(row) {
	return String(row.iteration);
}
/** STATUS column — precedence-ordered text badge per r354 P2. */
function formatStatus(row, i18n) {
	if (row.sub_state.startsWith("DONE.")) return i18n.t(statusIndicatorKey("done"));
	if (row.pending_queue_depth >= 2) return `${i18n.t(statusIndicatorKey("blocked"))} [×${row.pending_queue_depth}]`;
	if (row.pending_queue_depth === 1) return i18n.t(statusIndicatorKey("blocked"));
	if (row.active_tasks.length >= 2) return `${i18n.t(statusIndicatorKey("running"))} [×${row.active_tasks.length}]`;
	if (row.active_tasks.length === 1) return i18n.t(statusIndicatorKey("running"));
	return formatPhaseSub(row, i18n);
}
/** STATUS badge for rows that already render sub_state elsewhere. */
function formatStatusBadge(row, i18n) {
	if (statusBucket(row) === "idle") return i18n.t(statusIndicatorKey("idle"));
	return formatStatus(row, i18n);
}
//#endregion
//#region src/cli/tui/chrome.ts
const DETAIL_FIELD_KEYS = {
	feature: CHROME_KEYS.tuiDetailFieldFeature,
	session: CHROME_KEYS.tuiDetailFieldSession,
	label: CHROME_KEYS.tuiDetailFieldLabel,
	workspace: CHROME_KEYS.tuiDetailFieldWorkspace,
	ceremony: CHROME_KEYS.tuiDetailFieldCeremony,
	phase: CHROME_KEYS.tuiDetailFieldPhase,
	iteration: CHROME_KEYS.tuiDetailFieldIteration,
	complexity: CHROME_KEYS.tuiDetailFieldComplexity,
	created: CHROME_KEYS.tuiDetailFieldCreated,
	updated: CHROME_KEYS.tuiDetailFieldUpdated,
	spec_locked: CHROME_KEYS.tuiDetailFieldSpecLocked,
	verify_accepted: CHROME_KEYS.tuiDetailFieldVerifyAccepted,
	spec_version: CHROME_KEYS.tuiDetailFieldSpecVersion,
	tail_seq: CHROME_KEYS.tuiDetailFieldTailSeq
};
const DETAIL_SECTION_KEYS = {
	tasks: CHROME_KEYS.tuiDetailSectionTasks,
	evidence: CHROME_KEYS.tuiDetailSectionEvidence,
	open_findings: CHROME_KEYS.tuiDetailSectionOpenFindings,
	pending: CHROME_KEYS.tuiDetailSectionPending
};
const EVIDENCE_BADGE_KEYS = {
	pass: CHROME_KEYS.tuiDetailEvidenceBadgePass,
	fail: CHROME_KEYS.tuiDetailEvidenceBadgeFail,
	waived: CHROME_KEYS.tuiDetailEvidenceBadgeWaived
};
function formatTuiListTitle(i18n, activeCount, totalCount) {
	return i18n.t(CHROME_KEYS.tuiListTitle, {
		active_count: activeCount,
		total_count: totalCount
	});
}
function formatTuiSortLabel(i18n, sortMode) {
	const sort = i18n.t(sortMode === "time" ? CHROME_KEYS.tuiListSortTime : CHROME_KEYS.tuiListSortStatus);
	return i18n.t(CHROME_KEYS.tuiListSort, { sort });
}
function formatTuiListHelp(i18n) {
	return i18n.t(CHROME_KEYS.tuiListHelp);
}
function formatTuiListRowIteration(i18n, iteration) {
	return i18n.t(CHROME_KEYS.tuiListRowIteration, { value: iteration });
}
function formatTuiDetailHelp(i18n) {
	return i18n.t(CHROME_KEYS.tuiDetailHelp);
}
function formatTuiDetailNone(i18n) {
	return i18n.t(CHROME_KEYS.tuiDetailNone);
}
function formatTuiBoolean(i18n, value) {
	return i18n.t(value ? CHROME_KEYS.tuiDetailBooleanTrue : CHROME_KEYS.tuiDetailBooleanFalse);
}
function formatTuiDetailField(i18n, field, value) {
	return i18n.t(DETAIL_FIELD_KEYS[field], { value });
}
function formatTuiDetailBasedOn(i18n, spec, tasks) {
	return i18n.t(CHROME_KEYS.tuiDetailFieldBasedOn, {
		spec,
		tasks
	});
}
function formatTuiDetailSectionTitle(i18n, section, count) {
	return i18n.t(DETAIL_SECTION_KEYS[section], { count });
}
function formatTuiDetailEvidenceBadge(i18n, badge) {
	return i18n.t(EVIDENCE_BADGE_KEYS[badge]);
}
function formatTuiDetailSidecarSummary(i18n, path) {
	return i18n.t(CHROME_KEYS.tuiDetailSidecarSummary, { path });
}
function formatTuiDetailStepSummary(i18n, done, total) {
	return i18n.t(CHROME_KEYS.tuiDetailStepSummary, {
		done,
		total
	});
}
//#endregion
//#region src/cli/tui/app.tsx
function App({ initialRows, loadRows, loadDetail, i18n }) {
	const { exit } = useApp();
	const [rows, setRows] = useState(initialRows);
	const [reloading, setReloading] = useState(false);
	const [selectedKey, setSelectedKey] = useState(null);
	const [showAll, setShowAll] = useState(false);
	const [sortMode, setSortMode] = useState("time");
	const [collapsed, setCollapsed] = useState(() => /* @__PURE__ */ new Set());
	const [mode, setMode] = useState("list");
	const [detail, setDetail] = useState(null);
	const plan = useMemo(() => buildRenderPlan(rows, {
		showAll,
		sortMode,
		collapsed
	}), [
		rows,
		showAll,
		sortMode,
		collapsed
	]);
	const selection = useMemo(() => resolveSelectionAfterRebuild(plan, selectedKey), [plan, selectedKey]);
	const treePlan = useMemo(() => withTreePrefixes(plan), [plan]);
	const activeCount = useMemo(() => filterActive(rows, false).length, [rows]);
	const handleReload = useCallback(async () => {
		if (reloading) return;
		setReloading(true);
		try {
			setRows(await loadRows());
		} finally {
			setReloading(false);
		}
	}, [loadRows, reloading]);
	const handleOpenDetail = useCallback((row) => {
		setMode("detail");
		setDetail({
			row,
			result: null
		});
		loadDetail(row).then((result) => {
			setDetail((current) => current?.row.session_id === row.session_id ? {
				row,
				result
			} : current);
		}).catch((error) => {
			setDetail((current) => current?.row.session_id === row.session_id ? {
				row,
				result: unexpectedDetailError(error)
			} : current);
		});
	}, [loadDetail]);
	useEffect(() => {
		if (selectedKey !== selection.selectedKey) setSelectedKey(selection.selectedKey);
	}, [selectedKey, selection.selectedKey]);
	useInput((input, key) => {
		if (input === "q" || key.ctrl && input === "c") {
			exit();
			return;
		}
		if (key.escape) {
			if (mode === "detail") {
				setMode("list");
				return;
			}
			exit();
			return;
		}
		if (mode === "detail") return;
		if (key.upArrow || key.downArrow) {
			const nextIndex = nextSelectableIndex(plan, selection.index, key.downArrow ? 1 : -1);
			setSelectedKey((nextIndex >= 0 ? plan[nextIndex] : void 0)?.key ?? null);
			return;
		}
		if (input === " " || key.return) {
			const selectedItem = selection.index >= 0 ? plan[selection.index] : void 0;
			if (selectedItem?.kind === "project" || selectedItem?.kind === "feature") {
				setCollapsed((prev) => toggleCollapsed(prev, selectedItem.key));
				setSelectedKey(selectedItem.key);
			}
			if (key.return && selectedItem?.kind === "session") handleOpenDetail(selectedItem.row);
			return;
		}
		if (input === "a") {
			setShowAll((current) => !current);
			return;
		}
		if (input === "s") {
			setSortMode((current) => current === "time" ? "status" : "time");
			return;
		}
		if (input === "r") handleReload();
	});
	if (mode === "detail") return /* @__PURE__ */ jsxs(Box, {
		flexDirection: "column",
		padding: 1,
		width: "100%",
		children: [/* @__PURE__ */ jsxs(Box, {
			borderStyle: "round",
			flexDirection: "column",
			paddingX: 1,
			width: "100%",
			children: [/* @__PURE__ */ jsx(Text, {
				bold: true,
				children: i18n.t(CHROME_KEYS.tuiDetailTitle)
			}), renderDetail(detail, i18n)]
		}), /* @__PURE__ */ jsx(Box, {
			marginTop: 1,
			paddingX: 1,
			children: /* @__PURE__ */ jsx(Text, {
				dimColor: true,
				children: formatTuiDetailHelp(i18n)
			})
		})]
	});
	return /* @__PURE__ */ jsxs(Box, {
		flexDirection: "column",
		padding: 1,
		width: "100%",
		children: [/* @__PURE__ */ jsxs(Box, {
			borderStyle: "round",
			flexDirection: "column",
			paddingX: 1,
			width: "100%",
			children: [/* @__PURE__ */ jsxs(Box, { children: [
				/* @__PURE__ */ jsx(Text, {
					bold: true,
					children: formatTuiListTitle(i18n, activeCount, rows.length)
				}),
				/* @__PURE__ */ jsx(Text, {
					dimColor: true,
					children: ` · ${formatTuiSortLabel(i18n, sortMode)}`
				}),
				reloading && /* @__PURE__ */ jsx(Text, {
					dimColor: true,
					children: ` · ${i18n.t(CHROME_KEYS.tuiListReloading)}`
				})
			] }), plan.length === 0 ? /* @__PURE__ */ jsx(Text, {
				dimColor: true,
				children: i18n.t(CHROME_KEYS.tuiListEmpty)
			}) : treePlan.map((treeItem) => renderItem(treeItem, treeItem.item.key === selection.selectedKey, i18n))]
		}), /* @__PURE__ */ jsx(Box, {
			marginTop: 1,
			paddingX: 1,
			children: /* @__PURE__ */ jsx(Text, {
				dimColor: true,
				children: formatTuiListHelp(i18n)
			})
		})]
	});
}
function renderItem(treeItem, selected, i18n) {
	const { item, prefix } = treeItem;
	const marker = selected ? ">" : " ";
	switch (item.kind) {
		case "project": return /* @__PURE__ */ jsx(Box, { children: /* @__PURE__ */ jsx(Text, {
			inverse: selected,
			children: `${marker} ${caret(item.collapsed)} ${item.cwd} (${item.visible_session_count})`
		}) }, item.key);
		case "feature": return /* @__PURE__ */ jsx(Box, { children: /* @__PURE__ */ jsx(Text, {
			inverse: selected,
			children: `${marker} ${prefix}${caret(item.collapsed)} ${item.feature} (${item.visible_session_count})`
		}) }, item.key);
		case "session": return /* @__PURE__ */ jsx(Box, { children: /* @__PURE__ */ jsx(Text, {
			inverse: selected,
			children: `${marker} ${prefix}${formatPhaseSub(item.row, i18n)} · ${formatTuiListRowIteration(i18n, formatIteration(item.row))} · ${formatStatusBadge(item.row, i18n)}`
		}) }, item.key);
	}
}
function caret(collapsed) {
	return collapsed ? "▸" : "▾";
}
function renderDetail(detail, i18n) {
	if (detail === null) return /* @__PURE__ */ jsx(Text, {
		dimColor: true,
		children: i18n.t(CHROME_KEYS.tuiDetailNoSelected)
	});
	if (detail.result === null) return /* @__PURE__ */ jsxs(Box, {
		flexDirection: "column",
		children: [/* @__PURE__ */ jsx(Text, {
			bold: true,
			children: i18n.t(CHROME_KEYS.tuiDetailTitle)
		}), /* @__PURE__ */ jsx(Text, {
			dimColor: true,
			children: i18n.t(CHROME_KEYS.tuiDetailLoading)
		})]
	});
	switch (detail.result.status) {
		case "ready": return renderReadyDetail(detail.result.vm, i18n);
		case "missing": return /* @__PURE__ */ jsxs(Box, {
			flexDirection: "column",
			children: [
				/* @__PURE__ */ jsx(Text, {
					bold: true,
					children: i18n.t(CHROME_KEYS.tuiDetailMissingTitle, { feature: detail.row.feature })
				}),
				/* @__PURE__ */ jsx(Text, { children: detail.result.message }),
				detail.result.fix !== null && /* @__PURE__ */ jsx(Text, {
					dimColor: true,
					children: detail.result.fix
				})
			]
		});
		case "stale": return /* @__PURE__ */ jsxs(Box, {
			flexDirection: "column",
			children: [
				/* @__PURE__ */ jsx(Text, {
					bold: true,
					children: i18n.t(CHROME_KEYS.tuiDetailStaleTitle, { feature: detail.row.feature })
				}),
				/* @__PURE__ */ jsx(Text, { children: detail.result.message }),
				detail.result.fix !== null && /* @__PURE__ */ jsx(Text, {
					dimColor: true,
					children: detail.result.fix
				})
			]
		});
		case "error": return /* @__PURE__ */ jsxs(Box, {
			flexDirection: "column",
			children: [/* @__PURE__ */ jsx(Text, {
				bold: true,
				children: i18n.t(CHROME_KEYS.tuiDetailErrorTitle, { feature: detail.row.feature })
			}), /* @__PURE__ */ jsx(Text, { children: detail.result.message })]
		});
	}
}
function renderReadyDetail(vm, i18n) {
	return /* @__PURE__ */ jsxs(Box, {
		flexDirection: "column",
		children: [
			/* @__PURE__ */ jsx(Text, {
				bold: true,
				children: formatTuiDetailField(i18n, "feature", vm.feature)
			}),
			/* @__PURE__ */ jsx(Text, { children: formatTuiDetailField(i18n, "session", vm.session_id_short) }),
			/* @__PURE__ */ jsx(Text, { children: formatTuiDetailField(i18n, "label", vm.session_label ?? "n/a") }),
			/* @__PURE__ */ jsx(Text, { children: formatTuiDetailField(i18n, "workspace", vm.workspace) }),
			/* @__PURE__ */ jsx(Text, { children: formatTuiDetailField(i18n, "ceremony", vm.ceremony_label) }),
			/* @__PURE__ */ jsx(Text, { children: formatTuiDetailField(i18n, "phase", vm.sub_state) }),
			/* @__PURE__ */ jsx(Text, { children: formatTuiDetailField(i18n, "iteration", vm.iteration) }),
			/* @__PURE__ */ jsx(Text, { children: formatTuiDetailField(i18n, "complexity", vm.complexity_score) }),
			/* @__PURE__ */ jsx(Text, { children: formatTuiDetailBasedOn(i18n, vm.based_on.spec, vm.based_on.tasks) }),
			/* @__PURE__ */ jsx(Text, { children: formatTuiDetailField(i18n, "created", vm.created_at_relative) }),
			/* @__PURE__ */ jsx(Text, { children: formatTuiDetailField(i18n, "updated", vm.updated_at_relative) }),
			/* @__PURE__ */ jsx(Text, { children: formatTuiDetailField(i18n, "spec_locked", formatTuiBoolean(i18n, vm.spec_locked)) }),
			/* @__PURE__ */ jsx(Text, { children: formatTuiDetailField(i18n, "verify_accepted", formatTuiBoolean(i18n, vm.verify_accepted)) }),
			/* @__PURE__ */ jsx(Text, { children: formatTuiDetailField(i18n, "spec_version", vm.spec_version) }),
			/* @__PURE__ */ jsx(Text, { children: formatTuiDetailField(i18n, "tail_seq", vm.tail_seq) }),
			/* @__PURE__ */ jsxs(Box, {
				marginTop: 1,
				flexDirection: "column",
				children: [/* @__PURE__ */ jsx(Text, {
					bold: true,
					children: formatTuiDetailSectionTitle(i18n, "tasks", vm.tasks.length)
				}), vm.tasks.length === 0 ? /* @__PURE__ */ jsx(Text, {
					dimColor: true,
					children: `  ${formatTuiDetailNone(i18n)}`
				}) : vm.tasks.map((task) => /* @__PURE__ */ jsx(Text, { children: `  ${task.id} ${task.status} ${task.kind}${task.title === null ? "" : ` ${task.title}`} · ${i18n.t(CHROME_KEYS.tuiDetailRowSteps, { value: task.step_summary })}` }, task.id))]
			}),
			/* @__PURE__ */ jsxs(Box, {
				marginTop: 1,
				flexDirection: "column",
				children: [/* @__PURE__ */ jsx(Text, {
					bold: true,
					children: formatTuiDetailSectionTitle(i18n, "evidence", vm.evidence.length)
				}), vm.evidence.length === 0 ? /* @__PURE__ */ jsx(Text, {
					dimColor: true,
					children: `  ${formatTuiDetailNone(i18n)}`
				}) : vm.evidence.map((evidence) => /* @__PURE__ */ jsx(Text, { children: `  ${evidence.id} [${formatTuiDetailEvidenceBadge(i18n, evidence.result_badge)}] ${evidence.kind} ${i18n.t(CHROME_KEYS.tuiDetailRowIteration, { value: evidence.iteration })}${evidence.task_id === null ? "" : ` ${i18n.t(CHROME_KEYS.tuiDetailRowTask, { value: evidence.task_id })}`} · ${evidence.summary}` }, evidence.id))]
			}),
			/* @__PURE__ */ jsxs(Box, {
				marginTop: 1,
				flexDirection: "column",
				children: [/* @__PURE__ */ jsx(Text, {
					bold: true,
					children: formatTuiDetailSectionTitle(i18n, "open_findings", vm.open_findings.length)
				}), vm.open_findings.length === 0 ? /* @__PURE__ */ jsx(Text, {
					dimColor: true,
					children: `  ${formatTuiDetailNone(i18n)}`
				}) : vm.open_findings.map((finding) => /* @__PURE__ */ jsx(Text, { children: `  ${finding.id} ${finding.category}/${finding.action}${finding.target === null ? "" : ` ${i18n.t(CHROME_KEYS.tuiDetailRowTarget, { value: finding.target })}`}${finding.reason ? ` · ${finding.reason}` : ""}${finding.summary ? ` · ${finding.summary}` : ""}` }, finding.id))]
			}),
			/* @__PURE__ */ jsxs(Box, {
				marginTop: 1,
				flexDirection: "column",
				children: [/* @__PURE__ */ jsx(Text, {
					bold: true,
					children: formatTuiDetailSectionTitle(i18n, "pending", vm.pending.length)
				}), vm.pending.length === 0 ? /* @__PURE__ */ jsx(Text, {
					dimColor: true,
					children: `  ${formatTuiDetailNone(i18n)}`
				}) : vm.pending.map((pending) => /* @__PURE__ */ jsx(Text, { children: `  ${pending.pending_id} ${pending.kind} ${i18n.t(CHROME_KEYS.tuiDetailRowBlocks, { value: pending.blocks })}${pending.options.length === 0 ? "" : ` ${i18n.t(CHROME_KEYS.tuiDetailRowOptions, { value: pending.options.join(",") })}`} · ${pending.question}` }, pending.pending_id))]
			})
		]
	});
}
function unexpectedDetailError(error) {
	return {
		status: "error",
		message: error instanceof Error ? error.message : String(error)
	};
}
//#endregion
//#region src/cli/tui/detail-model.ts
const DETAIL_PROJECTION_KINDS = [
	"state",
	"tasks",
	"evidence",
	"findings",
	"pending"
];
function classifyDetailOutcome(row, input, now, i18n) {
	if (input.ok) return {
		status: "ready",
		vm: shapeDetailViewModel(row, input.loaded, now, i18n)
	};
	const { error } = input;
	if (error instanceof NoSessionError) return {
		status: "missing",
		message: i18n.t(CHROME_KEYS.tuiDetailMissingMessage, { feature: row.feature }),
		fix: detailFix(error.detail)
	};
	if (error instanceof SnapshotStaleError) return {
		status: "stale",
		reason: error.reason,
		message: i18n.t(CHROME_KEYS.tuiDetailStaleMessage, { reason: error.reason }),
		fix: detailFix(error.detail)
	};
	return {
		status: "error",
		message: error instanceof Error ? error.message : String(error)
	};
}
function shapeDetailViewModel(row, loaded, now, i18n) {
	const { state, tasks, evidence, findings, pending, meta } = loaded;
	return {
		feature: row.feature,
		session_id_short: row.session_id_short,
		session_label: state.session_label,
		workspace: state.workspace,
		ceremony_label: state.ceremony_label,
		phase: i18n.t(phaseKey(state.phase)),
		sub_state: i18n.t(subStateKey(state.sub_state)),
		iteration: state.iteration,
		complexity_score: state.complexity_score === null ? "n/a" : String(state.complexity_score),
		based_on: state.based_on,
		created_at_relative: formatAtRelative(state.created_at, now, i18n),
		updated_at_relative: formatAtRelative(state.updated_at, now, i18n),
		spec_locked: state.spec_locked,
		verify_accepted: state.verify_accepted,
		spec_version: state.spec_version,
		tail_seq: meta.last_applied_seq,
		tasks: tasks === null ? [] : tasks.tasks.map((task) => ({
			id: task.id,
			kind: i18n.t(taskKindKey(task.kind)),
			status: i18n.t(taskStatusKey(task.status)),
			title: optionalStringField(task, "title"),
			step_summary: formatStepSummary(task.execution, i18n)
		})),
		evidence: evidence.evidence.map((entry) => ({
			id: entry.id,
			kind: i18n.t(evidenceKindKey(entry.kind)),
			result: entry.result,
			result_badge: resultBadge(entry.result),
			summary: truncateHighSignal(summaryText(entry.summary, i18n)),
			iteration: entry.iteration,
			task_id: entry.task_id ?? null
		})),
		open_findings: findings.findings.filter((finding) => finding.status === "open").map((finding) => ({
			id: finding.id,
			category: i18n.t(findingCategoryKey(finding.category)),
			action: i18n.t(findingActionKey(finding.action)),
			summary: truncateHighSignal(finding.summary ?? ""),
			reason: truncateHighSignal(finding.reason ?? ""),
			target: finding.target === void 0 ? null : `${finding.target.task_id}/${finding.target.step}`
		})),
		pending: pending.pending.filter((entry) => !entry.resolved).map((entry) => ({
			pending_id: entry.pending_id,
			kind: i18n.t(pendingKindKey(entry.kind)),
			question: entry.question,
			blocks: entry.blocks,
			options: entry.options ?? []
		}))
	};
}
function detailFix(detail) {
	return typeof detail["fix"] === "string" ? detail["fix"] : null;
}
function resultBadge(result) {
	switch (result) {
		case "passed":
		case "approved": return "pass";
		case "failed":
		case "rejected": return "fail";
		case "waived": return "waived";
		default: throw new Error(`unexpected evidence result: ${result}`);
	}
}
function summaryText(summary, i18n) {
	if (typeof summary === "string") return summary;
	if (summary.mode === "inline") return summary.text;
	return formatTuiDetailSidecarSummary(i18n, summary.ref.path);
}
function truncateHighSignal(value) {
	const limit = 75;
	if (value.length <= limit) return value;
	return `${value.slice(0, limit - 1)}…`;
}
function formatStepSummary(execution, i18n) {
	const steps = Object.values(execution);
	const done = steps.filter((step) => step.status === "passed" || step.status === "waived").length;
	return formatTuiDetailStepSummary(i18n, done, steps.length);
}
function optionalStringField(value, field) {
	if (typeof value !== "object" || value === null) return null;
	const candidate = value[field];
	return typeof candidate === "string" && candidate.length > 0 ? candidate : null;
}
//#endregion
//#region src/cli/tui/render.ts
async function defaultRenderTui(app) {
	const { render } = await import("ink");
	await render(app).waitUntilExit();
}
/** Canonical event list — frozen order for stable `--list-events` output
*  and unknown-event did-you-mean ranking. */
const HOOK_EVENTS = z.enum([
	"session-start",
	"write-guard",
	"scope-track",
	"closure-check"
]).options;
/** Map each hook event to its Claude Code wire-protocol event name.
*  Mirror of `docs/schemas.ts:HOOK_EVENT_TO_CLAUDE_CODE`. */
const HOOK_EVENT_TO_CLAUDE_CODE = {
	"session-start": "SessionStart",
	"write-guard": "PreToolUse(Write,Edit)",
	"scope-track": "PostToolUse(Write,Edit)",
	"closure-check": "Stop"
};
//#endregion
//#region src/core/sub-state-contracts.ts
const MutationRights = z.object({
	writable_fields: z.array(z.string()).default([]),
	forbidden_fields: z.array(z.string()).default([])
});
z.object({
	sub_state: SubState$1,
	entry: z.string(),
	exit: z.string(),
	write_paths: z.array(z.string()),
	mutation_rights: MutationRights.optional(),
	next: z.array(SubState$1),
	prompt_inject: z.string()
});
/** sub_state → contract lookup (built once; the contract list is frozen). */
const SUB_STATE_CONTRACT_BY_STATE = Object.fromEntries([
	{
		sub_state: "TRIAGE.score",
		entry: "loaf start <desc> invoked",
		exit: "complexity_score computed (0-100)",
		write_paths: [".loaf/<feature>/state.json"],
		next: ["TRIAGE.confirm"],
		prompt_inject: "Score 0-100 across files/api/schema/concurrency/security. Suggest profile."
	},
	{
		sub_state: "TRIAGE.confirm",
		entry: "score computed",
		exit: "user accepts or overrides profile",
		write_paths: [".loaf/<feature>/state.json"],
		next: ["SPEC.proposal", "EXECUTE.plan"],
		prompt_inject: "Confirm proposed profile (quick/light/standard/deep — see skill PRESETS) or override."
	},
	{
		sub_state: "SPEC.proposal",
		entry: "ceremony.spec_phase=true && TRIAGE.confirm done; OR Q9 escalation backfill (ceremony.spec_phase 由 false 改 true)",
		exit: "spec.md body has Proposal section",
		write_paths: [".loaf/<feature>/spec.md", ".loaf/<feature>/spec-draft-context.md"],
		next: ["SPEC.spec"],
		prompt_inject: "Write Proposal: why / scope / anti-scope. If backfill, read spec-draft-context.md."
	},
	{
		sub_state: "SPEC.spec",
		entry: "proposal section exists OR amend-spec back-edge",
		exit: "frontmatter has requirements (each with three-way verifiability) + scenarios (+visual_contracts if UI); needs_clarification empty",
		write_paths: [".loaf/<feature>/spec.md"],
		next: ["SPEC.plan"],
		prompt_inject: "Author EARS REQ-* with measurable / verified_by_scenarios / acceptance_na+reason. Add Gherkin SCEN-* and VIS-* as needed."
	},
	{
		sub_state: "SPEC.plan",
		entry: "spec section complete && needs_clarification empty",
		exit: "spec.md body has Plan section",
		write_paths: [".loaf/<feature>/spec.md"],
		mutation_rights: {
			writable_fields: ["spec.md:body.plan"],
			forbidden_fields: [
				"spec.md:frontmatter.requirements",
				"spec.md:frontmatter.scenarios",
				"spec.md:frontmatter.visual_contracts",
				"tasks.json:*"
			]
		},
		next: ["SPEC.design"],
		prompt_inject: "Plan: risks / dependencies / milestones."
	},
	{
		sub_state: "SPEC.design",
		entry: "plan section complete",
		exit: "design section + tasks.json generated; every REQ/SCEN/VIS bound to ≥1 task",
		write_paths: [".loaf/<feature>/spec.md", ".loaf/<feature>/tasks.json"],
		mutation_rights: {
			writable_fields: ["spec.md:body.design", "tasks.json:*"],
			forbidden_fields: [
				"spec.md:frontmatter.requirements",
				"spec.md:frontmatter.scenarios",
				"spec.md:frontmatter.visual_contracts"
			]
		},
		next: ["EXECUTE.plan"],
		prompt_inject: "Design + decompose into tasks bound to REQ/SCEN/VIS via task.drives[]. Use labels[] for bug/security/etc."
	},
	{
		sub_state: "EXECUTE.plan",
		entry: "spec-lock passed (or quick: TRIAGE.confirm done)",
		exit: "every task has execution policy populated per its kind",
		write_paths: [".loaf/<feature>/tasks.json"],
		mutation_rights: {
			writable_fields: ["tasks.json:tasks[].execution[].applicability", "tasks.json:tasks[].status"],
			forbidden_fields: [
				"tasks.json:tasks[].id",
				"tasks.json:tasks[].kind",
				"tasks.json:tasks[].drives",
				"tasks.json:tasks[].depends_on",
				"tasks.json:tasks[].labels",
				"spec.md:*"
			]
		},
		next: ["EXECUTE.work"],
		prompt_inject: "Derive execution policy for each task from kind × profile. Set step.applicability accordingly."
	},
	{
		sub_state: "EXECUTE.work",
		entry: "EXECUTE.plan done OR fix-impl/fix-test/amend-tasks back-edge",
		exit: "every task.status = done OR abandoned, with all required steps passed/waived/na",
		write_paths: [
			".loaf/<feature>/tasks.json",
			".loaf/<feature>/evidence.jsonl",
			".loaf/<feature>/findings.jsonl"
		],
		mutation_rights: {
			writable_fields: [
				"tasks.json:tasks[].execution[].status",
				"tasks.json:tasks[].execution[].evidence_refs",
				"tasks.json:tasks[].status",
				"evidence.jsonl:*",
				"findings.jsonl:*"
			],
			forbidden_fields: [
				"tasks.json:tasks[].id",
				"tasks.json:tasks[].kind",
				"tasks.json:tasks[].drives",
				"tasks.json:tasks[].depends_on",
				"tasks.json:tasks[].labels",
				"spec.md:*"
			]
		},
		next: ["EXECUTE.work", "EXECUTE.done"],
		prompt_inject: "Execute each in-progress task at its currently-running step. Append evidence with covers[]."
	},
	{
		sub_state: "EXECUTE.done",
		entry: "all tasks status ∈ {done, abandoned}",
		exit: "advance to VERIFY.plan (verify_phase=true); OR DONE.delivered (verify_phase=false: quick / light non-spike via `loaf deliver`: verify-min runs at this boundary, on pass transition direct to DONE.delivered, on fail exit 2 — see protocol.md §3.2 + §10.14)",
		write_paths: [],
		next: ["VERIFY.plan", "DONE.delivered"],
		prompt_inject: "All tasks complete. verify_phase=true → advance to VERIFY.plan. verify_phase=false non-spike → run `loaf deliver` (verify-min then DONE.delivered). spike (any profile) → deliver blocked; pick archive / spike convert / abandon per §8.3."
	},
	{
		sub_state: "VERIFY.plan",
		entry: "EXECUTE.done && ceremony.verify_phase=true",
		exit: "applicability computed for each VerifyCheckKind (must/optional/na with reasons)",
		write_paths: [".loaf/<feature>/state.json"],
		next: [
			"VERIFY.run",
			"VERIFY.review",
			"VERIFY.acceptance",
			"VERIFY.visual",
			"VERIFY.accept"
		],
		prompt_inject: "Compute which verify checks apply: run/review/acceptance/visual. Output reasoning + N/A justifications."
	},
	{
		sub_state: "VERIFY.run",
		entry: "VERIFY.plan done with run applicability ∈ {must, optional-elected}; OR amend back-edge",
		exit: "run check passed or explicitly waived",
		write_paths: [".loaf/<feature>/evidence.jsonl", ".loaf/<feature>/findings.jsonl"],
		next: [
			"VERIFY.review",
			"VERIFY.acceptance",
			"VERIFY.visual",
			"VERIFY.accept"
		],
		prompt_inject: "Run the `run` check (test + lint + typecheck). Append evidence with kind=local-check or task-summary. Raise findings as needed."
	},
	{
		sub_state: "VERIFY.review",
		entry: "VERIFY.plan or prior check done with review applicability ∈ {must, optional-elected}",
		exit: "review check passed or explicitly waived",
		write_paths: [".loaf/<feature>/evidence.jsonl", ".loaf/<feature>/findings.jsonl"],
		next: [
			"VERIFY.run",
			"VERIFY.acceptance",
			"VERIFY.visual",
			"VERIFY.accept"
		],
		prompt_inject: "Run quality review (spec_fit + quality_fit). Append evidence with kind=verify-review. Raise findings as needed."
	},
	{
		sub_state: "VERIFY.acceptance",
		entry: "VERIFY.plan or prior check done with acceptance applicability ∈ {must, optional-elected}",
		exit: "acceptance check passed or explicitly waived",
		write_paths: [".loaf/<feature>/evidence.jsonl", ".loaf/<feature>/findings.jsonl"],
		next: [
			"VERIFY.run",
			"VERIFY.review",
			"VERIFY.visual",
			"VERIFY.accept"
		],
		prompt_inject: "Run selected Gherkin acceptance scenarios. Append evidence with kind=acceptance. Raise findings as needed."
	},
	{
		sub_state: "VERIFY.visual",
		entry: "VERIFY.plan or prior check done with visual applicability ∈ {must, optional-elected}",
		exit: "visual check passed or explicitly waived",
		write_paths: [".loaf/<feature>/evidence.jsonl", ".loaf/<feature>/findings.jsonl"],
		next: [
			"VERIFY.run",
			"VERIFY.review",
			"VERIFY.acceptance",
			"VERIFY.accept"
		],
		prompt_inject: "Run visual contract verification. Append evidence with kind=visual-review (attachments required). Raise findings as needed."
	},
	{
		sub_state: "VERIFY.accept",
		entry: "all applicable checks passed/waived + no open findings",
		exit: "verify-accept gate approved. settle_phase=true (deep) → SETTLE.reconcile via `loaf settle`; settle_phase=false (standard) → DONE.delivered via `loaf deliver`",
		write_paths: [".loaf/<feature>/evidence.jsonl"],
		next: ["SETTLE.reconcile", "DONE.delivered"],
		prompt_inject: "Verify-accept gate. Review check status + open findings. Approve or reject. On approve: settle_phase=true → `loaf settle` enters SETTLE.reconcile; settle_phase=false → `loaf deliver` enters DONE.delivered."
	},
	{
		sub_state: "SETTLE.reconcile",
		entry: "verify-accept passed && ceremony.settle_phase=true (deep only after rev 5.x; quick/light/standard skip SETTLE)",
		exit: "reconcile.json valid",
		write_paths: [".loaf/<feature>/reconcile.json"],
		next: ["SETTLE.lessons"],
		prompt_inject: "Compare planned_scope vs actual_scope. Resolve every drift. Snapshot verify_checks_status."
	},
	{
		sub_state: "SETTLE.lessons",
		entry: "reconcile valid (deep only after rev 5.x; quick/light/standard skip SETTLE)",
		exit: "lessons.md appended (deep: lessons_required=must)",
		write_paths: [".loaf/<feature>/lessons.md"],
		next: [
			"DONE.delivered",
			"DONE.archived",
			"DONE.abandoned"
		],
		prompt_inject: "Append lessons (deep: MUST). User then runs `loaf deliver` / `loaf archive` / `loaf abandon`."
	},
	{
		sub_state: "DONE.delivered",
		entry: "loaf deliver succeeded (Q4: advisory only — no git/gh side effects)",
		exit: "terminal",
		write_paths: [],
		next: [],
		prompt_inject: ""
	},
	{
		sub_state: "DONE.archived",
		entry: "loaf archive --reason '...'",
		exit: "terminal",
		write_paths: [],
		next: [],
		prompt_inject: ""
	},
	{
		sub_state: "DONE.abandoned",
		entry: "loaf abandon --reason '...' (reason required)",
		exit: "terminal",
		write_paths: [],
		next: [],
		prompt_inject: ""
	}
].map((c) => [c.sub_state, c]));
/**
* prompt_inject text for a sub_state. Returns `undefined` for an unknown
* sub_state (caller decides: session-start treats unknown as no-context).
* Terminal DONE.* states carry an empty-string prompt_inject by design.
*/
function promptInjectFor(subState) {
	return SUB_STATE_CONTRACT_BY_STATE[subState]?.prompt_inject;
}
//#endregion
//#region src/core/hook-read.ts
/**
* Compose the `additionalContext` string injected into a Claude Code
* SessionStart hook. Always returns a non-empty banner line; the
* prompt_inject / findings / pending sections append only when present.
*
* Terminal DONE.* sub_states have an empty prompt_inject by design — the
* banner still renders so the agent knows the session is terminal.
*/
function composeSessionStartContext(input) {
	const lines = [];
	lines.push(`loaf session — ${input.sub_state} (iteration ${input.iteration})`);
	const inject = promptInjectFor(input.sub_state);
	if (inject !== void 0 && inject.length > 0) lines.push(`Next action: ${inject}`);
	if (input.open_findings.length > 0) {
		const rendered = input.open_findings.map((f) => {
			const label = `${f.id} [${f.category}/${f.action}]`;
			return f.summary ? `${label} ${f.summary}` : label;
		}).join("; ");
		lines.push(`Open findings (${input.open_findings.length}): ${rendered}`);
	}
	const head = input.pending[0];
	if (head !== void 0) lines.push(`Pending: ${head.pending_id} [${head.kind}] ${head.question}`);
	return lines.join("\n");
}
function sessionStartHookOutput(additionalContext) {
	return { hookSpecificOutput: {
		hookEventName: "SessionStart",
		additionalContext
	} };
}
/**
* Read-only closure consistency warnings (codex GO Q-B lock, MVP set).
* NEVER throws; the caller always exits 0 (warnings must not block the
* Claude Code Stop event).
*
* MVP checks:
*   1. orphan evidence — `covers[]` task-id (T-NNN) targets absent from
*      tasks.json (cheap, read-only). REQ/SCEN/VIS-target orphans are
*      DEFERRED — they require the spec.md projection, which is not in the
*      loadProjections kind set.
*   2. open findings summary — count + ids (the narrow "findings reasonable"
*      signal).
*
* Projection freshness/schema consistency (Q-B check 1) is enforced upstream
* by the loadProjections fast-check path in the caller (SnapshotStaleError),
* not duplicated here.
*/
function runClosureWarnings(input) {
	const warnings = [];
	const knownTaskIds = new Set((input.tasks?.tasks ?? []).map((t) => t.id));
	const orphanPairs = [];
	for (const ev of input.evidence.evidence) for (const ref of ev.covers) if (ref.startsWith("T-") && !knownTaskIds.has(ref)) orphanPairs.push(`${ev.id}→${ref}`);
	if (orphanPairs.length > 0) warnings.push(`orphan evidence: ${orphanPairs.length} covers[] task target(s) absent from tasks.json: ${orphanPairs.join(", ")}`);
	const open = input.findings.findings.filter((f) => f.status === "open");
	if (open.length > 0) warnings.push(`open findings (${open.length}): ${open.map((f) => f.id).join(", ")}`);
	return warnings;
}
z.enum([
	"source",
	"tests",
	"docs",
	"ui",
	"public_api",
	"schema",
	"security"
]);
const STEP_WRITE_PATHS_BY_KIND = {
	behavioral: {
		red: [
			"**/test/**",
			"tests/**",
			"src/**/__tests__/**"
		],
		implement: ["src/**", "lib/**"],
		refactor: [
			"src/**",
			"lib/**",
			"**/test/**"
		]
	},
	structural: {
		implement: ["src/**", "lib/**"],
		refactor: ["src/**", "lib/**"]
	},
	"visual-ui": {
		mockup: ["docs/mockups/**", ".loaf/<feature>/attachments/**"],
		implement: [
			"src/**",
			"res/**",
			"**/ui/**"
		],
		"screenshot-compare": [".loaf/<feature>/attachments/**"]
	},
	docs: {
		draft: [
			"docs/**",
			"**/*.md",
			"README*"
		],
		review: []
	},
	spike: {
		explore: [],
		prototype: ["**/*"],
		record: [".loaf/<feature>/evidence.jsonl"]
	},
	chore: { execute: ["**/*"] }
};
const VERIFY_CHECK_WRITE_PATHS = {
	run: [],
	review: [],
	acceptance: [],
	visual: [".loaf/<feature>/attachments/**"]
};
const STEP_WRITE_CATEGORIES_BY_KIND = {
	behavioral: {
		red: ["tests"],
		implement: ["source"],
		refactor: ["source", "tests"]
	},
	structural: {
		implement: ["source"],
		refactor: ["source"]
	},
	"visual-ui": {
		mockup: ["docs"],
		implement: ["source", "ui"],
		"screenshot-compare": []
	},
	docs: {
		draft: ["docs"],
		review: []
	},
	spike: {
		explore: [],
		prototype: [],
		record: []
	},
	chore: { execute: [] }
};
const VERIFY_CHECK_WRITE_CATEGORIES = {
	run: [],
	review: [],
	acceptance: [],
	visual: []
};
/**
* Built-in write globs for a (kind, step) pair. Returns `[]` for an unknown
* kind/step combination (caller treats absence as "no built-in grant").
*/
function stepWritePaths(kind, step) {
	return STEP_WRITE_PATHS_BY_KIND[kind]?.[step] ?? [];
}
/**
* Config-widenable semantic categories for a (kind, step) pair. Returns `[]`
* for an unknown combination or a step that writes only loaf-internal
* artifacts.
*/
function stepWriteCategories(kind, step) {
	return STEP_WRITE_CATEGORIES_BY_KIND[kind]?.[step] ?? [];
}
//#endregion
//#region src/core/write-guard.ts
const MATCH_OPTS = { dot: true };
function substituteFeature(glob, feature) {
	return glob.replace(/<feature>/g, feature);
}
/** Normalize a target path to a repo-root-relative POSIX path. */
function normalizeToRepoRoot(targetPath, repoRoot) {
	const abs = path.isAbsolute(targetPath) ? targetPath : path.resolve(repoRoot, targetPath);
	return path.relative(repoRoot, abs).split(path.sep).join("/");
}
function anyMatch(normalized, globs) {
	if (globs.length === 0) return false;
	return picomatch(globs, MATCH_OPTS)(normalized);
}
function firstMatch(normalized, globs) {
	for (const g of globs) if (picomatch(g, MATCH_OPTS)(normalized)) return g;
	return null;
}
/**
* Decide whether `targetPath` may be written in the current sub_state +
* active task/step context.
*
* Order (codex Q1/Q7 lock):
*   1. normalize to repo-root-relative POSIX path
*   2. protected_files HARD-DENY (config) — wins over any allow
*   3. allow-set = built-in globs (<feature>-substituted) ∪ config.paths[cat]
*      for cat ∈ activeCategories only (category-aware widening, NOT a flat
*      union — `paths.tests` cannot authorize a source write in implement)
*   4. match → allowed; else WRITE_PATH_VIOLATION
*/
function evaluateWritePath(input) {
	const normalized = normalizeToRepoRoot(input.targetPath, input.repoRoot);
	if (input.config) {
		const matchedDeny = firstMatch(normalized, input.config.protected_files.map((g) => substituteFeature(g, input.feature)));
		if (matchedDeny !== null) return {
			allowed: false,
			code: "PROTECTED_FILE_WRITE",
			normalizedPath: normalized,
			matchedDeny
		};
	}
	const allowSet = input.builtinGlobs.map((g) => substituteFeature(g, input.feature));
	if (input.config) for (const cat of input.activeCategories) for (const g of input.config.paths[cat]) allowSet.push(substituteFeature(g, input.feature));
	if (anyMatch(normalized, allowSet)) return {
		allowed: true,
		normalizedPath: normalized
	};
	return {
		allowed: false,
		code: "WRITE_PATH_VIOLATION",
		normalizedPath: normalized,
		allowSet
	};
}
const HookToolInputEnvelope = z.object({ tool_input: z.object({ file_path: z.string().min(1) }) });
/** Parse `tool_input.file_path` from a Claude Code hook stdin JSON payload. */
function parseHookStdinPath(raw) {
	let parsed;
	try {
		parsed = JSON.parse(raw);
	} catch {
		return {
			ok: false,
			reason: "hook stdin is not valid JSON"
		};
	}
	const result = HookToolInputEnvelope.safeParse(parsed);
	if (!result.success) return {
		ok: false,
		reason: "hook stdin JSON missing non-empty tool_input.file_path"
	};
	return {
		ok: true,
		path: result.data.tool_input.file_path
	};
}
//#endregion
//#region src/core/loaf-config.ts
const WriteGuardConfigPaths = z.object({
	source: z.array(z.string()).default(["src/**"]),
	tests: z.array(z.string()).default(["**/test/**", "tests/**"]),
	docs: z.array(z.string()).default(["docs/**", "**/*.md"]),
	ui: z.array(z.string()).default([]),
	public_api: z.array(z.string()).default([]),
	schema: z.array(z.string()).default([]),
	security: z.array(z.string()).default([])
});
const WriteGuardConfig = z.object({
	schema_version: z.literal(2),
	protected_files: z.array(z.string()).default([]),
	stable_core: z.array(z.string()).default([]),
	paths: WriteGuardConfigPaths.prefault({})
});
/** Canonical project-level config path under a repo root. */
function loafConfigPath(repoRoot) {
	return path.join(repoRoot, ".loaf", ".config", "loaf.config.json");
}
/**
* Read + validate the write-guard slice of loaf.config.json.
*
* - file absent (ENOENT)           → { status: "absent" }   (no overlay)
* - unreadable / malformed / bad   → { status: "invalid" }  (fail closed)
* - valid                          → { status: "ok", config }
*
* The caller (write-guard) treats "invalid" as a hard exit-2: an untrusted
* config must never silently relax the write boundary.
*/
async function readLoafConfig(repoRoot) {
	const configPath = loafConfigPath(repoRoot);
	let raw;
	try {
		raw = await promises.readFile(configPath, "utf8");
	} catch (err) {
		if (err.code === "ENOENT") return { status: "absent" };
		return {
			status: "invalid",
			reason: `cannot read ${configPath}: ${err.message}`
		};
	}
	let parsed;
	try {
		parsed = JSON.parse(raw);
	} catch {
		return {
			status: "invalid",
			reason: `malformed JSON in ${configPath}`
		};
	}
	const result = WriteGuardConfig.safeParse(parsed);
	if (!result.success) return {
		status: "invalid",
		reason: `schema validation failed for ${configPath}`
	};
	return {
		status: "ok",
		config: result.data
	};
}
//#endregion
//#region src/core/user-config.ts
const UserConfig = z.object({
	schema_version: z.literal(1),
	locale: z.object({ default_lang: z.enum(["en", "zh"]) }).strict()
}).strict();
/** Canonical user-level config path under an injected home directory. */
function userConfigPath(homeDir) {
	return path.join(homeDir, ".loaf", "config.json");
}
/**
* Read + strictly validate ~/.loaf/config.json.
*
* - file absent (ENOENT)         -> { status: "absent" }
* - unreadable / malformed / bad -> { status: "invalid" }
* - valid                        -> { status: "ok", config }
*/
async function readUserConfig(homeDir) {
	const configPath = userConfigPath(homeDir);
	let raw;
	try {
		raw = await promises.readFile(configPath, "utf8");
	} catch (err) {
		if (err.code === "ENOENT") return { status: "absent" };
		return {
			status: "invalid",
			path: configPath,
			reason: `cannot read ${configPath}: ${err.message}`
		};
	}
	let parsed;
	try {
		parsed = JSON.parse(raw);
	} catch {
		return {
			status: "invalid",
			path: configPath,
			reason: `malformed JSON in ${configPath}`
		};
	}
	const result = UserConfig.safeParse(parsed);
	if (!result.success) return {
		status: "invalid",
		path: configPath,
		reason: `schema validation failed for ${configPath}`
	};
	return {
		status: "ok",
		config: result.data
	};
}
//#endregion
//#region src/cli/run-editor.ts
var EditorTokenizeError = class extends Error {
	editor;
	code = "EDITOR_TOKENIZE_ERROR";
	constructor(message, editor) {
		super(message);
		this.editor = editor;
		this.name = "EditorTokenizeError";
	}
};
/** Shell-style word split with single + double quote grouping. NOT a
*  full shell parser — does NOT expand $VARS, ~, globs, or backticks.
*  Filepath is appended by the caller (NOT injected via shell). Codex
*  r336 P2 lock. */
function tokenizeEditor(editor) {
	const tokens = [];
	let current = "";
	let quoteChar = null;
	let inToken = false;
	for (let i = 0; i < editor.length; i++) {
		const ch = editor[i];
		if (quoteChar !== null) {
			if (ch === quoteChar) quoteChar = null;
			else current += ch;
			continue;
		}
		if (ch === "\"" || ch === "'") {
			quoteChar = ch;
			inToken = true;
			continue;
		}
		if (ch === " " || ch === "	") {
			if (inToken) {
				tokens.push(current);
				current = "";
				inToken = false;
			}
			continue;
		}
		current += ch;
		inToken = true;
	}
	if (quoteChar !== null) throw new EditorTokenizeError(`EDITOR has unmatched ${quoteChar === "\"" ? "double" : "single"} quote: ${editor}`, editor);
	if (inToken) tokens.push(current);
	return tokens;
}
/** Production runEditor — spawn the user's editor and resolve with the
*  outcome. Always resolves; never throws — tokenize errors become
*  `error: "EDITOR_TOKENIZE_ERROR"` (codex r339 P1), spawn errors
*  become typed error strings (ENOENT etc.). */
async function runEditor(args) {
	let tokens;
	try {
		tokens = tokenizeEditor(args.editor);
	} catch (err) {
		if (err instanceof EditorTokenizeError) return {
			code: 127,
			signal: null,
			error: "EDITOR_TOKENIZE_ERROR"
		};
		throw err;
	}
	if (tokens.length === 0) return {
		code: 127,
		signal: null,
		error: "EDITOR_EMPTY"
	};
	const [bin, ...rest] = tokens;
	return new Promise((resolve) => {
		let settled = false;
		const finish = (result) => {
			if (settled) return;
			settled = true;
			resolve(result);
		};
		const child = spawn(bin, [...rest, args.filePath], {
			stdio: "inherit",
			cwd: args.cwd,
			env: args.env
		});
		child.once("error", (err) => {
			finish({
				code: 127,
				signal: null,
				error: err.code ?? err.message
			});
		});
		child.once("close", (code, signal) => {
			finish({
				code: code ?? 0,
				signal: signal ?? null
			});
		});
	});
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
	if (!ActorString$1.safeParse(candidate).success) return {
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
//#region src/core/kind-guards.ts
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
const ALL_NON_MIGRATION = [
	"human",
	"skill",
	"ci",
	"cli"
];
const HUMAN_ONLY = ["human"];
const CLI_ONLY = ["cli"];
const MIGRATION_ONLY = ["migration"];
function actorPrefix(actor) {
	const m = /^(human|skill|ci|cli|migration):/.exec(actor);
	return m ? m[1] : null;
}
//#endregion
//#region src/core/kind-registry.ts
const KIND_REGISTRY = {
	"event:phase_advanced": {
		payload: PhaseAdvancedPayload,
		reducerImplemented: true,
		subStates: ANY_SUB_STATE,
		actors: ALL_NON_MIGRATION,
		emitsSpec: false
	},
	"event:ceremony_set": {
		payload: CeremonyPayload,
		reducerImplemented: true,
		subStates: new Set([
			"TRIAGE.score",
			"TRIAGE.confirm",
			...ALL_SPEC,
			...ALL_EXECUTE
		]),
		actors: ALL_NON_MIGRATION,
		emitsSpec: false
	},
	"event:tasks_planned": {
		payload: TasksPlannedPayload,
		reducerImplemented: true,
		subStates: new Set(["SPEC.design", "EXECUTE.plan"]),
		actors: ALL_NON_MIGRATION,
		emitsSpec: false
	},
	"event:tasks_amended": {
		payload: TasksAmendedPayload,
		reducerImplemented: true,
		subStates: new Set(VERIFY_OR_POST_LOCK_EXECUTE),
		actors: ALL_NON_MIGRATION,
		emitsSpec: false
	},
	"event:task_claimed": {
		payload: TaskRefPayload,
		reducerImplemented: true,
		subStates: new Set(["EXECUTE.work"]),
		actors: ALL_NON_MIGRATION,
		emitsSpec: false
	},
	"event:task_step_started": {
		payload: TaskStepRefPayload,
		reducerImplemented: true,
		subStates: new Set(["EXECUTE.work"]),
		actors: ALL_NON_MIGRATION,
		emitsSpec: false
	},
	"event:task_step_done": {
		payload: TaskStepDonePayload,
		reducerImplemented: true,
		subStates: new Set(["EXECUTE.work"]),
		actors: ALL_NON_MIGRATION,
		emitsSpec: false
	},
	"event:task_step_reset": {
		payload: TaskStepResetPayload,
		reducerImplemented: true,
		subStates: new Set(FIX_BACK_EDGE_FROM),
		actors: CLI_ONLY,
		emitsSpec: false
	},
	"event:task_abandoned": {
		payload: TaskAbandonedPayload,
		reducerImplemented: true,
		subStates: new Set(["EXECUTE.work"]),
		actors: ALL_NON_MIGRATION,
		emitsSpec: false
	},
	"event:spec_req_added": {
		payload: SpecReqAddedPayload,
		reducerImplemented: true,
		subStates: new Set(ALL_SPEC),
		actors: ALL_NON_MIGRATION,
		emitsSpec: true
	},
	"event:spec_scenario_added": {
		payload: SpecScenarioAddedPayload,
		reducerImplemented: true,
		subStates: new Set(ALL_SPEC),
		actors: ALL_NON_MIGRATION,
		emitsSpec: true
	},
	"event:spec_visual_added": {
		payload: SpecVisualAddedPayload,
		reducerImplemented: true,
		subStates: new Set(ALL_SPEC),
		actors: ALL_NON_MIGRATION,
		emitsSpec: true
	},
	"event:spec_submitted": {
		payload: SpecSubmittedPayload,
		reducerImplemented: true,
		subStates: new Set(ALL_SPEC),
		actors: ALL_NON_MIGRATION,
		emitsSpec: true
	},
	"evidence:added": {
		payload: EvidenceAddedPayload,
		reducerImplemented: true,
		subStates: new Set([...ALL_EXECUTE, ...VERIFY_OR_POST_LOCK_EXECUTE.filter((s) => s.startsWith("VERIFY"))]),
		actors: ALL_NON_MIGRATION,
		emitsSpec: false
	},
	"finding:raised": {
		payload: FindingRaisedPayload,
		reducerImplemented: true,
		subStates: new Set(VERIFY_OR_POST_LOCK_EXECUTE),
		actors: ALL_NON_MIGRATION,
		emitsSpec: false
	},
	"finding:closed": {
		payload: FindingClosedPayload,
		reducerImplemented: true,
		subStates: new Set(VERIFY_OR_POST_LOCK_EXECUTE),
		actors: ALL_NON_MIGRATION,
		emitsSpec: false
	},
	"pending:added": {
		payload: PendingAddedPayload,
		reducerImplemented: true,
		subStates: ANY_SUB_STATE,
		actors: ALL_NON_MIGRATION,
		emitsSpec: false
	},
	"pending:resolved": {
		payload: PendingResolvedPayload,
		reducerImplemented: true,
		subStates: ANY_SUB_STATE,
		actors: ALL_NON_MIGRATION,
		emitsSpec: false
	},
	"gate:decided": {
		payload: GateDecidedPayload,
		reducerImplemented: true,
		subStates: new Set(["SPEC.design", "VERIFY.accept"]),
		actors: HUMAN_ONLY,
		emitsSpec: false
	},
	"session:started": {
		payload: SessionStartedPayload,
		reducerImplemented: true,
		subStates: ANY_SUB_STATE,
		actors: ALL_NON_MIGRATION,
		emitsSpec: false
	},
	"session:resumed": {
		payload: SessionResumedPayload,
		reducerImplemented: true,
		subStates: ANY_SUB_STATE,
		actors: ALL_NON_MIGRATION,
		emitsSpec: false
	},
	"session:delivered": {
		payload: SessionReasonPayload,
		reducerImplemented: true,
		subStates: new Set([
			"EXECUTE.done",
			"VERIFY.accept",
			"SETTLE.lessons"
		]),
		actors: HUMAN_ONLY,
		emitsSpec: false
	},
	"session:archived": {
		payload: SessionReasonPayload,
		reducerImplemented: true,
		subStates: ANY_NON_DONE,
		actors: HUMAN_ONLY,
		emitsSpec: false
	},
	"session:abandoned": {
		payload: SessionReasonPayload,
		reducerImplemented: true,
		subStates: ANY_NON_DONE,
		actors: HUMAN_ONLY,
		emitsSpec: false
	},
	"spike:converted": {
		payload: SpikeConvertedPayload,
		reducerImplemented: true,
		subStates: ANY_NON_DONE,
		actors: HUMAN_ONLY,
		emitsSpec: false
	},
	"migration:snapshot_imported": {
		payload: MigrationSnapshotImportedPayload,
		reducerImplemented: true,
		subStates: ANY_SUB_STATE,
		actors: MIGRATION_ONLY,
		emitsSpec: false
	}
};
const ALL_KINDS = Object.keys(KIND_REGISTRY);
const PER_KIND_PAYLOAD = Object.fromEntries(ALL_KINDS.map((k) => [k, KIND_REGISTRY[k].payload]));
const REDUCER_IMPLEMENTED_KINDS = new Set(ALL_KINDS.filter((k) => KIND_REGISTRY[k].reducerImplemented));
Object.fromEntries(ALL_KINDS.map((k) => [k, KIND_REGISTRY[k].subStates]));
Object.fromEntries(ALL_KINDS.map((k) => [k, KIND_REGISTRY[k].actors]));
const SPEC_EMITTING_KINDS = new Set(ALL_KINDS.filter((k) => KIND_REGISTRY[k].emitsSpec));
function isSubStateAllowed(kind, subState) {
	const guard = KIND_REGISTRY[kind].subStates;
	if (guard === ANY_SUB_STATE) return true;
	if (guard === ANY_NON_DONE) return !subState.startsWith("DONE.");
	return guard.has(subState);
}
function isActorAllowed(kind, actor) {
	const prefix = actorPrefix(actor);
	if (prefix === null) return false;
	return KIND_REGISTRY[kind].actors.includes(prefix);
}
//#endregion
//#region src/core/reducer/invariants.ts
/**
* spec_version monotonicity, parametrised by batch position.
*
* - "head": the first entry of a batch must bump to `currentVersion + 1`.
* - "continuation": a non-head entry must repeat `currentVersion` (the head
*   already bumped state).
*
* On success returns the accepted `nextVersion` so the reducer can set
* `state.spec_version` without recomputing the rule; on failure returns the
* `expected` version so each layer formats its own message/detail.
*
* NOTE: the structural guard for `spec_submitted` at batch_index > 0 is NOT this
* predicate's concern (it has no kind/batch_index) and must be checked by the
* caller before delegating here.
*/
function checkSpecVersion$1(payloadVersion, currentVersion, mode) {
	const expected = mode === "head" ? currentVersion + 1 : currentVersion;
	return payloadVersion === expected ? {
		ok: true,
		nextVersion: expected
	} : {
		ok: false,
		expected
	};
}
/**
* Self-scan: the first id that appears more than once within `ids`, else null.
* For `tasks_planned`, where the duplicate question is internal to the incoming
* task list. Returns the first id encountered a second time (scan order) so the
* offender is deterministic.
*/
function findDuplicateId(ids) {
	const seen = /* @__PURE__ */ new Set();
	for (const id of ids) {
		if (seen.has(id)) return { id };
		seen.add(id);
	}
	return null;
}
/**
* Membership: does `incomingId` already exist among `existing`, else null. For
* REQ/SCEN/VIS add-one, where the question is collision against the projection
* — NOT whether the projection is internally corrupt. A pre-existing duplicate
* in `existing` unrelated to `incomingId` must not change the answer.
*
* Takes the source items + an id selector and short-circuits on the first match,
* so callers pass the projection array directly — no throwaway `.map(...)` id
* array per check on the per-mutation path.
*/
function findCollision(incomingId, existing, selectId) {
	for (const item of existing) if (selectId(item) === incomingId) return { id: incomingId };
	return null;
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
	const parsed = JournalEntry$1.safeParse(rawEntry);
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
		if (sub_state === "EXECUTE.done") {
			if (ceremony.verify_phase) return {
				ok: false,
				code: "DELIVER_NOT_ACCEPTED",
				message: "cannot deliver from EXECUTE.done: verify_phase=true (standard/deep) must complete VERIFY and deliver from VERIFY.accept; EXECUTE.done deliver is the quick/light verify-min path",
				detail: {
					sub_state,
					ceremony_label: deriveCeremonyLabel(ceremony),
					verify_phase: true
				}
			};
			const proofGaps = evaluateTaskProof(ctx.snapshot, verifyMinPolicy);
			const redGap = proofGaps.find((f) => f.gaps.includes("bug-red-unregistered"));
			if (redGap) return {
				ok: false,
				code: "BUG_TASK_RED_NOT_REGISTERED",
				message: `behavioral bug task ${redGap.task.id} is status=done but never registered its RED test (red_test_registered≠true); cannot verify-min deliver`,
				detail: { task_id: redGap.task.id }
			};
			const missing = proofGaps.filter((f) => f.gaps.includes("no-passing-evidence")).map((f) => ({
				task_id: f.task.id,
				kind: f.task.kind,
				required_kinds: verifyMinPolicy.acceptedKinds(f.task)
			}));
			if (missing.length > 0) return {
				ok: false,
				code: "DELIVER_VERIFY_MIN_INCOMPLETE",
				message: `verify-min: ${missing.length} done task(s) lack the required evidence to deliver (${missing.map((m) => `${m.task_id} needs ${m.required_kinds.join("/")}`).join("; ")}). Add evidence (e.g. \`loaf evidence add\`) or waive, then re-deliver`,
				detail: {
					sub_state,
					ceremony_label: deriveCeremonyLabel(ceremony),
					count: missing.length,
					tasks: missing
				}
			};
		}
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
		if (findCollision(payload.req.id, ctx.snapshot.requirements, (r) => r.id)) return {
			ok: false,
			code: "DUPLICATE_REQ_ID",
			message: `spec_req_added: REQ ${payload.req.id} already in projection`,
			detail: { id: payload.req.id }
		};
	}
	if (entry.kind === "event:spec_scenario_added") {
		const payload = payloadParsed.data;
		if (findCollision(payload.scenario.id, ctx.snapshot.scenarios, (s) => s.id)) return {
			ok: false,
			code: "DUPLICATE_SCEN_ID",
			message: `spec_scenario_added: SCEN ${payload.scenario.id} already in projection`,
			detail: { id: payload.scenario.id }
		};
	}
	if (entry.kind === "event:spec_visual_added") {
		const payload = payloadParsed.data;
		if (findCollision(payload.visual.id, ctx.snapshot.visual_contracts, (v) => v.id)) return {
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
			const v = checkSpecVersion$1(payloadVersion, currentVersion, "head");
			if (!v.ok) return {
				ok: false,
				code: "SPEC_VERSION_NOT_MONOTONIC",
				message: `spec_submitted: spec_version must be ${v.expected} (current+1), got ${payloadVersion}`,
				detail: {
					kind: entry.kind,
					payload_spec_version: payloadVersion,
					current_spec_version: currentVersion,
					expected_spec_version: v.expected
				}
			};
		} else {
			const mode = entry.batch_index === void 0 || entry.batch_index === 0 ? "head" : "continuation";
			const v = checkSpecVersion$1(payloadVersion, currentVersion, mode);
			if (!v.ok) {
				if (mode === "head") return {
					ok: false,
					code: "SPEC_VERSION_NOT_MONOTONIC",
					message: `${entry.kind}: spec_version must be ${v.expected} (current+1) at batch head, got ${payloadVersion}`,
					detail: {
						kind: entry.kind,
						payload_spec_version: payloadVersion,
						current_spec_version: currentVersion,
						expected_spec_version: v.expected,
						batch_position: "head"
					}
				};
				return {
					ok: false,
					code: "SPEC_VERSION_BATCH_MISMATCH",
					message: `${entry.kind}: spec_version must be ${v.expected} at batch_index=${entry.batch_index} (batch continuation), got ${payloadVersion}`,
					detail: {
						kind: entry.kind,
						payload_spec_version: payloadVersion,
						current_spec_version: currentVersion,
						batch_index: entry.batch_index,
						batch_position: "continuation"
					}
				};
			}
		}
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
			const dup = findDuplicateId(incoming.map((t) => t.id));
			if (dup) return invalidPayload(entry.kind, `DUPLICATE_TASK_ID: ${dup.id} appears more than once in tasks_planned payload`);
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
			if (findCollision(payload.req.id, prev.requirements, (r) => r.id)) return invalidPayload(entry.kind, `DUPLICATE_REQ_ID: ${payload.req.id} already in projection`);
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
			if (findCollision(payload.scenario.id, prev.scenarios, (s) => s.id)) return invalidPayload(entry.kind, `DUPLICATE_SCEN_ID: ${payload.scenario.id} already in projection`);
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
			if (findCollision(payload.visual.id, prev.visual_contracts, (v) => v.id)) return invalidPayload(entry.kind, `DUPLICATE_VIS_ID: ${payload.visual.id} already in projection`);
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
		case "session:resumed": return {
			ok: true,
			snapshot: prev
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
	const r = checkSpecVersion$1(payloadVersion, currentVersion, "head");
	return r.ok ? {
		ok: true,
		nextVersion: r.nextVersion
	} : {
		ok: false,
		message: `SPEC_VERSION_NOT_MONOTONIC: spec_version must be ${r.expected} (current+1), got ${payloadVersion}`
	};
}
function checkSpecVersion(entry, payloadVersion, currentVersion) {
	const mode = entry.batch_index === void 0 || entry.batch_index === 0 ? "head" : "continuation";
	const r = checkSpecVersion$1(payloadVersion, currentVersion, mode);
	if (r.ok) return {
		ok: true,
		nextVersion: r.nextVersion
	};
	return {
		ok: false,
		message: mode === "head" ? `SPEC_VERSION_NOT_MONOTONIC: spec_version must be ${r.expected} (current+1) at batch head, got ${payloadVersion}` : `SPEC_VERSION_BATCH_MISMATCH: spec_version must be ${r.expected} at batch_index=${entry.batch_index}, got ${payloadVersion}`
	};
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
		const parsed = JournalEntry$1.safeParse(entry);
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
	result: EvidenceResult$1.optional(),
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
			const parsed = JournalEntry$1.safeParse(JSON.parse(line));
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
async function loadSession(featureDir, opts = {}) {
	if (opts.ensureDir ?? true) await promises.mkdir(featureDir, { recursive: true });
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
const evaluateSpecLockGate = gateEvalFromCheck(specLockCheck);
async function evaluateSpecLock(snapshot, featureDir) {
	return evaluateSpecLockGate(snapshot, featureDir);
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
		const parsed = LongTextField$1.safeParse(value);
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
	SpecFrontmatter$1.parse(fm);
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
		existingBody = splitFrontmatter(await fsp.readFile(specPath, "utf8")).body;
	} catch (err) {
		if (err.code !== "ENOENT") throw err;
	}
	const content = composeSpecMdFrontmatter(snapshot, existingBody);
	const tmp = `${specPath}.tmp-${randomBytes(6).toString("hex")}`;
	await fsp.writeFile(tmp, content, { mode: 420 });
	let fh = await fsp.open(tmp, "r+");
	try {
		await fh.sync();
	} finally {
		await fh.close();
	}
	await fsp.rename(tmp, specPath);
	try {
		fh = await fsp.open(path$1.dirname(specPath), "r");
		try {
			await fh.sync();
		} finally {
			await fh.close();
		}
	} catch {}
}
//#endregion
//#region src/core/journal-mutate.ts
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
	if (ctx.dryRun) return {
		ok: true,
		snapshot: snapshotAcc,
		entries: candidates,
		meta: ctx.meta
	};
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
	if (finalSnapshot.state?.session_id) {
		let registryFile;
		try {
			registryFile = buildRegistryFile({
				snapshot: finalSnapshot,
				entries: ctx.entries.concat(promoted),
				now: ctx.registryWriter?.now?.() ?? /* @__PURE__ */ new Date(),
				cwd: ctx.registryWriter?.cwd?.() ?? process.cwd()
			});
		} catch (err) {
			return {
				ok: false,
				code: "PROJECTION_WRITE_FAILED",
				message: `registry derivation failed after journal append; journal is authoritative — run 'loaf doctor --rebuild-registry' (future). Cause: ${err.message}`,
				detail: {
					projection: "registry",
					phase: "derivation",
					journal_appended: true,
					error: err.message
				}
			};
		}
		if (registryFile) try {
			await writeRegistryFile(registryFile.session_id, registryFile, { ...ctx.registryWriter?.registryDir !== void 0 && { registryDir: ctx.registryWriter.registryDir } });
		} catch {}
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
//#region src/cli.tsx
function normalizedCovers(covers) {
	if (!covers || covers.length === 0) return "";
	return [...new Set(covers)].sort().join(",");
}
function formatCovers(i18n, covers) {
	if (!covers || covers.length === 0) return i18n.t(SUCCESS_KEYS.evidenceCoversNone);
	return [...new Set(covers)].sort().join(",");
}
function formatTaskListKind(i18n, kind) {
	if (i18n.locale === "en") return kind;
	return i18n.t(taskKindKey(kind));
}
function formatTaskStatus(i18n, status) {
	return i18n.t(taskStatusKey(status));
}
function evidenceAddStateChange(i18n, items) {
	if (items.length === 1) {
		const it = items[0];
		return i18n.t(SUCCESS_KEYS.evidenceAddStateChangeSingle, {
			evidence_id: it.id,
			kind: it.kind,
			covers: formatCovers(i18n, it.covers)
		});
	}
	const kinds = new Set(items.map((it) => it.kind));
	const coversNorm = new Set(items.map((it) => normalizedCovers(it.covers)));
	const idsList = items.map((it) => it.id).join(",");
	if (kinds.size === 1 && coversNorm.size === 1) {
		const kind = [...kinds][0];
		const coversForRender = formatCovers(i18n, items[0].covers);
		return i18n.t(SUCCESS_KEYS.evidenceAddStateChangeBatchHomogeneous, {
			count: items.length,
			evidence_ids: idsList,
			kind,
			covers: coversForRender
		});
	}
	return i18n.t(SUCCESS_KEYS.evidenceAddStateChangeBatchMixed, {
		count: items.length,
		evidence_ids: idsList
	});
}
function formatPendingKind(i18n, kind) {
	if (i18n.locale === "en") return kind;
	const parsed = PendingPromptKind$1.safeParse(kind);
	return parsed.success ? i18n.t(pendingKindKey(parsed.data)) : kind;
}
function formatFindingCategory(i18n, category) {
	if (i18n.locale === "en") return category;
	const parsed = FindingCategory$1.safeParse(category);
	return parsed.success ? i18n.t(findingCategoryKey(parsed.data)) : category;
}
function formatFindingAction(i18n, action) {
	if (i18n.locale === "en") return action;
	const parsed = FindingAction$1.safeParse(action);
	return parsed.success ? i18n.t(findingActionKey(parsed.data)) : action;
}
function formatFindingStatus(i18n, status) {
	return i18n.t(findingStatusKey(status));
}
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
function preparseI18nFromEnv(env) {
	const explicit = env["LOAF_LANG"];
	if (explicit === "zh" || explicit === "en") return createI18n(explicit, BUILTIN_BUNDLES);
	if (((env["LC_ALL"] ?? env["LC_MESSAGES"] ?? env["LANG"])?.toLowerCase())?.startsWith("zh")) return createI18n("zh", BUILTIN_BUNDLES);
	return createI18n("en", BUILTIN_BUNDLES);
}
function writePreContextKeyedFailure(input) {
	const keyPath = diagnosticKey(input.code);
	const message = input.renderAsJson ? createI18n("en", BUILTIN_BUNDLES).t(keyPath, input.vars) : preparseI18nFromEnv(process.env).t(keyPath, input.vars);
	if (input.renderAsJson) {
		const out = {
			ok: false,
			code: input.code,
			message
		};
		if (input.detail !== void 0) out["detail"] = input.detail;
		process.stderr.write(JSON.stringify(out) + "\n");
	} else process.stderr.write(`error: ${input.code} — ${message}\n`);
}
function writePreContextSiteFailure(input) {
	const message = input.renderAsJson ? createI18n("en", BUILTIN_BUNDLES).t(input.keyPath, input.vars) : preparseI18nFromEnv(process.env).t(input.keyPath, input.vars);
	if (input.renderAsJson) {
		const out = {
			ok: false,
			code: input.code,
			message
		};
		if (input.detail !== void 0) out["detail"] = input.detail;
		process.stderr.write(JSON.stringify(out) + "\n");
	} else process.stderr.write(`error: ${input.code} — ${message}\n`);
}
function diagnosticVarsFor(code, detail) {
	switch (code) {
		case "INVALID_FORMAT": return varsIfDefined({
			value: stringVar(detail?.["value"]),
			allowed_values_human: stringVar(detail?.["allowed_values_human"]) ?? FORMAT_MODES_HUMAN
		});
		case "MUTUALLY_EXCLUSIVE_FLAGS": return varsIfDefined({ flags: listVar(detail?.["conflicting"]) });
		case "DRY_RUN_NOT_APPLICABLE": return varsIfDefined({
			command_type: stringVar(detail?.["command_type"]),
			command: stringVar(detail?.["command"])
		});
		case "FEATURE_NOT_FOUND": return {};
		case "FEATURE_AMBIGUOUS": return varsIfDefined({
			count: numberVar(detail?.["count"]),
			feature_list: listVar(detail?.["feature_list"])
		});
		case "SESSION_CWD_MISMATCH": return varsIfDefined({
			uuid: stringVar(detail?.["uuid"]),
			registered_cwd: stringVar(detail?.["registered_cwd"]),
			current_cwd: stringVar(detail?.["current_cwd"])
		});
		case "SESSION_SHORT_AMBIGUOUS": return varsIfDefined({
			prefix: stringVar(detail?.["prefix"]),
			match_count: numberVar(detail?.["match_count"]),
			candidate_list: listVar(detail?.["candidate_list"])
		});
		case "SESSION_NOT_FOUND": return varsIfDefined({ uuid_or_prefix: stringVar(detail?.["uuid_or_prefix"]) });
		default: return null;
	}
}
function varsIfDefined(vars) {
	for (const value of Object.values(vars)) if (value === null) return null;
	return vars;
}
function stringVar(value) {
	if (typeof value === "string") return value;
	if (typeof value === "number" || typeof value === "boolean") return String(value);
	return null;
}
function numberVar(value) {
	return typeof value === "number" ? value : null;
}
function listVar(value) {
	if (Array.isArray(value)) return value.map((item) => String(item)).join(", ");
	return stringVar(value);
}
async function main(argv = process.argv, deps = {}) {
	const wantsHelpOrVersion = argv.some((a) => a === "--help" || a === "-h" || a === "--version" || a === "-V");
	if (!wantsHelpOrVersion) {
		const presentation = parsePresentation(argv);
		if (!presentation.ok) {
			if (presentation.kind === "INVALID_FORMAT") writePreContextKeyedFailure({
				code: "INVALID_FORMAT",
				vars: {
					value: presentation.rawValue,
					allowed_values_human: FORMAT_MODES_HUMAN
				},
				detail: {
					value: presentation.rawValue,
					allowed_values: FORMAT_MODES
				},
				renderAsJson: false
			});
			else {
				const { conflicting, renderAsJson } = presentation;
				writePreContextKeyedFailure({
					code: "MUTUALLY_EXCLUSIVE_FLAGS",
					vars: { flags: conflicting.join(", ") },
					detail: { conflicting },
					renderAsJson
				});
			}
			return 2;
		}
	}
	if (!wantsHelpOrVersion) {
		const SUBCOMMAND_VALUE_FLAGS = new Set([
			"--format",
			"--session",
			"--feature",
			"--feature-dir",
			"--ceremony",
			"--label",
			"--workspace"
		]);
		const collectNonFlagTokens = (startIdx, max) => {
			const out = [];
			for (let i = startIdx; i < argv.length; i++) {
				const a = argv[i];
				if (a.startsWith("--")) {
					const flagName = a.includes("=") ? a.slice(0, a.indexOf("=")) : a;
					if (SUBCOMMAND_VALUE_FLAGS.has(flagName) && !a.includes("=")) i++;
					continue;
				}
				if (a.startsWith("-") && a.length > 1) continue;
				out.push(a);
				if (out.length >= max) break;
			}
			return out;
		};
		const cmdTokens = collectNonFlagTokens(2, 2);
		if (cmdTokens[0] === "sessions" && cmdTokens[1] === "list") {
			const presentSelectors = [];
			if (argv.includes("--session") || argv.some((a) => a.startsWith("--session="))) presentSelectors.push("--session");
			if (argv.includes("--feature") || argv.some((a) => a.startsWith("--feature="))) presentSelectors.push("--feature");
			if (argv.includes("--feature-dir") || argv.some((a) => a.startsWith("--feature-dir="))) presentSelectors.push("--feature-dir");
			if (process.env["LOAF_SESSION"] !== void 0 && process.env["LOAF_SESSION"].length > 0) presentSelectors.push("$LOAF_SESSION");
			if (process.env["LOAF_FEATURE"] !== void 0 && process.env["LOAF_FEATURE"].length > 0) presentSelectors.push("$LOAF_FEATURE");
			if (presentSelectors.length > 0) {
				const renderAsJson = argv.some((a) => a === "--format=json" || a === "--format" && argv[argv.indexOf(a) + 1] === "json");
				writePreContextSiteFailure({
					code: "USAGE",
					keyPath: FAILURE_SITE_KEYS.sessionsListSelectorConflict,
					vars: { conflicting: presentSelectors.join(" / ") },
					detail: { conflicting: presentSelectors },
					renderAsJson
				});
				return 2;
			}
		}
		if (cmdTokens[0] === "tui") {
			const presentSelectors = [];
			if (argv.includes("--session") || argv.some((a) => a.startsWith("--session="))) presentSelectors.push("--session");
			if (argv.includes("--feature") || argv.some((a) => a.startsWith("--feature="))) presentSelectors.push("--feature");
			if (argv.includes("--feature-dir") || argv.some((a) => a.startsWith("--feature-dir="))) presentSelectors.push("--feature-dir");
			if (process.env["LOAF_SESSION"] !== void 0 && process.env["LOAF_SESSION"].length > 0) presentSelectors.push("$LOAF_SESSION");
			if (process.env["LOAF_FEATURE"] !== void 0 && process.env["LOAF_FEATURE"].length > 0) presentSelectors.push("$LOAF_FEATURE");
			const hasFormat = argv.some((a) => a === "--format" || a.startsWith("--format="));
			const renderAsJson = argv.some((a) => a === "--format=json" || a === "--format" && argv[argv.indexOf(a) + 1] === "json");
			if (presentSelectors.length > 0) {
				writePreContextSiteFailure({
					code: "USAGE",
					keyPath: FAILURE_SITE_KEYS.tuiSelectorConflict,
					vars: { conflicting: presentSelectors.join(" / ") },
					detail: { conflicting: presentSelectors },
					renderAsJson
				});
				return 2;
			}
			if (hasFormat) {
				writePreContextSiteFailure({
					code: "USAGE",
					keyPath: FAILURE_SITE_KEYS.tuiInteractiveOnly,
					vars: {},
					detail: { reason: "tui-interactive-only" },
					renderAsJson
				});
				return 2;
			}
		}
		if (cmdTokens[0] === "hook") {
			const renderAsJson = argv.some((a) => a === "--format=json" || a === "--format" && argv[argv.indexOf(a) + 1] === "json");
			if (argv.includes("--list-events")) {
				if (renderAsJson) process.stdout.write(JSON.stringify({
					ok: true,
					count: HOOK_EVENTS.length,
					events: HOOK_EVENTS.map((e) => ({
						event: e,
						claude_code: HOOK_EVENT_TO_CLAUDE_CODE[e]
					}))
				}) + "\n");
				else for (const e of HOOK_EVENTS) process.stdout.write(`${e}\t${HOOK_EVENT_TO_CLAUDE_CODE[e]}\n`);
				return 0;
			}
			if (cmdTokens[1] === void 0) {
				writePreContextSiteFailure({
					code: "USAGE",
					keyPath: FAILURE_SITE_KEYS.hookMissingEvent,
					vars: { events: HOOK_EVENTS.join(", ") },
					detail: { events: HOOK_EVENTS },
					renderAsJson
				});
				return 2;
			}
			if (!HOOK_EVENTS.includes(cmdTokens[1])) {
				const got = cmdTokens[1];
				const suggestion = HOOK_EVENTS.find((e) => e.startsWith(got.slice(0, 4))) ?? HOOK_EVENTS[0];
				writePreContextSiteFailure({
					code: "USAGE",
					keyPath: FAILURE_SITE_KEYS.hookUnknownEvent,
					vars: {
						event: got,
						allowed: HOOK_EVENTS.join(", "),
						suggestion
					},
					detail: {
						event: got,
						allowed: HOOK_EVENTS,
						suggestion
					},
					renderAsJson
				});
				return 2;
			}
		}
		if (cmdTokens[0] === "check") {
			const presentSelectors = [];
			if (argv.includes("--session") || argv.some((a) => a.startsWith("--session="))) presentSelectors.push("--session");
			if (argv.includes("--feature") || argv.some((a) => a.startsWith("--feature="))) presentSelectors.push("--feature");
			if (argv.includes("--feature-dir") || argv.some((a) => a.startsWith("--feature-dir="))) presentSelectors.push("--feature-dir");
			if (process.env["LOAF_SESSION"] !== void 0 && process.env["LOAF_SESSION"].length > 0) presentSelectors.push("$LOAF_SESSION");
			if (process.env["LOAF_FEATURE"] !== void 0 && process.env["LOAF_FEATURE"].length > 0) presentSelectors.push("$LOAF_FEATURE");
			if (presentSelectors.length > 0) {
				const renderAsJson = argv.some((a) => a === "--format=json" || a === "--format" && argv[argv.indexOf(a) + 1] === "json");
				writePreContextSiteFailure({
					code: "USAGE",
					keyPath: FAILURE_SITE_KEYS.checkSelectorConflict,
					vars: { conflicting: presentSelectors.join(" / ") },
					detail: { conflicting: presentSelectors },
					renderAsJson
				});
				return 2;
			}
		}
		const MUTATOR_SCHEMA_LABELS = new Map([
			["spec/add-req", "spec add-req --schema"],
			["spec/add-scenario", "spec add-scenario --schema"],
			["spec/add-visual", "spec add-visual --schema"],
			["tasks/add", "tasks add --schema"],
			["evidence/add", "evidence add --schema"]
		]);
		const ARTIFACT_KINDS = new Set([
			"spec",
			"tasks",
			"evidence",
			"finding",
			"state"
		]);
		const isArtifactSchema = cmdTokens[1] === "schema" && cmdTokens[0] !== void 0 && ARTIFACT_KINDS.has(cmdTokens[0]);
		const mutatorSchemaLabel = cmdTokens[0] !== void 0 && cmdTokens[1] !== void 0 && argv.includes("--schema") ? MUTATOR_SCHEMA_LABELS.get(`${cmdTokens[0]}/${cmdTokens[1]}`) : void 0;
		if (isArtifactSchema || mutatorSchemaLabel !== void 0) {
			const presentSelectors = [];
			if (argv.includes("--session") || argv.some((a) => a.startsWith("--session="))) presentSelectors.push("--session");
			if (argv.includes("--feature") || argv.some((a) => a.startsWith("--feature="))) presentSelectors.push("--feature");
			if (argv.includes("--feature-dir") || argv.some((a) => a.startsWith("--feature-dir="))) presentSelectors.push("--feature-dir");
			if (process.env["LOAF_SESSION"] !== void 0 && process.env["LOAF_SESSION"].length > 0) presentSelectors.push("$LOAF_SESSION");
			if (process.env["LOAF_FEATURE"] !== void 0 && process.env["LOAF_FEATURE"].length > 0) presentSelectors.push("$LOAF_FEATURE");
			if (presentSelectors.length > 0) {
				const subj = mutatorSchemaLabel ?? `${cmdTokens[0]} schema`;
				const renderAsJson = argv.some((a) => a === "--format=json" || a === "--format" && argv[argv.indexOf(a) + 1] === "json");
				writePreContextSiteFailure({
					code: "USAGE",
					keyPath: FAILURE_SITE_KEYS.schemaSelectorConflict,
					vars: {
						subject: subj,
						conflicting: presentSelectors.join(" / ")
					},
					detail: { conflicting: presentSelectors },
					renderAsJson
				});
				return 2;
			}
		}
	}
	if (!wantsHelpOrVersion) {
		const hasSession = argv.includes("--session") || argv.some((a) => a.startsWith("--session="));
		const hasFeatureDir = argv.includes("--feature-dir") || argv.some((a) => a.startsWith("--feature-dir="));
		const hasFeature = argv.includes("--feature") || argv.some((a) => a.startsWith("--feature="));
		const hasLoafSession = process.env["LOAF_SESSION"] !== void 0 && process.env["LOAF_SESSION"].length > 0;
		const hasLoafFeature = process.env["LOAF_FEATURE"] !== void 0 && process.env["LOAF_FEATURE"].length > 0;
		const FLAGS_WITH_VALUES = new Set([
			"--format",
			"--session",
			"--feature",
			"--feature-dir",
			"--ceremony",
			"--label",
			"--workspace"
		]);
		let subcommand;
		for (let i = 2; i < argv.length; i++) {
			const a = argv[i];
			if (a.startsWith("--")) {
				const flagName = a.includes("=") ? a.slice(0, a.indexOf("=")) : a;
				if (FLAGS_WITH_VALUES.has(flagName) && !a.includes("=")) i++;
				continue;
			}
			if (a.startsWith("-") && a.length > 1) continue;
			subcommand = a;
			break;
		}
		if (hasFeatureDir && !(subcommand === "start")) {
			const sessionConflict = [];
			if (hasSession) sessionConflict.push("--session");
			if (hasLoafSession) sessionConflict.push("$LOAF_SESSION");
			let conflictingList = [];
			let usageKey = null;
			let usageVars = {};
			if (sessionConflict.length > 0) {
				usageKey = FAILURE_SITE_KEYS.dispatchSessionFeatureDirConflict;
				usageVars = { conflicting: sessionConflict.join(" + ") };
				conflictingList = [...sessionConflict, "--feature-dir"];
			} else if (!hasFeature && !hasLoafFeature) {
				usageKey = FAILURE_SITE_KEYS.dispatchFeatureDirRequiresFeature;
				usageVars = {};
				conflictingList = ["--feature-dir"];
			}
			if (usageKey !== null) {
				const renderAsJson = argv.some((a) => a === "--format=json" || a === "--format" && argv[argv.indexOf(a) + 1] === "json");
				writePreContextSiteFailure({
					code: "USAGE",
					keyPath: usageKey,
					vars: usageVars,
					detail: { conflicting: conflictingList },
					renderAsJson
				});
				return 2;
			}
		}
	}
	const userConfigLoad = await readUserConfig(deps.userConfigHomeDir ?? os.homedir());
	const localeResolution = resolveLocale({
		argv: [],
		env: process.env,
		userConfig: userConfigLoad.status === "ok" ? {
			status: "ok",
			locale: userConfigLoad.config.locale.default_lang
		} : userConfigLoad
	});
	if (!localeResolution.ok) {
		const presentation = parsePresentation(argv);
		if (presentation.ok && presentation.format === "json") process.stderr.write(JSON.stringify({
			ok: false,
			code: localeResolution.code,
			message: localeResolution.message,
			detail: localeResolution.detail
		}) + "\n");
		else process.stderr.write(`error: ${localeResolution.code} — ${localeResolution.message}\n`);
		return 2;
	}
	const i18n = createI18n(localeResolution.locale, BUILTIN_BUNDLES);
	const readStdin = deps.readStdin ?? defaultReadStdin;
	const isStdinTty = deps.isStdinTty ?? defaultIsStdinTty;
	const appendTraceLine = deps.appendTraceLine ?? defaultAppendTraceLine;
	const now = deps.now ?? (() => /* @__PURE__ */ new Date());
	const monotonicNow = deps.monotonicNow ?? (() => performance.now());
	const STDOUT_CAPTURE_CHAR_CAP = 4096;
	const stdoutCapture = [];
	let stdoutCaptureChars = 0;
	const writeStdoutCaptured = (s) => {
		if (stdoutCaptureChars < STDOUT_CAPTURE_CHAR_CAP) {
			stdoutCapture.push(s.slice(0, STDOUT_CAPTURE_CHAR_CAP - stdoutCaptureChars));
			stdoutCaptureChars += s.length;
		}
		process.stdout.write(s);
	};
	const program = new Command();
	program.name("loaf").description("Spec-driven development protocol CLI").version(version).option("--format <fmt>", `Output format: ${FORMAT_MODES_HUMAN} (default: text)`).option("--plain", "Alias for --format text (clig.dev convention)").option("--no-color", "Disable color (NO_COLOR/LOAF_NO_COLOR/TERM=dumb equivalents)").option("-q, --quiet", "Suppress advisory stderr (state-change + next hint; errors still emit)").option("-v, --verbose", "Increase advisory detail; counter — repeat for more (-v, -vv)", (_v, prior) => (prior ?? 0) + 1, 0).option("--no-input", "Non-interactive mode: refuse git-config actor fallback; forward-compat with future prompts (skill / hook / CI)").option("--debug", "Write per-invocation trace.jsonl (LOAF_DEBUG=1 / DEBUG=1 equivalents)").option("-n, --dry-run", "Validate without writing (mutating commands only); read-only commands exit 2").option("--session <uuid-or-prefix>", "Resolve session by UUID or ≥8-char prefix (registry lookup; see §10.3)").addHelpText("after", helpFooter()).showHelpAfterError().exitOverride();
	const actor = `cli:loaf@${process.env["USER"] ?? "unknown"}`;
	const ctx = createCommandContext(argv, {
		writeStdout: writeStdoutCaptured,
		writeStderr: (s) => process.stderr.write(s),
		loadSession,
		loadProjections,
		i18n,
		...deps.registryDir !== void 0 && { registryDir: deps.registryDir }
	});
	function emitKeyedFailure(code, detail) {
		const vars = diagnosticVarsFor(code, detail);
		if (vars === null) return false;
		ctx.failureKeyed(code, diagnosticKey(code), vars, detail);
		return true;
	}
	const fail = (code, message) => {
		if (!emitKeyedFailure(code, void 0)) ctx.failure(code, message);
	};
	const emitFailure = (code, message, detail) => {
		if (!emitKeyedFailure(code, detail)) ctx.failure(code, message, detail);
	};
	const emitNoSessionFailure = (keyPath, feature, detail) => {
		ctx.failureKeyed("NO_SESSION", keyPath, { feature }, detail);
	};
	const isInteractiveHumanForActor = () => (deps.isInteractiveHuman?.() ?? process.stdin.isTTY === true) && !ctx.noInput;
	const readGitConfigForActor = deps.readGitConfig ?? getGitEmail;
	const dispatchOrFail = async (opts) => {
		const dispatch = await ctx.resolveDispatch();
		if (!dispatch.ok) {
			emitFailure(dispatch.code, dispatch.message, dispatch.detail);
			return null;
		}
		if (dispatch.autoPickAdvisory) ctx.advisory(dispatch.autoPickAdvisory);
		opts.feature = dispatch.feature;
		opts.featureDir = dispatch.featureDir;
		ctx.recordTraceTarget(dispatch.feature, dispatch.featureDir);
		return dispatch.featureDir;
	};
	const dispatchForHookOptional = async (opts) => {
		let dispatch;
		try {
			dispatch = await ctx.resolveDispatch();
		} catch {
			return { skip: true };
		}
		if (dispatch.ok) {
			opts.feature = dispatch.feature;
			opts.featureDir = dispatch.featureDir;
			ctx.recordTraceTarget(dispatch.feature, dispatch.featureDir);
			return { featureDir: dispatch.featureDir };
		}
		if (dispatch.code === "SNAPSHOT_STALE_REBUILD_REQUIRED") return {
			skip: true,
			stale: {
				code: dispatch.code,
				message: dispatch.message
			}
		};
		return { skip: true };
	};
	const resolveHookPath = async (opts) => {
		if (opts.path !== void 0 && opts.path.length > 0) return opts.path;
		if (!isStdinTty()) {
			const parsed = parseHookStdinPath(await readStdin());
			if (!parsed.ok) {
				ctx.failureKeyed("SCHEMA_VALIDATION_FAILED", FAILURE_SITE_KEYS.hookStdinParseFailed, { reason: parsed.reason }, { source: "hook-stdin" });
				return null;
			}
			return parsed.path;
		}
		ctx.failureKeyed("USAGE", FAILURE_SITE_KEYS.hookWritePathMissing, {}, {});
		return null;
	};
	const resolveDispatchForWriteGuard = async (opts) => {
		let dispatch;
		try {
			dispatch = await ctx.resolveDispatch();
		} catch (err) {
			return {
				failClosed: true,
				code: "SNAPSHOT_STALE_REBUILD_REQUIRED",
				message: `write-guard cannot resolve the session: ${err.message}`
			};
		}
		if (dispatch.ok) {
			opts.feature = dispatch.feature;
			opts.featureDir = dispatch.featureDir;
			ctx.recordTraceTarget(dispatch.feature, dispatch.featureDir);
			return { featureDir: dispatch.featureDir };
		}
		if (dispatch.code === "FEATURE_NOT_FOUND") return { allow: true };
		return {
			failClosed: true,
			code: dispatch.code,
			message: dispatch.message
		};
	};
	const registryWriterDeps = deps.registryDir !== void 0 || deps.registryNow !== void 0 || deps.registryCwd !== void 0 ? {
		...deps.registryDir !== void 0 && { registryDir: deps.registryDir },
		...deps.registryNow !== void 0 && { now: deps.registryNow },
		...deps.registryCwd !== void 0 && { cwd: deps.registryCwd }
	} : void 0;
	const emitDryRunSuccess = (result) => {
		const kind = "entry" in result ? result.entry.kind : result.entries[0]?.kind ?? "(empty)";
		ctx.success({
			ok: true,
			dry_run: true,
			would: { kind }
		}, () => `dry-run: would ${kind}\n`);
	};
	const rejectIfDryRun = (command, commandType = "read-only") => {
		if (ctx.dryRun) {
			emitFailure("DRY_RUN_NOT_APPLICABLE", `--dry-run not applicable to ${commandType} command \`${command}\``, {
				command,
				command_type: commandType
			});
			return true;
		}
		return false;
	};
	const emitMutatorSchemaAndExit = (commandKey) => {
		const schema = emitInputSchema(commandKey);
		ctx.success(schema, () => formatSchema(schema));
	};
	const routeMutateFailure = (route, r) => {
		if (route === "legacy-fail") fail(r.code, r.message);
		else if (route === "raw-ctx-failure") ctx.failure(r.code, r.message, r.detail);
		else emitFailure(r.code, r.message, r.detail);
	};
	const mctxFor = (featureDir, session) => ({
		feature_dir: featureDir,
		snapshot: session.snapshot,
		tail_seq: session.tail_seq,
		entries: session.entries,
		meta: session.meta,
		dryRun: ctx.dryRun,
		registryWriter: registryWriterDeps
	});
	function finishMutate(result, route) {
		if (!result.ok) {
			routeMutateFailure(route, result);
			return null;
		}
		if (ctx.dryRun) {
			emitDryRunSuccess(result);
			return null;
		}
		return result;
	}
	async function runMutator(featureDir, session, input, route = "emit-failure") {
		const now = (/* @__PURE__ */ new Date()).toISOString();
		const stamp = (e) => ({
			at: now,
			actor: e.actor,
			entry_schema_version: 1,
			kind: e.kind,
			payload: e.payload
		});
		const mctx = mctxFor(featureDir, session);
		return finishMutate(Array.isArray(input) ? await mutateBatch(input.map(stamp), mctx) : await mutate(stamp(input), mctx), route);
	}
	const loadProjectionsOrFail = async (featureDir, kinds, feature, noSessionKey) => {
		try {
			return await loadProjections({
				feature_dir: featureDir,
				kinds
			});
		} catch (err) {
			if (err instanceof NoSessionError) {
				emitNoSessionFailure(noSessionKey, feature, err.detail);
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
			ctx.failureKeyed("USAGE", FAILURE_SITE_KEYS.startLabelTooShort, { min_length: 3 }, {
				min_length: 3,
				actual_length: opts.label.length
			});
			return;
		}
		if (opts.workspace.length < 1) {
			ctx.failureKeyed("USAGE", FAILURE_SITE_KEYS.startWorkspaceEmpty, {}, {});
			return;
		}
		const featureDir = opts.featureDir ?? defaultFeatureDir(feature);
		ctx.recordTraceTarget(feature, featureDir);
		const session = await loadSession(featureDir, { ensureDir: !ctx.dryRun });
		const sessionId = crypto.randomUUID();
		const result = await runMutator(featureDir, session, {
			kind: "session:started",
			payload: {
				session_id: sessionId,
				feature,
				ceremony,
				ceremony_label: opts.ceremony,
				workspace: opts.workspace,
				loaf_version_required: `^${version}`,
				...opts.label !== void 0 ? { session_label: opts.label } : {}
			},
			actor
		}, "legacy-fail");
		if (!result) return;
		const out = {
			ok: true,
			feature,
			session_id: sessionId,
			ceremony_label: opts.ceremony,
			workspace: opts.workspace,
			feature_dir: featureDir,
			sub_state: result.snapshot.state?.sub_state
		};
		ctx.success(out, () => `${sessionId}\n`, (i18n) => ({
			stateChange: i18n.t(SUCCESS_KEYS.startStateChange, { feature }),
			next: i18n.t(SUCCESS_KEYS.nextAdvance)
		}));
	});
	program.command("advance <to>").description("Advance the session cursor (emits event:phase_advanced)").option("--feature <name>", "Feature whose session to advance").option("--feature-dir <path>", "Override default .loaf/<feature> directory").action(async (to, opts) => {
		const featureDir = await dispatchOrFail(opts);
		if (featureDir === null) return;
		const session = await loadSession(featureDir, { ensureDir: !ctx.dryRun });
		const from = session.snapshot.state?.sub_state;
		if (!from) {
			emitNoSessionFailure(FAILURE_SITE_KEYS.noSessionAdvance, opts.feature);
			return;
		}
		const result = await runMutator(featureDir, session, {
			kind: "event:phase_advanced",
			payload: {
				from,
				to
			},
			actor
		}, "legacy-fail");
		if (!result) return;
		const out = {
			ok: true,
			from,
			to,
			sub_state: result.snapshot.state?.sub_state
		};
		ctx.success(out, () => "", (i18n) => ({ stateChange: i18n.t(SUCCESS_KEYS.advanceStateChange, {
			from,
			to
		}) }));
	});
	program.command("status").description("Show the current session snapshot (read-only)").option("--feature <name>", "Feature whose status to show").option("--feature-dir <path>", "Override default .loaf/<feature> directory").action(async (opts) => {
		if (rejectIfDryRun("status")) return;
		const featureDir = await dispatchOrFail(opts);
		if (featureDir === null) return;
		const loaded = await loadProjectionsOrFail(featureDir, [
			"state",
			"tasks",
			"evidence",
			"findings",
			"pending"
		], opts.feature, FAILURE_SITE_KEYS.noSessionStatus);
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
		ctx.success(out, (i18n) => i18n.t(CHROME_KEYS.statusFeature, { feature: opts.feature }) + "\n" + i18n.t(CHROME_KEYS.statusPhase, { phase: i18n.t(subStateKey(state.sub_state)) }) + "\n" + i18n.t(CHROME_KEYS.statusCursor, { cursor: state.sub_state }) + "\n" + i18n.t(CHROME_KEYS.statusTail, { seq: out.tail_seq }) + "\n" + i18n.t(CHROME_KEYS.statusCounts, {
			tasks_count: out.tasks_count,
			evidence_count: out.evidence_count,
			findings_count: out.findings_count,
			pending_count: out.pending_count
		}) + "\n" + i18n.t(CHROME_KEYS.statusSnapshotAsOfProjectionLoader, { seq: out.tail_seq }) + "\n");
	});
	program.command("next").description("Compute the next owner command for the current session (read-only)").option("--feature <name>", "Feature whose next action to compute").option("--feature-dir <path>", "Override default .loaf/<feature> directory").action(async (opts) => {
		if (rejectIfDryRun("next")) return;
		const featureDir = await dispatchOrFail(opts);
		if (featureDir === null) return;
		const loaded = await loadProjectionsOrFail(featureDir, [
			"state",
			"tasks",
			"pending"
		], opts.feature, FAILURE_SITE_KEYS.noSessionStatus);
		if (loaded === null) return;
		let verifyApplicableLanes;
		if (loaded.state.sub_state.startsWith("VERIFY.")) {
			const read = await readSpecFrontmatter(featureDir);
			if (!read.ok) {
				emitFailure("SPEC_FRONTMATTER_INVALID", read.message, {
					subcode: read.code,
					...read.detail ?? {}
				});
				return;
			}
			verifyApplicableLanes = deriveVerifyApplicability({
				state: null,
				tasks: loaded.tasks ? loaded.tasks.tasks.map((t) => extractTaskSlim(t)) : [],
				evidence: [],
				findings: [],
				pending: [],
				spec_header: null,
				requirements: [],
				scenarios: [],
				visual_contracts: [],
				tasks_based_on: null
			}, read.frontmatter);
		}
		const out = buildNextOutput({
			feature: opts.feature,
			feature_dir: featureDir,
			phase: loaded.state.phase,
			sub_state: loaded.state.sub_state,
			ceremony: loaded.state.ceremony,
			spec_locked: loaded.state.spec_locked,
			verify_accepted: loaded.state.verify_accepted,
			pending: loaded.state.pending,
			verify_applicable_lanes: verifyApplicableLanes
		});
		ctx.success(out, () => out.next_action === void 0 ? "" : `${out.next_action.command}\n`);
	});
	program.command("gate").description("Gate decision commands (spec-lock + verify-accept)").command("decide <gate-name>").description("Decide a gate (emits gate:decided; spec-lock approve also advances cursor)").option("--approve", "Approve the gate").option("--reject", "Reject the gate").requiredOption("--reason <text>", "Decision rationale (passed through to GateDecidedPayload)").option("--feature <name>", "Feature whose session to gate").option("--feature-dir <path>", "Override default .loaf/<feature> directory").action(async (gateName, opts) => {
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
			readGitConfig: readGitConfigForActor,
			isInteractiveHuman: isInteractiveHumanForActor()
		});
		if (!resolution.ok) {
			emitFailure(resolution.code, resolution.message);
			return;
		}
		const humanActor = resolution.actor;
		const featureDir = await dispatchOrFail(opts);
		if (featureDir === null) return;
		const session = await loadSession(featureDir, { ensureDir: !ctx.dryRun });
		const from = session.snapshot.state?.sub_state;
		if (!from) {
			emitNoSessionFailure(FAILURE_SITE_KEYS.noSessionGeneric, opts.feature);
			return;
		}
		const pendingHead = session.snapshot.pending.find((p) => !p.resolved);
		const coEmitPendingResolved = approve && pendingHead && pendingHead.kind === "gate_decision";
		if (approve) {
			if (gateName === "spec-lock") {
				const result = await runMutator(featureDir, session, buildGateApprovalBatch({
					gate: "spec-lock",
					reason: opts.reason,
					humanActor,
					cliActor: actor,
					from,
					...coEmitPendingResolved && pendingHead ? { pendingHeadId: pendingHead.id } : {}
				}));
				if (!result) return;
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
				ctx.success(out, () => "", (i18n) => ({ stateChange: i18n.t(SUCCESS_KEYS.gateSpecLockApprovedStateChange, { actor: humanActor }) }));
				return;
			}
			const result = await runMutator(featureDir, session, buildGateApprovalBatch({
				gate: "verify-accept",
				reason: opts.reason,
				humanActor,
				cliActor: actor,
				...coEmitPendingResolved && pendingHead ? { pendingHeadId: pendingHead.id } : {}
			}));
			if (!result) return;
			const out = {
				ok: true,
				gate: "verify-accept",
				decision: "approved",
				from,
				actor: humanActor,
				sub_state: result.snapshot.state?.sub_state,
				verify_accepted: result.snapshot.state?.verify_accepted
			};
			const nextCmd = result.snapshot.state?.ceremony?.settle_phase === true ? "loaf settle" : "loaf deliver";
			ctx.success(out, () => "", (i18n) => ({
				stateChange: i18n.t(SUCCESS_KEYS.gateVerifyAcceptApprovedStateChange, { actor: humanActor }),
				next: i18n.t(nextCmd === "loaf settle" ? SUCCESS_KEYS.nextSettle : SUCCESS_KEYS.nextDeliver)
			}));
			return;
		}
		const result = await runMutator(featureDir, session, {
			kind: "gate:decided",
			payload: {
				gate_kind: gateName,
				decision: "rejected",
				reason: opts.reason
			},
			actor: humanActor
		});
		if (!result) return;
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
		ctx.success(out, () => "", (i18n) => ({ stateChange: i18n.t(SUCCESS_KEYS.gateRejectedStateChange, {
			gate: gateName,
			actor: humanActor
		}) }));
	});
	program.command("deliver").description("Deliver the feature session (emits session:delivered → DONE.delivered)").option("--feature <name>", "Feature whose session to deliver").option("--feature-dir <path>", "Override default .loaf/<feature> directory").option("--reason <text>", "Optional rationale to record on the session:delivered entry").action(async (opts) => {
		const resolution = resolveHumanActor({
			env: process.env,
			readGitConfig: readGitConfigForActor,
			isInteractiveHuman: isInteractiveHumanForActor()
		});
		if (!resolution.ok) {
			ctx.failure(resolution.code, resolution.message);
			return;
		}
		const humanActor = resolution.actor;
		const featureDir = await dispatchOrFail(opts);
		if (featureDir === null) return;
		const session = await ctx.resolveSession(featureDir);
		const from = session.snapshot.state?.sub_state;
		if (!from) {
			emitNoSessionFailure(FAILURE_SITE_KEYS.noSessionGeneric, opts.feature);
			return;
		}
		const payload = {};
		if (opts.reason !== void 0) payload["reason"] = opts.reason;
		const result = await runMutator(featureDir, session, {
			kind: "session:delivered",
			payload,
			actor: humanActor
		}, "raw-ctx-failure");
		if (!result) return;
		const out = {
			ok: true,
			feature: opts.feature,
			from,
			to: "DONE.delivered",
			actor: humanActor,
			sub_state: result.snapshot.state?.sub_state,
			advisory: [`session complete — \`loaf start <feature>\` to begin another`]
		};
		ctx.success(out, () => "", (i18n) => ({
			stateChange: i18n.t(SUCCESS_KEYS.deliverStateChange, {
				feature: opts.feature,
				from,
				actor: humanActor
			}),
			next: i18n.t(SUCCESS_KEYS.deliverNext)
		}));
	});
	program.command("archive").description("Close the feature session without delivering (emits session:archived → DONE.archived)").option("--feature <name>", "Feature whose session to archive").requiredOption("--reason <text>", "Rationale recorded on the session:archived entry").option("--feature-dir <path>", "Override default .loaf/<feature> directory").action(async (opts) => {
		const resolution = resolveHumanActor({
			env: process.env,
			readGitConfig: readGitConfigForActor,
			isInteractiveHuman: isInteractiveHumanForActor()
		});
		if (!resolution.ok) {
			emitFailure(resolution.code, resolution.message);
			return;
		}
		const humanActor = resolution.actor;
		const featureDir = await dispatchOrFail(opts);
		if (featureDir === null) return;
		const session = await loadSession(featureDir, { ensureDir: !ctx.dryRun });
		const from = session.snapshot.state?.sub_state;
		if (!from) {
			emitNoSessionFailure(FAILURE_SITE_KEYS.noSessionGeneric, opts.feature);
			return;
		}
		const result = await runMutator(featureDir, session, {
			kind: "session:archived",
			payload: { reason: opts.reason },
			actor: humanActor
		});
		if (!result) return;
		const out = {
			ok: true,
			feature: opts.feature,
			from,
			to: "DONE.archived",
			actor: humanActor,
			sub_state: result.snapshot.state?.sub_state
		};
		ctx.success(out, () => "", (i18n) => ({ stateChange: i18n.t(SUCCESS_KEYS.archiveStateChange, {
			feature: opts.feature,
			from,
			actor: humanActor
		}) }));
	});
	program.command("abandon").description("Abandon the feature session (emits session:abandoned → DONE.abandoned)").option("--feature <name>", "Feature whose session to abandon").requiredOption("--reason <text>", "Rationale recorded on the session:abandoned entry").option("--feature-dir <path>", "Override default .loaf/<feature> directory").action(async (opts) => {
		const resolution = resolveHumanActor({
			env: process.env,
			readGitConfig: readGitConfigForActor,
			isInteractiveHuman: isInteractiveHumanForActor()
		});
		if (!resolution.ok) {
			emitFailure(resolution.code, resolution.message);
			return;
		}
		const humanActor = resolution.actor;
		const featureDir = await dispatchOrFail(opts);
		if (featureDir === null) return;
		const session = await loadSession(featureDir, { ensureDir: !ctx.dryRun });
		const from = session.snapshot.state?.sub_state;
		if (!from) {
			emitNoSessionFailure(FAILURE_SITE_KEYS.noSessionGeneric, opts.feature);
			return;
		}
		const result = await runMutator(featureDir, session, {
			kind: "session:abandoned",
			payload: { reason: opts.reason },
			actor: humanActor
		});
		if (!result) return;
		const out = {
			ok: true,
			feature: opts.feature,
			from,
			to: "DONE.abandoned",
			actor: humanActor,
			sub_state: result.snapshot.state?.sub_state
		};
		ctx.success(out, () => "", (i18n) => ({ stateChange: i18n.t(SUCCESS_KEYS.abandonStateChange, {
			feature: opts.feature,
			from,
			actor: humanActor,
			reason: opts.reason
		}) }));
	});
	program.command("spike").description("Spike-task exits (protocol §8.3)").command("convert").description("Convert a spike session — emits spike:converted then archives to DONE.archived").option("--feature <name>", "Feature whose spike session to convert").requiredOption("--to-feature <id>", "Target feature id (F-NNN) the spike learnings carry into").requiredOption("--reason <text>", "Rationale recorded on the spike:converted entry").option("--feature-dir <path>", "Override default .loaf/<feature> directory").action(async (opts) => {
		const resolution = resolveHumanActor({
			env: process.env,
			readGitConfig: readGitConfigForActor,
			isInteractiveHuman: isInteractiveHumanForActor()
		});
		if (!resolution.ok) {
			emitFailure(resolution.code, resolution.message);
			return;
		}
		const humanActor = resolution.actor;
		const featureDir = await dispatchOrFail(opts);
		if (featureDir === null) return;
		const session = await loadSession(featureDir, { ensureDir: !ctx.dryRun });
		const from = session.snapshot.state?.sub_state;
		if (!from) {
			emitNoSessionFailure(FAILURE_SITE_KEYS.noSessionGeneric, opts.feature);
			return;
		}
		const result = await runMutator(featureDir, session, [{
			kind: "spike:converted",
			payload: {
				to_feature: opts.toFeature,
				reason: opts.reason
			},
			actor: humanActor
		}, {
			kind: "session:archived",
			payload: { reason: opts.reason },
			actor: humanActor
		}]);
		if (!result) return;
		const out = {
			ok: true,
			feature: opts.feature,
			to_feature: opts.toFeature,
			from,
			to: "DONE.archived",
			actor: humanActor,
			sub_state: result.snapshot.state?.sub_state
		};
		ctx.success(out, () => "", (i18n) => ({ stateChange: i18n.t(SUCCESS_KEYS.spikeConvertStateChange, {
			feature: opts.feature,
			to_feature: opts.toFeature,
			from,
			actor: humanActor
		}) }));
	});
	program.command("profile").description("Ceremony profile commands (protocol §10.8)").command("escalate").description("Apply a ceremony escalation — resolve the profile_escalation pending + emit event:ceremony_set").requiredOption("--confirm", "Human acceptance of the escalation (required)").requiredOption("--input <path>", "JSON file with the escalated 6-flag Ceremony object").option("--feature <name>", "Feature whose session to escalate").option("--feature-dir <path>", "Override default .loaf/<feature> directory").action(async (opts) => {
		if (await dispatchOrFail(opts) === null) return;
		const resolution = resolveHumanActor({
			env: process.env,
			readGitConfig: readGitConfigForActor,
			isInteractiveHuman: isInteractiveHumanForActor()
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
			if (err.code === "ENOENT") ctx.failureKeyed("INPUT_FILE_NOT_FOUND", FAILURE_SITE_KEYS.profileInputFileMissing, { path: opts.input }, { path: opts.input });
			else ctx.failureKeyed("INPUT_FILE_NOT_FOUND", FAILURE_SITE_KEYS.profileInputFileUnreadable, {
				path: opts.input,
				error: String(err)
			}, { path: opts.input });
			return;
		}
		let ceremony;
		try {
			ceremony = JSON.parse(content);
		} catch (err) {
			emitFailure("SCHEMA_VALIDATION_FAILED", `input is not valid JSON: ${err.message}`);
			return;
		}
		const featureDir = await dispatchOrFail(opts);
		if (featureDir === null) return;
		const session = await loadSession(featureDir, { ensureDir: !ctx.dryRun });
		if (!session.snapshot.state?.sub_state) {
			emitNoSessionFailure(FAILURE_SITE_KEYS.noSessionGeneric, opts.feature);
			return;
		}
		const head = session.snapshot.pending.find((p) => !p.resolved);
		if (!head) {
			emitFailure("ESCALATION_NOT_PENDING", "`loaf profile escalate --confirm --input <ceremony.json>` requires pending head kind=profile_escalation; current head: (none)", { actual_head: "(none)" });
			return;
		}
		const result = await runMutator(featureDir, session, [{
			kind: "event:ceremony_set",
			payload: ceremony,
			actor: humanActor
		}, {
			kind: "pending:resolved",
			payload: { id: head.id },
			actor: humanActor
		}]);
		if (!result) return;
		const out = {
			ok: true,
			feature: opts.feature,
			resolved_pending: head.id,
			sub_state: result.snapshot.state?.sub_state,
			actor: humanActor
		};
		ctx.success(out, () => "", (i18n) => ({ stateChange: i18n.t(SUCCESS_KEYS.profileEscalateStateChange, { pending_id: head.id }) }));
	});
	program.command("doctor").description("Repository self-check. This release implements --rebuild only").option("--rebuild", "Full journal replay → rebuild snapshots/*.json + _meta.json").option("--feature <name>", "Feature whose snapshots to rebuild (required with --rebuild)").option("--feature-dir <path>", "Override default .loaf/<feature> directory").action(async (opts) => {
		if (rejectIfDryRun(opts.rebuild ? "doctor --rebuild" : "doctor")) return;
		if (!opts.rebuild) {
			emitFailure("DOCTOR_MODE_NOT_IMPLEMENTED", "only --rebuild is implemented for loaf doctor in this release");
			return;
		}
		if (!opts.feature) {
			emitFailure("DOCTOR_FEATURE_REQUIRED", "doctor --rebuild requires --feature <name>");
			return;
		}
		const featureDir = opts.featureDir ?? defaultFeatureDir(opts.feature);
		ctx.recordTraceTarget(opts.feature, featureDir);
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
		ctx.success(out, (i18n) => i18n.t(rebuilt.length === 1 ? SUCCESS_KEYS.doctorRebuildTextOne : SUCCESS_KEYS.doctorRebuildTextMany, {
			count: rebuilt.length,
			feature: opts.feature
		}) + "\n" + rebuilt.map((f) => `  snapshots/${f}\n`).join("") + i18n.t(SUCCESS_KEYS.snapshotAsOfSeq, { seq: replay.meta.last_applied_seq }) + "\n", (i18n) => ({ stateChange: i18n.t(rebuilt.length === 1 ? SUCCESS_KEYS.doctorRebuildStateChangeOne : SUCCESS_KEYS.doctorRebuildStateChangeMany, {
			count: rebuilt.length,
			feature: opts.feature
		}) }));
	});
	const tasksCmd = program.command("tasks").description("Task lifecycle commands (Slice 2 MVP: submit / claim / step)");
	tasksCmd.command("submit").description("Submit a complete task graph from --input <src> (stdin / inline JSON / file path; whole-graph single object)").requiredOption("--input <src>", "JSON source: `-` (stdin), inline JSON literal, or file path (protocol §10.7). Whole-graph single object only.").option("--feature <name>", "Feature whose task graph to submit").option("--feature-dir <path>", "Override default .loaf/<feature> directory").action(async (opts) => {
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
		const featureDir = await dispatchOrFail(opts);
		if (featureDir === null) return;
		const session = await ctx.resolveSession(featureDir);
		if (!session.snapshot.state) {
			emitNoSessionFailure(FAILURE_SITE_KEYS.noSessionTasks, opts.feature);
			return;
		}
		const result = await runMutator(featureDir, session, {
			kind: "event:tasks_planned",
			payload,
			actor
		}, "raw-ctx-failure");
		if (!result) return;
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
		ctx.success(out, (i18n) => i18n.t(tasks.length === 1 ? SUCCESS_KEYS.tasksSubmitTextOne : SUCCESS_KEYS.tasksSubmitTextMany, {
			count: tasks.length,
			task_ids: taskIds.join(", ")
		}) + "\n", (i18n) => ({
			stateChange: i18n.t(SUCCESS_KEYS.tasksSubmitStateChange, { count: tasks.length }),
			next: i18n.t(SUCCESS_KEYS.nextAdvance)
		}));
	});
	tasksCmd.command("add").description("Append id-less task(s) to the graph — --input <src> with single object or array (batch); SPEC.design whole-graph, or EXECUTE.work sponsored via --finding").option("--input <src>", "JSON source for TaskInput (single object or array): `-` (stdin), inline JSON, or file path (protocol §10.7)").option("--schema", "Dump the input JSON Schema instead of mutating (Phase 16 SC-10)").option("--feature <name>", "Feature whose task graph to extend").option("--feature-dir <path>", "Override default .loaf/<feature> directory").option("--finding <FND-N>", "Sponsoring amend-tasks finding (sponsored add at EXECUTE.work)").action(async (rawOpts) => {
		if (rawOpts.schema === true) {
			if (rejectIfDryRun("tasks add --schema")) return;
			emitMutatorSchemaAndExit("tasks:add");
			return;
		}
		if (rawOpts.input === void 0) {
			emitFailure("MISSING_INPUT", "loaf tasks add requires --input <src> (or pass --schema to dump the input JSON Schema)");
			return;
		}
		const opts = rawOpts;
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
			ctx.failureKeyed("SCHEMA_VALIDATION_FAILED", FAILURE_SITE_KEYS.tasksAddEmptyArray, {}, {});
			return;
		}
		const validatedInputs = [];
		for (const raw of rawTasks) {
			const p = TaskInput$1.safeParse(raw);
			if (!p.success) {
				ctx.failure("SCHEMA_VALIDATION_FAILED", `tasks add input is not a valid id-less task (omit id / status / execution): ${p.error.issues.map((i) => i.message).join("; ")}`, { issues: p.error.issues });
				return;
			}
			validatedInputs.push(p.data);
		}
		const featureDir = await dispatchOrFail(opts);
		if (featureDir === null) return;
		const session = await ctx.resolveSession(featureDir);
		if (!session.snapshot.state) {
			emitNoSessionFailure(FAILURE_SITE_KEYS.noSessionTasks, opts.feature);
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
			const result = finishMutate(await mutateBatch(seededNew.map((task) => ({
				at: (/* @__PURE__ */ new Date()).toISOString(),
				actor,
				entry_schema_version: 1,
				kind: "event:tasks_amended",
				payload: {
					mode: "add",
					task,
					sponsored_by_finding_id: opts.finding
				}
			})), mctxFor(featureDir, session)), "raw-ctx-failure");
			if (!result) return;
			const out = {
				ok: true,
				feature: opts.feature,
				task_ids: newIds,
				sponsored_by_finding_id: opts.finding,
				tasks_count: result.snapshot.tasks.length,
				sub_state: result.snapshot.state?.sub_state
			};
			ctx.success(out, (i18n) => i18n.t(newIds.length === 1 ? SUCCESS_KEYS.tasksAddSponsoredTextOne : SUCCESS_KEYS.tasksAddSponsoredTextMany, {
				count: newIds.length,
				finding: opts.finding,
				task_ids: newIds.join(", ")
			}) + "\n", (i18n) => ({ stateChange: i18n.t(SUCCESS_KEYS.tasksAddStateChange, {
				count: newIds.length,
				task_ids: newIds.join(",")
			}) }));
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
		const result = await runMutator(featureDir, session, {
			kind: "event:tasks_planned",
			payload: {
				based_on: session.snapshot.tasks_based_on ?? { spec: session.snapshot.state.spec_version },
				tasks: [...existingFull, ...seededNew]
			},
			actor
		}, "raw-ctx-failure");
		if (!result) return;
		const out = {
			ok: true,
			feature: opts.feature,
			task_ids: newIds,
			tasks_count: result.snapshot.tasks.length,
			sub_state: result.snapshot.state?.sub_state
		};
		ctx.success(out, (i18n) => i18n.t(newIds.length === 1 ? SUCCESS_KEYS.tasksAddTextOne : SUCCESS_KEYS.tasksAddTextMany, {
			count: newIds.length,
			task_ids: newIds.join(", ")
		}) + "\n", (i18n) => ({ stateChange: i18n.t(SUCCESS_KEYS.tasksAddStateChange, {
			count: newIds.length,
			task_ids: newIds.join(",")
		}) }));
	});
	tasksCmd.command("claim <task-id>").description("Claim a ready task (pending → in_progress) at EXECUTE.work").option("--feature <name>", "Feature whose task to claim").option("--feature-dir <path>", "Override default .loaf/<feature> directory").action(async (taskId, opts) => {
		const featureDir = await dispatchOrFail(opts);
		if (featureDir === null) return;
		const session = await loadSession(featureDir, { ensureDir: !ctx.dryRun });
		if (!session.snapshot.state) {
			emitNoSessionFailure(FAILURE_SITE_KEYS.noSessionTasks, opts.feature);
			return;
		}
		const result = await runMutator(featureDir, session, {
			kind: "event:task_claimed",
			payload: { task_id: taskId },
			actor
		});
		if (!result) return;
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
		ctx.success(out, () => "", (i18n) => ({ stateChange: i18n.t(SUCCESS_KEYS.tasksClaimStateChange, {
			task_id: taskId,
			status
		}) }));
	});
	tasksCmd.command("abandon <task-id>").description("Abandon a non-terminal task (→ abandoned) at EXECUTE.work").requiredOption("--reason <text>", "Why the task is being abandoned (required)").option("--feature <name>", "Feature whose task to abandon").option("--feature-dir <path>", "Override default .loaf/<feature> directory").action(async (taskId, opts) => {
		const featureDir = await dispatchOrFail(opts);
		if (featureDir === null) return;
		const session = await loadSession(featureDir, { ensureDir: !ctx.dryRun });
		if (!session.snapshot.state) {
			emitNoSessionFailure(FAILURE_SITE_KEYS.noSessionTasks, opts.feature);
			return;
		}
		const result = await runMutator(featureDir, session, {
			kind: "event:task_abandoned",
			payload: {
				task_id: taskId,
				reason: opts.reason
			},
			actor
		});
		if (!result) return;
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
		ctx.success(out, () => "", (i18n) => ({ stateChange: i18n.t(SUCCESS_KEYS.tasksAbandonStateChange, {
			task_id: taskId,
			status
		}) }));
	});
	tasksCmd.command("list").description("List tasks (read-only); shows derived `ready` column").option("--feature <name>", "Feature whose tasks to list").option("--feature-dir <path>", "Override default .loaf/<feature> directory").option("--status <s>", "Filter by task status (pending|ready|in_progress|done|abandoned)").action(async (opts) => {
		if (rejectIfDryRun("tasks list")) return;
		const featureDir = await dispatchOrFail(opts);
		if (featureDir === null) return;
		const loaded = await loadProjectionsOrFail(featureDir, ["state", "tasks"], opts.feature, FAILURE_SITE_KEYS.noSessionTasks);
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
		ctx.success({
			ok: true,
			feature: opts.feature,
			count: filtered.length,
			tasks: filtered
		}, (i18n) => {
			if (filtered.length === 0) return opts.status ? i18n.t(CHROME_KEYS.tasksListEmptyFiltered, { status: opts.status }) + "\n" : i18n.t(CHROME_KEYS.tasksListEmpty) + "\n";
			return filtered.map((t) => {
				const vars = {
					task_id: t.id,
					kind: formatTaskListKind(i18n, t.kind),
					status: formatTaskStatus(i18n, t.status),
					ready: i18n.t(CHROME_KEYS.tasksListReadyMarker)
				};
				return i18n.t(t.ready ? CHROME_KEYS.tasksListRowReady : CHROME_KEYS.tasksListRow, vars) + "\n";
			}).join("");
		});
	});
	tasksCmd.command("next").description("Print the next ready task id (or empty if none); read-only").option("--feature <name>", "Feature whose ready task to compute").option("--feature-dir <path>", "Override default .loaf/<feature> directory").action(async (opts) => {
		if (rejectIfDryRun("tasks next")) return;
		const featureDir = await dispatchOrFail(opts);
		if (featureDir === null) return;
		const session = await loadSession(featureDir, { ensureDir: !ctx.dryRun });
		if (!session.snapshot.state) {
			emitNoSessionFailure(FAILURE_SITE_KEYS.noSessionTasks, opts.feature);
			return;
		}
		const tasks = session.snapshot.tasks;
		const tasksById = new Map(tasks.map((t) => [t.id, t]));
		const ready = tasks.find((t) => {
			if (t.status !== "pending") return false;
			return t.depends_on.length === 0 || t.depends_on.every((d) => tasksById.get(d)?.status === "done");
		});
		ctx.success({
			ok: true,
			feature: opts.feature,
			task_id: ready?.id ?? null,
			kind: ready?.kind ?? null
		}, () => ready ? `${ready.id}\n` : "");
	});
	tasksCmd.command("complete <task-id>").description("Confirm a task has reached status=done (read-only; emits nothing)").option("--feature <name>", "Feature whose task to confirm").option("--feature-dir <path>", "Override default .loaf/<feature> directory").action(async (taskId, opts) => {
		if (rejectIfDryRun("tasks complete")) return;
		const featureDir = await dispatchOrFail(opts);
		if (featureDir === null) return;
		const session = await loadSession(featureDir, { ensureDir: !ctx.dryRun });
		if (!session.snapshot.state) {
			emitNoSessionFailure(FAILURE_SITE_KEYS.noSessionTasks, opts.feature);
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
		ctx.success(out, (i18n) => i18n.t(CHROME_KEYS.tasksCompleteText, {
			task_id: taskId,
			status: formatTaskStatus(i18n, "done")
		}) + "\n");
	});
	tasksCmd.command("amend <task-id>").description("Amend a task: --policy <step>=<applicability> (EXECUTE.plan) or --input <file> --finding <FND-N> (sponsored, EXECUTE.work)").option("--feature <name>", "Feature whose task to amend").option("--feature-dir <path>", "Override default .loaf/<feature> directory").option("--policy <step=applicability>", "Step applicability override (must|optional|na); repeatable", (val, acc) => [...acc, val], []).option("--input <file>", "New id-less task definition for a sponsored graph replacement (JSON file or '-')").option("--finding <FND-N>", "Sponsoring amend-tasks finding (required with --input)").action(async (taskId, opts) => {
		if (await dispatchOrFail(opts) === null) return;
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
			const inTask = TaskInput$1.safeParse(inParsed);
			if (!inTask.success) {
				ctx.failure("SCHEMA_VALIDATION_FAILED", `tasks amend --input is not a valid id-less task (omit id / status / execution): ${inTask.error.issues.map((i) => i.message).join("; ")}`, { issues: inTask.error.issues });
				return;
			}
			const sFeatureDir = opts.featureDir ?? defaultFeatureDir(opts.feature);
			const sSession = await ctx.resolveSession(sFeatureDir);
			if (!sSession.snapshot.state) {
				emitNoSessionFailure(FAILURE_SITE_KEYS.noSessionTasks, opts.feature);
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
			const sResult = await runMutator(sFeatureDir, sSession, {
				kind: "event:tasks_amended",
				payload: {
					mode: "replace",
					task: materializeTaskForAmend(carryForwardStepProgress(sNewGraph, sCanonical), sCurrent),
					sponsored_by_finding_id: findingId
				},
				actor
			}, "raw-ctx-failure");
			if (!sResult) return;
			const sOut = {
				ok: true,
				feature: opts.feature,
				task_id: taskId,
				sponsored_by_finding_id: findingId,
				sub_state: sResult.snapshot.state?.sub_state
			};
			ctx.success(sOut, (i18n) => i18n.t(SUCCESS_KEYS.amendSponsoredText, {
				task_id: taskId,
				finding_id: findingId
			}) + "\n", (i18n) => ({ stateChange: i18n.t(SUCCESS_KEYS.amendStateChange, { task_id: taskId }) }));
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
		const featureDir = await dispatchOrFail(opts);
		if (featureDir === null) return;
		const session = await loadSession(featureDir, { ensureDir: !ctx.dryRun });
		if (!session.snapshot.state) {
			emitNoSessionFailure(FAILURE_SITE_KEYS.noSessionTasks, opts.feature);
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
		const result = await runMutator(featureDir, session, {
			kind: "event:tasks_amended",
			payload: {
				mode: "replace",
				task: materialized
			},
			actor
		});
		if (!result) return;
		const applied = [...policyMap].map(([s, a]) => `${s}=${a}`).join(", ");
		const out = {
			ok: true,
			feature: opts.feature,
			task_id: taskId,
			policy: Object.fromEntries(policyMap),
			sub_state: result.snapshot.state?.sub_state
		};
		ctx.success(out, (i18n) => i18n.t(SUCCESS_KEYS.amendPolicyText, {
			task_id: taskId,
			applied
		}) + "\n", (i18n) => ({ stateChange: i18n.t(SUCCESS_KEYS.amendStateChange, { task_id: taskId }) }));
	});
	tasksCmd.command("register-red <task-id>").description("Register the RED test for a claimed behavioral bug task (EXECUTE.work)").option("--feature <name>", "Feature whose task to register").option("--feature-dir <path>", "Override default .loaf/<feature> directory").action(async (taskId, opts) => {
		const featureDir = await dispatchOrFail(opts);
		if (featureDir === null) return;
		const session = await loadSession(featureDir, { ensureDir: !ctx.dryRun });
		if (!session.snapshot.state) {
			emitNoSessionFailure(FAILURE_SITE_KEYS.noSessionTasks, opts.feature);
			return;
		}
		const result = await runMutator(featureDir, session, {
			kind: "event:task_step_done",
			payload: {
				task_id: taskId,
				step: "red",
				result: "passed",
				red_test_registered: true
			},
			actor
		});
		if (!result) return;
		const out = {
			ok: true,
			feature: opts.feature,
			task_id: taskId,
			red_test_registered: true,
			sub_state: result.snapshot.state?.sub_state
		};
		ctx.success(out, () => "", (i18n) => ({ stateChange: i18n.t(SUCCESS_KEYS.tasksRegisterRedStateChange, { task_id: taskId }) }));
	});
	const stepCmd = tasksCmd.command("step").description("Task step lifecycle (start / done)");
	stepCmd.command("start").description("Mark a task step as running (task must be claimed)").requiredOption("--task <task-id>", "Task whose step to start").requiredOption("--step <step-name>", "Step name (kind-specific; see spec)").option("--feature <name>", "Feature whose task lifecycle to advance").option("--feature-dir <path>", "Override default .loaf/<feature> directory").action(async (opts) => {
		const featureDir = await dispatchOrFail(opts);
		if (featureDir === null) return;
		const session = await loadSession(featureDir, { ensureDir: !ctx.dryRun });
		if (!session.snapshot.state) {
			emitNoSessionFailure(FAILURE_SITE_KEYS.noSessionTasks, opts.feature);
			return;
		}
		const result = await runMutator(featureDir, session, {
			kind: "event:task_step_started",
			payload: {
				task_id: opts.task,
				step: opts.step
			},
			actor
		});
		if (!result) return;
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
		ctx.success(out, () => "", (i18n) => ({ stateChange: i18n.t(SUCCESS_KEYS.stepStartStateChange, {
			task_id: opts.task,
			step: opts.step
		}) }));
	});
	stepCmd.command("done").description("Mark a task step as done (--result passed|failed|waived|na; default passed)").requiredOption("--task <task-id>", "Task whose step to mark done").requiredOption("--step <step-name>", "Step name (kind-specific)").option("--result <r>", "Step result: passed (default) | failed | waived | na", "passed").option("--evidence-kind <kind>", "Evidence kind (closed EvidenceKind enum)").option("--evidence-result <r>", "Evidence result (passed | failed | approved | rejected | waived)").option("--evidence-summary <text>", "Evidence summary (≥3 chars)").option("--evidence-covers <csv>", "Comma-separated REQ/SCEN/VIS/Task ids covered by this evidence").option("--evidence-check <kind>", "Verify-check kind (run | review | acceptance | visual)").option("--evidence-reason <text>", "Evidence reason (manual/waiver require ≥10 chars)").option("--evidence-actor <actor>", "Override evidence actor (default: cli:loaf; required human:* for manual/waiver)").option("--feature <name>", "Feature whose task lifecycle to advance").option("--feature-dir <path>", "Override default .loaf/<feature> directory").action(async (opts) => {
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
		const featureDir = await dispatchOrFail(opts);
		if (featureDir === null) return;
		const session = await loadSession(featureDir, { ensureDir: !ctx.dryRun });
		if (!session.snapshot.state) {
			emitNoSessionFailure(FAILURE_SITE_KEYS.noSessionTasks, opts.feature);
			return;
		}
		const stepDoneEntry = {
			kind: "event:task_step_done",
			payload: {
				task_id: opts.task,
				step: opts.step,
				result: opts.result
			},
			actor
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
			result = await runMutator(featureDir, session, [stepDoneEntry, {
				kind: "evidence:added",
				payload: evidencePayload,
				actor
			}]);
		} else result = await runMutator(featureDir, session, stepDoneEntry);
		if (!result) return;
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
		ctx.success(out, (i18n) => {
			const promoteSuffix = updated.status === "done" ? i18n.t(SUCCESS_KEYS.stepDonePromoteSuffix) : "";
			const evidenceSuffix = evidenceId !== void 0 ? i18n.t(SUCCESS_KEYS.stepDoneEvidenceSuffix, { evidence_id: evidenceId }) : "";
			return i18n.t(SUCCESS_KEYS.stepDoneText, {
				task_id: opts.task,
				step: opts.step,
				result: opts.result,
				evidence_suffix: evidenceSuffix,
				promote_suffix: promoteSuffix
			}) + "\n";
		}, (i18n) => ({ stateChange: i18n.t(SUCCESS_KEYS.stepDoneStateChange, {
			task_id: opts.task,
			step: opts.step,
			result: opts.result
		}) }));
	});
	program.command("settle").description("Advance VERIFY.accept → SETTLE.reconcile (deep ceremony only)").option("--feature <name>", "Feature whose session to settle").option("--feature-dir <path>", "Override default .loaf/<feature> directory").action(async (opts) => {
		const featureDir = await dispatchOrFail(opts);
		if (featureDir === null) return;
		const session = await loadSession(featureDir, { ensureDir: !ctx.dryRun });
		const from = session.snapshot.state?.sub_state;
		if (!from) {
			emitNoSessionFailure(FAILURE_SITE_KEYS.noSessionGeneric, opts.feature);
			return;
		}
		const result = await runMutator(featureDir, session, {
			kind: "event:phase_advanced",
			payload: {
				from,
				to: "SETTLE.reconcile"
			},
			actor
		});
		if (!result) return;
		const out = {
			ok: true,
			feature: opts.feature,
			from,
			to: "SETTLE.reconcile",
			sub_state: result.snapshot.state?.sub_state,
			advisory: ["complete SETTLE.* phase (loaf advance SETTLE.lessons) then `loaf deliver`"]
		};
		ctx.success(out, (i18n) => i18n.t(SUCCESS_KEYS.settleText), (i18n) => ({
			stateChange: i18n.t(SUCCESS_KEYS.settleStateChange, { from }),
			next: i18n.t(SUCCESS_KEYS.nextDeliver)
		}));
	});
	program.command("resume").description("Resume session from snapshots/resume-pack.json (emits session:resumed journal entry)").option("--feature <name>", "Feature whose resume pack to consume").option("--feature-dir <path>", "Override default .loaf/<feature> directory").action(async (opts) => {
		const featureDir = await dispatchOrFail(opts);
		if (featureDir === null) return;
		const session = await loadSession(featureDir, { ensureDir: false });
		if (!session.snapshot.state) {
			emitNoSessionFailure(FAILURE_SITE_KEYS.noSessionGeneric, opts.feature);
			return;
		}
		const packPath = path.join(featureDir, "snapshots", "resume-pack.json");
		let raw;
		try {
			raw = await promises.readFile(packPath, "utf8");
		} catch (err) {
			if (err.code === "ENOENT") {
				emitFailure("INPUT_FILE_NOT_FOUND", `resume pack not found at ${packPath}; run \`loaf handoff --reason "..."\` first to create one`, { path: packPath });
				return;
			}
			throw err;
		}
		let parsedPack;
		try {
			parsedPack = JSON.parse(raw);
		} catch (err) {
			emitFailure("SCHEMA_VALIDATION_FAILED", `resume pack at ${packPath} is not valid JSON: ${err.message}`, {
				subcode: "invalid-json",
				path: packPath
			});
			return;
		}
		const packParse = ResumePack.safeParse(parsedPack);
		if (!packParse.success) {
			emitFailure("SCHEMA_VALIDATION_FAILED", `resume pack at ${packPath} failed ResumePack schema validation`, {
				subcode: "zod",
				path: packPath,
				issues: packParse.error.issues
			});
			return;
		}
		const pack = packParse.data;
		const actor = `cli:loaf@${process.env["USER"] ?? "unknown"}`;
		const result = await runMutator(featureDir, session, {
			kind: "session:resumed",
			payload: { resumed_from_pack: {
				at: pack.at,
				reason: pack.reason,
				session_id: pack.session_id
			} },
			actor
		});
		if (!result) return;
		ctx.success({
			ok: true,
			feature: opts.feature,
			session_id: pack.session_id,
			sub_state: result.snapshot.state?.sub_state
		}, () => `${pack.session_id}\n`, (i18n) => ({ stateChange: i18n.t(SUCCESS_KEYS.resumeStateChange, {
			session_id: pack.session_id,
			sub_state: result.snapshot.state?.sub_state
		}) }));
	});
	program.command("handoff").description("Compose and persist snapshots/resume-pack.json (read-side projection writer; no journal entry)").requiredOption("--reason <text>", "Why this handoff is being taken (≥5 chars; mandatory per ResumePack.reason)").option("--notes <text>", "Optional free-form notes attached to the pack").option("--feature <name>", "Feature whose handoff to take").option("--feature-dir <path>", "Override default .loaf/<feature> directory").action(async (opts) => {
		if (rejectIfDryRun("handoff", "projection-writer")) return;
		if (opts.reason.length < 5) {
			ctx.failureKeyed("USAGE", FAILURE_SITE_KEYS.handoffReasonTooShort, {
				min_length: 5,
				reason_length: opts.reason.length
			}, {
				min_length: 5,
				reason_length: opts.reason.length
			});
			return;
		}
		const resolution = resolveHumanActor({
			env: process.env,
			readGitConfig: readGitConfigForActor,
			isInteractiveHuman: isInteractiveHumanForActor()
		});
		if (!resolution.ok) {
			emitFailure(resolution.code, resolution.message);
			return;
		}
		const featureDir = await dispatchOrFail(opts);
		if (featureDir === null) return;
		const session = await loadSession(featureDir, { ensureDir: false });
		if (!session.snapshot.state) {
			emitNoSessionFailure(FAILURE_SITE_KEYS.noSessionGeneric, opts.feature);
			return;
		}
		const pack = buildResumePack({
			snapshot: session.snapshot,
			entries: session.entries,
			at: (/* @__PURE__ */ new Date()).toISOString(),
			reason: opts.reason,
			...opts.notes !== void 0 && { notes: opts.notes }
		});
		const parse = ResumePack.safeParse(pack);
		if (!parse.success) {
			ctx.failureKeyed("SCHEMA_VALIDATION_FAILED", FAILURE_SITE_KEYS.handoffPackValidationFailed, {}, {
				subcode: "zod",
				issues: parse.error.issues
			});
			return;
		}
		const snapshotsDir = path.join(featureDir, "snapshots");
		await promises.mkdir(snapshotsDir, { recursive: true });
		const packPath = path.join(snapshotsDir, "resume-pack.json");
		const tmpPath = packPath + ".tmp";
		await promises.writeFile(tmpPath, JSON.stringify(pack, null, 2) + "\n");
		await promises.rename(tmpPath, packPath);
		ctx.success({
			ok: true,
			feature: opts.feature,
			pack_path: packPath,
			session_id: pack.session_id
		}, () => `${packPath}\n`, (i18n) => ({ stateChange: i18n.t(SUCCESS_KEYS.handoffStateChange, { actor: resolution.actor }) }));
	});
	const pendingCmd = program.command("pending").description("Pending queue commands (raise / list / status / resolve)");
	pendingCmd.command("raise").description("Raise a new pending entry (CLI allocates PEND-id)").requiredOption("--kind <kind>", "Pending kind (ask_user_question | gate_decision | spec_clarification | finding_decision | profile_escalation)").requiredOption("--question <text>", "Question / rationale shown to whoever resolves it (required for ALL kinds)").option("--options <csv>", "Comma-separated answer options (passthrough)").option("--task-id <id>", "Optional task association (passthrough)").option("--feature <name>", "Feature whose session to raise pending against").option("--feature-dir <path>", "Override default .loaf/<feature> directory").action(async (opts) => {
		const featureDir = await dispatchOrFail(opts);
		if (featureDir === null) return;
		const session = await loadSession(featureDir, { ensureDir: !ctx.dryRun });
		if (!session.snapshot.state) {
			emitNoSessionFailure(FAILURE_SITE_KEYS.noSessionPending, opts.feature);
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
		if (!await runMutator(featureDir, session, {
			kind: "pending:added",
			payload,
			actor
		})) return;
		ctx.success({
			ok: true,
			feature: opts.feature,
			id,
			kind: opts.kind
		}, () => id + "\n", (i18n) => ({ stateChange: i18n.t(SUCCESS_KEYS.pendingRaiseStateChange, {
			pending_id: id,
			kind: opts.kind
		}) }));
	});
	pendingCmd.command("list").description("List pending entries (FIFO; first unresolved is head)").option("--feature <name>", "Feature whose pending to list").option("--feature-dir <path>", "Override default .loaf/<feature> directory").action(async (opts) => {
		if (rejectIfDryRun("pending list")) return;
		const featureDir = await dispatchOrFail(opts);
		if (featureDir === null) return;
		const loaded = await loadProjectionsOrFail(featureDir, ["pending"], opts.feature, FAILURE_SITE_KEYS.noSessionPending);
		if (loaded === null) return;
		const entries = loaded.pending.pending;
		const headIdx = entries.findIndex((p) => !p.resolved);
		const rows = entries.map((p, i) => ({
			id: p.pending_id,
			kind: p.kind,
			resolved: p.resolved,
			head: i === headIdx
		}));
		ctx.success({
			ok: true,
			feature: opts.feature,
			count: rows.length,
			pending: rows
		}, (i18n) => rows.map((r) => i18n.t(CHROME_KEYS.pendingListRow, {
			pending_id: r.id,
			kind: formatPendingKind(i18n, r.kind),
			status: i18n.t(r.resolved ? CHROME_KEYS.pendingResolved : CHROME_KEYS.pendingOpen),
			head: i18n.t(r.head ? CHROME_KEYS.pendingHead : CHROME_KEYS.pendingNonHead)
		}) + "\n").join(""));
	});
	pendingCmd.command("status").description("Status of head pending entry (default) or specific entry by --id").option("--feature <name>", "Feature whose pending to inspect").option("--id <id>", "Lookup a specific PEND-id (default: head)").option("--feature-dir <path>", "Override default .loaf/<feature> directory").action(async (opts) => {
		if (rejectIfDryRun("pending status")) return;
		const featureDir = await dispatchOrFail(opts);
		if (featureDir === null) return;
		const session = await loadSession(featureDir, { ensureDir: !ctx.dryRun });
		if (!session.snapshot.state) {
			emitNoSessionFailure(FAILURE_SITE_KEYS.noSessionPending, opts.feature);
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
		ctx.success({
			ok: true,
			feature: opts.feature,
			pending: target
		}, (i18n) => {
			if (target === null) return i18n.t(CHROME_KEYS.pendingStatusNoOpen) + "\n";
			return i18n.t(CHROME_KEYS.pendingListRow, {
				pending_id: target.id,
				kind: formatPendingKind(i18n, target.kind),
				status: i18n.t(target.resolved ? CHROME_KEYS.pendingResolved : CHROME_KEYS.pendingOpen),
				head: i18n.t(target.head ? CHROME_KEYS.pendingHead : CHROME_KEYS.pendingNonHead)
			}) + "\n";
		});
	});
	pendingCmd.command("resolve").description("Resolve the head pending entry (strict FIFO; no --id flag)").requiredOption("--answer <text>", "Resolution answer (passthrough into pending:resolved payload)").option("--feature <name>", "Feature whose pending to resolve").option("--feature-dir <path>", "Override default .loaf/<feature> directory").action(async (opts) => {
		const featureDir = await dispatchOrFail(opts);
		if (featureDir === null) return;
		const session = await loadSession(featureDir, { ensureDir: !ctx.dryRun });
		if (!session.snapshot.state) {
			emitNoSessionFailure(FAILURE_SITE_KEYS.noSessionPending, opts.feature);
			return;
		}
		const head = session.snapshot.pending.find((p) => !p.resolved);
		if (!head) {
			emitFailure("PENDING_NOT_FOUND", "pending:resolved called but the queue has no unresolved head");
			return;
		}
		if (!await runMutator(featureDir, session, {
			kind: "pending:resolved",
			payload: {
				id: head.id,
				answer: opts.answer
			},
			actor
		})) return;
		ctx.success({
			ok: true,
			feature: opts.feature,
			resolved_id: head.id,
			kind: head.kind
		}, (i18n) => i18n.t(SUCCESS_KEYS.pendingResolveText, {
			pending_id: head.id,
			kind: head.kind
		}) + "\n", (i18n) => ({ stateChange: i18n.t(SUCCESS_KEYS.pendingResolveStateChange, { pending_id: head.id }) }));
	});
	const evidenceCmd = program.command("evidence").description("Evidence ledger commands (Slice 3 SC2 MVP: add)");
	evidenceCmd.command("add").description("Append evidence entry/entries from --input <src> JSON (CLI allocates EV-id; single object or non-empty array for batch)").option("--input <src>", "JSON source for EvidenceAddInput (single object OR non-empty array for batch): `-` (stdin), inline JSON, or file path (protocol §10.7)").option("--schema", "Dump the input JSON Schema instead of mutating (Phase 16 SC-10)").option("--feature <name>", "Feature whose ledger to append to").option("--feature-dir <path>", "Override default .loaf/<feature> directory").action(async (rawOpts) => {
		if (rawOpts.schema === true) {
			if (rejectIfDryRun("evidence add --schema")) return;
			emitMutatorSchemaAndExit("evidence:add");
			return;
		}
		if (rawOpts.input === void 0) {
			emitFailure("MISSING_INPUT", "loaf evidence add requires --input <src> (or pass --schema to dump the input JSON Schema)");
			return;
		}
		const opts = rawOpts;
		if (await dispatchOrFail(opts) === null) return;
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
			const p = EvidenceAddInput$1.safeParse(raw);
			if (!p.success) {
				ctx.failure("SCHEMA_VALIDATION_FAILED", `evidence add input[${i}] failed schema validation: ${p.error.issues.map((iss) => iss.message).join("; ")}`, {
					index: i,
					issues: p.error.issues
				});
				return;
			}
			validatedInputs.push(p.data);
		}
		const featureDir = await dispatchOrFail(opts);
		if (featureDir === null) return;
		const session = await ctx.resolveSession(featureDir);
		if (!session.snapshot.state) {
			emitNoSessionFailure(FAILURE_SITE_KEYS.noSessionGeneric, opts.feature);
			return;
		}
		const evIds = allocateNextEvidenceIds(session.snapshot, validatedInputs.length);
		const result = await runMutator(featureDir, session, validatedInputs.map((input, i) => ({
			kind: "evidence:added",
			payload: {
				...input,
				id: evIds[i]
			},
			actor
		})), "raw-ctx-failure");
		if (!result) return;
		const isBatch = Array.isArray(parsed);
		const evidenceItems = validatedInputs.map((input, i) => ({
			id: evIds[i],
			kind: input.kind,
			covers: input.covers
		}));
		if (isBatch) ctx.success({
			ok: true,
			feature: opts.feature,
			ev_ids: evIds,
			count: evIds.length,
			sub_state: result.snapshot.state?.sub_state
		}, () => evIds.join("\n") + "\n", (i18n) => ({ stateChange: evidenceAddStateChange(i18n, evidenceItems) }));
		else ctx.success({
			ok: true,
			feature: opts.feature,
			id: evIds[0],
			kind: validatedInputs[0].kind
		}, () => `${evIds[0]}\n`, (i18n) => ({ stateChange: evidenceAddStateChange(i18n, evidenceItems) }));
	});
	program.command("waive <obligation-id>").description("Record a waiver evidence (kind=waiver) against an obligation id (REQ-/SCEN-/VIS-/T-)").requiredOption("--reason <text>", "Waiver rationale (≥10 chars; mandatory per evidence schema refine)").option("--feature <name>", "Feature whose ledger to append to").option("--feature-dir <path>", "Override default .loaf/<feature> directory").action(async (obligationId, opts) => {
		if (!CoversRefPayload.safeParse(obligationId).success) {
			emitFailure("USAGE", `invalid obligation id '${obligationId}' — expected REQ-NS-NNN / SCEN-NS-NNN / VIS-NS-NNN / T-NNN form`, { argument: obligationId });
			return;
		}
		if (opts.reason.length < 10) {
			ctx.failureKeyed("USAGE", FAILURE_SITE_KEYS.lessonsReasonTooShort, {
				min_length: 10,
				reason_length: opts.reason.length
			}, {
				min_length: 10,
				reason_length: opts.reason.length
			});
			return;
		}
		const resolution = resolveHumanActor({
			env: process.env,
			readGitConfig: readGitConfigForActor,
			isInteractiveHuman: isInteractiveHumanForActor()
		});
		if (!resolution.ok) {
			emitFailure(resolution.code, resolution.message);
			return;
		}
		const actor = resolution.actor;
		const featureDir = await dispatchOrFail(opts);
		if (featureDir === null) return;
		const session = await loadSession(featureDir, { ensureDir: !ctx.dryRun });
		if (!session.snapshot.state) {
			emitNoSessionFailure(FAILURE_SITE_KEYS.noSessionGeneric, opts.feature);
			return;
		}
		const evidenceId = allocateNextEvidenceId(session.snapshot);
		if (!await runMutator(featureDir, session, {
			kind: "evidence:added",
			payload: buildWaiveEvidencePayload({
				evidenceId,
				obligationId,
				reason: opts.reason,
				actor,
				iteration: session.snapshot.state.iteration
			}),
			actor
		})) return;
		ctx.success({
			ok: true,
			feature: opts.feature,
			id: evidenceId,
			kind: "waiver",
			obligation_id: obligationId
		}, () => `${evidenceId}\n`, (i18n) => ({ stateChange: i18n.t(SUCCESS_KEYS.waiveStateChange, {
			evidence_id: evidenceId,
			obligation_id: obligationId
		}) }));
	});
	program.command("lessons").description("Lessons-learned evidence commands (Phase 16 SC-11: add)").command("add").description("Record a lessons-learned evidence entry (kind=manual; --text inline OR --file <path>)").option("--text <inline>", "Lesson body text (inline). Mutex with --file.").option("--file <path>", "Read lesson body from file. Mutex with --text.").requiredOption("--reason <text>", "Why this lesson matters (≥10 chars; mandatory per evidence schema refine)").option("--feature <name>", "Feature whose ledger to append to").option("--feature-dir <path>", "Override default .loaf/<feature> directory").action(async (opts) => {
		const hasText = opts.text !== void 0;
		const hasFile = opts.file !== void 0;
		if (hasText === hasFile) {
			ctx.failureKeyed("USAGE", FAILURE_SITE_KEYS.lessonsTextFileMutex, { provided_state: hasText ? "both provided" : "neither provided" }, {
				text_provided: hasText,
				file_provided: hasFile
			});
			return;
		}
		let lessonText;
		if (hasText) lessonText = opts.text;
		else try {
			lessonText = await promises.readFile(opts.file, "utf8");
		} catch (err) {
			if (err.code === "ENOENT") {
				ctx.failureKeyed("INPUT_FILE_NOT_FOUND", FAILURE_SITE_KEYS.lessonsFileMissing, { path: opts.file }, { path: opts.file });
				return;
			}
			throw err;
		}
		if (lessonText.length < 3) {
			ctx.failureKeyed("USAGE", FAILURE_SITE_KEYS.lessonsTextTooShort, {
				min_length: 3,
				lesson_text_length: lessonText.length
			}, {
				min_length: 3,
				lesson_text_length: lessonText.length
			});
			return;
		}
		if (opts.reason.length < 10) {
			ctx.failureKeyed("USAGE", FAILURE_SITE_KEYS.lessonsReasonTooShort, {
				min_length: 10,
				reason_length: opts.reason.length
			}, {
				min_length: 10,
				reason_length: opts.reason.length
			});
			return;
		}
		const resolution = resolveHumanActor({
			env: process.env,
			readGitConfig: readGitConfigForActor,
			isInteractiveHuman: isInteractiveHumanForActor()
		});
		if (!resolution.ok) {
			emitFailure(resolution.code, resolution.message);
			return;
		}
		const actor = resolution.actor;
		const featureDir = await dispatchOrFail(opts);
		if (featureDir === null) return;
		const session = await loadSession(featureDir, { ensureDir: !ctx.dryRun });
		if (!session.snapshot.state) {
			emitNoSessionFailure(FAILURE_SITE_KEYS.noSessionGeneric, opts.feature);
			return;
		}
		const evidenceId = allocateNextEvidenceId(session.snapshot);
		if (!await runMutator(featureDir, session, {
			kind: "evidence:added",
			payload: buildLessonsEvidencePayload({
				evidenceId,
				lessonText,
				reason: opts.reason,
				actor,
				iteration: session.snapshot.state.iteration
			}),
			actor
		})) return;
		ctx.success({
			ok: true,
			feature: opts.feature,
			id: evidenceId,
			kind: "manual"
		}, () => `${evidenceId}\n`, (i18n) => ({ stateChange: i18n.t(SUCCESS_KEYS.lessonsAddStateChange, { evidence_id: evidenceId }) }));
	});
	program.command("hook <event>").description("Claude Code hook entry point (session-start + closure-check read-side; write-guard + scope-track land SC-15c)").option("--list-events", "Dump the canonical 4-event enum (handled by pre-parse guard)").option("--feature <name>", "Feature whose session to read (read-side events)").option("--feature-dir <path>", "Override default .loaf/<feature> directory").option("--session <uuid>", "Resolve session by registry UUID (read-side events)").option("--path <text>", "Tool target path (for write-guard / scope-track; SC-15c)").action(async (event, opts) => {
		if (event === "session-start") {
			const d = await dispatchForHookOptional(opts);
			if ("skip" in d) return;
			let loaded;
			try {
				loaded = await loadProjections({
					feature_dir: d.featureDir,
					kinds: [
						"state",
						"findings",
						"pending"
					]
				});
			} catch {
				return;
			}
			const additionalContext = composeSessionStartContext({
				sub_state: loaded.state.sub_state,
				iteration: loaded.state.iteration,
				open_findings: loaded.findings.findings.filter((f) => f.status === "open"),
				pending: loaded.state.pending
			});
			process.stdout.write(JSON.stringify(sessionStartHookOutput(additionalContext)) + "\n");
			return;
		}
		if (event === "closure-check") {
			const d = await dispatchForHookOptional(opts);
			if ("skip" in d) {
				if (d.stale) process.stderr.write(`warning: closure-check skipped — ${d.stale.message}\n`);
				return;
			}
			let loaded;
			try {
				loaded = await loadProjections({
					feature_dir: d.featureDir,
					kinds: [
						"state",
						"tasks",
						"evidence",
						"findings"
					]
				});
			} catch (err) {
				if (err instanceof SnapshotStaleError) {
					process.stderr.write(`warning: closure-check skipped — ${err.message}\n`);
					return;
				}
				if (err instanceof NoSessionError) return;
				process.stderr.write(`warning: closure-check skipped — ${err.message}\n`);
				return;
			}
			const warnings = runClosureWarnings({
				state: loaded.state,
				tasks: loaded.tasks,
				evidence: loaded.evidence,
				findings: loaded.findings
			});
			for (const w of warnings) process.stderr.write(`warning: ${w}\n`);
			return;
		}
		if (event === "scope-track") {
			if (await resolveHookPath(opts) === null) return;
			return;
		}
		const target = await resolveHookPath(opts);
		if (target === null) return;
		const wd = await resolveDispatchForWriteGuard(opts);
		if ("allow" in wd) return;
		if ("failClosed" in wd) {
			emitFailure(wd.code, `write-guard blocked: ${wd.message}`, { reason: wd.message });
			return;
		}
		const repoRoot = path.dirname(path.dirname(wd.featureDir));
		const feature = opts.feature;
		const cfg = await readLoafConfig(repoRoot);
		if (cfg.status === "invalid") {
			ctx.failureKeyed("SCHEMA_VALIDATION_FAILED", FAILURE_SITE_KEYS.writeGuardConfigInvalid, { reason: cfg.reason }, {
				source: "loaf.config.json",
				reason: cfg.reason
			});
			return;
		}
		const config = cfg.status === "ok" ? cfg.config : null;
		let loaded;
		try {
			loaded = await loadProjections({
				feature_dir: wd.featureDir,
				kinds: ["state", "tasks"]
			});
		} catch (err) {
			emitFailure(err instanceof SnapshotStaleError ? err.code : "SNAPSHOT_STALE_REBUILD_REQUIRED", `write-guard blocked: ${err.message}`, { reason: err.message });
			return;
		}
		const { state, tasks } = loaded;
		const builtinGlobs = [...SUB_STATE_CONTRACT_BY_STATE[state.sub_state]?.write_paths ?? []];
		const activeCategories = /* @__PURE__ */ new Set();
		for (const task of tasks?.tasks ?? []) {
			if (task.status !== "in_progress") continue;
			const execution = task.execution ?? {};
			for (const [step, st] of Object.entries(execution)) if (st?.status === "running") {
				for (const g of stepWritePaths(task.kind, step)) builtinGlobs.push(g);
				for (const c of stepWriteCategories(task.kind, step)) activeCategories.add(c);
			}
		}
		const [phase, sub] = state.sub_state.split(".");
		if (phase === "VERIFY" && [
			"run",
			"review",
			"acceptance",
			"visual"
		].includes(sub)) {
			const check = sub;
			for (const g of VERIFY_CHECK_WRITE_PATHS[check]) builtinGlobs.push(g);
			for (const c of VERIFY_CHECK_WRITE_CATEGORIES[check]) activeCategories.add(c);
		}
		const decision = evaluateWritePath({
			targetPath: target,
			repoRoot,
			feature,
			subState: state.sub_state,
			builtinGlobs,
			activeCategories: [...activeCategories],
			config
		});
		if (decision.allowed) return;
		if (decision.code === "PROTECTED_FILE_WRITE") {
			emitFailure("PROTECTED_FILE_WRITE", `write blocked: \`${decision.normalizedPath}\` matches protected_files entry \`${decision.matchedDeny}\` — protected files are never writable`, {
				path: target,
				normalized_path: decision.normalizedPath,
				matched_deny: decision.matchedDeny
			});
			return;
		}
		emitFailure("WRITE_PATH_VIOLATION", `write blocked: \`${decision.normalizedPath}\` is outside the allowed write paths for sub_state \`${state.sub_state}\``, {
			path: target,
			normalized_path: decision.normalizedPath,
			sub_state: state.sub_state,
			allow_set: decision.allowSet.slice(0, 30)
		});
	});
	const renderTuiImpl = deps.renderTui ?? defaultRenderTui;
	const isStdoutTtyForTui = deps.isStdoutTty ?? (() => process.stdout.isTTY === true);
	program.command("tui").description("Interactive session manager TUI (Ink; read-only, MVP)").action(async () => {
		if (rejectIfDryRun("tui")) return;
		const stdinTty = isStdinTty();
		const stdoutTty = isStdoutTtyForTui();
		if (!stdinTty || !stdoutTty) {
			emitFailure("USAGE", "TUI requires an interactive terminal (stdin/stdout TTY)", {
				stdin_tty: stdinTty,
				stdout_tty: stdoutTty
			});
			return;
		}
		const loadRows = async () => {
			return (await listSessions(deps.registryDir !== void 0 ? { registryDir: deps.registryDir } : {})).rows;
		};
		const loadDetail = async (row) => {
			const featureDir = path.join(row.cwd, ".loaf", row.feature);
			try {
				return classifyDetailOutcome(row, {
					ok: true,
					loaded: await loadProjections({
						feature_dir: featureDir,
						kinds: DETAIL_PROJECTION_KINDS
					})
				}, /* @__PURE__ */ new Date(), i18n);
			} catch (error) {
				return classifyDetailOutcome(row, {
					ok: false,
					error
				}, /* @__PURE__ */ new Date(), i18n);
			}
		};
		await renderTuiImpl(createElement(App, {
			initialRows: await loadRows(),
			loadRows,
			loadDetail,
			i18n
		}));
	});
	program.command("sessions").description("Session registry commands (list)").command("list").description("List session registry entries (read-only; --in-cwd filters by current cwd)").option("--in-cwd", "Only list sessions whose registered cwd matches the current cwd").action(async (opts) => {
		if (rejectIfDryRun("sessions list")) return;
		const filterCwd = opts.inCwd ? await promises.realpath(process.cwd()).catch(() => process.cwd()) : void 0;
		const result = await listSessions({
			...deps.registryDir !== void 0 && { registryDir: deps.registryDir },
			...filterCwd !== void 0 && { filterCwd }
		});
		for (const w of result.warnings) {
			const actionKey = w.reason === "orphan-cwd" ? opts.inCwd ? CHROME_KEYS.sessionsActionFilteredOut : CHROME_KEYS.sessionsActionOrphanCwd : CHROME_KEYS.sessionsActionSkipped;
			ctx.advisory(i18n.t(CHROME_KEYS.sessionsWarning, {
				file: w.file,
				action: i18n.t(actionKey),
				reason: w.reason,
				detail_suffix: w.detail ? `: ${w.detail}` : ""
			}));
		}
		const nowDate = deps.now?.() ?? /* @__PURE__ */ new Date();
		ctx.success({
			ok: true,
			count: result.rows.length,
			sessions: result.rows,
			warnings: result.warnings
		}, (textI18n) => {
			if (result.rows.length === 0) return textI18n.t(CHROME_KEYS.sessionsListEmpty) + "\n";
			const lines = [];
			const featureWidth = Math.max(...result.rows.map((r) => r.feature.length), 7);
			const stateWidth = Math.max(...result.rows.map((r) => formatPhaseSub(r, textI18n).length), 12);
			for (const row of result.rows) {
				const at = formatAtRelative(row.at, nowDate, textI18n);
				const state = formatPhaseSub(row, textI18n);
				lines.push(`${row.session_id_short}  ${row.feature.padEnd(featureWidth)}  ${state.padEnd(stateWidth)}  ${at}\n`);
			}
			return lines.join("");
		});
	});
	program.command("check <path>").description("Validate an artifact file against its schema (read-only; CI-friendly)").option("--kind <kind>", `Artifact kind (one of ${CHECK_KINDS.join("|")}); auto-detected from basename when omitted`).action(async (filePath, opts) => {
		if (rejectIfDryRun("check")) return;
		let kind;
		if (opts.kind !== void 0) {
			if (!CHECK_KINDS.includes(opts.kind)) {
				ctx.failureKeyed("USAGE", FAILURE_SITE_KEYS.checkKindInvalid, {
					value: opts.kind,
					allowed_kinds_human: CHECK_KINDS.join("|")
				}, {
					provided: opts.kind,
					value: opts.kind,
					allowed: CHECK_KINDS
				});
				return;
			}
			kind = opts.kind;
		}
		const result = await checkFile(kind === void 0 ? { path: filePath } : {
			path: filePath,
			kind
		});
		if (result.ok) {
			ctx.success(result, (i18n) => renderSuccessText(result, i18n));
			return;
		}
		if (result.code === "USAGE" && result.detail["suggestion"] !== void 0) {
			ctx.failureKeyed("USAGE", FAILURE_SITE_KEYS.checkKindRequired, {
				subject: String(result.detail["argument"] ?? filePath),
				kind: "tasks",
				suggestion: String(result.detail["suggestion"])
			}, result.detail);
			return;
		}
		if (result.code === "INPUT_FILE_NOT_FOUND") {
			ctx.failureKeyed("INPUT_FILE_NOT_FOUND", FAILURE_SITE_KEYS.checkPathMissing, { path: String(result.detail["path"] ?? filePath) }, result.detail);
			return;
		}
		if (result.code === "SCHEMA_VALIDATION_FAILED" && result.detail["kind"] !== void 0 && result.detail["path"] !== void 0 && result.detail["error_count"] !== void 0) {
			ctx.failureKeyed("SCHEMA_VALIDATION_FAILED", FAILURE_SITE_KEYS.schemaValidation, {
				kind: String(result.detail["kind"]),
				path: String(result.detail["path"]),
				error_count: String(result.detail["error_count"]),
				error_word: Number(result.detail["error_count"]) === 1 ? "error" : "errors"
			}, result.detail);
			return;
		}
		emitFailure(result.code, result.message, result.detail);
	});
	program.command("verify").description("Verify-accept gate read commands (status)").command("status").description("Show per-check verify-accept diagnostic (read-only)").option("--feature <name>", "Feature whose verify status to show").option("--feature-dir <path>", "Override default .loaf/<feature> directory").action(async (opts) => {
		if (rejectIfDryRun("verify status")) return;
		const featureDir = await dispatchOrFail(opts);
		if (featureDir === null) return;
		const diag = await evaluateVerifyAcceptDiagnostic((await loadSession(featureDir, { ensureDir: !ctx.dryRun })).snapshot, featureDir);
		if (!diag.ok) {
			emitFailure(diag.code, diag.message, diag.detail);
			return;
		}
		const env = buildEnvelope(diag.checks);
		ctx.success(env, (i18n) => renderText(env, i18n));
	});
	const findingCmd = program.command("finding").description("Finding ledger commands (Slice 3 SC3 MVP: raise / list / close)");
	findingCmd.command("raise").description("Raise a new finding (CLI allocates FND-id)").requiredOption("--category <category>", "Finding category (spec-gap | spec-defect | impl-defect | test-defect | new-scope | risk-escalation)").requiredOption("--action <action>", "Finding action (amend-spec | amend-tasks | fix-impl | fix-test | defer | backlog)").option("--summary <text>", "One-line finding summary (passthrough)").option("--reason <text>", "Justification (required ≥20 chars on unusual cells)").option("--target-task <task-id>", "Target task for fix-impl / fix-test / amend-tasks").option("--target-step <step>", "Target step (must equal action's canonical step)").option("--feature <name>", "Feature whose ledger to append to").option("--feature-dir <path>", "Override default .loaf/<feature> directory").action(async (opts) => {
		const hasTask = opts.targetTask !== void 0;
		const hasStep = opts.targetStep !== void 0;
		if (hasTask !== hasStep) {
			emitFailure("USAGE", "--target-task and --target-step must be specified together (or both omitted)");
			return;
		}
		const featureDir = await dispatchOrFail(opts);
		if (featureDir === null) return;
		const session = await loadSession(featureDir, { ensureDir: !ctx.dryRun });
		if (!session.snapshot.state) {
			emitNoSessionFailure(FAILURE_SITE_KEYS.noSessionFinding, opts.feature);
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
		const currentSubState = session.snapshot.state.sub_state;
		const findingBatch = buildFindingRaiseBatch({
			action: opts.action,
			findingPayload: payload,
			findingId: id,
			currentSubState,
			findingActor: actor,
			...hasTask && hasStep ? { target: { taskId: opts.targetTask } } : {}
		});
		if (findingBatch.kind === "none") {
			if (!await runMutator(featureDir, session, {
				kind: "finding:raised",
				payload,
				actor
			})) return;
			ctx.success({
				ok: true,
				feature: opts.feature,
				id,
				category: opts.category,
				action: opts.action
			}, () => id + "\n", { stateChange: `finding raise: ${id} (category=${opts.category}, action=${opts.action})` });
			return;
		}
		if (!await runMutator(featureDir, session, findingBatch.entries)) return;
		ctx.success({
			ok: true,
			feature: opts.feature,
			id,
			category: opts.category,
			action: opts.action,
			back_edge: {
				from: currentSubState,
				to: findingBatch.backEdgeTo
			}
		}, () => id + "\n", { stateChange: `finding raise: ${id} (category=${opts.category}, action=${opts.action}) — back-edge to ${findingBatch.backEdgeTo}` });
	});
	findingCmd.command("list").description("List findings (read-only; --status filters open|closed)").option("--feature <name>", "Feature whose findings to list").option("--status <s>", "Filter by status (open | closed)").option("--feature-dir <path>", "Override default .loaf/<feature> directory").action(async (opts) => {
		if (rejectIfDryRun("finding list")) return;
		if (opts.status !== void 0 && opts.status !== "open" && opts.status !== "closed") {
			ctx.failureKeyed("USAGE", FAILURE_SITE_KEYS.findingStatusInvalid, {
				allowed_statuses_human: "open | closed",
				value: opts.status
			}, {
				allowed: ["open", "closed"],
				value: opts.status
			});
			return;
		}
		const featureDir = await dispatchOrFail(opts);
		if (featureDir === null) return;
		const loaded = await loadProjectionsOrFail(featureDir, ["findings"], opts.feature, FAILURE_SITE_KEYS.noSessionFinding);
		if (loaded === null) return;
		const all = loaded.findings.findings;
		const rows = opts.status ? all.filter((f) => f.status === opts.status) : all;
		ctx.success({
			ok: true,
			feature: opts.feature,
			count: rows.length,
			findings: rows
		}, (i18n) => rows.map((r) => i18n.t(CHROME_KEYS.findingListRow, {
			finding_id: r.id,
			category: formatFindingCategory(i18n, r.category),
			action: formatFindingAction(i18n, r.action),
			status: formatFindingStatus(i18n, r.status)
		}) + "\n").join(""));
	});
	findingCmd.command("close <fnd-id>").description("Close a finding (emits finding:closed)").option("--feature <name>", "Feature whose ledger to close against").option("--feature-dir <path>", "Override default .loaf/<feature> directory").action(async (fndId, opts) => {
		const idParse = FindingId.safeParse(fndId);
		if (!idParse.success) {
			emitFailure("INVALID_PAYLOAD", `finding close id must match FindingId regex /^FND-\\d{3,}$/ (got ${fndId})`, {
				id: fndId,
				issues: idParse.error.issues
			});
			return;
		}
		const featureDir = await dispatchOrFail(opts);
		if (featureDir === null) return;
		const session = await loadSession(featureDir, { ensureDir: !ctx.dryRun });
		if (!session.snapshot.state) {
			emitNoSessionFailure(FAILURE_SITE_KEYS.noSessionFinding, opts.feature);
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
		if (!await runMutator(featureDir, session, {
			kind: "finding:closed",
			payload: { id: fndId },
			actor
		})) return;
		ctx.success({
			ok: true,
			feature: opts.feature,
			id: fndId,
			status: "closed"
		}, (i18n) => i18n.t(SUCCESS_KEYS.findingCloseText, { finding_id: fndId }) + "\n", (i18n) => ({ stateChange: i18n.t(SUCCESS_KEYS.findingCloseStateChange, { finding_id: fndId }) }));
	});
	const specCmd = program.command("spec").description("SPEC content commands (submit / add-req / add-scenario / add-visual; init in SC4)");
	specCmd.command("submit").description("Whole-replacement spec submit from JSON --input (CLI fills spec_version)").requiredOption("--input <src>", "JSON source: `-` (stdin), inline JSON literal, or file path (protocol §10.7)").option("--feature <name>", "Feature whose spec to submit").option("--feature-dir <path>", "Override default .loaf/<feature> directory").action(async (opts) => {
		if (await dispatchOrFail(opts) === null) return;
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
		const featureDir = await dispatchOrFail(opts);
		if (featureDir === null) return;
		const session = await ctx.resolveSession(featureDir);
		if (!session.snapshot.state) {
			emitNoSessionFailure(FAILURE_SITE_KEYS.noSessionGeneric, opts.feature);
			return;
		}
		const now = (/* @__PURE__ */ new Date()).toISOString();
		const result = finishMutate(await mutateBatch(buildSpecSubmitBatch({
			input,
			snapshot: session.snapshot,
			actor,
			now
		}), mctxFor(featureDir, session)), "raw-ctx-failure");
		if (!result) return;
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
		ctx.success(out, (i18n) => i18n.t(SUCCESS_KEYS.specSubmitText, {
			spec_version: out.spec_version,
			req_count: reqIds.length,
			scen_count: scenIds.length,
			vis_count: visIds.length
		}) + "\n", (i18n) => ({
			stateChange: i18n.t(SUCCESS_KEYS.specSubmitStateChange, { spec_version: out.spec_version }),
			next: i18n.t(SUCCESS_KEYS.specSubmitNext)
		}));
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
	function specAddTextKey(name, count) {
		if (name === "req") return count === 1 ? SUCCESS_KEYS.specAddReqTextOne : SUCCESS_KEYS.specAddReqTextMany;
		if (name === "scenario") return count === 1 ? SUCCESS_KEYS.specAddScenarioTextOne : SUCCESS_KEYS.specAddScenarioTextMany;
		return count === 1 ? SUCCESS_KEYS.specAddVisualTextOne : SUCCESS_KEYS.specAddVisualTextMany;
	}
	function specAddStateChangeKey(name, count) {
		if (name === "req") return count === 1 ? SUCCESS_KEYS.specAddReqStateChangeOne : SUCCESS_KEYS.specAddReqStateChangeMany;
		if (name === "scenario") return count === 1 ? SUCCESS_KEYS.specAddScenarioStateChangeOne : SUCCESS_KEYS.specAddScenarioStateChangeMany;
		return count === 1 ? SUCCESS_KEYS.specAddVisualStateChangeOne : SUCCESS_KEYS.specAddVisualStateChangeMany;
	}
	specCmd.command("init").description("Write a parser-valid minimal spec.md scaffold (no journal entry)").option("--feature <name>", "Feature whose spec.md to scaffold").option("--feature-dir <path>", "Override default .loaf/<feature> directory").option("--feature-id <id>", "Override feature.id in scaffold (default: F-XXX placeholder)").option("--feature-name <text>", "Override feature.name in scaffold (default: --feature value)").option("--intent <text>", "Override intent line in scaffold (default: TODO placeholder ≥20 chars)").action(async (opts) => {
		const featureDir = await dispatchOrFail(opts);
		if (featureDir === null) return;
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
		const scaffoldParse = SpecFrontmatter$1.safeParse(scaffoldObj);
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
		ctx.success({
			ok: true,
			feature: opts.feature,
			spec_md_path: specMdPath
		}, () => `${specMdPath}\n`, (i18n) => ({
			stateChange: i18n.t(SUCCESS_KEYS.specInitStateChange, { path: specMdPath }),
			next: i18n.t(SUCCESS_KEYS.specInitNext)
		}));
	});
	const runEditorImpl = deps.runEditor ?? runEditor;
	specCmd.command("edit").description("Launch $EDITOR on spec.md, validate, then emit event:spec_submitted (wrapping mutator; --dry-run rejected)").option("--feature <name>", "Feature whose spec.md to edit").option("--feature-dir <path>", "Override default .loaf/<feature> directory").action(async (opts) => {
		if (rejectIfDryRun("spec edit", "wrapping")) return;
		const featureDir = await dispatchOrFail(opts);
		if (featureDir === null) return;
		const resolution = resolveHumanActor({
			env: process.env,
			readGitConfig: readGitConfigForActor,
			isInteractiveHuman: isInteractiveHumanForActor()
		});
		if (!resolution.ok) {
			emitFailure(resolution.code, resolution.message);
			return;
		}
		const actor = resolution.actor;
		const session = await loadSession(featureDir, { ensureDir: false });
		if (!session.snapshot.state) {
			emitNoSessionFailure(FAILURE_SITE_KEYS.noSessionGeneric, opts.feature);
			return;
		}
		if (session.snapshot.state.spec_locked === true) {
			emitFailure("SPEC_LOCKED_NO_DIRECT_EDIT", `spec is locked; direct edits via \`loaf spec edit\` are rejected post-lock — use \`loaf finding raise --category spec-gap --action amend-spec --summary "..."\` to roll back to SPEC.spec and amend through the finding flow`, { kind: "event:spec_submitted" });
			return;
		}
		const specMdPath = path.join(featureDir, "spec.md");
		let beforeContent;
		try {
			beforeContent = await promises.readFile(specMdPath, "utf8");
		} catch (err) {
			if (err.code === "ENOENT") {
				emitFailure("SCHEMA_VALIDATION_FAILED", `spec.md not found at ${specMdPath}; run \`loaf spec init\` to scaffold one first`, {
					subcode: "spec-not-found",
					path: specMdPath
				});
				return;
			}
			throw err;
		}
		const editor = (process.env["EDITOR"] ?? "").trim() || "vi";
		const result = await runEditorImpl({
			filePath: specMdPath,
			editor,
			cwd: process.cwd(),
			env: process.env
		});
		if (result.error !== void 0) {
			emitFailure("USAGE", `editor '${editor}' could not be launched (${result.error})`, {
				editor,
				spawn_error: result.error
			});
			return;
		}
		if (result.signal !== null) {
			ctx.exitCode = 130;
			return;
		}
		if (result.code !== 0) {
			emitFailure("USAGE", `editor exited with code=${result.code}`, {
				editor,
				editor_exit: result.code
			});
			return;
		}
		let afterContent;
		try {
			afterContent = await promises.readFile(specMdPath, "utf8");
		} catch (err) {
			if (err.code === "ENOENT") {
				emitFailure("SCHEMA_VALIDATION_FAILED", `spec.md was deleted during edit at ${specMdPath}`, {
					subcode: "spec-not-found",
					path: specMdPath
				});
				return;
			}
			throw err;
		}
		if (beforeContent === afterContent) {
			ctx.success({
				ok: true,
				feature: opts.feature,
				no_op: true,
				spec_md_path: specMdPath
			}, () => "spec.md unchanged (no-op)\n");
			return;
		}
		const { frontmatter } = splitFrontmatter(afterContent);
		if (frontmatter === null) {
			emitFailure("SCHEMA_VALIDATION_FAILED", `spec.md is missing a YAML frontmatter block fenced by \`---\` on the first line; work copy preserved at ${specMdPath} for you to fix and re-run \`loaf spec edit\``, {
				subcode: "missing-frontmatter",
				path: specMdPath
			});
			return;
		}
		let parsedYaml;
		try {
			parsedYaml = parse(frontmatter);
		} catch (err) {
			emitFailure("SCHEMA_VALIDATION_FAILED", `spec.md frontmatter YAML failed to parse: ${err.message}; work copy preserved at ${specMdPath} for you to fix and re-run \`loaf spec edit\``, {
				subcode: "invalid-yaml",
				path: specMdPath
			});
			return;
		}
		const zodResult = SpecFrontmatter$1.safeParse(parsedYaml);
		if (!zodResult.success) {
			const issues = mapZodIssues(zodResult.error);
			emitFailure("SCHEMA_VALIDATION_FAILED", `spec.md frontmatter failed schema validation (${issues.error_count} errors); work copy preserved at ${specMdPath} for you to fix and re-run \`loaf spec edit\``, {
				subcode: "zod",
				path: specMdPath,
				errors: issues.errors,
				truncated: issues.truncated,
				error_count: issues.error_count
			});
			return;
		}
		const fm = zodResult.data;
		const submitParse = SpecSubmitInput.safeParse({
			spec_version: void 0,
			feature: fm.feature,
			intent: fm.intent,
			adr_refs: fm.adr_refs,
			requirements: fm.requirements,
			scenarios: fm.scenarios,
			visual_contracts: fm.visual_contracts ?? [],
			needs_clarification: fm.needs_clarification
		});
		if (!submitParse.success) {
			emitFailure("SCHEMA_VALIDATION_FAILED", `spec.md frontmatter passed SpecFrontmatter but failed SpecSubmitInput shape (unusual cross-schema drift); work copy preserved at ${specMdPath}`, {
				subcode: "zod",
				path: specMdPath,
				issues: submitParse.error.issues
			});
			return;
		}
		const now = (/* @__PURE__ */ new Date()).toISOString();
		const entries = buildSpecSubmitBatch({
			input: submitParse.data,
			snapshot: session.snapshot,
			actor,
			now
		});
		const mutateResult = finishMutate(await mutateBatch(entries, mctxFor(featureDir, session)), "emit-failure");
		if (!mutateResult) return;
		const newSpecVersion = entries[0].payload.spec_version;
		ctx.success({
			ok: true,
			feature: opts.feature,
			spec_version: newSpecVersion,
			sub_state: mutateResult.snapshot.state?.sub_state
		}, (i18n) => i18n.t(SUCCESS_KEYS.specEditText, { spec_version: newSpecVersion }) + "\n", (i18n) => ({ stateChange: i18n.t(SUCCESS_KEYS.specEditStateChange, { spec_version: newSpecVersion }) }));
	});
	for (const cfg of REGISTER_SPEC_ADD) {
		const mutatorKey = cfg.name === "req" ? "spec:add-req" : cfg.name === "scenario" ? "spec:add-scenario" : "spec:add-visual";
		specCmd.command(`add-${cfg.name}`).description(`Add ${cfg.name} entries via id_namespace stamping (CLI allocates ${cfg.name.toUpperCase()} ids)`).option("--input <src>", `JSON source for SpecAdd${cfg.name[0].toUpperCase()}${cfg.name.slice(1)}Input (item or array): \`-\` (stdin), inline JSON, or file path (protocol §10.7)`).option("--schema", "Dump the input JSON Schema instead of mutating (Phase 16 SC-10)").option("--feature <name>", `Feature whose spec to extend`).option("--feature-dir <path>", "Override default .loaf/<feature> directory").action(async (rawOpts) => {
			if (rawOpts.schema === true) {
				let rejected = false;
				if (cfg.name === "req") rejected = rejectIfDryRun("spec add-req --schema");
				else if (cfg.name === "scenario") rejected = rejectIfDryRun("spec add-scenario --schema");
				else rejected = rejectIfDryRun("spec add-visual --schema");
				if (rejected) return;
				emitMutatorSchemaAndExit(mutatorKey);
				return;
			}
			if (rawOpts.input === void 0) {
				emitFailure("MISSING_INPUT", `loaf spec add-${cfg.name} requires --input <src> (or pass --schema to dump the input JSON Schema)`);
				return;
			}
			const opts = rawOpts;
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
			const featureDir = await dispatchOrFail(opts);
			if (featureDir === null) return;
			const session = await ctx.resolveSession(featureDir);
			if (!session.snapshot.state) {
				emitNoSessionFailure(FAILURE_SITE_KEYS.noSessionGeneric, opts.feature);
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
			const result = await runMutator(featureDir, session, transformedItems.map(({ id, rest }) => ({
				kind: cfg.entryKind,
				payload: {
					spec_version: targetVersion,
					[cfg.payloadField]: {
						id,
						...rest
					}
				},
				actor
			})), "raw-ctx-failure");
			if (!result) return;
			const specVersion = result.snapshot.state?.spec_version;
			ctx.success({
				ok: true,
				feature: opts.feature,
				spec_version: specVersion,
				ids: allocatedIds,
				sub_state: result.snapshot.state?.sub_state
			}, (i18n) => i18n.t(specAddTextKey(cfg.name, allocatedIds.length), {
				spec_version: specVersion,
				ids: allocatedIds.join(", ")
			}) + "\n", (i18n) => ({ stateChange: i18n.t(specAddStateChangeKey(cfg.name, allocatedIds.length), {
				count: allocatedIds.length,
				spec_version: specVersion,
				ids: allocatedIds.join(",")
			}) }));
		});
	}
	const ARTIFACT_PARENTS = {
		spec: specCmd,
		tasks: tasksCmd,
		evidence: evidenceCmd,
		finding: findingCmd,
		state: program.command("state").description("Session state schema dump (SC-10)")
	};
	for (const kind of ARTIFACT_SCHEMA_KINDS) ARTIFACT_PARENTS[kind].command("schema").description(`Dump the ${kind} artifact JSON Schema (Phase 16 SC-10; read-only)`).action(async () => {
		let rejected = false;
		if (kind === "spec") rejected = rejectIfDryRun("spec schema");
		else if (kind === "tasks") rejected = rejectIfDryRun("tasks schema");
		else if (kind === "evidence") rejected = rejectIfDryRun("evidence schema");
		else if (kind === "finding") rejected = rejectIfDryRun("finding schema");
		else rejected = rejectIfDryRun("state schema");
		if (rejected) return;
		const schema = emitArtifactSchema(kind);
		ctx.success(schema, () => formatSchema(schema));
	});
	const t0 = monotonicNow();
	let resolvedExit = 0;
	try {
		try {
			await program.parseAsync(argv);
			resolvedExit = ctx.exitCode;
			return ctx.exitCode;
		} catch (err) {
			if (err instanceof CommanderError) {
				if (err.exitCode === 0) {
					resolvedExit = 0;
					return 0;
				}
				process.stderr.write(`error: ${err.code ?? "USAGE"} — ${err.message}\n`);
				resolvedExit = err.exitCode === 1 ? 2 : err.exitCode;
				return resolvedExit;
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
			if (ctx.output === "json") {
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
			resolvedExit = 1;
			return 1;
		}
	} finally {
		if (ctx.debug && ctx.traceTarget && !ctx.dryRun) try {
			const wallMs = Math.round(monotonicNow() - t0);
			const crashContext = ctx.snapshotCrashContext();
			const entry = buildTraceEntry({
				now: now(),
				feature: ctx.traceTarget.feature,
				sessionId: crashContext.session_id,
				subState: crashContext.sub_state,
				cmd: deriveCmdFromArgv(argv),
				argv: argv.slice(2),
				exit: resolvedExit,
				wallMs,
				rawStdout: stdoutCapture.join(""),
				outputMode: ctx.output
			});
			await appendTraceLine(ctx.traceTarget.featureDir, entry);
		} catch {}
	}
}
/** Derive `cmd` (subcommand chain) from argv for trace.jsonl. Walks
*  argv[2:], collects up to 3 leading non-flag tokens, stopping at
*  the first `--<flag>` token. Catches `loaf advance EXECUTE.done`,
*  `loaf start auth-refresh`, and 3-level chains like `loaf tasks
*  step start`. Flag values (e.g. `standard` after `--ceremony`)
*  are excluded because the walk stops at the first `--<flag>`. */
function deriveCmdFromArgv(argv) {
	const chain = [];
	for (const t of argv.slice(2)) {
		if (t.startsWith("--")) break;
		chain.push(t);
		if (chain.length >= 3) break;
	}
	return ["loaf", ...chain].join(" ");
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