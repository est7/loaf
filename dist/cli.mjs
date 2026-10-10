#!/usr/bin/env node
import { Command, CommanderError } from "commander";
import { z } from "zod";
import * as path$1 from "node:path";
import path from "node:path";
import os from "node:os";
import { execFileSync, spawn } from "node:child_process";
import { constants, promises, readFileSync, unlinkSync } from "node:fs";
import { createHash, randomBytes } from "node:crypto";
import * as fsp from "node:fs/promises";
import picomatch from "picomatch";
import { isDeepStrictEqual } from "node:util";
import { O_APPEND, O_CREAT, O_WRONLY } from "node:constants";
import { parse, stringify } from "yaml";
import { createElement, useCallback, useEffect, useMemo, useState } from "react";
import { Box, Text, useApp, useInput } from "ink";
import { jsx, jsxs } from "react/jsx-runtime";
import process$1 from "node:process";
import { createServer } from "node:http";
//#region src/core/argv-scanner.ts
/** Keep every raw token, including option-looking values and duplicates.
* No command recognition, validation, alias expansion or shell parsing occurs.
*/
function scanArgv(argv, valueFlags = /* @__PURE__ */ new Set()) {
	return argv.map((raw, index) => {
		if (raw === "--") return {
			kind: "terminator",
			index,
			raw
		};
		if (!raw.startsWith("-") || raw === "-") return {
			kind: "positional",
			index,
			raw
		};
		const equals = raw.startsWith("--") ? raw.indexOf("=") : -1;
		const flag = equals === -1 ? raw : raw.slice(0, equals);
		const arity = equals !== -1 || valueFlags.has(flag) ? 1 : 0;
		return {
			kind: "option",
			index,
			raw,
			flag,
			arity,
			value: equals !== -1 ? raw.slice(equals + 1) : arity === 1 ? argv[index + 1] : void 0,
			valueIndex: equals !== -1 ? index : arity === 1 && index + 1 < argv.length ? index + 1 : void 0
		};
	});
}
/** Option-bearing prefix. The first literal terminator and all following tokens
* belong to the positional view; raw scanArgv provenance remains unchanged. */
function optionArgv(argv) {
	const boundary = argv.indexOf("--");
	return boundary === -1 ? argv : argv.slice(0, boundary);
}
//#endregion
//#region src/core/error-catalog.ts
const TemplateKey = z.string().regex(/^[A-Za-z0-9_]+$/);
const DiagnosticTemplate = z.object({
	message_template: z.string().min(3),
	zh_message_template: z.string().min(3).optional(),
	fix_template: z.string().min(3).optional(),
	zh_fix_template: z.string().min(3).optional(),
	template_keys: z.array(TemplateKey).readonly(),
	detail_keys: z.array(TemplateKey).readonly().optional(),
	adapter: z.record(TemplateKey, TemplateKey).optional(),
	list_separator: z.record(TemplateKey, z.string()).optional(),
	doc_anchor: z.string().min(3).optional()
});
DiagnosticTemplate.extend({
	exit_code: z.literal(2),
	variants: z.record(z.string(), DiagnosticTemplate).optional()
});
const ERROR_CATALOG = {
	INPUT_FILE_NOT_FOUND: {
		exit_code: 2,
		message_template: "input file does not exist: {path}",
		fix_template: "verify the path, or pass '-' to read from stdin / inline JSON starting with a JSON object or array — see `loaf <cmd> --help` for examples",
		template_keys: ["path"],
		doc_anchor: "protocol.md#§10.7",
		detail_keys: ["path"],
		variants: {
			"failure.check.path_missing": {
				message_template: "file not found: {path}",
				zh_message_template: "input file 不存在:{path}",
				fix_template: "verify the path, or pass '-' to read from stdin / inline JSON starting with a JSON object or array — see `loaf <cmd> --help` for examples",
				template_keys: ["path"],
				detail_keys: ["path"],
				doc_anchor: "protocol.md#§10.7"
			},
			"failure.profile.input_file_missing": {
				message_template: "input file does not exist: {path}",
				zh_message_template: "input file 不存在:{path}",
				fix_template: "verify the path, or pass '-' to read from stdin / inline JSON starting with a JSON object or array — see `loaf <cmd> --help` for examples",
				template_keys: ["path"],
				detail_keys: ["path"],
				doc_anchor: "protocol.md#§10.7"
			},
			"failure.profile.input_file_unreadable": {
				message_template: "cannot read input file {path}: {error}",
				zh_message_template: "无法读取 input file {path}:{error}",
				fix_template: "verify the path, or pass '-' to read from stdin / inline JSON starting with a JSON object or array — see `loaf <cmd> --help` for examples",
				template_keys: ["error", "path"],
				detail_keys: ["error", "path"],
				doc_anchor: "protocol.md#§10.7"
			},
			"failure.lessons.file_missing": {
				message_template: "lesson file not found: {path}",
				zh_message_template: "lesson file 不存在:{path}",
				fix_template: "verify the path, or pass '-' to read from stdin / inline JSON starting with a JSON object or array — see `loaf <cmd> --help` for examples",
				template_keys: ["path"],
				detail_keys: ["path"],
				doc_anchor: "protocol.md#§10.7"
			}
		}
	},
	MISSING_INPUT: {
		exit_code: 2,
		message_template: "required input source missing or unreadable: --input not provided OR stdin could not be read (--input - failed)",
		fix_template: "pass --input with one of: a JSON file path, '-' for stdin (with valid piped JSON), or inline JSON; for stdin failures, pass valid JSON to `loaf <cmd> --input -` on stdin; for the 6 schema-capable authoring commands (spec add-req / spec add-scenario / spec add-visual / tasks submit / tasks add / evidence add), run `loaf <cmd> --schema --format=json` to view the input schema",
		template_keys: [],
		doc_anchor: "protocol.md#§10.7",
		detail_keys: []
	},
	SPEC_EDIT_INPUT_REQUIRED: {
		exit_code: 2,
		message_template: "non-interactive `loaf spec edit` requires --input <src>; the editor lane requires TTY stdin and stdout",
		zh_message_template: "非交互式 `loaf spec edit` 必须传 --input <src>；编辑器通道要求 stdin 和 stdout 均为 TTY",
		fix_template: "pass --input with a JSON object {\"body\":\"<Markdown>\"} via file, stdin '-', or inline JSON; alternatively rerun from a terminal with both stdin and stdout attached to a TTY",
		template_keys: [],
		detail_keys: [],
		doc_anchor: "protocol.md#§10.7"
	},
	SCHEMA_VALIDATION_FAILED: {
		exit_code: 2,
		message_template: "validation failed: {reason}",
		fix_template: "inspect the structured validation detail and correct the input or runtime state before retrying; use --schema when supported by the command to inspect its input contract",
		template_keys: ["reason"],
		doc_anchor: "protocol.md#§10.5",
		detail_keys: ["reason"],
		variants: {
			"failure.hook.stdin_parse_failed": {
				message_template: "{reason}",
				zh_message_template: "hook stdin payload 解析失败:{reason}",
				fix_template: "pass --path <P> or a non-TTY hook payload containing tool_input.file_path, then retry the hook",
				template_keys: ["reason"],
				detail_keys: ["reason"],
				doc_anchor: "protocol.md#§10.5"
			},
			"failure.schema.validation": {
				message_template: "{kind} at {path} failed schema validation ({error_count} {error_word})",
				zh_message_template: "{kind} at {path} 校验失败({error_count} {error_word})",
				fix_template: "fix the reported fields in {path}, then rerun `loaf check {path} --kind {kind}`",
				template_keys: [
					"error_count",
					"error_word",
					"kind",
					"path"
				],
				detail_keys: [
					"error_count",
					"error_word",
					"kind",
					"path"
				],
				doc_anchor: "protocol.md#§10.5"
			},
			"failure.handoff.pack_validation_failed": {
				message_template: "ResumePack failed runtime validation (builder bug or schema drift)",
				zh_message_template: "ResumePack 运行时校验失败(builder bug 或 schema drift)",
				fix_template: "preserve the session journal and report the failed ResumePack runtime validation; retry with a corrected loaf version",
				template_keys: [],
				detail_keys: [],
				doc_anchor: "protocol.md#§10.5"
			},
			"failure.tasks_add.empty_array": {
				message_template: "tasks add input is an empty array",
				zh_message_template: "tasks add 输入不能为空数组",
				fix_template: "provide at least one task object; run `loaf tasks add --schema --format=json` to inspect the authoring input",
				template_keys: [],
				detail_keys: [],
				doc_anchor: "protocol.md#§10.5"
			},
			"failure.write_guard.config_invalid": {
				message_template: "write-guard blocked: {reason}",
				zh_message_template: "write-guard 被拦截:{reason}",
				fix_template: "repair .loaf/.config/loaf.config.json, then retry the write-side hook",
				template_keys: ["reason"],
				detail_keys: ["reason"],
				doc_anchor: "protocol.md#§10.5"
			}
		}
	},
	SPEC_LOCKED_NO_DIRECT_EDIT: {
		exit_code: 2,
		message_template: "{kind} blocked: spec_locked=true; use `loaf finding raise --category spec-gap --action amend-spec` to back-edge into SPEC.spec",
		zh_message_template: "{kind} 被拒:spec_locked=true;用 `loaf finding raise --category spec-gap --action amend-spec` 走 amend-spec 回退到 SPEC.spec",
		fix_template: "raise a finding with category=spec-gap (or spec-defect) and action=amend-spec to back-edge into SPEC.spec (the finding's resets_spec_locked effect lifts the gate); then retry the spec add/submit",
		template_keys: ["kind"],
		doc_anchor: "protocol.md#§5.3",
		detail_keys: ["kind"]
	},
	SPEC_NOT_INITIALIZED: {
		exit_code: 2,
		message_template: "{kind} blocked: spec_version=0; run `loaf spec submit` first to bump spec_version to 1",
		zh_message_template: "{kind} 被拒:spec_version=0;先跑 `loaf spec submit` 把 spec_version 升到 1",
		fix_template: "run `loaf spec submit --input <file>` first to bump spec_version to 1, then retry the add-* command (SC4 will add `loaf spec init` as a separate scaffold helper that chains into submit)",
		template_keys: ["kind"],
		doc_anchor: "protocol.md#§4.2",
		detail_keys: ["kind"]
	},
	SPEC_ALREADY_INITIALIZED: {
		exit_code: 2,
		message_template: "spec.md already exists at {spec_md_path}; refusing to overwrite",
		zh_message_template: "spec.md 已存在于 {spec_md_path};拒绝覆盖",
		fix_template: "edit the existing spec.md directly, or remove it before re-running `loaf spec init` (no --force flag in Slice 4)",
		template_keys: ["spec_md_path"],
		doc_anchor: "protocol.md#§4.2",
		detail_keys: ["spec_md_path"]
	},
	CONFIG_ALREADY_INITIALIZED: {
		exit_code: 2,
		message_template: "loaf config already exists at {config_path}; refusing to overwrite",
		zh_message_template: "loaf config 已存在于 {config_path};拒绝覆盖",
		fix_template: "edit the existing config file directly, or remove it before re-running `loaf config init` (no --force flag)",
		template_keys: ["config_path"],
		detail_keys: ["config_path"],
		doc_anchor: "protocol.md#§10.8"
	},
	ATTACHMENT_NOT_FOUND: {
		exit_code: 2,
		message_template: "attachment path does not exist: {path}",
		fix_template: "verify the path is reachable from the working directory and readable by the current user",
		template_keys: ["path"],
		doc_anchor: "protocol.md#§4.4",
		detail_keys: ["path"]
	},
	ATTACHMENT_NOT_FILE: {
		exit_code: 2,
		message_template: "attachment path is not a regular file: {path} ({kind})",
		fix_template: "attachments must be regular files; directories, symlinks to directories, sockets, and FIFOs are rejected",
		template_keys: ["kind", "path"],
		doc_anchor: "protocol.md#§4.4",
		detail_keys: ["kind", "path"]
	},
	FINDING_ACTION_UNUSUAL_REASON_REQUIRED: {
		exit_code: 2,
		message_template: "finding category={category} × action={action} is 'unusual'; --reason of at least {min_reason_length} characters is required",
		fix_template: "rerun with --reason explaining why this non-typical combination applies (see references/finding-matrix-rationale.md)",
		template_keys: [
			"action",
			"category",
			"min_reason_length"
		],
		detail_keys: [
			"action",
			"category",
			"current_reason_length",
			"min_reason_length"
		],
		doc_anchor: "protocol.md#§4.5"
	},
	FINDING_ACTION_INCOHERENT: {
		exit_code: 2,
		message_template: "finding category={category} × action={action} is incoherent: no target task exists to apply this transition to",
		fix_template: "amend the spec first (category=spec-gap / new-scope × action=amend-spec) so a target task can be planned, then raise the fix-impl / fix-test finding against that task",
		template_keys: ["action", "category"],
		doc_anchor: "protocol.md#§4.5",
		detail_keys: ["action", "category"]
	},
	FINDING_TARGET_REQUIRED: {
		exit_code: 2,
		message_template: "finding action={action} target validation failed ({reason})",
		zh_message_template: "finding action={action} target 校验失败({reason})",
		fix_template: "fix-impl/fix-test require --target-task + --target-step matching the action's canonical step (fix-impl=implement, fix-test=red); amend-tasks accepts an optional but valid target; amend-spec / defer / backlog must not carry a target",
		template_keys: ["action", "reason"],
		doc_anchor: "protocol.md#§4.5",
		detail_keys: ["action", "reason"]
	},
	PRUNE_RESTORE_NOT_FOUND: {
		exit_code: 2,
		message_template: "no trashed session matches the given id",
		zh_message_template: "没有匹配该 id 的已回收 session",
		fix_template: "run `loaf prune --history` to list trashed sessions (slice 6b)",
		template_keys: [],
		doc_anchor: "protocol.md#§10.8",
		detail_keys: []
	},
	PRUNE_RESTORE_AMBIGUOUS: {
		exit_code: 2,
		message_template: "the session id was trashed more than once; pass --at <ts> to pick one",
		zh_message_template: "该 session id 被回收过多次;用 --at <ts> 指定其一",
		fix_template: "re-run `loaf prune restore <id> --at <ts>` with one of the listed timestamps",
		template_keys: [],
		doc_anchor: "protocol.md#§10.8",
		detail_keys: []
	},
	PRUNE_RESTORE_INCOMPLETE: {
		exit_code: 2,
		message_template: "the trash bucket is incomplete (missing a required artifact); not restoring",
		zh_message_template: "trash 桶不完整(缺必要文件),不予恢复",
		fix_template: "inspect the trash bucket; a complete bucket has manifest.json + registry.json",
		template_keys: [],
		doc_anchor: "protocol.md#§10.8",
		detail_keys: []
	},
	PRUNE_PATH_OCCUPIED: {
		exit_code: 2,
		message_template: "a restore destination already exists; refusing to overwrite",
		zh_message_template: "恢复目标已存在,拒绝覆盖",
		fix_template: "move or remove the occupying registry entry / feature dir, then retry restore",
		template_keys: [],
		doc_anchor: "protocol.md#§10.8",
		detail_keys: []
	},
	PRUNE_PARTIAL_FAILURE: {
		exit_code: 2,
		message_template: "prune partially failed: one or more sessions could not be removed",
		zh_message_template: "prune 部分失败:有 session 未能删除",
		fix_template: "inspect detail.failed; rerun prune for the failed sessions after resolving the error",
		template_keys: [],
		doc_anchor: "protocol.md#§10.8",
		detail_keys: []
	},
	MUTUALLY_EXCLUSIVE_FLAGS: {
		exit_code: 2,
		message_template: "mutually exclusive flags in the same invocation: {flags}",
		zh_message_template: "同一次调用使用了互斥的 flags:{flags}",
		fix_template: "pass at most one of the flags from each exclusion set; see `loaf <cmd> --help` for the canonical flag list",
		template_keys: ["flags"],
		detail_keys: ["conflicting"],
		adapter: { flags: "conflicting" },
		doc_anchor: "protocol.md#§10.7"
	},
	INVALID_ENV_VALUE: {
		exit_code: 2,
		message_template: "environment variable {env_name}={value} is not in the accepted enum: {accepted}",
		fix_template: "unset {env_name} or set it to one of: {accepted}",
		template_keys: [
			"accepted",
			"env_name",
			"value"
		],
		doc_anchor: "protocol.md#§10.3",
		detail_keys: [
			"accepted",
			"env_name",
			"value"
		]
	},
	INVALID_FORMAT: {
		exit_code: 2,
		message_template: "invalid --format value '{value}'; allowed: {allowed_values_human}",
		zh_message_template: "无效的 --format 值 '{value}';合法值:{allowed_values_human}",
		fix_template: "pass --format text or --format json (the only allowed values for this release); --format=<value> equals form is accepted",
		template_keys: ["allowed_values_human", "value"],
		detail_keys: ["allowed_values", "value"],
		adapter: { allowed_values_human: "allowed_values" },
		doc_anchor: "protocol.md#§10.7",
		list_separator: { allowed_values_human: "|" }
	},
	INVALID_LOCALE: {
		exit_code: 2,
		message_template: "invalid locale from {source} (expected {accepted})",
		zh_message_template: "locale 来源 {source} 的值无效(期望:{accepted})",
		fix_template: "unset the locale override or set it to one of: {accepted}; user preferences live in ~/.loaf/config.json locale.default_lang",
		template_keys: ["accepted", "source"],
		doc_anchor: "docs/adr/0006-runtime-i18n-and-user-config.md",
		detail_keys: ["accepted", "source"]
	},
	DRY_RUN_NOT_APPLICABLE: {
		exit_code: 2,
		message_template: "--dry-run not applicable to {command_type} command `{command}`",
		zh_message_template: "--dry-run 不适用于{command_type}命令 `{command}`",
		fix_template: "--dry-run only applies to mutating commands; re-run without --dry-run (or -n) to invoke the {command_type} command",
		template_keys: ["command", "command_type"],
		detail_keys: ["command", "command_type"],
		doc_anchor: "protocol.md#§10.7"
	},
	HOOK_EVENT_NOT_IMPLEMENTED: {
		exit_code: 2,
		message_template: "hook event `{event}` is not implemented in this loaf version (Phase 16 SC-15{sub_cycle} pending; see protocol §11)",
		zh_message_template: "hook event `{event}` 在当前 loaf 版本未实装(Phase 16 SC-15{sub_cycle} 待实现;详 protocol §11)",
		fix_template: "upgrade to a loaf release that implements this hook event, OR skip this hook surface for now — `loaf hook --list-events` shows the canonical 4-event enum",
		template_keys: ["event", "sub_cycle"],
		doc_anchor: "protocol.md#§11",
		detail_keys: ["event", "sub_cycle"]
	},
	TASK_STATUS_WITHOUT_PROOF: {
		exit_code: 2,
		message_template: "task {task_id} status change requires evidence: status={status} has no PASSING covering evidence proof in evidence.jsonl",
		fix_template: "emit `loaf evidence add` covering task_id={task_id} before advancing status (task-evidence is otherwise enforced later at verify-min / verify-accept)",
		template_keys: ["status", "task_id"],
		doc_anchor: "protocol.md#§4.4",
		detail_keys: ["status", "task_id"]
	},
	MISSING_VERIFIABILITY: {
		exit_code: 2,
		message_template: "REQ {req_id} must declare measurable, verified_by_scenarios[], or acceptance_na+reason",
		zh_message_template: "需求 {req_id} 必须声明 measurable、verified_by_scenarios[] 或 acceptance_na+reason 三选一",
		fix_template: "add one of: measurable with metric, threshold, and optional unit/direction; verified_by_scenarios: [SCEN-...]; or acceptance_na: true with acceptance_na_reason of at least 10 characters",
		template_keys: ["req_id"],
		doc_anchor: "protocol.md#§4.2",
		detail_keys: ["req_id"]
	},
	VAGUE_NO_SCENARIO: {
		exit_code: 2,
		message_template: "requirement {req_id} reads as vague but is not anchored to a measurable threshold or to a verifying scenario",
		fix_template: "either add measurable with a numeric threshold and direction, or add the verifying SCEN-id to verified_by_scenarios",
		template_keys: ["req_id"],
		doc_anchor: "protocol.md#§4.2",
		detail_keys: ["req_id"]
	},
	DRIVES_NOT_BOUND: {
		exit_code: 2,
		message_template: "REQ {req_id} is not referenced by any task.drives[]",
		zh_message_template: "需求 {req_id} 没有被任何 task.drives[] 引用",
		fix_template: "add a task whose drives[] contains {req_id} (loaf tasks add --input ...), or remove the REQ if it is intentionally out-of-scope for this feature",
		template_keys: ["req_id"],
		doc_anchor: "protocol.md#§4.3",
		detail_keys: ["req_id"]
	},
	MUTATION_OUT_OF_RIGHTS: {
		exit_code: 2,
		message_template: "event:tasks_amended on task {task_id} is not permitted at sub_state {sub_state} — §8.6 grants no mutation right for this change",
		zh_message_template: "task {task_id} 的 event:tasks_amended 在 sub_state {sub_state} 不被允许 —— §8.6 未授予该改动的 mutation right",
		fix_template: "the mutation rights matrix (protocol.md §8.6) limits EXECUTE.plan `tasks amend` to execution[].applicability changes plus a status pending→ready advance; graph/kind-flag fields are frozen. To restructure the task graph, raise a `finding raise --action amend-tasks` back-edge, then run the sponsored `tasks add --finding` / `tasks amend --input --finding` at EXECUTE.work — a sponsored amend may change graph/definition fields but never erases execution progress (task/step status is frozen)",
		template_keys: ["sub_state", "task_id"],
		doc_anchor: "protocol.md#§8.6",
		detail_keys: ["sub_state", "task_id"]
	},
	LOCK_TIMEOUT: {
		exit_code: 2,
		message_template: "could not acquire the write lock within {timeout_seconds}s",
		fix_template: "another loaf process is holding the feature lease; wait for it to release. A later writer automatically reclaims a lease only when its PID is verifiably dead and the owner generation is unchanged; malformed leases fail closed and require inspection.",
		template_keys: ["timeout_seconds"],
		doc_anchor: "protocol.md#§11.2",
		detail_keys: ["timeout_seconds"]
	},
	LOCK_INVALID: {
		exit_code: 2,
		message_template: "feature write lease at {lock_path} is malformed or incomplete",
		fix_template: "inspect the lease and active loaf processes; malformed leases fail closed and no loaf command deletes them. Remove or replace the file only after independently proving that no writer owns it.",
		template_keys: ["lock_path"],
		doc_anchor: "protocol.md#§11.2",
		detail_keys: ["lock_path"]
	},
	FEATURE_NOT_FOUND: {
		exit_code: 2,
		message_template: "no feature found in cwd (.loaf/ is empty or missing, or no projection has phase != DONE)",
		zh_message_template: "当前 cwd 找不到 feature(.loaf/ 为空或缺失,或所有 projection 已 DONE)",
		fix_template: "run `loaf start <description>` to create a new feature, or cd into a directory that already has a .loaf/<feature>/ subtree",
		template_keys: [],
		detail_keys: [],
		doc_anchor: "protocol.md#§10.3"
	},
	FEATURE_AMBIGUOUS: {
		exit_code: 2,
		message_template: "current working directory has {count} active features and no dispatch context: {feature_list}",
		zh_message_template: "当前 cwd 有 {count} 个 active feature 但无 dispatch 上下文:{feature_list}",
		fix_template: "disambiguate with --feature <name>, --session <UUID>, or set $LOAF_FEATURE / $LOAF_SESSION in the environment",
		template_keys: ["count", "feature_list"],
		detail_keys: ["count", "feature_list"],
		doc_anchor: "protocol.md#§10.3"
	},
	SESSION_CWD_MISMATCH: {
		exit_code: 2,
		message_template: "--session {uuid} is registered against cwd={registered_cwd}, but the current cwd is {current_cwd}",
		zh_message_template: "--session {uuid} 注册的 cwd={registered_cwd},当前 cwd 是 {current_cwd}",
		fix_template: "cd to the registered cwd before issuing the command, or pass a different --session, or drop --session to auto-pick a session in the current cwd",
		template_keys: [
			"current_cwd",
			"registered_cwd",
			"uuid"
		],
		detail_keys: [
			"current_cwd",
			"registered_cwd",
			"uuid"
		],
		doc_anchor: "protocol.md#§10.3"
	},
	SESSION_SHORT_AMBIGUOUS: {
		exit_code: 2,
		message_template: "--session {prefix} matches {match_count} sessions in the registry: {candidate_list}",
		zh_message_template: "--session {prefix} 在 registry 匹配 {match_count} 个 session:{candidate_list}",
		fix_template: "pass a longer UUID prefix (≥8 chars are required; use more to disambiguate) or pass the full UUID",
		template_keys: [
			"candidate_list",
			"match_count",
			"prefix"
		],
		detail_keys: [
			"candidate_list",
			"match_count",
			"prefix"
		],
		doc_anchor: "protocol.md#§10.3"
	},
	SESSION_NOT_FOUND: {
		exit_code: 2,
		message_template: "--session {uuid_or_prefix} matches no entry in the registry",
		zh_message_template: "--session {uuid_or_prefix} 在 registry 找不到任何匹配",
		fix_template: "run `loaf sessions list --in-cwd` to see registered sessions (future SC-9b), or run `loaf start <name>` to create one",
		template_keys: ["uuid_or_prefix"],
		detail_keys: ["uuid_or_prefix"],
		doc_anchor: "protocol.md#§10.3"
	},
	PENDING_BLOCKS_ADVANCE: {
		exit_code: 2,
		message_template: "pending head {pending_id} (kind={kind}) blocks `loaf advance` until resolved",
		zh_message_template: "pending head {pending_id}(kind={kind})阻塞 `loaf advance`,需先 resolve",
		fix_template: "resolve the head with the kind-appropriate command: `loaf gate decide <G>` for kind=gate_decision; `loaf profile escalate --confirm --input <ceremony.json>` for kind=profile_escalation; `loaf pending resolve --answer <a>` for the rest",
		template_keys: ["kind", "pending_id"],
		doc_anchor: "protocol.md#§10.7",
		detail_keys: ["kind", "pending_id"]
	},
	GATE_NOT_PENDING: {
		exit_code: 2,
		message_template: "`loaf gate decide {gate_kind}` requires pending head kind=gate_decision; current head kind: {head_kind}",
		zh_message_template: "`loaf gate decide {gate_kind}` 要求 pending head kind=gate_decision;当前 head kind:{head_kind}",
		fix_template: "resolve the current head first via the kind-appropriate command, or wait for the gate_decision pending to appear",
		template_keys: ["gate_kind", "head_kind"],
		detail_keys: [
			"gate_kind",
			"head_id",
			"head_kind"
		],
		doc_anchor: "protocol.md#§10.7"
	},
	ESCALATION_NOT_PENDING: {
		exit_code: 2,
		message_template: "`loaf profile escalate --confirm --input <ceremony.json>` requires pending head kind=profile_escalation; current head: {actual_head}",
		zh_message_template: "`loaf profile escalate --confirm --input <ceremony.json>` 要求 pending head kind=profile_escalation;当前 head:{actual_head}",
		fix_template: "resolve the current head first via the kind-appropriate command, or wait for the profile_escalation pending to appear",
		template_keys: ["actual_head"],
		doc_anchor: "protocol.md#§10.7",
		detail_keys: ["actual_head"]
	},
	ACTOR_AUTHORITY_VIOLATION: {
		exit_code: 2,
		message_template: "actor {actor} is not allowed for journal kind {kind}",
		fix_template: "use the command surface that owns this kind; human-only kinds require an interactive human actor resolved by LOAF_USER or git user.email",
		template_keys: ["actor", "kind"],
		doc_anchor: "protocol.md#§10.8",
		detail_keys: ["actor", "kind"]
	},
	FROM_CURSOR_MISMATCH: {
		exit_code: 2,
		message_template: "entry payload.from={payload_from} does not match current sub_state={current_sub_state}",
		fix_template: "refresh the current session state and emit the transition from the actual cursor; do not replay a stale transition candidate",
		template_keys: ["current_sub_state", "payload_from"],
		doc_anchor: "protocol.md#§11.2",
		detail_keys: ["current_sub_state", "payload_from"]
	},
	INVALID_ENVELOPE: {
		exit_code: 2,
		message_template: "journal entry failed envelope validation: {reason}",
		fix_template: "rebuild the entry through the CLI mutator so seq, entry_id, actor, kind, payload, and batch markers satisfy JournalEntry",
		template_keys: ["reason"],
		doc_anchor: "protocol.md#§11.2",
		detail_keys: ["reason"]
	},
	INVALID_PAYLOAD: {
		exit_code: 2,
		message_template: "payload for kind {kind} failed validation: {reason}",
		fix_template: "fix the payload to match the PER_KIND_PAYLOAD schema for this kind and retry the mutator",
		template_keys: ["kind", "reason"],
		doc_anchor: "protocol.md#§11.2",
		detail_keys: ["kind", "reason"]
	},
	SEQ_NOT_MONOTONIC: {
		exit_code: 2,
		message_template: "entry seq {got} does not extend journal tail {tail_seq}; expected {expected}",
		fix_template: "refresh tail_seq under the session lock and retry; if the tail is corrupt run `loaf doctor --check-tail`",
		template_keys: [
			"expected",
			"got",
			"tail_seq"
		],
		doc_anchor: "protocol.md#§11.2",
		detail_keys: [
			"expected",
			"got",
			"tail_seq"
		]
	},
	SETTLE_PHASE_BYPASS: {
		exit_code: 2,
		message_template: "VERIFY.accept → DONE.delivered requires ceremony.settle_phase=false (quick / light / standard); deep profile must enter SETTLE.lessons first; current settle_phase={settle_phase}",
		fix_template: "for deep profile, advance from VERIFY.accept to SETTLE.lessons via `loaf settle`; if SETTLE is not desired, start/continue a standard ceremony flow instead",
		template_keys: ["settle_phase"],
		doc_anchor: "protocol.md#§5.2",
		detail_keys: ["settle_phase"]
	},
	SETTLE_PHASE_DISABLED: {
		exit_code: 2,
		message_template: "VERIFY.accept → SETTLE.lessons requires ceremony.settle_phase=true (deep profile only after rev 5.x); current settle_phase={settle_phase}",
		fix_template: "for non-deep profiles (quick / light / standard), advance from VERIFY.accept to DONE.delivered via `loaf deliver`; to enter SETTLE, escalate ceremony to deep",
		template_keys: ["settle_phase"],
		doc_anchor: "protocol.md#§5.2",
		detail_keys: ["settle_phase"]
	},
	SPEC_PHASE_FORK_VIOLATION: {
		exit_code: 2,
		message_template: "transition {from} → {to} violates ceremony.spec_phase={spec_phase}",
		fix_template: "follow the ceremony fork: spec_phase=true traverses SPEC.*, spec_phase=false goes directly to EXECUTE.plan",
		template_keys: [
			"from",
			"spec_phase",
			"to"
		],
		doc_anchor: "protocol.md#§5.2",
		detail_keys: [
			"from",
			"spec_phase",
			"to"
		]
	},
	SUB_STATE_AUTHORITY_VIOLATION: {
		exit_code: 2,
		message_template: "kind {kind} is not allowed in sub_state {sub_state}",
		fix_template: "advance/back-edge to a sub_state that permits this journal kind, or use the command valid for the current state",
		template_keys: ["kind", "sub_state"],
		doc_anchor: "protocol.md#§10.8",
		detail_keys: ["kind", "sub_state"]
	},
	TRANSITION_ILLEGAL: {
		exit_code: 2,
		message_template: "cannot transition {from} → {to}",
		fix_template: "choose one of the allowed forward transitions for the current sub_state, or use an explicit terminal/archive path when supported",
		template_keys: ["from", "to"],
		doc_anchor: "protocol.md#§5.2",
		detail_keys: ["from", "to"]
	},
	VERIFY_PHASE_FORK_VIOLATION: {
		exit_code: 2,
		message_template: "transition {from} → {to} violates ceremony.verify_phase={verify_phase}",
		fix_template: "follow the ceremony fork: verify_phase=true enters VERIFY.plan, verify_phase=false can deliver after minimal verification",
		template_keys: [
			"from",
			"to",
			"verify_phase"
		],
		doc_anchor: "protocol.md#§5.2",
		detail_keys: [
			"from",
			"to",
			"verify_phase"
		]
	},
	EXECUTE_DONE_TASKS_NOT_FINAL: {
		exit_code: 2,
		message_template: "cannot advance EXECUTE.work → EXECUTE.done: {count} task(s) are not in a final status (done or abandoned); finish their remaining steps or abandon out-of-scope tasks with `loaf tasks abandon <T-N> --reason \"...\"`",
		zh_message_template: "无法从 EXECUTE.work 推进到 EXECUTE.done:{count} 个 task 未处于终态(done 或 abandoned);跑完剩余 step,或用 `loaf tasks abandon <T-N> --reason \"...\"` 放弃超出范围的 task",
		fix_template: "finish the remaining steps — run each task's steps via `loaf tasks step` until it auto-promotes to status=done — OR abandon out-of-scope tasks with `loaf tasks abandon <T-N> --reason \"...\"`, then retry `loaf advance EXECUTE.done`; see detail.non_final for the tasks still pending or in progress",
		template_keys: ["count"],
		doc_anchor: "protocol.md#§10.5",
		detail_keys: ["count"]
	},
	ALREADY_STARTED: {
		exit_code: 2,
		message_template: "session bootstrap kind {kind} cannot run after state already exists",
		fix_template: "resume the existing session or create a new feature directory instead of starting over initialized state",
		template_keys: ["kind"],
		detail_keys: ["kind"],
		doc_anchor: "protocol.md#§11.2"
	},
	FINDING_NOT_FOUND: {
		exit_code: 2,
		message_template: "finding close references unknown finding id {id}",
		fix_template: "list open findings and close an existing id, or raise the finding before closing it",
		template_keys: ["id"],
		doc_anchor: "protocol.md#§10.8",
		detail_keys: ["id"]
	},
	NO_SESSION: {
		exit_code: 2,
		message_template: "no started session — run `loaf start` first",
		fix_template: "run `loaf start` before emitting non-bootstrap journal entries",
		template_keys: [],
		doc_anchor: "protocol.md#§10.8",
		detail_keys: [],
		variants: {
			"failure.no_session.status": {
				message_template: "run `loaf start {feature}` first",
				zh_message_template: "先跑 `loaf start {feature}`",
				fix_template: "run `loaf start` before emitting non-bootstrap journal entries",
				template_keys: ["feature"],
				detail_keys: ["feature"],
				doc_anchor: "protocol.md#§10.8"
			},
			"failure.no_session.advance": {
				message_template: "run `loaf start {feature}` first",
				zh_message_template: "先跑 `loaf start {feature}`",
				fix_template: "run `loaf start` before emitting non-bootstrap journal entries",
				template_keys: ["feature"],
				detail_keys: ["feature"],
				doc_anchor: "protocol.md#§10.8"
			},
			"failure.no_session.tasks": {
				message_template: "run `loaf start {feature}` first",
				zh_message_template: "先跑 `loaf start {feature}`",
				fix_template: "run `loaf start` before emitting non-bootstrap journal entries",
				template_keys: ["feature"],
				detail_keys: ["feature"],
				doc_anchor: "protocol.md#§10.8"
			},
			"failure.no_session.pending": {
				message_template: "run `loaf start {feature}` first",
				zh_message_template: "先跑 `loaf start {feature}`",
				fix_template: "run `loaf start` before emitting non-bootstrap journal entries",
				template_keys: ["feature"],
				detail_keys: ["feature"],
				doc_anchor: "protocol.md#§10.8"
			},
			"failure.no_session.finding": {
				message_template: "run `loaf start {feature}` first",
				zh_message_template: "先跑 `loaf start {feature}`",
				fix_template: "run `loaf start` before emitting non-bootstrap journal entries",
				template_keys: ["feature"],
				detail_keys: ["feature"],
				doc_anchor: "protocol.md#§10.8"
			},
			"failure.no_session.verify": {
				message_template: "run `loaf start {feature}` first",
				zh_message_template: "先跑 `loaf start {feature}`",
				fix_template: "run `loaf start` before emitting non-bootstrap journal entries",
				template_keys: ["feature"],
				detail_keys: ["feature"],
				doc_anchor: "protocol.md#§10.8"
			},
			"failure.no_session.generic": {
				message_template: "run `loaf start {feature}` first",
				zh_message_template: "先跑 `loaf start {feature}`",
				fix_template: "run `loaf start` before emitting non-bootstrap journal entries",
				template_keys: ["feature"],
				detail_keys: ["feature"],
				doc_anchor: "protocol.md#§10.8"
			}
		}
	},
	PENDING_NOT_FOUND: {
		exit_code: 2,
		message_template: "pending resolve failed: {reason}",
		fix_template: "resolve the current pending head only; list pending items and retry with the head id",
		template_keys: ["reason"],
		detail_keys: ["reason"],
		doc_anchor: "protocol.md#§10.7"
	},
	REDUCER_NOT_IMPLEMENTED: {
		exit_code: 2,
		message_template: "reducer has no handler for journal kind {kind}",
		fix_template: "implement the journal kind in the exhaustive reducer switch before appending it",
		template_keys: ["kind"],
		doc_anchor: "protocol.md#§11.2",
		detail_keys: ["kind"]
	},
	ENTRY_OVERSIZE: {
		exit_code: 2,
		message_template: "journal entry serialized to {bytes} bytes; limit is {limit}",
		fix_template: "move long text into sidecar form via LongTextField instead of embedding it inline",
		template_keys: ["bytes", "limit"],
		doc_anchor: "protocol.md#§11.2",
		detail_keys: ["bytes", "limit"]
	},
	SHORT_WRITE: {
		exit_code: 2,
		message_template: "journal append wrote {wrote} of {want} bytes",
		fix_template: "stop writing, preserve the journal, and run `loaf doctor --check-tail` before retrying",
		template_keys: ["want", "wrote"],
		doc_anchor: "protocol.md#§11.2",
		detail_keys: ["want", "wrote"]
	},
	TAIL_CORRUPTION: {
		exit_code: 2,
		message_template: "journal tail is corrupt: {reason}",
		fix_template: "run `loaf doctor --check-tail`; do not append until the tail has been repaired or quarantined",
		template_keys: ["reason"],
		doc_anchor: "protocol.md#§10.15",
		detail_keys: ["reason"]
	},
	INVALID_ACTOR_FORMAT: {
		exit_code: 2,
		message_template: "human actor value is invalid: {reason}",
		fix_template: "set LOAF_USER to the raw human identifier without a namespace prefix, or unset it to allow interactive git user.email fallback",
		template_keys: ["reason"],
		doc_anchor: "protocol.md#§10.8",
		detail_keys: ["reason"]
	},
	NO_HUMAN_ACTOR: {
		exit_code: 2,
		message_template: "no human actor could be resolved for a human-only command",
		fix_template: "run interactively with git user.email configured, or set LOAF_USER explicitly",
		template_keys: [],
		doc_anchor: "protocol.md#§10.8",
		detail_keys: []
	},
	DUPLICATE_REQ_ID: {
		exit_code: 2,
		message_template: "REQ id {id} is already in the spec projection",
		fix_template: "allocate a fresh REQ id under the same id_namespace (the CLI scans for max serial + 1 inside the per-session lock) or `loaf finding raise --category spec-gap --action amend-spec` if you need to retire the existing REQ",
		template_keys: ["id"],
		doc_anchor: "protocol.md#§4.2",
		detail_keys: ["id"]
	},
	DUPLICATE_SCEN_ID: {
		exit_code: 2,
		message_template: "SCEN id {id} is already in the spec projection",
		fix_template: "allocate a fresh SCEN id under the same id_namespace, or amend via finding mechanism if retiring an existing scenario",
		template_keys: ["id"],
		doc_anchor: "protocol.md#§4.2",
		detail_keys: ["id"]
	},
	DUPLICATE_VIS_ID: {
		exit_code: 2,
		message_template: "VIS id {id} is already in the spec projection",
		fix_template: "allocate a fresh VIS id under the same id_namespace, or amend via finding mechanism if retiring an existing visual contract",
		template_keys: ["id"],
		doc_anchor: "protocol.md#§4.2",
		detail_keys: ["id"]
	},
	SPEC_FRONTMATTER_INVALID: {
		exit_code: 2,
		message_template: "spec frontmatter failed gate check 1 (subcode={subcode})",
		fix_template: "subcode=SPEC_NOT_FOUND: run `loaf spec init` then `loaf spec submit` to seed spec.md; subcode=SPEC_YAML_INVALID: check the `---`-fenced YAML block at the top of spec.md for syntax errors; subcode=SPEC_FRONTMATTER_INVALID: run `loaf spec schema --format=json` to dump the SpecFrontmatter JSON Schema (Phase 16 SC-10) and fix the offending field. Snapshot-sourced failures require a valid canonical spec submission; initializing or editing a derived file cannot satisfy either gate.",
		template_keys: ["subcode"],
		doc_anchor: "protocol.md#§5.1",
		detail_keys: ["subcode"]
	},
	SPEC_HAS_UNCLARIFIED: {
		exit_code: 2,
		message_template: "spec has {count} unresolved needs_clarification entries (ids={ids}); resolve or remove them before spec-lock can pass",
		fix_template: "edit spec.md to remove resolved needs_clarification entries, or run `loaf finding raise --category spec-gap --action clarify` to formalize the resolution flow; spec-lock check 2 requires needs_clarification === []",
		template_keys: ["count", "ids"],
		detail_keys: ["count", "ids"],
		doc_anchor: "protocol.md#§5.1"
	},
	TASK_NOT_FOUND: {
		exit_code: 2,
		message_template: "task {task_id} is not in the current tasks projection",
		fix_template: "run `loaf tasks list` to see live ids; if you meant to add a new task, use `loaf tasks add` instead of amend/step; if you expected the id to exist, the projection may be stale — run `loaf doctor --rebuild` to rebuild from journal",
		template_keys: ["task_id"],
		doc_anchor: "protocol.md#§10.8",
		detail_keys: ["task_id"]
	},
	TASK_STEP_NOT_FOUND: {
		exit_code: 2,
		message_template: "step {step} is not seeded on task {task_id} — seeded steps are derived from the task's kind execution schema (§14)",
		fix_template: "use only the per-kind step names — behavioral: red/implement/refactor; structural: implement/refactor; visual-ui: mockup/implement/screenshot-compare; docs: draft/review; spike: explore/prototype/record; chore: execute. Running an unseeded step name was a silent add bug in v0.0.x — sub-cycle 3a fails fast instead",
		template_keys: ["step", "task_id"],
		doc_anchor: "protocol.md#§10.8",
		detail_keys: ["step", "task_id"]
	},
	DUPLICATE_TASK_ID: {
		exit_code: 2,
		message_template: "task id {task_id} appears more than once in tasks_planned payload",
		fix_template: "tasks_planned is whole-replacement — each task id must be unique within the batch. Rename one or merge them in the planning input",
		template_keys: ["task_id"],
		doc_anchor: "protocol.md#§10.8",
		detail_keys: ["task_id"]
	},
	TASKS_NOT_PLANNED: {
		exit_code: 2,
		message_template: "gate task-graph check: tasks have not been planned (snapshot.tasks_based_on is null)",
		fix_template: "run `loaf tasks submit --input <plan-file>` to emit event:tasks_planned and seed the task graph; spec-lock check 3 and verify-accept check 4 both require tasks_based_on.spec to match the current spec.spec_version",
		template_keys: [],
		doc_anchor: "protocol.md#§5.1",
		detail_keys: []
	},
	TASKS_BASED_ON_STALE: {
		exit_code: 2,
		message_template: "gate task-graph check: tasks_based_on.spec={tasks_based_on_spec} but current spec.spec_version={current_spec_version} — the task graph was planned against an older spec",
		fix_template: "either re-plan tasks against the current spec via `loaf tasks submit` (whole-replacement), or amend individual tasks via `loaf tasks add/amend` + raise a `loaf finding raise --category spec-gap --action amend-spec` if a spec roll-back is needed. Surfaces for spec-lock (check 3) and verify-accept (check 4 precondition).",
		template_keys: ["current_spec_version", "tasks_based_on_spec"],
		doc_anchor: "protocol.md#§5.1",
		detail_keys: ["current_spec_version", "tasks_based_on_spec"]
	},
	REQ_NOT_DRIVEN: {
		exit_code: 2,
		message_template: "spec-lock check 4: requirement {req_id} is not referenced by any task.drives[]",
		fix_template: "add a task whose drives[] array includes {req_id}, or remove the requirement from spec.md if it is no longer in scope. Note: this is the REQ-side coverage code (distinct from legacy DRIVES_NOT_BOUND which named the inverse direction)",
		template_keys: ["req_id"],
		doc_anchor: "protocol.md#§5.1",
		detail_keys: ["req_id"]
	},
	E2E_SCENARIO_UNBOUND: {
		exit_code: 2,
		message_template: "spec-lock check 6: e2e scenario {scenario_id} has no binding task (requires task with requires_acceptance=true AND drives includes {scenario_id})",
		fix_template: "either (a) add a task with requires_acceptance=true and drives including {scenario_id}, or (b) mark the scenario with acceptance_na=<reason ≥5 chars> in spec.md if e2e acceptance is intentionally skipped for this iteration",
		template_keys: ["scenario_id"],
		doc_anchor: "protocol.md#§5.1",
		detail_keys: ["scenario_id"]
	},
	VISUAL_CONTRACT_UNBOUND: {
		exit_code: 2,
		message_template: "spec-lock check 7: visual_contract {visual_id} has no visual-ui task whose visual_contract_refs includes it",
		fix_template: "either (a) add a visual-ui task with visual_contract_refs including {visual_id}, or (b) mark the visual_contract with visual_na=<reason ≥5 chars> in spec.md if visual verification is intentionally deferred",
		template_keys: ["visual_id"],
		doc_anchor: "protocol.md#§5.1",
		detail_keys: ["visual_id"]
	},
	TASK_KIND_SCHEMA_VIOLATION: {
		exit_code: 2,
		message_template: "spec-lock check 8: task {task_id} (kind={kind}) violates projected kind-specific obligations: {reasons}",
		fix_template: "amend the task to satisfy its kind contract: structural/docs/spike/chore require no_test_rationale (string ≥10 chars); visual-ui requires visual_contract_refs[] with ≥1 entry. Slice C R2: bug-task RED is execution discipline, not a spec-lock obligation — a behavioral task with labels=['bug'] is born unregistered, and RED registration is enforced at runtime by BUG_TASK_REQUIRES_RED (preflight, implement step) and BUG_TASK_RED_NOT_REGISTERED (verify-accept), never by this check",
		template_keys: [
			"kind",
			"reasons",
			"task_id"
		],
		doc_anchor: "protocol.md#§5.1",
		detail_keys: [
			"kind",
			"reasons",
			"task_id"
		],
		list_separator: { reasons: "; " }
	},
	GATE_PRECONDITION_VIOLATION: {
		exit_code: 2,
		message_template: "gate:decided {gate} approval rejected at the mutate layer: {failure_count} check(s) failed",
		fix_template: "this is a mutate-layer envelope around the underlying gate checks (see detail.checks for the list). spec-lock failure codes: MISSING_VERIFIABILITY / REQ_NOT_DRIVEN / E2E_SCENARIO_UNBOUND / VISUAL_CONTRACT_UNBOUND / TASKS_NOT_PLANNED / TASKS_BASED_ON_STALE / TASK_KIND_SCHEMA_VIOLATION / SPEC_HAS_UNCLARIFIED. verify-accept failure codes: VERIFY_LANE_NOT_PASSED / OPEN_FINDINGS_PRESENT / COVERAGE_NOT_SATISFIED / TASK_DONE_NO_EVIDENCE / SPEC_REVIEW_MISSING / SPEC_REVIEW_IMPLEMENTER_CONFLICT / SPEC_REVIEW_IMPLEMENTER_UNKNOWN / TASKS_NOT_PLANNED (precondition) / TASKS_BASED_ON_STALE (precondition). Fix each listed check then retry the gate decision. Pass 1.5 runs after preflight + reducer dry-run + before sidecar promotion, so a rejected gate batch leaves no on-disk residue.",
		template_keys: ["failure_count", "gate"],
		doc_anchor: "protocol.md#§5.1",
		detail_keys: ["failure_count", "gate"]
	},
	MULTIPLE_GATE_DECISIONS: {
		exit_code: 2,
		message_template: "batch contains {count} approved gate:decided entries (gate_kinds={gate_kinds}); protocol §10.8 requires one gate decision per atomic operation",
		fix_template: "split the batch — emit each gate decision as its own mutation. A batch carrying ≥2 gate approvals (even with different gate_kinds, e.g. spec-lock + verify-accept) is not a valid atomic operation. Rejected gate decisions are not counted; only approvals trigger this rule",
		template_keys: ["count", "gate_kinds"],
		doc_anchor: "protocol.md#§10.8",
		detail_keys: ["count", "gate_kinds"]
	},
	GATE_NOT_IMPLEMENTED: {
		exit_code: 2,
		message_template: "gate={gate} is not recognized; protocol GateName enum is closed at `spec-lock` or `verify-accept` for v0.1.0",
		fix_template: "use `loaf gate decide spec-lock` or `loaf gate decide verify-accept`. Future gates beyond v0.1.0 would extend the GateName enum in journal-entry.ts + evidence-schema.ts (lockstep) and wire here.",
		template_keys: ["gate"],
		doc_anchor: "protocol.md#§10.8",
		detail_keys: ["gate"]
	},
	VERIFY_LANE_NOT_PASSED: {
		exit_code: 2,
		message_template: "verify-accept check 1: applicable VERIFY lane={lane} has no evidence with passing/approved/waived result",
		fix_template: "add an evidence:added entry with check={lane} (or a matching kind via the narrow fallback map: local-check/task-summary→run, verify-review/spec-review→review, acceptance→acceptance, visual-review→visual) and result one of `passed`, `approved`, or `waived`. Applicable lanes derive from spec: REQ ⇒ REVIEW, SCEN.tag=e2e ⇒ ACCEPTANCE, VIS ⇒ VISUAL, done task ⇒ RUN+REVIEW.",
		template_keys: ["lane"],
		doc_anchor: "protocol.md#§5.2",
		detail_keys: ["lane"]
	},
	OPEN_FINDINGS_PRESENT: {
		exit_code: 2,
		message_template: "verify-accept check 2: {count} actionable finding(s) still open (ids={open_ids}); resolve or close before verify-accept",
		zh_message_template: "verify-accept 检查 2: 仍有 {count} 个可执行 finding 未关闭(ids={open_ids});请在 verify-accept 前解决或关闭",
		fix_template: "complete the declared action for each listed finding, then run `loaf finding close <FND-id>`; if the honest disposition is carry-forward, raise it with action=defer or action=backlog instead. verify-accept excludes only open findings whose existing action declares deferral",
		template_keys: ["count", "open_ids"],
		doc_anchor: "protocol.md#§5.2",
		detail_keys: ["count", "open_ids"]
	},
	COVERAGE_NOT_SATISFIED: {
		exit_code: 2,
		message_template: "{covered_id} has no evidence that satisfies it (canSatisfy failed for all candidates)",
		zh_message_template: "{covered_id} 没有任何证据满足覆盖(canSatisfy 对所有候选 evidence 都失败)",
		fix_template: "add evidence:added covering {covered_id} per protocol §5.4: REQ allows task-summary/verify-review/spec-review/manual+reason/waiver+reason; SCEN.tag=e2e allows acceptance/manual+reason/waiver+reason; VIS allows visual-review+attachment/manual+reason/waiver+reason. Result must be passed/approved/waived per §1035.",
		template_keys: ["covered_id"],
		doc_anchor: "protocol.md#§5.2",
		detail_keys: ["covered_id"]
	},
	TASK_DONE_NO_EVIDENCE: {
		exit_code: 2,
		message_template: "verify-accept check 4: task {task_id} is status=done but has no evidence covering it (kind one of `task-summary`, `local-check`, `manual`, or `waiver`)",
		fix_template: "add evidence:added with covers including {task_id} and kind in the T-allowed set. Most commonly: a task-summary written on closing the task; alternatively local-check (test/lint/typecheck run), manual (human attest), or waiver (human waiver with reason ≥10 chars).",
		template_keys: ["task_id"],
		doc_anchor: "protocol.md#§5.2",
		detail_keys: ["task_id"]
	},
	SPEC_REVIEW_MISSING: {
		exit_code: 2,
		message_template: "verify-accept check 5: ceremony.strict_spec_review=true requires ≥1 evidence kind=spec-review with result `passed` or `approved` from an actor ≠ implementer; none found",
		fix_template: "have an independent reviewer (not the implementer of done tasks; not a cli:* automation actor) run a spec review and add an evidence:added with kind=spec-review and result `passed` or `approved`. Note: result=waived does NOT count for spec-review (kind=spec-review + result=waived bypasses the human+reason refine guarantee that kind=manual or kind=waiver provides).",
		template_keys: [],
		doc_anchor: "protocol.md#§5.2",
		detail_keys: []
	},
	SPEC_REVIEW_IMPLEMENTER_CONFLICT: {
		exit_code: 2,
		message_template: "verify-accept check 5: every passing spec-review actor is in the implementer set; no independent reviewer signed off (actors={spec_review_actors}, implementers={implementers})",
		fix_template: "have a non-implementer (someone other than the actors on done-task task-summary/local-check evidence) submit an additional evidence with kind=spec-review and result `passed` or `approved`. One independent reviewer is sufficient — implementer self-reviews can coexist.",
		template_keys: ["implementers", "spec_review_actors"],
		doc_anchor: "protocol.md#§5.2",
		detail_keys: ["implementers", "spec_review_actors"]
	},
	SPEC_REVIEW_IMPLEMENTER_UNKNOWN: {
		exit_code: 2,
		message_template: "verify-accept check 5: cannot establish implementer set (all done-task evidence actors are cli:* automation); strict_spec_review fails closed",
		fix_template: "ensure at least one done-task evidence (task-summary or local-check) carries a non-cli:* actor (e.g. human:dev@example.com); the strict_spec_review comparison requires a real implementer identity to compare against. Without it, the gate cannot prove the spec reviewer is independent.",
		template_keys: [],
		doc_anchor: "protocol.md#§5.2",
		detail_keys: []
	},
	DELIVER_NOT_ACCEPTED: {
		exit_code: 2,
		message_template: "deliver requires verify_accepted=true at sub_state={sub_state}; run `loaf gate decide verify-accept --approve` first",
		zh_message_template: "deliver 要求 verify_accepted=true(sub_state={sub_state});先运行 `loaf gate decide verify-accept --approve`",
		fix_template: "run `loaf gate decide verify-accept --approve --reason \"...\"` first; the gate flips snapshot.state.verify_accepted before `loaf deliver` will accept the session:delivered entry",
		template_keys: ["sub_state"],
		doc_anchor: "protocol.md#§5.2",
		detail_keys: ["sub_state"]
	},
	DELIVER_SETTLE_PHASE_BYPASS: {
		exit_code: 2,
		message_template: "deliver from VERIFY.accept requires ceremony.settle_phase=false (standard); deep ceremony must run `loaf settle` first",
		zh_message_template: "VERIFY.accept 直接 deliver 要求 ceremony.settle_phase=false(standard);deep ceremony 必须先运行 `loaf settle`",
		fix_template: "for ceremony.settle_phase=true (deep), run `loaf settle` to enter SETTLE.lessons, record lessons, then `loaf deliver`; only standard ceremony delivers directly from VERIFY.accept",
		template_keys: [],
		doc_anchor: "protocol.md#§5.2",
		detail_keys: []
	},
	DELIVER_VERIFY_MIN_UNAVAILABLE: {
		exit_code: 2,
		message_template: "verify-min was unavailable in this build (ceremony_label={ceremony_label}) — superseded at v0.1.1 by DELIVER_VERIFY_MIN_INCOMPLETE; no longer emitted",
		zh_message_template: "verify-min 在此 build 不可用(ceremony_label={ceremony_label})—— v0.1.1 起由 DELIVER_VERIFY_MIN_INCOMPLETE 取代,已不再触发",
		fix_template: "upgrade to v0.1.1+ where quick / light deliver runs the verify-min per-task evidence check; on failure see DELIVER_VERIFY_MIN_INCOMPLETE",
		template_keys: ["ceremony_label"],
		doc_anchor: "protocol.md#§3",
		detail_keys: ["ceremony_label"]
	},
	DELIVER_VERIFY_MIN_INCOMPLETE: {
		exit_code: 2,
		message_template: "verify-min: {count} done task(s) lack required evidence to deliver (ceremony_label={ceremony_label}); add evidence or waive, then re-deliver",
		zh_message_template: "verify-min:{count} 个 done task 缺少 deliver 所需 evidence(ceremony_label={ceremony_label});补 evidence 或 waive 后重试 deliver",
		fix_template: "for each listed task add evidence covering it — code tasks need a `local-check` (test/lint/typecheck) run, visual-ui needs visual-review or manual, docs needs task-summary or manual — or `loaf waive` it; then `loaf deliver` again",
		template_keys: ["ceremony_label", "count"],
		doc_anchor: "protocol.md#§3",
		detail_keys: ["ceremony_label", "count"]
	},
	DELIVER_SPIKE_TASKS: {
		exit_code: 2,
		message_template: "cannot deliver: task {task_id} is kind=spike (status={status}); spike tasks block delivery for the entire session",
		zh_message_template: "无法 deliver:task {task_id} 是 kind=spike(status={status});spike 任务阻塞整 session 的交付",
		fix_template: "abandon the spike task (`loaf tasks abandon {task_id} --reason \"...\"`) or convert it to a feature (`loaf spike convert --to-feature F-N --reason \"...\"`); spike tasks must not remain in non-abandoned status when the session delivers",
		template_keys: ["status", "task_id"],
		doc_anchor: "protocol.md#§8.3",
		detail_keys: ["status", "task_id"]
	},
	SETTLE_NOT_ACCEPTED: {
		exit_code: 2,
		message_template: "VERIFY.accept → SETTLE.lessons requires verify_accepted=true; run `loaf gate decide verify-accept --approve` before `loaf settle`",
		zh_message_template: "VERIFY.accept → SETTLE.lessons 要求 verify_accepted=true;先运行 `loaf gate decide verify-accept --approve` 再 `loaf settle`",
		fix_template: "run `loaf gate decide verify-accept --approve --reason \"...\"` before `loaf settle`; the gate flips snapshot.state.verify_accepted before the transition validator will admit the SETTLE entry",
		template_keys: [],
		doc_anchor: "protocol.md#§5.2",
		detail_keys: []
	},
	SPEC_LOCK_NOT_SATISFIED: {
		exit_code: 2,
		message_template: "SPEC.design → EXECUTE.plan requires spec_locked=true; run `loaf gate decide spec-lock --approve` before `loaf advance EXECUTE.plan`",
		zh_message_template: "SPEC.design → EXECUTE.plan 要求 spec_locked=true;先运行 `loaf gate decide spec-lock --approve` 再 `loaf advance EXECUTE.plan`",
		fix_template: "run `loaf gate decide spec-lock --approve --reason \"...\"` before `loaf advance EXECUTE.plan`; the gate runs the 8 spec-lock checks and flips snapshot.state.spec_locked before the transition validator will admit the EXECUTE.plan entry",
		template_keys: [],
		doc_anchor: "protocol.md#§5.1",
		detail_keys: []
	},
	TASK_NOT_CLAIMABLE: {
		exit_code: 2,
		message_template: "task {task_id} cannot be claimed (status={status} — terminal state)",
		zh_message_template: "task {task_id} 无法 claim(status={status} — 终态)",
		fix_template: "tasks with status=done are already complete; status=abandoned tasks cannot be reactivated. Run `loaf tasks list` to inspect the task graph, or `loaf tasks next` to pick a different ready task",
		template_keys: ["status", "task_id"],
		doc_anchor: "protocol.md#§10.8",
		detail_keys: ["status", "task_id"]
	},
	TASK_ALREADY_CLAIMED: {
		exit_code: 2,
		message_template: "task {task_id} is already claimed (status=in_progress)",
		zh_message_template: "task {task_id} 已被 claim(status=in_progress)",
		fix_template: "another worker may already hold this task; run `loaf tasks list` to inspect active claims. Stale-claim release is handled in a future slice (no CLI surface for abandon in v0.1.0 yet) — raise a finding with action=fix-impl if needed",
		template_keys: ["task_id"],
		doc_anchor: "protocol.md#§10.8",
		detail_keys: ["task_id"]
	},
	TASK_DEP_NOT_FOUND: {
		exit_code: 2,
		message_template: "task {task_id} field {field} references missing task {ref}",
		zh_message_template: "task {task_id} 的 {field} 引用了不存在的 task {ref}",
		fix_template: "add the referenced task in the same atomic batch, or amend the dependency to an existing task, then retry",
		template_keys: [
			"field",
			"ref",
			"task_id"
		],
		doc_anchor: "protocol.md#§10.8",
		detail_keys: [
			"field",
			"ref",
			"task_id"
		]
	},
	TASK_DEP_SELF: {
		exit_code: 2,
		message_template: "task {task_id} cannot depend on itself",
		zh_message_template: "task {task_id} 不能依赖自身",
		fix_template: "remove the self-reference from depends_on, then retry the task graph mutation",
		template_keys: ["task_id"],
		doc_anchor: "protocol.md#§10.8",
		detail_keys: ["task_id"]
	},
	TASK_DEP_DUPLICATE: {
		exit_code: 2,
		message_template: "task {task_id} repeats dependency {ref} at indexes {indexes}",
		zh_message_template: "task {task_id} 在下标 {indexes} 重复声明依赖 {ref}",
		fix_template: "keep each dependency id only once in depends_on, then retry",
		template_keys: [
			"indexes",
			"ref",
			"task_id"
		],
		doc_anchor: "protocol.md#§10.8",
		detail_keys: [
			"indexes",
			"ref",
			"task_id"
		]
	},
	TASK_DEP_CYCLE: {
		exit_code: 2,
		message_template: "task dependency graph contains cycle {cycle}",
		zh_message_template: "task 依赖图包含环 {cycle}",
		fix_template: "remove or redirect one dependency in the reported closed path, then retry",
		template_keys: ["cycle"],
		doc_anchor: "protocol.md#§10.8",
		detail_keys: ["cycle"],
		list_separator: { cycle: " -> " }
	},
	TASK_DEP_ABANDONED: {
		exit_code: 2,
		message_template: "task {task_id} field {field} references abandoned task {ref}; {hint}",
		zh_message_template: "task {task_id} 的 {field} 引用了已 abandoned 的 task {ref};{hint}",
		fix_template: "use an amend-tasks-sponsored task amendment to replace the abandoned dependency, then retry",
		template_keys: [
			"field",
			"hint",
			"ref",
			"task_id"
		],
		doc_anchor: "protocol.md#§10.8",
		detail_keys: [
			"field",
			"hint",
			"ref",
			"task_id"
		]
	},
	TASK_DEPS_NOT_SATISFIED: {
		exit_code: 2,
		message_template: "task {task_id} cannot be claimed: dependency {blocking_dep} is not done (status={blocking_status})",
		zh_message_template: "task {task_id} 无法 claim:依赖 {blocking_dep} 未 done(status={blocking_status})",
		fix_template: "complete deps_on tasks first (run `loaf tasks list --status pending` to see what is blocking), or use `loaf tasks next` to pick a task with all deps satisfied",
		template_keys: [
			"blocking_dep",
			"blocking_status",
			"task_id"
		],
		doc_anchor: "protocol.md#§10.8",
		detail_keys: [
			"blocking_dep",
			"blocking_status",
			"task_id"
		]
	},
	TASK_NOT_CLAIMED: {
		exit_code: 2,
		message_template: "task {task_id} step {step} mutation requires task.status=in_progress (got status={status}); claim the task first",
		zh_message_template: "task {task_id} step {step} 变更要求 task.status=in_progress(实际 status={status});先 `loaf tasks claim`",
		fix_template: "run `loaf tasks claim {task_id}` to move the task from pending/ready to in_progress before emitting task_step_started or task_step_done; once auto-promoted to done, steps cannot be re-mutated",
		template_keys: [
			"status",
			"step",
			"task_id"
		],
		doc_anchor: "protocol.md#§10.8",
		detail_keys: [
			"status",
			"step",
			"task_id"
		]
	},
	TASK_NOT_ABANDONABLE: {
		exit_code: 2,
		message_template: "task {task_id} cannot be abandoned (status={status} — already in a final status)",
		zh_message_template: "task {task_id} 无法 abandon(status={status} — 已处于终态)",
		fix_template: "tasks with status=done are already complete and status=abandoned tasks are already abandoned; run `loaf tasks list` to inspect the task graph and abandon a non-terminal task instead",
		template_keys: ["status", "task_id"],
		doc_anchor: "protocol.md#§10.8",
		detail_keys: ["status", "task_id"]
	},
	TASK_ABANDON_BLOCKED_DEPENDENTS: {
		exit_code: 2,
		message_template: "task {task_id} cannot be abandoned: non-terminal task(s) {blocking_dependents} depend on it; abandon or complete the dependents first",
		zh_message_template: "task {task_id} 无法 abandon:非终态 task {blocking_dependents} 依赖它;先 abandon 或完成这些依赖方",
		fix_template: "abandon or complete the dependent tasks first (see detail.blocking_dependents), then retry `loaf tasks abandon {task_id} --reason \"...\"`; abandoning a parent would strand a pending child",
		template_keys: ["blocking_dependents", "task_id"],
		doc_anchor: "protocol.md#§10.8",
		detail_keys: ["blocking_dependents", "task_id"]
	},
	SESSION_REASON_REQUIRED: {
		exit_code: 2,
		message_template: "{kind}: --reason is required (the session-terminal entry must record why)",
		zh_message_template: "{kind}:必须提供 --reason(会话终态 entry 必须记录原因)",
		fix_template: "re-run with `--reason \"...\"`; `loaf archive` and `loaf abandon` both require a rationale on the journal entry",
		template_keys: ["kind"],
		doc_anchor: "protocol.md#§10.8",
		detail_keys: ["kind"]
	},
	PROJECTION_WRITE_FAILED: {
		exit_code: 2,
		message_template: "{projection} projection write failed after journal append at last_seq={last_seq} (spec_version={spec_version}): {error}",
		zh_message_template: "{projection} 派生投影在 journal append (last_seq={last_seq}, spec_version={spec_version}) 后写盘失败:{error}",
		fix_template: "the journal already records the change; do NOT retry the same command. Run `loaf doctor --rebuild` (when available) to resync derived projections from journal truth, or inspect `.loaf/<feature>/journal.jsonl` tail manually.",
		template_keys: [
			"error",
			"last_seq",
			"projection",
			"spec_version"
		],
		doc_anchor: "protocol.md#§10.15",
		detail_keys: [
			"error",
			"last_seq",
			"projection",
			"spec_version"
		]
	},
	FINDING_AMEND_SPEC_NOT_LOCKED: {
		exit_code: 2,
		message_template: "finding raise action=amend-spec requires state.spec_locked=true; spec is not locked at sub_state={current_sub_state}, edit directly via `loaf spec submit / add-*`",
		zh_message_template: "finding raise action=amend-spec 要求 state.spec_locked=true;当前 sub_state={current_sub_state} 下 spec 未锁,请直接使用 `loaf spec submit / add-*`",
		fix_template: "drop --action amend-spec and use `loaf spec submit` / `loaf spec add-req` / etc. directly while spec is unlocked; amend-spec is reserved for post-`gate decide spec-lock --approve` recovery.",
		template_keys: ["current_sub_state"],
		doc_anchor: "protocol.md#§6.1",
		detail_keys: ["current_sub_state"]
	},
	SPEC_VERSION_NOT_MONOTONIC: {
		exit_code: 2,
		message_template: "{kind}: spec_version must be {expected_spec_version} (current+1), got {payload_spec_version}",
		zh_message_template: "{kind}: spec_version 必须等于 {expected_spec_version}(current+1),实际为 {payload_spec_version}",
		fix_template: "set spec_version to {expected_spec_version} in the input payload (or omit it and let `loaf spec submit` fill the current+1 default).",
		template_keys: [
			"expected_spec_version",
			"kind",
			"payload_spec_version"
		],
		doc_anchor: "protocol.md#§4.2",
		detail_keys: [
			"expected_spec_version",
			"kind",
			"payload_spec_version"
		]
	},
	SPEC_VERSION_BATCH_MISMATCH: {
		exit_code: 2,
		message_template: "{kind}: spec_version must be {current_spec_version} at batch_index={batch_index}, got {payload_spec_version}",
		zh_message_template: "{kind}: batch_index={batch_index} 处 spec_version 必须等于 {current_spec_version},实际为 {payload_spec_version}",
		fix_template: "in a multi-entry spec batch, the head (batch_index=0) bumps spec_version to current+1 and all continuation entries (batch_index≥1) must set spec_version to that same value. Check the head entry's payload.spec_version and align companions.",
		template_keys: [
			"batch_index",
			"current_spec_version",
			"kind",
			"payload_spec_version"
		],
		doc_anchor: "protocol.md#§4.2",
		detail_keys: [
			"batch_index",
			"current_spec_version",
			"kind",
			"payload_spec_version"
		]
	},
	TASK_COMPLETE_PRECONDITION_VIOLATED: {
		exit_code: 2,
		message_template: "task {task_id} is not complete (status={status}); must-applicable steps not terminal-positive: {blocking_steps}",
		zh_message_template: "task {task_id} 尚未完成(status={status});以下 must 级 step 未达 terminal-positive:{blocking_steps}",
		fix_template: "finish each blocking step via `loaf tasks step start/done`; a task auto-promotes to status=done once every must-applicable step is passed/waived/na, and `loaf tasks complete` then confirms it. Run `loaf tasks list` to inspect step status.",
		template_keys: [
			"blocking_steps",
			"status",
			"task_id"
		],
		doc_anchor: "protocol.md#§10.8",
		detail_keys: [
			"blocking_steps",
			"status",
			"task_id"
		]
	},
	BUG_TASK_REQUIRES_RED: {
		exit_code: 2,
		message_template: "behavioral bug task {task_id} cannot start or complete its implement step before its RED test is registered",
		zh_message_template: "behavioral bug task {task_id} 在注册 RED 测试前不能开始或完成 implement step",
		fix_template: "run `loaf tasks register-red {task_id}` once the failing RED test is in place; protocol §9.3 requires RED registration before the implement step of a behavioral task labelled `bug`.",
		template_keys: ["task_id"],
		doc_anchor: "protocol.md#§9.3",
		detail_keys: ["task_id"]
	},
	BUG_TASK_FLAG_MISUSE: {
		exit_code: 2,
		message_template: "task {task_id}: red_test_registered=true is valid only on a red-step task_step_done for a behavioral bug task (passed/waived result) — not on this entry",
		zh_message_template: "task {task_id}:red_test_registered=true 只在 behavioral bug task 的 red-step task_step_done(passed/waived)上有效 —— 不能用在本 entry",
		fix_template: "do not set red_test_registered in a planned task or on a non-red step; the flag is owned by `loaf tasks register-red`, which the reducer promotes to task-level registration.",
		template_keys: ["task_id"],
		doc_anchor: "protocol.md#§9.3",
		detail_keys: ["task_id"]
	},
	BUG_TASK_RED_NOT_REGISTERED: {
		exit_code: 2,
		message_template: "behavioral bug task {task_id} is done but never registered its RED test (red_test_registered≠true)",
		zh_message_template: "behavioral bug task {task_id} 已 done 但从未注册 RED 测试(red_test_registered≠true)",
		fix_template: "a done behavioral bug task must have registered its RED test via `loaf tasks register-red`; this is a verify-accept defense-in-depth check for raw-API journals — rebuild the journal or register RED retroactively before re-running the gate.",
		template_keys: ["task_id"],
		doc_anchor: "protocol.md#§9.3",
		detail_keys: ["task_id"]
	},
	SPIKE_CONVERT_NO_SPIKE_TASK: {
		exit_code: 2,
		message_template: "cannot convert: the session has no non-abandoned spike task; `loaf spike convert` is a spike-task exit (protocol §8.3)",
		zh_message_template: "无法 convert:session 没有非-abandoned 的 spike task;`loaf spike convert` 是 spike-task 出口(protocol §8.3)",
		fix_template: "run `loaf spike convert` only from a session that holds a kind=spike task; for a non-spike session close it with `loaf archive --reason \"...\"` or `loaf abandon --reason \"...\"`",
		template_keys: [],
		doc_anchor: "protocol.md#§8.3",
		detail_keys: []
	},
	SNAPSHOT_STALE_REBUILD_REQUIRED: {
		exit_code: 2,
		message_template: "snapshot stale (reason={reason}); run `loaf doctor --rebuild --feature <feature>` to re-serialize from journal truth",
		zh_message_template: "snapshot 失效(reason={reason});跑 `loaf doctor --rebuild --feature <feature>` 从 journal 重建",
		fix_template: "snapshot meta/leaves no longer agree with the journal tail; run `loaf doctor --rebuild --feature <feature>` to re-serialize from journal truth, then retry. Inspect detail.reason + reason-specific fields (meta_path / projection_kind / cause) to triage corruption source before rebuilding.",
		template_keys: ["reason"],
		doc_anchor: "protocol.md#§10.15",
		detail_keys: ["reason"]
	},
	JOURNAL_TAIL_REQUIRES_NEWER_LOAF: {
		exit_code: 2,
		message_template: "tail recovery refused at seq {seq}: journal kind {kind} uses entry schema {entry_schema_version} ({reason})",
		zh_message_template: "tail recovery 已拒绝:seq {seq} 的 journal kind {kind} 使用 entry schema {entry_schema_version} ({reason})",
		fix_template: "preserve journal.jsonl byte-for-byte and upgrade loaf to a version that understands this entry before running tail recovery again",
		zh_fix_template: "保持 journal.jsonl 字节不变，升级到能识别该 entry 的 loaf 版本后再运行 tail recovery",
		template_keys: [
			"entry_schema_version",
			"kind",
			"reason",
			"seq"
		],
		detail_keys: [
			"entry_schema_version",
			"kind",
			"reason",
			"seq"
		],
		doc_anchor: "protocol.md#§10.15"
	},
	INVALID_PRESET: {
		exit_code: 2,
		message_template: "invalid ceremony preset",
		zh_message_template: "ceremony preset 不合法",
		fix_template: "Use one of quick, light, standard, or deep.",
		template_keys: [],
		doc_anchor: "protocol.md#§10.5",
		detail_keys: []
	},
	USAGE: {
		exit_code: 2,
		message_template: "invalid CLI usage",
		zh_message_template: "CLI 用法不合法",
		fix_template: "Run the command with --help and retry with the required flags/arguments.",
		template_keys: [],
		doc_anchor: "protocol.md#§10.5",
		detail_keys: [],
		variants: {
			"failure.sessions_list.selector_conflict": {
				message_template: "sessions list does not accept {conflicting} — it lists across all sessions; use --in-cwd to filter",
				zh_message_template: "sessions list 不接受 {conflicting} —— 它会跨全部 session 列表;如需过滤当前 cwd,使用 --in-cwd",
				fix_template: "Run the command with --help and retry with the required flags/arguments.",
				template_keys: ["conflicting"],
				detail_keys: ["conflicting"],
				doc_anchor: "protocol.md#§10.5"
			},
			"failure.tui.selector_conflict": {
				message_template: "tui does not accept {conflicting} — it lists across all sessions; selectors are nonsensical for an interactive UI",
				zh_message_template: "tui 不接受 {conflicting} —— 它会跨全部 session 列表;selector 对交互 UI 没有意义",
				fix_template: "Run the command with --help and retry with the required flags/arguments.",
				template_keys: ["conflicting"],
				detail_keys: ["conflicting"],
				doc_anchor: "protocol.md#§10.5"
			},
			"failure.tui.interactive_only": {
				message_template: "tui is interactive-only; use `loaf sessions list --format json` for scriptable session output",
				zh_message_template: "tui 仅支持交互模式;脚本化 session 输出请使用 `loaf sessions list --format json`",
				fix_template: "Run the command with --help and retry with the required flags/arguments.",
				template_keys: [],
				detail_keys: [],
				doc_anchor: "protocol.md#§10.5"
			},
			"failure.hook.missing_event": {
				message_template: "loaf hook requires an event token; one of: {events}. Run `loaf hook --list-events` for the full enum",
				zh_message_template: "loaf hook 需要 event token;可选值:{events}. 运行 `loaf hook --list-events` 查看完整枚举",
				fix_template: "Run the command with --help and retry with the required flags/arguments.",
				template_keys: ["events"],
				detail_keys: ["events"],
				doc_anchor: "protocol.md#§10.5"
			},
			"failure.hook.unknown_event": {
				message_template: "unknown hook event '{event}'; expected one of: {allowed}. Did you mean '{suggestion}'?",
				zh_message_template: "未知 hook event '{event}';期望值:{allowed}. 你是不是想输入 '{suggestion}'?",
				fix_template: "Run the command with --help and retry with the required flags/arguments.",
				template_keys: [
					"allowed",
					"event",
					"suggestion"
				],
				detail_keys: [
					"allowed",
					"event",
					"suggestion"
				],
				doc_anchor: "protocol.md#§10.5"
			},
			"failure.hook.write_path_missing": {
				message_template: "write-side hook requires --path <P> or a non-TTY stdin hook payload (tool_input.file_path)",
				zh_message_template: "write-side hook 需要 --path <P> 或非 TTY stdin hook payload(tool_input.file_path)",
				fix_template: "Run the command with --help and retry with the required flags/arguments.",
				template_keys: [],
				detail_keys: [],
				doc_anchor: "protocol.md#§10.5"
			},
			"failure.check.selector_conflict": {
				message_template: "check does not accept {conflicting} — it validates a file by path, independent of any feature session",
				zh_message_template: "check 不接受 {conflicting} —— 它按路径校验文件,独立于 feature session",
				fix_template: "Run the command with --help and retry with the required flags/arguments.",
				template_keys: ["conflicting"],
				detail_keys: ["conflicting"],
				doc_anchor: "protocol.md#§10.5"
			},
			"failure.check.kind_required": {
				message_template: "`{subject}` is not a file path. To validate a {kind} artifact, pass its path: `{suggestion}` (noun-first `loaf {kind} check` is reserved for a future release)",
				zh_message_template: "`{subject}` 不是文件路径. 如需校验 {kind} artifact,需要显式路径: `{suggestion}`(noun-first `loaf {kind} check` 预留给未来版本)",
				fix_template: "Run the command with --help and retry with the required flags/arguments.",
				template_keys: [
					"kind",
					"subject",
					"suggestion"
				],
				detail_keys: [
					"kind",
					"subject",
					"suggestion"
				],
				doc_anchor: "protocol.md#§10.5"
			},
			"failure.check.kind_invalid": {
				message_template: "--kind '{value}' is not recognized; expected one of {allowed_kinds_human}",
				zh_message_template: "--kind 必须是 {allowed_kinds_human};当前为 '{value}'",
				fix_template: "Run the command with --help and retry with the required flags/arguments.",
				template_keys: ["allowed_kinds_human", "value"],
				detail_keys: ["allowed_kinds_human", "value"],
				doc_anchor: "protocol.md#§10.5"
			},
			"failure.schema.selector_conflict": {
				message_template: "{subject} does not accept {conflicting} — schema dumps are feature-agnostic",
				zh_message_template: "{subject} 不接受 {conflicting} —— schema dump 与 feature 无关",
				fix_template: "Run the command with --help and retry with the required flags/arguments.",
				template_keys: ["conflicting", "subject"],
				detail_keys: ["conflicting", "subject"],
				doc_anchor: "protocol.md#§10.5"
			},
			"failure.dispatch.session_feature_dir_conflict": {
				message_template: "{conflicting} cannot be combined with --feature-dir (session identity comes from registry; manual featureDir is contradictory)",
				zh_message_template: "{conflicting} 不能与 --feature-dir 一起使用(session identity 来自 registry;手动 featureDir 会矛盾)",
				fix_template: "Run the command with --help and retry with the required flags/arguments.",
				template_keys: ["conflicting"],
				detail_keys: ["conflicting"],
				doc_anchor: "protocol.md#§10.5"
			},
			"failure.dispatch.feature_dir_requires_feature": {
				message_template: "--feature-dir requires --feature <name> or $LOAF_FEATURE to name the feature",
				zh_message_template: "--feature-dir 需要 --feature <name> 或 $LOAF_FEATURE 来命名 feature",
				fix_template: "Run the command with --help and retry with the required flags/arguments.",
				template_keys: [],
				detail_keys: [],
				doc_anchor: "protocol.md#§10.5"
			},
			"failure.start.label_too_short": {
				message_template: "--label must be at least {min_length} characters",
				zh_message_template: "--label 至少需要 {min_length} 个字符",
				fix_template: "Run the command with --help and retry with the required flags/arguments.",
				template_keys: ["min_length"],
				detail_keys: ["min_length"],
				doc_anchor: "protocol.md#§10.5"
			},
			"failure.start.workspace_empty": {
				message_template: "--workspace must not be empty",
				zh_message_template: "--workspace 不能为空",
				fix_template: "Run the command with --help and retry with the required flags/arguments.",
				template_keys: [],
				detail_keys: [],
				doc_anchor: "protocol.md#§10.5"
			},
			"failure.handoff.reason_too_short": {
				message_template: "--reason must be ≥{min_length} chars (got {reason_length})",
				zh_message_template: "--reason 必须 ≥{min_length} 字符(当前 {reason_length})",
				fix_template: "Run the command with --help and retry with the required flags/arguments.",
				template_keys: ["min_length", "reason_length"],
				detail_keys: ["min_length", "reason_length"],
				doc_anchor: "protocol.md#§10.5"
			},
			"failure.lessons.text_too_short": {
				message_template: "lesson text must be ≥{min_length} chars (got {lesson_text_length})",
				zh_message_template: "lesson text 必须 ≥{min_length} 字符(当前 {lesson_text_length})",
				fix_template: "Run the command with --help and retry with the required flags/arguments.",
				template_keys: ["lesson_text_length", "min_length"],
				detail_keys: ["lesson_text_length", "min_length"],
				doc_anchor: "protocol.md#§10.5"
			},
			"failure.lessons.reason_too_short": {
				message_template: "--reason must be ≥{min_length} chars (got {reason_length})",
				zh_message_template: "--reason 必须 ≥{min_length} 字符(当前 {reason_length})",
				fix_template: "Run the command with --help and retry with the required flags/arguments.",
				template_keys: ["min_length", "reason_length"],
				detail_keys: ["min_length", "reason_length"],
				doc_anchor: "protocol.md#§10.5"
			},
			"failure.lessons.text_file_mutex": {
				message_template: "exactly one of --text or --file required ({provided_state})",
				zh_message_template: "--text 和 --file 必须二选一({provided_state})",
				fix_template: "Run the command with --help and retry with the required flags/arguments.",
				template_keys: ["provided_state"],
				detail_keys: ["provided_state"],
				doc_anchor: "protocol.md#§10.5"
			},
			"failure.finding.status_invalid": {
				message_template: "--status must be one of: {allowed_statuses_human} (got {value})",
				zh_message_template: "--status 必须是:{allowed_statuses_human}(当前 {value})",
				fix_template: "Run the command with --help and retry with the required flags/arguments.",
				template_keys: ["allowed_statuses_human", "value"],
				detail_keys: ["allowed_statuses_human", "value"],
				doc_anchor: "protocol.md#§10.5"
			},
			"failure.journal.integer_invalid": {
				message_template: "{flag} must be an integer >= {minimum} (got {value})",
				zh_message_template: "{flag} 必须是 >= {minimum} 的整数(当前 {value})",
				fix_template: "Run the command with --help and retry with the required flags/arguments.",
				template_keys: [
					"flag",
					"minimum",
					"value"
				],
				detail_keys: [
					"flag",
					"minimum",
					"value"
				],
				doc_anchor: "protocol.md#§10.5"
			},
			"failure.journal.kind_invalid": {
				message_template: "--kind must be a registered journal kind (got {value})",
				zh_message_template: "--kind 必须是已注册的 journal kind(当前 {value})",
				fix_template: "Run the command with --help and retry with the required flags/arguments.",
				template_keys: ["value"],
				detail_keys: ["value"],
				doc_anchor: "protocol.md#§10.5"
			},
			"failure.journal.actor_invalid": {
				message_template: "--actor must be a non-empty actor prefix or full actor string",
				zh_message_template: "--actor 必须是非空 actor 前缀或完整 actor 字符串",
				fix_template: "Run the command with --help and retry with the required flags/arguments.",
				template_keys: [],
				detail_keys: [],
				doc_anchor: "protocol.md#§10.5"
			},
			"failure.evidence.covers_invalid": {
				message_template: "--covers must be a valid coverage id (got {value})",
				zh_message_template: "--covers 必须是有效的 coverage id(当前 {value})",
				fix_template: "Run the command with --help and retry with the required flags/arguments.",
				template_keys: ["value"],
				detail_keys: ["value"],
				doc_anchor: "protocol.md#§10.5"
			},
			"failure.evidence.task_invalid": {
				message_template: "--task must be a valid task id (got {value})",
				zh_message_template: "--task 必须是有效的 task id(当前 {value})",
				fix_template: "Run the command with --help and retry with the required flags/arguments.",
				template_keys: ["value"],
				detail_keys: ["value"],
				doc_anchor: "protocol.md#§10.5"
			},
			"failure.evidence.kind_invalid": {
				message_template: "--kind must be one of: {allowed_kinds_human}",
				zh_message_template: "--kind 必须是:{allowed_kinds_human}",
				fix_template: "Run the command with --help and retry with the required flags/arguments.",
				template_keys: ["allowed_kinds_human"],
				detail_keys: ["allowed_kinds_human"],
				doc_anchor: "protocol.md#§10.5"
			}
		}
	},
	DOCTOR_MODE_NOT_IMPLEMENTED: {
		exit_code: 2,
		message_template: "requested loaf doctor mode is not implemented in this release",
		zh_message_template: "当前发布版本未实现该 loaf doctor 模式",
		fix_template: "Use loaf doctor --rebuild --feature <name>; other doctor modes are deferred.",
		template_keys: [],
		doc_anchor: "protocol.md#§10.15",
		detail_keys: []
	},
	DOCTOR_FEATURE_REQUIRED: {
		exit_code: 2,
		message_template: "loaf doctor --rebuild requires --feature <name>",
		zh_message_template: "loaf doctor --rebuild 必须带 --feature <name>",
		fix_template: "Pass --feature <name> or --feature-dir <path> for the session to rebuild.",
		template_keys: [],
		doc_anchor: "protocol.md#§10.15",
		detail_keys: []
	},
	DOCTOR_REBUILD_FAILED: {
		exit_code: 2,
		message_template: "doctor --rebuild failed",
		zh_message_template: "doctor --rebuild 失败",
		fix_template: "Inspect the emitted error message; fix the journal/projection issue, then rerun doctor --rebuild.",
		template_keys: [],
		doc_anchor: "protocol.md#§10.15",
		detail_keys: []
	},
	REDUCER_ERROR: {
		exit_code: 2,
		message_template: "internal reducer invariant failed",
		zh_message_template: "reducer 内部不变量失败",
		fix_template: "Preserve the journal and command stderr; this indicates a loaf-cli bug or inconsistent projection state.",
		template_keys: [],
		doc_anchor: "protocol.md#§10.5",
		detail_keys: []
	},
	APPEND_ERROR: {
		exit_code: 2,
		message_template: "journal append failed",
		fix_template: "preserve journal.jsonl and the emitted detail, then inspect the append error before retrying; if a write may have started, run `loaf doctor` to verify journal integrity",
		template_keys: [],
		detail_keys: [],
		doc_anchor: "protocol.md#§11.2"
	},
	SIDECAR_ERROR: {
		exit_code: 2,
		message_template: "sidecar finalize failed: {err}",
		fix_template: "inspect the emitted error and attachment path permissions; validation already passed, so remove any orphan sidecar residue before retrying",
		template_keys: ["err"],
		detail_keys: ["err"],
		doc_anchor: "protocol.md#§11.2"
	},
	INVALID_BATCH: {
		exit_code: 2,
		message_template: "mutation batch is invalid",
		fix_template: "rebuild the batch through the CLI mutator without caller-owned envelope fields and with entries + meta matching the current journal tail",
		template_keys: [],
		detail_keys: [],
		doc_anchor: "protocol.md#§11.2"
	},
	SCOPE_RECORDED_BATCH_INVALID: {
		exit_code: 2,
		message_template: "scope:recorded batch is invalid: {reason}",
		zh_message_template: "scope:recorded 批次无效:{reason}",
		fix_template: "emit at most one scope:recorded immediately before exactly one EXECUTE.work to EXECUTE.done transition in the same batch",
		template_keys: ["reason"],
		detail_keys: ["reason"],
		doc_anchor: "protocol.md#§4.6"
	},
	SCOPE_RECORDED_ITERATION_DUPLICATE: {
		exit_code: 2,
		message_template: "scope:recorded already exists for iteration {iteration}",
		zh_message_template: "iteration {iteration} 已存在 scope:recorded",
		fix_template: "reuse the recorded closure result for this iteration or advance through a finding back-edge before recording a new closure",
		template_keys: ["iteration"],
		detail_keys: ["iteration"],
		doc_anchor: "protocol.md#§4.6"
	},
	ACTUAL_SCOPE_HISTORY_INCOMPLETE: {
		exit_code: 2,
		message_template: "actual scope history is incomplete: EXECUTE closure transition(s) at seq {transition_seqs} have no same-batch scope:recorded marker",
		zh_message_template: "actual scope 历史不完整:seq {transition_seqs} 的 EXECUTE closure transition 缺少同批 scope:recorded marker",
		fix_template: "do not fabricate an empty actual_scope; preserve the journal and rerun the feature's EXECUTE work with an F-027-capable loaf version before auditing scope. Pre-F-027 closure scope cannot be reconstructed from journal history.",
		zh_fix_template: "不要伪造空 actual_scope;保留 journal,使用支持 F-027 的 loaf 版本重新执行该 feature 的 EXECUTE work 后再审计 scope。pre-F-027 closure scope 无法从 journal 历史重建。",
		template_keys: ["transition_seqs"],
		detail_keys: ["transition_seqs"],
		doc_anchor: "protocol.md#§4.6"
	},
	WRITE_PATH_VIOLATION: {
		exit_code: 2,
		message_template: "write blocked: `{normalized_path}` is outside the allowed write paths for sub_state `{sub_state}`",
		zh_message_template: "写入被拦截:`{normalized_path}` 不在 sub_state `{sub_state}` 的允许写入路径内",
		fix_template: "write within the current step's contract, advance to the right sub_state/step first, or widen the matching `paths.*` category in .loaf/.config/loaf.config.json",
		template_keys: ["normalized_path", "sub_state"],
		doc_anchor: "protocol.md#§11.1",
		detail_keys: ["normalized_path", "sub_state"]
	},
	PROTECTED_FILE_WRITE: {
		exit_code: 2,
		message_template: "write blocked: `{normalized_path}` matches protected_files entry `{matched_deny}` — protected files are never writable",
		zh_message_template: "写入被拦截:`{normalized_path}` 命中 protected_files 条目 `{matched_deny}` —— 受保护文件永不可写",
		fix_template: "remove the entry from protected_files in .loaf/.config/loaf.config.json if the protection is wrong, otherwise write a different file",
		template_keys: ["matched_deny", "normalized_path"],
		doc_anchor: "protocol.md#§11.1",
		detail_keys: ["matched_deny", "normalized_path"]
	}
};
/** Constructs a catalog diagnostic while checking its required detail keys. */
function diagnostic$2(code, detail) {
	return {
		code,
		detail
	};
}
/** Derived index, not a second registry. Variant code membership comes from
* its parent catalog entry; context names are the existing failure sites. */
const DIAGNOSTIC_VARIANTS = Object.fromEntries(Object.entries(ERROR_CATALOG).flatMap(([code, entry]) => "variants" in entry ? Object.entries(entry.variants).map(([context, template]) => [context, {
	code,
	template
}]) : []));
/** Constructs an ambiguous existing site without replacing its subcode.
* Context is added only for catalog variants, never ordinary code records. */
function diagnosticVariant(context, detail) {
	return {
		code: DIAGNOSTIC_VARIANTS[context].code,
		detail: {
			...detail,
			context
		}
	};
}
const DIAGNOSTIC_CODE_VALUES = Object.keys(ERROR_CATALOG);
z.enum(DIAGNOSTIC_CODE_VALUES);
/** Canonical event list — frozen order for stable `--list-events` output
*  and unknown-event did-you-mean ranking. */
const HOOK_EVENTS = z.enum([
	"session-start",
	"write-guard",
	"scope-track",
	"closure-check"
]).options;
/** Map each hook event to its Claude Code wire-protocol event name.
*  Canonical Claude Code protocol mapping. */
const HOOK_EVENT_TO_CLAUDE_CODE = {
	"session-start": "SessionStart",
	"write-guard": "PreToolUse(Write,Edit)",
	"scope-track": "PostToolUse(Write,Edit)",
	"closure-check": "Stop"
};
//#endregion
//#region src/cli/argv-bootstrap.ts
/** Bootstrap positional view: tokens after `--` are literal operands.
* Retain pre-boundary consumption of a value-taking flag's next token.
*/
function bootstrapCommandTokens(argv, max, valueFlags) {
	const out = [];
	let consumedThrough = 1;
	let positionalOnly = false;
	for (const token of scanArgv(argv, valueFlags)) {
		if (!positionalOnly && token.kind === "terminator") {
			positionalOnly = true;
			continue;
		}
		if (positionalOnly) {
			out.push(token.raw);
			if (out.length >= max) break;
			continue;
		}
		if (token.index <= consumedThrough) continue;
		if (token.kind === "option") {
			if (token.raw.startsWith("--") && token.arity === 1 && !token.raw.includes("=")) consumedThrough = token.index + 1;
			continue;
		}
		out.push(token.raw);
		if (out.length >= max) break;
	}
	return out;
}
//#endregion
//#region src/cli/selectors.ts
function collectPresentSelectors(argv, env) {
	const selectors = [];
	const tokens = scanArgv(optionArgv(argv));
	if (tokens.some((token) => token.kind === "option" && token.flag === "--session")) selectors.push("--session");
	if (tokens.some((token) => token.kind === "option" && token.flag === "--feature")) selectors.push("--feature");
	if (tokens.some((token) => token.kind === "option" && token.flag === "--feature-dir")) selectors.push("--feature-dir");
	if (env["LOAF_SESSION"] !== void 0 && env["LOAF_SESSION"].length > 0) selectors.push("$LOAF_SESSION");
	if (env["LOAF_FEATURE"] !== void 0 && env["LOAF_FEATURE"].length > 0) selectors.push("$LOAF_FEATURE");
	return selectors;
}
//#endregion
//#region src/cli/command-policy.ts
const policies = /* @__PURE__ */ new WeakMap();
/** Attach policy to the actual registered command; aliases share its identity. */
function declareCommandPolicy(command, policy) {
	if (policies.has(command)) throw new Error(`command policy declared twice: ${command.name()}`);
	policies.set(command, policy);
	return command;
}
function commandPolicy(command) {
	return policies.get(command);
}
function commandPolicyInventory(program) {
	const rows = [];
	function visit(parent, prefix) {
		for (const command of parent.commands) {
			const path = `${prefix}${command.name()}`;
			rows.push({
				command,
				path,
				policy: commandPolicy(command)
			});
			visit(command, `${path} `);
		}
	}
	visit(program, "");
	return rows;
}
function assertLeafCommandPolicies(program) {
	const missing = commandPolicyInventory(program).filter(({ command, policy }) => command.commands.length === 0 && policy === void 0);
	if (missing.length > 0) throw new Error(`missing command policy: ${missing.map(({ path }) => path).join(", ")}`);
}
/** Preserve the existing bootstrap view's arities, derived from registrations.
* Other command-local options do not become global bootstrap options.
*/
function bootstrapValueFlags(program) {
	const flags = /* @__PURE__ */ new Set();
	for (const command of [program, ...program.commands.filter((command) => commandPolicy(command)?.selectors === "start")]) for (const option of command.options) if (option.required && option.long) flags.add(option.long);
	for (const { command, policy } of commandPolicyInventory(program)) {
		if (policy?.selectors !== "selected") continue;
		for (const option of command.options) if (option.required && (option.long === "--feature" || option.long === "--feature-dir")) flags.add(option.long);
	}
	return flags;
}
/** Command-specific pre-parse checks, ordered ahead of generic dispatch misuse. */
function evaluateCommandPreparse(program, argv, env) {
	const tokens = bootstrapCommandTokens(argv, 2, bootstrapValueFlags(program));
	const root = program.commands.find((command) => command.name() === tokens[0] || command.aliases().includes(tokens[0] ?? ""));
	const selected = root?.commands.find((command) => command.name() === tokens[1] || command.aliases().includes(tokens[1] ?? "")) ?? root;
	const policy = selected === void 0 ? void 0 : commandPolicy(selected);
	const selectors = collectPresentSelectors(argv, env);
	const fail = (diagnostic) => ({
		kind: "failure",
		diagnostic
	});
	if (policy?.selectorFailure && selectors.length > 0) return fail(diagnosticVariant(policy.selectorFailure, { conflicting: selectors }));
	if (policy?.interactiveFormat && optionArgv(argv).some((arg) => arg === "--format" || arg.startsWith("--format="))) return fail(diagnosticVariant("failure.tui.interactive_only", { reason: "tui-interactive-only" }));
	if (policy?.selectors === "optional-hook") {
		if (optionArgv(argv).includes("--list-events")) return { kind: "hook-events" };
		const event = tokens[1];
		if (event === void 0) return fail(diagnosticVariant("failure.hook.missing_event", { events: HOOK_EVENTS }));
		if (!HOOK_EVENTS.includes(event)) return fail(diagnosticVariant("failure.hook.unknown_event", {
			event,
			allowed: HOOK_EVENTS,
			suggestion: HOOK_EVENTS.find((known) => known.startsWith(event.slice(0, 4))) ?? HOOK_EVENTS[0]
		}));
	}
	if ((policy?.schema?.kind === "artifact" || policy?.schema?.kind === "input" && optionArgv(argv).includes("--schema")) && selectors.length > 0) return fail(diagnosticVariant("failure.schema.selector_conflict", {
		subject: `${tokens.join(" ")}${policy?.schema?.kind === "input" ? " --schema" : ""}`,
		conflicting: selectors
	}));
	if (selectors.includes("--feature-dir") && policy?.selectors !== "start") {
		const conflicting = selectors.filter((selector) => selector === "--session" || selector === "$LOAF_SESSION");
		if (conflicting.length > 0) return fail(diagnosticVariant("failure.dispatch.session_feature_dir_conflict", { conflicting: [...conflicting, "--feature-dir"] }));
		if (!selectors.includes("--feature") && !selectors.includes("$LOAF_FEATURE")) return fail(diagnosticVariant("failure.dispatch.feature_dir_requires_feature", { conflicting: ["--feature-dir"] }));
	}
	return { kind: "continue" };
}
function renderHookEvents(json) {
	return json ? `${JSON.stringify({
		ok: true,
		count: HOOK_EVENTS.length,
		events: HOOK_EVENTS.map((event) => ({
			event,
			claude_code: HOOK_EVENT_TO_CLAUDE_CODE[event]
		}))
	})}\n` : HOOK_EVENTS.map((event) => `${event}\t${HOOK_EVENT_TO_CLAUDE_CODE[event]}\n`).join("");
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
z.enum([
	"ubiquitous",
	"event-driven",
	"state-driven",
	"optional",
	"unwanted"
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
const SpecEditInput = z.object({ body: z.string() }).strict();
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
}).strict();
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
const TaskKind = z.enum([
	"behavioral",
	"structural",
	"visual-ui",
	"docs",
	"spike",
	"chore"
]);
const TaskIdPayload = z.string().regex(/^T-\d{3,}$/);
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
	started_at: z.string().datetime().optional()
}).strict();
const BehavioralExecutionPayload = z.object({
	red: TaskExecutionStepPayload,
	implement: TaskExecutionStepPayload,
	refactor: TaskExecutionStepPayload
}).strict();
const StructuralExecutionPayload = z.object({
	implement: TaskExecutionStepPayload,
	refactor: TaskExecutionStepPayload
}).strict();
const VisualUiExecutionPayload = z.object({
	mockup: TaskExecutionStepPayload,
	implement: TaskExecutionStepPayload,
	"screenshot-compare": TaskExecutionStepPayload
}).strict();
const DocsExecutionPayload = z.object({
	draft: TaskExecutionStepPayload,
	review: TaskExecutionStepPayload
}).strict();
const SpikeExecutionPayload = z.object({
	explore: TaskExecutionStepPayload,
	prototype: TaskExecutionStepPayload,
	record: TaskExecutionStepPayload
}).strict();
const ChoreExecutionPayload = z.object({ execute: TaskExecutionStepPayload }).strict();
const BehavioralStep = BehavioralExecutionPayload.keyof();
const StructuralStep = StructuralExecutionPayload.keyof();
const VisualUiStep = VisualUiExecutionPayload.keyof();
const DocsStep = DocsExecutionPayload.keyof();
const SpikeStep = SpikeExecutionPayload.keyof();
const ChoreStep = ChoreExecutionPayload.keyof();
z.union([
	BehavioralStep,
	StructuralStep,
	VisualUiStep,
	DocsStep,
	SpikeStep,
	ChoreStep
]);
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
	kind: z.literal(TaskKind.enum.behavioral),
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
	kind: z.literal(TaskKind.enum.structural),
	drives: z.array(RawDrivesRef).optional(),
	no_test_rationale: z.string().min(10),
	execution: StructuralExecutionPayload
});
const TaskVisualUiPayload = TaskBase.extend({
	kind: z.literal(TaskKind.enum["visual-ui"]),
	drives: z.array(RawDrivesRef).optional(),
	visual_contract_refs: z.array(VisIdPayload).min(1),
	no_test_rationale: z.string().min(10).optional(),
	execution: VisualUiExecutionPayload
});
const TaskDocsPayload = TaskBase.extend({
	kind: z.literal(TaskKind.enum.docs),
	drives: z.array(RawDrivesRef).optional(),
	no_test_rationale: z.string().min(10),
	execution: DocsExecutionPayload
});
const TaskSpikePayload = TaskBase.extend({
	kind: z.literal(TaskKind.enum.spike),
	drives: z.array(RawDrivesRef).optional(),
	no_test_rationale: z.string().min(10),
	execution: SpikeExecutionPayload
});
const TaskChorePayload = TaskBase.extend({
	kind: z.literal(TaskKind.enum.chore),
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
* (tests / test_layer / execution.reason / started_at) stay in the journal
* payload as canonical truth — only cross-cutting fields needed by spec-lock
* checks + auto-promote land in the projection.
*/
function extractTaskSlim(t) {
	const out = {
		id: t.id,
		kind: t.kind,
		status: t.status,
		steps: extractTaskSteps(t.execution),
		drives: t.drives ?? [],
		depends_on: t.depends_on ?? [],
		labels: t.labels ?? []
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
	kind: z.literal(TaskKind.enum.behavioral),
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
	kind: z.literal(TaskKind.enum.structural),
	no_test_rationale: z.string().min(10)
}).strict();
const TaskVisualUiInput = z.object({
	...TaskInputBaseShape,
	kind: z.literal(TaskKind.enum["visual-ui"]),
	visual_contract_refs: z.array(VisIdPayload).min(1),
	no_test_rationale: z.string().min(10).optional()
}).strict();
const TaskDocsInput = z.object({
	...TaskInputBaseShape,
	kind: z.literal(TaskKind.enum.docs),
	no_test_rationale: z.string().min(10)
}).strict();
const TaskSpikeInput = z.object({
	...TaskInputBaseShape,
	kind: z.literal(TaskKind.enum.spike),
	no_test_rationale: z.string().min(10)
}).strict();
const TaskChoreInput = z.object({
	...TaskInputBaseShape,
	kind: z.literal(TaskKind.enum.chore),
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
z.union([TaskInput, z.array(TaskInput).nonempty()]);
const TaskLocalKey = z.string().min(1).max(64).regex(/^[A-Za-z][A-Za-z0-9_-]*$/);
const TaskDependencyRef = z.union([z.object({ task_id: TaskIdPayload }).strict(), z.object({ local_key: TaskLocalKey }).strict()]);
const TaskAuthoringBaseShape = {
	local_key: TaskLocalKey,
	drives: z.array(RawDrivesRef).optional(),
	depends_on: z.array(TaskDependencyRef).default([]),
	labels: z.array(z.string()).default([])
};
const BehavioralStepPolicy = z.object({
	red: ApplicabilityPayload.optional(),
	implement: ApplicabilityPayload.optional(),
	refactor: ApplicabilityPayload.optional()
}).strict();
const StructuralStepPolicy = z.object({
	implement: ApplicabilityPayload.optional(),
	refactor: ApplicabilityPayload.optional()
}).strict();
const VisualUiStepPolicy = z.object({
	mockup: ApplicabilityPayload.optional(),
	implement: ApplicabilityPayload.optional(),
	"screenshot-compare": ApplicabilityPayload.optional()
}).strict();
const DocsStepPolicy = z.object({
	draft: ApplicabilityPayload.optional(),
	review: ApplicabilityPayload.optional()
}).strict();
const SpikeStepPolicy = z.object({
	explore: ApplicabilityPayload.optional(),
	prototype: ApplicabilityPayload.optional(),
	record: ApplicabilityPayload.optional()
}).strict();
const ChoreStepPolicy = z.object({ execute: ApplicabilityPayload.optional() }).strict();
const TaskBehavioralAuthoringInput = z.object({
	...TaskAuthoringBaseShape,
	kind: z.literal(TaskKind.enum.behavioral),
	drives: z.array(RawDrivesRef).min(1),
	tests: z.array(z.string().min(3)).min(1),
	test_layer: z.enum([
		"unit",
		"integration",
		"e2e"
	]).optional(),
	step_policy: BehavioralStepPolicy.optional(),
	requires_acceptance: z.boolean().optional(),
	requires_visual: z.boolean().optional()
}).strict();
const TaskStructuralAuthoringInput = z.object({
	...TaskAuthoringBaseShape,
	kind: z.literal(TaskKind.enum.structural),
	no_test_rationale: z.string().min(10),
	step_policy: StructuralStepPolicy.optional()
}).strict();
const TaskVisualUiAuthoringInput = z.object({
	...TaskAuthoringBaseShape,
	kind: z.literal(TaskKind.enum["visual-ui"]),
	visual_contract_refs: z.array(VisIdPayload).min(1),
	no_test_rationale: z.string().min(10).optional(),
	step_policy: VisualUiStepPolicy.optional()
}).strict();
const TaskDocsAuthoringInput = z.object({
	...TaskAuthoringBaseShape,
	kind: z.literal(TaskKind.enum.docs),
	no_test_rationale: z.string().min(10),
	step_policy: DocsStepPolicy.optional()
}).strict();
const TaskSpikeAuthoringInput = z.object({
	...TaskAuthoringBaseShape,
	kind: z.literal(TaskKind.enum.spike),
	no_test_rationale: z.string().min(10),
	step_policy: SpikeStepPolicy.optional()
}).strict();
const TaskChoreAuthoringInput = z.object({
	...TaskAuthoringBaseShape,
	kind: z.literal(TaskKind.enum.chore),
	no_test_rationale: z.string().min(10),
	step_policy: ChoreStepPolicy.optional()
}).strict();
const TaskAuthoringInput = z.union([
	TaskBehavioralAuthoringInput,
	TaskStructuralAuthoringInput,
	TaskVisualUiAuthoringInput,
	TaskDocsAuthoringInput,
	TaskSpikeAuthoringInput,
	TaskChoreAuthoringInput
]);
function rejectDuplicateLocalKeys(items, ctx) {
	const firstIndex = /* @__PURE__ */ new Map();
	for (let index = 0; index < items.length; index += 1) {
		const localKey = items[index].local_key;
		const first = firstIndex.get(localKey);
		if (first === void 0) {
			firstIndex.set(localKey, index);
			continue;
		}
		ctx.addIssue({
			code: "custom",
			message: `duplicate local_key '${localKey}' at indexes ${first} and ${index}`,
			path: [index, "local_key"]
		});
	}
}
const TaskAuthoringBatch = z.array(TaskAuthoringInput).nonempty().superRefine(rejectDuplicateLocalKeys);
const TaskAuthoringInputBatched = z.union([TaskAuthoringInput, TaskAuthoringBatch]);
const TasksSubmitInput = z.object({ tasks: TaskAuthoringBatch }).strict();
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
* applicability="must", status="pending" (`tasks
* amend --policy` is the path to narrow applicability afterward).
*/
function materializeTaskInput(input, id) {
	const execution = {};
	for (const step of KIND_EXECUTION_STEPS[input.kind]) execution[step] = {
		applicability: "must",
		status: "pending"
	};
	return {
		...input,
		id,
		status: "pending",
		execution
	};
}
//#endregion
//#region src/core/attachment-ref.ts
const ATTACHMENT_ENTRY_ID = /^JE-\d{6,}$/;
const AttachmentPath = z.string().min(1).regex(/^attachments\/JE-\d{6,}\/[^/\\\0]+(?:\/[^/\\\0]+)*$/, { message: "attachment path must use attachments/<entry_id>/<file> POSIX form" }).superRefine((value, ctx) => {
	if (value.includes("\0")) ctx.addIssue({
		code: "custom",
		message: "attachment path must not contain NUL"
	});
	if (value.includes("\\")) ctx.addIssue({
		code: "custom",
		message: "attachment path must use POSIX separators"
	});
	if (path.posix.isAbsolute(value) || path.win32.isAbsolute(value)) ctx.addIssue({
		code: "custom",
		message: "attachment path must be feature-relative"
	});
	const segments = value.split("/");
	if (segments.some((segment) => segment === "" || segment === "." || segment === "..")) ctx.addIssue({
		code: "custom",
		message: "attachment path must not contain empty, '.' or '..' segments"
	});
	if (segments[0] !== "attachments") ctx.addIssue({
		code: "custom",
		message: "attachment path must start with attachments/"
	});
	if (!ATTACHMENT_ENTRY_ID.test(segments[1] ?? "")) ctx.addIssue({
		code: "custom",
		message: "attachment path must use an attachments/<entry_id>/ bucket"
	});
	if (segments.length < 3) ctx.addIssue({
		code: "custom",
		message: "attachment path must identify a file inside the entry bucket"
	});
});
const AttachmentRef = z.object({
	path: AttachmentPath,
	sha256: z.string().regex(/^[a-f0-9]{64}$/),
	size: z.number().int().nonnegative()
}).strict();
const InlineLongTextField = z.object({
	mode: z.literal("inline"),
	text: z.string()
}).strict();
const LongTextField$1 = z.discriminatedUnion("mode", [InlineLongTextField, z.object({
	mode: z.literal("sidecar"),
	ref: AttachmentRef
}).strict()]);
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
const LongTextFieldPayload = LongTextField$1;
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
}, { message: "evidence kind=manual/waiver requires actor=human:* and reason ≥10 chars (per §5.4)" }).refine((e) => !(e.kind === "manual" && e.result === "waived"), { message: "evidence kind=manual must not carry result=waived; use kind=waiver" }).refine((e) => {
	if (e.kind === "visual-review") {
		if (!e.attachments || e.attachments.length === 0) return false;
	}
	return true;
}, { message: "evidence kind=visual-review requires ≥1 attachment (per §5.4 + §1695-1700)" });
const EvidenceAuthoringSummary = z.union([z.string().min(3), InlineLongTextField]);
const EvidenceAddInput = EvidenceFullShape.extend({ summary: EvidenceAuthoringSummary }).omit({ id: true }).strict();
const EvidenceAddInputBatched = z.union([EvidenceAddInput, z.array(EvidenceAddInput).nonempty()]);
//#endregion
//#region src/cli/input-schemas.ts
const SpecReqInputBatched = SpecAddReqInput;
const SpecScenarioInputBatched = SpecAddScenarioInput;
const SpecVisualInputBatched = SpecAddVisualInput;
z.enum([
	"spec:add-req",
	"spec:add-scenario",
	"spec:add-visual",
	"tasks:submit",
	"tasks:add",
	"evidence:add"
]);
/** The exact schemas parsed by schema-emitting mutation paths. */
const INPUT_SCHEMAS = {
	"spec:add-req": SpecReqInputBatched,
	"spec:add-scenario": SpecScenarioInputBatched,
	"spec:add-visual": SpecVisualInputBatched,
	"tasks:submit": TasksSubmitInput,
	"tasks:add": TaskAuthoringInputBatched,
	"evidence:add": EvidenceAddInputBatched
};
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
const FindingTarget = z.object({
	task_id: TaskIdPayload,
	step: z.string().min(1)
}).strict();
//#endregion
//#region src/core/journal-entry.ts
const ENTRY_BYTE_LIMIT = 64e3;
const EntryId = z.string().regex(/^JE-\d{6,}$/, { message: "entry_id must match /^JE-\\d{6,}$/ (e.g. JE-000123)" });
const BatchId = z.string().uuid();
const ActorString = z.string().regex(/^(human|skill|ci|cli|migration):[^\s].*$/, { message: "actor must be of form '<prefix>:<id>' where prefix ∈ {human, skill, ci, cli, migration}" });
const LongTextField = LongTextField$1;
/** One concrete repo-relative POSIX path recorded for actual-scope audit. */
const ScopePath = z.string().min(1).superRefine((value, ctx) => {
	if (value.includes("\0")) ctx.addIssue({
		code: "custom",
		message: "scope path must not contain NUL"
	});
	if (value.includes("\\")) ctx.addIssue({
		code: "custom",
		message: "scope path must use POSIX separators"
	});
	if (path.posix.isAbsolute(value) || path.win32.isAbsolute(value)) ctx.addIssue({
		code: "custom",
		message: "scope path must be repo-relative"
	});
	const segments = value.split("/");
	if (segments.some((segment) => segment === "" || segment === "." || segment === "..")) ctx.addIssue({
		code: "custom",
		message: "scope path must not contain empty, '.' or '..' segments"
	});
	if (segments[0] === ".loaf") ctx.addIssue({
		code: "custom",
		message: "scope path must not target .loaf"
	});
});
/** UTF-8 byte ordering is the canonical cross-runtime scope-path order. */
function compareScopePathBytes(left, right) {
	return Buffer.compare(Buffer.from(left, "utf8"), Buffer.from(right, "utf8"));
}
const CanonicalScopePaths = z.array(ScopePath).superRefine((paths, ctx) => {
	for (let index = 1; index < paths.length; index += 1) if (compareScopePathBytes(paths[index - 1], paths[index]) >= 0) ctx.addIssue({
		code: "custom",
		path: [index],
		message: "scope paths must be strictly bytewise-sorted and duplicate-free"
	});
});
const CanonicalScopePathsLongText = LongTextField.superRefine((field, ctx) => {
	if (field.mode === "sidecar") return;
	let decoded;
	try {
		decoded = JSON.parse(field.text);
	} catch {
		ctx.addIssue({
			code: "custom",
			message: "inline scope paths must be valid JSON"
		});
		return;
	}
	const parsed = CanonicalScopePaths.safeParse(decoded);
	if (!parsed.success) {
		ctx.addIssue({
			code: "custom",
			message: "inline scope paths must be canonical"
		});
		return;
	}
	if (field.text !== JSON.stringify(parsed.data)) ctx.addIssue({
		code: "custom",
		message: "inline scope paths must use the canonical JSON encoding"
	});
});
z.object({
	alg: z.string().min(1),
	key_id: z.string().min(1),
	sig: z.string().min(1),
	signed_at: z.string().datetime()
}).strict();
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
z.string();
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
	"lesson:recorded",
	"scope:recorded",
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
	"spike:converted"
]);
const JournalEntry = z.object({
	seq: z.number().int().nonnegative(),
	entry_id: EntryId,
	at: z.string().datetime(),
	actor: ActorString,
	entry_schema_version: z.number().int().positive(),
	kind: EntryKind,
	payload: z.unknown(),
	batch_id: BatchId.optional(),
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
	ceremony_label: z.string(),
	workspace: z.string().min(1),
	loaf_version_required: z.string().regex(/^[\^~]?\d+\.\d+(\.\d+)?(-[0-9A-Za-z.-]+)?(\+[0-9A-Za-z.-]+)?$/)
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
	mode: z.enum(["add", "replace"]),
	task: TaskFullPayload,
	reason: z.string().min(10).optional(),
	sponsored_by_finding_id: FindingId.optional()
}).strict();
const EvidenceAddedPayload = EvidenceFullPayload;
/**
* `lesson:recorded` payload v1. The actor belongs to the journal envelope;
* keeping it out of this strict payload prevents the two authority sources
* from drifting. Long summaries use the shared sidecar-capable field shape.
*/
const LessonRecordedPayload = z.object({
	id: z.string().regex(/^LSN-\d{3,}$/),
	iteration: z.number().int().positive(),
	reason: z.string().min(10),
	summary: z.union([z.string().min(3), LongTextField])
}).strict();
/**
* `scope:recorded` payload v1. Small sets remain a canonical array; large
* sets use canonical JSON in LongTextField so the shared sidecar pipeline can
* keep the journal entry below its byte ceiling.
*/
const ScopeRecordedPayload = z.object({
	iteration: z.number().int().positive(),
	paths: z.union([CanonicalScopePaths, CanonicalScopePathsLongText])
}).strict();
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
const SpecReqAddedPayload = z.object({
	spec_version: BatchSpecVersion,
	req: RequirementEarsVerifiable
}).passthrough();
const SpecScenarioAddedPayload = z.object({
	spec_version: BatchSpecVersion,
	scenario: ScenarioGherkin
}).passthrough();
const SpecVisualAddedPayload = z.object({
	spec_version: BatchSpecVersion,
	visual: VisualContract
}).passthrough();
const SchemaVersionLiteral = z.literal(2);
const SessionRuntimeFile = z.object({
	schema_version: SchemaVersionLiteral,
	session_id: z.string().min(1),
	cwd: z.string(),
	debug: z.boolean(),
	heartbeat_at: z.string().datetime(),
	pending_scope: z.object({
		iteration: z.number().int().positive(),
		paths: CanonicalScopePaths
	}).strict().nullable()
}).strict();
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
	loaf_version_required: z.string().regex(/^[\^~]?\d+\.\d+(\.\d+)?(-[0-9A-Za-z.-]+)?(\+[0-9A-Za-z.-]+)?$/),
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
const RegistryFile = z.object({
	schema_version: SchemaVersionLiteral,
	at: z.string().datetime(),
	session_id: z.string().uuid(),
	session_label: z.string(),
	feature: z.string().min(1),
	cwd: z.string(),
	workspace: z.string().min(1),
	phase: StateProjectionPhase,
	sub_state: SubState,
	iteration: z.number().int().positive(),
	active_tasks: z.array(z.string().regex(/^T-\d{3,}$/)),
	pending: PendingQueueEntry.nullable(),
	pending_queue_depth: z.number().int().nonnegative(),
	ceremony_label: z.string()
}).strict();
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
	spec: SpecFrontmatter,
	tasks: TasksJson,
	evidence: EvidenceJson,
	finding: FindingsJson,
	state: StateProjection
};
/** Emit JSON Schema for one of the 6 structured authoring commands. */
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
//#region src/cli/command-action-policy.ts
/** An intentional pre-action completion, handled by the CLI parse boundary. */
var CommandPolicyComplete = class extends Error {
	constructor() {
		super("command completed by registered action policy");
		this.name = "CommandPolicyComplete";
	}
};
function commandLabel(command) {
	const names = [];
	for (let current = command; current?.parent; current = current.parent) names.unshift(current.name());
	return names.join(" ");
}
/** Preserve action-entry priority: dry-run rejection, Board selectors, schema output. */
function evaluateCommandAction(command, input) {
	const policy = commandPolicy(command);
	if (!policy) throw new Error(`missing command policy: ${commandLabel(command)}`);
	const opts = command.opts();
	const schema = policy.schema?.kind === "artifact" || policy.schema?.kind === "input" && opts.schema === true ? policy.schema : void 0;
	let commandType;
	if (schema) commandType = "read-only";
	else if (policy.dryRun === "spec-edit") {
		if (opts.input === void 0) commandType = "wrapping";
	} else if (policy.dryRun === "read-only" || policy.dryRun === "wrapping" || policy.dryRun === "projection-writer" || policy.dryRun === "scaffold-writer") commandType = policy.dryRun;
	if (input.dryRun && commandType) {
		let label = commandLabel(command);
		if (policy.selectors === "recovery" && opts.rebuild) label += " --rebuild";
		if (schema?.kind === "input") label += " --schema";
		return {
			kind: "failure",
			diagnostic: diagnostic$2("DRY_RUN_NOT_APPLICABLE", {
				command: label,
				command_type: commandType
			})
		};
	}
	if (policy.selectors === "forbidden" && policy.selectorStage === "action") {
		const selectors = collectPresentSelectors(input.argv, input.env);
		if (selectors.length > 0) return {
			kind: "failure",
			diagnostic: diagnostic$2("USAGE", {
				reason: "board_selector_not_supported",
				conflicting: selectors
			})
		};
	}
	return schema ? {
		kind: "schema",
		schema
	} : { kind: "continue" };
}
/** Commander validates syntax before this public hook; completion skips the action. */
function installCommandActionPolicy(program, ctx) {
	program.hook("preAction", (_program, command) => {
		const decision = evaluateCommandAction(command, {
			dryRun: ctx.dryRun,
			argv: ctx.argv,
			env: process.env
		});
		if (decision.kind === "continue") return;
		if (decision.kind === "failure") ctx.failure(decision.diagnostic);
		else {
			const schema = decision.schema.kind === "input" ? emitInputSchema(decision.schema.key) : emitArtifactSchema(decision.schema.key);
			ctx.success(schema, () => formatSchema(schema));
		}
		throw new CommandPolicyComplete();
	});
}
//#endregion
//#region package.json
var version = "0.10.0";
//#endregion
//#region src/core/machine.ts
/** Preserve literal inference while rejecting missing and extra state keys. */
function defineMachine(machine) {
	return machine;
}
/** Canonical state-axis definition. Keep declaration order aligned with SubState. */
const MACHINE = defineMachine({
	"TRIAGE.score": {
		entry: "loaf start <desc> invoked",
		exit: "complexity_score computed (0-100)",
		write_paths: [".loaf/<feature>/state.json"],
		edges: [{
			target: "TRIAGE.confirm",
			owner_kind: "event:phase_advanced"
		}],
		prompt_inject: "Score 0-100 across files/api/schema/concurrency/security. Suggest profile."
	},
	"TRIAGE.confirm": {
		entry: "score computed",
		exit: "user accepts or overrides profile",
		write_paths: [".loaf/<feature>/state.json"],
		edges: [{
			target: "SPEC.proposal",
			owner_kind: "event:phase_advanced",
			guards: ["spec_phase_required"]
		}, {
			target: "EXECUTE.plan",
			owner_kind: "event:phase_advanced",
			guards: ["spec_phase_forbidden"]
		}],
		prompt_inject: "Confirm proposed profile (quick/light/standard/deep — see skill PRESETS) or override."
	},
	"SPEC.proposal": {
		entry: "ceremony.spec_phase=true && TRIAGE.confirm done; OR Q9 escalation backfill (ceremony.spec_phase 由 false 改 true)",
		exit: "spec.md body has Proposal section",
		write_paths: [".loaf/<feature>/spec.md", ".loaf/<feature>/spec-draft-context.md"],
		edges: [{
			target: "SPEC.spec",
			owner_kind: "event:phase_advanced"
		}],
		prompt_inject: "Write Proposal: why / scope / anti-scope. If backfill, read spec-draft-context.md."
	},
	"SPEC.spec": {
		entry: "proposal section exists OR amend-spec back-edge",
		exit: "frontmatter has requirements (each with three-way verifiability) + scenarios (+visual_contracts if UI); needs_clarification empty",
		write_paths: [".loaf/<feature>/spec.md"],
		edges: [{
			target: "SPEC.plan",
			owner_kind: "event:phase_advanced"
		}],
		prompt_inject: "Author EARS REQ-* with measurable / verified_by_scenarios / acceptance_na+reason. Add Gherkin SCEN-* and VIS-* as needed."
	},
	"SPEC.plan": {
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
		edges: [{
			target: "SPEC.design",
			owner_kind: "event:phase_advanced"
		}],
		prompt_inject: "Plan: risks / dependencies / milestones."
	},
	"SPEC.design": {
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
		edges: [{
			target: "EXECUTE.plan",
			owner_kind: "event:phase_advanced",
			guards: ["spec_locked_required"]
		}],
		prompt_inject: "Design + decompose into tasks bound to REQ/SCEN/VIS via task.drives[]. Use labels[] for bug/security/etc.",
		gate: "spec-lock"
	},
	"EXECUTE.plan": {
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
		edges: [{
			target: "EXECUTE.work",
			owner_kind: "event:phase_advanced"
		}],
		prompt_inject: "Derive execution policy for each task from kind × profile. Set step.applicability accordingly."
	},
	"EXECUTE.work": {
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
		edges: [{
			target: "EXECUTE.work",
			owner_kind: "contract:next"
		}, {
			target: "EXECUTE.done",
			owner_kind: "event:phase_advanced"
		}],
		prompt_inject: "Execute each in-progress task at its currently-running step. Append evidence with covers[]."
	},
	"EXECUTE.done": {
		entry: "all tasks status ∈ {done, abandoned}",
		exit: "advance to VERIFY.plan (verify_phase=true); OR DONE.delivered (verify_phase=false: quick / light non-spike via `loaf deliver`: verify-min runs at this boundary, on pass transition direct to DONE.delivered, on fail exit 2 — see protocol.md §3.2 + §10.14)",
		write_paths: [],
		edges: [{
			target: "VERIFY.plan",
			owner_kind: "event:phase_advanced",
			guards: ["verify_phase_required"]
		}, {
			target: "DONE.delivered",
			owner_kind: "session:delivered"
		}],
		prompt_inject: "All tasks complete. verify_phase=true → advance to VERIFY.plan. verify_phase=false non-spike → run `loaf deliver` (verify-min then DONE.delivered). spike (any profile) → deliver blocked; pick archive / spike convert / abandon per §8.3."
	},
	"VERIFY.plan": {
		entry: "EXECUTE.done && ceremony.verify_phase=true",
		exit: "applicability computed for each VerifyCheckKind (must/optional/na with reasons)",
		write_paths: [".loaf/<feature>/state.json"],
		edges: [
			{
				target: "VERIFY.run",
				owner_kind: "event:phase_advanced"
			},
			{
				target: "VERIFY.review",
				owner_kind: "contract:next"
			},
			{
				target: "VERIFY.acceptance",
				owner_kind: "contract:next"
			},
			{
				target: "VERIFY.visual",
				owner_kind: "contract:next"
			},
			{
				target: "VERIFY.accept",
				owner_kind: "contract:next"
			}
		],
		prompt_inject: "Compute which verify checks apply: run/review/acceptance/visual. Output reasoning + N/A justifications."
	},
	"VERIFY.run": {
		entry: "VERIFY.plan done with run applicability ∈ {must, optional-elected}; OR amend back-edge",
		exit: "run check passed or explicitly waived",
		write_paths: [".loaf/<feature>/evidence.jsonl", ".loaf/<feature>/findings.jsonl"],
		edges: [
			{
				target: "VERIFY.review",
				owner_kind: "event:phase_advanced"
			},
			{
				target: "VERIFY.acceptance",
				owner_kind: "event:phase_advanced"
			},
			{
				target: "VERIFY.visual",
				owner_kind: "event:phase_advanced"
			},
			{
				target: "VERIFY.accept",
				owner_kind: "event:phase_advanced"
			}
		],
		prompt_inject: "Run the `run` check (test + lint + typecheck). Append evidence with kind=local-check or task-summary. Raise findings as needed."
	},
	"VERIFY.review": {
		entry: "VERIFY.plan or prior check done with review applicability ∈ {must, optional-elected}",
		exit: "review check passed or explicitly waived",
		write_paths: [".loaf/<feature>/evidence.jsonl", ".loaf/<feature>/findings.jsonl"],
		edges: [
			{
				target: "VERIFY.run",
				owner_kind: "contract:next"
			},
			{
				target: "VERIFY.acceptance",
				owner_kind: "event:phase_advanced"
			},
			{
				target: "VERIFY.visual",
				owner_kind: "event:phase_advanced"
			},
			{
				target: "VERIFY.accept",
				owner_kind: "event:phase_advanced"
			}
		],
		prompt_inject: "Run quality review (spec_fit + quality_fit). Append evidence with kind=verify-review. Raise findings as needed."
	},
	"VERIFY.acceptance": {
		entry: "VERIFY.plan or prior check done with acceptance applicability ∈ {must, optional-elected}",
		exit: "acceptance check passed or explicitly waived",
		write_paths: [".loaf/<feature>/evidence.jsonl", ".loaf/<feature>/findings.jsonl"],
		edges: [
			{
				target: "VERIFY.run",
				owner_kind: "contract:next"
			},
			{
				target: "VERIFY.review",
				owner_kind: "contract:next"
			},
			{
				target: "VERIFY.visual",
				owner_kind: "event:phase_advanced"
			},
			{
				target: "VERIFY.accept",
				owner_kind: "event:phase_advanced"
			}
		],
		prompt_inject: "Run selected Gherkin acceptance scenarios. Append evidence with kind=acceptance. Raise findings as needed."
	},
	"VERIFY.visual": {
		entry: "VERIFY.plan or prior check done with visual applicability ∈ {must, optional-elected}",
		exit: "visual check passed or explicitly waived",
		write_paths: [".loaf/<feature>/evidence.jsonl", ".loaf/<feature>/findings.jsonl"],
		edges: [
			{
				target: "VERIFY.run",
				owner_kind: "contract:next"
			},
			{
				target: "VERIFY.review",
				owner_kind: "contract:next"
			},
			{
				target: "VERIFY.acceptance",
				owner_kind: "contract:next"
			},
			{
				target: "VERIFY.accept",
				owner_kind: "event:phase_advanced"
			}
		],
		prompt_inject: "Run visual contract verification. Append evidence with kind=visual-review (attachments required). Raise findings as needed."
	},
	"VERIFY.accept": {
		entry: "all applicable checks passed/waived + no actionable open findings (`defer` / `backlog` are non-blocking dispositions)",
		exit: "verify-accept gate approved. settle_phase=true (deep) → SETTLE.lessons via `loaf settle`; settle_phase=false (standard) → DONE.delivered via `loaf deliver`",
		write_paths: [".loaf/<feature>/evidence.jsonl"],
		edges: [{
			target: "SETTLE.lessons",
			owner_kind: "event:phase_advanced",
			guards: ["settle_phase_required", "verify_accepted_required"]
		}, {
			target: "DONE.delivered",
			owner_kind: "session:delivered"
		}],
		prompt_inject: "Verify-accept gate. Review check status + open findings. Approve or reject. On approve: settle_phase=true → `loaf settle` enters SETTLE.lessons; settle_phase=false → `loaf deliver` enters DONE.delivered.",
		gate: "verify-accept"
	},
	"SETTLE.lessons": {
		entry: "verify-accept passed and deep settle entered directly",
		exit: "lessons.md appended (deep: lessons_required=must)",
		write_paths: [".loaf/<feature>/lessons.md"],
		edges: [
			{
				target: "DONE.delivered",
				owner_kind: "session:delivered"
			},
			{
				target: "DONE.archived",
				owner_kind: "session:archived"
			},
			{
				target: "DONE.abandoned",
				owner_kind: "session:abandoned"
			}
		],
		prompt_inject: "Append lessons (deep: MUST). User then runs `loaf deliver` / `loaf archive` / `loaf abandon`."
	},
	"DONE.delivered": {
		entry: "loaf deliver succeeded (Q4: advisory only — no git/gh side effects)",
		exit: "terminal",
		write_paths: [],
		edges: [],
		prompt_inject: ""
	},
	"DONE.archived": {
		entry: "loaf archive --reason '...'",
		exit: "terminal",
		write_paths: [],
		edges: [],
		prompt_inject: ""
	},
	"DONE.abandoned": {
		entry: "loaf abandon --reason '...' (reason required)",
		exit: "terminal",
		write_paths: [],
		edges: [],
		prompt_inject: ""
	}
});
/** Compatibility projection consumed by the runtime contract shim. */
const SUB_STATE_CONTRACTS$1 = Object.entries(MACHINE).map(([subState, node]) => ({
	sub_state: subState,
	entry: node.entry,
	exit: node.exit,
	write_paths: [...node.write_paths],
	..."mutation_rights" in node ? { mutation_rights: {
		writable_fields: [...node.mutation_rights.writable_fields],
		forbidden_fields: [...node.mutation_rights.forbidden_fields]
	} } : {},
	next: node.edges.map((edge) => edge.target),
	prompt_inject: node.prompt_inject
}));
/** Cursor-owned human gate, if the current node declares one. */
function gateNameForCursor(subState) {
	return MACHINE[subState].gate ?? null;
}
//#endregion
//#region src/core/reducer/transition.ts
function deriveLegalTransitions() {
	const transitions = {};
	for (const subState of Object.keys(MACHINE)) transitions[subState] = MACHINE[subState].edges.filter((edge) => edge.owner_kind === "event:phase_advanced").map((edge) => edge.target);
	return transitions;
}
const LEGAL_TRANSITIONS = deriveLegalTransitions();
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
function buildGateDecideAction(gate) {
	return {
		command: `loaf gate decide ${gate} --approve|--reject --reason "<reason>"`,
		owner_verb: "gate decide",
		target: gate,
		blocking: true,
		reason: gate === "spec-lock" ? "SPEC_LOCK_GATE_DECISION_REQUIRED" : "VERIFY_ACCEPT_GATE_DECISION_REQUIRED"
	};
}
function nextLegalTargets(prev, ceremony, verifyAccepted = false, specLocked = false) {
	return (LEGAL_TRANSITIONS[prev] ?? []).filter((target) => validateTransition(prev, target, {
		ceremony,
		actor: "cli:loaf",
		verify_accepted: verifyAccepted,
		spec_locked: specLocked
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
			target: "SETTLE.lessons",
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
	const targets = nextLegalTargets(sub_state, ceremony, verify_accepted, spec_locked);
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
const EXECUTE_OR_VERIFY_FROM = SubState.options.filter((source) => source.startsWith("EXECUTE.") || source.startsWith("VERIFY."));
const POST_PLAN_EXECUTE_OR_VERIFY_FROM = EXECUTE_OR_VERIFY_FROM.filter((source) => source !== "EXECUTE.plan");
const BACK_EDGE_FROM = {
	"amend-spec": {
		expected_target: "SPEC.spec",
		allowed_from: new Set(EXECUTE_OR_VERIFY_FROM),
		allowed_from_label: "EXECUTE.* + VERIFY.*"
	},
	"amend-tasks": {
		expected_target: "EXECUTE.work",
		allowed_from: new Set(POST_PLAN_EXECUTE_OR_VERIFY_FROM),
		allowed_from_label: "EXECUTE.work / EXECUTE.done + VERIFY.*"
	},
	"fix-impl": {
		expected_target: "EXECUTE.work",
		allowed_from: new Set(POST_PLAN_EXECUTE_OR_VERIFY_FROM),
		allowed_from_label: "EXECUTE.work / EXECUTE.done + VERIFY.*"
	},
	"fix-test": {
		expected_target: "EXECUTE.work",
		allowed_from: new Set(POST_PLAN_EXECUTE_OR_VERIFY_FROM),
		allowed_from_label: "EXECUTE.work / EXECUTE.done + VERIFY.*"
	}
};
/** Ordered source states; the returned copy cannot change transition policy. */
function backEdgeSourceStates(action) {
	return [...BACK_EDGE_FROM[action].allowed_from];
}
/** Target query for intervention assembly; the transition table remains the sole owner. */
function backEdgeTarget(action) {
	return BACK_EDGE_FROM[action].expected_target;
}
const TRANSITION_GUARDS = {
	spec_phase_required: {
		passes: (ctx) => ctx.ceremony.spec_phase,
		failure: (prev, target, ctx) => ({
			ok: false,
			code: "SPEC_PHASE_FORK_VIOLATION",
			detail: {
				from: prev,
				to: target,
				spec_phase: ctx.ceremony.spec_phase
			}
		})
	},
	spec_phase_forbidden: {
		passes: (ctx) => !ctx.ceremony.spec_phase,
		failure: (prev, target, ctx) => ({
			ok: false,
			code: "SPEC_PHASE_FORK_VIOLATION",
			detail: {
				from: prev,
				to: target,
				spec_phase: ctx.ceremony.spec_phase
			}
		})
	},
	verify_phase_required: {
		passes: (ctx) => ctx.ceremony.verify_phase,
		failure: (prev, target, ctx) => ({
			ok: false,
			code: "VERIFY_PHASE_FORK_VIOLATION",
			detail: {
				from: prev,
				to: target,
				verify_phase: ctx.ceremony.verify_phase
			}
		})
	},
	spec_locked_required: {
		passes: (ctx) => !!ctx.spec_locked,
		failure: (prev, target, ctx) => ({
			ok: false,
			code: "SPEC_LOCK_NOT_SATISFIED",
			detail: {
				from: prev,
				to: target,
				spec_locked: !!ctx.spec_locked
			}
		})
	},
	settle_phase_required: {
		passes: (ctx) => ctx.ceremony.settle_phase,
		failure: (prev, target, ctx) => ({
			ok: false,
			code: "SETTLE_PHASE_DISABLED",
			detail: {
				from: prev,
				to: target,
				settle_phase: ctx.ceremony.settle_phase
			}
		})
	},
	verify_accepted_required: {
		passes: (ctx) => !!ctx.verify_accepted,
		failure: (prev, target, ctx) => ({
			ok: false,
			code: "SETTLE_NOT_ACCEPTED",
			detail: {
				from: prev,
				to: target,
				verify_accepted: !!ctx.verify_accepted
			}
		})
	}
};
function validateBackEdge(prev, target, backEdge) {
	const action = backEdge.action;
	const rule = Object.hasOwn(BACK_EDGE_FROM, action) ? BACK_EDGE_FROM[action] : void 0;
	if (rule === void 0) return {
		ok: false,
		code: "TRANSITION_ILLEGAL",
		detail: {
			from: prev,
			to: target,
			back_edge: backEdge,
			reason: "back_edge_action_unknown"
		}
	};
	if (target !== rule.expected_target) return {
		ok: false,
		code: "TRANSITION_ILLEGAL",
		detail: {
			from: prev,
			to: target,
			back_edge_action: action,
			expected_target: rule.expected_target,
			reason: "back_edge_target_mismatch"
		}
	};
	if (!rule.allowed_from.has(prev)) return {
		ok: false,
		code: "TRANSITION_ILLEGAL",
		detail: {
			from: prev,
			to: target,
			back_edge_action: action,
			allowed_from: [...rule.allowed_from],
			reason: "back_edge_from_not_allowed"
		}
	};
	return { ok: true };
}
function validateTransition(prev, target, ctx) {
	if (ctx.back_edge !== void 0) return validateBackEdge(prev, target, ctx.back_edge);
	const allowed = LEGAL_TRANSITIONS[prev] ?? [];
	if (!allowed.includes(target)) return {
		ok: false,
		code: "TRANSITION_ILLEGAL",
		detail: {
			from: prev,
			to: target,
			allowed_forward: [...allowed]
		}
	};
	const edge = MACHINE[prev].edges.find((candidate) => candidate.owner_kind === "event:phase_advanced" && candidate.target === target);
	if (edge === void 0) throw new Error(`MACHINE forward edge missing after LEGAL_TRANSITIONS accepted ${prev} → ${target}`);
	for (const guardName of edge.guards ?? []) {
		const guard = TRANSITION_GUARDS[guardName];
		if (!guard.passes(ctx)) return guard.failure(prev, target, ctx);
	}
	return { ok: true };
}
//#endregion
//#region src/core/intervention-policy.ts
/** Actions whose selection is itself a non-blocking disposition. */
const FINDING_DEFERRAL_ACTIONS = ["defer", "backlog"];
/**
* Derive disposition from the persisted action without widening the journal
* or projection schema. Accepts string because historical slim snapshots type
* FindingState.action loosely, while validated new entries use FindingAction.
*/
function isFindingDeferralAction(action) {
	return FINDING_DEFERRAL_ACTIONS.includes(action);
}
/**
* FINDING_ACTION_GRID — per-cell risk classification.
* 4 `incoherent` cells (rev 4.3 ADR-0004 A7): structurally there is no
* task target a transition can land on, so block early at preflight.
* Implements the `docs/protocol.md §4.5` finding matrix.
*/
const FINDING_ACTION_GRID = {
	"spec-gap": {
		"amend-spec": "typical",
		"amend-tasks": "unusual",
		"fix-impl": "incoherent",
		"fix-test": "incoherent",
		defer: "typical",
		backlog: "typical"
	},
	"spec-defect": {
		"amend-spec": "typical",
		"amend-tasks": "unusual",
		"fix-impl": "unusual",
		"fix-test": "unusual",
		defer: "typical",
		backlog: "typical"
	},
	"impl-defect": {
		"amend-spec": "unusual",
		"amend-tasks": "typical",
		"fix-impl": "typical",
		"fix-test": "unusual",
		defer: "typical",
		backlog: "typical"
	},
	"test-defect": {
		"amend-spec": "unusual",
		"amend-tasks": "typical",
		"fix-impl": "unusual",
		"fix-test": "typical",
		defer: "typical",
		backlog: "typical"
	},
	"new-scope": {
		"amend-spec": "typical",
		"amend-tasks": "typical",
		"fix-impl": "incoherent",
		"fix-test": "incoherent",
		defer: "typical",
		backlog: "typical"
	},
	"risk-escalation": {
		"amend-spec": "unusual",
		"amend-tasks": "typical",
		"fix-impl": "unusual",
		"fix-test": "unusual",
		defer: "typical",
		backlog: "typical"
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
	defer: "none",
	backlog: "none"
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
/** Action effect for batch assembly; admission still verifies authorization.
* Unknown action strings have no mechanical siblings, preserving the loose
* input surface used by CLI builders before payload admission. */
function findingActionEffect(action) {
	if (action === "fix-impl" || action === "fix-test") return {
		kind: "fix-reset",
		target: backEdgeTarget(action),
		step: FIX_ACTION_STEP[action]
	};
	if (action === "amend-spec" || action === "amend-tasks") return {
		kind: "back-edge",
		target: backEdgeTarget(action)
	};
	return { kind: "none" };
}
/** Historical pending rows keep resolved entries; the head is first unresolved. */
function pendingHeadIndex(rows) {
	return rows.findIndex((row) => !row.resolved);
}
function pendingHead(rows) {
	const index = pendingHeadIndex(rows);
	return index === -1 ? void 0 : rows[index];
}
/** Preserve rich/slim fields and ordering; serialization remains with the writer. */
function livePending(rows) {
	return rows.filter((row) => !row.resolved);
}
function checkPendingAdvance(rows) {
	const head = pendingHead(rows);
	return head && (head.kind === "gate_decision" || head.kind === "profile_escalation") ? diagnostic$2("PENDING_BLOCKS_ADVANCE", {
		pending_id: head.id,
		kind: head.kind
	}) : null;
}
/** Approved gates soft-bind to a gate head; rejected gates never co-resolve.
* CLI assembly consumes only an eligible head. A failure is still reported
* by admission at its existing stage, after other earlier checks. */
function planGatePending(rows, gate, decision) {
	if (decision === "rejected") return {
		ok: true,
		resolutionHead: void 0
	};
	const head = pendingHead(rows);
	if (head && head.kind !== "gate_decision") return {
		ok: false,
		...diagnostic$2("GATE_NOT_PENDING", {
			gate_kind: gate,
			head_id: head.id,
			head_kind: head.kind
		})
	};
	return {
		ok: true,
		resolutionHead: head
	};
}
function checkPendingEscalation(rows, subState) {
	if (subState === "TRIAGE.score" || subState === "TRIAGE.confirm") return null;
	const head = pendingHead(rows);
	return head?.kind === "profile_escalation" ? null : diagnostic$2("ESCALATION_NOT_PENDING", { actual_head: head ? head.kind : "(none)" });
}
/** Called at reducer application, not promoted into admission. */
function resolvePending(rows, id) {
	const index = pendingHeadIndex(rows);
	if (index === -1) return {
		ok: false,
		...diagnostic$2("PENDING_NOT_FOUND", { reason: "no pending head" })
	};
	const head = rows[index];
	if (head.id !== id) return {
		ok: false,
		...diagnostic$2("PENDING_NOT_FOUND", { reason: `id=${id} does not match head id=${head.id} (FIFO violation)` })
	};
	return {
		ok: true,
		pending: rows.map((row, i) => i === index ? {
			...row,
			resolved: true
		} : row)
	};
}
/** Intent routing for an already-live queue; all pending kinds require a next
* action, whereas only gate/profile heads block phase advance. */
function pendingResolutionOwner(kind, gateAtCursor) {
	if (kind === "gate_decision" && gateAtCursor !== null) return {
		owner: "gate decide",
		gate: gateAtCursor
	};
	if (kind === "profile_escalation") return { owner: "profile escalate" };
	return { owner: "pending resolve" };
}
function openFinding(rows, id) {
	const index = rows.findIndex((finding) => finding.id === id);
	if (index === -1) return {
		ok: false,
		code: "FINDING_NOT_FOUND",
		detail: {
			id,
			reason: "not_found"
		}
	};
	const finding = rows[index];
	if (finding.status === "closed") return {
		ok: false,
		code: "FINDING_NOT_FOUND",
		detail: {
			id,
			reason: "already_closed"
		}
	};
	return {
		ok: true,
		finding,
		index
	};
}
/** Preserve each operation's single-action/string versus fix-action/array detail. */
function requireFindingSponsor(rows, id, expectedAction) {
	const found = openFinding(rows, id);
	if (!found.ok) return found;
	if (!(typeof expectedAction === "string" ? found.finding.action === expectedAction : expectedAction.includes(found.finding.action))) return {
		ok: false,
		code: "FINDING_NOT_FOUND",
		detail: {
			id,
			reason: "action_mismatch",
			expected_action: expectedAction,
			actual_action: found.finding.action
		}
	};
	return {
		...found,
		finding: found.finding
	};
}
/** Closure retains its historical missing-id reason and reducer-stage check. */
function findingForClosure(rows, id) {
	const found = openFinding(rows, id);
	return !found.ok && found.detail.reason === "not_found" ? {
		ok: false,
		code: "FINDING_NOT_FOUND",
		detail: {
			id,
			reason: "unknown"
		}
	} : found;
}
/** Runs after general kind/actor/sub-state admission; preserves the existing
* risk -> reason -> target -> spec-lock order. */
function checkFindingRaise(payload, snapshot, sub_state) {
	const risk = cellRisk(payload.category, payload.action);
	if (risk === "incoherent") return {
		ok: false,
		code: "FINDING_ACTION_INCOHERENT",
		detail: {
			category: payload.category,
			action: payload.action
		}
	};
	if (risk === "unusual") {
		const reasonLength = payload.reason?.length ?? 0;
		if (reasonLength < 20) return {
			ok: false,
			...diagnostic$2("FINDING_ACTION_UNUSUAL_REASON_REQUIRED", {
				category: payload.category,
				action: payload.action,
				current_reason_length: reasonLength,
				min_reason_length: 20
			})
		};
	}
	const mode = FINDING_ACTION_TARGET_MODE[payload.action];
	if (mode === "task_id_step") {
		if (!payload.target) return {
			ok: false,
			code: "FINDING_TARGET_REQUIRED",
			detail: {
				action: payload.action,
				reason: "missing"
			}
		};
		const expectedStep = FIX_ACTION_STEP[payload.action];
		if (expectedStep && payload.target.step !== expectedStep) return {
			ok: false,
			code: "FINDING_TARGET_REQUIRED",
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
		detail: {
			action: payload.action,
			task_id: payload.target.task_id,
			step: payload.target.step,
			reason: "target_not_allowed"
		}
	};
	if (mode === "task_id_step" || mode === "task_id_optional") {
		if (payload.target) {
			const task = snapshot.tasks.find((t) => t.id === payload.target.task_id);
			if (!task) return {
				ok: false,
				code: "FINDING_TARGET_REQUIRED",
				detail: {
					action: payload.action,
					task_id: payload.target.task_id,
					reason: "task_not_found"
				}
			};
			if (!(payload.target.step in task.steps)) return {
				ok: false,
				code: "FINDING_TARGET_REQUIRED",
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
	if (payload.action === "amend-spec" && !snapshot.state?.spec_locked) return {
		ok: false,
		code: "FINDING_AMEND_SPEC_NOT_LOCKED",
		detail: {
			current_spec_locked: false,
			current_sub_state: sub_state,
			hint: "use loaf spec submit / add-* directly to edit spec when not locked"
		}
	};
	return null;
}
/** Sponsor -> canonical step -> exact target -> task/step -> abandoned order. */
function checkFindingReset(payload, snapshot, sub_state) {
	const sponsor = requireFindingSponsor(snapshot.findings, payload.finding_id, ["fix-impl", "fix-test"]);
	if (!sponsor.ok) return sponsor;
	const finding = sponsor.finding;
	const expectedStep = FIX_ACTION_STEP[finding.action];
	if (payload.step !== expectedStep) return {
		ok: false,
		code: "MUTATION_OUT_OF_RIGHTS",
		detail: {
			finding_id: payload.finding_id,
			sub_state,
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
		detail: {
			finding_id: payload.finding_id,
			sub_state,
			task_id: payload.task_id,
			expected_target: expectedTarget ?? null,
			actual_target: {
				task_id: payload.task_id,
				step: payload.step
			},
			reason: "task_step_reset_target_mismatch"
		}
	};
	const task = snapshot.tasks.find((t) => t.id === payload.task_id);
	if (!task || !(payload.step in task.steps)) return {
		ok: false,
		code: "MUTATION_OUT_OF_RIGHTS",
		detail: {
			finding_id: payload.finding_id,
			sub_state,
			task_id: payload.task_id,
			step: payload.step,
			reason: "task_step_reset_target_mismatch"
		}
	};
	if (task.status === "abandoned") return {
		ok: false,
		code: "MUTATION_OUT_OF_RIGHTS",
		detail: {
			finding_id: payload.finding_id,
			sub_state,
			task_id: payload.task_id,
			status: task.status,
			reason: "task_step_reset_task_abandoned"
		}
	};
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
/**
* Applies an entry whose external validation has already succeeded.
*
* `prev` is consumed. Some cases mutate projection arrays in place and may
* return the same snapshot object or array references.
*
* @internal Only entry-admission.ts may call this directly.
*/
function applyValidated(prev, entry) {
	if (entry.kind === "session:started") {
		if (prev.state !== null) return {
			ok: false,
			...diagnostic$2("ALREADY_STARTED", { kind: entry.kind })
		};
		const payload = entry.payload;
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
	const state = prev.state;
	const { kind } = entry;
	switch (kind) {
		case "event:phase_advanced": {
			const payload = entry.payload;
			const next = {
				...state,
				sub_state: payload.to,
				phase: extractPhase(payload.to),
				spec_locked: payload.to === "SPEC.spec" ? false : state.spec_locked,
				iteration: payload.back_edge !== void 0 ? state.iteration + 1 : state.iteration
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
						...state,
						ceremony: payload
					}
				}
			};
		}
		case "gate:decided": {
			const payload = entry.payload;
			if (payload.decision !== "approved") return {
				ok: true,
				snapshot: prev
			};
			switch (payload.gate_kind) {
				case "spec-lock": return {
					ok: true,
					snapshot: {
						...prev,
						state: {
							...state,
							spec_locked: true
						}
					}
				};
				case "verify-accept": return {
					ok: true,
					snapshot: {
						...prev,
						state: {
							...state,
							verify_accepted: true
						}
					}
				};
				default: return payload.gate_kind;
			}
		}
		case "event:tasks_planned": {
			const payload = entry.payload;
			const taskList = payload.tasks.map(extractTaskSlim);
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
			const mode = payload.mode;
			const idx = prev.tasks.findIndex((t) => t.id === payload.task.id);
			if (mode === "add") {
				if (idx !== -1) return {
					ok: false,
					code: "DUPLICATE_TASK_ID",
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
			const seeded = prev.tasks.find((t) => t.id === payload.task_id).steps[payload.step];
			if (!seeded) return {
				ok: false,
				code: "TASK_STEP_NOT_FOUND",
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
			const task = prev.tasks.find((t) => t.id === payload.task_id);
			const seeded = task.steps[payload.step];
			if (!seeded) return {
				ok: false,
				code: "TASK_STEP_NOT_FOUND",
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
			const seeded = prev.tasks.find((t) => t.id === payload.task_id).steps[payload.step];
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
						...state,
						spec_version: payload.spec_version
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
			prev.requirements.push(structuredClone(payload.req));
			return {
				ok: true,
				snapshot: payload.spec_version === state.spec_version ? prev : {
					...prev,
					state: {
						...state,
						spec_version: payload.spec_version
					}
				}
			};
		}
		case "event:spec_scenario_added": {
			const payload = entry.payload;
			prev.scenarios.push(structuredClone(payload.scenario));
			return {
				ok: true,
				snapshot: payload.spec_version === state.spec_version ? prev : {
					...prev,
					state: {
						...state,
						spec_version: payload.spec_version
					}
				}
			};
		}
		case "event:spec_visual_added": {
			const payload = entry.payload;
			prev.visual_contracts.push(structuredClone(payload.visual));
			return {
				ok: true,
				snapshot: payload.spec_version === state.spec_version ? prev : {
					...prev,
					state: {
						...state,
						spec_version: payload.spec_version
					}
				}
			};
		}
		case "evidence:added": {
			const payload = entry.payload;
			const ev = {
				id: payload.id,
				kind: payload.kind,
				covers: payload.covers,
				actor: payload.actor
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
		case "lesson:recorded": return {
			ok: true,
			snapshot: prev
		};
		case "scope:recorded": return {
			ok: true,
			snapshot: prev
		};
		case "finding:raised": {
			const payload = entry.payload;
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
			const closure = findingForClosure(prev.findings, payload.id);
			if (!closure.ok) return closure;
			const idx = closure.index;
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
			const resolved = resolvePending(prev.pending, payload.id);
			if (!resolved.ok) return resolved;
			return {
				ok: true,
				snapshot: {
					...prev,
					pending: resolved.pending
				}
			};
		}
		case "session:delivered": return {
			ok: true,
			snapshot: {
				...prev,
				state: {
					...state,
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
					...state,
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
					...state,
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
		default: return {
			ok: false,
			code: "REDUCER_NOT_IMPLEMENTED",
			detail: { kind }
		};
	}
}
//#endregion
//#region src/core/kind-guards.ts
const ANY_SUB_STATE = Symbol("any-sub-state");
const ANY_NON_DONE = Symbol("any-non-done");
const VERIFY_OR_POST_LOCK_EXECUTE = backEdgeSourceStates("amend-spec");
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
const FIX_BACK_EDGE_FROM = backEdgeSourceStates("fix-impl");
const ALL_ACTOR_PREFIXES = [
	"human",
	"skill",
	"ci",
	"cli"
];
const HUMAN_ONLY = ["human"];
const CLI_ONLY = ["cli"];
function actorPrefix(actor) {
	const m = /^(human|skill|ci|cli):/.exec(actor);
	return m ? m[1] : null;
}
//#endregion
//#region src/core/kind-registry.ts
const KIND_REGISTRY = {
	"event:phase_advanced": {
		payload: PhaseAdvancedPayload,
		entrySchemaVersion: 1,
		subStates: ANY_SUB_STATE,
		actors: ALL_ACTOR_PREFIXES,
		emitsSpec: false
	},
	"event:ceremony_set": {
		payload: CeremonyPayload,
		entrySchemaVersion: 1,
		subStates: new Set([
			"TRIAGE.score",
			"TRIAGE.confirm",
			...ALL_SPEC,
			...ALL_EXECUTE
		]),
		actors: ALL_ACTOR_PREFIXES,
		emitsSpec: false
	},
	"event:tasks_planned": {
		payload: TasksPlannedPayload,
		entrySchemaVersion: 1,
		subStates: new Set(["SPEC.design", "EXECUTE.plan"]),
		actors: ALL_ACTOR_PREFIXES,
		emitsSpec: false
	},
	"event:tasks_amended": {
		payload: TasksAmendedPayload,
		entrySchemaVersion: 1,
		subStates: new Set(VERIFY_OR_POST_LOCK_EXECUTE),
		actors: ALL_ACTOR_PREFIXES,
		emitsSpec: false
	},
	"event:task_claimed": {
		payload: TaskRefPayload,
		entrySchemaVersion: 1,
		subStates: new Set(["EXECUTE.work"]),
		actors: ALL_ACTOR_PREFIXES,
		emitsSpec: false
	},
	"event:task_step_started": {
		payload: TaskStepRefPayload,
		entrySchemaVersion: 1,
		subStates: new Set(["EXECUTE.work"]),
		actors: ALL_ACTOR_PREFIXES,
		emitsSpec: false
	},
	"event:task_step_done": {
		payload: TaskStepDonePayload,
		entrySchemaVersion: 1,
		subStates: new Set(["EXECUTE.work"]),
		actors: ALL_ACTOR_PREFIXES,
		emitsSpec: false
	},
	"event:task_step_reset": {
		payload: TaskStepResetPayload,
		entrySchemaVersion: 1,
		subStates: new Set(FIX_BACK_EDGE_FROM),
		actors: CLI_ONLY,
		emitsSpec: false
	},
	"event:task_abandoned": {
		payload: TaskAbandonedPayload,
		entrySchemaVersion: 1,
		subStates: new Set(["EXECUTE.work"]),
		actors: ALL_ACTOR_PREFIXES,
		emitsSpec: false
	},
	"event:spec_req_added": {
		payload: SpecReqAddedPayload,
		entrySchemaVersion: 1,
		subStates: new Set(ALL_SPEC),
		actors: ALL_ACTOR_PREFIXES,
		emitsSpec: true
	},
	"event:spec_scenario_added": {
		payload: SpecScenarioAddedPayload,
		entrySchemaVersion: 1,
		subStates: new Set(ALL_SPEC),
		actors: ALL_ACTOR_PREFIXES,
		emitsSpec: true
	},
	"event:spec_visual_added": {
		payload: SpecVisualAddedPayload,
		entrySchemaVersion: 1,
		subStates: new Set(ALL_SPEC),
		actors: ALL_ACTOR_PREFIXES,
		emitsSpec: true
	},
	"event:spec_submitted": {
		payload: SpecSubmittedPayload,
		entrySchemaVersion: 1,
		subStates: new Set(ALL_SPEC),
		actors: ALL_ACTOR_PREFIXES,
		emitsSpec: true
	},
	"evidence:added": {
		payload: EvidenceAddedPayload,
		entrySchemaVersion: 1,
		subStates: new Set([...ALL_EXECUTE, ...VERIFY_OR_POST_LOCK_EXECUTE.filter((s) => s.startsWith("VERIFY"))]),
		actors: ALL_ACTOR_PREFIXES,
		emitsSpec: false
	},
	"lesson:recorded": {
		payload: LessonRecordedPayload,
		entrySchemaVersion: 1,
		subStates: ANY_NON_DONE,
		actors: HUMAN_ONLY,
		emitsSpec: false
	},
	"scope:recorded": {
		payload: ScopeRecordedPayload,
		entrySchemaVersion: 1,
		subStates: new Set(["EXECUTE.work"]),
		actors: CLI_ONLY,
		emitsSpec: false
	},
	"finding:raised": {
		payload: FindingRaisedPayload,
		entrySchemaVersion: 1,
		subStates: new Set(VERIFY_OR_POST_LOCK_EXECUTE),
		actors: ALL_ACTOR_PREFIXES,
		emitsSpec: false
	},
	"finding:closed": {
		payload: FindingClosedPayload,
		entrySchemaVersion: 1,
		subStates: new Set(VERIFY_OR_POST_LOCK_EXECUTE),
		actors: ALL_ACTOR_PREFIXES,
		emitsSpec: false
	},
	"pending:added": {
		payload: PendingAddedPayload,
		entrySchemaVersion: 1,
		subStates: ANY_SUB_STATE,
		actors: ALL_ACTOR_PREFIXES,
		emitsSpec: false
	},
	"pending:resolved": {
		payload: PendingResolvedPayload,
		entrySchemaVersion: 1,
		subStates: ANY_SUB_STATE,
		actors: ALL_ACTOR_PREFIXES,
		emitsSpec: false
	},
	"gate:decided": {
		payload: GateDecidedPayload,
		entrySchemaVersion: 1,
		subStates: new Set(["SPEC.design", "VERIFY.accept"]),
		actors: HUMAN_ONLY,
		emitsSpec: false
	},
	"session:started": {
		payload: SessionStartedPayload,
		entrySchemaVersion: 1,
		subStates: ANY_SUB_STATE,
		actors: ALL_ACTOR_PREFIXES,
		emitsSpec: false
	},
	"session:resumed": {
		payload: SessionResumedPayload,
		entrySchemaVersion: 1,
		subStates: ANY_SUB_STATE,
		actors: ALL_ACTOR_PREFIXES,
		emitsSpec: false
	},
	"session:delivered": {
		payload: SessionReasonPayload,
		entrySchemaVersion: 1,
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
		entrySchemaVersion: 1,
		subStates: ANY_NON_DONE,
		actors: HUMAN_ONLY,
		emitsSpec: false
	},
	"session:abandoned": {
		payload: SessionReasonPayload,
		entrySchemaVersion: 1,
		subStates: ANY_NON_DONE,
		actors: HUMAN_ONLY,
		emitsSpec: false
	},
	"spike:converted": {
		payload: SpikeConvertedPayload,
		entrySchemaVersion: 1,
		subStates: ANY_NON_DONE,
		actors: HUMAN_ONLY,
		emitsSpec: false
	}
};
const ALL_KINDS = Object.keys(KIND_REGISTRY);
const ENTRY_SCHEMA_VERSIONS = Object.fromEntries(ALL_KINDS.map((kind) => [kind, KIND_REGISTRY[kind].entrySchemaVersion]));
const PER_KIND_PAYLOAD = Object.fromEntries(ALL_KINDS.map((k) => [k, KIND_REGISTRY[k].payload]));
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
//#region src/core/reducer/preflight/checks-common.ts
function checkSeqMonotonic(c) {
	const { entry, ctx } = c;
	if (ctx.tail_seq === void 0) return null;
	const expectedSeq = ctx.tail_seq + 1;
	if (entry.seq !== expectedSeq) return {
		ok: false,
		code: "SEQ_NOT_MONOTONIC",
		detail: {
			got: entry.seq,
			expected: expectedSeq,
			tail_seq: ctx.tail_seq
		}
	};
	return null;
}
function checkSubStateAuthority(c) {
	const { entry, sub_state } = c;
	if (!isSubStateAllowed(entry.kind, sub_state)) return {
		ok: false,
		code: "SUB_STATE_AUTHORITY_VIOLATION",
		detail: {
			kind: entry.kind,
			sub_state
		}
	};
	return null;
}
function checkActorAuthority(c) {
	const { entry } = c;
	if (!isActorAllowed(entry.kind, entry.actor)) return {
		ok: false,
		code: "ACTOR_AUTHORITY_VIOLATION",
		detail: {
			kind: entry.kind,
			actor: entry.actor
		}
	};
	return null;
}
function checkPerKindPayload(c) {
	const { entry, payloadParsed } = c;
	if (!payloadParsed.success) return {
		ok: false,
		code: "INVALID_PAYLOAD",
		detail: {
			kind: entry.kind,
			issues: payloadParsed.error.issues,
			reason: payloadParsed.error.issues.map((issue) => issue.message).join("; ")
		}
	};
	return {
		ok: true,
		entry: {
			...entry,
			payload: payloadParsed.data
		}
	};
}
//#endregion
//#region src/core/reducer/invariants.ts
function resolveSpecVersionMode(batchIndex) {
	return batchIndex === void 0 || batchIndex === 0 ? "head" : "continuation";
}
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
//#region src/core/reducer/preflight/checks-spec.ts
const SPEC_CONTENT_KINDS = new Set([
	"event:spec_submitted",
	"event:spec_req_added",
	"event:spec_scenario_added",
	"event:spec_visual_added"
]);
function checkSpecContentPhase(c) {
	const { entry, ctx } = c;
	if (SPEC_CONTENT_KINDS.has(entry.kind)) {
		if (ctx.snapshot.state?.spec_locked === true) return {
			ok: false,
			code: "SPEC_LOCKED_NO_DIRECT_EDIT",
			detail: {
				kind: entry.kind,
				spec_locked: true
			}
		};
		if (entry.kind !== "event:spec_submitted" && (ctx.snapshot.state?.spec_version ?? 0) === 0) return {
			ok: false,
			code: "SPEC_NOT_INITIALIZED",
			detail: {
				kind: entry.kind,
				spec_version: ctx.snapshot.state?.spec_version ?? 0
			}
		};
	}
	return null;
}
function checkSpecDuplicateIds(c) {
	const { entry, ctx } = c;
	if (entry.kind === "event:spec_req_added") {
		const payload = entry.payload;
		if (findCollision(payload.req.id, ctx.snapshot.requirements, (r) => r.id)) return {
			ok: false,
			code: "DUPLICATE_REQ_ID",
			detail: { id: payload.req.id }
		};
	}
	if (entry.kind === "event:spec_scenario_added") {
		const payload = entry.payload;
		if (findCollision(payload.scenario.id, ctx.snapshot.scenarios, (s) => s.id)) return {
			ok: false,
			code: "DUPLICATE_SCEN_ID",
			detail: { id: payload.scenario.id }
		};
	}
	if (entry.kind === "event:spec_visual_added") {
		const payload = entry.payload;
		if (findCollision(payload.visual.id, ctx.snapshot.visual_contracts, (v) => v.id)) return {
			ok: false,
			code: "DUPLICATE_VIS_ID",
			detail: { id: payload.visual.id }
		};
	}
	return null;
}
function checkSpecVersion(c) {
	const { entry, ctx } = c;
	if (entry.kind === "event:spec_submitted" || entry.kind === "event:spec_req_added" || entry.kind === "event:spec_scenario_added" || entry.kind === "event:spec_visual_added") {
		const payloadVersion = entry.payload.spec_version;
		const currentVersion = ctx.snapshot.state?.spec_version ?? 0;
		if (entry.kind === "event:spec_submitted") {
			if (entry.batch_index !== void 0 && entry.batch_index !== 0) return {
				ok: false,
				code: "SPEC_VERSION_BATCH_MISMATCH",
				detail: {
					kind: entry.kind,
					batch_index: entry.batch_index,
					expected_batch_index: 0,
					current_spec_version: currentVersion,
					payload_spec_version: payloadVersion
				}
			};
			const v = checkSpecVersion$1(payloadVersion, currentVersion, "head");
			if (!v.ok) return {
				ok: false,
				code: "SPEC_VERSION_NOT_MONOTONIC",
				detail: {
					kind: entry.kind,
					payload_spec_version: payloadVersion,
					current_spec_version: currentVersion,
					expected_spec_version: v.expected
				}
			};
		} else {
			const mode = resolveSpecVersionMode(entry.batch_index);
			const v = checkSpecVersion$1(payloadVersion, currentVersion, mode);
			if (!v.ok) {
				if (mode === "head") return {
					ok: false,
					code: "SPEC_VERSION_NOT_MONOTONIC",
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
	return null;
}
//#endregion
//#region src/core/task-amend-policy.ts
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
//#endregion
//#region src/core/task-graph.ts
function areTaskDependenciesSatisfied(task, tasksById) {
	return task.depends_on.every((dependencyId) => tasksById.get(dependencyId)?.status === "done");
}
/** Validate the batch-final task projection at the admission boundary. */
function checkTaskGraph(tasks) {
	const tasksById = new Map(tasks.map((task) => [task.id, task]));
	for (const task of tasks) for (let index = 0; index < task.depends_on.length; index++) {
		const dependencyId = task.depends_on[index];
		if (!tasksById.has(dependencyId)) return {
			code: "TASK_DEP_NOT_FOUND",
			detail: {
				task_id: task.id,
				field: `depends_on[${index}]`,
				ref: dependencyId
			}
		};
	}
	for (const task of tasks) if (task.depends_on.includes(task.id)) return {
		code: "TASK_DEP_SELF",
		detail: { task_id: task.id }
	};
	for (const task of tasks) {
		const firstIndexByDependency = /* @__PURE__ */ new Map();
		for (let index = 0; index < task.depends_on.length; index++) {
			const dependencyId = task.depends_on[index];
			const firstIndex = firstIndexByDependency.get(dependencyId);
			if (firstIndex !== void 0) return {
				code: "TASK_DEP_DUPLICATE",
				detail: {
					task_id: task.id,
					ref: dependencyId,
					indexes: [firstIndex, index]
				}
			};
			firstIndexByDependency.set(dependencyId, index);
		}
	}
	const visited = /* @__PURE__ */ new Set();
	const active = /* @__PURE__ */ new Set();
	const stack = [];
	const findCycle = (taskId) => {
		visited.add(taskId);
		active.add(taskId);
		stack.push(taskId);
		const task = tasksById.get(taskId);
		for (const dependencyId of task.depends_on) if (!visited.has(dependencyId)) {
			const cycle = findCycle(dependencyId);
			if (cycle !== null) return cycle;
		} else if (active.has(dependencyId)) {
			const cycleStart = stack.indexOf(dependencyId);
			return [...stack.slice(cycleStart), dependencyId];
		}
		stack.pop();
		active.delete(taskId);
		return null;
	};
	for (const task of tasks) {
		if (visited.has(task.id)) continue;
		const cycle = findCycle(task.id);
		if (cycle !== null) return {
			code: "TASK_DEP_CYCLE",
			detail: { cycle }
		};
	}
	for (const task of tasks) {
		if (task.status === "done" || task.status === "abandoned") continue;
		for (let index = 0; index < task.depends_on.length; index++) {
			const dependencyId = task.depends_on[index];
			if (tasksById.get(dependencyId).status === "abandoned") return {
				code: "TASK_DEP_ABANDONED",
				detail: {
					task_id: task.id,
					field: `depends_on[${index}]`,
					ref: dependencyId,
					hint: "replace the abandoned dependency via amend-tasks"
				}
			};
		}
	}
	return null;
}
//#endregion
//#region src/core/reducer/preflight/checks-task.ts
function hasForbiddenTaskRedInput(inputPayload, taskIndex) {
	if (typeof inputPayload !== "object" || inputPayload === null) return false;
	let task;
	if (taskIndex === void 0) {
		if ("task" in inputPayload) task = inputPayload.task;
	} else if ("tasks" in inputPayload && Array.isArray(inputPayload.tasks)) task = inputPayload.tasks[taskIndex];
	return typeof task === "object" && task !== null && "red_test_registered" in task && task.red_test_registered === true;
}
function checkTasksPlanned(c) {
	const { entry, inputPayload } = c;
	if (entry.kind === "event:tasks_planned") {
		const seenIds = /* @__PURE__ */ new Set();
		for (const [index, task] of entry.payload.tasks.entries()) {
			if (seenIds.has(task.id)) return {
				ok: false,
				code: "DUPLICATE_TASK_ID",
				detail: { task_id: task.id }
			};
			seenIds.add(task.id);
			if (task.kind === "behavioral" ? task.red_test_registered === true : hasForbiddenTaskRedInput(inputPayload, index)) return {
				ok: false,
				code: "BUG_TASK_FLAG_MISUSE",
				detail: {
					task_id: task.id,
					kind: "event:tasks_planned"
				}
			};
		}
	}
	return null;
}
function checkTasksAmended(c) {
	const { entry, inputPayload, sub_state, ctx } = c;
	if (entry.kind === "event:tasks_amended") {
		const amended = entry.payload;
		const mode = amended.mode;
		const taskId = amended.task.id;
		const sponsorId = amended.sponsored_by_finding_id;
		if (amended.task.kind !== "behavioral" && hasForbiddenTaskRedInput(inputPayload)) return {
			ok: false,
			code: "BUG_TASK_FLAG_MISUSE",
			detail: {
				task_id: taskId,
				kind: entry.kind
			}
		};
		if (sponsorId !== void 0) {
			const sponsor = requireFindingSponsor(ctx.snapshot.findings, sponsorId, "amend-tasks");
			if (!sponsor.ok) return sponsor;
			if (sub_state !== "EXECUTE.work") return {
				ok: false,
				code: "MUTATION_OUT_OF_RIGHTS",
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
					detail: { task_id: taskId }
				};
				const violation = firstSponsoredFrozenViolation(currentTask, extractTaskSlim(amended.task));
				if (violation) return {
					ok: false,
					code: "MUTATION_OUT_OF_RIGHTS",
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
			return null;
		}
		if (mode === "add") return {
			ok: false,
			code: "MUTATION_OUT_OF_RIGHTS",
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
			detail: { task_id: taskId }
		};
		const violation = firstFrozenViolation(currentTask, extractTaskSlim(amended.task));
		if (violation) return {
			ok: false,
			code: "MUTATION_OUT_OF_RIGHTS",
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
	return null;
}
function checkTaskLifecycle(c) {
	const { entry, ctx } = c;
	if (entry.kind === "event:task_claimed" || entry.kind === "event:task_step_started" || entry.kind === "event:task_step_done") {
		const task_id = entry.payload.task_id;
		const task = ctx.snapshot.tasks.find((t) => t.id === task_id);
		if (!task) return {
			ok: false,
			code: "TASK_NOT_FOUND",
			detail: {
				task_id,
				kind: entry.kind
			}
		};
		if (entry.kind === "event:task_claimed") {
			if (task.status === "in_progress") return {
				ok: false,
				code: "TASK_ALREADY_CLAIMED",
				detail: {
					task_id,
					status: task.status
				}
			};
			if (task.status === "done" || task.status === "abandoned") return {
				ok: false,
				code: "TASK_NOT_CLAIMABLE",
				detail: {
					task_id,
					status: task.status
				}
			};
			const tasksById = new Map(ctx.snapshot.tasks.map((candidate) => [candidate.id, candidate]));
			if (!areTaskDependenciesSatisfied(task, tasksById)) {
				const blockingDepId = task.depends_on.find((dependencyId) => tasksById.get(dependencyId)?.status !== "done");
				return {
					ok: false,
					code: "TASK_DEPS_NOT_SATISFIED",
					detail: {
						task_id,
						blocking_dep: blockingDepId,
						blocking_status: tasksById.get(blockingDepId)?.status ?? "missing"
					}
				};
			}
		} else {
			const step = entry.payload.step;
			if (task.status !== "in_progress") return {
				ok: false,
				code: "TASK_NOT_CLAIMED",
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
				detail: {
					task_id,
					step,
					kind: entry.kind
				}
			};
			if (entry.kind === "event:task_step_done" && entry.payload.red_test_registered === true) {
				const result = entry.payload.result;
				const okResult = result === void 0 || result === "passed" || result === "waived";
				if (!(step === "red" && task.kind === "behavioral" && task.labels.includes("bug") && okResult)) return {
					ok: false,
					code: "BUG_TASK_FLAG_MISUSE",
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
	return null;
}
function checkTaskAbandoned(c) {
	const { entry, ctx } = c;
	if (entry.kind === "event:task_abandoned") {
		const task_id = entry.payload.task_id;
		const task = ctx.snapshot.tasks.find((t) => t.id === task_id);
		if (!task) return {
			ok: false,
			code: "TASK_NOT_FOUND",
			detail: {
				task_id,
				kind: entry.kind
			}
		};
		if (task.status === "done" || task.status === "abandoned") return {
			ok: false,
			code: "TASK_NOT_ABANDONABLE",
			detail: {
				task_id,
				status: task.status
			}
		};
		const blockingDependents = ctx.snapshot.tasks.filter((t) => t.depends_on.includes(task_id) && t.status !== "done" && t.status !== "abandoned").map((t) => t.id);
		if (blockingDependents.length > 0) return {
			ok: false,
			code: "TASK_ABANDON_BLOCKED_DEPENDENTS",
			detail: {
				task_id,
				blocking_dependents: blockingDependents
			}
		};
	}
	return null;
}
function checkTaskStepReset(c) {
	const { entry, ctx, sub_state } = c;
	if (entry.kind === "event:task_step_reset") return checkFindingReset(entry.payload, ctx.snapshot, sub_state);
	return null;
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
//#region src/core/reducer/preflight/checks-workflow.ts
function checkGateDecided(c) {
	const { entry, sub_state, ctx } = c;
	if (entry.kind === "gate:decided") {
		const gateKind = entry.payload.gate_kind;
		if (gateKind === "spec-lock" && sub_state !== "SPEC.design") return {
			ok: false,
			code: "SUB_STATE_AUTHORITY_VIOLATION",
			detail: {
				kind: entry.kind,
				gate_kind: gateKind,
				sub_state,
				expected: "SPEC.design"
			}
		};
		if (gateKind === "verify-accept" && sub_state !== "VERIFY.accept") return {
			ok: false,
			code: "SUB_STATE_AUTHORITY_VIOLATION",
			detail: {
				kind: entry.kind,
				gate_kind: gateKind,
				sub_state,
				expected: "VERIFY.accept"
			}
		};
		const pendingPlan = planGatePending(ctx.snapshot.pending, gateKind, entry.payload.decision);
		if (!pendingPlan.ok) return pendingPlan;
	}
	return null;
}
function checkPhaseAdvanced(c) {
	const { entry, sub_state, ctx } = c;
	if (entry.kind === "event:phase_advanced") {
		const payload = entry.payload;
		const from = payload.from;
		if (from !== sub_state) return {
			ok: false,
			code: "FROM_CURSOR_MISMATCH",
			detail: {
				payload_from: from,
				current_sub_state: sub_state
			}
		};
		const pendingFailure = checkPendingAdvance(ctx.snapshot.pending);
		if (pendingFailure) return {
			ok: false,
			...pendingFailure
		};
		const backEdge = payload.back_edge;
		if (backEdge !== void 0) {
			const sponsor = requireFindingSponsor(ctx.snapshot.findings, backEdge.finding_id, backEdge.action);
			if (!sponsor.ok) return sponsor;
		}
		const phaseTo = payload.to;
		if (backEdge === void 0 && sub_state === "EXECUTE.work" && phaseTo === "EXECUTE.done") {
			const nonFinal = ctx.snapshot.tasks.filter((t) => t.status !== "done" && t.status !== "abandoned").map((t) => ({
				task_id: t.id,
				status: t.status
			}));
			if (nonFinal.length > 0) return {
				ok: false,
				code: "EXECUTE_DONE_TASKS_NOT_FINAL",
				detail: {
					non_final: nonFinal,
					count: nonFinal.length
				}
			};
		}
	}
	return null;
}
function checkSessionDelivered(c) {
	const { entry, sub_state, ceremony, verify_accepted, ctx } = c;
	if (entry.kind === "session:delivered") {
		const activeSpike = ctx.snapshot.tasks.find((t) => t.kind === "spike" && t.status !== "abandoned");
		if (activeSpike) return {
			ok: false,
			code: "DELIVER_SPIKE_TASKS",
			detail: {
				task_id: activeSpike.id,
				status: activeSpike.status
			}
		};
		if (sub_state === "EXECUTE.done") {
			if (ceremony.verify_phase) return {
				ok: false,
				code: "DELIVER_NOT_ACCEPTED",
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
				detail: {
					sub_state,
					settle_phase: ceremony.settle_phase
				}
			};
			if (!verify_accepted) return {
				ok: false,
				code: "DELIVER_NOT_ACCEPTED",
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
				detail: {
					sub_state,
					verify_accepted
				}
			};
		}
	}
	return null;
}
function checkSpikeConverted(c) {
	const { entry, ctx } = c;
	if (entry.kind === "spike:converted") {
		if (!ctx.snapshot.tasks.some((t) => t.kind === "spike" && t.status !== "abandoned")) return {
			ok: false,
			code: "SPIKE_CONVERT_NO_SPIKE_TASK",
			detail: {}
		};
	}
	return null;
}
function checkCeremonySet(c) {
	const { entry, sub_state, ctx } = c;
	if (entry.kind === "event:ceremony_set") {
		const pendingFailure = checkPendingEscalation(ctx.snapshot.pending, sub_state);
		if (pendingFailure) return {
			ok: false,
			...pendingFailure
		};
	}
	return null;
}
function checkSessionTerminalReason(c) {
	const { entry } = c;
	if (entry.kind === "session:archived" || entry.kind === "session:abandoned") {
		if (entry.payload.reason === void 0) return {
			ok: false,
			code: "SESSION_REASON_REQUIRED",
			detail: { kind: entry.kind }
		};
	}
	return null;
}
function checkFindingRaised(c) {
	const { entry, sub_state, ctx } = c;
	if (entry.kind === "finding:raised") return checkFindingRaise(entry.payload, ctx.snapshot, sub_state);
	return null;
}
function checkTransitionEdge(c) {
	const { entry, ceremony, verify_accepted, spec_locked } = c;
	if (entry.kind !== "event:phase_advanced") return null;
	const { from, to, back_edge } = entry.payload;
	const transitionResult = validateTransition(from, to, {
		ceremony,
		verify_accepted,
		spec_locked,
		actor: entry.actor,
		...back_edge !== void 0 ? { back_edge } : {}
	});
	if (!transitionResult.ok) return transitionResult;
	return null;
}
function deriveCeremonyLabel(c) {
	if (!c.spec_phase && !c.verify_phase) return "quick";
	if (c.spec_phase && !c.verify_phase) return "light";
	if (c.spec_phase && c.verify_phase && !c.settle_phase) return "standard";
	if (c.spec_phase && c.verify_phase && c.settle_phase) return "deep";
	return "custom";
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
function preflight(rawEntry, ctx) {
	const sub_state = ctx.snapshot.state?.sub_state ?? DEFAULT_SUB_STATE;
	const ceremony = ctx.snapshot.state?.ceremony ?? DEFAULT_CEREMONY;
	const verify_accepted = ctx.snapshot.state?.verify_accepted ?? false;
	const spec_locked = ctx.snapshot.state?.spec_locked ?? false;
	const parsed = JournalEntry.safeParse(rawEntry);
	if (!parsed.success) return {
		ok: false,
		code: "INVALID_ENVELOPE",
		detail: {
			issues: parsed.error.issues,
			reason: parsed.error.issues.map((issue) => issue.message).join("; ")
		}
	};
	const entry = parsed.data;
	const envelopeCtx = {
		entry,
		payloadParsed: PER_KIND_PAYLOAD[entry.kind].safeParse(entry.payload),
		ctx,
		sub_state,
		ceremony,
		verify_accepted,
		spec_locked
	};
	for (const check of AUTHORITY_CHECKS) {
		const failure = check(envelopeCtx);
		if (failure) return failure;
	}
	const admitted = checkPerKindPayload(envelopeCtx);
	if (!admitted.ok) return admitted;
	const checkCtx = {
		entry: admitted.entry,
		inputPayload: entry.payload,
		ctx,
		sub_state,
		ceremony,
		verify_accepted,
		spec_locked
	};
	for (const check of SEMANTIC_CHECKS) {
		const failure = check(checkCtx);
		if (failure) return failure;
	}
	return admitted;
}
const AUTHORITY_CHECKS = [
	checkSeqMonotonic,
	checkSubStateAuthority,
	checkActorAuthority
];
const SEMANTIC_CHECKS = [
	checkGateDecided,
	checkPhaseAdvanced,
	checkSessionDelivered,
	checkSpikeConverted,
	checkCeremonySet,
	checkSessionTerminalReason,
	checkTasksPlanned,
	checkTasksAmended,
	checkTaskLifecycle,
	checkTaskAbandoned,
	checkTaskStepReset,
	checkFindingRaised,
	checkSpecContentPhase,
	checkSpecDuplicateIds,
	checkSpecVersion,
	checkTransitionEdge
];
[...AUTHORITY_CHECKS, ...SEMANTIC_CHECKS];
//#endregion
//#region src/core/entry-admission.ts
/**
* Admits one entry and consumes `prev`; projection application can mutate its
* arrays in place. Clone first when the caller needs the prior snapshot.
* Every kind passes preflight before projection application. Supply tail_seq
* when the caller owns the journal tail; replayJournal checks envelope and
* sequence continuity independently and omits it.
*/
function admitEntry(prev, entry, options = {}) {
	if (!(entry.kind === "session:started") && prev.state === null) return {
		ok: false,
		stage: "admission",
		code: "NO_SESSION",
		detail: { kind: entry.kind }
	};
	const checked = preflight(entry, {
		snapshot: prev,
		...options
	});
	if (!checked.ok) return {
		...checked,
		stage: "admission"
	};
	const result = applyValidated(prev, checked.entry);
	if (!result.ok) return {
		...result,
		stage: "reducer"
	};
	return result;
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
		const expectedSeq = lastSeq + 1;
		if (entry.seq !== expectedSeq) return {
			ok: false,
			code: "INVALID_ENTRY",
			message: `journal seq not monotonic: entry.seq=${entry.seq} but expected ${expectedSeq} (prior applied seq=${lastSeq})`,
			at_seq: entry.seq,
			detail: {
				expected_seq: expectedSeq,
				got_seq: entry.seq,
				prior_seq: lastSeq
			}
		};
		const result = admitEntry(snapshot, entry);
		if (!result.ok) {
			const { ok: _ok, stage: _stage, ...diagnostic } = result;
			return {
				ok: false,
				code: "REDUCER_REJECTED",
				diagnostic,
				at_seq: entry.seq,
				detail: {
					...result.detail,
					inner_code: result.code
				}
			};
		}
		snapshot = result.snapshot;
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
z.object({
	seq: z.number().int().nonnegative(),
	entry_id: EntryId,
	at: z.string().datetime(),
	actor: ActorString,
	entry_schema_version: z.number().int().positive(),
	kind: z.string().min(1),
	payload: z.unknown(),
	batch_id: BatchId.optional(),
	batch_index: z.number().int().nonnegative().optional(),
	batch_count: z.number().int().positive().optional()
}).passthrough().refine((entry) => {
	const present = [
		entry.batch_id,
		entry.batch_index,
		entry.batch_count
	].filter((value) => value !== void 0).length;
	return present === 0 || present === 3;
}, { message: "batch_id, batch_index, batch_count must be all-present or all-absent" }).refine((entry) => entry.batch_index === void 0 || entry.batch_count === void 0 || entry.batch_index < entry.batch_count, { message: "batch_index must be < batch_count" });
//#endregion
//#region src/core/cli-runtime.ts
const LOAF_DOCS_URL = "https://docs.loaf.invalid";
const LOAF_ISSUE_URL = "https://issues.loaf.invalid";
function helpFooter() {
	return `\ndocs:       ${LOAF_DOCS_URL}\nreport bug: ${LOAF_ISSUE_URL}\n`;
}
async function loadSession(featureDir, opts = {}) {
	if (opts.ensureDir ?? true) await promises.mkdir(featureDir, { recursive: true });
	const replay = await replayJournal(path.join(featureDir, "journal.jsonl"), { collect_entries: true });
	if (!replay.ok) {
		const reason = replay.code === "REDUCER_REJECTED" ? `entry at seq ${replay.at_seq} rejected by ${replay.diagnostic.code}` : replay.message;
		throw new Error(`failed to load session at ${featureDir}: ${replay.code} — ${reason}`, { cause: replay });
	}
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
	for (const entry of entries) if (entry.kind === "event:tasks_planned") {
		const candidate = entry.payload.tasks?.find((t) => t.id === taskId);
		current = candidate === void 0 ? void 0 : TaskFullPayload.parse(candidate);
	} else if (entry.kind === "event:tasks_amended") {
		const payload = entry.payload;
		if (payload.task?.id === taskId) current = TaskFullPayload.parse(payload.task);
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
* `test_layer`, kind-specific contract fields, and per-step `reason` /
* `started_at`. The base body defines the canonical step set;
* a step absent from `current.steps` keeps its base values.
*/
function materializeTaskForAmend(base, current) {
	const out = TaskFullPayload.parse(base);
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
* the replacement a fresh `execution` block (every step `pending`, no
* `started_at` / `reason`). A sponsored graph amend
* must NOT erase execution history, so for every step RETAINED across the
* replacement (present in both bodies) this copies the body-only progress
* fields — `started_at` and `reason` — from the canonical body.
* A step introduced by the replacement keeps its fresh, unstarted values.
*
* `status` / `applicability` are NOT carried here — `materializeTaskForAmend`
* overlays those from the slim projection downstream. This helper is the
* CLI-side guard for the body-only half of the Q4 frozen-field rule:
* stable-core preflight runs against the slim `Snapshot.tasks` projection,
* which drops `started_at` / step `reason`, so it cannot
* verify their preservation (see the §8.6 sponsored-branch comment in
* preflight.ts).
*/
function carryForwardStepProgress(replacement, canonical) {
	const out = TaskFullPayload.parse(replacement);
	const outExec = out.execution;
	const priorExec = canonical.execution;
	for (const stepName of Object.keys(outExec)) {
		const priorRaw = priorExec[stepName];
		const step = outExec[stepName];
		if (!priorRaw || !step) continue;
		const prior = TaskExecutionStepPayload.parse(priorRaw);
		if (prior.started_at !== void 0) step.started_at = prior.started_at;
		if (prior.reason !== void 0) step.reason = prior.reason;
	}
	return out;
}
//#endregion
//#region src/core/attachment-authority.ts
const LONG_TEXT_SLOTS = {
	"evidence:added": { summary: "summary.txt" },
	"lesson:recorded": { summary: "summary.txt" },
	"scope:recorded": { paths: "paths.txt" }
};
var AttachmentAuthorityError = class extends Error {
	code;
	detail;
	constructor(code, message, detail = {}) {
		super(message);
		this.code = code;
		this.detail = detail;
		this.name = "AttachmentAuthorityError";
	}
};
function attachmentFieldsFor(kind) {
	return Object.keys(LONG_TEXT_SLOTS[kind] ?? {});
}
function expectedRelativePath(owner, field) {
	const suffix = LONG_TEXT_SLOTS[owner.kind]?.[field];
	if (!suffix) throw new AttachmentAuthorityError("ATTACHMENT_UNAUTHORIZED", `attachment slot ${owner.kind}.${field} is not registered`, {
		entry_id: owner.entry_id,
		kind: owner.kind,
		field
	});
	return `attachments/${owner.entry_id}/${suffix}`;
}
function assertAuthorizedRef(owner, field, ref) {
	const expected = expectedRelativePath(owner, field);
	if (ref.path !== expected) throw new AttachmentAuthorityError("ATTACHMENT_UNAUTHORIZED", `attachment ref ${ref.path} does not own slot ${owner.entry_id}:${owner.kind}.${field}`, {
		expected,
		actual: ref.path,
		entry_id: owner.entry_id,
		kind: owner.kind,
		field
	});
	return expected;
}
function assertAttachmentOwnership(owner, field, ref) {
	assertAuthorizedRef(owner, field, ref);
}
function isInside(root, candidate) {
	const relative = path.relative(root, candidate);
	return relative === "" || !relative.startsWith(`..${path.sep}`) && relative !== "..";
}
async function realFeatureRoot(featureDir) {
	const root = await promises.realpath(featureDir);
	if (!(await promises.lstat(root)).isDirectory()) throw new AttachmentAuthorityError("ATTACHMENT_UNSAFE_PATH", `feature attachment root is not a directory: ${featureDir}`);
	return root;
}
async function prepareParent(root, relativeFile, create) {
	const parentSegments = path.posix.dirname(relativeFile).split("/");
	let current = root;
	for (const segment of parentSegments) {
		current = path.join(current, segment);
		if (create) await promises.mkdir(current).catch((error) => {
			if (error.code !== "EEXIST") throw error;
		});
		let stat;
		try {
			stat = await promises.lstat(current);
		} catch (error) {
			if (error.code === "ENOENT") throw new AttachmentAuthorityError("ATTACHMENT_MISSING", `attachment directory is missing: ${current}`, { path: current });
			throw error;
		}
		if (stat.isSymbolicLink()) throw new AttachmentAuthorityError("ATTACHMENT_UNSAFE_PATH", `attachment directory must not be a symlink: ${current}`, { path: current });
		if (!stat.isDirectory()) throw new AttachmentAuthorityError("ATTACHMENT_UNSAFE_PATH", `attachment path component is not a directory: ${current}`, { path: current });
		const real = await promises.realpath(current);
		if (!isInside(root, real)) throw new AttachmentAuthorityError("ATTACHMENT_UNSAFE_PATH", `attachment directory escapes the feature root: ${current}`, {
			path: current,
			resolved: real
		});
	}
	return current;
}
async function inspectFinalPath(finalPath) {
	try {
		const stat = await promises.lstat(finalPath);
		if (stat.isSymbolicLink()) throw new AttachmentAuthorityError("ATTACHMENT_UNSAFE_PATH", `attachment file must not be a symlink: ${finalPath}`, { path: finalPath });
		if (!stat.isFile()) throw new AttachmentAuthorityError("ATTACHMENT_NOT_FILE", `attachment target is not a regular file: ${finalPath}`, { path: finalPath });
		return "file";
	} catch (error) {
		if (error.code === "ENOENT") return "missing";
		throw error;
	}
}
async function readAttachment(featureDir, owner, field, ref) {
	const relative = assertAuthorizedRef(owner, field, ref);
	const root = await realFeatureRoot(featureDir);
	await prepareParent(root, relative, false);
	const finalPath = path.join(root, ...relative.split("/"));
	if (await inspectFinalPath(finalPath) === "missing") throw new AttachmentAuthorityError("ATTACHMENT_MISSING", `attachment file is missing: ${ref.path}`, { path: ref.path });
	let handle;
	try {
		handle = await promises.open(finalPath, constants.O_RDONLY | constants.O_NOFOLLOW);
	} catch (error) {
		const code = error.code;
		if (code === "ENOENT") throw new AttachmentAuthorityError("ATTACHMENT_MISSING", `attachment file is missing: ${ref.path}`, { path: ref.path });
		if (code === "ELOOP") throw new AttachmentAuthorityError("ATTACHMENT_UNSAFE_PATH", `attachment file became a symlink: ${ref.path}`, { path: ref.path });
		throw error;
	}
	try {
		const stat = await handle.stat();
		if (!stat.isFile()) throw new AttachmentAuthorityError("ATTACHMENT_NOT_FILE", `attachment target is not a regular file: ${ref.path}`, { path: ref.path });
		const body = await handle.readFile();
		const actualSha256 = createHash("sha256").update(body).digest("hex");
		if (stat.size !== body.byteLength || body.byteLength !== ref.size || actualSha256 !== ref.sha256) throw new AttachmentAuthorityError("ATTACHMENT_INTEGRITY", `attachment ${ref.path} integrity mismatch`, {
			expected_size: ref.size,
			actual_size: body.byteLength,
			expected_sha256: ref.sha256,
			actual_sha256: actualSha256
		});
		return body;
	} finally {
		await handle.close();
	}
}
async function writeAttachment(featureDir, owner, field, content, opts = {}) {
	const relative = expectedRelativePath(owner, field);
	const root = await realFeatureRoot(featureDir);
	const parent = await prepareParent(root, relative, true);
	const finalPath = path.join(root, ...relative.split("/"));
	await inspectFinalPath(finalPath);
	const body = Buffer.isBuffer(content) ? content : Buffer.from(content, "utf8");
	const tmpPath = path.join(parent, `.${path.basename(finalPath)}.tmp-${randomBytes(6).toString("hex")}`);
	let handle;
	try {
		handle = await promises.open(tmpPath, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 420);
		await handle.writeFile(body);
		if (opts.fsync ?? true) await handle.sync();
		await handle.close();
		handle = void 0;
		await inspectFinalPath(finalPath);
		await promises.rename(tmpPath, finalPath);
		if (opts.fsync ?? true) {
			const directory = await promises.open(parent, constants.O_RDONLY);
			try {
				await directory.sync();
			} finally {
				await directory.close();
			}
		}
	} finally {
		if (handle) await handle.close().catch(() => {});
		await promises.unlink(tmpPath).catch(() => {});
	}
	return {
		path: relative,
		sha256: createHash("sha256").update(body).digest("hex"),
		size: body.byteLength
	};
}
//#endregion
//#region src/core/lessons-projection.ts
/**
* Select lesson entries from the journal stream (journal order = seq order).
* Only the dedicated lesson kind owns lesson content.
* Operates on FULL journal payloads, not the slim `Snapshot.evidence`.
*/
function selectLessonEntries(entries) {
	const lessons = [];
	for (const e of entries) {
		if (e.kind !== "lesson:recorded") continue;
		const payload = LessonRecordedPayload.parse(e.payload);
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
* sidecar LongTextFields are resolved by the attachment authority, which
* verifies entry/slot ownership, path safety, `ref.sha256`, and `ref.size`.
* Any rejection THROWS and surfaces as PROJECTION_WRITE_FAILED at the writer
* boundary.
*/
async function resolveLessonBodies(featureDir, lessons) {
	const resolved = [];
	for (const lesson of lessons) {
		const { summary } = lesson;
		let body;
		if (typeof summary === "string") body = summary;
		else if (summary.mode === "inline") body = summary.text;
		else body = (await readAttachment(featureDir, {
			entry_id: lesson.entry_id,
			kind: "lesson:recorded"
		}, "summary", summary.ref)).toString("utf8");
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
* Start identity fields are read from the validated `session:started`
* payload. Only session_label is optional and projects as null when omitted.
* complexity_score has no journal source and remains null. created_at is the
* start envelope timestamp; updated_at is the last replayed entry timestamp.
* based_on.tasks counts tasks_planned + tasks_amended entries.
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
	const ceremonyLabel = startPayload.ceremony_label;
	const workspace = startPayload.workspace;
	const loafVersionRequired = startPayload.loaf_version_required;
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
		pending: livePending(composePendingJson(entries).pending).map(({ resolved: _resolved, ...queue }) => queue),
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
* payload-derived summary / reason / target). Validated against FindingsJson.
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
* Does NOT acquire the per-feature lease itself. Both live callers already
* hold it: `mutateBatch` spans append through projection publication, and
* `loaf doctor --rebuild` acquires the same lease before replay. Keeping
* acquisition at the operation boundary prevents a nested lease.
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
	const workspace = startPayload.workspace;
	const ceremonyLabel = startPayload.ceremony_label;
	const unresolved = livePending(composePendingJson(entries).pending).map(({ resolved: _resolved, ...rest }) => rest);
	const pendingHead = unresolved[0] ?? null;
	const pendingQueueDepth = unresolved.length;
	const activeTasks = snapshot.tasks.filter((t) => t.status === "in_progress").map((t) => t.id);
	const feature = startPayload.feature;
	return RegistryFile.parse({
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
//#region src/core/session-runtime.ts
const RuntimeLockFile = z.object({
	pid: z.number().int().positive(),
	acquired_at: z.string().datetime(),
	operation: z.string().min(1).max(200),
	owner: z.string().regex(/^[0-9a-f]{32}$/).optional()
}).strict();
var RuntimeStoreError = class extends Error {
	code;
	holder;
	lockDetail;
	constructor(...args) {
		const [code, message, holder, lockDetail] = args;
		super(message);
		this.name = "RuntimeStoreError";
		this.code = code;
		if (holder !== void 0) this.holder = holder;
		if (lockDetail !== void 0) this.lockDetail = lockDetail;
	}
};
const DEFAULT_LOCK_TIMEOUT_MS = 2e3;
const DEFAULT_RETRY_DELAY_MS$1 = 20;
const SAFE_SESSION_ID = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
function defaultRuntimeDir(homeDir) {
	return path.join(homeDir, ".loaf", "runtime");
}
function checkedSessionId(sessionId) {
	if (!SAFE_SESSION_ID.test(sessionId)) throw new RuntimeStoreError("RUNTIME_IDENTITY_MISMATCH", `unsafe runtime session_id ${JSON.stringify(sessionId)}`);
	return sessionId;
}
function sessionRuntimeFilePath(sessionId, options) {
	return path.join(options.runtimeDir, `${checkedSessionId(sessionId)}.json`);
}
function sessionRuntimeLockPath(sessionId, options) {
	return path.join(options.runtimeDir, `${checkedSessionId(sessionId)}.lock`);
}
async function canonicalIdentity(identity) {
	checkedSessionId(identity.session_id);
	let cwd;
	try {
		cwd = await promises.realpath(identity.cwd);
	} catch (error) {
		throw new RuntimeStoreError("RUNTIME_IDENTITY_MISMATCH", `selected runtime cwd cannot be canonicalized: ${error.message}`);
	}
	return {
		session_id: identity.session_id,
		cwd
	};
}
async function ensureRuntimeDir(runtimeDir) {
	await promises.mkdir(runtimeDir, {
		recursive: true,
		mode: 448
	});
	await promises.chmod(runtimeDir, 448);
}
async function validateFileIdentity(file, identity) {
	let fileCwd;
	try {
		fileCwd = await promises.realpath(file.cwd);
	} catch (error) {
		throw new RuntimeStoreError("RUNTIME_IDENTITY_MISMATCH", `runtime file cwd cannot be canonicalized: ${error.message}`);
	}
	if (file.session_id !== identity.session_id || fileCwd !== identity.cwd) throw new RuntimeStoreError("RUNTIME_IDENTITY_MISMATCH", `runtime identity mismatch: selected session=${identity.session_id} cwd=${identity.cwd}, file session=${file.session_id} cwd=${fileCwd}; refusing to merge`);
	return file;
}
async function readSessionRuntimeFileUnlocked(identity, options) {
	const target = sessionRuntimeFilePath(identity.session_id, options);
	let raw;
	try {
		raw = await promises.readFile(target, "utf8");
	} catch (error) {
		if (error.code === "ENOENT") return null;
		throw error;
	}
	let decoded;
	try {
		decoded = JSON.parse(raw);
	} catch (error) {
		throw new RuntimeStoreError("RUNTIME_FILE_INVALID", `runtime file is not valid JSON: ${error.message}`);
	}
	const parsed = SessionRuntimeFile.safeParse(decoded);
	if (!parsed.success) throw new RuntimeStoreError("RUNTIME_FILE_INVALID", `runtime file failed SessionRuntimeFile validation: ${parsed.error.message}`);
	return await validateFileIdentity(parsed.data, identity);
}
/** Lock-free read is safe because writers publish only through atomic rename. */
async function readSessionRuntimeFile(identity, options) {
	return await readSessionRuntimeFileUnlocked(await canonicalIdentity(identity), options);
}
async function writeSessionRuntimeFileUnlocked(file, identity, options) {
	const runtimeDir = options.runtimeDir;
	await ensureRuntimeDir(runtimeDir);
	const target = sessionRuntimeFilePath(identity.session_id, options);
	const tmp = `${target}.tmp-${process.pid}-${randomBytes(6).toString("hex")}`;
	let handle = null;
	try {
		handle = await promises.open(tmp, "wx", 384);
		await handle.writeFile(JSON.stringify(file));
		await handle.sync();
		await handle.close();
		handle = null;
		await promises.chmod(tmp, 384);
		await promises.rename(tmp, target);
		try {
			const directory = await promises.open(runtimeDir, "r");
			try {
				await directory.sync();
			} finally {
				await directory.close();
			}
		} catch {}
	} catch (error) {
		if (handle !== null) await handle.close().catch(() => void 0);
		await promises.unlink(tmp).catch(() => void 0);
		throw error;
	}
}
function isPidAlive(pid) {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		const code = error.code;
		if (code === "ESRCH") return false;
		if (code === "EPERM") return true;
		throw error;
	}
}
async function readLock(lockPath) {
	try {
		const parsed = RuntimeLockFile.safeParse(JSON.parse(await promises.readFile(lockPath, "utf8")));
		return parsed.success ? parsed.data : null;
	} catch (error) {
		if (error.code === "ENOENT") return null;
		if (error instanceof SyntaxError) return null;
		throw error;
	}
}
function isSameLockGeneration(observed, current) {
	return observed.pid === current.pid && observed.acquired_at === current.acquired_at && observed.operation === current.operation && observed.owner === current.owner;
}
async function createLock(lockPath, lock) {
	let handle = null;
	try {
		handle = await promises.open(lockPath, "wx", 384);
		await handle.writeFile(JSON.stringify(lock));
		await handle.sync();
		await handle.close();
		handle = null;
		await promises.chmod(lockPath, 384);
	} catch (error) {
		if (handle !== null) await handle.close().catch(() => void 0);
		if (error.code !== "EEXIST") await promises.unlink(lockPath).catch(() => void 0);
		throw error;
	}
}
async function acquireRuntimeLock(identity, operation, options) {
	const runtimeDir = options.runtimeDir;
	await ensureRuntimeDir(runtimeDir);
	const lockPath = sessionRuntimeLockPath(identity.session_id, options);
	const lock = RuntimeLockFile.parse({
		pid: process.pid,
		acquired_at: options.now().toISOString(),
		operation,
		owner: randomBytes(16).toString("hex")
	});
	const timeoutMs = Math.max(0, options.lockTimeoutMs ?? DEFAULT_LOCK_TIMEOUT_MS);
	const retryDelayMs = Math.max(1, options.retryDelayMs ?? DEFAULT_RETRY_DELAY_MS$1);
	const maxAttempts = Math.max(1, Math.ceil(timeoutMs / retryDelayMs) + 1);
	let attempts = 0;
	while (true) {
		try {
			await createLock(lockPath, lock);
			const confirmed = await readLock(lockPath);
			if (confirmed?.owner !== lock.owner) {
				attempts += 1;
				if (attempts >= maxAttempts) throw new RuntimeStoreError(confirmed === null ? "RUNTIME_LOCK_INVALID" : "RUNTIME_LOCK_TIMEOUT", `runtime lock ownership changed before acquisition completed`, confirmed ?? void 0, {
					lock_path: lockPath,
					timeout_seconds: timeoutMs / 1e3
				});
				await new Promise((resolve) => setTimeout(resolve, retryDelayMs));
				continue;
			}
			return async () => {
				if ((await readLock(lockPath))?.owner !== lock.owner) return;
				await promises.unlink(lockPath).catch((error) => {
					if (error.code !== "ENOENT") throw error;
				});
			};
		} catch (error) {
			if (error.code !== "EEXIST") throw error;
		}
		const holder = await readLock(lockPath);
		attempts += 1;
		if (holder !== null && !isPidAlive(holder.pid)) {
			const current = await readLock(lockPath);
			if (current !== null && isSameLockGeneration(holder, current) && !isPidAlive(current.pid)) await promises.unlink(lockPath).catch((error) => {
				if (error.code !== "ENOENT") throw error;
			});
			if (attempts >= maxAttempts) throw new RuntimeStoreError("RUNTIME_LOCK_TIMEOUT", `runtime lock stale recovery exceeded its bounded retry budget`, current ?? holder, {
				lock_path: lockPath,
				timeout_seconds: timeoutMs / 1e3
			});
			continue;
		}
		if (attempts >= maxAttempts) throw new RuntimeStoreError(holder === null ? "RUNTIME_LOCK_INVALID" : "RUNTIME_LOCK_TIMEOUT", holder === null ? `runtime lock ${lockPath} is malformed or incomplete; refusing stale removal` : `runtime lock held by live PID ${holder.pid} during ${holder.operation}`, holder ?? void 0, {
			lock_path: lockPath,
			timeout_seconds: timeoutMs / 1e3
		});
		await new Promise((resolve) => setTimeout(resolve, retryDelayMs));
	}
}
/**
* The only read-modify-write API: acquire → validated read → mutate → atomic
* write → unlock. Identity comes from the already journal-selected session;
* malformed/mismatched files fail closed and are never silently merged or
* replaced. An explicit future quarantine flow must present that identity.
*/
async function withRuntimeLock(identityInput, operation, mutate, options) {
	const identity = await canonicalIdentity(identityInput);
	const release = await acquireRuntimeLock(identity, operation, options);
	try {
		const current = await readSessionRuntimeFileUnlocked(identity, options);
		const canonical = {
			...await validateFileIdentity(SessionRuntimeFile.parse(await mutate(current)), identity),
			cwd: identity.cwd
		};
		await writeSessionRuntimeFileUnlocked(canonical, identity, options);
		return canonical;
	} finally {
		await release();
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
		"SETTLE": { "lessons": "Settle / lessons" },
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
	board: {
		"chrome": {
			"app_title": "loaf board",
			"brand": "loaf board",
			"scope_label": "Scope",
			"all_sessions": "All sessions",
			"current_cwd": "Current cwd",
			"refresh": "Refresh",
			"theme_toggle": "Toggle theme",
			"eyebrow": "Local board",
			"heading": "Loaf Live Board",
			"subtitle": "Reading local journal projections.",
			"active": "Active",
			"blocked": "Blocked",
			"updated": "Updated",
			"waiting": "Waiting",
			"board_label": "Loaf session board",
			"no_sessions": "No sessions.",
			"none": "None.",
			"session": "Session",
			"session_detail": "Session detail",
			"close_session_detail": "Close session detail",
			"loading": "Loading...",
			"session_error": "Session error",
			"iteration_short": "iter"
		},
		"column": {
			"TRIAGE": { "description": "Score and confirm ceremony" },
			"SPEC": { "description": "Proposal, spec, plan, design" },
			"EXECUTE": { "description": "Task work and fan-out" },
			"VERIFY": { "description": "Run, review, acceptance, visual" },
			"SETTLE": { "description": "Lessons" },
			"DONE": { "description": "Delivered or terminal sessions" }
		},
		"status": {
			"pending_decision": "human decision",
			"pending_question": "question"
		},
		"detail": {
			"phase": "Phase",
			"sub_state": "Sub-state",
			"tail_seq": "Tail seq",
			"tasks": "Tasks",
			"evidence": "Evidence",
			"open_findings": "Open findings",
			"pending": "Pending",
			"task_done_suffix": "done",
			"evidence_passing_suffix": "passing",
			"steps_suffix": "steps"
		}
	},
	diagnostic: {
		"INPUT_FILE_NOT_FOUND": "input file does not exist: {path}",
		"MISSING_INPUT": "required input source missing or unreadable: --input not provided OR stdin could not be read (--input - failed)",
		"SPEC_EDIT_INPUT_REQUIRED": "non-interactive `loaf spec edit` requires --input <src>; the editor lane requires TTY stdin and stdout",
		"SCHEMA_VALIDATION_FAILED": "validation failed: {reason}",
		"SPEC_LOCKED_NO_DIRECT_EDIT": "{kind} blocked: spec_locked=true; use `loaf finding raise --category spec-gap --action amend-spec` to back-edge into SPEC.spec",
		"SPEC_NOT_INITIALIZED": "{kind} blocked: spec_version=0; run `loaf spec submit` first to bump spec_version to 1",
		"SPEC_ALREADY_INITIALIZED": "spec.md already exists at {spec_md_path}; refusing to overwrite",
		"CONFIG_ALREADY_INITIALIZED": "loaf config already exists at {config_path}; refusing to overwrite",
		"ATTACHMENT_NOT_FOUND": "attachment path does not exist: {path}",
		"ATTACHMENT_NOT_FILE": "attachment path is not a regular file: {path} ({kind})",
		"FINDING_ACTION_UNUSUAL_REASON_REQUIRED": "finding category={category} × action={action} is 'unusual'; --reason of at least {min_reason_length} characters is required",
		"FINDING_ACTION_INCOHERENT": "finding category={category} × action={action} is incoherent: no target task exists to apply this transition to",
		"FINDING_TARGET_REQUIRED": "finding action={action} target validation failed ({reason})",
		"PRUNE_RESTORE_NOT_FOUND": "no trashed session matches the given id",
		"PRUNE_RESTORE_AMBIGUOUS": "the session id was trashed more than once; pass --at <ts> to pick one",
		"PRUNE_RESTORE_INCOMPLETE": "the trash bucket is incomplete (missing a required artifact); not restoring",
		"PRUNE_PATH_OCCUPIED": "a restore destination already exists; refusing to overwrite",
		"PRUNE_PARTIAL_FAILURE": "prune partially failed: one or more sessions could not be removed",
		"MUTUALLY_EXCLUSIVE_FLAGS": "mutually exclusive flags in the same invocation: {flags}",
		"INVALID_ENV_VALUE": "environment variable {env_name}={value} is not in the accepted enum: {accepted}",
		"INVALID_FORMAT": "invalid --format value '{value}'; allowed: {allowed_values_human}",
		"INVALID_LOCALE": "invalid locale from {source} (expected {accepted})",
		"DRY_RUN_NOT_APPLICABLE": "--dry-run not applicable to {command_type} command `{command}`",
		"HOOK_EVENT_NOT_IMPLEMENTED": "hook event `{event}` is not implemented in this loaf version (Phase 16 SC-15{sub_cycle} pending; see protocol §11)",
		"TASK_STATUS_WITHOUT_PROOF": "task {task_id} status change requires evidence: status={status} has no PASSING covering evidence proof in evidence.jsonl",
		"MISSING_VERIFIABILITY": "REQ {req_id} must declare measurable, verified_by_scenarios[], or acceptance_na+reason",
		"VAGUE_NO_SCENARIO": "requirement {req_id} reads as vague but is not anchored to a measurable threshold or to a verifying scenario",
		"DRIVES_NOT_BOUND": "REQ {req_id} is not referenced by any task.drives[]",
		"MUTATION_OUT_OF_RIGHTS": "event:tasks_amended on task {task_id} is not permitted at sub_state {sub_state} — §8.6 grants no mutation right for this change",
		"LOCK_TIMEOUT": "could not acquire the write lock within {timeout_seconds}s",
		"LOCK_INVALID": "feature write lease at {lock_path} is malformed or incomplete",
		"FEATURE_NOT_FOUND": "no feature found in cwd (.loaf/ is empty or missing, or no projection has phase != DONE)",
		"FEATURE_AMBIGUOUS": "current working directory has {count} active features and no dispatch context: {feature_list}",
		"SESSION_CWD_MISMATCH": "--session {uuid} is registered against cwd={registered_cwd}, but the current cwd is {current_cwd}",
		"SESSION_SHORT_AMBIGUOUS": "--session {prefix} matches {match_count} sessions in the registry: {candidate_list}",
		"SESSION_NOT_FOUND": "--session {uuid_or_prefix} matches no entry in the registry",
		"PENDING_BLOCKS_ADVANCE": "pending head {pending_id} (kind={kind}) blocks `loaf advance` until resolved",
		"GATE_NOT_PENDING": "`loaf gate decide {gate_kind}` requires pending head kind=gate_decision; current head kind: {head_kind}",
		"ESCALATION_NOT_PENDING": "`loaf profile escalate --confirm --input <ceremony.json>` requires pending head kind=profile_escalation; current head: {actual_head}",
		"ACTOR_AUTHORITY_VIOLATION": "actor {actor} is not allowed for journal kind {kind}",
		"FROM_CURSOR_MISMATCH": "entry payload.from={payload_from} does not match current sub_state={current_sub_state}",
		"INVALID_ENVELOPE": "journal entry failed envelope validation: {reason}",
		"INVALID_PAYLOAD": "payload for kind {kind} failed validation: {reason}",
		"SEQ_NOT_MONOTONIC": "entry seq {got} does not extend journal tail {tail_seq}; expected {expected}",
		"SETTLE_PHASE_BYPASS": "VERIFY.accept → DONE.delivered requires ceremony.settle_phase=false (quick / light / standard); deep profile must enter SETTLE.lessons first; current settle_phase={settle_phase}",
		"SETTLE_PHASE_DISABLED": "VERIFY.accept → SETTLE.lessons requires ceremony.settle_phase=true (deep profile only after rev 5.x); current settle_phase={settle_phase}",
		"SPEC_PHASE_FORK_VIOLATION": "transition {from} → {to} violates ceremony.spec_phase={spec_phase}",
		"SUB_STATE_AUTHORITY_VIOLATION": "kind {kind} is not allowed in sub_state {sub_state}",
		"TRANSITION_ILLEGAL": "cannot transition {from} → {to}",
		"VERIFY_PHASE_FORK_VIOLATION": "transition {from} → {to} violates ceremony.verify_phase={verify_phase}",
		"EXECUTE_DONE_TASKS_NOT_FINAL": "cannot advance EXECUTE.work → EXECUTE.done: {count} task(s) are not in a final status (done or abandoned); finish their remaining steps or abandon out-of-scope tasks with `loaf tasks abandon <T-N> --reason \"...\"`",
		"ALREADY_STARTED": "session bootstrap kind {kind} cannot run after state already exists",
		"FINDING_NOT_FOUND": "finding close references unknown finding id {id}",
		"NO_SESSION": "no started session — run `loaf start` first",
		"PENDING_NOT_FOUND": "pending resolve failed: {reason}",
		"REDUCER_NOT_IMPLEMENTED": "reducer has no handler for journal kind {kind}",
		"ENTRY_OVERSIZE": "journal entry serialized to {bytes} bytes; limit is {limit}",
		"SHORT_WRITE": "journal append wrote {wrote} of {want} bytes",
		"TAIL_CORRUPTION": "journal tail is corrupt: {reason}",
		"INVALID_ACTOR_FORMAT": "human actor value is invalid: {reason}",
		"NO_HUMAN_ACTOR": "no human actor could be resolved for a human-only command",
		"DUPLICATE_REQ_ID": "REQ id {id} is already in the spec projection",
		"DUPLICATE_SCEN_ID": "SCEN id {id} is already in the spec projection",
		"DUPLICATE_VIS_ID": "VIS id {id} is already in the spec projection",
		"SPEC_FRONTMATTER_INVALID": "spec frontmatter failed gate check 1 (subcode={subcode})",
		"SPEC_HAS_UNCLARIFIED": "spec has {count} unresolved needs_clarification entries (ids={ids}); resolve or remove them before spec-lock can pass",
		"TASK_NOT_FOUND": "task {task_id} is not in the current tasks projection",
		"TASK_STEP_NOT_FOUND": "step {step} is not seeded on task {task_id} — seeded steps are derived from the task's kind execution schema (§14)",
		"DUPLICATE_TASK_ID": "task id {task_id} appears more than once in tasks_planned payload",
		"TASKS_NOT_PLANNED": "gate task-graph check: tasks have not been planned (snapshot.tasks_based_on is null)",
		"TASKS_BASED_ON_STALE": "gate task-graph check: tasks_based_on.spec={tasks_based_on_spec} but current spec.spec_version={current_spec_version} — the task graph was planned against an older spec",
		"REQ_NOT_DRIVEN": "spec-lock check 4: requirement {req_id} is not referenced by any task.drives[]",
		"E2E_SCENARIO_UNBOUND": "spec-lock check 6: e2e scenario {scenario_id} has no binding task (requires task with requires_acceptance=true AND drives includes {scenario_id})",
		"VISUAL_CONTRACT_UNBOUND": "spec-lock check 7: visual_contract {visual_id} has no visual-ui task whose visual_contract_refs includes it",
		"TASK_KIND_SCHEMA_VIOLATION": "spec-lock check 8: task {task_id} (kind={kind}) violates projected kind-specific obligations: {reasons}",
		"GATE_PRECONDITION_VIOLATION": "gate:decided {gate} approval rejected at the mutate layer: {failure_count} check(s) failed",
		"MULTIPLE_GATE_DECISIONS": "batch contains {count} approved gate:decided entries (gate_kinds={gate_kinds}); protocol §10.8 requires one gate decision per atomic operation",
		"GATE_NOT_IMPLEMENTED": "gate={gate} is not recognized; protocol GateName enum is closed at `spec-lock` or `verify-accept` for v0.1.0",
		"VERIFY_LANE_NOT_PASSED": "verify-accept check 1: applicable VERIFY lane={lane} has no evidence with passing/approved/waived result",
		"OPEN_FINDINGS_PRESENT": "verify-accept check 2: {count} actionable finding(s) still open (ids={open_ids}); resolve or close before verify-accept",
		"COVERAGE_NOT_SATISFIED": "{covered_id} has no evidence that satisfies it (canSatisfy failed for all candidates)",
		"TASK_DONE_NO_EVIDENCE": "verify-accept check 4: task {task_id} is status=done but has no evidence covering it (kind one of `task-summary`, `local-check`, `manual`, or `waiver`)",
		"SPEC_REVIEW_MISSING": "verify-accept check 5: ceremony.strict_spec_review=true requires ≥1 evidence kind=spec-review with result `passed` or `approved` from an actor ≠ implementer; none found",
		"SPEC_REVIEW_IMPLEMENTER_CONFLICT": "verify-accept check 5: every passing spec-review actor is in the implementer set; no independent reviewer signed off (actors={spec_review_actors}, implementers={implementers})",
		"SPEC_REVIEW_IMPLEMENTER_UNKNOWN": "verify-accept check 5: cannot establish implementer set (all done-task evidence actors are cli:* automation); strict_spec_review fails closed",
		"DELIVER_NOT_ACCEPTED": "deliver requires verify_accepted=true at sub_state={sub_state}; run `loaf gate decide verify-accept --approve` first",
		"DELIVER_SETTLE_PHASE_BYPASS": "deliver from VERIFY.accept requires ceremony.settle_phase=false (standard); deep ceremony must run `loaf settle` first",
		"DELIVER_VERIFY_MIN_UNAVAILABLE": "verify-min was unavailable in this build (ceremony_label={ceremony_label}) — superseded at v0.1.1 by DELIVER_VERIFY_MIN_INCOMPLETE; no longer emitted",
		"DELIVER_VERIFY_MIN_INCOMPLETE": "verify-min: {count} done task(s) lack required evidence to deliver (ceremony_label={ceremony_label}); add evidence or waive, then re-deliver",
		"DELIVER_SPIKE_TASKS": "cannot deliver: task {task_id} is kind=spike (status={status}); spike tasks block delivery for the entire session",
		"SETTLE_NOT_ACCEPTED": "VERIFY.accept → SETTLE.lessons requires verify_accepted=true; run `loaf gate decide verify-accept --approve` before `loaf settle`",
		"SPEC_LOCK_NOT_SATISFIED": "SPEC.design → EXECUTE.plan requires spec_locked=true; run `loaf gate decide spec-lock --approve` before `loaf advance EXECUTE.plan`",
		"TASK_NOT_CLAIMABLE": "task {task_id} cannot be claimed (status={status} — terminal state)",
		"TASK_ALREADY_CLAIMED": "task {task_id} is already claimed (status=in_progress)",
		"TASK_DEP_NOT_FOUND": "task {task_id} field {field} references missing task {ref}",
		"TASK_DEP_SELF": "task {task_id} cannot depend on itself",
		"TASK_DEP_DUPLICATE": "task {task_id} repeats dependency {ref} at indexes {indexes}",
		"TASK_DEP_CYCLE": "task dependency graph contains cycle {cycle}",
		"TASK_DEP_ABANDONED": "task {task_id} field {field} references abandoned task {ref}; {hint}",
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
		"BUG_TASK_REQUIRES_RED": "behavioral bug task {task_id} cannot start or complete its implement step before its RED test is registered",
		"BUG_TASK_FLAG_MISUSE": "task {task_id}: red_test_registered=true is valid only on a red-step task_step_done for a behavioral bug task (passed/waived result) — not on this entry",
		"BUG_TASK_RED_NOT_REGISTERED": "behavioral bug task {task_id} is done but never registered its RED test (red_test_registered≠true)",
		"SPIKE_CONVERT_NO_SPIKE_TASK": "cannot convert: the session has no non-abandoned spike task; `loaf spike convert` is a spike-task exit (protocol §8.3)",
		"SNAPSHOT_STALE_REBUILD_REQUIRED": "snapshot stale (reason={reason}); run `loaf doctor --rebuild --feature <feature>` to re-serialize from journal truth",
		"JOURNAL_TAIL_REQUIRES_NEWER_LOAF": "tail recovery refused at seq {seq}: journal kind {kind} uses entry schema {entry_schema_version} ({reason})",
		"INVALID_PRESET": "invalid ceremony preset",
		"USAGE": "invalid CLI usage",
		"DOCTOR_MODE_NOT_IMPLEMENTED": "requested loaf doctor mode is not implemented in this release",
		"DOCTOR_FEATURE_REQUIRED": "loaf doctor --rebuild requires --feature <name>",
		"DOCTOR_REBUILD_FAILED": "doctor --rebuild failed",
		"REDUCER_ERROR": "internal reducer invariant failed",
		"APPEND_ERROR": "journal append failed",
		"SIDECAR_ERROR": "sidecar finalize failed: {err}",
		"INVALID_BATCH": "mutation batch is invalid",
		"SCOPE_RECORDED_BATCH_INVALID": "scope:recorded batch is invalid: {reason}",
		"SCOPE_RECORDED_ITERATION_DUPLICATE": "scope:recorded already exists for iteration {iteration}",
		"ACTUAL_SCOPE_HISTORY_INCOMPLETE": "actual scope history is incomplete: EXECUTE closure transition(s) at seq {transition_seqs} have no same-batch scope:recorded marker",
		"WRITE_PATH_VIOLATION": "write blocked: `{normalized_path}` is outside the allowed write paths for sub_state `{sub_state}`",
		"PROTECTED_FILE_WRITE": "write blocked: `{normalized_path}` matches protected_files entry `{matched_deny}` — protected files are never writable"
	},
	diagnostic_fix: {
		"INPUT_FILE_NOT_FOUND": "verify the path, or pass '-' to read from stdin / inline JSON starting with a JSON object or array — see `loaf <cmd> --help` for examples",
		"MISSING_INPUT": "pass --input with one of: a JSON file path, '-' for stdin (with valid piped JSON), or inline JSON; for stdin failures, pass valid JSON to `loaf <cmd> --input -` on stdin; for the 6 schema-capable authoring commands (spec add-req / spec add-scenario / spec add-visual / tasks submit / tasks add / evidence add), run `loaf <cmd> --schema --format=json` to view the input schema",
		"SPEC_EDIT_INPUT_REQUIRED": "pass --input with a JSON object {\"body\":\"<Markdown>\"} via file, stdin '-', or inline JSON; alternatively rerun from a terminal with both stdin and stdout attached to a TTY",
		"SCHEMA_VALIDATION_FAILED": "inspect the structured validation detail and correct the input or runtime state before retrying; use --schema when supported by the command to inspect its input contract",
		"SPEC_LOCKED_NO_DIRECT_EDIT": "raise a finding with category=spec-gap (or spec-defect) and action=amend-spec to back-edge into SPEC.spec (the finding's resets_spec_locked effect lifts the gate); then retry the spec add/submit",
		"SPEC_NOT_INITIALIZED": "run `loaf spec submit --input <file>` first to bump spec_version to 1, then retry the add-* command (SC4 will add `loaf spec init` as a separate scaffold helper that chains into submit)",
		"SPEC_ALREADY_INITIALIZED": "edit the existing spec.md directly, or remove it before re-running `loaf spec init` (no --force flag in Slice 4)",
		"CONFIG_ALREADY_INITIALIZED": "edit the existing config file directly, or remove it before re-running `loaf config init` (no --force flag)",
		"ATTACHMENT_NOT_FOUND": "verify the path is reachable from the working directory and readable by the current user",
		"ATTACHMENT_NOT_FILE": "attachments must be regular files; directories, symlinks to directories, sockets, and FIFOs are rejected",
		"FINDING_ACTION_UNUSUAL_REASON_REQUIRED": "rerun with --reason explaining why this non-typical combination applies (see references/finding-matrix-rationale.md)",
		"FINDING_ACTION_INCOHERENT": "amend the spec first (category=spec-gap / new-scope × action=amend-spec) so a target task can be planned, then raise the fix-impl / fix-test finding against that task",
		"FINDING_TARGET_REQUIRED": "fix-impl/fix-test require --target-task + --target-step matching the action's canonical step (fix-impl=implement, fix-test=red); amend-tasks accepts an optional but valid target; amend-spec / defer / backlog must not carry a target",
		"PRUNE_RESTORE_NOT_FOUND": "run `loaf prune --history` to list trashed sessions (slice 6b)",
		"PRUNE_RESTORE_AMBIGUOUS": "re-run `loaf prune restore <id> --at <ts>` with one of the listed timestamps",
		"PRUNE_RESTORE_INCOMPLETE": "inspect the trash bucket; a complete bucket has manifest.json + registry.json",
		"PRUNE_PATH_OCCUPIED": "move or remove the occupying registry entry / feature dir, then retry restore",
		"PRUNE_PARTIAL_FAILURE": "inspect detail.failed; rerun prune for the failed sessions after resolving the error",
		"MUTUALLY_EXCLUSIVE_FLAGS": "pass at most one of the flags from each exclusion set; see `loaf <cmd> --help` for the canonical flag list",
		"INVALID_ENV_VALUE": "unset {env_name} or set it to one of: {accepted}",
		"INVALID_FORMAT": "pass --format text or --format json (the only allowed values for this release); --format=<value> equals form is accepted",
		"INVALID_LOCALE": "unset the locale override or set it to one of: {accepted}; user preferences live in ~/.loaf/config.json locale.default_lang",
		"DRY_RUN_NOT_APPLICABLE": "--dry-run only applies to mutating commands; re-run without --dry-run (or -n) to invoke the {command_type} command",
		"HOOK_EVENT_NOT_IMPLEMENTED": "upgrade to a loaf release that implements this hook event, OR skip this hook surface for now — `loaf hook --list-events` shows the canonical 4-event enum",
		"TASK_STATUS_WITHOUT_PROOF": "emit `loaf evidence add` covering task_id={task_id} before advancing status (task-evidence is otherwise enforced later at verify-min / verify-accept)",
		"MISSING_VERIFIABILITY": "add one of: measurable with metric, threshold, and optional unit/direction; verified_by_scenarios: [SCEN-...]; or acceptance_na: true with acceptance_na_reason of at least 10 characters",
		"VAGUE_NO_SCENARIO": "either add measurable with a numeric threshold and direction, or add the verifying SCEN-id to verified_by_scenarios",
		"DRIVES_NOT_BOUND": "add a task whose drives[] contains {req_id} (loaf tasks add --input ...), or remove the REQ if it is intentionally out-of-scope for this feature",
		"MUTATION_OUT_OF_RIGHTS": "the mutation rights matrix (protocol.md §8.6) limits EXECUTE.plan `tasks amend` to execution[].applicability changes plus a status pending→ready advance; graph/kind-flag fields are frozen. To restructure the task graph, raise a `finding raise --action amend-tasks` back-edge, then run the sponsored `tasks add --finding` / `tasks amend --input --finding` at EXECUTE.work — a sponsored amend may change graph/definition fields but never erases execution progress (task/step status is frozen)",
		"LOCK_TIMEOUT": "another loaf process is holding the feature lease; wait for it to release. A later writer automatically reclaims a lease only when its PID is verifiably dead and the owner generation is unchanged; malformed leases fail closed and require inspection.",
		"LOCK_INVALID": "inspect the lease and active loaf processes; malformed leases fail closed and no loaf command deletes them. Remove or replace the file only after independently proving that no writer owns it.",
		"FEATURE_NOT_FOUND": "run `loaf start <description>` to create a new feature, or cd into a directory that already has a .loaf/<feature>/ subtree",
		"FEATURE_AMBIGUOUS": "disambiguate with --feature <name>, --session <UUID>, or set $LOAF_FEATURE / $LOAF_SESSION in the environment",
		"SESSION_CWD_MISMATCH": "cd to the registered cwd before issuing the command, or pass a different --session, or drop --session to auto-pick a session in the current cwd",
		"SESSION_SHORT_AMBIGUOUS": "pass a longer UUID prefix (≥8 chars are required; use more to disambiguate) or pass the full UUID",
		"SESSION_NOT_FOUND": "run `loaf sessions list --in-cwd` to see registered sessions (future SC-9b), or run `loaf start <name>` to create one",
		"PENDING_BLOCKS_ADVANCE": "resolve the head with the kind-appropriate command: `loaf gate decide <G>` for kind=gate_decision; `loaf profile escalate --confirm --input <ceremony.json>` for kind=profile_escalation; `loaf pending resolve --answer <a>` for the rest",
		"GATE_NOT_PENDING": "resolve the current head first via the kind-appropriate command, or wait for the gate_decision pending to appear",
		"ESCALATION_NOT_PENDING": "resolve the current head first via the kind-appropriate command, or wait for the profile_escalation pending to appear",
		"ACTOR_AUTHORITY_VIOLATION": "use the command surface that owns this kind; human-only kinds require an interactive human actor resolved by LOAF_USER or git user.email",
		"FROM_CURSOR_MISMATCH": "refresh the current session state and emit the transition from the actual cursor; do not replay a stale transition candidate",
		"INVALID_ENVELOPE": "rebuild the entry through the CLI mutator so seq, entry_id, actor, kind, payload, and batch markers satisfy JournalEntry",
		"INVALID_PAYLOAD": "fix the payload to match the PER_KIND_PAYLOAD schema for this kind and retry the mutator",
		"SEQ_NOT_MONOTONIC": "refresh tail_seq under the session lock and retry; if the tail is corrupt run `loaf doctor --check-tail`",
		"SETTLE_PHASE_BYPASS": "for deep profile, advance from VERIFY.accept to SETTLE.lessons via `loaf settle`; if SETTLE is not desired, start/continue a standard ceremony flow instead",
		"SETTLE_PHASE_DISABLED": "for non-deep profiles (quick / light / standard), advance from VERIFY.accept to DONE.delivered via `loaf deliver`; to enter SETTLE, escalate ceremony to deep",
		"SPEC_PHASE_FORK_VIOLATION": "follow the ceremony fork: spec_phase=true traverses SPEC.*, spec_phase=false goes directly to EXECUTE.plan",
		"SUB_STATE_AUTHORITY_VIOLATION": "advance/back-edge to a sub_state that permits this journal kind, or use the command valid for the current state",
		"TRANSITION_ILLEGAL": "choose one of the allowed forward transitions for the current sub_state, or use an explicit terminal/archive path when supported",
		"VERIFY_PHASE_FORK_VIOLATION": "follow the ceremony fork: verify_phase=true enters VERIFY.plan, verify_phase=false can deliver after minimal verification",
		"EXECUTE_DONE_TASKS_NOT_FINAL": "finish the remaining steps — run each task's steps via `loaf tasks step` until it auto-promotes to status=done — OR abandon out-of-scope tasks with `loaf tasks abandon <T-N> --reason \"...\"`, then retry `loaf advance EXECUTE.done`; see detail.non_final for the tasks still pending or in progress",
		"ALREADY_STARTED": "resume the existing session or create a new feature directory instead of starting over initialized state",
		"FINDING_NOT_FOUND": "list open findings and close an existing id, or raise the finding before closing it",
		"NO_SESSION": "run `loaf start` before emitting non-bootstrap journal entries",
		"PENDING_NOT_FOUND": "resolve the current pending head only; list pending items and retry with the head id",
		"REDUCER_NOT_IMPLEMENTED": "implement the journal kind in the exhaustive reducer switch before appending it",
		"ENTRY_OVERSIZE": "move long text into sidecar form via LongTextField instead of embedding it inline",
		"SHORT_WRITE": "stop writing, preserve the journal, and run `loaf doctor --check-tail` before retrying",
		"TAIL_CORRUPTION": "run `loaf doctor --check-tail`; do not append until the tail has been repaired or quarantined",
		"INVALID_ACTOR_FORMAT": "set LOAF_USER to the raw human identifier without a namespace prefix, or unset it to allow interactive git user.email fallback",
		"NO_HUMAN_ACTOR": "run interactively with git user.email configured, or set LOAF_USER explicitly",
		"DUPLICATE_REQ_ID": "allocate a fresh REQ id under the same id_namespace (the CLI scans for max serial + 1 inside the per-session lock) or `loaf finding raise --category spec-gap --action amend-spec` if you need to retire the existing REQ",
		"DUPLICATE_SCEN_ID": "allocate a fresh SCEN id under the same id_namespace, or amend via finding mechanism if retiring an existing scenario",
		"DUPLICATE_VIS_ID": "allocate a fresh VIS id under the same id_namespace, or amend via finding mechanism if retiring an existing visual contract",
		"SPEC_FRONTMATTER_INVALID": "subcode=SPEC_NOT_FOUND: run `loaf spec init` then `loaf spec submit` to seed spec.md; subcode=SPEC_YAML_INVALID: check the `---`-fenced YAML block at the top of spec.md for syntax errors; subcode=SPEC_FRONTMATTER_INVALID: run `loaf spec schema --format=json` to dump the SpecFrontmatter JSON Schema (Phase 16 SC-10) and fix the offending field. Snapshot-sourced failures require a valid canonical spec submission; initializing or editing a derived file cannot satisfy either gate.",
		"SPEC_HAS_UNCLARIFIED": "edit spec.md to remove resolved needs_clarification entries, or run `loaf finding raise --category spec-gap --action clarify` to formalize the resolution flow; spec-lock check 2 requires needs_clarification === []",
		"TASK_NOT_FOUND": "run `loaf tasks list` to see live ids; if you meant to add a new task, use `loaf tasks add` instead of amend/step; if you expected the id to exist, the projection may be stale — run `loaf doctor --rebuild` to rebuild from journal",
		"TASK_STEP_NOT_FOUND": "use only the per-kind step names — behavioral: red/implement/refactor; structural: implement/refactor; visual-ui: mockup/implement/screenshot-compare; docs: draft/review; spike: explore/prototype/record; chore: execute. Running an unseeded step name was a silent add bug in v0.0.x — sub-cycle 3a fails fast instead",
		"DUPLICATE_TASK_ID": "tasks_planned is whole-replacement — each task id must be unique within the batch. Rename one or merge them in the planning input",
		"TASKS_NOT_PLANNED": "run `loaf tasks submit --input <plan-file>` to emit event:tasks_planned and seed the task graph; spec-lock check 3 and verify-accept check 4 both require tasks_based_on.spec to match the current spec.spec_version",
		"TASKS_BASED_ON_STALE": "either re-plan tasks against the current spec via `loaf tasks submit` (whole-replacement), or amend individual tasks via `loaf tasks add/amend` + raise a `loaf finding raise --category spec-gap --action amend-spec` if a spec roll-back is needed. Surfaces for spec-lock (check 3) and verify-accept (check 4 precondition).",
		"REQ_NOT_DRIVEN": "add a task whose drives[] array includes {req_id}, or remove the requirement from spec.md if it is no longer in scope. Note: this is the REQ-side coverage code (distinct from legacy DRIVES_NOT_BOUND which named the inverse direction)",
		"E2E_SCENARIO_UNBOUND": "either (a) add a task with requires_acceptance=true and drives including {scenario_id}, or (b) mark the scenario with acceptance_na=<reason ≥5 chars> in spec.md if e2e acceptance is intentionally skipped for this iteration",
		"VISUAL_CONTRACT_UNBOUND": "either (a) add a visual-ui task with visual_contract_refs including {visual_id}, or (b) mark the visual_contract with visual_na=<reason ≥5 chars> in spec.md if visual verification is intentionally deferred",
		"TASK_KIND_SCHEMA_VIOLATION": "amend the task to satisfy its kind contract: structural/docs/spike/chore require no_test_rationale (string ≥10 chars); visual-ui requires visual_contract_refs[] with ≥1 entry. Slice C R2: bug-task RED is execution discipline, not a spec-lock obligation — a behavioral task with labels=['bug'] is born unregistered, and RED registration is enforced at runtime by BUG_TASK_REQUIRES_RED (preflight, implement step) and BUG_TASK_RED_NOT_REGISTERED (verify-accept), never by this check",
		"GATE_PRECONDITION_VIOLATION": "this is a mutate-layer envelope around the underlying gate checks (see detail.checks for the list). spec-lock failure codes: MISSING_VERIFIABILITY / REQ_NOT_DRIVEN / E2E_SCENARIO_UNBOUND / VISUAL_CONTRACT_UNBOUND / TASKS_NOT_PLANNED / TASKS_BASED_ON_STALE / TASK_KIND_SCHEMA_VIOLATION / SPEC_HAS_UNCLARIFIED. verify-accept failure codes: VERIFY_LANE_NOT_PASSED / OPEN_FINDINGS_PRESENT / COVERAGE_NOT_SATISFIED / TASK_DONE_NO_EVIDENCE / SPEC_REVIEW_MISSING / SPEC_REVIEW_IMPLEMENTER_CONFLICT / SPEC_REVIEW_IMPLEMENTER_UNKNOWN / TASKS_NOT_PLANNED (precondition) / TASKS_BASED_ON_STALE (precondition). Fix each listed check then retry the gate decision. Pass 1.5 runs after preflight + reducer dry-run + before sidecar promotion, so a rejected gate batch leaves no on-disk residue.",
		"MULTIPLE_GATE_DECISIONS": "split the batch — emit each gate decision as its own mutation. A batch carrying ≥2 gate approvals (even with different gate_kinds, e.g. spec-lock + verify-accept) is not a valid atomic operation. Rejected gate decisions are not counted; only approvals trigger this rule",
		"GATE_NOT_IMPLEMENTED": "use `loaf gate decide spec-lock` or `loaf gate decide verify-accept`. Future gates beyond v0.1.0 would extend the GateName enum in journal-entry.ts + evidence-schema.ts (lockstep) and wire here.",
		"VERIFY_LANE_NOT_PASSED": "add an evidence:added entry with check={lane} (or a matching kind via the narrow fallback map: local-check/task-summary→run, verify-review/spec-review→review, acceptance→acceptance, visual-review→visual) and result one of `passed`, `approved`, or `waived`. Applicable lanes derive from spec: REQ ⇒ REVIEW, SCEN.tag=e2e ⇒ ACCEPTANCE, VIS ⇒ VISUAL, done task ⇒ RUN+REVIEW.",
		"OPEN_FINDINGS_PRESENT": "complete the declared action for each listed finding, then run `loaf finding close <FND-id>`; if the honest disposition is carry-forward, raise it with action=defer or action=backlog instead. verify-accept excludes only open findings whose existing action declares deferral",
		"COVERAGE_NOT_SATISFIED": "add evidence:added covering {covered_id} per protocol §5.4: REQ allows task-summary/verify-review/spec-review/manual+reason/waiver+reason; SCEN.tag=e2e allows acceptance/manual+reason/waiver+reason; VIS allows visual-review+attachment/manual+reason/waiver+reason. Result must be passed/approved/waived per §1035.",
		"TASK_DONE_NO_EVIDENCE": "add evidence:added with covers including {task_id} and kind in the T-allowed set. Most commonly: a task-summary written on closing the task; alternatively local-check (test/lint/typecheck run), manual (human attest), or waiver (human waiver with reason ≥10 chars).",
		"SPEC_REVIEW_MISSING": "have an independent reviewer (not the implementer of done tasks; not a cli:* automation actor) run a spec review and add an evidence:added with kind=spec-review and result `passed` or `approved`. Note: result=waived does NOT count for spec-review (kind=spec-review + result=waived bypasses the human+reason refine guarantee that kind=manual or kind=waiver provides).",
		"SPEC_REVIEW_IMPLEMENTER_CONFLICT": "have a non-implementer (someone other than the actors on done-task task-summary/local-check evidence) submit an additional evidence with kind=spec-review and result `passed` or `approved`. One independent reviewer is sufficient — implementer self-reviews can coexist.",
		"SPEC_REVIEW_IMPLEMENTER_UNKNOWN": "ensure at least one done-task evidence (task-summary or local-check) carries a non-cli:* actor (e.g. human:dev@example.com); the strict_spec_review comparison requires a real implementer identity to compare against. Without it, the gate cannot prove the spec reviewer is independent.",
		"DELIVER_NOT_ACCEPTED": "run `loaf gate decide verify-accept --approve --reason \"...\"` first; the gate flips snapshot.state.verify_accepted before `loaf deliver` will accept the session:delivered entry",
		"DELIVER_SETTLE_PHASE_BYPASS": "for ceremony.settle_phase=true (deep), run `loaf settle` to enter SETTLE.lessons, record lessons, then `loaf deliver`; only standard ceremony delivers directly from VERIFY.accept",
		"DELIVER_VERIFY_MIN_UNAVAILABLE": "upgrade to v0.1.1+ where quick / light deliver runs the verify-min per-task evidence check; on failure see DELIVER_VERIFY_MIN_INCOMPLETE",
		"DELIVER_VERIFY_MIN_INCOMPLETE": "for each listed task add evidence covering it — code tasks need a `local-check` (test/lint/typecheck) run, visual-ui needs visual-review or manual, docs needs task-summary or manual — or `loaf waive` it; then `loaf deliver` again",
		"DELIVER_SPIKE_TASKS": "abandon the spike task (`loaf tasks abandon {task_id} --reason \"...\"`) or convert it to a feature (`loaf spike convert --to-feature F-N --reason \"...\"`); spike tasks must not remain in non-abandoned status when the session delivers",
		"SETTLE_NOT_ACCEPTED": "run `loaf gate decide verify-accept --approve --reason \"...\"` before `loaf settle`; the gate flips snapshot.state.verify_accepted before the transition validator will admit the SETTLE entry",
		"SPEC_LOCK_NOT_SATISFIED": "run `loaf gate decide spec-lock --approve --reason \"...\"` before `loaf advance EXECUTE.plan`; the gate runs the 8 spec-lock checks and flips snapshot.state.spec_locked before the transition validator will admit the EXECUTE.plan entry",
		"TASK_NOT_CLAIMABLE": "tasks with status=done are already complete; status=abandoned tasks cannot be reactivated. Run `loaf tasks list` to inspect the task graph, or `loaf tasks next` to pick a different ready task",
		"TASK_ALREADY_CLAIMED": "another worker may already hold this task; run `loaf tasks list` to inspect active claims. Stale-claim release is handled in a future slice (no CLI surface for abandon in v0.1.0 yet) — raise a finding with action=fix-impl if needed",
		"TASK_DEP_NOT_FOUND": "add the referenced task in the same atomic batch, or amend the dependency to an existing task, then retry",
		"TASK_DEP_SELF": "remove the self-reference from depends_on, then retry the task graph mutation",
		"TASK_DEP_DUPLICATE": "keep each dependency id only once in depends_on, then retry",
		"TASK_DEP_CYCLE": "remove or redirect one dependency in the reported closed path, then retry",
		"TASK_DEP_ABANDONED": "use an amend-tasks-sponsored task amendment to replace the abandoned dependency, then retry",
		"TASK_DEPS_NOT_SATISFIED": "complete deps_on tasks first (run `loaf tasks list --status pending` to see what is blocking), or use `loaf tasks next` to pick a task with all deps satisfied",
		"TASK_NOT_CLAIMED": "run `loaf tasks claim {task_id}` to move the task from pending/ready to in_progress before emitting task_step_started or task_step_done; once auto-promoted to done, steps cannot be re-mutated",
		"TASK_NOT_ABANDONABLE": "tasks with status=done are already complete and status=abandoned tasks are already abandoned; run `loaf tasks list` to inspect the task graph and abandon a non-terminal task instead",
		"TASK_ABANDON_BLOCKED_DEPENDENTS": "abandon or complete the dependent tasks first (see detail.blocking_dependents), then retry `loaf tasks abandon {task_id} --reason \"...\"`; abandoning a parent would strand a pending child",
		"SESSION_REASON_REQUIRED": "re-run with `--reason \"...\"`; `loaf archive` and `loaf abandon` both require a rationale on the journal entry",
		"PROJECTION_WRITE_FAILED": "the journal already records the change; do NOT retry the same command. Run `loaf doctor --rebuild` (when available) to resync derived projections from journal truth, or inspect `.loaf/<feature>/journal.jsonl` tail manually.",
		"FINDING_AMEND_SPEC_NOT_LOCKED": "drop --action amend-spec and use `loaf spec submit` / `loaf spec add-req` / etc. directly while spec is unlocked; amend-spec is reserved for post-`gate decide spec-lock --approve` recovery.",
		"SPEC_VERSION_NOT_MONOTONIC": "set spec_version to {expected_spec_version} in the input payload (or omit it and let `loaf spec submit` fill the current+1 default).",
		"SPEC_VERSION_BATCH_MISMATCH": "in a multi-entry spec batch, the head (batch_index=0) bumps spec_version to current+1 and all continuation entries (batch_index≥1) must set spec_version to that same value. Check the head entry's payload.spec_version and align companions.",
		"TASK_COMPLETE_PRECONDITION_VIOLATED": "finish each blocking step via `loaf tasks step start/done`; a task auto-promotes to status=done once every must-applicable step is passed/waived/na, and `loaf tasks complete` then confirms it. Run `loaf tasks list` to inspect step status.",
		"BUG_TASK_REQUIRES_RED": "run `loaf tasks register-red {task_id}` once the failing RED test is in place; protocol §9.3 requires RED registration before the implement step of a behavioral task labelled `bug`.",
		"BUG_TASK_FLAG_MISUSE": "do not set red_test_registered in a planned task or on a non-red step; the flag is owned by `loaf tasks register-red`, which the reducer promotes to task-level registration.",
		"BUG_TASK_RED_NOT_REGISTERED": "a done behavioral bug task must have registered its RED test via `loaf tasks register-red`; this is a verify-accept defense-in-depth check for raw-API journals — rebuild the journal or register RED retroactively before re-running the gate.",
		"SPIKE_CONVERT_NO_SPIKE_TASK": "run `loaf spike convert` only from a session that holds a kind=spike task; for a non-spike session close it with `loaf archive --reason \"...\"` or `loaf abandon --reason \"...\"`",
		"SNAPSHOT_STALE_REBUILD_REQUIRED": "snapshot meta/leaves no longer agree with the journal tail; run `loaf doctor --rebuild --feature <feature>` to re-serialize from journal truth, then retry. Inspect detail.reason + reason-specific fields (meta_path / projection_kind / cause) to triage corruption source before rebuilding.",
		"JOURNAL_TAIL_REQUIRES_NEWER_LOAF": "preserve journal.jsonl byte-for-byte and upgrade loaf to a version that understands this entry before running tail recovery again",
		"INVALID_PRESET": "Use one of quick, light, standard, or deep.",
		"USAGE": "Run the command with --help and retry with the required flags/arguments.",
		"DOCTOR_MODE_NOT_IMPLEMENTED": "Use loaf doctor --rebuild --feature <name>; other doctor modes are deferred.",
		"DOCTOR_FEATURE_REQUIRED": "Pass --feature <name> or --feature-dir <path> for the session to rebuild.",
		"DOCTOR_REBUILD_FAILED": "Inspect the emitted error message; fix the journal/projection issue, then rerun doctor --rebuild.",
		"REDUCER_ERROR": "Preserve the journal and command stderr; this indicates a loaf-cli bug or inconsistent projection state.",
		"APPEND_ERROR": "preserve journal.jsonl and the emitted detail, then inspect the append error before retrying; if a write may have started, run `loaf doctor` to verify journal integrity",
		"SIDECAR_ERROR": "inspect the emitted error and attachment path permissions; validation already passed, so remove any orphan sidecar residue before retrying",
		"INVALID_BATCH": "rebuild the batch through the CLI mutator without caller-owned envelope fields and with entries + meta matching the current journal tail",
		"SCOPE_RECORDED_BATCH_INVALID": "emit at most one scope:recorded immediately before exactly one EXECUTE.work to EXECUTE.done transition in the same batch",
		"SCOPE_RECORDED_ITERATION_DUPLICATE": "reuse the recorded closure result for this iteration or advance through a finding back-edge before recording a new closure",
		"ACTUAL_SCOPE_HISTORY_INCOMPLETE": "do not fabricate an empty actual_scope; preserve the journal and rerun the feature's EXECUTE work with an F-027-capable loaf version before auditing scope. Pre-F-027 closure scope cannot be reconstructed from journal history.",
		"WRITE_PATH_VIOLATION": "write within the current step's contract, advance to the right sub_state/step first, or widen the matching `paths.*` category in .loaf/.config/loaf.config.json",
		"PROTECTED_FILE_WRITE": "remove the entry from protected_files in .loaf/.config/loaf.config.json if the protection is wrong, otherwise write a different file"
	},
	diagnostic_variant: { "failure": {
		"check": {
			"path_missing": "file not found: {path}",
			"selector_conflict": "check does not accept {conflicting} — it validates a file by path, independent of any feature session",
			"kind_required": "`{subject}` is not a file path. To validate a {kind} artifact, pass its path: `{suggestion}` (noun-first `loaf {kind} check` is reserved for a future release)",
			"kind_invalid": "--kind '{value}' is not recognized; expected one of {allowed_kinds_human}"
		},
		"profile": {
			"input_file_missing": "input file does not exist: {path}",
			"input_file_unreadable": "cannot read input file {path}: {error}"
		},
		"lessons": {
			"file_missing": "lesson file not found: {path}",
			"text_too_short": "lesson text must be ≥{min_length} chars (got {lesson_text_length})",
			"reason_too_short": "--reason must be ≥{min_length} chars (got {reason_length})",
			"text_file_mutex": "exactly one of --text or --file required ({provided_state})"
		},
		"hook": {
			"stdin_parse_failed": "{reason}",
			"missing_event": "loaf hook requires an event token; one of: {events}. Run `loaf hook --list-events` for the full enum",
			"unknown_event": "unknown hook event '{event}'; expected one of: {allowed}. Did you mean '{suggestion}'?",
			"write_path_missing": "write-side hook requires --path <P> or a non-TTY stdin hook payload (tool_input.file_path)"
		},
		"schema": {
			"validation": "{kind} at {path} failed schema validation ({error_count} {error_word})",
			"selector_conflict": "{subject} does not accept {conflicting} — schema dumps are feature-agnostic"
		},
		"handoff": {
			"pack_validation_failed": "ResumePack failed runtime validation (builder bug or schema drift)",
			"reason_too_short": "--reason must be ≥{min_length} chars (got {reason_length})"
		},
		"tasks_add": { "empty_array": "tasks add input is an empty array" },
		"write_guard": { "config_invalid": "write-guard blocked: {reason}" },
		"no_session": {
			"status": "run `loaf start {feature}` first",
			"advance": "run `loaf start {feature}` first",
			"tasks": "run `loaf start {feature}` first",
			"pending": "run `loaf start {feature}` first",
			"finding": "run `loaf start {feature}` first",
			"verify": "run `loaf start {feature}` first",
			"generic": "run `loaf start {feature}` first"
		},
		"sessions_list": { "selector_conflict": "sessions list does not accept {conflicting} — it lists across all sessions; use --in-cwd to filter" },
		"tui": {
			"selector_conflict": "tui does not accept {conflicting} — it lists across all sessions; selectors are nonsensical for an interactive UI",
			"interactive_only": "tui is interactive-only; use `loaf sessions list --format json` for scriptable session output"
		},
		"dispatch": {
			"session_feature_dir_conflict": "{conflicting} cannot be combined with --feature-dir (session identity comes from registry; manual featureDir is contradictory)",
			"feature_dir_requires_feature": "--feature-dir requires --feature <name> or $LOAF_FEATURE to name the feature"
		},
		"start": {
			"label_too_short": "--label must be at least {min_length} characters",
			"workspace_empty": "--workspace must not be empty"
		},
		"finding": { "status_invalid": "--status must be one of: {allowed_statuses_human} (got {value})" },
		"journal": {
			"integer_invalid": "{flag} must be an integer >= {minimum} (got {value})",
			"kind_invalid": "--kind must be a registered journal kind (got {value})",
			"actor_invalid": "--actor must be a non-empty actor prefix or full actor string"
		},
		"evidence": {
			"covers_invalid": "--covers must be a valid coverage id (got {value})",
			"task_invalid": "--task must be a valid task id (got {value})",
			"kind_invalid": "--kind must be one of: {allowed_kinds_human}"
		}
	} },
	diagnostic_variant_fix: { "failure": {
		"check": {
			"path_missing": "verify the path, or pass '-' to read from stdin / inline JSON starting with a JSON object or array — see `loaf <cmd> --help` for examples",
			"selector_conflict": "Run the command with --help and retry with the required flags/arguments.",
			"kind_required": "Run the command with --help and retry with the required flags/arguments.",
			"kind_invalid": "Run the command with --help and retry with the required flags/arguments."
		},
		"profile": {
			"input_file_missing": "verify the path, or pass '-' to read from stdin / inline JSON starting with a JSON object or array — see `loaf <cmd> --help` for examples",
			"input_file_unreadable": "verify the path, or pass '-' to read from stdin / inline JSON starting with a JSON object or array — see `loaf <cmd> --help` for examples"
		},
		"lessons": {
			"file_missing": "verify the path, or pass '-' to read from stdin / inline JSON starting with a JSON object or array — see `loaf <cmd> --help` for examples",
			"text_too_short": "Run the command with --help and retry with the required flags/arguments.",
			"reason_too_short": "Run the command with --help and retry with the required flags/arguments.",
			"text_file_mutex": "Run the command with --help and retry with the required flags/arguments."
		},
		"hook": {
			"stdin_parse_failed": "pass --path <P> or a non-TTY hook payload containing tool_input.file_path, then retry the hook",
			"missing_event": "Run the command with --help and retry with the required flags/arguments.",
			"unknown_event": "Run the command with --help and retry with the required flags/arguments.",
			"write_path_missing": "Run the command with --help and retry with the required flags/arguments."
		},
		"schema": {
			"validation": "fix the reported fields in {path}, then rerun `loaf check {path} --kind {kind}`",
			"selector_conflict": "Run the command with --help and retry with the required flags/arguments."
		},
		"handoff": {
			"pack_validation_failed": "preserve the session journal and report the failed ResumePack runtime validation; retry with a corrected loaf version",
			"reason_too_short": "Run the command with --help and retry with the required flags/arguments."
		},
		"tasks_add": { "empty_array": "provide at least one task object; run `loaf tasks add --schema --format=json` to inspect the authoring input" },
		"write_guard": { "config_invalid": "repair .loaf/.config/loaf.config.json, then retry the write-side hook" },
		"no_session": {
			"status": "run `loaf start` before emitting non-bootstrap journal entries",
			"advance": "run `loaf start` before emitting non-bootstrap journal entries",
			"tasks": "run `loaf start` before emitting non-bootstrap journal entries",
			"pending": "run `loaf start` before emitting non-bootstrap journal entries",
			"finding": "run `loaf start` before emitting non-bootstrap journal entries",
			"verify": "run `loaf start` before emitting non-bootstrap journal entries",
			"generic": "run `loaf start` before emitting non-bootstrap journal entries"
		},
		"sessions_list": { "selector_conflict": "Run the command with --help and retry with the required flags/arguments." },
		"tui": {
			"selector_conflict": "Run the command with --help and retry with the required flags/arguments.",
			"interactive_only": "Run the command with --help and retry with the required flags/arguments."
		},
		"dispatch": {
			"session_feature_dir_conflict": "Run the command with --help and retry with the required flags/arguments.",
			"feature_dir_requires_feature": "Run the command with --help and retry with the required flags/arguments."
		},
		"start": {
			"label_too_short": "Run the command with --help and retry with the required flags/arguments.",
			"workspace_empty": "Run the command with --help and retry with the required flags/arguments."
		},
		"finding": { "status_invalid": "Run the command with --help and retry with the required flags/arguments." },
		"journal": {
			"integer_invalid": "Run the command with --help and retry with the required flags/arguments.",
			"kind_invalid": "Run the command with --help and retry with the required flags/arguments.",
			"actor_invalid": "Run the command with --help and retry with the required flags/arguments."
		},
		"evidence": {
			"covers_invalid": "Run the command with --help and retry with the required flags/arguments.",
			"task_invalid": "Run the command with --help and retry with the required flags/arguments.",
			"kind_invalid": "Run the command with --help and retry with the required flags/arguments."
		}
	} },
	success: {
		"next": {
			"full_command_pointer": "run `{command}` for the full command",
			"deliver": "loaf deliver",
			"settle": "loaf settle",
			"settle_lessons": "loaf lessons add --text \"<lesson>\" --reason \"<why it matters>\""
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
			"state_change": "settle: {from} → SETTLE.lessons"
		},
		"resume": { "state_change": "resume: session {session_id} (sub_state={sub_state} unchanged)" },
		"handoff": { "state_change": "handoff: resume-pack.json written by {actor}" },
		"pending": {
			"raise_state_change": "pending raise: {pending_id} (kind={kind})",
			"resolve_text": "resolved {pending_id} (kind={kind})",
			"resolve_state_change": "pending resolve: {pending_id} cleared"
		},
		"waive": { "state_change": "waive: {evidence_id} obligation={obligation_id}" },
		"lessons": { "add_state_change": "lessons add: {lesson_id} recorded (kind=lesson:recorded; lessons.md updated)" },
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
			"init_next": "edit, then `loaf spec edit --input <json>`",
			"edit_text": "spec edit: spec_version={spec_version}",
			"edit_state_change": "spec edit: spec_version={spec_version} via $EDITOR",
			"edit_input_state_change": "spec edit: spec_version={spec_version} via --input",
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
		"journal": {
			"list_row": "seq={seq} entry_id={entry_id} at={at} actor={actor} kind={kind}",
			"list_row_batch": "seq={seq} entry_id={entry_id} at={at} actor={actor} kind={kind} batch_id={batch_id} batch_index={batch_index} batch_count={batch_count}",
			"list_empty": "No journal entries."
		},
		"evidence": {
			"list_row": "id={id} kind={kind} covers={covers} task={task_id} at={at} actor={actor}",
			"list_empty": "No evidence entries.",
			"compatibility_warning": "evidence kind {kind} cannot satisfy {covered_id}; use one of: {allowed_kinds} (entry written)"
		},
		"spec_status": {
			"pass": "spec-lock: PASS",
			"failure_row": "check {check}: FAIL {code} — {message}",
			"suppressed_row": "check {check}: SUPPRESSED (blocked by check {blocked_by})"
		},
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
			"check_deferred_findings": "deferred_findings",
			"info": "info",
			"deferred_summary": " {findings} (non-blocking)",
			"failure_summary_one": " {code}",
			"failure_summary_many": " {count} failures ({code}, …)",
			"diagnostic_only": "(diagnostic only — gate verdict not implied)",
			"lane_label": "lane.{lane}",
			"lane_reason": " — {reason}",
			"lane_reason_no_done_tasks": "no done tasks require run verification",
			"lane_reason_no_review_obligations": "no non-NA requirements or done tasks require review verification",
			"lane_reason_no_e2e_scenarios": "no applicable e2e scenarios require acceptance verification",
			"lane_reason_no_visual_contracts": "no applicable visual contracts require visual verification"
		},
		"tui": {
			"list": {
				"title": "loaf sessions ({active_count} active / {total_count} total)",
				"sort": "sort: {sort}",
				"sort_time": "time",
				"sort_status": "status",
				"reloading": "reloading…",
				"empty": "(no sessions found)",
				"help": "[↑/↓] move · [Enter] detail · [space] fold · [a] active/all · [s] sort · [r] reload · [q] quit",
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
		"resume": "Resume session from a handoff pack",
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
		"verify_status": "Compute current verify check applicability + status (real-time)",
		"gate_decide": "Record human gate decision; writes evidence kind=gate-decision",
		"settle": "Advance VERIFY.accept → SETTLE.lessons (deep ceremony only)",
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
		"SETTLE": { "lessons": "结算 / 经验沉淀" },
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
	board: {
		"chrome": {
			"app_title": "loaf 看板",
			"brand": "loaf 看板",
			"scope_label": "范围",
			"all_sessions": "全部会话",
			"current_cwd": "当前 cwd",
			"refresh": "刷新",
			"theme_toggle": "切换主题",
			"eyebrow": "本地看板",
			"heading": "Loaf 实时看板",
			"subtitle": "读取本地 journal projection。",
			"active": "活跃",
			"blocked": "阻塞",
			"updated": "更新于",
			"waiting": "等待中",
			"board_label": "Loaf 会话看板",
			"no_sessions": "暂无会话。",
			"none": "无。",
			"session": "会话",
			"session_detail": "会话详情",
			"close_session_detail": "关闭会话详情",
			"loading": "加载中...",
			"session_error": "会话错误",
			"iteration_short": "迭代"
		},
		"column": {
			"TRIAGE": { "description": "打分并确认 ceremony" },
			"SPEC": { "description": "提案、规格、计划、设计" },
			"EXECUTE": { "description": "任务执行与并行展开" },
			"VERIFY": { "description": "运行、评审、验收、视觉" },
			"SETTLE": { "description": "经验沉淀" },
			"DONE": { "description": "已交付或终态会话" }
		},
		"status": {
			"pending_decision": "人工决策",
			"pending_question": "问题"
		},
		"detail": {
			"phase": "阶段",
			"sub_state": "子状态",
			"tail_seq": "尾序号",
			"tasks": "任务",
			"evidence": "证据",
			"open_findings": "开放发现",
			"pending": "待处理",
			"task_done_suffix": "完成",
			"evidence_passing_suffix": "通过",
			"steps_suffix": "步骤"
		}
	},
	diagnostic: {
		"SPEC_EDIT_INPUT_REQUIRED": "非交互式 `loaf spec edit` 必须传 --input <src>；编辑器通道要求 stdin 和 stdout 均为 TTY",
		"SPEC_LOCKED_NO_DIRECT_EDIT": "{kind} 被拒:spec_locked=true;用 `loaf finding raise --category spec-gap --action amend-spec` 走 amend-spec 回退到 SPEC.spec",
		"SPEC_NOT_INITIALIZED": "{kind} 被拒:spec_version=0;先跑 `loaf spec submit` 把 spec_version 升到 1",
		"SPEC_ALREADY_INITIALIZED": "spec.md 已存在于 {spec_md_path};拒绝覆盖",
		"CONFIG_ALREADY_INITIALIZED": "loaf config 已存在于 {config_path};拒绝覆盖",
		"FINDING_TARGET_REQUIRED": "finding action={action} target 校验失败({reason})",
		"PRUNE_RESTORE_NOT_FOUND": "没有匹配该 id 的已回收 session",
		"PRUNE_RESTORE_AMBIGUOUS": "该 session id 被回收过多次;用 --at <ts> 指定其一",
		"PRUNE_RESTORE_INCOMPLETE": "trash 桶不完整(缺必要文件),不予恢复",
		"PRUNE_PATH_OCCUPIED": "恢复目标已存在,拒绝覆盖",
		"PRUNE_PARTIAL_FAILURE": "prune 部分失败:有 session 未能删除",
		"MUTUALLY_EXCLUSIVE_FLAGS": "同一次调用使用了互斥的 flags:{flags}",
		"INVALID_FORMAT": "无效的 --format 值 '{value}';合法值:{allowed_values_human}",
		"INVALID_LOCALE": "locale 来源 {source} 的值无效(期望:{accepted})",
		"DRY_RUN_NOT_APPLICABLE": "--dry-run 不适用于{command_type}命令 `{command}`",
		"HOOK_EVENT_NOT_IMPLEMENTED": "hook event `{event}` 在当前 loaf 版本未实装(Phase 16 SC-15{sub_cycle} 待实现;详 protocol §11)",
		"MISSING_VERIFIABILITY": "需求 {req_id} 必须声明 measurable、verified_by_scenarios[] 或 acceptance_na+reason 三选一",
		"DRIVES_NOT_BOUND": "需求 {req_id} 没有被任何 task.drives[] 引用",
		"MUTATION_OUT_OF_RIGHTS": "task {task_id} 的 event:tasks_amended 在 sub_state {sub_state} 不被允许 —— §8.6 未授予该改动的 mutation right",
		"FEATURE_NOT_FOUND": "当前 cwd 找不到 feature(.loaf/ 为空或缺失,或所有 projection 已 DONE)",
		"FEATURE_AMBIGUOUS": "当前 cwd 有 {count} 个 active feature 但无 dispatch 上下文:{feature_list}",
		"SESSION_CWD_MISMATCH": "--session {uuid} 注册的 cwd={registered_cwd},当前 cwd 是 {current_cwd}",
		"SESSION_SHORT_AMBIGUOUS": "--session {prefix} 在 registry 匹配 {match_count} 个 session:{candidate_list}",
		"SESSION_NOT_FOUND": "--session {uuid_or_prefix} 在 registry 找不到任何匹配",
		"PENDING_BLOCKS_ADVANCE": "pending head {pending_id}(kind={kind})阻塞 `loaf advance`,需先 resolve",
		"GATE_NOT_PENDING": "`loaf gate decide {gate_kind}` 要求 pending head kind=gate_decision;当前 head kind:{head_kind}",
		"ESCALATION_NOT_PENDING": "`loaf profile escalate --confirm --input <ceremony.json>` 要求 pending head kind=profile_escalation;当前 head:{actual_head}",
		"EXECUTE_DONE_TASKS_NOT_FINAL": "无法从 EXECUTE.work 推进到 EXECUTE.done:{count} 个 task 未处于终态(done 或 abandoned);跑完剩余 step,或用 `loaf tasks abandon <T-N> --reason \"...\"` 放弃超出范围的 task",
		"OPEN_FINDINGS_PRESENT": "verify-accept 检查 2: 仍有 {count} 个可执行 finding 未关闭(ids={open_ids});请在 verify-accept 前解决或关闭",
		"COVERAGE_NOT_SATISFIED": "{covered_id} 没有任何证据满足覆盖(canSatisfy 对所有候选 evidence 都失败)",
		"DELIVER_NOT_ACCEPTED": "deliver 要求 verify_accepted=true(sub_state={sub_state});先运行 `loaf gate decide verify-accept --approve`",
		"DELIVER_SETTLE_PHASE_BYPASS": "VERIFY.accept 直接 deliver 要求 ceremony.settle_phase=false(standard);deep ceremony 必须先运行 `loaf settle`",
		"DELIVER_VERIFY_MIN_UNAVAILABLE": "verify-min 在此 build 不可用(ceremony_label={ceremony_label})—— v0.1.1 起由 DELIVER_VERIFY_MIN_INCOMPLETE 取代,已不再触发",
		"DELIVER_VERIFY_MIN_INCOMPLETE": "verify-min:{count} 个 done task 缺少 deliver 所需 evidence(ceremony_label={ceremony_label});补 evidence 或 waive 后重试 deliver",
		"DELIVER_SPIKE_TASKS": "无法 deliver:task {task_id} 是 kind=spike(status={status});spike 任务阻塞整 session 的交付",
		"SETTLE_NOT_ACCEPTED": "VERIFY.accept → SETTLE.lessons 要求 verify_accepted=true;先运行 `loaf gate decide verify-accept --approve` 再 `loaf settle`",
		"SPEC_LOCK_NOT_SATISFIED": "SPEC.design → EXECUTE.plan 要求 spec_locked=true;先运行 `loaf gate decide spec-lock --approve` 再 `loaf advance EXECUTE.plan`",
		"TASK_NOT_CLAIMABLE": "task {task_id} 无法 claim(status={status} — 终态)",
		"TASK_ALREADY_CLAIMED": "task {task_id} 已被 claim(status=in_progress)",
		"TASK_DEP_NOT_FOUND": "task {task_id} 的 {field} 引用了不存在的 task {ref}",
		"TASK_DEP_SELF": "task {task_id} 不能依赖自身",
		"TASK_DEP_DUPLICATE": "task {task_id} 在下标 {indexes} 重复声明依赖 {ref}",
		"TASK_DEP_CYCLE": "task 依赖图包含环 {cycle}",
		"TASK_DEP_ABANDONED": "task {task_id} 的 {field} 引用了已 abandoned 的 task {ref};{hint}",
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
		"BUG_TASK_REQUIRES_RED": "behavioral bug task {task_id} 在注册 RED 测试前不能开始或完成 implement step",
		"BUG_TASK_FLAG_MISUSE": "task {task_id}:red_test_registered=true 只在 behavioral bug task 的 red-step task_step_done(passed/waived)上有效 —— 不能用在本 entry",
		"BUG_TASK_RED_NOT_REGISTERED": "behavioral bug task {task_id} 已 done 但从未注册 RED 测试(red_test_registered≠true)",
		"SPIKE_CONVERT_NO_SPIKE_TASK": "无法 convert:session 没有非-abandoned 的 spike task;`loaf spike convert` 是 spike-task 出口(protocol §8.3)",
		"SNAPSHOT_STALE_REBUILD_REQUIRED": "snapshot 失效(reason={reason});跑 `loaf doctor --rebuild --feature <feature>` 从 journal 重建",
		"JOURNAL_TAIL_REQUIRES_NEWER_LOAF": "tail recovery 已拒绝:seq {seq} 的 journal kind {kind} 使用 entry schema {entry_schema_version} ({reason})",
		"INVALID_PRESET": "ceremony preset 不合法",
		"USAGE": "CLI 用法不合法",
		"DOCTOR_MODE_NOT_IMPLEMENTED": "当前发布版本未实现该 loaf doctor 模式",
		"DOCTOR_FEATURE_REQUIRED": "loaf doctor --rebuild 必须带 --feature <name>",
		"DOCTOR_REBUILD_FAILED": "doctor --rebuild 失败",
		"REDUCER_ERROR": "reducer 内部不变量失败",
		"SCOPE_RECORDED_BATCH_INVALID": "scope:recorded 批次无效:{reason}",
		"SCOPE_RECORDED_ITERATION_DUPLICATE": "iteration {iteration} 已存在 scope:recorded",
		"ACTUAL_SCOPE_HISTORY_INCOMPLETE": "actual scope 历史不完整:seq {transition_seqs} 的 EXECUTE closure transition 缺少同批 scope:recorded marker",
		"WRITE_PATH_VIOLATION": "写入被拦截:`{normalized_path}` 不在 sub_state `{sub_state}` 的允许写入路径内",
		"PROTECTED_FILE_WRITE": "写入被拦截:`{normalized_path}` 命中 protected_files 条目 `{matched_deny}` —— 受保护文件永不可写"
	},
	diagnostic_fix: {
		"JOURNAL_TAIL_REQUIRES_NEWER_LOAF": "保持 journal.jsonl 字节不变，升级到能识别该 entry 的 loaf 版本后再运行 tail recovery",
		"ACTUAL_SCOPE_HISTORY_INCOMPLETE": "不要伪造空 actual_scope;保留 journal,使用支持 F-027 的 loaf 版本重新执行该 feature 的 EXECUTE work 后再审计 scope。pre-F-027 closure scope 无法从 journal 历史重建。"
	},
	diagnostic_variant: { "failure": {
		"check": {
			"path_missing": "input file 不存在:{path}",
			"selector_conflict": "check 不接受 {conflicting} —— 它按路径校验文件,独立于 feature session",
			"kind_required": "`{subject}` 不是文件路径. 如需校验 {kind} artifact,需要显式路径: `{suggestion}`(noun-first `loaf {kind} check` 预留给未来版本)",
			"kind_invalid": "--kind 必须是 {allowed_kinds_human};当前为 '{value}'"
		},
		"profile": {
			"input_file_missing": "input file 不存在:{path}",
			"input_file_unreadable": "无法读取 input file {path}:{error}"
		},
		"lessons": {
			"file_missing": "lesson file 不存在:{path}",
			"text_too_short": "lesson text 必须 ≥{min_length} 字符(当前 {lesson_text_length})",
			"reason_too_short": "--reason 必须 ≥{min_length} 字符(当前 {reason_length})",
			"text_file_mutex": "--text 和 --file 必须二选一({provided_state})"
		},
		"hook": {
			"stdin_parse_failed": "hook stdin payload 解析失败:{reason}",
			"missing_event": "loaf hook 需要 event token;可选值:{events}. 运行 `loaf hook --list-events` 查看完整枚举",
			"unknown_event": "未知 hook event '{event}';期望值:{allowed}. 你是不是想输入 '{suggestion}'?",
			"write_path_missing": "write-side hook 需要 --path <P> 或非 TTY stdin hook payload(tool_input.file_path)"
		},
		"schema": {
			"validation": "{kind} at {path} 校验失败({error_count} {error_word})",
			"selector_conflict": "{subject} 不接受 {conflicting} —— schema dump 与 feature 无关"
		},
		"handoff": {
			"pack_validation_failed": "ResumePack 运行时校验失败(builder bug 或 schema drift)",
			"reason_too_short": "--reason 必须 ≥{min_length} 字符(当前 {reason_length})"
		},
		"tasks_add": { "empty_array": "tasks add 输入不能为空数组" },
		"write_guard": { "config_invalid": "write-guard 被拦截:{reason}" },
		"no_session": {
			"status": "先跑 `loaf start {feature}`",
			"advance": "先跑 `loaf start {feature}`",
			"tasks": "先跑 `loaf start {feature}`",
			"pending": "先跑 `loaf start {feature}`",
			"finding": "先跑 `loaf start {feature}`",
			"verify": "先跑 `loaf start {feature}`",
			"generic": "先跑 `loaf start {feature}`"
		},
		"sessions_list": { "selector_conflict": "sessions list 不接受 {conflicting} —— 它会跨全部 session 列表;如需过滤当前 cwd,使用 --in-cwd" },
		"tui": {
			"selector_conflict": "tui 不接受 {conflicting} —— 它会跨全部 session 列表;selector 对交互 UI 没有意义",
			"interactive_only": "tui 仅支持交互模式;脚本化 session 输出请使用 `loaf sessions list --format json`"
		},
		"dispatch": {
			"session_feature_dir_conflict": "{conflicting} 不能与 --feature-dir 一起使用(session identity 来自 registry;手动 featureDir 会矛盾)",
			"feature_dir_requires_feature": "--feature-dir 需要 --feature <name> 或 $LOAF_FEATURE 来命名 feature"
		},
		"start": {
			"label_too_short": "--label 至少需要 {min_length} 个字符",
			"workspace_empty": "--workspace 不能为空"
		},
		"finding": { "status_invalid": "--status 必须是:{allowed_statuses_human}(当前 {value})" },
		"journal": {
			"integer_invalid": "{flag} 必须是 >= {minimum} 的整数(当前 {value})",
			"kind_invalid": "--kind 必须是已注册的 journal kind(当前 {value})",
			"actor_invalid": "--actor 必须是非空 actor 前缀或完整 actor 字符串"
		},
		"evidence": {
			"covers_invalid": "--covers 必须是有效的 coverage id(当前 {value})",
			"task_invalid": "--task 必须是有效的 task id(当前 {value})",
			"kind_invalid": "--kind 必须是:{allowed_kinds_human}"
		}
	} },
	diagnostic_variant_fix: {},
	success: {
		"next": {
			"full_command_pointer": "运行 `{command}` 获取完整命令",
			"deliver": "loaf deliver",
			"settle": "loaf settle",
			"settle_lessons": "loaf lessons add --text \"<lesson>\" --reason \"<why it matters>\""
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
			"state_change": "settle: {from} → SETTLE.lessons"
		},
		"resume": { "state_change": "resume: session {session_id}(sub_state={sub_state} unchanged)" },
		"handoff": { "state_change": "handoff: resume-pack.json written by {actor}" },
		"pending": {
			"raise_state_change": "pending raise: {pending_id}(kind={kind})",
			"resolve_text": "已 resolve {pending_id}(kind={kind})",
			"resolve_state_change": "pending resolve: {pending_id} cleared"
		},
		"waive": { "state_change": "waive: {evidence_id} obligation={obligation_id}" },
		"lessons": { "add_state_change": "lessons add: {lesson_id} 已记录(kind=lesson:recorded; lessons.md 已更新)" },
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
			"init_next": "编辑后运行 `loaf spec edit --input <json>`",
			"edit_text": "spec edit: spec_version={spec_version}",
			"edit_state_change": "spec edit: spec_version={spec_version} via $EDITOR",
			"edit_input_state_change": "spec edit: spec_version={spec_version} via --input",
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
		"journal": {
			"list_row": "序号={seq} 条目={entry_id} 时间={at} 操作者={actor} 类型={kind}",
			"list_row_batch": "序号={seq} 条目={entry_id} 时间={at} 操作者={actor} 类型={kind} 批次={batch_id} 批次索引={batch_index} 批次数量={batch_count}",
			"list_empty": "没有日志条目。"
		},
		"evidence": {
			"list_row": "id={id} 类型={kind} 覆盖={covers} 任务={task_id} 时间={at} 操作者={actor}",
			"list_empty": "没有证据条目。",
			"compatibility_warning": "证据类型 {kind} 无法满足 {covered_id};请改用以下类型之一:{allowed_kinds}(条目已写入)"
		},
		"spec_status": {
			"pass": "spec-lock：通过",
			"failure_row": "检查 {check}：失败 {code} — {message}",
			"suppressed_row": "检查 {check}：已抑制（由检查 {blocked_by} 阻塞）"
		},
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
			"check_deferred_findings": "延期发现",
			"info": "信息",
			"deferred_summary": " {findings}(不阻塞)",
			"failure_summary_one": " {code}",
			"failure_summary_many": " {count} 个失败({code}, …)",
			"diagnostic_only": "(仅诊断 —— 不代表 gate 结论)",
			"lane_label": "泳道.{lane}",
			"lane_reason": " —— {reason}",
			"lane_reason_no_done_tasks": "没有已完成任务需要运行验证",
			"lane_reason_no_review_obligations": "没有非 NA 需求或已完成任务需要评审验证",
			"lane_reason_no_e2e_scenarios": "没有适用的 e2e 场景需要验收验证",
			"lane_reason_no_visual_contracts": "没有适用的视觉合约需要视觉验证"
		},
		"tui": {
			"list": {
				"title": "loaf sessions ({active_count} 活跃 / {total_count} 总计)",
				"sort": "排序: {sort}",
				"sort_time": "时间",
				"sort_status": "状态",
				"reloading": "刷新中…",
				"empty": "(没有会话)",
				"help": "[↑/↓] 移动 · [Enter] 详情 · [space] 折叠 · [a] 活跃/全部 · [s] 排序 · [r] 重新加载 · [q] 退出",
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
		"resume": "从 handoff pack 恢复 session",
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
		"verify_status": "实时计算各 verify check 的 applicability + status",
		"gate_decide": "记录人工 gate 决策;写 evidence kind=gate-decision",
		"settle": "推进 VERIFY.accept → SETTLE.lessons(仅 deep ceremony)",
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
		detail: {
			source: "user-config",
			accepted: [...LOCALES],
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
//#endregion
//#region src/cli/diagnostic-failure.ts
function catalogVars(template, detail) {
	const vars = {};
	for (const key of template.template_keys) {
		const field = template.adapter?.[key] ?? key;
		const value = detail[field];
		if (value === void 0) throw new Error(`diagnostic contract missing detail.${field}`);
		vars[key] = Array.isArray(value) ? value.map((item) => String(item)).join(template.list_separator?.[key] ?? ", ") : typeof value === "object" && value !== null ? JSON.stringify(value) : String(value);
	}
	return vars;
}
/** Project nested domain check records only at the presentation boundary. */
function presentedDetail(detail, i18n) {
	if (!Array.isArray(detail["checks"])) return detail;
	const checks = detail["checks"];
	return {
		...detail,
		checks: checks.map((check) => ({
			...check,
			message: diagnosticMessage(check, i18n)
		}))
	};
}
function diagnosticContextRows(detail) {
	const lines = [];
	if (typeof detail["parser_code"] === "string" && typeof detail["reason"] === "string") lines.push(`  [${detail["parser_code"]}] ${detail["reason"]}\n`);
	const checks = detail["checks"];
	if (Array.isArray(checks)) for (const c of checks) lines.push(`  [check ${c.check ?? "?"}] ${c.code ?? "UNKNOWN"}: ${c.message ?? ""}\n`);
	const errors = detail["errors"];
	if (Array.isArray(errors)) {
		for (const e of errors) lines.push(`  [${e.path ?? "?"}] ${e.code ?? "UNKNOWN"}: ${e.message ?? ""}\n`);
		if (detail["truncated"] === true) {
			const count = detail["error_count"];
			lines.push(`  ... (${typeof count === "number" ? count : "?"} errors total; first ${errors.length} shown)\n`);
		}
	}
	return lines.join("");
}
/** Canonical message for nested replay diagnostics at existing presentation boundaries. */
function diagnosticMessage(diagnostic, i18n = DEFAULT_I18N) {
	return renderDiagnostic(diagnostic, i18n).message;
}
function renderDiagnostic(diagnostic, i18n) {
	const parent = ERROR_CATALOG[diagnostic.code];
	const context = diagnostic.detail["context"];
	const variant = context === void 0 ? void 0 : DIAGNOSTIC_VARIANTS[context];
	if (context !== void 0 && (variant === void 0 || variant.code !== diagnostic.code)) throw new Error(`diagnostic context ${context} does not belong to ${diagnostic.code}`);
	const template = variant?.template ?? parent;
	const vars = catalogVars(template, diagnostic.detail);
	const key = context === void 0 ? `diagnostic.${diagnostic.code}` : `diagnostic_variant.${context}`;
	return {
		parent,
		context,
		template,
		vars,
		message: i18n.t(key, vars)
	};
}
/** Sole recoverable exit-2 outlet; no CLI/context dependency or error fallback. */
function writeDiagnosticFailure(diagnostic, presentation) {
	const i18n = presentation.format === "json" ? DEFAULT_I18N : presentation.i18n;
	const { parent, context, template, vars, message } = renderDiagnostic(diagnostic, i18n);
	const detail = presentedDetail(diagnostic.detail, i18n);
	if (presentation.format === "json") presentation.writeStderr(JSON.stringify({
		ok: false,
		code: diagnostic.code,
		message,
		detail
	}) + "\n");
	else {
		let output = `error: ${diagnostic.code} — ${message}\n` + diagnosticContextRows(detail);
		if (template.fix_template !== void 0) {
			const fixKey = context === void 0 ? `diagnostic_fix.${diagnostic.code}` : `diagnostic_variant_fix.${context}`;
			output += `  fix: ${i18n.t(fixKey, vars)}\n`;
		}
		if (template.doc_anchor !== void 0) output += `  see: ${template.doc_anchor}\n`;
		presentation.writeStderr(output);
	}
	return parent.exit_code;
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
			detail: {
				feature_dir: path.dirname(journalPath),
				reason: "journal_missing",
				journal_path: journalPath
			}
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
			detail: {
				feature_dir: path.dirname(journalPath),
				reason: "journal_empty",
				meta_last_applied_seq: meta.last_applied_seq
			}
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
			detail: {
				feature_dir: path.dirname(journalPath),
				reason: "trailing_partial_line",
				tail_bytes: trailingText.length
			}
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
				feature_dir: path.dirname(journalPath),
				reason: "tail_offset_mismatch",
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
				feature_dir: path.dirname(journalPath),
				reason: "tail_hash_mismatch",
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
		...result.detail,
		feature_dir: featureDir,
		fix: fixForFeatureDir(featureDir)
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
	const result = RegistryFile.safeParse(parsed);
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
	const token = scanArgv(optionArgv(argv), new Set([flag])).find((token) => token.kind === "option" && token.flag === flag);
	if (token?.kind === "option") {
		const value = token.value;
		return token.raw.includes("=") || value !== void 0 && !value.startsWith("--") ? value : void 0;
	}
}
async function resolveDispatch(input) {
	const sessionFlag = pickFlagValue(input.argv, "--session");
	const featureFlag = pickFlagValue(input.argv, "--feature");
	const featureDirFlag = pickFlagValue(input.argv, "--feature-dir");
	const sessionEnv = input.env["LOAF_SESSION"];
	const featureEnv = input.env["LOAF_FEATURE"];
	if (sessionFlag !== void 0 && featureDirFlag !== void 0) return usageConflict(["--session", "--feature-dir"]);
	if (sessionFlag !== void 0) return resolveBySessionId(sessionFlag, input, "session-flag");
	if (featureFlag !== void 0) return resolveByFeatureName(featureFlag, input, "feature-flag", featureDirFlag);
	if (sessionEnv !== void 0 && featureDirFlag !== void 0) return usageConflict(["$LOAF_SESSION", "--feature-dir"]);
	if (sessionEnv !== void 0 && sessionEnv.length > 0) return resolveBySessionId(sessionEnv, input, "session-env");
	if (featureEnv !== void 0 && featureEnv.length > 0) return resolveByFeatureName(featureEnv, input, "feature-env", featureDirFlag);
	if (featureDirFlag !== void 0) return usageConflict(["--feature-dir"]);
	return autoPickFromCwd(input);
}
function usageConflict(conflicting) {
	return {
		ok: false,
		...diagnosticVariant(conflicting.length === 1 ? "failure.dispatch.feature_dir_requires_feature" : "failure.dispatch.session_feature_dir_conflict", { conflicting })
	};
}
async function resolveBySessionId(uuidOrPrefix, input, source) {
	if (uuidOrPrefix.length < MIN_SHORT_UUID_PREFIX) return {
		ok: false,
		code: "USAGE",
		detail: {
			reason: "session_prefix_too_short",
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
		detail: {
			uuid_or_prefix: uuidOrPrefix,
			registry_dir: registryDir,
			source
		}
	};
	if (matches.length > 1) return {
		ok: false,
		code: "SESSION_SHORT_AMBIGUOUS",
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
		detail: {
			uuid_or_prefix: uuidOrPrefix,
			session_id: sessionId,
			reason: read.reason,
			cause: read.strictDetail,
			source
		}
	};
	const registryFile = read.file;
	if ((await tryRealpath(registryFile.cwd) ?? registryFile.cwd) !== (await tryRealpath(input.cwd) ?? input.cwd)) return {
		ok: false,
		code: "SESSION_CWD_MISMATCH",
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
			detail: {
				feature: name,
				feature_dir: featureDir,
				source
			}
		};
		if (err instanceof SnapshotStaleError) return {
			ok: false,
			code: "SNAPSHOT_STALE_REBUILD_REQUIRED",
			detail: {
				...err.detail,
				feature_dir: featureDir,
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
		detail: {
			cwd: input.cwd,
			candidate_count: candidates.length
		}
	};
	if (active.length >= 2) return {
		ok: false,
		code: "FEATURE_AMBIGUOUS",
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
		detail: {
			reason: "empty",
			value: rawValue
		}
	};
	if (rawValue.trim().length === 0) return {
		ok: false,
		code: "INVALID_ACTOR_FORMAT",
		detail: {
			reason: "all_whitespace",
			value: rawValue
		}
	};
	if (rawValue !== rawValue.trim()) return {
		ok: false,
		code: "INVALID_ACTOR_FORMAT",
		detail: {
			reason: "leading_or_trailing_whitespace",
			value: rawValue
		}
	};
	if (NAMESPACE_PREFIXES.some((p) => rawValue.startsWith(p))) return {
		ok: false,
		code: "INVALID_ACTOR_FORMAT",
		detail: {
			reason: "reserved_namespace",
			value: rawValue
		}
	};
	const candidate = `human:${rawValue}`;
	if (!ActorString.safeParse(candidate).success) return {
		ok: false,
		code: "INVALID_ACTOR_FORMAT",
		detail: {
			reason: "actor_schema_invalid",
			value: rawValue
		}
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
		detail: { reason: "non_interactive" }
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
		detail: { reason: "git_identity_unavailable" }
	};
	return buildHumanActor(gitEmail);
}
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
const MATCH_OPTS = { dot: true };
function substituteFeature(glob, feature) {
	return glob.replace(/<feature>/g, feature);
}
function escapesRepoRoot(normalized) {
	return path.posix.isAbsolute(normalized) || path.win32.isAbsolute(normalized) || normalized.split("/").includes("..");
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
*   2. reject lexical repo-root escapes before consulting any glob
*   3. protected_files HARD-DENY (config) — wins over any allow
*   4. allow-set = built-in globs (<feature>-substituted) ∪ config.paths[cat]
*      for cat ∈ activeCategories only (category-aware widening, NOT a flat
*      union — `paths.tests` cannot authorize a source write in implement)
*   5. match → allowed; else WRITE_PATH_VIOLATION
*/
function evaluateWritePath(input) {
	const normalized = normalizeToRepoRoot(input.targetPath, input.repoRoot);
	if (escapesRepoRoot(normalized)) return {
		allowed: false,
		code: "WRITE_PATH_VIOLATION",
		normalizedPath: normalized,
		allowSet: [],
		reason: "outside_repo_root"
	};
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
//#region src/cli/argv-presentation.ts
/** Pure argv/environment presentation parsing.
*
* This module is the functional core for CLI presentation decisions. Every
* environment-dependent parser requires its environment explicitly; process
* state is owned and injected by command-context.ts.
*/
const FORMAT_VALUE_FLAGS = new Set(["--format"]);
/** Closed value set for `--format`. Single source of truth for both the
* argv parser and the human-readable error template. */
const FORMAT_MODES$1 = ["text", "json"];
/** Pipe-joined human form for INVALID_FORMAT i18n templates. */
const FORMAT_MODES_HUMAN$1 = FORMAT_MODES$1.join("|");
/** Scan EVERY `--format` / `--format=` occurrence — not just the first — so a
* later invalid value is not masked by an earlier valid one (codex r258 F1).
* This exhaustiveness is what gives INVALID_FORMAT its position-independent
* precedence over the mutex check. */
function findFirstInvalidFormat(argv) {
	for (const token of scanArgv(optionArgv(argv), FORMAT_VALUE_FLAGS)) {
		if (token.kind !== "option" || token.flag !== "--format") continue;
		const value = token.value;
		if (!token.raw.includes("=") && (value === void 0 || value.startsWith("--"))) continue;
		if (value !== void 0 && !FORMAT_MODES$1.includes(value)) return { rawValue: value };
	}
	return null;
}
function parsePlainFromArgv(argv) {
	return scanArgv(optionArgv(argv)).some((token) => token.raw === "--plain");
}
function parseQuietFromArgv(argv) {
	return scanArgv(optionArgv(argv)).some((token) => token.raw === "--quiet") || scanArgv(optionArgv(argv)).some((token) => token.raw === "-q");
}
function parseNoInputFromArgv(argv) {
	return scanArgv(optionArgv(argv)).some((token) => token.raw === "--no-input");
}
function parseDebugFromArgv(argv, env) {
	if (scanArgv(optionArgv(argv)).some((token) => token.raw === "--debug")) return true;
	if (env.LOAF_DEBUG && env.LOAF_DEBUG.length > 0) return true;
	if (env.DEBUG && env.DEBUG.length > 0) return true;
	return false;
}
function parseDryRunFromArgv(argv) {
	return scanArgv(optionArgv(argv)).some((token) => token.raw === "--dry-run") || scanArgv(optionArgv(argv)).some((token) => token.raw === "-n");
}
function parseVerboseFromArgv(argv) {
	let count = 0;
	for (const { raw: arg } of scanArgv(optionArgv(argv))) {
		if (arg === "--verbose") {
			count += 1;
			continue;
		}
		if (/^-v+$/.test(arg)) count += arg.length - 1;
	}
	return count;
}
/** Color suppression per protocol §10.2: `--no-color`, non-empty `NO_COLOR` or
* `LOAF_NO_COLOR`, or `TERM=dumb`. */
function parseNoColorFromArgv(argv, env) {
	if (scanArgv(optionArgv(argv)).some((token) => token.raw === "--no-color")) return true;
	if (env.NO_COLOR && env.NO_COLOR.length > 0) return true;
	if (env.LOAF_NO_COLOR && env.LOAF_NO_COLOR.length > 0) return true;
	if (env.TERM === "dumb") return true;
	return false;
}
function collectOutputFormatEntries(argv) {
	const out = [];
	for (const token of scanArgv(optionArgv(argv), FORMAT_VALUE_FLAGS)) {
		if (token.raw === "--plain") {
			out.push({
				entry: "--plain",
				canonical: "text"
			});
			continue;
		}
		if (token.kind !== "option" || token.flag !== "--format") continue;
		const value = token.value;
		if (value !== void 0 && FORMAT_MODES$1.includes(value)) out.push({
			entry: token.raw.includes("=") ? token.raw : `--format ${value}`,
			canonical: value
		});
	}
	return out;
}
/** Parse presentation flags with INVALID_FORMAT taking precedence over
* MUTUALLY_EXCLUSIVE_FLAGS. The caller must inject the environment. */
function parsePresentation$1(argv, env) {
	const invalid = findFirstInvalidFormat(argv);
	if (invalid) return {
		ok: false,
		kind: "INVALID_FORMAT",
		rawValue: invalid.rawValue
	};
	const entries = collectOutputFormatEntries(argv);
	if (new Set(entries.map((entry) => entry.canonical)).size > 1) {
		const renderAsJson = entries.some((entry) => entry.canonical === "json");
		return {
			ok: false,
			kind: "MUTUALLY_EXCLUSIVE_FLAGS",
			conflicting: Array.from(new Set(entries.map((entry) => entry.entry))),
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
//#endregion
//#region src/cli/command-context.ts
const FORMAT_MODES = FORMAT_MODES$1;
const FORMAT_MODES_HUMAN = FORMAT_MODES_HUMAN$1;
function parsePresentation(argv, env = process.env) {
	return parsePresentation$1(argv, env);
}
/** Pre-resolve `--feature <NAME>` from argv. Best-effort; null on miss.
*  Lifted here (was duplicated in src/core/crash-log.ts) so ctx and
*  crash-log can agree on what "feature" means for a given invocation. */
function extractFeature$1(argv) {
	const options = optionArgv(argv);
	const i = options.indexOf("--feature");
	if (i < 0 || i + 1 >= options.length) return null;
	const v = options[i + 1];
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
	const presentation = parsePresentation(argv, process.env);
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
				if (renderedAdvisories.warnings !== void 0) {
					const lines = Array.isArray(renderedAdvisories.warnings) ? renderedAdvisories.warnings : [renderedAdvisories.warnings];
					for (const line of lines) deps.writeStderr(`warning: ${line}\n`);
				}
			}
		},
		snapshotCrashContext() {
			return {
				phase: phaseOf(lastResolvedSubState),
				sub_state: lastResolvedSubState,
				feature: extractFeature$1(argv),
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
		},
		failure(diagnostic) {
			exitCode = writeDiagnosticFailure(diagnostic, {
				format: output,
				i18n,
				writeStderr: deps.writeStderr
			});
		},
		resolveHumanActorOrFail() {
			const isInteractive = (deps.isInteractiveHuman?.() ?? process.stdin.isTTY === true) && !noInput;
			const readGitConfig = deps.readGitConfig ?? getGitEmail;
			const r = resolveHumanActor({
				env: process.env,
				readGitConfig,
				isInteractiveHuman: isInteractive
			});
			if (!r.ok) {
				ctx.failure(r);
				return null;
			}
			return r.actor;
		},
		async dispatchOrFail(opts) {
			const dispatch = await ctx.resolveDispatch();
			if (!dispatch.ok) {
				ctx.failure(dispatch);
				return null;
			}
			if (dispatch.autoPickAdvisory) ctx.advisory(dispatch.autoPickAdvisory);
			opts.feature = dispatch.feature;
			opts.featureDir = dispatch.featureDir;
			ctx.recordTraceTarget(dispatch.feature, dispatch.featureDir);
			return dispatch.featureDir;
		},
		async dispatchForHookOptional(opts) {
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
				stale: dispatch
			};
			return { skip: true };
		},
		async resolveHookPath(opts) {
			if (opts.path !== void 0 && opts.path.length > 0) return opts.path;
			if (!(deps.isStdinTty ?? (() => process.stdin.isTTY === true))()) {
				const readStdin = deps.readStdin;
				if (!readStdin) throw new Error("CommandContext: readStdin dep not provided; cannot resolveHookPath from stdin");
				const parsed = parseHookStdinPath(await readStdin());
				if (!parsed.ok) {
					ctx.failure(diagnosticVariant("failure.hook.stdin_parse_failed", {
						reason: parsed.reason,
						source: "hook-stdin"
					}));
					return null;
				}
				return parsed.path;
			}
			ctx.failure(diagnosticVariant("failure.hook.write_path_missing", {}));
			return null;
		},
		async resolveDispatchForWriteGuard(opts) {
			let dispatch;
			try {
				dispatch = await ctx.resolveDispatch();
			} catch (err) {
				return {
					failClosed: true,
					code: "SNAPSHOT_STALE_REBUILD_REQUIRED",
					detail: { reason: err.message }
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
				...dispatch
			};
		},
		async loadProjectionsOrFail(featureDir, kinds, feature, noSessionKey) {
			const loader = deps.loadProjectionsDirect ?? deps.loadProjections;
			if (!loader) throw new Error("CommandContext: loadProjections dep not provided; cannot loadProjectionsOrFail");
			try {
				return await loader({
					feature_dir: featureDir,
					kinds
				});
			} catch (err) {
				if (err instanceof NoSessionError) {
					ctx.failure(diagnosticVariant(noSessionKey, {
						...err.detail,
						feature
					}));
					return null;
				}
				if (err instanceof SnapshotStaleError) {
					ctx.failure(err);
					return null;
				}
				throw err;
			}
		}
	};
	return ctx;
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
async function assertJournalTailMatchesMeta(filePath, priorMeta) {
	const tail = await readJournalTail(filePath);
	const { tailSeq, fileSize, tailLine } = tail;
	if (tailSeq === -1) {
		if (!isEmptyMeta(priorMeta)) throw new AppendError("PRIOR_META_STALE", "journal tail is empty (seq -1) but priorMeta is not the empty sentinel; a non-empty prior meta would corrupt the post-append rolling checksum", {
			meta_seq: priorMeta.last_applied_seq,
			tail_seq: tailSeq
		});
		return tail;
	}
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
	return tail;
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
	const { tailSeq, fileSize } = await assertJournalTailMatchesMeta(filePath, priorMeta);
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
//#region src/core/feature-write-lease.ts
const FeatureLeaseFile = z.object({
	pid: z.number().int().positive(),
	acquired_at: z.string().datetime(),
	operation: z.string().min(1).max(200),
	owner: z.string().regex(/^[0-9a-f]{32}$/)
}).strict();
var FeatureWriteLeaseError = class extends Error {
	diagnostic;
	lockPath;
	holder;
	constructor(diagnostic, message, lockPath, holder) {
		super(message);
		this.diagnostic = diagnostic;
		this.lockPath = lockPath;
		this.holder = holder;
		this.name = "FeatureWriteLeaseError";
	}
	get code() {
		return this.diagnostic.code;
	}
};
const DEFAULT_RETRY_DELAY_MS = 20;
const DEFAULT_LEGACY_STALE_MS = 3e4;
const activeOwners = /* @__PURE__ */ new Map();
function defaultIsPidAlive(pid) {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		const code = error.code;
		if (code === "ESRCH") return false;
		if (code === "EPERM") return true;
		throw error;
	}
}
async function observe(lockPath) {
	let before;
	let raw;
	let after;
	try {
		before = await promises.stat(lockPath);
		raw = await promises.readFile(lockPath, "utf8");
		after = await promises.stat(lockPath);
	} catch (error) {
		if (error.code === "ENOENT") return { kind: "missing" };
		throw error;
	}
	if (before.dev !== after.dev || before.ino !== after.ino || before.mtimeMs !== after.mtimeMs || before.size !== after.size) return await observe(lockPath);
	const identity = {
		dev: after.dev,
		ino: after.ino,
		mtimeMs: after.mtimeMs,
		size: after.size
	};
	if (raw.length === 0) return {
		kind: "legacy-empty",
		raw,
		identity
	};
	try {
		const parsed = FeatureLeaseFile.safeParse(JSON.parse(raw));
		return parsed.success ? {
			kind: "valid",
			raw,
			metadata: parsed.data,
			identity
		} : {
			kind: "invalid",
			raw,
			identity
		};
	} catch {
		return {
			kind: "invalid",
			raw,
			identity
		};
	}
}
async function createLease(lockPath, metadata, fsync) {
	let handle;
	let created = false;
	try {
		handle = await promises.open(lockPath, "wx", 384);
		created = true;
		await handle.writeFile(JSON.stringify(metadata));
		if (fsync) await handle.sync();
		await handle.close();
		handle = void 0;
		await promises.chmod(lockPath, 384);
	} catch (error) {
		if (handle) await handle.close().catch(() => {});
		if (created) await promises.unlink(lockPath).catch(() => {});
		throw error;
	}
}
async function unlinkIfUnchanged(lockPath, observed) {
	const current = await observe(lockPath);
	if ((current.kind === "valid" || current.kind === "legacy-empty" || current.kind === "invalid") && current.raw === observed.raw && current.identity.dev === observed.identity.dev && current.identity.ino === observed.identity.ino && current.identity.mtimeMs === observed.identity.mtimeMs && current.identity.size === observed.identity.size) {
		await promises.unlink(lockPath).catch((error) => {
			if (error.code !== "ENOENT") throw error;
		});
		return true;
	}
	return false;
}
async function acquireFeatureWriteLease(featureDir, operation, options = {}) {
	const lockPath = path.join(featureDir, ".lock");
	const now = options.now ?? (() => /* @__PURE__ */ new Date());
	const pid = options.pid ?? process.pid;
	const isPidAlive = options.isPidAlive ?? defaultIsPidAlive;
	const sleep = options.sleep ?? ((delayMs) => new Promise((resolve) => setTimeout(resolve, delayMs)));
	const retryDelayMs = Math.max(1, options.retryDelayMs ?? DEFAULT_RETRY_DELAY_MS);
	const timeoutMs = Math.max(0, options.timeoutMs ?? 3e4);
	const legacyLockStaleMs = Math.max(0, options.legacyLockStaleMs ?? DEFAULT_LEGACY_STALE_MS);
	const maxAttempts = Math.max(1, Math.ceil(timeoutMs / retryDelayMs) + 1);
	const metadata = FeatureLeaseFile.parse({
		pid,
		acquired_at: now().toISOString(),
		operation,
		owner: randomBytes(16).toString("hex")
	});
	let attempts = 0;
	let lastHolder;
	while (attempts < maxAttempts) {
		try {
			await createLease(lockPath, metadata, options.fsync ?? true);
			const confirmed = await observe(lockPath);
			if (confirmed.kind === "valid" && confirmed.metadata.owner === metadata.owner) {
				activeOwners.set(lockPath, metadata.owner);
				let released = false;
				return {
					path: lockPath,
					owner: metadata.owner,
					metadata,
					release: async () => {
						if (released) return;
						released = true;
						activeOwners.delete(lockPath);
						const current = await observe(lockPath);
						if (current.kind !== "valid" || current.metadata.owner !== metadata.owner) return;
						await unlinkIfUnchanged(lockPath, current);
					}
				};
			}
		} catch (error) {
			if (error.code !== "EEXIST") throw error;
		}
		const observed = await observe(lockPath);
		attempts += 1;
		if (observed.kind === "invalid") throw new FeatureWriteLeaseError({
			code: "LOCK_INVALID",
			detail: {
				lock_path: lockPath,
				lease_code: "LOCK_INVALID"
			}
		}, `feature write lease ${lockPath} is malformed or incomplete; refusing recovery`, lockPath);
		if (observed.kind === "valid") {
			lastHolder = observed.metadata;
			if (!isPidAlive(observed.metadata.pid)) {
				const current = await observe(lockPath);
				if (current.kind === "valid" && current.raw === observed.raw && !isPidAlive(current.metadata.pid)) {
					await unlinkIfUnchanged(lockPath, observed);
					continue;
				}
			}
		} else if (observed.kind === "legacy-empty" && now().getTime() - observed.identity.mtimeMs >= legacyLockStaleMs) {
			await unlinkIfUnchanged(lockPath, observed);
			continue;
		}
		if (attempts < maxAttempts) await sleep(retryDelayMs);
	}
	throw new FeatureWriteLeaseError({
		code: "LOCK_TIMEOUT",
		detail: {
			lock_path: lockPath,
			lease_code: "LOCK_TIMEOUT",
			timeout_seconds: timeoutMs / 1e3,
			...lastHolder !== void 0 && { holder: lastHolder }
		}
	}, lastHolder ? `feature write lease held by live PID ${lastHolder.pid} during ${lastHolder.operation}` : `could not acquire feature write lease ${lockPath} within ${timeoutMs}ms`, lockPath, lastHolder);
}
/**
* The CLI's first SIGINT exits synchronously, so async `finally` blocks cannot
* run. This hook performs a best-effort owner-token check before unlinking
* leases held by this process. Foreign successor generations are preserved.
*/
function releaseFeatureWriteLeasesForSignalSync() {
	for (const [lockPath, owner] of activeOwners) try {
		const parsed = FeatureLeaseFile.safeParse(JSON.parse(readFileSync(lockPath, "utf8")));
		if (parsed.success && parsed.data.owner === owner) unlinkSync(lockPath);
	} catch {} finally {
		activeOwners.delete(lockPath);
	}
}
//#endregion
//#region src/core/spec-snapshot.ts
/** Reconstruct and validate spec content without consulting derived files. */
function buildSpecFrontmatterFromSnapshot(snapshot) {
	if (snapshot.state === null || snapshot.spec_header === null) return {
		ok: false,
		code: "SPEC_FRONTMATTER_INVALID",
		detail: {
			source: "snapshot",
			subcode: "SPEC_NOT_FOUND",
			reason: snapshot.state === null ? "session_state_missing" : "spec_header_missing"
		}
	};
	const parsed = SpecFrontmatter.safeParse({
		schema_version: 2,
		spec_version: snapshot.state.spec_version,
		feature: snapshot.spec_header.feature,
		intent: snapshot.spec_header.intent,
		adr_refs: snapshot.spec_header.adr_refs,
		requirements: snapshot.requirements,
		scenarios: snapshot.scenarios,
		visual_contracts: snapshot.visual_contracts,
		needs_clarification: snapshot.spec_header.needs_clarification
	});
	if (!parsed.success) return {
		ok: false,
		code: "SPEC_FRONTMATTER_INVALID",
		detail: {
			source: "snapshot",
			subcode: "SPEC_FRONTMATTER_INVALID",
			issues: parsed.error.issues
		}
	};
	return {
		ok: true,
		frontmatter: parsed.data
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
		...diagnostic$2("SPEC_HAS_UNCLARIFIED", {
			count: frontmatter.needs_clarification.length,
			ids: frontmatter.needs_clarification.map((nc) => nc.id)
		})
	});
	let check3Failed = false;
	if (snapshot.tasks_based_on === null) {
		failures.push({
			check: 3,
			code: "TASKS_NOT_PLANNED",
			detail: {}
		});
		check3Failed = true;
	} else if (snapshot.tasks_based_on.spec !== frontmatter.spec_version) {
		failures.push({
			check: 3,
			code: "TASKS_BASED_ON_STALE",
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
			detail: { req_id: req.id }
		});
	}
	for (const req of frontmatter.requirements) if (!hasVerifiability(req)) failures.push({
		check: 5,
		code: "MISSING_VERIFIABILITY",
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
			detail: { scenario_id: scenario.id }
		});
	}
	if (!check3Failed) for (const visual of frontmatter.visual_contracts ?? []) {
		if (visual.visual_na !== void 0) continue;
		if (!snapshot.tasks.some((t) => t.kind === "visual-ui" && (t.visual_contract_refs ?? []).includes(visual.id))) failures.push({
			check: 7,
			code: "VISUAL_CONTRACT_UNBOUND",
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
/** Evaluate all spec-lock semantics from journal-replayed snapshot state. */
function evaluateSpecLockFromSnapshot(snapshot) {
	const built = buildSpecFrontmatterFromSnapshot(snapshot);
	if (!built.ok) return {
		ok: false,
		checks: [{
			check: 1,
			code: built.code,
			detail: built.detail
		}]
	};
	return specLockCheck(snapshot, built.frontmatter);
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
/**
* Return the actionable write-time diagnostic payload when `canSatisfy`
* rejects an evidence/obligation pair. This fulfills the input-time
* diagnostic promised by this module since Slice 3 while keeping the gate
* and CLI on the same predicate and compatibility table.
*
* The full predicate is evaluated, not kind membership alone. Successful
* `evidence add` writes have already passed EvidenceFullPayload, so the
* actor/reason/attachment refinements normally collapse to the same result
* as membership; retaining the full predicate prevents future drift if a
* new compatibility condition is added here.
*/
function evidenceCompatibilityMismatch(evidence, coveredId) {
	if (canSatisfy(evidence, coveredId)) return null;
	const idKind = parseIdKind(coveredId);
	if (idKind === null) return null;
	return {
		covered_id: coveredId,
		supplied_kind: evidence.kind,
		allowed_kinds: EVIDENCE_COMPAT[idKind].allowed
	};
}
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
function deriveVerifyLaneApplicability(snapshot, frontmatter) {
	const hasDoneTasks = snapshot.tasks.some((task) => task.status === "done");
	const hasReviewObligations = hasDoneTasks || frontmatter.requirements.some((req) => req.acceptance_na !== true);
	const hasAcceptanceObligations = frontmatter.scenarios.some((scenario) => scenario.tag === "e2e" && scenario.acceptance_na === void 0);
	const hasVisualObligations = (frontmatter.visual_contracts ?? []).some((visual) => visual.visual_na === void 0);
	return [
		{
			lane: "run",
			applicability: hasDoneTasks ? "must" : "na",
			reason: hasDoneTasks ? null : "no_done_tasks"
		},
		{
			lane: "review",
			applicability: hasReviewObligations ? "must" : "na",
			reason: hasReviewObligations ? null : "no_review_obligations"
		},
		{
			lane: "acceptance",
			applicability: hasAcceptanceObligations ? "must" : "na",
			reason: hasAcceptanceObligations ? null : "no_applicable_e2e_scenarios"
		},
		{
			lane: "visual",
			applicability: hasVisualObligations ? "must" : "na",
			reason: hasVisualObligations ? null : "no_applicable_visual_contracts"
		}
	];
}
function deriveVerifyApplicability(snapshot, frontmatter) {
	return new Set(deriveVerifyLaneApplicability(snapshot, frontmatter).filter((lane) => lane.applicability === "must").map((lane) => lane.lane));
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
		detail: { lane }
	});
	return failures;
}
function evalOpenFindings(snapshot) {
	const open = snapshot.findings.filter((f) => f.status === "open" && !isFindingDeferralAction(f.action));
	if (open.length === 0) return [];
	return [{
		check: 2,
		code: "OPEN_FINDINGS_PRESENT",
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
			detail: {}
		});
		return failures;
	}
	if (snapshot.tasks_based_on.spec !== frontmatter.spec_version) {
		failures.push({
			check: 4,
			code: "TASKS_BASED_ON_STALE",
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
		detail: { task_id: task.id }
	});
	else failures.push({
		check: 4,
		code: "BUG_TASK_RED_NOT_REGISTERED",
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
		detail: {}
	}];
	const implementers = deriveImplementers(snapshot);
	if (implementers.size === 0) return [{
		check: 5,
		code: "SPEC_REVIEW_IMPLEMENTER_UNKNOWN",
		detail: {}
	}];
	const conflicts = specReviews.filter((ev) => implementers.has(ev.actor));
	if (conflicts.length > 0 && conflicts.length === specReviews.length) return [{
		check: 5,
		code: "SPEC_REVIEW_IMPLEMENTER_CONFLICT",
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
*   - open_findings: ALWAYS applicable (never na); only actionable open
*                    findings fail, while defer/backlog remain visible
*                    non-blocking dispositions
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
//#region src/core/gates/verify-accept-eval.ts
function evaluateVerifyAccept(snapshot) {
	const built = buildSpecFrontmatterFromSnapshot(snapshot);
	if (!built.ok) return {
		ok: false,
		checks: [{
			check: 1,
			code: built.code,
			detail: built.detail
		}]
	};
	return verifyAcceptCheck(snapshot, built.frontmatter);
}
function evaluateVerifyAcceptDiagnostic(snapshot) {
	const built = buildSpecFrontmatterFromSnapshot(snapshot);
	if (!built.ok) return built;
	return {
		ok: true,
		checks: evaluateAllChecks(snapshot, built.frontmatter),
		lanes: deriveVerifyLaneApplicability(snapshot, built.frontmatter)
	};
}
//#endregion
//#region src/core/sidecar.ts
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
	for (const fieldName of attachmentFieldsFor(entry.kind)) {
		const value = payload[fieldName];
		const parsed = LongTextField.safeParse(value);
		if (!parsed.success) continue;
		const field = parsed.data;
		if (field.mode === "sidecar") {
			assertAttachmentOwnership(entry, fieldName, field.ref);
			continue;
		}
		if (Buffer.byteLength(field.text, "utf8") <= threshold) continue;
		promotedPayload[fieldName] = {
			mode: "sidecar",
			ref: await writeAttachment(attachmentRoot, entry, fieldName, field.text, { fsync })
		};
		mutated = true;
	}
	if (!mutated) return entry;
	return {
		...entry,
		payload: promotedPayload
	};
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
//#region src/core/scope-closure-policy.ts
function isExecuteClosure(entry) {
	const payload = entry.payload;
	return entry.kind === "event:phase_advanced" && payload.from === "EXECUTE.work" && payload.to === "EXECUTE.done";
}
function parseAdjacentFact(scope, transition) {
	if (scope.kind !== "scope:recorded" || !isExecuteClosure(transition)) return null;
	const parsed = ScopeRecordedPayload.safeParse(scope.payload);
	if (!parsed.success) return null;
	if (scope.actor !== transition.actor || scope.batch_id === void 0 || scope.batch_id !== transition.batch_id || scope.batch_index !== 0 || transition.batch_index !== 1 || scope.batch_count !== 2 || transition.batch_count !== 2) return null;
	return {
		scope,
		transition,
		iteration: parsed.data.iteration
	};
}
/**
* Parse canonical closure facts from journal history. Only the exact
* two-entry batch emitted by the closure writer is accepted as a fact.
*/
function parseScopeClosureFacts(entries) {
	const facts = [];
	const consumedTransitions = /* @__PURE__ */ new Set();
	for (let index = 0; index + 1 < entries.length; index += 1) {
		const fact = parseAdjacentFact(entries[index], entries[index + 1]);
		if (fact === null) continue;
		facts.push(fact);
		consumedTransitions.add(fact.transition.seq);
	}
	return {
		facts,
		incompleteTransitionSeqs: entries.filter(isExecuteClosure).filter((entry) => !consumedTransitions.has(entry.seq)).map((entry) => entry.seq)
	};
}
/** Validate the candidate closure fact against current state and history. */
function validateScopeClosureBatch(candidates, priorEntries, expectedIteration) {
	const scopeIndexes = candidates.flatMap((entry, index) => entry.kind === "scope:recorded" ? [index] : []);
	const closureIndexes = candidates.flatMap((entry, index) => isExecuteClosure(entry) ? [index] : []);
	if (scopeIndexes.length === 0) return null;
	if (scopeIndexes.length !== 1 || closureIndexes.length !== 1 || scopeIndexes[0] + 1 !== closureIndexes[0]) return {
		code: "SCOPE_RECORDED_BATCH_INVALID",
		detail: {
			reason: "missing_or_non_adjacent_execute_closure",
			scope_indexes: scopeIndexes,
			closure_indexes: closureIndexes
		}
	};
	const fact = parseAdjacentFact(candidates[scopeIndexes[0]], candidates[closureIndexes[0]]);
	if (fact === null) return {
		code: "SCOPE_RECORDED_BATCH_INVALID",
		detail: { reason: "invalid_batch_envelope_or_actor" }
	};
	if (fact.iteration !== expectedIteration) return {
		code: "SCOPE_RECORDED_BATCH_INVALID",
		detail: {
			reason: "iteration_mismatch",
			iteration: fact.iteration,
			expected_iteration: expectedIteration
		}
	};
	if (parseScopeClosureFacts(priorEntries).facts.some((prior) => prior.iteration === expectedIteration)) return {
		code: "SCOPE_RECORDED_ITERATION_DUPLICATE",
		detail: { iteration: expectedIteration }
	};
	return null;
}
function findScopeClosureFact(entries, iteration) {
	return parseScopeClosureFacts(entries).facts.find((fact) => fact.iteration === iteration) ?? null;
}
function buildScopeClosureEntries(actor, iteration, paths, at) {
	return [{
		at,
		actor,
		entry_schema_version: ENTRY_SCHEMA_VERSIONS["scope:recorded"],
		kind: "scope:recorded",
		payload: {
			iteration,
			paths: [...paths]
		}
	}, {
		at,
		actor,
		entry_schema_version: ENTRY_SCHEMA_VERSIONS["event:phase_advanced"],
		kind: "event:phase_advanced",
		payload: {
			from: "EXECUTE.work",
			to: "EXECUTE.done"
		}
	}];
}
//#endregion
//#region src/core/journal-mutate.ts
function classifyCommitState(result, dryRun) {
	if (result.commit_state !== void 0) return result;
	if (result.ok) return {
		...result,
		commit_state: dryRun ? "not-committed" : "committed"
	};
	return {
		...result,
		commit_state: "not-committed"
	};
}
async function mutateBatch(partials, ctx) {
	if (partials.length === 0) return classifyCommitState({
		ok: false,
		code: "INVALID_BATCH",
		detail: { partials_length: 0 }
	}, ctx.dryRun ?? false);
	return withMutationLease(ctx, () => mutateBatchUnderLease(partials, ctx));
}
/**
* Plan journal-ready entries while holding the feature lease. The planner sees
* the caller's snapshot; the normal under-lease tail proof still rejects a
* stale context before append. This is for deterministic allocation whose
* result must be fenced with the eventual write.
*/
async function mutateBatchPlanned(planner, ctx) {
	return withMutationLease(ctx, async () => {
		const plan = await planner(ctx.snapshot);
		if (!plan.ok) return plan;
		return mutateBatchUnderLease(plan.partials, ctx);
	});
}
async function withMutationLease(ctx, operation) {
	if (ctx.dryRun) try {
		await promises.access(ctx.feature_dir);
	} catch (error) {
		if (error.code === "ENOENT") return classifyCommitState(await operation(), ctx.dryRun ?? false);
		throw error;
	}
	let lease;
	try {
		lease = await acquireFeatureWriteLease(ctx.feature_dir, ctx.dryRun ? "mutate:dry-run" : "mutate", ctx.featureLease);
	} catch (error) {
		if (error instanceof FeatureWriteLeaseError) return classifyCommitState({
			ok: false,
			...error.diagnostic
		}, ctx.dryRun ?? false);
		throw error;
	}
	try {
		return classifyCommitState(await operation(), ctx.dryRun ?? false);
	} finally {
		await lease.release();
	}
}
async function mutateBatchUnderLease(partials, ctx) {
	if (partials.length === 0) return {
		ok: false,
		code: "INVALID_BATCH",
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
		const dryRun = admitEntry(snapshotAcc, candidate, { tail_seq: ctx.tail_seq + i });
		if (!dryRun.ok && dryRun.stage === "admission") {
			if (dryRun.code === "NO_SESSION") return {
				ok: false,
				code: "REDUCER_ERROR",
				failed_index: i,
				detail: {
					code: dryRun.code,
					...dryRun.detail
				}
			};
			const { stage: _stage, ...failure } = dryRun;
			return {
				...failure,
				failed_index: i
			};
		}
		if (!dryRun.ok) return {
			ok: false,
			code: "REDUCER_ERROR",
			failed_index: i,
			detail: {
				code: dryRun.code,
				...dryRun.detail
			}
		};
		snapshotAcc = dryRun.snapshot;
		candidates.push(candidate);
	}
	const scopeBatchFailure = validateScopeClosureBatch(candidates, ctx.entries, ctx.snapshot.state?.iteration ?? 1);
	if (scopeBatchFailure) return {
		ok: false,
		...scopeBatchFailure
	};
	if (candidates.some((candidate) => candidate.kind === "event:tasks_planned" || candidate.kind === "event:tasks_amended")) {
		const graphFailure = checkTaskGraph(snapshotAcc.tasks);
		if (graphFailure !== null) return {
			ok: false,
			...graphFailure
		};
	}
	const gateApprovals = candidates.filter((c) => c.kind === "gate:decided" && c.payload.decision === "approved");
	if (gateApprovals.length > 1) return {
		ok: false,
		code: "MULTIPLE_GATE_DECISIONS",
		detail: {
			count: gateApprovals.length,
			gate_kinds: gateApprovals.map((c) => c.payload.gate_kind)
		}
	};
	if (gateApprovals.length === 1) {
		const gateKind = gateApprovals[0].payload.gate_kind;
		if (gateKind === "spec-lock") {
			const gateResult = evaluateSpecLockFromSnapshot(ctx.snapshot);
			if (!gateResult.ok) return {
				ok: false,
				code: "GATE_PRECONDITION_VIOLATION",
				detail: {
					gate: "spec-lock",
					failure_count: gateResult.checks.length,
					checks: gateResult.checks
				}
			};
		} else if (gateKind === "verify-accept") {
			const gateResult = evaluateVerifyAccept(ctx.snapshot);
			if (!gateResult.ok) return {
				ok: false,
				code: "GATE_PRECONDITION_VIOLATION",
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
		detail: {
			tail_seq: ctx.tail_seq,
			entries_tail_seq: ctxEntriesTailSeq,
			meta_last_applied_seq: ctx.meta.last_applied_seq,
			empty_prefix_meta_bad: emptyPrefixMetaBad
		}
	};
	try {
		await assertJournalTailMatchesMeta(path.join(ctx.feature_dir, "journal.jsonl"), ctx.meta);
	} catch (error) {
		return {
			ok: false,
			code: "APPEND_ERROR",
			detail: {
				code: error instanceof AppendError ? error.code : error.code ?? "TAIL_READ_FAILED",
				...error instanceof AppendError ? error.detail ?? {} : {},
				cause: error instanceof AppendError ? error.message : String(error),
				phase: "lease-tail-check"
			}
		};
	}
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
			failed_index: i,
			detail: { err: String(err) }
		};
	}
	let finalSnapshot = structuredClone(ctx.snapshot);
	for (let i = 0; i < promoted.length; i++) {
		const entry = promoted[i];
		const dryRun = admitEntry(finalSnapshot, entry, { tail_seq: ctx.tail_seq + i });
		if (!dryRun.ok && dryRun.code === "NO_SESSION") return {
			ok: false,
			code: "REDUCER_ERROR",
			failed_index: i,
			detail: {
				code: dryRun.code,
				...dryRun.detail
			}
		};
		if (!dryRun.ok) return {
			ok: false,
			code: "REDUCER_ERROR",
			failed_index: i,
			detail: {
				code: dryRun.code,
				phase: "post-sidecar",
				...dryRun.detail
			}
		};
		finalSnapshot = dryRun.snapshot;
	}
	if (!isDeepStrictEqual(finalSnapshot, snapshotAcc)) return {
		ok: false,
		code: "REDUCER_ERROR",
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
			detail: {
				code: err.code,
				...err.detail ?? {},
				cause: err.message
			}
		};
		return {
			ok: false,
			code: "APPEND_ERROR",
			detail: { err: String(err) }
		};
	}
	if (promoted.some((entry) => SPEC_EMITTING_KINDS.has(entry.kind))) try {
		await writeDerivedSpecMd(finalSnapshot, ctx.feature_dir);
	} catch (err) {
		const lastSeq = promoted[promoted.length - 1].seq;
		return {
			ok: false,
			commit_state: "committed",
			code: "PROJECTION_WRITE_FAILED",
			snapshot: finalSnapshot,
			entries: promoted,
			meta: appendMeta,
			detail: {
				projection: "spec.md",
				path: path.join(ctx.feature_dir, "spec.md"),
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
			commit_state: "committed",
			code: "PROJECTION_WRITE_FAILED",
			snapshot: finalSnapshot,
			entries: promoted,
			meta: appendMeta,
			detail: {
				projection: "snapshots",
				path: path.join(ctx.feature_dir, "snapshots"),
				last_seq: lastSeq,
				error: err.message,
				spec_version: finalSnapshot.state?.spec_version ?? null
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
				commit_state: "committed",
				code: "PROJECTION_WRITE_FAILED",
				snapshot: finalSnapshot,
				entries: promoted,
				meta: appendMeta,
				detail: {
					projection: "registry",
					last_seq: promoted[promoted.length - 1].seq,
					spec_version: finalSnapshot.state?.spec_version ?? null,
					phase: "derivation",
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
	if (!batch.ok) {
		if (batch.commit_state === "committed") {
			const { entries, ...failure } = batch;
			return {
				...failure,
				entry: entries[0]
			};
		}
		return batch;
	}
	return {
		ok: true,
		commit_state: batch.commit_state,
		snapshot: batch.snapshot,
		entry: batch.entries[0],
		meta: batch.meta
	};
}
//#endregion
//#region src/core/scope-projection.ts
function parseCanonicalPathsText(text) {
	const decoded = JSON.parse(text);
	const paths = CanonicalScopePaths.parse(decoded);
	if (text !== JSON.stringify(paths)) throw new Error("scope paths sidecar is not canonical JSON");
	return paths;
}
async function resolveScopePaths(entry, featureDir) {
	const payload = ScopeRecordedPayload.parse(entry.payload);
	if (Array.isArray(payload.paths)) return payload.paths;
	if (payload.paths.mode === "inline") return parseCanonicalPathsText(payload.paths.text);
	return parseCanonicalPathsText((await readAttachment(featureDir, entry, "paths", payload.paths.ref)).toString("utf8"));
}
//#endregion
//#region src/core/scope-track.ts
function isContained(root, target) {
	const relative = path.relative(root, target);
	return relative === "" || !relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative);
}
async function realpathWithMissingSuffix(absolute) {
	const suffix = [];
	let candidate = absolute;
	while (true) try {
		const existing = await promises.realpath(candidate);
		return path.resolve(existing, ...suffix);
	} catch (error) {
		if (error.code !== "ENOENT") throw error;
		const parent = path.dirname(candidate);
		if (parent === candidate) throw error;
		suffix.unshift(path.basename(candidate));
		candidate = parent;
	}
}
/** Resolve a hook path to the canonical repo-relative POSIX audit path. */
async function normalizeScopePath(targetPath, repoRoot) {
	const lexicalRoot = path.resolve(repoRoot);
	const canonicalRoot = await promises.realpath(lexicalRoot);
	const requested = path.isAbsolute(targetPath) ? path.resolve(targetPath) : path.resolve(lexicalRoot, targetPath);
	if (!isContained(lexicalRoot, requested) && !isContained(canonicalRoot, requested)) return {
		ok: false,
		reason: "outside_repo_root",
		path: targetPath
	};
	const canonicalTarget = await realpathWithMissingSuffix(requested);
	if (!isContained(canonicalRoot, canonicalTarget)) return {
		ok: false,
		reason: "outside_repo_root",
		path: targetPath
	};
	const relative = path.relative(canonicalRoot, canonicalTarget).split(path.sep).join("/");
	if (relative === ".loaf" || relative.startsWith(".loaf/")) return {
		ok: true,
		kind: "internal",
		path: relative
	};
	const parsed = ScopePath.safeParse(relative);
	if (!parsed.success) return {
		ok: false,
		reason: "invalid_scope_path",
		path: relative
	};
	return {
		ok: true,
		kind: "scope",
		path: parsed.data
	};
}
//#endregion
//#region src/core/pending-scope.ts
function runtimeOrInitial(current, identity, debug, heartbeatAt) {
	return current ?? {
		schema_version: 2,
		session_id: identity.session_id,
		cwd: identity.cwd,
		debug,
		heartbeat_at: heartbeatAt,
		pending_scope: null
	};
}
/** Normalize and accumulate a PostToolUse path, publishing heartbeat even on
* path rejection. Storage failures propagate before the caller renders that
* rejection; the lock still owns the complete read-modify-write operation. */
async function trackPendingScope(options) {
	let normalized;
	try {
		normalized = await normalizeScopePath(options.targetPath, options.identity.cwd);
	} catch {
		normalized = {
			ok: false,
			reason: "invalid_scope_path",
			path: options.targetPath
		};
	}
	const heartbeatAt = options.runtime.now().toISOString();
	await withRuntimeLock(options.identity, "scope-track", async (current) => {
		const base = runtimeOrInitial(current, options.identity, options.debug, heartbeatAt);
		if (!normalized.ok || normalized.kind === "internal" || options.cursor.sub_state !== "EXECUTE.work") return {
			...base,
			heartbeat_at: heartbeatAt
		};
		const pending = base.pending_scope;
		let carriedPaths = [];
		if (pending !== null && pending.iteration === options.cursor.iteration) carriedPaths = pending.paths;
		else if (pending !== null && pending.iteration < options.cursor.iteration) {
			const history = await loadSession(options.featureDir, { ensureDir: false });
			if (history.snapshot.state?.session_id !== options.identity.session_id) throw new Error("scope-track history does not match the selected session identity");
			carriedPaths = await uncoveredPendingPaths(pending, {
				entries: history.entries,
				featureDir: options.featureDir
			});
		}
		const paths = new Set(carriedPaths);
		paths.add(normalized.path);
		return {
			...base,
			heartbeat_at: heartbeatAt,
			pending_scope: {
				iteration: options.cursor.iteration,
				paths: [...paths].sort(compareScopePathBytes)
			}
		};
	}, options.runtime);
	return normalized;
}
async function uncoveredPendingPaths(pending, context) {
	const scope = findScopeClosureFact(context.entries, pending.iteration)?.scope;
	if (scope === void 0) return [...pending.paths];
	const recorded = new Set(await resolveScopePaths(scope, context.featureDir));
	return pending.paths.filter((scopePath) => !recorded.has(scopePath));
}
async function pendingIsCovered(pending, context) {
	const scope = findScopeClosureFact(context.entries, pending.iteration)?.scope;
	if (scope === void 0) return false;
	const recorded = new Set(await resolveScopePaths(scope, context.featureDir));
	return pending.paths.every((scopePath) => recorded.has(scopePath));
}
/** Select closure paths without writing runtime or acquiring a lock. Older
* pending scope carries only paths absent from its own iteration's closure. */
async function preparePendingScopeClosure(current, context) {
	const runtime = runtimeOrInitial(current, context.identity, context.debug, context.heartbeatAt);
	const pending = runtime.pending_scope;
	if (pending === null) return {
		ok: true,
		runtime,
		paths: []
	};
	if (pending.iteration === context.iteration) return {
		ok: true,
		runtime,
		paths: [...pending.paths]
	};
	if (pending.iteration > context.iteration) return {
		ok: false,
		failure: {
			code: "EXECUTE_CLOSURE_STATE_CHANGED",
			detail: {
				reason: "pending_iteration_ahead",
				pending_iteration: pending.iteration,
				current_iteration: context.iteration
			}
		}
	};
	return {
		ok: true,
		runtime,
		paths: await uncoveredPendingPaths(pending, context)
	};
}
async function settlePendingScope(current, context, phase) {
	const runtime = runtimeOrInitial(current, context.identity, context.debug, context.heartbeatAt);
	const pending = runtime.pending_scope;
	if (phase === "recovered" && pending !== null && pending.iteration > context.iteration) return {
		ok: false,
		failure: {
			code: "EXECUTE_CLOSURE_STATE_CHANGED",
			detail: {
				reason: "pending_iteration_ahead",
				pending_iteration: pending.iteration,
				iteration: context.iteration
			}
		}
	};
	if (phase === "committed" || pending === null || await pendingIsCovered(pending, context)) return {
		ok: true,
		runtime: {
			...runtime,
			heartbeat_at: context.heartbeatAt,
			pending_scope: null
		}
	};
	if (phase === "committed-failure") return {
		ok: false,
		failure: {
			code: "EXECUTE_CLOSURE_COMMIT_AMBIGUOUS",
			detail: {
				reason: "pending_paths_not_covered",
				iteration: context.iteration
			}
		}
	};
	return {
		ok: true,
		runtime: {
			...runtime,
			heartbeat_at: context.heartbeatAt
		}
	};
}
//#endregion
//#region src/core/execute-closure.ts
var ClosureNotCommitted = class extends Error {};
var ExecuteClosureError = class extends Error {
	failure;
	constructor(failure, options) {
		super(failure.code, options);
		this.failure = failure;
		this.name = "ExecuteClosureError";
	}
	get code() {
		return this.failure.code;
	}
	get detail() {
		return this.failure.detail;
	}
};
async function reloadForCommitProof(featureDir, loader = (target) => loadSession(target, { ensureDir: false })) {
	try {
		return await loader(featureDir);
	} catch (error) {
		throw new ExecuteClosureError({
			code: "EXECUTE_CLOSURE_RELOAD_FAILED",
			detail: {
				feature_dir: featureDir,
				cause: error.message
			}
		}, { cause: error });
	}
}
/**
* Close one EXECUTE iteration while holding runtime state over the journal
* commit. Lock order is runtime first, feature second (inside mutateBatch).
* Ordinary journal mutators never acquire the runtime lock, so no reverse
* edge exists and the two-lock dependency graph stays acyclic.
*/
async function executeClosureTransaction(options) {
	const initialState = options.session.snapshot.state;
	if (initialState == null) return { kind: "not-committed" };
	if (options.mutateContext(options.session).dryRun) {
		if (initialState.sub_state !== "EXECUTE.work") return { kind: "not-committed" };
		const heartbeatAt = options.runtime.now().toISOString();
		const prepared = await preparePendingScopeClosure(await readSessionRuntimeFile(options.identity, options.runtime), {
			identity: options.identity,
			debug: options.debug,
			heartbeatAt,
			iteration: initialState.iteration,
			entries: options.session.entries,
			featureDir: options.featureDir
		});
		if (!prepared.ok) throw new ExecuteClosureError(prepared.failure);
		const result = await mutateBatch(buildScopeClosureEntries(options.actor, initialState.iteration, prepared.paths, heartbeatAt), options.mutateContext(options.session));
		return result.ok ? {
			kind: "committed",
			result,
			from: "EXECUTE.work"
		} : {
			kind: "failure",
			failure: result
		};
	}
	let outcome = null;
	const heartbeatAt = options.runtime.now().toISOString();
	try {
		await withRuntimeLock(options.identity, "execute-closure", async (current) => {
			const session = await reloadForCommitProof(options.featureDir, options.hooks?.reloadSession);
			const state = session.snapshot.state;
			if (state == null) throw new ClosureNotCommitted();
			const context = {
				identity: options.identity,
				debug: options.debug,
				heartbeatAt,
				iteration: state.iteration,
				entries: session.entries,
				featureDir: options.featureDir
			};
			const committed = findScopeClosureFact(session.entries, state.iteration);
			if (state.sub_state === "EXECUTE.done" && committed !== null) {
				const settled = await settlePendingScope(current, context, "recovered");
				if (!settled.ok) throw new ExecuteClosureError(settled.failure);
				outcome = {
					kind: "recovered",
					session,
					from: "EXECUTE.work"
				};
				return settled.runtime;
			}
			if (state.sub_state === "EXECUTE.done") throw new ClosureNotCommitted();
			if (state.sub_state !== "EXECUTE.work") throw new ExecuteClosureError({
				code: "EXECUTE_CLOSURE_STATE_CHANGED",
				detail: {
					expected: "EXECUTE.work",
					actual: state.sub_state
				}
			});
			const prepared = await preparePendingScopeClosure(current, context);
			if (!prepared.ok) throw new ExecuteClosureError(prepared.failure);
			await options.hooks?.beforeAppend?.();
			const result = await mutateBatch(buildScopeClosureEntries(options.actor, state.iteration, prepared.paths, heartbeatAt), options.mutateContext(session));
			if (result.ok) {
				outcome = {
					kind: "committed",
					result,
					from: "EXECUTE.work"
				};
				await options.hooks?.afterCommitBeforeClear?.();
				return (await settlePendingScope(prepared.runtime, context, "committed")).runtime;
			}
			if (result.commit_state === "committed") {
				const committedEntries = session.entries.concat(result.entries);
				if (findScopeClosureFact(committedEntries, state.iteration) !== null) {
					const settled = await settlePendingScope(prepared.runtime, {
						...context,
						entries: committedEntries
					}, "committed-failure");
					if (!settled.ok) throw new ExecuteClosureError(settled.failure);
					outcome = {
						kind: "failure",
						failure: result
					};
					await options.hooks?.afterCommitBeforeClear?.();
					return settled.runtime;
				}
			}
			outcome = {
				kind: "failure",
				failure: result
			};
			return prepared.runtime;
		}, options.runtime);
	} catch (error) {
		if (error instanceof ClosureNotCommitted) return { kind: "not-committed" };
		throw error;
	}
	if (outcome === null) throw new Error("internal invariant: EXECUTE closure transaction produced no outcome");
	return outcome;
}
//#endregion
//#region src/cli/command-mutator.ts
function createCommandMutator(ctx, deps) {
	const registryWriterDeps = deps.registryWriter;
	const createMutationContext = (featureDir, session) => ({
		feature_dir: featureDir,
		snapshot: session.snapshot,
		tail_seq: session.tail_seq,
		entries: session.entries,
		meta: session.meta,
		dryRun: ctx.dryRun,
		registryWriter: registryWriterDeps
	});
	const emitDryRunSuccess = (result) => {
		const kind = "entry" in result ? result.entry.kind : result.entries[0]?.kind ?? "(empty)";
		ctx.success({
			ok: true,
			dry_run: true,
			would: { kind }
		}, () => `dry-run: would ${kind}\n`);
	};
	function acceptResult(result) {
		if (!result.ok) {
			ctx.failure(result);
			return null;
		}
		if (result.commit_state === "not-committed") {
			emitDryRunSuccess(result);
			return null;
		}
		return result;
	}
	async function runImpl(featureDir, session, input) {
		const now = (/* @__PURE__ */ new Date()).toISOString();
		const stamp = (e) => ({
			at: now,
			actor: e.actor,
			entry_schema_version: ENTRY_SCHEMA_VERSIONS[e.kind],
			kind: e.kind,
			payload: e.payload
		});
		const mctx = createMutationContext(featureDir, session);
		return acceptResult(Array.isArray(input) ? await mutateBatch(input.map(stamp), mctx) : await mutate(stamp(input), mctx));
	}
	async function runBatch(featureDir, session, entries, options) {
		const sharedAt = options.timestamps === "shared" ? (/* @__PURE__ */ new Date()).toISOString() : void 0;
		return runPreparedBatch(featureDir, session, entries.map((entry) => ({
			at: sharedAt ?? (/* @__PURE__ */ new Date()).toISOString(),
			actor: entry.actor,
			entry_schema_version: ENTRY_SCHEMA_VERSIONS[entry.kind],
			kind: entry.kind,
			payload: entry.payload
		})));
	}
	async function runPreparedBatch(featureDir, session, entries) {
		return acceptResult(await mutateBatch([...entries], createMutationContext(featureDir, session)));
	}
	async function runPlannedBatch(featureDir, session, planner, options = {}) {
		return acceptResult(await mutateBatchPlanned(async (snapshot) => {
			const plan = await planner(snapshot);
			if (!plan.ok) return plan;
			const sharedAt = (options.timestamps ?? "shared") === "shared" ? (/* @__PURE__ */ new Date()).toISOString() : void 0;
			return {
				ok: true,
				partials: plan.entries.map((entry) => ({
					at: sharedAt ?? (/* @__PURE__ */ new Date()).toISOString(),
					actor: entry.actor,
					entry_schema_version: ENTRY_SCHEMA_VERSIONS[entry.kind],
					kind: entry.kind,
					payload: entry.payload
				}))
			};
		}, createMutationContext(featureDir, session)));
	}
	async function runExecuteClosure(options) {
		const closure = await executeClosureTransaction({
			...options,
			mutateContext: (session) => createMutationContext(options.featureDir, session)
		});
		if (closure.kind === "failure") {
			acceptResult(closure.failure);
			return null;
		}
		if (closure.kind === "committed" && acceptResult(closure.result) === null) return null;
		return closure;
	}
	return {
		run: runImpl,
		runBatch,
		runPreparedBatch,
		runPlannedBatch,
		runExecuteClosure
	};
}
z.discriminatedUnion("kind", [
	z.object({ kind: z.literal("stdin") }),
	z.object({
		kind: z.literal("inline"),
		value: z.string()
	}),
	z.object({
		kind: z.literal("file"),
		path: z.string()
	})
]);
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
function jsonInputHelp(declaration) {
	if (declaration.helpText !== void 0) return declaration.helpText;
	return `${declaration.helpPrefix}: \`-\` (stdin), ${declaration.inlineLabel}, or file path${declaration.helpSuffix ?? ""}`;
}
function createJsonInputIngestor(deps) {
	const readFile = deps.readFile ?? ((filePath) => promises.readFile(filePath, "utf8"));
	const requireArg = (ctx, arg, declaration) => {
		if (arg !== void 0) return true;
		ctx.failure({
			code: "MISSING_INPUT",
			detail: { command: declaration.command }
		});
		return false;
	};
	return {
		requireArg,
		async readJson(ctx, arg, declaration) {
			if (!requireArg(ctx, arg, declaration)) return { ok: false };
			const source = parseInputSource(arg);
			if (source.kind === "stdin" && deps.isStdinTty()) {
				ctx.failure({
					code: "USAGE",
					detail: {
						command: declaration.command,
						source: "stdin",
						reason: "stdin_is_tty"
					}
				});
				return { ok: false };
			}
			let raw;
			if (source.kind === "inline") raw = source.value;
			else if (source.kind === "stdin") try {
				raw = await deps.readStdin();
			} catch (error) {
				const message = error.message;
				ctx.failure({
					code: "MISSING_INPUT",
					detail: {
						command: declaration.command,
						source: "stdin",
						cause: message
					}
				});
				return { ok: false };
			}
			else try {
				raw = await readFile(source.path);
			} catch (error) {
				const cause = error;
				ctx.failure({
					code: "INPUT_FILE_NOT_FOUND",
					detail: {
						path: source.path,
						...cause.code === "ENOENT" ? {} : { cause: cause.message }
					}
				});
				return { ok: false };
			}
			try {
				return {
					ok: true,
					value: JSON.parse(raw)
				};
			} catch (error) {
				const cause = error.message;
				ctx.failure({
					code: "SCHEMA_VALIDATION_FAILED",
					detail: {
						reason: cause,
						command: declaration.command,
						cause
					}
				});
				return { ok: false };
			}
		}
	};
}
//#endregion
//#region src/cli/tui/render.ts
async function defaultRenderTui(app) {
	const { render } = await import("ink");
	await render(app).waitUntilExit();
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
//#region src/cli/runtime-store-diagnostic.ts
/** Preserve the established CLI mapping for runtime status errors. */
function runtimeStoreDiagnostic(error, source) {
	const detail = {
		source,
		runtime_code: error.code,
		reason: error.message,
		...error.holder !== void 0 && { holder: error.holder }
	};
	if (error.code === "RUNTIME_LOCK_TIMEOUT" || error.code === "RUNTIME_LOCK_INVALID") return {
		code: "LOCK_TIMEOUT",
		detail: {
			...detail,
			...error.lockDetail,
			timeout_seconds: error.lockDetail.timeout_seconds
		}
	};
	return {
		code: "SCHEMA_VALIDATION_FAILED",
		detail
	};
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
const VERIFY_CHECK_KIND_KEYS = {
	run: "verify_check_kind.run",
	review: "verify_check_kind.review",
	acceptance: "verify_check_kind.acceptance",
	visual: "verify_check_kind.visual"
};
const APPLICABILITY_KEYS = {
	must: "applicability.must",
	optional: "applicability.optional",
	na: "applicability.na"
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
	"SETTLE.lessons": "sub_state.SETTLE.lessons",
	"DONE.delivered": "sub_state.DONE.delivered",
	"DONE.archived": "sub_state.DONE.archived",
	"DONE.abandoned": "sub_state.DONE.abandoned"
};
const DIAGNOSTIC_KEYS = [...Object.keys(ERROR_CATALOG).flatMap((code) => [`diagnostic.${code}`, `diagnostic_fix.${code}`]), ...Object.keys(DIAGNOSTIC_VARIANTS).flatMap((context) => [`diagnostic_variant.${context}`, `diagnostic_variant_fix.${context}`])];
const SUCCESS_KEYS = {
	nextFullCommandPointer: "success.next.full_command_pointer",
	nextDeliver: "success.next.deliver",
	nextSettle: "success.next.settle",
	nextSettleLessons: "success.next.settle_lessons",
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
	specEditInputStateChange: "success.spec.edit_input_state_change",
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
	journalListRow: "chrome.journal.list_row",
	journalListRowBatch: "chrome.journal.list_row_batch",
	journalListEmpty: "chrome.journal.list_empty",
	evidenceListRow: "chrome.evidence.list_row",
	evidenceListEmpty: "chrome.evidence.list_empty",
	evidenceCompatibilityWarning: "chrome.evidence.compatibility_warning",
	specStatusPass: "chrome.spec_status.pass",
	specStatusFailureRow: "chrome.spec_status.failure_row",
	specStatusSuppressedRow: "chrome.spec_status.suppressed_row",
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
	verifyStatusCheckDeferredFindings: "chrome.verify_status.check_deferred_findings",
	verifyStatusInfo: "chrome.verify_status.info",
	verifyStatusDeferredSummary: "chrome.verify_status.deferred_summary",
	verifyStatusFailureSummaryOne: "chrome.verify_status.failure_summary_one",
	verifyStatusFailureSummaryMany: "chrome.verify_status.failure_summary_many",
	verifyStatusDiagnosticOnly: "chrome.verify_status.diagnostic_only",
	verifyStatusLaneLabel: "chrome.verify_status.lane_label",
	verifyStatusLaneReason: "chrome.verify_status.lane_reason",
	verifyStatusLaneReasonNoDoneTasks: "chrome.verify_status.lane_reason_no_done_tasks",
	verifyStatusLaneReasonNoReviewObligations: "chrome.verify_status.lane_reason_no_review_obligations",
	verifyStatusLaneReasonNoE2eScenarios: "chrome.verify_status.lane_reason_no_e2e_scenarios",
	verifyStatusLaneReasonNoVisualContracts: "chrome.verify_status.lane_reason_no_visual_contracts",
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
	...Object.values(VERIFY_CHECK_KIND_KEYS),
	...Object.values(APPLICABILITY_KEYS),
	...Object.values(FINDING_CATEGORY_KEYS),
	...Object.values(FINDING_ACTION_KEYS),
	...Object.values(FINDING_STATUS_KEYS),
	...Object.values(PENDING_KIND_KEYS),
	...Object.values(PHASE_KEYS),
	...Object.values(SUB_STATE_KEYS),
	...Object.values(DIAGNOSTIC_KEYS),
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
function verifyCheckKindKey(kind) {
	return VERIFY_CHECK_KIND_KEYS[kind];
}
function applicabilityKey(applicability) {
	return APPLICABILITY_KEYS[applicability];
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
}).strict().refine((output) => output.terminal || output.next_action !== void 0, { message: "next_action is required for non-terminal states" }).refine((output) => !output.terminal || output.next_action === void 0, { message: "next_action is omitted iff terminal=true" });
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
		const intervention = pendingResolutionOwner(head.kind, gateNameForCursor(input.sub_state));
		switch (intervention.owner) {
			case "gate decide": return buildGateDecideAction(intervention.gate);
			case "profile escalate": return profileEscalateAction();
			case "pending resolve": return pendingResolveAction(head);
		}
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
//#endregion
//#region src/cli/next-advisory.ts
function pendingKindsForNext(pending) {
	return pending.map(({ kind }) => ({ kind: PendingPromptKind.parse(kind) }));
}
function shellQuote(value) {
	if (/^[A-Za-z0-9_./:@%+=,-]+$/.test(value)) return value;
	return `'${value.replaceAll("'", `'\"'\"'`)}'`;
}
function appendSelector(command, selector) {
	const scoped = `${command} --${selector.kind} ${shellQuote(selector.value)}`;
	return selector.kind === "feature-dir" ? `${command} --feature ${shellQuote(selector.feature)} --feature-dir ${shellQuote(selector.value)}` : scoped;
}
function selectorForFeature(feature, featureDir, explicitFeatureDir) {
	return explicitFeatureDir ? {
		kind: "feature-dir",
		value: featureDir,
		feature
	} : {
		kind: "feature",
		value: feature
	};
}
function argvHasFlag(argv, flag) {
	return scanArgv(optionArgv(argv)).some((token) => token.kind === "option" && token.flag === flag);
}
function selectorForDispatch(dispatch, argv) {
	if (dispatch.source === "session-flag" || dispatch.source === "session-env") {
		if (dispatch.sessionId === null) throw new Error(`session dispatch source ${dispatch.source} has no canonical session id`);
		return {
			kind: "session",
			value: dispatch.sessionId
		};
	}
	return selectorForFeature(dispatch.feature, dispatch.featureDir, argvHasFlag(argv, "--feature-dir"));
}
async function selectorForCommandContext(ctx) {
	const dispatch = await ctx.resolveDispatch();
	if (!dispatch.ok) throw new Error(`next advisory requested after failed dispatch: ${dispatch.code}`);
	return selectorForDispatch(dispatch, ctx.argv);
}
function buildScopedNextOutput(input, selector) {
	const output = buildNextOutput(input);
	if (output.next_action === void 0) return output;
	return {
		...output,
		next_action: {
			...output.next_action,
			command: appendSelector(output.next_action.command, selector)
		}
	};
}
function nextInputFromSnapshot(snapshot, featureDir) {
	const state = snapshot.state;
	if (state === null) return null;
	return {
		feature: state.feature,
		feature_dir: featureDir,
		phase: state.phase,
		sub_state: state.sub_state,
		ceremony: state.ceremony,
		spec_locked: state.spec_locked,
		verify_accepted: state.verify_accepted,
		pending: pendingKindsForNext(snapshot.pending)
	};
}
/**
* Render a copy-pasteable next hint without owning workflow routing.
* `buildNextOutput` remains the sole routing authority. Blocking actions may
* require human-provided arguments, so those point to the scoped JSON query
* instead of advertising an unsafe placeholder command as runnable.
*/
function buildNextAdvisory(i18n, input, selector) {
	const output = buildScopedNextOutput(input, selector);
	if (output.next_action === void 0) return void 0;
	if (!output.next_action.blocking) return output.next_action.command;
	const command = `${appendSelector("loaf next", selector)} --format json`;
	return i18n.t(SUCCESS_KEYS.nextFullCommandPointer, { command });
}
function buildNextAdvisoryFromSnapshot(i18n, snapshot, featureDir, selector) {
	const input = nextInputFromSnapshot(snapshot, featureDir);
	return input === null ? void 0 : buildNextAdvisory(i18n, input, selector);
}
function nextCommandFromSnapshot(snapshot, featureDir, selector) {
	const input = nextInputFromSnapshot(snapshot, featureDir);
	if (input === null) return void 0;
	return buildScopedNextOutput(input, selector).next_action?.command;
}
//#endregion
//#region src/cli/commands/lifecycle.tsx
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
function registerLifecycle(program, ctx, mutator, actor, runtimeDir, runtimeNow, executeClosureHooks) {
	declareCommandPolicy(program.command("start <feature>").description("Start a new feature session (emits session:started)").option("--ceremony <preset>", "Preset label: quick / light / standard / deep", "standard").option("--label <text>", "Human-readable session label (≥3 chars)").option("--workspace <name>", "Workspace name (multi-worktree display)", "default").option("--feature-dir <path>", "Override default .loaf/<feature> directory"), {
		selectors: "start",
		dryRun: "mutating"
	}).action(async (feature, opts) => {
		const ceremony = PRESETS[opts.ceremony];
		if (!ceremony) {
			ctx.failure(diagnostic$2("INVALID_PRESET", {}));
			return;
		}
		if (opts.label !== void 0 && opts.label.length < 3) {
			ctx.failure(diagnosticVariant("failure.start.label_too_short", {
				min_length: 3,
				min_length: 3,
				actual_length: opts.label.length
			}));
			return;
		}
		if (opts.workspace.length < 1) {
			ctx.failure(diagnosticVariant("failure.start.workspace_empty", {}));
			return;
		}
		const featureDir = opts.featureDir ?? defaultFeatureDir(feature);
		ctx.recordTraceTarget(feature, featureDir);
		const session = await loadSession(featureDir, { ensureDir: !ctx.dryRun });
		const sessionId = crypto.randomUUID();
		const result = await mutator.run(featureDir, session, {
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
		});
		if (!result) return;
		const state = result.snapshot.state;
		if (state === null) {
			ctx.failure(diagnostic$2("REDUCER_ERROR", {}));
			return;
		}
		const out = {
			ok: true,
			feature,
			session_id: sessionId,
			ceremony_label: opts.ceremony,
			workspace: opts.workspace,
			feature_dir: featureDir,
			sub_state: state.sub_state
		};
		ctx.success(out, () => `${sessionId}\n`, (i18n) => {
			const next = buildNextAdvisoryFromSnapshot(i18n, result.snapshot, featureDir, selectorForFeature(state.feature, featureDir, opts.featureDir !== void 0));
			return {
				stateChange: i18n.t(SUCCESS_KEYS.startStateChange, { feature }),
				...next === void 0 ? {} : { next }
			};
		});
	});
	declareCommandPolicy(program.command("advance <to>").description("Advance the session cursor (emits event:phase_advanced)").option("--feature <name>", "Feature whose session to advance").option("--feature-dir <path>", "Override default .loaf/<feature> directory"), {
		selectors: "selected",
		dryRun: "mutating"
	}).action(async (to, opts) => {
		const featureDir = await ctx.dispatchOrFail(opts);
		if (featureDir === null) return;
		const selector = await selectorForCommandContext(ctx);
		const session = await loadSession(featureDir, { ensureDir: !ctx.dryRun });
		const from = session.snapshot.state?.sub_state;
		if (!from) {
			ctx.failure(diagnosticVariant("failure.no_session.advance", { feature: opts.feature }));
			return;
		}
		if (to === "EXECUTE.done" && (from === "EXECUTE.work" || from === "EXECUTE.done")) {
			const state = session.snapshot.state;
			const repoRoot = path.dirname(path.dirname(featureDir));
			try {
				const closure = await mutator.runExecuteClosure({
					featureDir,
					session,
					actor,
					identity: {
						session_id: state.session_id,
						cwd: repoRoot
					},
					runtime: {
						runtimeDir,
						now: runtimeNow
					},
					debug: ctx.debug,
					...executeClosureHooks !== void 0 && { hooks: executeClosureHooks }
				});
				if (closure === null) return;
				if (closure.kind !== "not-committed") {
					const snapshot = closure.kind === "committed" ? closure.result.snapshot : closure.session.snapshot;
					const out = {
						ok: true,
						from: closure.from,
						to,
						sub_state: snapshot.state?.sub_state
					};
					ctx.success(out, () => "", (i18n) => {
						const next = buildNextAdvisoryFromSnapshot(i18n, snapshot, featureDir, selector);
						return {
							stateChange: i18n.t(SUCCESS_KEYS.advanceStateChange, {
								from: closure.from,
								to
							}),
							...next === void 0 ? {} : { next }
						};
					});
					return;
				}
			} catch (error) {
				if (!(error instanceof RuntimeStoreError && error.code.startsWith("RUNTIME_LOCK_")) && !(error instanceof ExecuteClosureError)) throw error;
				if (error instanceof ExecuteClosureError) ctx.failure({
					code: "SCHEMA_VALIDATION_FAILED",
					detail: {
						source: "execute-closure",
						closure_code: error.code,
						reason: error.code,
						...error.detail
					}
				});
				else ctx.failure(runtimeStoreDiagnostic(error, "execute-closure"));
				return;
			}
		}
		const result = await mutator.run(featureDir, session, {
			kind: "event:phase_advanced",
			payload: {
				from,
				to
			},
			actor
		});
		if (!result) return;
		const out = {
			ok: true,
			from,
			to,
			sub_state: result.snapshot.state?.sub_state
		};
		ctx.success(out, () => "", (i18n) => {
			const next = buildNextAdvisoryFromSnapshot(i18n, result.snapshot, featureDir, selector);
			return {
				stateChange: i18n.t(SUCCESS_KEYS.advanceStateChange, {
					from,
					to
				}),
				...next === void 0 ? {} : { next }
			};
		});
	});
	declareCommandPolicy(program.command("status").description("Show the current session snapshot (read-only)").option("--feature <name>", "Feature whose status to show").option("--feature-dir <path>", "Override default .loaf/<feature> directory"), {
		selectors: "selected",
		dryRun: "read-only"
	}).action(async (opts) => {
		const featureDir = await ctx.dispatchOrFail(opts);
		if (featureDir === null) return;
		const loaded = await ctx.loadProjectionsOrFail(featureDir, [
			"state",
			"tasks",
			"evidence",
			"findings",
			"pending"
		], opts.feature, "failure.no_session.status");
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
	declareCommandPolicy(program.command("next").description("Compute the next owner command for the current session (read-only)").option("--feature <name>", "Feature whose next action to compute").option("--feature-dir <path>", "Override default .loaf/<feature> directory"), {
		selectors: "selected",
		dryRun: "read-only"
	}).action(async (opts) => {
		const featureDir = await ctx.dispatchOrFail(opts);
		if (featureDir === null) return;
		const selector = await selectorForCommandContext(ctx);
		const loaded = await ctx.loadProjectionsOrFail(featureDir, [
			"state",
			"tasks",
			"pending"
		], opts.feature, "failure.no_session.status");
		if (loaded === null) return;
		let verifyApplicableLanes;
		if (loaded.state.sub_state.startsWith("VERIFY.")) {
			const session = await ctx.resolveSession(featureDir);
			const built = buildSpecFrontmatterFromSnapshot(session.snapshot);
			if (!built.ok) {
				ctx.failure(built);
				return;
			}
			verifyApplicableLanes = deriveVerifyApplicability(session.snapshot, built.frontmatter);
		}
		const out = buildScopedNextOutput({
			feature: opts.feature,
			feature_dir: featureDir,
			phase: loaded.state.phase,
			sub_state: loaded.state.sub_state,
			ceremony: loaded.state.ceremony,
			spec_locked: loaded.state.spec_locked,
			verify_accepted: loaded.state.verify_accepted,
			pending: loaded.state.pending,
			verify_applicable_lanes: verifyApplicableLanes
		}, selector);
		ctx.success(out, () => out.next_action === void 0 ? "" : `${out.next_action.command}\n`);
	});
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
	const effect = findingActionEffect(args.action);
	if (effect.kind === "fix-reset" && args.target !== void 0) return {
		kind: "fix-reset",
		backEdgeTo: effect.target,
		entries: [
			findingRaised,
			{
				kind: "event:task_step_reset",
				payload: {
					task_id: args.target.taskId,
					step: effect.step,
					finding_id: args.findingId
				},
				actor: "cli:loaf"
			},
			{
				kind: "event:phase_advanced",
				payload: {
					from: args.currentSubState,
					to: effect.target,
					back_edge: {
						action: args.action,
						finding_id: args.findingId
					}
				},
				actor: "cli:loaf"
			}
		]
	};
	if (effect.kind === "back-edge") return {
		kind: "back-edge",
		backEdgeTo: effect.target,
		entries: [findingRaised, {
			kind: "event:phase_advanced",
			payload: {
				from: args.currentSubState,
				to: effect.target,
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
//#endregion
//#region src/cli/commands/gate.tsx
function registerGate(program, ctx, mutator, actor) {
	declareCommandPolicy(program.command("gate").description("Gate decision commands (spec-lock + verify-accept)").command("decide <gate-name>").description("Decide a gate (emits gate:decided; spec-lock approve also advances cursor)").option("--approve", "Approve the gate").option("--reject", "Reject the gate").requiredOption("--reason <text>", "Decision rationale (passed through to GateDecidedPayload)").option("--feature <name>", "Feature whose session to gate").option("--feature-dir <path>", "Override default .loaf/<feature> directory"), {
		selectors: "selected",
		dryRun: "mutating"
	}).action(async (gateName, opts) => {
		const approve = opts.approve === true;
		if (approve === (opts.reject === true)) {
			ctx.failure(diagnostic$2("USAGE", { reason: "approval_decision_required" }));
			return;
		}
		if (gateName !== "spec-lock" && gateName !== "verify-accept") {
			ctx.failure(diagnostic$2("GATE_NOT_IMPLEMENTED", { gate: gateName }));
			return;
		}
		const humanActor = ctx.resolveHumanActorOrFail();
		if (humanActor === null) return;
		const featureDir = await ctx.dispatchOrFail(opts);
		if (featureDir === null) return;
		const session = await loadSession(featureDir, { ensureDir: !ctx.dryRun });
		const from = session.snapshot.state?.sub_state;
		if (!from) {
			ctx.failure(diagnosticVariant("failure.no_session.generic", { feature: opts.feature }));
			return;
		}
		const pendingPlan = planGatePending(session.snapshot.pending, gateName, approve ? "approved" : "rejected");
		const pendingHead = pendingPlan.ok ? pendingPlan.resolutionHead : void 0;
		if (approve) {
			if (gateName === "spec-lock") {
				const result = await mutator.run(featureDir, session, buildGateApprovalBatch({
					gate: "spec-lock",
					reason: opts.reason,
					humanActor,
					cliActor: actor,
					from,
					...pendingHead ? { pendingHeadId: pendingHead.id } : {}
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
				const selector = await selectorForCommandContext(ctx);
				ctx.success(out, () => "", (i18n) => {
					const next = buildNextAdvisoryFromSnapshot(i18n, result.snapshot, featureDir, selector);
					return {
						stateChange: i18n.t(SUCCESS_KEYS.gateSpecLockApprovedStateChange, { actor: humanActor }),
						...next === void 0 ? {} : { next }
					};
				});
				return;
			}
			const result = await mutator.run(featureDir, session, buildGateApprovalBatch({
				gate: "verify-accept",
				reason: opts.reason,
				humanActor,
				cliActor: actor,
				...pendingHead ? { pendingHeadId: pendingHead.id } : {}
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
			const selector = await selectorForCommandContext(ctx);
			ctx.success(out, () => "", (i18n) => {
				const next = buildNextAdvisoryFromSnapshot(i18n, result.snapshot, featureDir, selector);
				return {
					stateChange: i18n.t(SUCCESS_KEYS.gateVerifyAcceptApprovedStateChange, { actor: humanActor }),
					...next === void 0 ? {} : { next }
				};
			});
			return;
		}
		const result = await mutator.run(featureDir, session, {
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
}
//#endregion
//#region src/cli/commands/terminal-execute.tsx
function registerTerminalExecute(program, ctx, mutator, actor) {
	declareCommandPolicy(program.command("deliver").description("Deliver the feature session (emits session:delivered → DONE.delivered)").option("--feature <name>", "Feature whose session to deliver").option("--feature-dir <path>", "Override default .loaf/<feature> directory").option("--reason <text>", "Optional rationale to record on the session:delivered entry"), {
		selectors: "selected",
		dryRun: "mutating"
	}).action(async (opts) => {
		const humanActor = ctx.resolveHumanActorOrFail();
		if (humanActor === null) return;
		const featureDir = await ctx.dispatchOrFail(opts);
		if (featureDir === null) return;
		const session = await ctx.resolveSession(featureDir);
		const from = session.snapshot.state?.sub_state;
		if (!from) {
			ctx.failure(diagnosticVariant("failure.no_session.generic", { feature: opts.feature }));
			return;
		}
		const payload = {};
		if (opts.reason !== void 0) payload["reason"] = opts.reason;
		const result = await mutator.run(featureDir, session, {
			kind: "session:delivered",
			payload,
			actor: humanActor
		});
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
	declareCommandPolicy(program.command("archive").description("Close the feature session without delivering (emits session:archived → DONE.archived)").option("--feature <name>", "Feature whose session to archive").requiredOption("--reason <text>", "Rationale recorded on the session:archived entry").option("--feature-dir <path>", "Override default .loaf/<feature> directory"), {
		selectors: "selected",
		dryRun: "mutating"
	}).action(async (opts) => {
		const humanActor = ctx.resolveHumanActorOrFail();
		if (humanActor === null) return;
		const featureDir = await ctx.dispatchOrFail(opts);
		if (featureDir === null) return;
		const session = await loadSession(featureDir, { ensureDir: !ctx.dryRun });
		const from = session.snapshot.state?.sub_state;
		if (!from) {
			ctx.failure(diagnosticVariant("failure.no_session.generic", { feature: opts.feature }));
			return;
		}
		const result = await mutator.run(featureDir, session, {
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
	declareCommandPolicy(program.command("abandon").description("Abandon the feature session (emits session:abandoned → DONE.abandoned)").option("--feature <name>", "Feature whose session to abandon").requiredOption("--reason <text>", "Rationale recorded on the session:abandoned entry").option("--feature-dir <path>", "Override default .loaf/<feature> directory"), {
		selectors: "selected",
		dryRun: "mutating"
	}).action(async (opts) => {
		const humanActor = ctx.resolveHumanActorOrFail();
		if (humanActor === null) return;
		const featureDir = await ctx.dispatchOrFail(opts);
		if (featureDir === null) return;
		const session = await loadSession(featureDir, { ensureDir: !ctx.dryRun });
		const from = session.snapshot.state?.sub_state;
		if (!from) {
			ctx.failure(diagnosticVariant("failure.no_session.generic", { feature: opts.feature }));
			return;
		}
		const result = await mutator.run(featureDir, session, {
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
}
//#endregion
//#region src/core/loaf-config.ts
const CONFIG_SCHEMA_VERSION = 2;
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
	schema_version: z.literal(CONFIG_SCHEMA_VERSION),
	protected_files: z.array(z.string()).default([]),
	stable_core: z.array(z.string()).default([]),
	paths: WriteGuardConfigPaths.prefault({})
});
const LoafConfigCommands = z.object({
	run: z.array(z.string()).default([]),
	lint: z.array(z.string()).default([]),
	typecheck: z.array(z.string()).default([]),
	visual: z.array(z.string()).default([]),
	acceptance: z.array(z.string()).default([]),
	build: z.array(z.string()).default([])
}).prefault({});
const LoafConfigConstitution = z.object({
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
}).prefault({});
const LoafConfigLocale = z.object({ default_lang: z.enum(["en", "zh"]).default("en") }).prefault({});
const LoafConfig = z.object({
	schema_version: z.literal(CONFIG_SCHEMA_VERSION),
	protected_files: z.array(z.string()).default([]),
	stable_core: z.array(z.string()).default([]),
	paths: WriteGuardConfigPaths.prefault({}),
	commands: LoafConfigCommands,
	constitution: LoafConfigConstitution,
	locale: LoafConfigLocale
});
function defaultLoafConfig() {
	return LoafConfig.parse({ schema_version: CONFIG_SCHEMA_VERSION });
}
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
/**
* Exclusive-create write for a scaffolded config file: `mkdir -p` the parent,
* then `open` with the `wx` flag so a race between a caller's existence
* pre-check and this write still refuses (`"exists"`) instead of clobbering.
* Non-EEXIST failures propagate — fail fast at the I/O boundary. The caller
* owns diagnostic emission; this stays pure I/O so the refuse-on-race branch
* is deterministically testable.
*/
async function writeConfigExclusive(configPath, content) {
	await promises.mkdir(path.dirname(configPath), { recursive: true });
	let handle;
	try {
		handle = await promises.open(configPath, "wx");
		await handle.writeFile(content, "utf8");
		return "written";
	} catch (err) {
		if (err.code === "EEXIST") return "exists";
		throw err;
	} finally {
		await handle?.close();
	}
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
//#region src/cli/commands/profile-config.tsx
const CONFIG_INIT_COMMENT = "Scaffolded by `loaf config init`. Machine contract: src/core/loaf-config.ts LoafConfig. This _comment key is an output affordance only; loaf-cli parses the semantic config without it.";
function serializeStableJson(value) {
	return JSON.stringify(value, null, 2) + "\n";
}
function registerProfileConfig(program, ctx, mutator, actor, userConfigHomeDir) {
	declareCommandPolicy(program.command("spike").description("Spike-task exits (protocol §8.3)").command("convert").description("Convert a spike session — emits spike:converted then archives to DONE.archived").option("--feature <name>", "Feature whose spike session to convert").requiredOption("--to-feature <id>", "Target feature id (F-NNN) the spike learnings carry into").requiredOption("--reason <text>", "Rationale recorded on the spike:converted entry").option("--feature-dir <path>", "Override default .loaf/<feature> directory"), {
		selectors: "selected",
		dryRun: "mutating"
	}).action(async (opts) => {
		const humanActor = ctx.resolveHumanActorOrFail();
		if (humanActor === null) return;
		const featureDir = await ctx.dispatchOrFail(opts);
		if (featureDir === null) return;
		const session = await loadSession(featureDir, { ensureDir: !ctx.dryRun });
		const from = session.snapshot.state?.sub_state;
		if (!from) {
			ctx.failure(diagnosticVariant("failure.no_session.generic", { feature: opts.feature }));
			return;
		}
		const result = await mutator.run(featureDir, session, [{
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
	declareCommandPolicy(program.command("profile").description("Ceremony profile commands (protocol §10.8)").command("escalate").description("Apply a ceremony escalation — resolve the profile_escalation pending + emit event:ceremony_set").requiredOption("--confirm", "Human acceptance of the escalation (required)").requiredOption("--input <path>", "JSON file with the escalated 6-flag Ceremony object").option("--feature <name>", "Feature whose session to escalate").option("--feature-dir <path>", "Override default .loaf/<feature> directory"), {
		selectors: "selected",
		dryRun: "mutating"
	}).action(async (opts) => {
		if (await ctx.dispatchOrFail(opts) === null) return;
		const humanActor = ctx.resolveHumanActorOrFail();
		if (humanActor === null) return;
		let content;
		try {
			content = await promises.readFile(opts.input, "utf8");
		} catch (err) {
			if (err.code === "ENOENT") ctx.failure(diagnosticVariant("failure.profile.input_file_missing", {
				path: opts.input,
				path: opts.input
			}));
			else ctx.failure(diagnosticVariant("failure.profile.input_file_unreadable", {
				path: opts.input,
				error: String(err),
				path: opts.input
			}));
			return;
		}
		let ceremony;
		try {
			ceremony = JSON.parse(content);
		} catch (err) {
			ctx.failure(diagnostic$2("SCHEMA_VALIDATION_FAILED", {
				reason: err.message,
				path: opts.input
			}));
			return;
		}
		const featureDir = await ctx.dispatchOrFail(opts);
		if (featureDir === null) return;
		const session = await loadSession(featureDir, { ensureDir: !ctx.dryRun });
		if (!session.snapshot.state?.sub_state) {
			ctx.failure(diagnosticVariant("failure.no_session.generic", { feature: opts.feature }));
			return;
		}
		const head = pendingHead(session.snapshot.pending);
		if (!head) {
			ctx.failure(diagnostic$2("ESCALATION_NOT_PENDING", { actual_head: "(none)" }));
			return;
		}
		const result = await mutator.run(featureDir, session, [{
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
	const refuseConfigExists = (configPath) => ctx.failure(diagnostic$2("CONFIG_ALREADY_INITIALIZED", { config_path: configPath }));
	async function ensureConfigTargetAbsent(configPath) {
		try {
			await promises.access(configPath);
			refuseConfigExists(configPath);
			return false;
		} catch (err) {
			if (err.code === "ENOENT") return true;
			throw err;
		}
	}
	declareCommandPolicy(program.command("config").description("Project and user config commands").command("init").description("Write .loaf/.config/loaf.config.json; --global writes ~/.loaf/config.json").option("--global", "Write user config at ~/.loaf/config.json instead of project config"), {
		selectors: "unscoped",
		dryRun: "scaffold-writer"
	}).action(async (opts) => {
		const configPath = opts.global ? userConfigPath(userConfigHomeDir ?? os.homedir()) : loafConfigPath(process.cwd());
		if (!await ensureConfigTargetAbsent(configPath)) return;
		if (await writeConfigExclusive(configPath, opts.global ? serializeStableJson(UserConfig.parse({
			schema_version: 1,
			locale: { default_lang: "en" }
		})) : serializeStableJson({
			_comment: CONFIG_INIT_COMMENT,
			...LoafConfig.parse(defaultLoafConfig())
		})) === "exists") {
			refuseConfigExists(configPath);
			return;
		}
		ctx.success({
			ok: true,
			config_path: configPath
		}, () => `${configPath}\n`);
	});
	declareCommandPolicy(program.command("doctor").description("Repository self-check. This release implements --rebuild only").option("--rebuild", "Full journal replay → rebuild snapshots/*.json + _meta.json").option("--feature <name>", "Feature whose snapshots to rebuild (required with --rebuild)").option("--feature-dir <path>", "Override default .loaf/<feature> directory"), {
		selectors: "recovery",
		dryRun: "read-only"
	}).action(async (opts) => {
		if (!opts.rebuild) {
			ctx.failure(diagnostic$2("DOCTOR_MODE_NOT_IMPLEMENTED", {}));
			return;
		}
		if (!opts.feature) {
			ctx.failure(diagnostic$2("DOCTOR_FEATURE_REQUIRED", {}));
			return;
		}
		const featureDir = opts.featureDir ?? defaultFeatureDir(opts.feature);
		ctx.recordTraceTarget(opts.feature, featureDir);
		let lease;
		try {
			lease = await acquireFeatureWriteLease(featureDir, "doctor:rebuild");
		} catch (error) {
			if (error instanceof FeatureWriteLeaseError) {
				ctx.failure(error.diagnostic);
				return;
			}
			throw error;
		}
		try {
			const journalPath = path.join(featureDir, "journal.jsonl");
			const replay = await replayJournal(journalPath, { collect_entries: true });
			if (!replay.ok) {
				ctx.failure(diagnostic$2("DOCTOR_REBUILD_FAILED", {
					journal_path: journalPath,
					replay_code: replay.code,
					at_seq: replay.at_seq,
					...replay.detail,
					...replay.code === "REDUCER_REJECTED" ? { diagnostic: replay.diagnostic } : { cause: replay.message }
				}));
				return;
			}
			const entries = replay.entries;
			if (entries === void 0) {
				ctx.failure(diagnostic$2("DOCTOR_REBUILD_FAILED", {}));
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
				ctx.failure(diagnostic$2("DOCTOR_REBUILD_FAILED", {
					reason: "projection_write_failed",
					cause: err.message,
					feature_dir: featureDir
				}));
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
		} finally {
			await lease.release();
		}
	});
}
//#endregion
//#region src/cli/task-authoring.ts
/** Collect every task id ever authored so whole-graph replacement never reuses one. */
function collectOccupiedTaskIds(snapshot, entries) {
	const ids = new Set(snapshot.tasks.map((task) => task.id));
	for (const entry of entries) if (entry.kind === "event:tasks_planned") {
		const tasks = entry.payload.tasks ?? [];
		for (const task of tasks) if (typeof task.id === "string") ids.add(task.id);
	} else if (entry.kind === "event:tasks_amended") {
		const taskId = entry.payload.task?.id;
		if (typeof taskId === "string") ids.add(taskId);
	}
	return [...ids];
}
function maxTaskSerial(taskIds) {
	let max = 0;
	for (const taskId of taskIds) {
		const match = /^T-(\d{3,})$/.exec(taskId);
		if (match === null) return null;
		max = Math.max(max, Number.parseInt(match[1], 10));
	}
	return max;
}
/**
* Allocate every id before resolving dependencies, so forward local refs are
* deterministic. `occupiedTaskIds` should include current and historical ids;
* callers execute this planner while the feature write lease is held.
*/
function allocateTaskAuthoringInputs(inputs, occupiedTaskIds) {
	const maxSerial = maxTaskSerial(occupiedTaskIds);
	if (maxSerial === null) return {
		ok: false,
		code: "REDUCER_ERROR",
		detail: { task_id: occupiedTaskIds.find((taskId) => !/^T-\d{3,}$/.test(taskId)) }
	};
	const taskIdsByLocalKey = {};
	for (let index = 0; index < inputs.length; index += 1) taskIdsByLocalKey[inputs[index].local_key] = `T-${String(maxSerial + index + 1).padStart(3, "0")}`;
	const tasks = [];
	for (const input of inputs) {
		const dependsOn = [];
		for (const dependency of input.depends_on) {
			if ("task_id" in dependency) {
				dependsOn.push(dependency.task_id);
				continue;
			}
			const taskId = taskIdsByLocalKey[dependency.local_key];
			if (taskId === void 0) return {
				ok: false,
				code: "SCHEMA_VALIDATION_FAILED",
				detail: {
					reason: "unknown_dependency_local_key",
					local_key: input.local_key,
					dependency_local_key: dependency.local_key
				}
			};
			dependsOn.push(taskId);
		}
		const { local_key: _localKey, depends_on: _dependencies, step_policy: stepPolicy, ...body } = input;
		const task = materializeTaskInput(TaskInput.parse({
			...body,
			depends_on: dependsOn
		}), taskIdsByLocalKey[input.local_key]);
		if (stepPolicy !== void 0) {
			const execution = task.execution;
			for (const [step, applicability] of Object.entries(stepPolicy)) {
				if (applicability === void 0) continue;
				execution[step].applicability = applicability;
			}
		}
		tasks.push(task);
	}
	return {
		ok: true,
		tasks,
		task_ids_by_local_key: taskIdsByLocalKey
	};
}
//#endregion
//#region src/cli/commands/tasks/authoring.ts
const TASKS_SUBMIT_INPUT = {
	command: "loaf tasks submit",
	helpPrefix: "JSON source",
	inlineLabel: "inline JSON literal",
	helpSuffix: " (protocol §10.7). Whole-graph single object only."
};
const TASKS_ADD_INPUT = {
	command: "loaf tasks add",
	helpPrefix: "JSON source for semantic task input (single object or array)",
	inlineLabel: "inline JSON",
	helpSuffix: " (protocol §10.7)"
};
const TASKS_AMEND_INPUT = {
	command: "loaf tasks amend",
	helpPrefix: "New id-less task definition for a sponsored graph replacement",
	inlineLabel: "inline JSON",
	helpText: "New id-less task definition for a sponsored graph replacement (JSON file or '-')"
};
function registerTaskSubmit(tasksCmd, deps) {
	const { ctx, mutator, actor, input } = deps;
	declareCommandPolicy(tasksCmd.command("submit").description("Submit a complete task graph from --input <src> (stdin / inline JSON / file path; whole-graph single object)").option("--input <src>", jsonInputHelp(TASKS_SUBMIT_INPUT)).option("--schema", "Dump the semantic authoring JSON Schema instead of mutating").option("--feature <name>", "Feature whose task graph to submit").option("--feature-dir <path>", "Override default .loaf/<feature> directory"), {
		selectors: "selected",
		dryRun: "mutating",
		schema: {
			kind: "input",
			key: "tasks:submit"
		}
	}).action(async (rawOpts) => {
		if (!input.requireArg(ctx, rawOpts.input, TASKS_SUBMIT_INPUT)) return;
		const opts = rawOpts;
		const read = await input.readJson(ctx, opts.input, TASKS_SUBMIT_INPUT);
		if (!read.ok) return;
		const parsed = TasksSubmitInput.safeParse(read.value);
		if (!parsed.success) {
			ctx.failure(diagnostic$2("SCHEMA_VALIDATION_FAILED", {
				reason: parsed.error.issues.map((issue) => issue.message).join("; "),
				issues: parsed.error.issues,
				migration: "legacy-full-input-rejected"
			}));
			return;
		}
		const featureDir = await ctx.dispatchOrFail(opts);
		if (featureDir === null) return;
		const session = await ctx.resolveSession(featureDir);
		if (!session.snapshot.state) {
			ctx.failure(diagnosticVariant("failure.no_session.tasks", { feature: opts.feature }));
			return;
		}
		const occupiedTaskIds = collectOccupiedTaskIds(session.snapshot, session.entries);
		const result = await mutator.runPlannedBatch(featureDir, session, (snapshot) => {
			const allocation = allocateTaskAuthoringInputs(parsed.data.tasks, occupiedTaskIds);
			if (!allocation.ok) return allocation;
			const specVersion = snapshot.state?.spec_version;
			if (specVersion === void 0) return {
				ok: false,
				code: "REDUCER_ERROR",
				detail: { reason: "session_state_missing" }
			};
			return {
				ok: true,
				entries: [{
					kind: "event:tasks_planned",
					payload: {
						based_on: { spec: specVersion },
						tasks: allocation.tasks
					},
					actor
				}]
			};
		}, {});
		if (!result) return;
		const state = result.snapshot.state;
		if (state === null) {
			ctx.failure(diagnostic$2("REDUCER_ERROR", {}));
			return;
		}
		const tasks = result.snapshot.tasks;
		const taskIds = tasks.map((t) => t.id);
		const plannedTasks = result.entries[0].payload.tasks;
		const taskIdsByLocalKey = Object.fromEntries(parsed.data.tasks.map((task, index) => [task.local_key, plannedTasks[index].id]));
		const out = {
			ok: true,
			feature: opts.feature,
			sub_state: state.sub_state,
			tasks_count: tasks.length,
			task_ids: taskIds,
			task_ids_by_local_key: taskIdsByLocalKey,
			tasks_based_on: result.snapshot.tasks_based_on
		};
		const selector = await selectorForCommandContext(ctx);
		ctx.success(out, (i18n) => i18n.t(tasks.length === 1 ? SUCCESS_KEYS.tasksSubmitTextOne : SUCCESS_KEYS.tasksSubmitTextMany, {
			count: tasks.length,
			task_ids: taskIds.join(", ")
		}) + "\n", (i18n) => {
			const next = buildNextAdvisoryFromSnapshot(i18n, result.snapshot, featureDir, selector);
			return {
				stateChange: i18n.t(SUCCESS_KEYS.tasksSubmitStateChange, { count: tasks.length }),
				...next === void 0 ? {} : { next }
			};
		});
	});
}
function registerTaskAdd(tasksCmd, deps) {
	const { ctx, mutator, actor, input } = deps;
	declareCommandPolicy(tasksCmd.command("add").description("Append id-less task(s) to the graph — --input <src> with single object or array (batch); SPEC.design whole-graph, or EXECUTE.work sponsored via --finding").option("--input <src>", jsonInputHelp(TASKS_ADD_INPUT)).option("--schema", "Dump the input JSON Schema instead of mutating (Phase 16 SC-10)").option("--feature <name>", "Feature whose task graph to extend").option("--feature-dir <path>", "Override default .loaf/<feature> directory").option("--finding <FND-N>", "Sponsoring amend-tasks finding (sponsored add at EXECUTE.work)"), {
		selectors: "selected",
		dryRun: "mutating",
		schema: {
			kind: "input",
			key: "tasks:add"
		}
	}).action(async (rawOpts) => {
		if (!input.requireArg(ctx, rawOpts.input, TASKS_ADD_INPUT)) return;
		const opts = rawOpts;
		const read = await input.readJson(ctx, opts.input, TASKS_ADD_INPUT);
		if (!read.ok) return;
		const parsed = read.value;
		const inputParse = TaskAuthoringInputBatched.safeParse(parsed);
		if (!inputParse.success) {
			if (Array.isArray(parsed) && parsed.length === 0) {
				ctx.failure(diagnosticVariant("failure.tasks_add.empty_array", {}));
				return;
			}
			ctx.failure(diagnostic$2("SCHEMA_VALIDATION_FAILED", {
				reason: inputParse.error.issues.map((issue) => issue.message).join("; "),
				issues: inputParse.error.issues,
				migration: "legacy-task-input-rejected"
			}));
			return;
		}
		const validatedInputs = Array.isArray(inputParse.data) ? inputParse.data : [inputParse.data];
		const featureDir = await ctx.dispatchOrFail(opts);
		if (featureDir === null) return;
		const session = await ctx.resolveSession(featureDir);
		if (!session.snapshot.state) {
			ctx.failure(diagnosticVariant("failure.no_session.tasks", { feature: opts.feature }));
			return;
		}
		const subState = session.snapshot.state.sub_state;
		const sponsored = opts.finding !== void 0;
		if (sponsored && subState === "SPEC.design") {
			ctx.failure(diagnostic$2("USAGE", { reason: "sponsorship_not_allowed_at_spec_design" }));
			return;
		}
		if (!sponsored && subState !== "SPEC.design") {
			ctx.failure(diagnostic$2("SUB_STATE_AUTHORITY_VIOLATION", {
				kind: "event:tasks_amended",
				sub_state: subState
			}));
			return;
		}
		const occupiedTaskIds = collectOccupiedTaskIds(session.snapshot, session.entries);
		if (sponsored) {
			const result = await mutator.runPlannedBatch(featureDir, session, () => {
				const allocation = allocateTaskAuthoringInputs(validatedInputs, occupiedTaskIds);
				if (!allocation.ok) return allocation;
				return {
					ok: true,
					entries: allocation.tasks.map((task) => ({
						actor,
						kind: "event:tasks_amended",
						payload: {
							mode: "add",
							task,
							sponsored_by_finding_id: opts.finding
						}
					}))
				};
			}, { timestamps: "per-entry" });
			if (!result) return;
			const newIds = result.entries.map((entry) => entry.payload.task.id);
			const taskIdsByLocalKey = Object.fromEntries(validatedInputs.map((task, index) => [task.local_key, newIds[index]]));
			const out = {
				ok: true,
				feature: opts.feature,
				task_ids: newIds,
				task_ids_by_local_key: taskIdsByLocalKey,
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
			existingFull.push(materializeTaskForAmend(base, t));
		}
		const result = await mutator.runPlannedBatch(featureDir, session, (snapshot) => {
			const allocation = allocateTaskAuthoringInputs(validatedInputs, occupiedTaskIds);
			if (!allocation.ok) return allocation;
			return {
				ok: true,
				entries: [{
					kind: "event:tasks_planned",
					payload: {
						based_on: snapshot.tasks_based_on ?? { spec: snapshot.state?.spec_version },
						tasks: [...existingFull, ...allocation.tasks]
					},
					actor
				}]
			};
		}, {});
		if (!result) return;
		const newIds = result.entries[0].payload.tasks.slice(existingFull.length).map((task) => task.id);
		const taskIdsByLocalKey = Object.fromEntries(validatedInputs.map((task, index) => [task.local_key, newIds[index]]));
		const out = {
			ok: true,
			feature: opts.feature,
			task_ids: newIds,
			task_ids_by_local_key: taskIdsByLocalKey,
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
}
function registerTaskAmend(tasksCmd, deps) {
	const { ctx, mutator, actor, input } = deps;
	declareCommandPolicy(tasksCmd.command("amend <task-id>").description("Amend a task: --policy <step>=<applicability> (EXECUTE.plan) or --input <file> --finding <FND-N> (sponsored, EXECUTE.work)").option("--feature <name>", "Feature whose task to amend").option("--feature-dir <path>", "Override default .loaf/<feature> directory").option("--policy <step=applicability>", "Step applicability override (must|optional|na); repeatable", (val, acc) => [...acc, val], []).option("--input <file>", jsonInputHelp(TASKS_AMEND_INPUT)).option("--finding <FND-N>", "Sponsoring amend-tasks finding (required with --input)"), {
		selectors: "selected",
		dryRun: "mutating"
	}).action(async (taskId, opts) => {
		const earlyFeatureDir = await ctx.dispatchOrFail(opts);
		if (earlyFeatureDir === null) return;
		const policies = opts.policy ?? [];
		const hasPolicy = policies.length > 0;
		const hasInput = opts.input !== void 0;
		const hasFinding = opts.finding !== void 0;
		if (hasPolicy && hasInput) {
			ctx.failure(diagnostic$2("USAGE", { reason: "policy_and_input_mutually_exclusive" }));
			return;
		}
		if (hasInput !== hasFinding) {
			ctx.failure(diagnostic$2("USAGE", { reason: "sponsored_input_finding_pair_required" }));
			return;
		}
		if (!hasPolicy && !hasInput) {
			ctx.failure(diagnostic$2("USAGE", { reason: "amend_input_required" }));
			return;
		}
		if (hasInput) {
			const inputPath = opts.input;
			const findingId = opts.finding;
			const read = await input.readJson(ctx, inputPath, TASKS_AMEND_INPUT);
			if (!read.ok) return;
			const inParsed = read.value;
			const inTask = TaskInput.safeParse(inParsed);
			if (!inTask.success) {
				ctx.failure(diagnostic$2("SCHEMA_VALIDATION_FAILED", {
					reason: inTask.error.issues.map((issue) => issue.message).join("; "),
					issues: inTask.error.issues
				}));
				return;
			}
			const sFeatureDir = earlyFeatureDir;
			const sSession = await ctx.resolveSession(sFeatureDir);
			if (!sSession.snapshot.state) {
				ctx.failure(diagnosticVariant("failure.no_session.tasks", { feature: opts.feature }));
				return;
			}
			const sCurrent = sSession.snapshot.tasks.find((t) => t.id === taskId);
			if (!sCurrent) {
				ctx.failure(diagnostic$2("TASK_NOT_FOUND", { task_id: taskId }));
				return;
			}
			const sCanonical = latestCanonicalTaskBody(sSession.entries, taskId);
			const sNewGraph = materializeTaskInput(inTask.data, taskId);
			const sNewSteps = new Set(Object.keys(sNewGraph.execution));
			const sPriorExec = sCanonical.execution;
			for (const [stepName, prior] of Object.entries(sPriorExec)) {
				if (sNewSteps.has(stepName)) continue;
				if (prior.status !== "pending" || prior.started_at !== void 0 || prior.reason !== void 0) {
					ctx.failure(diagnostic$2("MUTATION_OUT_OF_RIGHTS", {
						task_id: taskId,
						step: stepName,
						reason: "sponsored_amend_drops_progress_step",
						sub_state: sSession.snapshot.state.sub_state
					}));
					return;
				}
			}
			const sMaterialized = materializeTaskForAmend(carryForwardStepProgress(sNewGraph, sCanonical), sCurrent);
			const sResult = await mutator.run(sFeatureDir, sSession, {
				kind: "event:tasks_amended",
				payload: {
					mode: "replace",
					task: sMaterialized,
					sponsored_by_finding_id: findingId
				},
				actor
			});
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
				ctx.failure(diagnostic$2("SCHEMA_VALIDATION_FAILED", {
					reason: "policy_requires_step_assignment",
					value: p
				}));
				return;
			}
			const step = p.slice(0, eq);
			const applicability = p.slice(eq + 1);
			if (!APPLICABILITY.includes(applicability)) {
				ctx.failure(diagnostic$2("SCHEMA_VALIDATION_FAILED", {
					reason: "invalid_policy_applicability",
					step,
					value: applicability,
					allowed: APPLICABILITY
				}));
				return;
			}
			if (policyMap.has(step)) {
				ctx.failure(diagnostic$2("SCHEMA_VALIDATION_FAILED", {
					reason: "duplicate_policy_step",
					step
				}));
				return;
			}
			policyMap.set(step, applicability);
		}
		const featureDir = await ctx.dispatchOrFail(opts);
		if (featureDir === null) return;
		const session = await loadSession(featureDir, { ensureDir: !ctx.dryRun });
		if (!session.snapshot.state) {
			ctx.failure(diagnosticVariant("failure.no_session.tasks", { feature: opts.feature }));
			return;
		}
		const current = session.snapshot.tasks.find((t) => t.id === taskId);
		if (!current) {
			ctx.failure(diagnostic$2("TASK_NOT_FOUND", { task_id: taskId }));
			return;
		}
		const materialized = materializeTaskForAmend(latestCanonicalTaskBody(session.entries, taskId), current);
		const execution = materialized.execution;
		for (const [step, applicability] of policyMap) {
			const seeded = execution[step];
			if (!seeded) {
				ctx.failure(diagnostic$2("TASK_STEP_NOT_FOUND", {
					task_id: taskId,
					step
				}));
				return;
			}
			seeded.applicability = applicability;
		}
		const result = await mutator.run(featureDir, session, {
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
/** Single-id convenience for evidence wrappers such as `loaf waive`. */
function allocateNextEvidenceId(snapshot) {
	return allocateNextEvidenceIds(snapshot, 1)[0];
}
//#endregion
//#region src/cli/commands/tasks/presentation.ts
function formatTaskListKind(i18n, kind) {
	if (i18n.locale === "en") return kind;
	return i18n.t(taskKindKey(kind));
}
function formatTaskStatus(i18n, status) {
	return i18n.t(taskStatusKey(status));
}
//#endregion
//#region src/cli/commands/tasks/execution.ts
function registerTaskClaim(tasksCmd, deps) {
	const { ctx, mutator, actor } = deps;
	declareCommandPolicy(tasksCmd.command("claim <task-id>").description("Claim a ready task (pending → in_progress) at EXECUTE.work").option("--feature <name>", "Feature whose task to claim").option("--feature-dir <path>", "Override default .loaf/<feature> directory"), {
		selectors: "selected",
		dryRun: "mutating"
	}).action(async (taskId, opts) => {
		const featureDir = await ctx.dispatchOrFail(opts);
		if (featureDir === null) return;
		const session = await loadSession(featureDir, { ensureDir: !ctx.dryRun });
		if (!session.snapshot.state) {
			ctx.failure(diagnosticVariant("failure.no_session.tasks", { feature: opts.feature }));
			return;
		}
		const result = await mutator.run(featureDir, session, {
			kind: "event:task_claimed",
			payload: { task_id: taskId },
			actor
		});
		if (!result) return;
		const claimed = result.snapshot.tasks.find((t) => t.id === taskId);
		if (!claimed) {
			ctx.failure(diagnostic$2("REDUCER_ERROR", {}));
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
}
function registerTaskAbandon(tasksCmd, deps) {
	const { ctx, mutator, actor } = deps;
	declareCommandPolicy(tasksCmd.command("abandon <task-id>").description("Abandon a non-terminal task (→ abandoned) at EXECUTE.work").requiredOption("--reason <text>", "Why the task is being abandoned (required)").option("--feature <name>", "Feature whose task to abandon").option("--feature-dir <path>", "Override default .loaf/<feature> directory"), {
		selectors: "selected",
		dryRun: "mutating"
	}).action(async (taskId, opts) => {
		const featureDir = await ctx.dispatchOrFail(opts);
		if (featureDir === null) return;
		const session = await loadSession(featureDir, { ensureDir: !ctx.dryRun });
		if (!session.snapshot.state) {
			ctx.failure(diagnosticVariant("failure.no_session.tasks", { feature: opts.feature }));
			return;
		}
		const result = await mutator.run(featureDir, session, {
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
			ctx.failure(diagnostic$2("REDUCER_ERROR", {}));
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
}
function registerTaskComplete(tasksCmd, deps) {
	const { ctx } = deps;
	declareCommandPolicy(tasksCmd.command("complete <task-id>").description("Confirm a task has reached status=done (read-only; emits nothing)").option("--feature <name>", "Feature whose task to confirm").option("--feature-dir <path>", "Override default .loaf/<feature> directory"), {
		selectors: "selected",
		dryRun: "read-only"
	}).action(async (taskId, opts) => {
		const featureDir = await ctx.dispatchOrFail(opts);
		if (featureDir === null) return;
		const session = await loadSession(featureDir, { ensureDir: !ctx.dryRun });
		if (!session.snapshot.state) {
			ctx.failure(diagnosticVariant("failure.no_session.tasks", { feature: opts.feature }));
			return;
		}
		const task = session.snapshot.tasks.find((t) => t.id === taskId);
		if (!task) {
			ctx.failure(diagnostic$2("TASK_NOT_FOUND", { task_id: taskId }));
			return;
		}
		if (task.status !== "done") {
			const TERMINAL_POSITIVE = [
				"passed",
				"waived",
				"na"
			];
			const blockingSteps = Object.entries(task.steps).filter(([, s]) => s.applicability === "must" && !TERMINAL_POSITIVE.includes(s.status)).map(([name]) => name);
			ctx.failure(diagnostic$2("TASK_COMPLETE_PRECONDITION_VIOLATED", {
				task_id: taskId,
				status: task.status,
				blocking_steps: blockingSteps
			}));
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
}
function registerTaskRegisterRed(tasksCmd, deps) {
	const { ctx, mutator, actor } = deps;
	declareCommandPolicy(tasksCmd.command("register-red <task-id>").description("Register an established failing RED test for a claimed behavioral bug task (ordering proof; not a general step shortcut)").option("--feature <name>", "Feature whose task to register").option("--feature-dir <path>", "Override default .loaf/<feature> directory"), {
		selectors: "selected",
		dryRun: "mutating"
	}).action(async (taskId, opts) => {
		const featureDir = await ctx.dispatchOrFail(opts);
		if (featureDir === null) return;
		const session = await loadSession(featureDir, { ensureDir: !ctx.dryRun });
		if (!session.snapshot.state) {
			ctx.failure(diagnosticVariant("failure.no_session.tasks", { feature: opts.feature }));
			return;
		}
		const result = await mutator.run(featureDir, session, {
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
}
function registerTaskStep(tasksCmd, deps) {
	const { ctx, mutator, actor } = deps;
	const stepCmd = tasksCmd.command("step").description("Task step lifecycle (start / done)");
	declareCommandPolicy(stepCmd.command("start").description("Mark a task step as running (task must be claimed)").requiredOption("--task <task-id>", "Task whose step to start").requiredOption("--step <step-name>", "Step name (kind-specific; see spec)").option("--feature <name>", "Feature whose task lifecycle to advance").option("--feature-dir <path>", "Override default .loaf/<feature> directory"), {
		selectors: "selected",
		dryRun: "mutating"
	}).action(async (opts) => {
		const featureDir = await ctx.dispatchOrFail(opts);
		if (featureDir === null) return;
		const session = await loadSession(featureDir, { ensureDir: !ctx.dryRun });
		if (!session.snapshot.state) {
			ctx.failure(diagnosticVariant("failure.no_session.tasks", { feature: opts.feature }));
			return;
		}
		const result = await mutator.run(featureDir, session, {
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
			ctx.failure(diagnostic$2("REDUCER_ERROR", {}));
			return;
		}
		const stepInfo = updated.steps[opts.step];
		if (!stepInfo) {
			ctx.failure(diagnostic$2("REDUCER_ERROR", {}));
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
	declareCommandPolicy(stepCmd.command("done").description("Complete a workflow step; --result is the step outcome, independent of --evidence-result").requiredOption("--task <task-id>", "Task whose step to mark done").requiredOption("--step <step-name>", "Step name (kind-specific)").option("--result <r>", "Step outcome: passed (default) | failed | waived | na", "passed").option("--evidence-kind <kind>", "Evidence kind (closed EvidenceKind enum)").option("--evidence-result <r>", "Independent evidence outcome (passed | failed | approved | rejected | waived)").option("--evidence-summary <text>", "Evidence summary (≥3 chars)").option("--evidence-covers <csv>", "Comma-separated REQ/SCEN/VIS/Task ids covered by this evidence").option("--evidence-check <kind>", "Verify-check kind (run | review | acceptance | visual)").option("--evidence-reason <text>", "Evidence reason (manual/waiver require ≥10 chars)").option("--evidence-actor <actor>", "Override evidence actor (default: cli:loaf; required human:* for manual/waiver)").option("--feature <name>", "Feature whose task lifecycle to advance").option("--feature-dir <path>", "Override default .loaf/<feature> directory"), {
		selectors: "selected",
		dryRun: "mutating"
	}).action(async (opts) => {
		if (![
			"passed",
			"failed",
			"waived",
			"na"
		].includes(opts.result)) {
			ctx.failure(diagnostic$2("USAGE", {
				reason: "invalid_evidence_result",
				value: opts.result,
				allowed: [
					"passed",
					"failed",
					"waived",
					"na"
				]
			}));
			return;
		}
		const evidenceFlagSet = opts.evidenceKind !== void 0 || opts.evidenceResult !== void 0 || opts.evidenceSummary !== void 0 || opts.evidenceCovers !== void 0 || opts.evidenceCheck !== void 0 || opts.evidenceReason !== void 0 || opts.evidenceActor !== void 0;
		if (evidenceFlagSet) {
			if (opts.evidenceKind === void 0 || opts.evidenceSummary === void 0) {
				ctx.failure(diagnostic$2("USAGE", { reason: "evidence_kind_summary_pair_required" }));
				return;
			}
		}
		const featureDir = await ctx.dispatchOrFail(opts);
		if (featureDir === null) return;
		const session = await loadSession(featureDir, { ensureDir: !ctx.dryRun });
		if (!session.snapshot.state) {
			ctx.failure(diagnosticVariant("failure.no_session.tasks", { feature: opts.feature }));
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
			evidenceId = allocateNextEvidenceId(session.snapshot);
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
			result = await mutator.run(featureDir, session, [stepDoneEntry, {
				kind: "evidence:added",
				payload: evidencePayload,
				actor
			}]);
		} else result = await mutator.run(featureDir, session, stepDoneEntry);
		if (!result) return;
		const updated = result.snapshot.tasks.find((t) => t.id === opts.task);
		if (!updated) {
			ctx.failure(diagnostic$2("REDUCER_ERROR", {}));
			return;
		}
		const stepInfo = updated.steps[opts.step];
		if (!stepInfo) {
			ctx.failure(diagnostic$2("REDUCER_ERROR", {}));
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
}
//#endregion
//#region src/cli/commands/tasks/query.ts
function registerTaskQueries(tasksCmd, deps) {
	const { ctx } = deps;
	declareCommandPolicy(tasksCmd.command("list").description("List tasks (read-only); shows derived `ready` column").option("--feature <name>", "Feature whose tasks to list").option("--feature-dir <path>", "Override default .loaf/<feature> directory").option("--status <s>", "Filter by task status (pending|ready|in_progress|done|abandoned)"), {
		selectors: "selected",
		dryRun: "read-only"
	}).action(async (opts) => {
		const featureDir = await ctx.dispatchOrFail(opts);
		if (featureDir === null) return;
		const loaded = await ctx.loadProjectionsOrFail(featureDir, ["state", "tasks"], opts.feature, "failure.no_session.tasks");
		if (loaded === null) return;
		const slimTasks = loaded.tasks ? loaded.tasks.tasks.map((t) => extractTaskSlim(t)) : [];
		const tasksById = new Map(slimTasks.map((t) => [t.id, t]));
		const withDerived = slimTasks.map((t) => {
			return {
				...t,
				ready: (t.status === "pending" || t.status === "ready") && areTaskDependenciesSatisfied(t, tasksById)
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
			ctx.failure(diagnostic$2("USAGE", {
				reason: "invalid_task_status",
				value: opts.status,
				allowed: validStatuses
			}));
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
	declareCommandPolicy(tasksCmd.command("next").description("Print the next ready task id (or empty if none); read-only").option("--feature <name>", "Feature whose ready task to compute").option("--feature-dir <path>", "Override default .loaf/<feature> directory"), {
		selectors: "selected",
		dryRun: "read-only"
	}).action(async (opts) => {
		const featureDir = await ctx.dispatchOrFail(opts);
		if (featureDir === null) return;
		const session = await loadSession(featureDir, { ensureDir: !ctx.dryRun });
		if (!session.snapshot.state) {
			ctx.failure(diagnosticVariant("failure.no_session.tasks", { feature: opts.feature }));
			return;
		}
		const tasks = session.snapshot.tasks;
		const tasksById = new Map(tasks.map((t) => [t.id, t]));
		const ready = tasks.find((task) => (task.status === "pending" || task.status === "ready") && areTaskDependenciesSatisfied(task, tasksById));
		ctx.success({
			ok: true,
			feature: opts.feature,
			task_id: ready?.id ?? null,
			kind: ready?.kind ?? null
		}, () => ready ? `${ready.id}\n` : "");
	});
}
//#endregion
//#region src/cli/commands/tasks.tsx
/** Register the loaf tasks family without changing its public facade or command order. */
function registerTasks(program, ctx, mutator, actor, input) {
	const tasksCmd = program.command("tasks").description("Task lifecycle commands (Slice 2 MVP: submit / claim / step)");
	const deps = {
		ctx,
		mutator,
		actor,
		input
	};
	registerTaskSubmit(tasksCmd, deps);
	registerTaskAdd(tasksCmd, deps);
	registerTaskClaim(tasksCmd, deps);
	registerTaskAbandon(tasksCmd, deps);
	registerTaskQueries(tasksCmd, deps);
	registerTaskComplete(tasksCmd, deps);
	registerTaskAmend(tasksCmd, deps);
	registerTaskRegisterRed(tasksCmd, deps);
	registerTaskStep(tasksCmd, deps);
	return { tasksCmd };
}
/** TasksActiveSummary — resume-pack active-task projection.
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
	state_snapshot: StateProjection,
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
//#region src/cli/commands/terminal-settle.tsx
function registerTerminalSettle(program, ctx, mutator, actor) {
	declareCommandPolicy(program.command("settle").description("Advance VERIFY.accept → SETTLE.lessons (deep ceremony only)").option("--feature <name>", "Feature whose session to settle").option("--feature-dir <path>", "Override default .loaf/<feature> directory"), {
		selectors: "selected",
		dryRun: "mutating"
	}).action(async (opts) => {
		const featureDir = await ctx.dispatchOrFail(opts);
		if (featureDir === null) return;
		const session = await loadSession(featureDir, { ensureDir: !ctx.dryRun });
		const from = session.snapshot.state?.sub_state;
		if (!from) {
			ctx.failure(diagnosticVariant("failure.no_session.generic", { feature: opts.feature }));
			return;
		}
		const result = await mutator.run(featureDir, session, {
			kind: "event:phase_advanced",
			payload: {
				from,
				to: "SETTLE.lessons"
			},
			actor
		});
		if (!result) return;
		const selector = await selectorForCommandContext(ctx);
		const nextCommand = nextCommandFromSnapshot(result.snapshot, featureDir, selector);
		const advisory = nextCommand === void 0 ? [] : [nextCommand];
		const out = {
			ok: true,
			feature: opts.feature,
			from,
			to: "SETTLE.lessons",
			sub_state: result.snapshot.state?.sub_state,
			advisory
		};
		ctx.success(out, (i18n) => i18n.t(SUCCESS_KEYS.settleText), (i18n) => {
			const next = buildNextAdvisoryFromSnapshot(i18n, result.snapshot, featureDir, selector);
			return {
				stateChange: i18n.t(SUCCESS_KEYS.settleStateChange, { from }),
				...next === void 0 ? {} : { next }
			};
		});
	});
	declareCommandPolicy(program.command("resume").description("Resume session from snapshots/resume-pack.json (emits session:resumed journal entry)").option("--feature <name>", "Feature whose resume pack to consume").option("--feature-dir <path>", "Override default .loaf/<feature> directory"), {
		selectors: "selected",
		dryRun: "mutating"
	}).action(async (opts) => {
		const featureDir = await ctx.dispatchOrFail(opts);
		if (featureDir === null) return;
		const session = await loadSession(featureDir, { ensureDir: false });
		if (!session.snapshot.state) {
			ctx.failure(diagnosticVariant("failure.no_session.generic", { feature: opts.feature }));
			return;
		}
		const packPath = path.join(featureDir, "snapshots", "resume-pack.json");
		let raw;
		try {
			raw = await promises.readFile(packPath, "utf8");
		} catch (err) {
			if (err.code === "ENOENT") {
				ctx.failure(diagnostic$2("INPUT_FILE_NOT_FOUND", { path: packPath }));
				return;
			}
			throw err;
		}
		let parsedPack;
		try {
			parsedPack = JSON.parse(raw);
		} catch (err) {
			ctx.failure(diagnostic$2("SCHEMA_VALIDATION_FAILED", {
				reason: "invalid-json",
				cause: err.message,
				subcode: "invalid-json",
				path: packPath
			}));
			return;
		}
		const packParse = ResumePack.safeParse(parsedPack);
		if (!packParse.success) {
			ctx.failure(diagnostic$2("SCHEMA_VALIDATION_FAILED", {
				reason: packParse.error.issues.map((issue) => issue.message).join("; "),
				subcode: "zod",
				path: packPath,
				issues: packParse.error.issues
			}));
			return;
		}
		const pack = packParse.data;
		const resumeActor = `cli:loaf@${process.env["USER"] ?? "unknown"}`;
		const result = await mutator.run(featureDir, session, {
			kind: "session:resumed",
			payload: { resumed_from_pack: {
				at: pack.at,
				reason: pack.reason,
				session_id: pack.session_id
			} },
			actor: resumeActor
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
	declareCommandPolicy(program.command("handoff").description("Compose and persist snapshots/resume-pack.json (read-side projection writer; no journal entry)").requiredOption("--reason <text>", "Why this handoff is being taken (≥5 chars; mandatory per ResumePack.reason)").option("--notes <text>", "Optional free-form notes attached to the pack").option("--feature <name>", "Feature whose handoff to take").option("--feature-dir <path>", "Override default .loaf/<feature> directory"), {
		selectors: "selected",
		dryRun: "projection-writer"
	}).action(async (opts) => {
		if (opts.reason.length < 5) {
			ctx.failure(diagnosticVariant("failure.handoff.reason_too_short", {
				min_length: 5,
				reason_length: opts.reason.length,
				min_length: 5,
				reason_length: opts.reason.length
			}));
			return;
		}
		const humanActor = ctx.resolveHumanActorOrFail();
		if (humanActor === null) return;
		const featureDir = await ctx.dispatchOrFail(opts);
		if (featureDir === null) return;
		let lease;
		try {
			lease = await acquireFeatureWriteLease(featureDir, "handoff");
		} catch (error) {
			if (error instanceof FeatureWriteLeaseError) {
				ctx.failure(error.diagnostic);
				return;
			}
			throw error;
		}
		try {
			const session = await loadSession(featureDir, { ensureDir: false });
			if (!session.snapshot.state) {
				ctx.failure(diagnosticVariant("failure.no_session.generic", { feature: opts.feature }));
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
				ctx.failure(diagnosticVariant("failure.handoff.pack_validation_failed", {
					subcode: "zod",
					issues: parse.error.issues
				}));
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
			}, () => `${packPath}\n`, (i18n) => ({ stateChange: i18n.t(SUCCESS_KEYS.handoffStateChange, { actor: humanActor }) }));
		} finally {
			await lease.release();
		}
	});
}
//#endregion
//#region src/cli/commands/pending.tsx
function formatPendingKind(i18n, kind) {
	if (i18n.locale === "en") return kind;
	const parsed = PendingPromptKind.safeParse(kind);
	return parsed.success ? i18n.t(pendingKindKey(parsed.data)) : kind;
}
function registerPending(program, ctx, mutator, actor) {
	const pendingCmd = program.command("pending").description("Pending queue commands (raise / list / status / resolve)");
	declareCommandPolicy(pendingCmd.command("raise").description("Raise a new pending entry (CLI allocates PEND-id)").requiredOption("--kind <kind>", "Pending kind (ask_user_question | gate_decision | spec_clarification | finding_decision | profile_escalation)").requiredOption("--question <text>", "Question / rationale shown to whoever resolves it (required for ALL kinds)").option("--options <csv>", "Comma-separated answer options (passthrough)").option("--task-id <id>", "Optional task association (passthrough)").option("--feature <name>", "Feature whose session to raise pending against").option("--feature-dir <path>", "Override default .loaf/<feature> directory"), {
		selectors: "selected",
		dryRun: "mutating"
	}).action(async (opts) => {
		const featureDir = await ctx.dispatchOrFail(opts);
		if (featureDir === null) return;
		const session = await loadSession(featureDir, { ensureDir: !ctx.dryRun });
		if (!session.snapshot.state) {
			ctx.failure(diagnosticVariant("failure.no_session.pending", { feature: opts.feature }));
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
		if (!await mutator.run(featureDir, session, {
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
	declareCommandPolicy(pendingCmd.command("list").description("List pending entries (FIFO; first unresolved is head)").option("--feature <name>", "Feature whose pending to list").option("--feature-dir <path>", "Override default .loaf/<feature> directory"), {
		selectors: "selected",
		dryRun: "read-only"
	}).action(async (opts) => {
		const featureDir = await ctx.dispatchOrFail(opts);
		if (featureDir === null) return;
		const loaded = await ctx.loadProjectionsOrFail(featureDir, ["pending"], opts.feature, "failure.no_session.pending");
		if (loaded === null) return;
		const entries = loaded.pending.pending;
		const headIdx = pendingHeadIndex(entries);
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
	declareCommandPolicy(pendingCmd.command("status").description("Status of head pending entry (default) or specific entry by --id").option("--feature <name>", "Feature whose pending to inspect").option("--id <id>", "Lookup a specific PEND-id (default: head)").option("--feature-dir <path>", "Override default .loaf/<feature> directory"), {
		selectors: "selected",
		dryRun: "read-only"
	}).action(async (opts) => {
		const featureDir = await ctx.dispatchOrFail(opts);
		if (featureDir === null) return;
		const session = await loadSession(featureDir, { ensureDir: !ctx.dryRun });
		if (!session.snapshot.state) {
			ctx.failure(diagnosticVariant("failure.no_session.pending", { feature: opts.feature }));
			return;
		}
		const headIdx = pendingHeadIndex(session.snapshot.pending);
		let target;
		if (opts.id !== void 0) {
			const idx = session.snapshot.pending.findIndex((p) => p.id === opts.id);
			if (idx === -1) {
				ctx.failure(diagnostic$2("PENDING_NOT_FOUND", {
					reason: "pending_id_not_found",
					pending_id: opts.id
				}));
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
	declareCommandPolicy(pendingCmd.command("resolve").description("Resolve the head pending entry (strict FIFO; no --id flag)").requiredOption("--answer <text>", "Resolution answer (passthrough into pending:resolved payload)").option("--feature <name>", "Feature whose pending to resolve").option("--feature-dir <path>", "Override default .loaf/<feature> directory"), {
		selectors: "selected",
		dryRun: "mutating"
	}).action(async (opts) => {
		const featureDir = await ctx.dispatchOrFail(opts);
		if (featureDir === null) return;
		const session = await loadSession(featureDir, { ensureDir: !ctx.dryRun });
		if (!session.snapshot.state) {
			ctx.failure(diagnosticVariant("failure.no_session.pending", { feature: opts.feature }));
			return;
		}
		const head = pendingHead(session.snapshot.pending);
		if (!head) {
			ctx.failure(diagnostic$2("PENDING_NOT_FOUND", { reason: "no pending head" }));
			return;
		}
		if (!await mutator.run(featureDir, session, {
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
//#region src/cli/commands/evidence.tsx
function normalizedCovers(covers) {
	if (!covers || covers.length === 0) return "";
	return [...new Set(covers)].sort().join(",");
}
function formatCovers(i18n, covers) {
	if (!covers || covers.length === 0) return i18n.t(SUCCESS_KEYS.evidenceCoversNone);
	return [...new Set(covers)].sort().join(",");
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
function registerEvidence(program, ctx, mutator, actor, input) {
	const inputDeclaration = {
		command: "loaf evidence add",
		helpPrefix: "JSON authoring source (single object OR non-empty array)",
		inlineLabel: "inline JSON",
		helpSuffix: "; internal sidecar refs are rejected"
	};
	const evidenceCmd = program.command("evidence").description("Evidence ledger commands (add, list)");
	declareCommandPolicy(evidenceCmd.command("add").description("Append evidence entry/entries from --input <src> JSON (CLI allocates EV-id; single object or non-empty array for batch)").option("--input <src>", jsonInputHelp(inputDeclaration)).option("--schema", "Dump the input JSON Schema instead of mutating (Phase 16 SC-10)").option("--feature <name>", "Feature whose ledger to append to").option("--feature-dir <path>", "Override default .loaf/<feature> directory"), {
		selectors: "selected",
		dryRun: "mutating",
		schema: {
			kind: "input",
			key: "evidence:add"
		}
	}).action(async (rawOpts) => {
		if (!input.requireArg(ctx, rawOpts.input, inputDeclaration)) return;
		const opts = rawOpts;
		if (await ctx.dispatchOrFail(opts) === null) return;
		const read = await input.readJson(ctx, opts.input, inputDeclaration);
		if (!read.ok) return;
		const parsed = read.value;
		const rawItems = Array.isArray(parsed) ? parsed : [parsed];
		if (rawItems.length === 0) {
			ctx.failure(diagnostic$2("SCHEMA_VALIDATION_FAILED", {
				reason: "evidence_batch_empty",
				command: "evidence add"
			}));
			return;
		}
		const validatedInputs = [];
		for (let i = 0; i < rawItems.length; i++) {
			const raw = rawItems[i];
			const p = EvidenceAddInput.safeParse(raw);
			if (!p.success) {
				ctx.failure(diagnostic$2("SCHEMA_VALIDATION_FAILED", {
					reason: p.error.issues.map((issue) => issue.message).join("; "),
					index: i,
					issues: p.error.issues
				}));
				return;
			}
			validatedInputs.push(p.data);
		}
		const featureDir = await ctx.dispatchOrFail(opts);
		if (featureDir === null) return;
		const session = await ctx.resolveSession(featureDir);
		if (!session.snapshot.state) {
			ctx.failure(diagnosticVariant("failure.no_session.generic", { feature: opts.feature }));
			return;
		}
		const evIds = allocateNextEvidenceIds(session.snapshot, validatedInputs.length);
		const compatibilityMismatches = validatedInputs.flatMap((input, i) => {
			const evidence = {
				id: evIds[i],
				kind: input.kind,
				result: input.result,
				covers: input.covers,
				actor: input.actor,
				...input.check !== void 0 ? { check: input.check } : {},
				...input.reason !== void 0 ? { reason: input.reason } : {},
				...input.attachments !== void 0 ? { attachments: input.attachments } : {}
			};
			return evidence.covers.flatMap((coveredId) => {
				const mismatch = evidenceCompatibilityMismatch(evidence, coveredId);
				return mismatch === null ? [] : [mismatch];
			});
		});
		const entries = validatedInputs.map((input, i) => ({
			kind: "evidence:added",
			payload: {
				...input,
				id: evIds[i]
			},
			actor
		}));
		const result = await mutator.run(featureDir, session, entries);
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
		}, () => evIds.join("\n") + "\n", (i18n) => ({
			stateChange: evidenceAddStateChange(i18n, evidenceItems),
			warnings: compatibilityMismatches.map((mismatch) => i18n.t(CHROME_KEYS.evidenceCompatibilityWarning, {
				kind: mismatch.supplied_kind,
				covered_id: mismatch.covered_id,
				allowed_kinds: mismatch.allowed_kinds.join(", ")
			}))
		}));
		else ctx.success({
			ok: true,
			feature: opts.feature,
			id: evIds[0],
			kind: validatedInputs[0].kind
		}, () => `${evIds[0]}\n`, (i18n) => ({
			stateChange: evidenceAddStateChange(i18n, evidenceItems),
			warnings: compatibilityMismatches.map((mismatch) => i18n.t(CHROME_KEYS.evidenceCompatibilityWarning, {
				kind: mismatch.supplied_kind,
				covered_id: mismatch.covered_id,
				allowed_kinds: mismatch.allowed_kinds.join(", ")
			}))
		}));
	});
	declareCommandPolicy(evidenceCmd.command("list").description("List evidence coverage fields from the evidence projection (read-only)").option("--covers <id>", "Filter entries whose covers array contains id").option("--task <T-N>", "Filter entries linked to a task id").option("--kind <kind>", "Filter by the closed EvidenceKind enum").option("--feature <name>", "Feature whose evidence to list").option("--feature-dir <path>", "Override default .loaf/<feature> directory"), {
		selectors: "selected",
		dryRun: "read-only"
	}).action(async (opts) => {
		if (opts.covers !== void 0 && !CoversRefPayload.safeParse(opts.covers).success) {
			ctx.failure(diagnosticVariant("failure.evidence.covers_invalid", {
				value: opts.covers,
				value: opts.covers
			}));
			return;
		}
		if (opts.task !== void 0 && !TaskIdPayload.safeParse(opts.task).success) {
			ctx.failure(diagnosticVariant("failure.evidence.task_invalid", {
				value: opts.task,
				value: opts.task
			}));
			return;
		}
		if (opts.kind !== void 0 && !EvidenceKind.safeParse(opts.kind).success) {
			ctx.failure(diagnosticVariant("failure.evidence.kind_invalid", {
				value: opts.kind,
				allowed_kinds_human: EvidenceKind.options.join(" | "),
				value: opts.kind,
				allowed: EvidenceKind.options
			}));
			return;
		}
		const featureDir = await ctx.dispatchOrFail(opts);
		if (featureDir === null) return;
		const loaded = await ctx.loadProjectionsOrFail(featureDir, ["evidence"], opts.feature, "failure.no_session.generic");
		if (loaded === null) return;
		const rows = loaded.evidence.evidence.filter((entry) => (opts.covers === void 0 || entry.covers.includes(opts.covers)) && (opts.task === void 0 || entry.task_id === opts.task) && (opts.kind === void 0 || entry.kind === opts.kind)).map((entry) => ({
			id: entry.id,
			kind: entry.kind,
			covers: entry.covers,
			task_id: entry.task_id ?? null,
			at: entry.at,
			actor: entry.actor
		}));
		ctx.success({
			ok: true,
			feature: opts.feature,
			count: rows.length,
			evidence: rows
		}, (i18n) => {
			if (rows.length === 0) return i18n.t(CHROME_KEYS.evidenceListEmpty) + "\n";
			return rows.map((row) => i18n.t(CHROME_KEYS.evidenceListRow, {
				id: row.id,
				kind: row.kind,
				covers: row.covers.join(",") || "-",
				task_id: row.task_id ?? "-",
				at: row.at,
				actor: row.actor
			}) + "\n").join("");
		});
	});
	declareCommandPolicy(program.command("waive <obligation-id>").description("Record a waiver evidence (kind=waiver) against an obligation id (REQ-/SCEN-/VIS-/T-)").requiredOption("--reason <text>", "Waiver rationale (≥10 chars; mandatory per evidence schema refine)").option("--feature <name>", "Feature whose ledger to append to").option("--feature-dir <path>", "Override default .loaf/<feature> directory"), {
		selectors: "selected",
		dryRun: "mutating"
	}).action(async (obligationId, opts) => {
		if (!CoversRefPayload.safeParse(obligationId).success) {
			ctx.failure(diagnostic$2("USAGE", {
				reason: "invalid_obligation_id",
				argument: obligationId
			}));
			return;
		}
		if (opts.reason.length < 10) {
			ctx.failure(diagnosticVariant("failure.lessons.reason_too_short", {
				min_length: 10,
				reason_length: opts.reason.length,
				min_length: 10,
				reason_length: opts.reason.length
			}));
			return;
		}
		const waiveActor = ctx.resolveHumanActorOrFail();
		if (waiveActor === null) return;
		const featureDir = await ctx.dispatchOrFail(opts);
		if (featureDir === null) return;
		const session = await loadSession(featureDir, { ensureDir: !ctx.dryRun });
		if (!session.snapshot.state) {
			ctx.failure(diagnosticVariant("failure.no_session.generic", { feature: opts.feature }));
			return;
		}
		const evidenceId = allocateNextEvidenceId(session.snapshot);
		const payload = buildWaiveEvidencePayload({
			evidenceId,
			obligationId,
			reason: opts.reason,
			actor: waiveActor,
			iteration: session.snapshot.state.iteration
		});
		if (!await mutator.run(featureDir, session, {
			kind: "evidence:added",
			payload,
			actor: waiveActor
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
	return { evidenceCmd };
}
//#endregion
//#region src/cli/commands/journal.ts
const JOURNAL_KINDS = Object.keys(KIND_REGISTRY);
function registerJournal(program, ctx) {
	declareCommandPolicy(program.command("journal").alias("log").description("Journal inspection commands (list; `loaf log` alias)").command("list", { isDefault: true }).description("List journal entry envelopes without interpreting payloads (read-only)").option("--after-seq <n>", "Only include entries whose seq is greater than n").option("--limit <n>", "Return at most n entries in journal order").option("--kind <kind>", "Filter by the closed journal kind registry").option("--actor <prefix-or-full>", "Filter by actor prefix or full actor string").option("--feature <name>", "Feature whose journal to list").option("--feature-dir <path>", "Override default .loaf/<feature> directory"), {
		selectors: "selected",
		dryRun: "read-only"
	}).action(async (opts) => {
		const afterSeq = parseIntegerFilter(ctx, "--after-seq", opts.afterSeq, 0);
		if (afterSeq === null) return;
		const limit = parseIntegerFilter(ctx, "--limit", opts.limit, 1);
		if (limit === null) return;
		if (opts.kind !== void 0 && !Object.hasOwn(KIND_REGISTRY, opts.kind)) {
			ctx.failure(diagnosticVariant("failure.journal.kind_invalid", {
				value: opts.kind,
				value: opts.kind,
				allowed: JOURNAL_KINDS
			}));
			return;
		}
		if (opts.actor !== void 0 && opts.actor.length === 0) {
			ctx.failure(diagnosticVariant("failure.journal.actor_invalid", {}));
			return;
		}
		const featureDir = await ctx.dispatchOrFail(opts);
		if (featureDir === null) return;
		const session = await loadSession(featureDir, { ensureDir: false });
		if (session.snapshot.state === null) {
			ctx.failure(diagnosticVariant("failure.no_session.generic", { feature: opts.feature }));
			return;
		}
		let entries = session.entries.filter((entry) => (afterSeq === void 0 || entry.seq > afterSeq) && (opts.kind === void 0 || entry.kind === opts.kind) && (opts.actor === void 0 || entry.actor.startsWith(opts.actor)));
		if (limit !== void 0) entries = entries.slice(0, limit);
		const rows = entries.map(toJournalListRow);
		ctx.success({
			ok: true,
			feature: opts.feature,
			count: rows.length,
			entries: rows
		}, (i18n) => renderJournalRows(i18n, rows));
	});
}
function parseIntegerFilter(ctx, flag, value, minimum) {
	if (value === void 0) return void 0;
	if (!/^\d+$/.test(value)) {
		ctx.failure(diagnosticVariant("failure.journal.integer_invalid", {
			flag,
			value,
			minimum,
			flag,
			value,
			minimum
		}));
		return null;
	}
	const parsed = Number(value);
	if (!Number.isSafeInteger(parsed) || parsed < minimum) {
		ctx.failure(diagnosticVariant("failure.journal.integer_invalid", {
			flag,
			value,
			minimum,
			flag,
			value,
			minimum
		}));
		return null;
	}
	return parsed;
}
function toJournalListRow(entry) {
	const row = {
		seq: entry.seq,
		entry_id: entry.entry_id,
		at: entry.at,
		actor: entry.actor,
		kind: entry.kind
	};
	if (entry.batch_id !== void 0 && entry.batch_index !== void 0 && entry.batch_count !== void 0) {
		row.batch_id = entry.batch_id;
		row.batch_index = entry.batch_index;
		row.batch_count = entry.batch_count;
	}
	return row;
}
function renderJournalRows(i18n, rows) {
	if (rows.length === 0) return i18n.t(CHROME_KEYS.journalListEmpty) + "\n";
	return rows.map((row) => i18n.t(row.batch_id === void 0 ? CHROME_KEYS.journalListRow : CHROME_KEYS.journalListRowBatch, {
		seq: row.seq,
		entry_id: row.entry_id,
		at: row.at,
		actor: row.actor,
		kind: row.kind,
		batch_id: row.batch_id,
		batch_index: row.batch_index,
		batch_count: row.batch_count
	}) + "\n").join("");
}
//#endregion
//#region src/cli/lesson-id-allocator.ts
/** Allocate the next independent lesson id from canonical journal history. */
function allocateNextLessonId(entries) {
	const serial = nextSerialInNamespace(entries.filter((entry) => entry.kind === "lesson:recorded").map((entry) => LessonRecordedPayload.parse(entry.payload).id), "LSN");
	return `LSN-${String(serial).padStart(3, "0")}`;
}
//#endregion
//#region src/cli/lessons-add.ts
function chooseSummary(lessonText) {
	return Buffer.byteLength(lessonText, "utf8") > 8192 ? {
		mode: "inline",
		text: lessonText
	} : lessonText;
}
function buildLessonRecordedPayload(args) {
	return {
		id: args.lessonId,
		iteration: args.iteration,
		reason: args.reason,
		summary: chooseSummary(args.lessonText)
	};
}
//#endregion
//#region src/cli/commands/lessons.tsx
function registerLessons(program, ctx, mutator, _actor) {
	declareCommandPolicy(program.command("lessons").description("Lessons-learned journal commands").command("add").description("Record a lesson entry (--text inline OR --file <path>)").option("--text <inline>", "Lesson body text (inline). Mutex with --file.").option("--file <path>", "Read lesson body from file. Mutex with --text.").requiredOption("--reason <text>", "Why this lesson matters (≥10 chars; mandatory per evidence schema refine)").option("--feature <name>", "Feature whose ledger to append to").option("--feature-dir <path>", "Override default .loaf/<feature> directory"), {
		selectors: "selected",
		dryRun: "mutating"
	}).action(async (opts) => {
		const hasText = opts.text !== void 0;
		const hasFile = opts.file !== void 0;
		if (hasText === hasFile) {
			ctx.failure(diagnosticVariant("failure.lessons.text_file_mutex", {
				provided_state: hasText ? "both provided" : "neither provided",
				text_provided: hasText,
				file_provided: hasFile
			}));
			return;
		}
		let lessonText;
		if (hasText) lessonText = opts.text;
		else try {
			lessonText = await promises.readFile(opts.file, "utf8");
		} catch (err) {
			if (err.code === "ENOENT") {
				ctx.failure(diagnosticVariant("failure.lessons.file_missing", {
					path: opts.file,
					path: opts.file
				}));
				return;
			}
			throw err;
		}
		if (lessonText.length < 3) {
			ctx.failure(diagnosticVariant("failure.lessons.text_too_short", {
				min_length: 3,
				lesson_text_length: lessonText.length,
				min_length: 3,
				lesson_text_length: lessonText.length
			}));
			return;
		}
		if (opts.reason.length < 10) {
			ctx.failure(diagnosticVariant("failure.lessons.reason_too_short", {
				min_length: 10,
				reason_length: opts.reason.length,
				min_length: 10,
				reason_length: opts.reason.length
			}));
			return;
		}
		const actor = ctx.resolveHumanActorOrFail();
		if (actor === null) return;
		const featureDir = await ctx.dispatchOrFail(opts);
		if (featureDir === null) return;
		const session = await loadSession(featureDir, { ensureDir: !ctx.dryRun });
		if (!session.snapshot.state) {
			ctx.failure(diagnosticVariant("failure.no_session.generic", { feature: opts.feature }));
			return;
		}
		const lessonId = allocateNextLessonId(session.entries);
		const payload = buildLessonRecordedPayload({
			lessonId,
			lessonText,
			reason: opts.reason,
			iteration: session.snapshot.state.iteration
		});
		const result = await mutator.run(featureDir, session, {
			kind: "lesson:recorded",
			payload,
			actor
		});
		if (!result) return;
		const selector = await selectorForCommandContext(ctx);
		ctx.success({
			ok: true,
			feature: opts.feature,
			id: lessonId,
			kind: "lesson:recorded"
		}, () => `${lessonId}\n`, (i18n) => {
			const next = buildNextAdvisoryFromSnapshot(i18n, result.snapshot, featureDir, selector);
			return {
				stateChange: i18n.t(SUCCESS_KEYS.lessonsAddStateChange, { lesson_id: lessonId }),
				...next === void 0 ? {} : { next }
			};
		});
	});
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
			pending_head_kind: reg.pending?.kind ?? null,
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
		schema: SpecFrontmatter
	},
	tasks: {
		basename: "tasks.json",
		parse: "json",
		schema: TasksJson
	},
	evidence: {
		basename: "evidence.json",
		parse: "json",
		schema: EvidenceJson
	},
	finding: {
		basename: "findings.json",
		parse: "json",
		schema: FindingsJson
	},
	pending: {
		basename: "pending.json",
		parse: "json",
		schema: PendingJson
	},
	state: {
		basename: "state.json",
		parse: "json",
		schema: StateProjection
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
		detail: {
			subject: opts.path,
			kind: "tasks",
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
			detail: { path: absPath }
		};
		throw err;
	}
	const kind = resolveKind(opts.path, opts.kind);
	if (kind === null) return {
		ok: false,
		code: "USAGE",
		detail: {
			reason: "artifact_kind_unknown",
			allowed_kinds: CHECK_KINDS,
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
			detail: {
				kind,
				path: absPath,
				reason: "missing-frontmatter",
				subcode: "missing-frontmatter"
			}
		};
		try {
			parsed = parse(frontmatter);
		} catch (err) {
			return {
				ok: false,
				code: "SCHEMA_VALIDATION_FAILED",
				detail: {
					kind,
					path: absPath,
					reason: err.message,
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
			detail: {
				kind,
				path: absPath,
				reason: err.message,
				subcode: "invalid-json"
			}
		};
	}
	const result = entry.schema.safeParse(parsed);
	if (!result.success) {
		const issues = mapZodIssues(result.error);
		return {
			ok: false,
			...diagnosticVariant("failure.schema.validation", {
				kind,
				path: absPath,
				subcode: "zod",
				error_word: issues.error_count === 1 ? "error" : "errors",
				...issues
			})
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
//#region src/cli/verify-status.ts
/** Build the JSON envelope from evaluateAllChecks output. */
function buildEnvelope(checks, findings, lanes) {
	return {
		ok: true,
		all_pass: checks.every((r) => r.status !== "fail"),
		deferred_findings: findings.filter((finding) => finding.status === "open" && isFindingDeferralAction(finding.action)).map((finding) => ({
			id: finding.id,
			action: finding.action
		})),
		lanes,
		checks: checks.map((row) => ({
			...row,
			failures: row.failures.map((failure) => {
				const { detail, ...fields } = failure;
				return {
					...fields,
					message: diagnosticMessage(failure),
					...Object.keys(detail).length > 0 ? { detail } : {}
				};
			})
		}))
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
const LANE_REASON_KEYS = {
	no_done_tasks: CHROME_KEYS.verifyStatusLaneReasonNoDoneTasks,
	no_review_obligations: CHROME_KEYS.verifyStatusLaneReasonNoReviewObligations,
	no_applicable_e2e_scenarios: CHROME_KEYS.verifyStatusLaneReasonNoE2eScenarios,
	no_applicable_visual_contracts: CHROME_KEYS.verifyStatusLaneReasonNoVisualContracts
};
function renderText(env, i18n = DEFAULT_I18N) {
	const labels = Object.fromEntries(env.checks.map((row) => [row.check, checkLabel(row.check, i18n)]));
	const laneLabels = env.lanes.map((lane) => i18n.t(CHROME_KEYS.verifyStatusLaneLabel, { lane: i18n.t(verifyCheckKindKey(lane.lane)) }));
	const deferredLabel = i18n.t(CHROME_KEYS.verifyStatusCheckDeferredFindings);
	const labelWidth = Math.max(...Object.values(labels).map((l) => l.length), ...laneLabels.map((label) => label.length), ...env.deferred_findings.length > 0 ? [deferredLabel.length] : []);
	const lines = [];
	for (const row of env.checks) {
		const label = labels[row.check].padEnd(labelWidth);
		const status = statusGlyph(row.status, i18n).padEnd(4);
		lines.push(`${label}  ${status}${failureSummary(row.failures, i18n)}`);
		if (row.status === "fail" && row.failures.length > 1) for (const f of row.failures) lines.push(`    - ${f.code}: ${diagnosticMessage({
			code: f.code,
			detail: f.detail ?? {}
		}, i18n)}`);
	}
	for (const [index, lane] of env.lanes.entries()) {
		const label = laneLabels[index].padEnd(labelWidth);
		const applicability = i18n.t(applicabilityKey(lane.applicability));
		const reason = lane.reason === null ? "" : i18n.t(CHROME_KEYS.verifyStatusLaneReason, { reason: i18n.t(LANE_REASON_KEYS[lane.reason]) });
		lines.push(`${label}  ${applicability}${reason}`);
	}
	if (env.deferred_findings.length > 0) {
		const findings = env.deferred_findings.map((finding) => `${finding.id} (${finding.action})`).join(", ");
		lines.push(`${deferredLabel.padEnd(labelWidth)}  ${i18n.t(CHROME_KEYS.verifyStatusInfo).padEnd(4)}${i18n.t(CHROME_KEYS.verifyStatusDeferredSummary, { findings })}`);
	}
	lines.push(env.all_pass ? "" : i18n.t(CHROME_KEYS.verifyStatusDiagnosticOnly));
	return lines.join("\n") + "\n";
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
//#region src/core/sub-state-contracts.ts
const MutationRights = z.object({
	writable_fields: z.array(z.string()).default([]),
	forbidden_fields: z.array(z.string()).default([])
});
z.object({
	sub_state: SubState,
	entry: z.string(),
	exit: z.string(),
	write_paths: z.array(z.string()),
	mutation_rights: MutationRights.optional(),
	next: z.array(SubState),
	prompt_inject: z.string()
});
/** sub_state → contract lookup (built once from the derived contract objects). */
const SUB_STATE_CONTRACT_BY_STATE = Object.fromEntries(SUB_STATE_CONTRACTS$1.map((contract) => [contract.sub_state, contract]));
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
*   2. open findings summary — actionable findings remain warnings; deferred
*      findings remain visible as carried-work information.
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
	const actionable = open.filter((f) => !isFindingDeferralAction(f.action));
	const deferred = open.filter((f) => isFindingDeferralAction(f.action));
	if (actionable.length > 0) warnings.push(`open actionable findings (${actionable.length}): ${actionable.map((f) => f.id).join(", ")}`);
	if (deferred.length > 0) warnings.push(`deferred findings carried (${deferred.length}): ${deferred.map((f) => `${f.id} (${f.action})`).join(", ")}`);
	return warnings;
}
//#endregion
//#region src/cli/session-status.ts
function classifySessionStatus(row) {
	if (row.sub_state.startsWith("DONE.")) return "done";
	if (row.pending_queue_depth > 0) return "blocked";
	if (row.active_tasks.length > 0) return "running";
	return "idle";
}
function classifyPendingHead(kind) {
	if (kind === null) return null;
	return kind === "gate_decision" || kind === "profile_escalation" ? "decision" : "question";
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
function statusBucket$1(row) {
	return classifySessionStatus(row);
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
		return item;
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
			const byStatus = statusBucketRank(statusBucket$1(a)) - statusBucketRank(statusBucket$1(b));
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
	const pendingLabel = row.pending_head_kind === null ? i18n.t(statusIndicatorKey("blocked")) : i18n.t(pendingKindKey(row.pending_head_kind));
	if (row.pending_queue_depth >= 2) return `${pendingLabel} [×${row.pending_queue_depth}]`;
	if (row.pending_queue_depth === 1) return pendingLabel;
	if (row.active_tasks.length >= 2) return `${i18n.t(statusIndicatorKey("running"))} [×${row.active_tasks.length}]`;
	if (row.active_tasks.length === 1) return i18n.t(statusIndicatorKey("running"));
	return formatPhaseSub(row, i18n);
}
/** STATUS badge for rows that already render sub_state elsewhere. */
function formatStatusBadge(row, i18n) {
	if (statusBucket$1(row) === "idle") return i18n.t(statusIndicatorKey("idle"));
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
		fix: detailFix$1(error.detail)
	};
	if (error instanceof SnapshotStaleError) return {
		status: "stale",
		reason: error.reason,
		message: i18n.t(CHROME_KEYS.tuiDetailStaleMessage, { reason: error.reason }),
		fix: detailFix$1(error.detail)
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
			title: optionalStringField$1(task, "title"),
			step_summary: formatStepSummary(task.execution, i18n)
		})),
		evidence: evidence.evidence.map((entry) => ({
			id: entry.id,
			kind: i18n.t(evidenceKindKey(entry.kind)),
			result: entry.result,
			result_badge: resultBadge(entry.result),
			summary: truncateHighSignal(summaryText$1(entry.summary, i18n)),
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
		pending: livePending(pending.pending).map((entry) => ({
			pending_id: entry.pending_id,
			kind: i18n.t(pendingKindKey(entry.kind)),
			question: entry.question,
			blocks: entry.blocks,
			options: entry.options ?? []
		}))
	};
}
function detailFix$1(detail) {
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
function summaryText$1(summary, i18n) {
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
function optionalStringField$1(value, field) {
	if (typeof value !== "object" || value === null) return null;
	const candidate = value[field];
	return typeof candidate === "string" && candidate.length > 0 ? candidate : null;
}
//#endregion
//#region src/cli/commands/integrations.tsx
function registerIntegrations(program, ctx, _mutator, _actor, i18n, isStdinTty, renderTuiImpl, isStdoutTtyForTui, registryDir, now, runtimeDir, runtimeNow) {
	declareCommandPolicy(program.command("hook <event>").description("Claude Code hook entry point (session-start + closure-check read-side; write-guard + scope-track land SC-15c)").option("--list-events", "Dump the canonical 4-event enum (handled by pre-parse guard)").option("--feature <name>", "Feature whose session to read (read-side events)").option("--feature-dir <path>", "Override default .loaf/<feature> directory").option("--session <uuid>", "Resolve session by registry UUID (read-side events)").option("--path <text>", "Tool target path (for write-guard / scope-track; SC-15c)"), {
		selectors: "optional-hook",
		dryRun: "hook"
	}).action(async (event, opts) => {
		if (event === "session-start") {
			const d = await ctx.dispatchForHookOptional(opts);
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
			const d = await ctx.dispatchForHookOptional(opts);
			if ("skip" in d) {
				if (d.stale) process.stderr.write(`warning: closure-check skipped — ${diagnosticMessage(d.stale)}\n`);
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
			const target = await ctx.resolveHookPath(opts);
			if (target === null) return;
			let dispatch;
			try {
				dispatch = await ctx.resolveDispatch();
			} catch (error) {
				ctx.failure({
					code: "SNAPSHOT_STALE_REBUILD_REQUIRED",
					detail: { reason: error.message }
				});
				return;
			}
			if (!dispatch.ok) {
				if (dispatch.code === "FEATURE_NOT_FOUND") return;
				ctx.failure(dispatch);
				return;
			}
			opts.feature = dispatch.feature;
			opts.featureDir = dispatch.featureDir;
			ctx.recordTraceTarget(dispatch.feature, dispatch.featureDir);
			const sessionId = dispatch.sessionId;
			if (sessionId === null) {
				ctx.failure({
					code: "SCHEMA_VALIDATION_FAILED",
					detail: {
						source: "scope-track",
						reason: "selected_session_id_missing"
					}
				});
				return;
			}
			const repoRoot = path.dirname(path.dirname(dispatch.featureDir));
			let state;
			try {
				state = (await loadProjections({
					feature_dir: dispatch.featureDir,
					kinds: ["state"]
				})).state;
			} catch (error) {
				ctx.failure({
					code: "SNAPSHOT_STALE_REBUILD_REQUIRED",
					detail: error instanceof SnapshotStaleError ? error.detail : { reason: error.message }
				});
				return;
			}
			let normalized;
			try {
				normalized = await trackPendingScope({
					targetPath: target,
					featureDir: dispatch.featureDir,
					identity: {
						session_id: sessionId,
						cwd: repoRoot
					},
					debug: ctx.debug,
					cursor: {
						sub_state: state.sub_state,
						iteration: state.iteration
					},
					runtime: {
						runtimeDir,
						now: runtimeNow
					}
				});
			} catch (error) {
				ctx.failure(error instanceof RuntimeStoreError ? runtimeStoreDiagnostic(error, "session-runtime") : {
					code: "SCHEMA_VALIDATION_FAILED",
					detail: {
						source: "session-runtime",
						reason: error.message
					}
				});
				return;
			}
			if (!normalized.ok) ctx.failure({
				code: "SCHEMA_VALIDATION_FAILED",
				detail: {
					source: "scope-track",
					path: target,
					reason: normalized.reason
				}
			});
			return;
		}
		const target = await ctx.resolveHookPath(opts);
		if (target === null) return;
		const wd = await ctx.resolveDispatchForWriteGuard(opts);
		if ("allow" in wd) return;
		if ("failClosed" in wd) {
			ctx.failure(wd);
			return;
		}
		const repoRoot = path.dirname(path.dirname(wd.featureDir));
		const feature = opts.feature;
		const cfg = await readLoafConfig(repoRoot);
		if (cfg.status === "invalid") {
			ctx.failure(diagnosticVariant("failure.write_guard.config_invalid", {
				reason: cfg.reason,
				source: "loaf.config.json",
				reason: cfg.reason
			}));
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
			ctx.failure({
				code: "SNAPSHOT_STALE_REBUILD_REQUIRED",
				detail: err instanceof SnapshotStaleError ? err.detail : { reason: err.message }
			});
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
			ctx.failure(diagnostic$2("PROTECTED_FILE_WRITE", {
				path: target,
				normalized_path: decision.normalizedPath,
				matched_deny: decision.matchedDeny
			}));
			return;
		}
		ctx.failure(diagnostic$2("WRITE_PATH_VIOLATION", {
			path: target,
			normalized_path: decision.normalizedPath,
			sub_state: state.sub_state,
			allow_set: decision.allowSet.slice(0, 30),
			...decision.reason ? { reason: decision.reason } : {}
		}));
	});
	const resolvedRenderTui = renderTuiImpl ?? defaultRenderTui;
	declareCommandPolicy(program.command("tui").description("Interactive session manager TUI (Ink; read-only, MVP)"), {
		selectors: "forbidden",
		dryRun: "read-only",
		selectorFailure: "failure.tui.selector_conflict",
		interactiveFormat: true
	}).action(async () => {
		const stdinTty = isStdinTty();
		const stdoutTty = isStdoutTtyForTui();
		if (!stdinTty || !stdoutTty) {
			ctx.failure(diagnosticVariant("failure.tui.interactive_only", {
				stdin_tty: stdinTty,
				stdout_tty: stdoutTty
			}));
			return;
		}
		const loadRows = async () => {
			return (await listSessions(registryDir !== void 0 ? { registryDir } : {})).rows;
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
		await resolvedRenderTui(createElement(App, {
			initialRows: await loadRows(),
			loadRows,
			loadDetail,
			i18n
		}));
	});
	declareCommandPolicy(program.command("sessions").description("Session registry commands (list)").command("list").description("List session registry entries (read-only; --in-cwd filters by current cwd)").option("--in-cwd", "Only list sessions whose registered cwd matches the current cwd"), {
		selectors: "forbidden",
		dryRun: "read-only",
		selectorFailure: "failure.sessions_list.selector_conflict"
	}).action(async (opts) => {
		const filterCwd = opts.inCwd ? await promises.realpath(process.cwd()).catch(() => process.cwd()) : void 0;
		const result = await listSessions({
			...registryDir !== void 0 && { registryDir },
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
		const nowDate = now?.() ?? /* @__PURE__ */ new Date();
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
	declareCommandPolicy(program.command("check <path>").description("Validate an artifact file against its schema (read-only; CI-friendly)").option("--kind <kind>", `Artifact kind (one of ${CHECK_KINDS.join("|")}); auto-detected from basename when omitted`), {
		selectors: "forbidden",
		dryRun: "read-only",
		selectorFailure: "failure.check.selector_conflict"
	}).action(async (filePath, opts) => {
		let kind;
		if (opts.kind !== void 0) {
			if (!CHECK_KINDS.includes(opts.kind)) {
				ctx.failure(diagnosticVariant("failure.check.kind_invalid", {
					value: opts.kind,
					allowed_kinds_human: CHECK_KINDS.join("|"),
					provided: opts.kind,
					value: opts.kind,
					allowed: CHECK_KINDS
				}));
				return;
			}
			kind = opts.kind;
		}
		const result = await checkFile(kind === void 0 ? { path: filePath } : {
			path: filePath,
			kind
		});
		if (result.ok) {
			ctx.success(result, (checkI18n) => renderSuccessText(result, checkI18n));
			return;
		}
		if (result.code === "USAGE" && result.detail["suggestion"] !== void 0) {
			ctx.failure(diagnosticVariant("failure.check.kind_required", {
				subject: String(result.detail["argument"] ?? filePath),
				kind: "tasks",
				suggestion: String(result.detail["suggestion"]),
				...result.detail
			}));
			return;
		}
		if (result.code === "INPUT_FILE_NOT_FOUND") {
			ctx.failure(diagnosticVariant("failure.check.path_missing", {
				path: String(result.detail["path"] ?? filePath),
				...result.detail
			}));
			return;
		}
		if (result.code === "SCHEMA_VALIDATION_FAILED" && result.detail["kind"] !== void 0 && result.detail["path"] !== void 0 && result.detail["error_count"] !== void 0) {
			ctx.failure(diagnosticVariant("failure.schema.validation", {
				kind: String(result.detail["kind"]),
				path: String(result.detail["path"]),
				error_count: String(result.detail["error_count"]),
				error_word: Number(result.detail["error_count"]) === 1 ? "error" : "errors",
				...result.detail
			}));
			return;
		}
		ctx.failure(result);
	});
	declareCommandPolicy(program.command("verify").description("Verify-accept gate read commands (status)").command("status").description("Show per-check verify-accept diagnostic (read-only)").option("--feature <name>", "Feature whose verify status to show").option("--feature-dir <path>", "Override default .loaf/<feature> directory"), {
		selectors: "selected",
		dryRun: "read-only"
	}).action(async (opts) => {
		const featureDir = await ctx.dispatchOrFail(opts);
		if (featureDir === null) return;
		const session = await loadSession(featureDir, { ensureDir: !ctx.dryRun });
		const diag = evaluateVerifyAcceptDiagnostic(session.snapshot);
		if (!diag.ok) {
			ctx.failure(diag);
			return;
		}
		const env = buildEnvelope(diag.checks, session.snapshot.findings, diag.lanes);
		ctx.success(env, (verI18n) => renderText(env, verI18n));
	});
}
//#endregion
//#region src/cli/commands/finding.tsx
function formatFindingCategory(i18n, category) {
	if (i18n.locale === "en") return category;
	const parsed = FindingCategory.safeParse(category);
	return parsed.success ? i18n.t(findingCategoryKey(parsed.data)) : category;
}
function formatFindingAction(i18n, action) {
	if (i18n.locale === "en") return action;
	const parsed = FindingAction.safeParse(action);
	return parsed.success ? i18n.t(findingActionKey(parsed.data)) : action;
}
function formatFindingStatus(i18n, status) {
	return i18n.t(findingStatusKey(status));
}
function registerFinding(program, ctx, mutator, actor) {
	const findingCmd = program.command("finding").description("Finding ledger commands (Slice 3 SC3 MVP: raise / list / close)");
	declareCommandPolicy(findingCmd.command("raise").description("Raise a new finding (CLI allocates FND-id)").requiredOption("--category <category>", "Finding category (spec-gap | spec-defect | impl-defect | test-defect | new-scope | risk-escalation)").requiredOption("--action <action>", "Finding action (amend-spec | amend-tasks | fix-impl | fix-test | defer | backlog)").option("--summary <text>", "One-line finding summary (passthrough)").option("--reason <text>", "Justification (required ≥20 chars on unusual cells)").option("--target-task <task-id>", "Target task for fix-impl / fix-test / amend-tasks").option("--target-step <step>", "Target step (must equal action's canonical step)").option("--feature <name>", "Feature whose ledger to append to").option("--feature-dir <path>", "Override default .loaf/<feature> directory"), {
		selectors: "selected",
		dryRun: "mutating"
	}).action(async (opts) => {
		const hasTask = opts.targetTask !== void 0;
		const hasStep = opts.targetStep !== void 0;
		if (hasTask !== hasStep) {
			ctx.failure(diagnostic$2("USAGE", { reason: "target_task_step_pair_required" }));
			return;
		}
		const featureDir = await ctx.dispatchOrFail(opts);
		if (featureDir === null) return;
		const session = await loadSession(featureDir, { ensureDir: !ctx.dryRun });
		if (!session.snapshot.state) {
			ctx.failure(diagnosticVariant("failure.no_session.finding", { feature: opts.feature }));
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
			if (!await mutator.run(featureDir, session, {
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
		if (!await mutator.run(featureDir, session, findingBatch.entries)) return;
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
	declareCommandPolicy(findingCmd.command("list").description("List findings (read-only; --status filters open|closed)").option("--feature <name>", "Feature whose findings to list").option("--status <s>", "Filter by status (open | closed)").option("--feature-dir <path>", "Override default .loaf/<feature> directory"), {
		selectors: "selected",
		dryRun: "read-only"
	}).action(async (opts) => {
		if (opts.status !== void 0 && opts.status !== "open" && opts.status !== "closed") {
			ctx.failure(diagnosticVariant("failure.finding.status_invalid", {
				allowed_statuses_human: "open | closed",
				value: opts.status,
				allowed: ["open", "closed"],
				value: opts.status
			}));
			return;
		}
		const featureDir = await ctx.dispatchOrFail(opts);
		if (featureDir === null) return;
		const loaded = await ctx.loadProjectionsOrFail(featureDir, ["findings"], opts.feature, "failure.no_session.finding");
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
	declareCommandPolicy(findingCmd.command("close <fnd-id>").description("Close a finding (emits finding:closed)").option("--feature <name>", "Feature whose ledger to close against").option("--feature-dir <path>", "Override default .loaf/<feature> directory"), {
		selectors: "selected",
		dryRun: "mutating"
	}).action(async (fndId, opts) => {
		const idParse = FindingId.safeParse(fndId);
		if (!idParse.success) {
			ctx.failure(diagnostic$2("INVALID_PAYLOAD", {
				kind: "finding:closed",
				reason: idParse.error.issues.map((issue) => issue.message).join("; "),
				id: fndId,
				issues: idParse.error.issues
			}));
			return;
		}
		const featureDir = await ctx.dispatchOrFail(opts);
		if (featureDir === null) return;
		const session = await loadSession(featureDir, { ensureDir: !ctx.dryRun });
		if (!session.snapshot.state) {
			ctx.failure(diagnosticVariant("failure.no_session.finding", { feature: opts.feature }));
			return;
		}
		const closure = findingForClosure(session.snapshot.findings, fndId);
		if (!closure.ok) {
			ctx.failure(closure);
			return;
		}
		if (!await mutator.run(featureDir, session, {
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
	return { findingCmd };
}
//#endregion
//#region src/cli/spec-status.ts
const CHECK_3_SUPPRESSION = [
	{
		check: 4,
		blocked_by: 3
	},
	{
		check: 6,
		blocked_by: 3
	},
	{
		check: 7,
		blocked_by: 3
	}
];
/** Map internal check objects to the explicit public JSON contract. */
function buildSpecStatusEnvelope(result) {
	const checks = result.ok ? [] : result.checks;
	const failures = checks.map((failure) => ({
		check: failure.check,
		code: failure.code,
		message: diagnosticMessage(failure),
		detail: Object.keys(failure.detail).length === 0 ? null : failure.detail
	}));
	const suppressedChecks = checks.some((failure) => failure.check === 3) ? CHECK_3_SUPPRESSION.map((row) => ({ ...row })) : [];
	return {
		ok: true,
		all_pass: failures.length === 0,
		failures,
		suppressed_checks: suppressedChecks
	};
}
function renderSpecStatusText(env, i18n) {
	if (env.all_pass) return i18n.t(CHROME_KEYS.specStatusPass) + "\n";
	const failureLines = env.failures.map((failure) => i18n.t(CHROME_KEYS.specStatusFailureRow, {
		check: failure.check,
		code: failure.code,
		message: diagnosticMessage({
			code: failure.code,
			detail: failure.detail ?? {}
		}, i18n)
	}) + "\n");
	const suppressedLines = env.suppressed_checks.map((row) => i18n.t(CHROME_KEYS.specStatusSuppressedRow, {
		check: row.check,
		blocked_by: row.blocked_by
	}) + "\n");
	return [...failureLines, ...suppressedLines].join("");
}
//#endregion
//#region src/cli/spec-submit-batch.ts
/** Build the canonical spec-submit batch: 1 head `event:spec_submitted`
*  + N `event:spec_req_added` + M `event:spec_scenario_added` + K
*  `event:spec_visual_added`. All entries share `at` / `actor` and the
*  payload's `spec_version`; each uses its kind's current entry version. */
function buildSpecSubmitBatch(args) {
	const { input, snapshot, actor, now } = args;
	const currentVersion = snapshot.state?.spec_version ?? 0;
	const specVersion = input.spec_version ?? currentVersion + 1;
	const entries = [{
		at: now,
		actor,
		entry_schema_version: ENTRY_SCHEMA_VERSIONS["event:spec_submitted"],
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
		entry_schema_version: ENTRY_SCHEMA_VERSIONS["event:spec_req_added"],
		kind: "event:spec_req_added",
		payload: {
			spec_version: specVersion,
			req
		}
	});
	for (const scen of input.scenarios) entries.push({
		at: now,
		actor,
		entry_schema_version: ENTRY_SCHEMA_VERSIONS["event:spec_scenario_added"],
		kind: "event:spec_scenario_added",
		payload: {
			spec_version: specVersion,
			scenario: scen
		}
	});
	for (const vis of input.visual_contracts) entries.push({
		at: now,
		actor,
		entry_schema_version: ENTRY_SCHEMA_VERSIONS["event:spec_visual_added"],
		kind: "event:spec_visual_added",
		payload: {
			spec_version: specVersion,
			visual: vis
		}
	});
	return entries;
}
//#endregion
//#region src/cli/commands/spec.tsx
const SPEC_SUBMIT_INPUT = {
	command: "loaf spec submit",
	helpPrefix: "JSON source",
	inlineLabel: "inline JSON literal",
	helpSuffix: " (protocol §10.7)"
};
const SPEC_EDIT_INPUT = {
	command: "loaf spec edit",
	helpPrefix: "JSON {\"body\":\"<Markdown>\"} source",
	inlineLabel: "inline JSON",
	helpSuffix: "; preserves current frontmatter"
};
function specAddInputDeclaration(name) {
	return {
		command: `loaf spec add-${name}`,
		helpPrefix: `JSON source for SpecAdd${name[0].toUpperCase()}${name.slice(1)}Input (item or array)`,
		inlineLabel: "inline JSON",
		helpSuffix: " (protocol §10.7)"
	};
}
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
function registerSpec(program, ctx, mutator, actor, isStdinTty, isStdoutTty, inputIngestor, runEditorImpl) {
	const resolvedRunEditor = runEditorImpl ?? runEditor;
	const specCmd = program.command("spec").description("SPEC content and diagnostic commands (status / submit / add-req / add-scenario / add-visual; init in SC4)");
	declareCommandPolicy(specCmd.command("status").description("Show failing and suppressed spec-lock checks from replayed state (read-only)").option("--feature <name>", "Feature whose spec-lock status to show").option("--feature-dir <path>", "Override default .loaf/<feature> directory"), {
		selectors: "selected",
		dryRun: "read-only"
	}).action(async (opts) => {
		const featureDir = await ctx.dispatchOrFail(opts);
		if (featureDir === null) return;
		const session = await loadSession(featureDir, { ensureDir: false });
		if (session.snapshot.state === null) {
			ctx.failure(diagnosticVariant("failure.no_session.generic", { feature: opts.feature }));
			return;
		}
		const envelope = buildSpecStatusEnvelope(evaluateSpecLockFromSnapshot(session.snapshot));
		ctx.success(envelope, (i18n) => renderSpecStatusText(envelope, i18n));
	});
	declareCommandPolicy(specCmd.command("submit").description("Whole-replacement spec submit from JSON --input (CLI fills spec_version)").requiredOption("--input <src>", jsonInputHelp(SPEC_SUBMIT_INPUT)).option("--feature <name>", "Feature whose spec to submit").option("--feature-dir <path>", "Override default .loaf/<feature> directory"), {
		selectors: "selected",
		dryRun: "mutating"
	}).action(async (opts) => {
		if (await ctx.dispatchOrFail(opts) === null) return;
		const read = await inputIngestor.readJson(ctx, opts.input, SPEC_SUBMIT_INPUT);
		if (!read.ok) return;
		const parsed = read.value;
		if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
			ctx.failure(diagnostic$2("USAGE", { reason: "spec_input_object_required" }));
			return;
		}
		const inputParse = SpecSubmitInput.safeParse(parsed);
		if (!inputParse.success) {
			ctx.failure(diagnostic$2("SCHEMA_VALIDATION_FAILED", {
				reason: inputParse.error.issues.map((issue) => issue.message).join("; "),
				issues: inputParse.error.issues
			}));
			return;
		}
		const input = inputParse.data;
		const featureDir = await ctx.dispatchOrFail(opts);
		if (featureDir === null) return;
		const session = await ctx.resolveSession(featureDir);
		if (!session.snapshot.state) {
			ctx.failure(diagnosticVariant("failure.no_session.generic", { feature: opts.feature }));
			return;
		}
		const now = (/* @__PURE__ */ new Date()).toISOString();
		const entries = buildSpecSubmitBatch({
			input,
			snapshot: session.snapshot,
			actor,
			now
		});
		const result = await mutator.runPreparedBatch(featureDir, session, entries);
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
		const selector = await selectorForCommandContext(ctx);
		ctx.success(out, (i18n) => i18n.t(SUCCESS_KEYS.specSubmitText, {
			spec_version: out.spec_version,
			req_count: reqIds.length,
			scen_count: scenIds.length,
			vis_count: visIds.length
		}) + "\n", (i18n) => {
			const next = buildNextAdvisoryFromSnapshot(i18n, result.snapshot, featureDir, selector);
			return {
				stateChange: i18n.t(SUCCESS_KEYS.specSubmitStateChange, { spec_version: out.spec_version }),
				...next === void 0 ? {} : { next }
			};
		});
	});
	declareCommandPolicy(specCmd.command("init").description("Write a parser-valid minimal spec.md scaffold (no journal entry)").option("--feature <name>", "Feature whose spec.md to scaffold").option("--feature-dir <path>", "Override default .loaf/<feature> directory").option("--feature-id <id>", "Override feature.id in scaffold (default: F-XXX placeholder)").option("--feature-name <text>", "Override feature.name in scaffold (default: --feature value)").option("--intent <text>", "Override intent line in scaffold (default: TODO placeholder ≥20 chars)"), {
		selectors: "selected",
		dryRun: "scaffold-writer"
	}).action(async (opts) => {
		const featureDir = await ctx.dispatchOrFail(opts);
		if (featureDir === null) return;
		const specMdPath = path.join(featureDir, "spec.md");
		try {
			await promises.access(specMdPath);
			ctx.failure(diagnostic$2("SPEC_ALREADY_INITIALIZED", { spec_md_path: specMdPath }));
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
			ctx.failure(diagnostic$2("SCHEMA_VALIDATION_FAILED", {
				reason: scaffoldParse.error.issues.map((issue) => issue.message).join("; "),
				issues: scaffoldParse.error.issues
			}));
			return;
		}
		const md = `---
schema_version: 2
spec_version: 1
feature:
  id: ${JSON.stringify(featureId)}\n  name: ${JSON.stringify(featureName)}\nintent: ${JSON.stringify(intent)}\nadr_refs: []\nrequirements: []\nscenarios: []\nneeds_clarification: []\n---\n\n## Why\n\nTODO: describe motivation and scope. Edit this section, then run \`loaf spec edit --input <json>\` to record the canonical spec.\n`;
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
	declareCommandPolicy(specCmd.command("edit").description("Replace the spec.md body from --input or launch $EDITOR, validate, then emit event:spec_submitted").option("--input <src>", jsonInputHelp(SPEC_EDIT_INPUT)).option("--feature <name>", "Feature whose spec.md to edit").option("--feature-dir <path>", "Override default .loaf/<feature> directory"), {
		selectors: "selected",
		dryRun: "spec-edit"
	}).action(async (opts) => {
		const hasInput = opts.input !== void 0;
		const featureDir = await ctx.dispatchOrFail(opts);
		if (featureDir === null) return;
		const explicitEditor = (process.env["EDITOR"] ?? "").trim();
		if (!hasInput && (!isStdinTty() || !isStdoutTty())) {
			ctx.failure(diagnostic$2("SPEC_EDIT_INPUT_REQUIRED", {}));
			return;
		}
		const actor = ctx.resolveHumanActorOrFail();
		if (actor === null) return;
		const session = await loadSession(featureDir, { ensureDir: false });
		if (!session.snapshot.state) {
			ctx.failure(diagnosticVariant("failure.no_session.generic", { feature: opts.feature }));
			return;
		}
		if (session.snapshot.state.spec_locked === true) {
			ctx.failure(diagnostic$2("SPEC_LOCKED_NO_DIRECT_EDIT", { kind: "event:spec_submitted" }));
			return;
		}
		const specMdPath = path.join(featureDir, "spec.md");
		let beforeContent;
		try {
			beforeContent = await promises.readFile(specMdPath, "utf8");
		} catch (err) {
			if (err.code === "ENOENT") {
				ctx.failure(diagnostic$2("SCHEMA_VALIDATION_FAILED", {
					reason: "spec-not-found",
					subcode: "spec-not-found",
					path: specMdPath
				}));
				return;
			}
			throw err;
		}
		let afterContent;
		if (hasInput) {
			const read = await inputIngestor.readJson(ctx, opts.input, SPEC_EDIT_INPUT);
			if (!read.ok) return;
			const inputParse = SpecEditInput.safeParse(read.value);
			if (!inputParse.success) {
				ctx.failure(diagnostic$2("SCHEMA_VALIDATION_FAILED", {
					reason: inputParse.error.issues.map((issue) => issue.message).join("; "),
					issues: inputParse.error.issues
				}));
				return;
			}
			const frontmatterMatch = FRONTMATTER_RE.exec(beforeContent);
			if (frontmatterMatch === null) {
				ctx.failure(diagnostic$2("SCHEMA_VALIDATION_FAILED", {
					reason: "missing-frontmatter",
					subcode: "missing-frontmatter",
					path: specMdPath
				}));
				return;
			}
			afterContent = beforeContent.slice(0, frontmatterMatch[0].length) + inputParse.data.body;
		} else {
			const editor = explicitEditor || "vi";
			const result = await resolvedRunEditor({
				filePath: specMdPath,
				editor,
				cwd: process.cwd(),
				env: process.env
			});
			if (result.error !== void 0) {
				ctx.failure(diagnostic$2("USAGE", {
					editor,
					spawn_error: result.error
				}));
				return;
			}
			if (result.signal !== null) {
				ctx.exitCode = 130;
				return;
			}
			if (result.code !== 0) {
				ctx.failure(diagnostic$2("USAGE", {
					editor,
					editor_exit: result.code
				}));
				return;
			}
			try {
				afterContent = await promises.readFile(specMdPath, "utf8");
			} catch (err) {
				if (err.code === "ENOENT") {
					ctx.failure(diagnostic$2("SCHEMA_VALIDATION_FAILED", {
						reason: "spec-not-found",
						subcode: "spec-not-found",
						path: specMdPath
					}));
					return;
				}
				throw err;
			}
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
			ctx.failure(diagnostic$2("SCHEMA_VALIDATION_FAILED", {
				reason: "missing-frontmatter",
				subcode: "missing-frontmatter",
				path: specMdPath
			}));
			return;
		}
		let parsedYaml;
		try {
			parsedYaml = parse(frontmatter);
		} catch (err) {
			ctx.failure(diagnostic$2("SCHEMA_VALIDATION_FAILED", {
				reason: "invalid-yaml",
				cause: err.message,
				subcode: "invalid-yaml",
				path: specMdPath
			}));
			return;
		}
		const zodResult = SpecFrontmatter.safeParse(parsedYaml);
		if (!zodResult.success) {
			const issues = mapZodIssues(zodResult.error);
			ctx.failure(diagnostic$2("SCHEMA_VALIDATION_FAILED", {
				reason: "zod",
				subcode: "zod",
				path: specMdPath,
				errors: issues.errors,
				truncated: issues.truncated,
				error_count: issues.error_count
			}));
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
			ctx.failure(diagnostic$2("SCHEMA_VALIDATION_FAILED", {
				reason: submitParse.error.issues.map((issue) => issue.message).join("; "),
				subcode: "zod",
				path: specMdPath,
				issues: submitParse.error.issues
			}));
			return;
		}
		const now = (/* @__PURE__ */ new Date()).toISOString();
		const entries = buildSpecSubmitBatch({
			input: submitParse.data,
			snapshot: session.snapshot,
			actor,
			now
		});
		if (hasInput && !ctx.dryRun) await promises.writeFile(specMdPath, afterContent, "utf8");
		const mutateResult = await mutator.runPreparedBatch(featureDir, session, entries);
		if (!mutateResult) return;
		const newSpecVersion = entries[0].payload.spec_version;
		ctx.success({
			ok: true,
			feature: opts.feature,
			spec_version: newSpecVersion,
			sub_state: mutateResult.snapshot.state?.sub_state
		}, (i18n) => i18n.t(SUCCESS_KEYS.specEditText, { spec_version: newSpecVersion }) + "\n", (i18n) => ({ stateChange: i18n.t(hasInput ? SUCCESS_KEYS.specEditInputStateChange : SUCCESS_KEYS.specEditStateChange, { spec_version: newSpecVersion }) }));
	});
	for (const cfg of REGISTER_SPEC_ADD) {
		const mutatorKey = cfg.name === "req" ? "spec:add-req" : cfg.name === "scenario" ? "spec:add-scenario" : "spec:add-visual";
		const inputDeclaration = specAddInputDeclaration(cfg.name);
		declareCommandPolicy(specCmd.command(`add-${cfg.name}`).description(`Add ${cfg.name} entries via id_namespace stamping (CLI allocates ${cfg.name.toUpperCase()} ids)`).option("--input <src>", jsonInputHelp(inputDeclaration)).option("--schema", "Dump the input JSON Schema instead of mutating (Phase 16 SC-10)").option("--feature <name>", `Feature whose spec to extend`).option("--feature-dir <path>", "Override default .loaf/<feature> directory"), {
			selectors: "selected",
			dryRun: "mutating",
			schema: {
				kind: "input",
				key: mutatorKey
			}
		}).action(async (rawOpts) => {
			const read = await inputIngestor.readJson(ctx, rawOpts.input, inputDeclaration);
			if (!read.ok) return;
			const opts = rawOpts;
			const parsed = read.value;
			const inputParse = cfg.inputSchema.safeParse(parsed);
			if (!inputParse.success) {
				ctx.failure(diagnostic$2("SCHEMA_VALIDATION_FAILED", {
					reason: inputParse.error.issues.map((issue) => issue.message).join("; "),
					issues: inputParse.error.issues
				}));
				return;
			}
			const items = Array.isArray(inputParse.data) ? inputParse.data : [inputParse.data];
			const featureDir = await ctx.dispatchOrFail(opts);
			if (featureDir === null) return;
			const session = await ctx.resolveSession(featureDir);
			if (!session.snapshot.state) {
				ctx.failure(diagnosticVariant("failure.no_session.generic", { feature: opts.feature }));
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
			const entries = transformedItems.map(({ id, rest }) => ({
				kind: cfg.entryKind,
				payload: {
					spec_version: targetVersion,
					[cfg.payloadField]: {
						id,
						...rest
					}
				},
				actor
			}));
			const result = await mutator.run(featureDir, session, entries);
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
	return { specCmd };
}
//#endregion
//#region src/cli/commands/state.tsx
function registerState(program, specCmd, tasksCmd, evidenceCmd, findingCmd) {
	const ARTIFACT_PARENTS = {
		spec: specCmd,
		tasks: tasksCmd,
		evidence: evidenceCmd,
		finding: findingCmd,
		state: program.command("state").description("Session state schema dump (SC-10)")
	};
	for (const kind of ARTIFACT_SCHEMA_KINDS) declareCommandPolicy(ARTIFACT_PARENTS[kind].command("schema").description(`Dump the ${kind} artifact JSON Schema (Phase 16 SC-10; read-only)`), {
		selectors: "forbidden",
		dryRun: "read-only",
		schema: {
			kind: "artifact",
			key: kind
		}
	}).action(() => {});
}
//#endregion
//#region src/cli/board/open-url.ts
async function defaultOpenUrl(url) {
	const command = process$1.platform === "darwin" ? "open" : process$1.platform === "win32" ? "cmd" : "xdg-open";
	const args = process$1.platform === "win32" ? [
		"/c",
		"start",
		"",
		url
	] : [url];
	await new Promise((resolve, reject) => {
		const child = spawn(command, args, {
			stdio: "ignore",
			detached: true
		});
		child.once("error", reject);
		child.once("spawn", () => {
			child.unref();
			resolve();
		});
	});
}
//#endregion
//#region src/cli/board/static.ts
const BOARD_PHASES = [
	"TRIAGE",
	"SPEC",
	"EXECUTE",
	"VERIFY",
	"SETTLE",
	"DONE"
];
const BOARD_COLUMN_DESCRIPTION_KEYS = {
	TRIAGE: "board.column.TRIAGE.description",
	SPEC: "board.column.SPEC.description",
	EXECUTE: "board.column.EXECUTE.description",
	VERIFY: "board.column.VERIFY.description",
	SETTLE: "board.column.SETTLE.description",
	DONE: "board.column.DONE.description"
};
const BOARD_SUB_STATES = [
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
	"SETTLE.lessons",
	"DONE.delivered",
	"DONE.archived",
	"DONE.abandoned"
];
const BOARD_STATUS_BUCKETS = [
	"done",
	"blocked",
	"running",
	"idle"
];
function renderBoardHtml(i18n) {
	const messages = buildBoardMessages(i18n);
	return [
		"<!doctype html>",
		`<html lang="${escapeHtmlAttr(i18n.locale)}">`,
		"<head>",
		"  <meta charset=\"utf-8\">",
		"  <meta name=\"viewport\" content=\"width=device-width, initial-scale=1\">",
		`  <title>${escapeHtml(messages.chrome.appTitle)}</title>`,
		`  <style>${BOARD_STYLES}</style>`,
		"</head>",
		"<body data-theme=\"system\">",
		renderTopbar(messages),
		renderMainShell(messages),
		renderModal(messages),
		`  <script>window.__LOAF_BOARD_MESSAGES__=${scriptJson(messages)};<\/script>`,
		`  <script type="module">${BOARD_SCRIPT}<\/script>`,
		"</body>",
		"</html>"
	].join("\n");
}
function renderTopbar(messages) {
	const { chrome } = messages;
	return `
  <header class="topbar">
    <div class="topbar__left">
      <div class="brand">
        <span class="brand__mark">L</span>
        <span class="brand__name">${escapeHtml(chrome.brand)}</span>
        <span class="live-dot" id="live-dot" aria-hidden="true"></span>
      </div>
      <label class="scope-picker">
        <span>${escapeHtml(chrome.scopeLabel)}</span>
        <select id="scope-select">
          <option value="all">${escapeHtml(chrome.allSessions)}</option>
          <option value="cwd">${escapeHtml(chrome.currentCwd)}</option>
        </select>
      </label>
    </div>
    <div class="topbar__actions">
      <button class="pill-button" id="refresh-button" type="button">${escapeHtml(chrome.refresh)}</button>
      <button class="icon-button" id="theme-button" type="button" aria-label="${escapeHtmlAttr(chrome.themeToggle)}">◐</button>
    </div>
  </header>`;
}
function renderMainShell(messages) {
	const { chrome } = messages;
	return `
  <main class="shell">
    <section class="board-header">
      <div>
        <p class="eyebrow">${escapeHtml(chrome.eyebrow)}</p>
        <h1>${escapeHtml(chrome.heading)}</h1>
        <p class="board-subtitle" id="board-subtitle">${escapeHtml(chrome.subtitle)}</p>
      </div>
      <dl class="metric-strip">
        <div><dt>${escapeHtml(chrome.active)}</dt><dd id="metric-active">0</dd></div>
        <div><dt>${escapeHtml(chrome.blocked)}</dt><dd id="metric-blocked">0</dd></div>
        <div><dt>${escapeHtml(chrome.updated)}</dt><dd id="metric-updated">${escapeHtml(chrome.waiting)}</dd></div>
      </dl>
    </section>
    <section class="board-grid" id="board-grid" aria-label="${escapeHtmlAttr(chrome.boardLabel)}"></section>
  </main>`;
}
function renderModal(messages) {
	const { chrome } = messages;
	return `
  <div class="modal" id="session-modal" hidden>
    <button class="modal__scrim" type="button" data-close-modal aria-label="${escapeHtmlAttr(chrome.closeSessionDetail)}"></button>
    <article class="modal__panel" role="dialog" aria-modal="true" aria-labelledby="modal-title">
      <header class="modal__header">
        <div>
          <p class="eyebrow" id="modal-kicker">${escapeHtml(chrome.session)}</p>
          <h2 id="modal-title">${escapeHtml(chrome.sessionDetail)}</h2>
        </div>
        <button class="icon-button" type="button" data-close-modal aria-label="${escapeHtmlAttr(chrome.closeSessionDetail)}">×</button>
      </header>
      <div class="modal__body" id="modal-body"></div>
    </article>
  </div>`;
}
function buildBoardMessages(i18n) {
	return {
		locale: i18n.locale,
		chrome: {
			appTitle: i18n.t("board.chrome.app_title"),
			brand: i18n.t("board.chrome.brand"),
			scopeLabel: i18n.t("board.chrome.scope_label"),
			allSessions: i18n.t("board.chrome.all_sessions"),
			currentCwd: i18n.t("board.chrome.current_cwd"),
			refresh: i18n.t("board.chrome.refresh"),
			themeToggle: i18n.t("board.chrome.theme_toggle"),
			eyebrow: i18n.t("board.chrome.eyebrow"),
			heading: i18n.t("board.chrome.heading"),
			subtitle: i18n.t("board.chrome.subtitle"),
			active: i18n.t("board.chrome.active"),
			blocked: i18n.t("board.chrome.blocked"),
			updated: i18n.t("board.chrome.updated"),
			waiting: i18n.t("board.chrome.waiting"),
			boardLabel: i18n.t("board.chrome.board_label"),
			noSessions: i18n.t("board.chrome.no_sessions"),
			none: i18n.t("board.chrome.none"),
			session: i18n.t("board.chrome.session"),
			sessionDetail: i18n.t("board.chrome.session_detail"),
			closeSessionDetail: i18n.t("board.chrome.close_session_detail"),
			loading: i18n.t("board.chrome.loading"),
			sessionError: i18n.t("board.chrome.session_error"),
			iterationShort: i18n.t("board.chrome.iteration_short"),
			justNow: i18n.t("relative.just_now")
		},
		detail: {
			phase: i18n.t("board.detail.phase"),
			subState: i18n.t("board.detail.sub_state"),
			tailSeq: i18n.t("board.detail.tail_seq"),
			tasks: i18n.t("board.detail.tasks"),
			evidence: i18n.t("board.detail.evidence"),
			openFindings: i18n.t("board.detail.open_findings"),
			pending: i18n.t("board.detail.pending"),
			taskDoneSuffix: i18n.t("board.detail.task_done_suffix"),
			evidencePassingSuffix: i18n.t("board.detail.evidence_passing_suffix"),
			stepsSuffix: i18n.t("board.detail.steps_suffix")
		},
		columns: BOARD_PHASES.map((phase) => ({
			id: phase,
			title: i18n.t(phaseKey(phase)),
			description: i18n.t(BOARD_COLUMN_DESCRIPTION_KEYS[phase])
		})),
		labels: {
			phases: Object.fromEntries(BOARD_PHASES.map((phase) => [phase, i18n.t(phaseKey(phase))])),
			subStates: Object.fromEntries(BOARD_SUB_STATES.map((subState) => [subState, i18n.t(subStateKey(subState))])),
			statuses: Object.fromEntries(BOARD_STATUS_BUCKETS.map((status) => [status, i18n.t(statusIndicatorKey(status))])),
			pendingClasses: {
				decision: i18n.t("board.status.pending_decision"),
				question: i18n.t("board.status.pending_question")
			}
		}
	};
}
const BOARD_STYLES = `
:root {
  color-scheme: light;
  --canvas: #f7f6f3;
  --surface: #ffffff;
  --surface-muted: #fbfbfa;
  --ink: #111111;
  --muted: #787774;
  --line: #e7e5df;
  --blue-bg: #e1f3fe;
  --blue-text: #1f6c9f;
  --green-bg: #edf3ec;
  --green-text: #346538;
  --red-bg: #fdebec;
  --red-text: #9f2f2d;
  --yellow-bg: #fbf3db;
  --yellow-text: #956400;
  --active-surface: #fbfdfe;
  font-family: "SF Pro Display", "Geist Sans", "Helvetica Neue", Arial, sans-serif;
}

body[data-theme="dark"] {
  color-scheme: dark;
  --canvas: #07101f;
  --surface: #101a2d;
  --surface-muted: #0c1525;
  --ink: #f7f9fc;
  --muted: #9aa7bf;
  --line: #26334a;
  --blue-bg: #173653;
  --blue-text: #9ed8ff;
  --green-bg: #143929;
  --green-text: #a6e8bf;
  --red-bg: #3a1d22;
  --red-text: #ffb2b9;
  --yellow-bg: #3a3014;
  --yellow-text: #f6d878;
  --active-surface: #0f2031;
}

* { box-sizing: border-box; }
body { margin: 0; min-height: 100vh; background: var(--canvas); color: var(--ink); }
button, select { font: inherit; }

.topbar {
  position: sticky;
  top: 16px;
  z-index: 10;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
  width: min(1392px, calc(100% - 48px));
  min-height: 64px;
  margin: 0 auto;
  padding: 10px 12px 10px 18px;
  border: 1px solid rgba(219, 226, 240, 0.86);
  border-radius: 999px;
  background: color-mix(in srgb, var(--surface) 78%, transparent);
  box-shadow: 0 18px 48px rgba(30, 40, 72, 0.1);
  backdrop-filter: blur(22px);
}

.topbar__left, .topbar__actions, .brand, .scope-picker {
  display: inline-flex;
  align-items: center;
  gap: 10px;
  min-width: 0;
}
.topbar__left { gap: 24px; }
.brand { color: var(--ink); font-weight: 800; min-width: fit-content; }
.brand__mark {
  display: grid;
  place-items: center;
  width: 38px;
  height: 38px;
  border-radius: 12px;
  background: linear-gradient(135deg, #4f46d8, #1f9d69);
  color: #fff;
  font-weight: 900;
}
.brand__name { font-size: 18px; letter-spacing: 0; }
.live-dot {
  width: 8px;
  height: 8px;
  border: 2px solid #fff;
  border-radius: 999px;
  background: #1f9d69;
  box-shadow: 0 0 0 4px rgba(31, 157, 105, 0.12);
}
.live-dot.offline { background: var(--yellow-text); box-shadow: 0 0 0 4px rgba(149, 100, 0, 0.12); }

.scope-picker span {
  color: var(--muted);
  font-size: 11px;
  font-weight: 700;
  letter-spacing: 0.08em;
  text-transform: uppercase;
}
.scope-picker select, .pill-button, .icon-button {
  min-height: 38px;
  border: 1px solid var(--line);
  border-radius: 999px;
  background: color-mix(in srgb, var(--surface) 72%, transparent);
  color: var(--ink);
  font-weight: 800;
}
.scope-picker select { width: min(220px, 100%); padding: 0 34px 0 14px; }
.pill-button { padding: 0 15px; cursor: pointer; }
.icon-button { width: 38px; padding: 0; cursor: pointer; }

.shell { width: min(1440px, 100%); margin: 0 auto; padding: 28px 24px 40px; }
.board-header {
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto;
  gap: 24px;
  align-items: end;
  padding: 8px 0 24px;
  border-bottom: 1px solid var(--line);
}
.eyebrow {
  margin: 0 0 8px;
  color: var(--muted);
  font-size: 11px;
  font-weight: 700;
  letter-spacing: 0.08em;
  text-transform: uppercase;
}
h1, h2, h3, p { margin-top: 0; }
h1 {
  margin-bottom: 10px;
  max-width: 900px;
  font-size: clamp(34px, 5vw, 68px);
  line-height: 0.95;
  letter-spacing: 0;
}
.board-subtitle { max-width: 860px; margin-bottom: 0; color: var(--muted); line-height: 1.55; }

.metric-strip {
  display: grid;
  grid-template-columns: repeat(3, minmax(94px, auto));
  gap: 1px;
  overflow: hidden;
  margin: 0;
  border: 1px solid var(--line);
  border-radius: 8px;
  background: var(--line);
}
.metric-strip div { min-width: 0; padding: 12px 14px; background: var(--surface); }
.metric-strip dt { margin-bottom: 6px; color: var(--muted); font-size: 11px; text-transform: uppercase; letter-spacing: 0.05em; }
.metric-strip dd { margin: 0; max-width: 180px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 14px; }

.board-grid {
  display: grid;
  grid-template-columns: repeat(6, minmax(210px, 1fr));
  gap: 16px;
  overflow-x: auto;
  padding-top: 18px;
  padding-bottom: 8px;
}
.column { min-width: 0; border: 1px solid var(--line); border-radius: 8px; background: var(--surface-muted); }
.column__header { display: flex; align-items: start; justify-content: space-between; gap: 12px; padding: 16px; border-bottom: 1px solid var(--line); }
.column__header h2 { margin: 0 0 4px; font-size: 16px; line-height: 1.2; }
.column__header p { margin: 0; color: var(--muted); font-size: 13px; line-height: 1.4; }
.column__count { color: var(--muted); font-family: "Geist Mono", "SF Mono", monospace; font-size: 13px; }
.card-list { display: grid; gap: 10px; padding: 12px; }
.session-card {
  position: relative;
  width: 100%;
  min-height: 138px;
  display: flex;
  flex-direction: column;
  gap: 10px;
  border: 1px solid var(--line);
  border-radius: 8px;
  padding: 14px;
  background: var(--surface);
  color: inherit;
  text-align: left;
  cursor: pointer;
}
.session-card:hover { border-color: rgba(79, 70, 216, 0.28); transform: translateY(-1px); }
.session-card.is-active {
  border: 1px solid transparent;
  background: linear-gradient(var(--active-surface), var(--active-surface)) padding-box,
    linear-gradient(110deg, #78d7ff, #6c63ff, #78f2b9, #78d7ff) border-box;
}
.session-card__kicker { display: flex; align-items: center; justify-content: space-between; gap: 8px; color: var(--muted); font-size: 12px; font-weight: 700; }
.session-card__title { margin: 0; font-size: 16px; line-height: 1.32; color: var(--ink); }
.session-card__meta { display: flex; flex-wrap: wrap; gap: 6px; margin-top: auto; color: var(--muted); font-size: 12px; }
.badge { display: inline-flex; align-items: center; width: fit-content; border-radius: 999px; padding: 4px 8px; font-size: 11px; font-weight: 700; letter-spacing: 0.05em; text-transform: uppercase; background: var(--blue-bg); color: var(--blue-text); }
.badge.done { background: var(--green-bg); color: var(--green-text); }
.badge.blocked, .badge.failed { background: var(--red-bg); color: var(--red-text); }
.badge.running { background: var(--yellow-bg); color: var(--yellow-text); }
.empty-column { padding: 16px; color: var(--muted); font-size: 13px; }

.modal[hidden] { display: none; }
.modal { position: fixed; inset: 0; z-index: 20; display: grid; place-items: center; padding: 24px; }
.modal__scrim { position: absolute; inset: 0; border: 0; background: rgba(7, 12, 24, 0.45); cursor: pointer; }
.modal__panel {
  position: relative;
  width: min(920px, 100%);
  max-height: min(820px, calc(100vh - 48px));
  overflow: hidden;
  display: flex;
  flex-direction: column;
  border: 1px solid var(--line);
  border-radius: 14px;
  background: var(--surface);
  box-shadow: 0 28px 90px rgba(0, 0, 0, 0.24);
}
.modal__header { display: flex; align-items: start; justify-content: space-between; gap: 16px; padding: 20px 22px; border-bottom: 1px solid var(--line); }
.modal__header h2 { margin: 0; font-size: 28px; letter-spacing: 0; }
.modal__body { overflow: auto; padding: 20px 22px 24px; }
.detail-grid { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 10px; margin-bottom: 18px; }
.detail-card, .detail-row { border: 1px solid var(--line); border-radius: 8px; padding: 12px; background: var(--surface-muted); }
.detail-card dt { color: var(--muted); font-size: 11px; font-weight: 800; text-transform: uppercase; letter-spacing: 0.05em; }
.detail-card dd { margin: 6px 0 0; overflow-wrap: anywhere; }
.detail-section { margin-top: 18px; }
.detail-section h3 { margin: 0 0 8px; font-size: 15px; }
.detail-list { display: grid; gap: 8px; }
.detail-row strong { display: block; margin-bottom: 4px; }
.detail-row p { margin: 0; color: var(--muted); line-height: 1.45; }
.error-panel { border: 1px solid var(--red-bg); border-radius: 8px; padding: 12px; color: var(--red-text); background: var(--red-bg); }

@media (max-width: 1040px) { .board-grid { grid-template-columns: repeat(3, minmax(210px, 1fr)); } .board-header { grid-template-columns: 1fr; } }
@media (max-width: 680px) {
  .topbar { width: calc(100% - 24px); border-radius: 22px; align-items: stretch; flex-direction: column; }
  .topbar__left, .topbar__actions { width: 100%; justify-content: space-between; }
  .board-grid { grid-template-columns: 1fr; overflow-x: visible; }
  .metric-strip, .detail-grid { grid-template-columns: 1fr; }
  h1 { font-size: 34px; line-height: 1; }
}
`;
const BOARD_SCRIPT = `
const MESSAGES = window.__LOAF_BOARD_MESSAGES__;
const COLUMNS = MESSAGES.columns;
const RELATIVE_TIME = new Intl.RelativeTimeFormat(MESSAGES.locale, { numeric: "auto" });

const elements = {
  grid: document.querySelector("#board-grid"),
  subtitle: document.querySelector("#board-subtitle"),
  active: document.querySelector("#metric-active"),
  blocked: document.querySelector("#metric-blocked"),
  updated: document.querySelector("#metric-updated"),
  liveDot: document.querySelector("#live-dot"),
  scope: document.querySelector("#scope-select"),
  modal: document.querySelector("#session-modal"),
  modalTitle: document.querySelector("#modal-title"),
  modalKicker: document.querySelector("#modal-kicker"),
  modalBody: document.querySelector("#modal-body"),
};

let selectedScope = "all";

document.querySelector("#refresh-button").addEventListener("click", loadSnapshot);
document.querySelector("#theme-button").addEventListener("click", toggleTheme);
elements.scope.addEventListener("change", () => {
  selectedScope = elements.scope.value;
  loadSnapshot();
});
document.querySelectorAll("[data-close-modal]").forEach((node) => {
  node.addEventListener("click", closeModal);
});
window.addEventListener("keydown", (event) => {
  if (event.key === "Escape") closeModal();
});

const savedTheme = localStorage.getItem("loaf-board-theme");
if (savedTheme) document.body.dataset.theme = savedTheme;
loadSnapshot();

async function loadSnapshot() {
  try {
    const snapshot = await fetchJson("/api/sessions?scope=" + encodeURIComponent(selectedScope));
    elements.liveDot.classList.remove("offline");
    renderSnapshot(snapshot);
  } catch (error) {
    elements.liveDot.classList.add("offline");
    elements.grid.innerHTML = renderError(error.message || String(error));
  }
}

function renderSnapshot(snapshot) {
  elements.subtitle.textContent = snapshot.cwd;
  elements.active.textContent = String(snapshot.totals.active);
  elements.blocked.textContent = String(snapshot.totals.blocked);
  elements.updated.textContent = new Date(snapshot.generated_at).toLocaleTimeString();
  elements.grid.innerHTML = COLUMNS
    .map((column) => renderColumn(column, sessionsForPhase(snapshot.sessions, column.id)))
    .join("");
  elements.grid.querySelectorAll("[data-session-id]").forEach((card) => {
    card.addEventListener("click", () => openSessionDetail(card.getAttribute("data-session-id")));
  });
}

function sessionsForPhase(sessions, phase) {
  return sessions
    .filter((session) => session.phase === phase)
    .sort((left, right) => right.at.localeCompare(left.at));
}

function renderColumn(column, sessions) {
  const cards = sessions.length ? sessions.map(renderSessionCard).join("") : '<p class="empty-column">' + escapeHtml(MESSAGES.chrome.noSessions) + '</p>';
  return '<section class="column">' +
    '<header class="column__header"><div><h2>' + escapeHtml(column.title) + '</h2><p>' +
    escapeHtml(column.description) + '</p></div><span class="column__count">' +
    sessions.length + '</span></header><div class="card-list">' + cards + '</div></section>';
}

function renderSessionCard(session) {
  const activeClass = session.status_bucket === "running" ? " is-active" : "";
  return '<button class="session-card' + activeClass + '" type="button" data-session-id="' + escapeAttr(session.session_id) + '">' +
    '<div class="session-card__kicker"><span>' + escapeHtml(session.session_id_short) + '</span><span class="badge ' +
    escapeAttr(session.status_bucket) + '">' + escapeHtml(statusLabel(session.status_bucket, session.pending_head_class)) + '</span></div>' +
    '<h3 class="session-card__title">' + escapeHtml(session.label) + '</h3>' +
    '<div class="session-card__meta"><span>' + escapeHtml(subStateLabel(session.sub_state)) + '</span><span>' + escapeHtml(MESSAGES.chrome.iterationShort) + ' ' +
    session.iteration + '</span><span>' + relativeTime(session.at) + '</span></div></button>';
}

async function openSessionDetail(sessionId) {
  if (!sessionId) return;
  elements.modal.hidden = false;
  elements.modalTitle.textContent = MESSAGES.chrome.loading;
  elements.modalKicker.textContent = MESSAGES.chrome.session;
  elements.modalBody.innerHTML = "";
  try {
    const payload = await fetchJson("/api/sessions/" + encodeURIComponent(sessionId));
    renderDetail(payload);
  } catch (error) {
    elements.modalTitle.textContent = MESSAGES.chrome.sessionError;
    elements.modalBody.innerHTML = renderError(error.message || String(error));
  }
}

function renderDetail(payload) {
  elements.modalTitle.textContent = payload.session.label;
  elements.modalKicker.textContent = payload.session.session_id_short + " · " + subStateLabel(payload.session.sub_state);
  if (payload.status !== "ready") {
    elements.modalBody.innerHTML = renderError([payload.status, payload.message, payload.fix].filter(Boolean).join("\\n"));
    return;
  }
  const detail = payload.detail;
  elements.modalBody.innerHTML =
    '<dl class="detail-grid">' +
    detailCard(MESSAGES.detail.phase, phaseLabel(detail.state.phase)) +
    detailCard(MESSAGES.detail.subState, subStateLabel(detail.state.sub_state)) +
    detailCard(MESSAGES.detail.tailSeq, detail.state.tail_seq) +
    detailCard(MESSAGES.detail.tasks, detail.proof.tasks_done + "/" + detail.proof.tasks_total + " " + MESSAGES.detail.taskDoneSuffix) +
    detailCard(MESSAGES.detail.evidence, detail.proof.passing_evidence + "/" + detail.proof.evidence_total + " " + MESSAGES.detail.evidencePassingSuffix) +
    detailCard(MESSAGES.detail.openFindings, detail.proof.open_findings) +
    '</dl>' +
    detailSection(MESSAGES.detail.pending, detail.pending.map((item) => detailRow(item.pending_id, item.question, item.kind))) +
    detailSection(MESSAGES.detail.tasks, detail.tasks.map((item) => detailRow(item.id, item.title || item.kind, item.status + " · " + item.steps.done + "/" + item.steps.total + " " + MESSAGES.detail.stepsSuffix))) +
    detailSection(MESSAGES.detail.evidence, detail.evidence.slice().reverse().map((item) => detailRow(item.id, item.summary, item.result + " · " + item.kind))) +
    detailSection(MESSAGES.detail.openFindings, detail.open_findings.map((item) => detailRow(item.id, item.summary || item.reason, item.category + " · " + item.action)));
}

function detailCard(label, value) {
  return '<div class="detail-card"><dt>' + escapeHtml(label) + '</dt><dd>' + escapeHtml(String(value)) + '</dd></div>';
}

function detailSection(title, rows) {
  const body = rows.length ? rows.join("") : '<p class="empty-column">' + escapeHtml(MESSAGES.chrome.none) + '</p>';
  return '<section class="detail-section"><h3>' + escapeHtml(title) + '</h3><div class="detail-list">' + body + '</div></section>';
}

function detailRow(title, body, meta) {
  return '<article class="detail-row"><strong>' + escapeHtml(title) + '</strong><p>' +
    escapeHtml(body || "") + '</p><p>' + escapeHtml(meta || "") + '</p></article>';
}

async function fetchJson(url) {
  const response = await fetch(url, { cache: "no-store" });
  const text = await response.text();
  const payload = text ? JSON.parse(text) : {};
  if (!response.ok || payload.ok === false) throw new Error(payload.message || text || response.statusText);
  return payload;
}

function closeModal() {
  elements.modal.hidden = true;
}

function toggleTheme() {
  const next = document.body.dataset.theme === "dark" ? "light" : "dark";
  document.body.dataset.theme = next;
  localStorage.setItem("loaf-board-theme", next);
}

function relativeTime(iso) {
  const at = new Date(iso).getTime();
  if (Number.isNaN(at)) return iso;
  const diff = Date.now() - at;
  if (diff < 60_000) return MESSAGES.chrome.justNow;
  if (diff < 3_600_000) return RELATIVE_TIME.format(-Math.floor(diff / 60_000), "minute");
  if (diff < 86_400_000) return RELATIVE_TIME.format(-Math.floor(diff / 3_600_000), "hour");
  return new Date(iso).toLocaleDateString();
}

function renderError(message) {
  return '<section class="error-panel">' + escapeHtml(message) + '</section>';
}

function statusLabel(status, pendingClass) {
  const label = MESSAGES.labels.statuses[status] || status;
  const pendingLabel = MESSAGES.labels.pendingClasses[pendingClass] || pendingClass;
  return status === "blocked" && pendingClass ? label + " · " + pendingLabel : label;
}

function phaseLabel(phase) {
  return MESSAGES.labels.phases[phase] || phase;
}

function subStateLabel(subState) {
  return MESSAGES.labels.subStates[subState] || subState;
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function escapeAttr(value) {
  return escapeHtml(value);
}
`;
function scriptJson(value) {
	return JSON.stringify(value).replaceAll("<", "\\u003c");
}
function escapeHtml(value) {
	return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll("\"", "&quot;").replaceAll("'", "&#039;");
}
function escapeHtmlAttr(value) {
	return escapeHtml(value);
}
//#endregion
//#region src/cli/board/model.ts
const BOARD_DETAIL_PROJECTION_KINDS = [
	"state",
	"tasks",
	"evidence",
	"findings",
	"pending"
];
async function buildBoardSnapshot(input) {
	const cwd = input.cwd ?? process.cwd();
	const filterCwd = input.scope === "cwd" ? await canonicalCwd(cwd) : void 0;
	const listed = await listSessions({
		...input.registryDir !== void 0 && { registryDir: input.registryDir },
		...filterCwd !== void 0 && { filterCwd }
	});
	const sessions = listed.rows.map(toBoardSessionSummary);
	const totals = summarizeSessions(sessions, listed.warnings.length);
	return {
		ok: true,
		generated_at: (input.now ?? /* @__PURE__ */ new Date()).toISOString(),
		scope: input.scope,
		cwd,
		totals,
		sessions,
		warnings: listed.warnings
	};
}
async function buildBoardSessionDetail(input) {
	const row = (await listSessions(input.registryDir !== void 0 ? { registryDir: input.registryDir } : {})).rows.find((candidate) => candidate.session_id === input.sessionId);
	if (row === void 0) return {
		ok: false,
		code: "SESSION_NOT_FOUND",
		message: `session ${input.sessionId} was not found in the loaf registry`
	};
	const session = toBoardSessionSummary(row);
	const featureDir = path.join(row.cwd, ".loaf", row.feature);
	try {
		return {
			ok: true,
			status: "ready",
			session,
			detail: shapeBoardSessionDetail(await loadProjections({
				feature_dir: featureDir,
				kinds: BOARD_DETAIL_PROJECTION_KINDS
			}))
		};
	} catch (error) {
		if (error instanceof NoSessionError) return {
			ok: true,
			status: "missing",
			session,
			message: `feature ${row.feature} no longer has a valid loaf session`,
			fix: detailFix(error.detail)
		};
		if (error instanceof SnapshotStaleError) return {
			ok: true,
			status: "stale",
			session,
			reason: error.reason,
			message: `snapshot is stale: ${error.reason}`,
			fix: detailFix(error.detail)
		};
		return {
			ok: true,
			status: "error",
			session,
			message: error instanceof Error ? error.message : String(error)
		};
	}
}
function toBoardSessionSummary(row) {
	return {
		...row,
		label: row.session_label.length > 0 ? row.session_label : row.feature,
		status_bucket: statusBucket(row),
		pending_head_class: classifyPendingHead(row.pending_head_kind)
	};
}
function statusBucket(row) {
	return classifySessionStatus(row);
}
function shapeBoardSessionDetail(loaded) {
	const tasks = loaded.tasks === null ? [] : loaded.tasks.tasks.map(shapeTaskLine);
	const evidence = loaded.evidence.evidence.map((entry) => ({
		id: entry.id,
		kind: entry.kind,
		result: entry.result,
		summary: summaryText(entry.summary),
		iteration: entry.iteration,
		task_id: entry.task_id ?? null,
		covers: entry.covers,
		at: entry.at
	}));
	const openFindings = loaded.findings.findings.filter((finding) => finding.status === "open").map((finding) => ({
		id: finding.id,
		category: finding.category,
		action: finding.action,
		summary: finding.summary ?? "",
		reason: finding.reason ?? "",
		target: finding.target === void 0 ? null : `${finding.target.task_id}/${finding.target.step}`
	}));
	const pending = livePending(loaded.pending.pending).map((entry) => ({
		pending_id: entry.pending_id,
		kind: entry.kind,
		question: entry.question,
		blocks: entry.blocks,
		options: entry.options ?? []
	}));
	return {
		state: {
			phase: loaded.state.phase,
			sub_state: loaded.state.sub_state,
			iteration: loaded.state.iteration,
			ceremony_label: loaded.state.ceremony_label,
			spec_locked: loaded.state.spec_locked,
			verify_accepted: loaded.state.verify_accepted,
			spec_version: loaded.state.spec_version,
			based_on: loaded.state.based_on,
			created_at: loaded.state.created_at,
			updated_at: loaded.state.updated_at,
			tail_seq: loaded.meta.last_applied_seq
		},
		tasks,
		evidence,
		open_findings: openFindings,
		pending,
		proof: {
			tasks_total: tasks.length,
			tasks_done: tasks.filter((task) => task.status === "done").length,
			evidence_total: evidence.length,
			passing_evidence: evidence.filter((entry) => isPassingEvidence(entry.result)).length,
			open_findings: openFindings.length,
			pending: pending.length
		}
	};
}
function summarizeSessions(sessions, warnings) {
	return {
		sessions: sessions.length,
		active: sessions.filter((row) => row.status_bucket !== "done").length,
		blocked: sessions.filter((row) => row.status_bucket === "blocked").length,
		running: sessions.filter((row) => row.status_bucket === "running").length,
		done: sessions.filter((row) => row.status_bucket === "done").length,
		warnings
	};
}
function shapeTaskLine(task) {
	const steps = Object.values(task.execution);
	return {
		id: task.id,
		kind: task.kind,
		status: task.status,
		title: optionalStringField(task, "title"),
		drives: task.drives ?? [],
		depends_on: task.depends_on ?? [],
		labels: task.labels ?? [],
		steps: {
			total: steps.length,
			done: steps.filter((step) => step.status === "passed" || step.status === "waived").length,
			running: steps.filter((step) => step.status === "running").length,
			failed: steps.filter((step) => step.status === "failed").length
		}
	};
}
function optionalStringField(value, field) {
	if (typeof value !== "object" || value === null) return null;
	const candidate = value[field];
	return typeof candidate === "string" && candidate.length > 0 ? candidate : null;
}
function summaryText(summary) {
	if (typeof summary === "string") return summary;
	if (summary.mode === "inline") return summary.text;
	return summary.ref.path;
}
function isPassingEvidence(result) {
	return result === "passed" || result === "approved" || result === "waived";
}
function detailFix(detail) {
	return typeof detail["fix"] === "string" ? detail["fix"] : null;
}
async function canonicalCwd(cwd) {
	try {
		return await promises.realpath(cwd);
	} catch {
		return cwd;
	}
}
//#endregion
//#region src/cli/board/server.ts
const DEFAULT_BOARD_HOST = "127.0.0.1";
const DEFAULT_BOARD_PORT = 41738;
async function createBoardOnceSnapshot(input) {
	return await buildBoardSnapshot(input);
}
async function startBoardServer(options) {
	const host = options.host ?? "127.0.0.1";
	const port = options.port ?? 41738;
	const cwd = options.cwd ?? process.cwd();
	const i18n = options.i18n ?? DEFAULT_I18N;
	const server = createServer(async (request, response) => {
		try {
			await routeRequest(request, response, {
				...options.registryDir !== void 0 && { registryDir: options.registryDir },
				cwd,
				i18n
			});
		} catch (error) {
			sendRouteError(response, error);
		}
	});
	await listen(server, port, host);
	const address = server.address();
	const actualPort = typeof address === "object" && address !== null ? address.port : port;
	return {
		url: `http://${host}:${actualPort}/`,
		host,
		port: actualPort,
		server,
		close: () => new Promise((resolve, reject) => {
			server.close((error) => error ? reject(error) : resolve());
		})
	};
}
async function routeRequest(request, response, context) {
	const url = new URL(request.url ?? "/", `http://${request.headers.host ?? "127.0.0.1"}`);
	if (request.method !== "GET") {
		methodNotAllowed(response);
		return;
	}
	if (url.pathname === "/" || url.pathname === "/index.html") {
		sendHtml(response, renderBoardHtml(context.i18n));
		return;
	}
	if (url.pathname === "/api/health") {
		sendJson(response, {
			ok: true,
			service: "loaf-board"
		});
		return;
	}
	if (url.pathname === "/api/sessions") {
		const scope = parseScope(url.searchParams.get("scope"));
		sendJson(response, await buildBoardSnapshot({
			...context.registryDir !== void 0 && { registryDir: context.registryDir },
			scope,
			cwd: context.cwd
		}));
		return;
	}
	const detailMatch = url.pathname.match(/^\/api\/sessions\/([^/]+)$/);
	if (detailMatch) {
		const detail = await buildBoardSessionDetail({
			...context.registryDir !== void 0 && { registryDir: context.registryDir },
			sessionId: decodeURIComponent(detailMatch[1])
		});
		sendJson(response, detail, detail.ok ? 200 : 404);
		return;
	}
	notFound(response);
}
function parseScope(value) {
	if (value === null || value === "" || value === "all") return "all";
	if (value === "cwd") return "cwd";
	throw new BoardHttpError(400, `invalid scope: ${value}`);
}
function sendHtml(response, html) {
	response.writeHead(200, {
		"Content-Type": "text/html; charset=utf-8",
		"Cache-Control": "no-store"
	});
	response.end(html);
}
function sendJson(response, payload, status = 200) {
	response.writeHead(status, {
		"Content-Type": "application/json; charset=utf-8",
		"Cache-Control": "no-store"
	});
	response.end(JSON.stringify(payload, null, 2));
}
function methodNotAllowed(response) {
	response.writeHead(405, {
		Allow: "GET",
		"Content-Type": "text/plain; charset=utf-8",
		"Cache-Control": "no-store"
	});
	response.end("Method not allowed");
}
function notFound(response) {
	response.writeHead(404, {
		"Content-Type": "text/plain; charset=utf-8",
		"Cache-Control": "no-store"
	});
	response.end("Not found");
}
function sendRouteError(response, error) {
	if (response.headersSent) {
		response.end();
		return;
	}
	const status = error instanceof BoardHttpError ? error.status : 500;
	response.writeHead(status, {
		"Content-Type": "application/json; charset=utf-8",
		"Cache-Control": "no-store"
	});
	response.end(JSON.stringify({
		ok: false,
		code: status === 400 ? "BAD_REQUEST" : "BOARD_SERVER_ERROR",
		message: error instanceof Error ? error.message : String(error)
	}));
}
function listen(server, port, host) {
	return new Promise((resolve, reject) => {
		server.once("error", reject);
		server.listen(port, host, () => {
			server.off("error", reject);
			resolve();
		});
	});
}
function parseBoardPort(value) {
	const port = Number(value);
	if (!Number.isInteger(port) || port < 0 || port > 65535) throw new BoardHttpError(400, `invalid board port: ${value}`);
	return port;
}
function isAddressInUse(error) {
	return error.code === "EADDRINUSE";
}
var BoardHttpError = class extends Error {
	status;
	constructor(status, message) {
		super(message);
		this.name = "BoardHttpError";
		this.status = status;
	}
};
//#endregion
//#region src/cli/commands/board.tsx
function waitForever() {
	return new Promise(() => {});
}
function registerBoard(program, ctx, deps) {
	declareCommandPolicy(program.command("board").description("Open the local read-only loaf board in a browser").option("--port <port>", `Loopback port (default: ${DEFAULT_BOARD_PORT}; use 0 for ephemeral)`).option("--in-cwd", "Only show sessions whose registered cwd matches the current cwd").option("--once", "Print one board snapshot and exit without starting a server").option("--open", "Open the board URL in the default browser"), {
		selectors: "forbidden",
		dryRun: "read-only",
		selectorStage: "action"
	}).action(async (opts) => {
		const scope = opts.inCwd ? "cwd" : "all";
		let port;
		try {
			port = opts.port === void 0 ? DEFAULT_BOARD_PORT : parseBoardPort(opts.port);
		} catch (error) {
			ctx.failure(diagnostic$2("USAGE", {
				reason: error instanceof Error ? error.message : String(error),
				port: opts.port
			}));
			return;
		}
		if (opts.once) {
			const snapshot = await createBoardOnceSnapshot({
				...deps.registryDir !== void 0 && { registryDir: deps.registryDir },
				cwd: process.cwd(),
				scope,
				now: deps.now()
			});
			ctx.success(snapshot, () => {
				const plural = snapshot.totals.sessions === 1 ? "session" : "sessions";
				return `loaf board: ${snapshot.totals.sessions} ${plural} (${snapshot.totals.active} active, ${snapshot.totals.blocked} blocked)\n`;
			});
			return;
		}
		try {
			const board = await startBoardServer({
				host: DEFAULT_BOARD_HOST,
				port,
				...deps.registryDir !== void 0 && { registryDir: deps.registryDir },
				cwd: process.cwd(),
				i18n: deps.i18n
			});
			ctx.success({
				ok: true,
				url: board.url,
				host: board.host,
				port: board.port
			}, () => `loaf board: ${board.url}\n`);
			if (opts.open) await (deps.openUrl ?? defaultOpenUrl)(board.url);
			const keepAlive = deps.boardKeepAlive ?? waitForever;
			try {
				await keepAlive(board.url);
			} finally {
				await board.close();
			}
		} catch (error) {
			if (isAddressInUse(error)) {
				ctx.failure(diagnostic$2("USAGE", { port }));
				return;
			}
			throw error;
		}
	});
}
//#endregion
//#region src/cli/prune/audit.ts
async function appendPruneLog(logPath, entry) {
	await promises.mkdir(path.dirname(logPath), { recursive: true });
	await promises.appendFile(logPath, `${JSON.stringify(entry)}\n`, "utf8");
}
async function readPruneLog(logPath) {
	let raw;
	try {
		raw = await promises.readFile(logPath, "utf8");
	} catch {
		return [];
	}
	const out = [];
	for (const line of raw.split("\n")) {
		const trimmed = line.trim();
		if (trimmed.length === 0) continue;
		try {
			out.push(JSON.parse(trimmed));
		} catch {}
	}
	return out;
}
//#endregion
//#region src/core/trash-bucket.ts
function trashDirectory(registryDir) {
	return path.join(path.dirname(registryDir), "trash");
}
function trashTimestampPath(trashDir, timestamp) {
	return path.join(trashDir, timestamp);
}
function trashBucketPath(trashDir, timestamp, sessionId) {
	return path.join(trashTimestampPath(trashDir, timestamp), sessionId);
}
/** Trash one selected session; manifest first, feature before registry. */
async function trashSession(opts) {
	const { registryDir, trashDir, timestamp, session: t } = opts;
	const registryEntryPath = path.join(registryDir, `${t.session_id}.json`);
	const bucket = trashBucketPath(trashDir, timestamp, t.session_id);
	await promises.mkdir(bucket, { recursive: true });
	const manifestPath = path.join(bucket, "manifest.json");
	const writeManifest = (featureTrashed) => promises.writeFile(manifestPath, `${JSON.stringify({
		session_id: t.session_id,
		feature: t.feature,
		cwd: t.cwd,
		feature_dir: t.feature_dir,
		orphan: t.orphan,
		feature_trashed: featureTrashed,
		at: timestamp
	}, null, 2)}\n`);
	await writeManifest(!t.orphan);
	let featureMoved = false;
	if (!t.orphan) {
		featureMoved = await moveDir(t.feature_dir, path.join(bucket, "feature"));
		if (!featureMoved) await writeManifest(false);
	}
	try {
		await moveFile(registryEntryPath, path.join(bucket, "registry.json"));
	} catch (regErr) {
		if (featureMoved) try {
			if (!await moveDir(path.join(bucket, "feature"), t.feature_dir)) throw missingMoveSource(path.join(bucket, "feature"));
		} catch (rollbackErr) {
			throw new AggregateError([regErr, rollbackErr], `registry deregister failed (${regErr.message}); feature rollback also failed (${rollbackErr.message}); feature data retained in ${bucket} (registry entry still at origin) — recover manually: move ${path.join(bucket, "feature")} back to ${t.feature_dir}; registry locations: ${registryEntryPath}, ${path.join(bucket, "registry.json")}`, { cause: regErr });
		}
		if (!(regErr instanceof CopyMoveError)) await promises.rm(bucket, {
			recursive: true,
			force: true
		}).catch(() => void 0);
		throw regErr;
	}
	return bucket;
}
const BucketManifestSchema = z.looseObject({
	feature: z.string().min(1),
	cwd: z.string().min(1),
	feature_dir: z.string().min(1),
	feature_trashed: z.boolean()
});
async function readBucketManifest(bucket) {
	const manifestPath = path.join(bucket, "manifest.json");
	const raw = await promises.readFile(manifestPath, "utf8");
	const invalid = (cause) => ({
		ok: false,
		code: "PRUNE_RESTORE_INCOMPLETE",
		detail: {
			bucket,
			missing: "manifest.json",
			path: manifestPath,
			cause
		}
	});
	let value;
	try {
		value = JSON.parse(raw);
	} catch (error) {
		if (error instanceof SyntaxError) return invalid(error.message);
		throw error;
	}
	const parsed = BucketManifestSchema.safeParse(value);
	if (!parsed.success) return invalid(parsed.error.message);
	return {
		ok: true,
		manifest: parsed.data
	};
}
async function pathExists(p) {
	try {
		await promises.stat(p);
		return true;
	} catch (error) {
		if (error.code === "ENOENT") return false;
		throw error;
	}
}
/** Timestamps whose bucket holds a manifest for this session. */
async function bucketsFor(trashDir, sessionId) {
	let tsDirs;
	try {
		tsDirs = await promises.readdir(trashDir);
	} catch (error) {
		if (error.code === "ENOENT") return [];
		throw error;
	}
	const found = [];
	for (const ts of tsDirs) if (await pathExists(path.join(trashBucketPath(trashDir, ts, sessionId), "manifest.json"))) found.push(ts);
	return found;
}
async function restoreTrashBucket(opts) {
	const { registryDir, trashDir, sessionId, at } = opts;
	const timestamps = await bucketsFor(trashDir, sessionId);
	if (timestamps.length === 0) return {
		ok: false,
		code: "PRUNE_RESTORE_NOT_FOUND",
		detail: { session_id: sessionId }
	};
	let chosen;
	if (at !== void 0) {
		if (!timestamps.includes(at)) return {
			ok: false,
			code: "PRUNE_RESTORE_NOT_FOUND",
			detail: {
				session_id: sessionId,
				at,
				timestamps
			}
		};
		chosen = at;
	} else if (timestamps.length > 1) return {
		ok: false,
		code: "PRUNE_RESTORE_AMBIGUOUS",
		detail: {
			session_id: sessionId,
			timestamps
		}
	};
	else chosen = timestamps[0];
	const bucket = trashBucketPath(trashDir, chosen, sessionId);
	const read = await readBucketManifest(bucket);
	if (!read.ok) return read;
	const manifest = read.manifest;
	const registryDest = path.join(registryDir, `${sessionId}.json`);
	const registrySrc = path.join(bucket, "registry.json");
	const featureSrc = path.join(bucket, "feature");
	if (!await pathExists(registrySrc)) return {
		ok: false,
		code: "PRUNE_RESTORE_INCOMPLETE",
		detail: {
			bucket,
			missing: "registry.json"
		}
	};
	if (manifest.feature_trashed && !await pathExists(featureSrc)) return {
		ok: false,
		code: "PRUNE_RESTORE_INCOMPLETE",
		detail: {
			bucket,
			missing: "feature/"
		}
	};
	if (await pathExists(registryDest)) return {
		ok: false,
		code: "PRUNE_PATH_OCCUPIED",
		detail: { path: registryDest }
	};
	if (manifest.feature_trashed && await pathExists(manifest.feature_dir)) return {
		ok: false,
		code: "PRUNE_PATH_OCCUPIED",
		detail: { path: manifest.feature_dir }
	};
	if (!opts.dryRun) {
		let featureMoved = false;
		if (manifest.feature_trashed) {
			await promises.mkdir(path.dirname(manifest.feature_dir), { recursive: true });
			featureMoved = await moveDir(featureSrc, manifest.feature_dir);
			if (!featureMoved) return {
				ok: false,
				code: "PRUNE_RESTORE_INCOMPLETE",
				detail: {
					bucket,
					missing: "feature/"
				}
			};
		}
		try {
			await moveFile(registrySrc, registryDest);
		} catch (registryError) {
			if (featureMoved) try {
				if (!await moveDir(manifest.feature_dir, featureSrc)) throw missingMoveSource(manifest.feature_dir);
			} catch (rollbackError) {
				throw new AggregateError([registryError, rollbackError], `registry restore failed (${errorMessage(registryError)}); feature rollback also failed (${errorMessage(rollbackError)}); feature locations: ${manifest.feature_dir}, ${featureSrc}; registry locations: ${registrySrc}, ${registryDest}; manifest retained at ${path.join(bucket, "manifest.json")}`, { cause: registryError });
			}
			throw registryError;
		}
		try {
			await promises.rm(bucket, {
				recursive: true,
				force: true
			});
		} catch (error) {
			throw new Error(`bucket cleanup failed (${errorMessage(error)}); artifacts restored; remaining bucket: ${bucket}`, { cause: error });
		}
	}
	return {
		ok: true,
		session_id: sessionId,
		feature: manifest.feature,
		cwd: manifest.cwd,
		restored_from: bucket
	};
}
var CopyMoveError = class extends Error {
	constructor(kind, source, destination, cause) {
		super(`${kind} transfer failed (${errorMessage(cause)}); inspect retained copies at ${source} and ${destination}`, { cause });
		this.name = "CopyMoveError";
	}
};
function errorMessage(error) {
	return error instanceof Error ? error.message : String(error);
}
function missingMoveSource(source) {
	return Object.assign(/* @__PURE__ */ new Error(`transfer source disappeared: ${source}`), { code: "ENOENT" });
}
/**
* Rename a directory; copy+rm across devices. Returns false (not an error) when
* the source is already gone (ENOENT) so callers can degrade gracefully.
*/
async function moveDir(src, dest) {
	try {
		await promises.rename(src, dest);
		return true;
	} catch (err) {
		const code = err.code;
		if (code === "ENOENT") {
			if (await pathExists(src)) throw err;
			return false;
		}
		if (code === "EXDEV") {
			try {
				await promises.cp(src, dest, { recursive: true });
				await promises.rm(src, {
					recursive: true,
					force: true
				});
			} catch (error) {
				throw new CopyMoveError("directory", src, dest, error);
			}
			return true;
		}
		throw err;
	}
}
/** Rename a file; copy+unlink across devices. */
async function moveFile(src, dest) {
	try {
		await promises.rename(src, dest);
	} catch (err) {
		if (err.code === "EXDEV") try {
			await promises.copyFile(src, dest);
			await promises.rm(src, { force: true });
		} catch (error) {
			throw new CopyMoveError("registry", src, dest, error);
		}
		else throw err;
	}
}
/** ISO 8601 with `:` → `-` (e.g. 2026-06-09T12-34-56.789Z). Path-segment safe. */
function toTrashTs(d) {
	return d.toISOString().replace(/:/g, "-");
}
/**
* Reverse `toTrashTs`. Only the HH-MM-SS dashes in the time part are turned back
* into colons (the date part keeps its dashes; the `.sssZ` millis has no dash).
* Returns null for anything that does not parse — callers must not GC a bucket
* they cannot date.
*/
function fromTrashTs(name) {
	const tIdx = name.indexOf("T");
	if (tIdx < 0) return null;
	const datePart = name.slice(0, tIdx);
	const timePart = name.slice(tIdx + 1).replace(/-/g, ":");
	const ms = Date.parse(`${datePart}T${timePart}`);
	return Number.isNaN(ms) ? null : new Date(ms);
}
//#endregion
//#region src/cli/prune/execute.ts
async function executePrune(opts) {
	const { registryDir, trashDir, targets, mode, timestamp } = opts;
	const done = [];
	const failed = [];
	for (const t of targets) {
		const registryEntryPath = path.join(registryDir, `${t.session_id}.json`);
		try {
			if (mode === "trash") {
				const bucket = await trashSession({
					registryDir,
					trashDir,
					timestamp,
					session: t
				});
				done.push({
					session_id: t.session_id,
					feature: t.feature,
					cwd: t.cwd,
					mode: "trash",
					orphan: t.orphan,
					trash_path: bucket
				});
			} else {
				if (!t.orphan) await promises.rm(t.feature_dir, {
					recursive: true,
					force: true
				});
				await promises.rm(registryEntryPath, { force: true });
				done.push({
					session_id: t.session_id,
					feature: t.feature,
					cwd: t.cwd,
					mode: "purge",
					orphan: t.orphan
				});
			}
		} catch (err) {
			failed.push({
				session_id: t.session_id,
				error: err.message
			});
		}
	}
	return {
		done,
		failed
	};
}
//#endregion
//#region src/cli/prune/resolve.ts
/** Terminal sub_states — the only sessions prune touches without --force. */
const TERMINAL_SUB_STATES = new Set([
	"DONE.delivered",
	"DONE.archived",
	"DONE.abandoned"
]);
async function probePath(p) {
	try {
		await promises.stat(p);
		return "exists";
	} catch (err) {
		const code = err.code;
		return code === "ENOENT" || code === "ENOTDIR" ? "missing" : "error";
	}
}
async function resolvePruneTargets(opts) {
	const { registryDir, scope, includeActive } = opts;
	let files;
	try {
		files = await promises.readdir(registryDir);
	} catch {
		return {
			targets: [],
			skipped: []
		};
	}
	const ids = files.filter((f) => f.endsWith(".json")).map((f) => f.slice(0, -5));
	const targets = [];
	const skipped = [];
	let scopeCwd;
	if (scope.kind === "cwd") scopeCwd = await tryRealpath(scope.cwd) ?? scope.cwd;
	else if (scope.kind === "orphans" && scope.cwd !== void 0) scopeCwd = await tryRealpath(scope.cwd) ?? scope.cwd;
	for (const id of ids) {
		const read = await readRegistryEntry(registryDir, id);
		if (!read.ok) continue;
		const e = read.file;
		if (scope.kind === "session" && !e.session_id.startsWith(scope.id)) continue;
		if (scopeCwd !== void 0) {
			if ((await tryRealpath(e.cwd) ?? e.cwd) !== scopeCwd) continue;
		}
		const feature_dir = path.join(e.cwd, ".loaf", e.feature);
		const featProbe = await probePath(feature_dir);
		if (featProbe === "error") {
			skipped.push({
				session_id: e.session_id,
				reason: "inaccessible",
				sub_state: e.sub_state
			});
			continue;
		}
		const orphan = featProbe === "missing";
		const target = {
			session_id: e.session_id,
			feature: e.feature,
			cwd: e.cwd,
			sub_state: e.sub_state,
			feature_dir,
			orphan
		};
		if (scope.kind === "orphans") {
			if (orphan) targets.push(target);
			continue;
		}
		if (!TERMINAL_SUB_STATES.has(e.sub_state) && !includeActive) {
			skipped.push({
				session_id: e.session_id,
				reason: "non-terminal",
				sub_state: e.sub_state
			});
			continue;
		}
		if (!orphan) {
			const lockProbe = await probePath(path.join(feature_dir, ".lock"));
			if (lockProbe === "exists") {
				skipped.push({
					session_id: e.session_id,
					reason: "locked",
					sub_state: e.sub_state
				});
				continue;
			}
			if (lockProbe === "error") {
				skipped.push({
					session_id: e.session_id,
					reason: "inaccessible",
					sub_state: e.sub_state
				});
				continue;
			}
		}
		targets.push(target);
	}
	return {
		targets,
		skipped
	};
}
//#endregion
//#region src/cli/prune/trash-gc.ts
const DAY_MS = 864e5;
async function gcTrash(opts) {
	const { trashDir, olderThanDays, now, dryRun } = opts;
	const cutoff = now.getTime() - olderThanDays * DAY_MS;
	let entries;
	try {
		entries = await promises.readdir(trashDir);
	} catch {
		return {
			removed: [],
			kept: []
		};
	}
	const removed = [];
	const kept = [];
	for (const ts of entries) {
		const when = fromTrashTs(ts);
		if (when === null) {
			kept.push({ ts });
			continue;
		}
		if (when.getTime() < cutoff) {
			const p = trashTimestampPath(trashDir, ts);
			if (!dryRun) await promises.rm(p, {
				recursive: true,
				force: true
			});
			removed.push({
				ts,
				path: p
			});
		} else kept.push({ ts });
	}
	return {
		removed,
		kept
	};
}
//#endregion
//#region src/cli/commands/prune.tsx
/** Resolve a uuid prefix against the registry (mirrors SESSION_SHORT_AMBIGUOUS). */
async function resolveSessionPrefix(registryDir, prefix) {
	let files;
	try {
		files = await promises.readdir(registryDir);
	} catch {
		return { kind: "not-found" };
	}
	const matches = files.filter((f) => f.endsWith(".json")).map((f) => f.slice(0, -5)).filter((id) => id.startsWith(prefix));
	if (matches.length === 0) return { kind: "not-found" };
	if (matches.length > 1) return {
		kind: "ambiguous",
		matches
	};
	return {
		kind: "found",
		id: matches[0]
	};
}
/** Commander coercion for `--older-than <days>`: positive integer or throws. */
function parseDaysOption(value) {
	const n = Number(value);
	if (!Number.isInteger(n) || n < 0) throw new Error(`--older-than must be a non-negative integer number of days (got ${value})`);
	return n;
}
function describeScope(scope) {
	switch (scope.kind) {
		case "session": return `session:${scope.id}`;
		case "cwd": return `cwd:${scope.cwd}`;
		case "orphans": return scope.cwd === void 0 ? "orphans" : `orphans:${scope.cwd}`;
		default: return "all";
	}
}
function registerPrune(program, ctx, deps) {
	declareCommandPolicy(declareCommandPolicy(program.command("prune").description("Garbage-collect finished sessions (terminal-only; recoverable trash). Scope with the global --session <id> or one of --in-cwd / --project / --all / --orphans.").option("--in-cwd", "Prune sessions registered under the current cwd").option("--project <path>", "Prune sessions registered under <path>").option("--all", "Prune across all sessions (global)").option("--orphans", "Remove only dangling registry entries (feature dir gone)").option("--force", "Include active (non-terminal) sessions — never overrides a held lock").option("--purge", "Hard-delete instead of moving to recoverable trash").option("--yes", "Execute; without it, prune previews and changes nothing").option("--history", "Print the prune audit log (~/.loaf/prune-log.jsonl) and exit").option("--trash", "Trash retention sweep: remove trash buckets older than --older-than").option("--older-than <days>", "(with --trash) remove buckets older than N days", parseDaysOption), {
		selectors: "registry",
		dryRun: "prune"
	}).action(async (_localOpts, command) => {
		const opts = command.optsWithGlobals();
		const base = path.dirname(deps.registryDir);
		if (opts.history === true) {
			const entries = await readPruneLog(path.join(base, "prune-log.jsonl"));
			ctx.success({
				ok: true,
				count: entries.length,
				entries
			}, () => {
				if (entries.length === 0) return "prune history: (empty)\n";
				return `${entries.map((e) => `${e.at}  ${e.mode}  ${e.scope}  pruned=${e.pruned.length}`).join("\n")}\n`;
			});
			return;
		}
		if (opts.trash === true) {
			if (opts.olderThan === void 0) {
				ctx.failure(diagnostic$2("USAGE", { reason: "trash_age_required" }));
				return;
			}
			const previewTrash = opts.yes !== true || opts.dryRun === true;
			const r = await gcTrash({
				trashDir: trashDirectory(deps.registryDir),
				olderThanDays: opts.olderThan,
				now: deps.now(),
				dryRun: previewTrash
			});
			ctx.success({
				ok: true,
				dry_run: previewTrash,
				removed: r.removed,
				kept: r.kept
			}, () => `${previewTrash ? "would remove" : "removed"} ${r.removed.length} trash bucket(s), kept ${r.kept.length}` + (previewTrash ? " — re-run with --yes to execute" : "") + "\n");
			return;
		}
		const scopeCount = (opts.session !== void 0 ? 1 : 0) + (opts.inCwd ? 1 : 0) + (opts.project !== void 0 ? 1 : 0) + (opts.all ? 1 : 0) + (opts.orphans ? 1 : 0);
		if (scopeCount !== 1) {
			ctx.failure(diagnostic$2("USAGE", { scope_count: scopeCount }));
			return;
		}
		let scope;
		if (opts.session !== void 0) {
			const resolved = await resolveSessionPrefix(deps.registryDir, opts.session);
			if (resolved.kind === "not-found") {
				ctx.failure(diagnostic$2("SESSION_NOT_FOUND", { uuid_or_prefix: opts.session }));
				return;
			}
			if (resolved.kind === "ambiguous") {
				ctx.failure(diagnostic$2("SESSION_SHORT_AMBIGUOUS", {
					prefix: opts.session,
					match_count: resolved.matches.length,
					candidate_list: resolved.matches
				}));
				return;
			}
			scope = {
				kind: "session",
				id: resolved.id
			};
		} else if (opts.inCwd) scope = {
			kind: "cwd",
			cwd: await tryRealpath(process.cwd()) ?? process.cwd()
		};
		else if (opts.project !== void 0) scope = {
			kind: "cwd",
			cwd: await tryRealpath(opts.project) ?? opts.project
		};
		else if (opts.all) scope = { kind: "all" };
		else scope = { kind: "orphans" };
		const { targets, skipped } = await resolvePruneTargets({
			registryDir: deps.registryDir,
			scope,
			includeActive: opts.force === true
		});
		const mode = opts.purge === true ? "purge" : "trash";
		if (opts.yes !== true || opts.dryRun === true) {
			ctx.success({
				ok: true,
				dry_run: true,
				mode,
				pruned: targets.map((t) => ({
					session_id: t.session_id,
					feature: t.feature,
					cwd: t.cwd,
					sub_state: t.sub_state,
					orphan: t.orphan
				})),
				skipped
			}, () => `would ${mode} ${targets.length} session(s)` + (skipped.length > 0 ? `, skip ${skipped.length}` : "") + ` — re-run with --yes to execute\n`);
			return;
		}
		const trashDir = trashDirectory(deps.registryDir);
		const logPath = path.join(base, "prune-log.jsonl");
		const timestamp = toTrashTs(deps.now());
		const result = await executePrune({
			registryDir: deps.registryDir,
			trashDir,
			targets,
			mode,
			timestamp
		});
		await appendPruneLog(logPath, {
			at: deps.now().toISOString(),
			scope: describeScope(scope),
			mode,
			actor: deps.actor,
			pruned: result.done.map((d) => ({
				session_id: d.session_id,
				feature: d.feature,
				orphan: d.orphan
			})),
			skipped: skipped.map((s) => ({
				session_id: s.session_id,
				reason: s.reason
			})),
			...result.failed.length > 0 && { failed: result.failed }
		});
		const body = {
			dry_run: false,
			mode,
			pruned: result.done,
			skipped,
			failed: result.failed
		};
		if (result.failed.length > 0) {
			ctx.failure(diagnostic$2("PRUNE_PARTIAL_FAILURE", body));
			return;
		}
		ctx.success({
			ok: true,
			...body
		}, () => `${mode === "purge" ? "purged" : "pruned"} ${result.done.length} session(s)` + (skipped.length > 0 ? `, skipped ${skipped.length}` : "") + "\n");
	}).command("restore <session-id>").description("Restore a trashed session (registry entry + feature dir) from the prune trash").option("--at <ts>", "Disambiguate when the session was trashed more than once"), {
		selectors: "registry",
		dryRun: "prune"
	}).action(async (sessionId, _localOpts, command) => {
		const opts = command.optsWithGlobals();
		const dryRun = opts.dryRun === true;
		const trashDir = trashDirectory(deps.registryDir);
		const result = await restoreTrashBucket({
			registryDir: deps.registryDir,
			trashDir,
			sessionId,
			dryRun,
			...opts.at !== void 0 && { at: opts.at }
		});
		if (!result.ok) {
			ctx.failure(result);
			return;
		}
		ctx.success({
			ok: true,
			dry_run: dryRun,
			session_id: result.session_id,
			feature: result.feature,
			cwd: result.cwd
		}, () => `${dryRun ? "would restore" : "restored"} ${result.session_id} (${result.feature})\n`);
	});
}
//#endregion
//#region src/cli/command-program.ts
function createCommandProgram(ctx, mutator, input, i18n, actor, deps, isStdinTty, now) {
	const program = new Command();
	program.name("loaf").description("Spec-driven development protocol CLI").version(version).option("--format <fmt>", `Output format: ${FORMAT_MODES_HUMAN} (default: text)`).option("--plain", "Alias for --format text (clig.dev convention)").option("--no-color", "Disable color (NO_COLOR/LOAF_NO_COLOR/TERM=dumb equivalents)").option("-q, --quiet", "Suppress advisory stderr (state-change + next hint; errors still emit)").option("-v, --verbose", "Increase advisory detail; counter — repeat for more (-v, -vv)", (_v, prior) => (prior ?? 0) + 1, 0).option("--no-input", "Non-interactive mode: refuse git-config actor fallback; forward-compat with future prompts (skill / hook / CI)").option("--debug", "Write per-invocation trace.jsonl (LOAF_DEBUG=1 / DEBUG=1 equivalents)").option("-n, --dry-run", "Validate without writing (mutating commands only); read-only commands exit 2").option("--session <uuid-or-prefix>", "Resolve session by UUID or ≥8-char prefix (registry lookup; see §10.3)").addHelpText("after", helpFooter()).configureOutput({ writeErr: () => {} }).exitOverride();
	registerLifecycle(program, ctx, mutator, actor, deps.runtimeDir ?? defaultRuntimeDir(os.homedir()), deps.now ?? (() => /* @__PURE__ */ new Date()), deps.executeClosureHooks);
	registerGate(program, ctx, mutator, actor);
	registerTerminalExecute(program, ctx, mutator, actor);
	registerProfileConfig(program, ctx, mutator, actor, deps.userConfigHomeDir);
	const { tasksCmd } = registerTasks(program, ctx, mutator, actor, input);
	registerTerminalSettle(program, ctx, mutator, actor);
	registerPending(program, ctx, mutator, actor);
	const { evidenceCmd } = registerEvidence(program, ctx, mutator, actor, input);
	registerJournal(program, ctx);
	registerLessons(program, ctx, mutator, actor);
	const renderTuiImpl = deps.renderTui ?? defaultRenderTui;
	const isStdoutTty = deps.isStdoutTty ?? (() => process.stdout.isTTY === true);
	registerIntegrations(program, ctx, mutator, actor, i18n, isStdinTty, renderTuiImpl, isStdoutTty, deps.registryDir, deps.now, deps.runtimeDir ?? defaultRuntimeDir(os.homedir()), deps.now ?? (() => /* @__PURE__ */ new Date()));
	registerBoard(program, ctx, {
		i18n,
		now,
		...deps.registryDir !== void 0 && { registryDir: deps.registryDir },
		...deps.openUrl !== void 0 && { openUrl: deps.openUrl },
		...deps.boardKeepAlive !== void 0 && { boardKeepAlive: deps.boardKeepAlive }
	});
	registerPrune(program, ctx, {
		registryDir: deps.registryDir ?? defaultRegistryDir(),
		now,
		actor
	});
	const { findingCmd } = registerFinding(program, ctx, mutator, actor);
	const { specCmd } = registerSpec(program, ctx, mutator, actor, isStdinTty, isStdoutTty, input, deps.runEditor ?? runEditor);
	registerState(program, specCmd, tasksCmd, evidenceCmd, findingCmd);
	assertLeafCommandPolicies(program);
	installCommandActionPolicy(program, ctx);
	return program;
}
/** Same registrations as execution; input/output seams fail if construction
* accidentally executes an action. No user config, registry or session reads.
*/
function createPolicyCommandProgram() {
	const unavailable = () => {
		throw new Error("command inventory must not execute actions");
	};
	const i18n = createI18n("en", BUILTIN_BUNDLES);
	const ctx = createCommandContext(["node", "loaf"], {
		i18n,
		writeStdout: unavailable,
		writeStderr: unavailable
	});
	return createCommandProgram(ctx, createCommandMutator(ctx, { registryWriter: void 0 }), createJsonInputIngestor({
		readStdin: async () => unavailable(),
		isStdinTty: unavailable
	}), i18n, "cli:inventory", {}, unavailable, unavailable);
}
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
function extractFeature(argv) {
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
		feature: extractFeature(input.argv),
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
z.object({
	schema_version: z.literal(2),
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
//#region src/cli.tsx
let _sigintInstalled = false;
function installSigintHandler(deps) {
	const handler = () => {
		releaseFeatureWriteLeasesForSignalSync();
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
function detectRenderAsJson(argv) {
	const options = optionArgv(argv);
	return options.some((a) => a === "--format=json" || a === "--format" && options[options.indexOf(a) + 1] === "json");
}
async function main(argv = process.argv, deps = {}) {
	const wantsHelpOrVersion = optionArgv(argv).some((a) => a === "--help" || a === "-h" || a === "--version" || a === "-V");
	if (!wantsHelpOrVersion) {
		const presentation = parsePresentation(argv);
		if (!presentation.ok) {
			if (presentation.kind === "INVALID_FORMAT") writeDiagnosticFailure(diagnostic$2("INVALID_FORMAT", {
				value: presentation.rawValue,
				allowed_values: FORMAT_MODES
			}), {
				format: "text",
				i18n: preparseI18nFromEnv(process.env),
				writeStderr: (line) => process.stderr.write(line)
			});
			else {
				const { conflicting, renderAsJson } = presentation;
				writeDiagnosticFailure(diagnostic$2("MUTUALLY_EXCLUSIVE_FLAGS", { conflicting }), {
					format: renderAsJson ? "json" : "text",
					i18n: preparseI18nFromEnv(process.env),
					writeStderr: (line) => process.stderr.write(line)
				});
			}
			return 2;
		}
	}
	if (!wantsHelpOrVersion) {
		const policy = evaluateCommandPreparse(createPolicyCommandProgram(), argv, process.env);
		if (policy.kind === "failure") {
			writeDiagnosticFailure(policy.diagnostic, {
				format: detectRenderAsJson(argv) ? "json" : "text",
				i18n: preparseI18nFromEnv(process.env),
				writeStderr: (line) => process.stderr.write(line)
			});
			return 2;
		}
		if (policy.kind === "hook-events") {
			process.stdout.write(renderHookEvents(detectRenderAsJson(argv)));
			return 0;
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
		writeDiagnosticFailure(localeResolution, {
			format: presentation.ok && presentation.format === "json" ? "json" : "text",
			i18n: preparseI18nFromEnv(process.env),
			writeStderr: (line) => process.stderr.write(line)
		});
		return 2;
	}
	const i18n = createI18n(localeResolution.locale, BUILTIN_BUNDLES);
	const readStdin = deps.readStdin ?? defaultReadStdin;
	const isStdinTty = deps.isStdinTty ?? defaultIsStdinTty;
	const input = createJsonInputIngestor({
		readStdin,
		isStdinTty
	});
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
	const actor = `cli:loaf@${process.env["USER"] ?? "unknown"}`;
	const ctx = createCommandContext(argv, {
		writeStdout: writeStdoutCaptured,
		writeStderr: (s) => process.stderr.write(s),
		loadSession,
		loadProjections,
		loadProjectionsDirect: loadProjections,
		i18n,
		...deps.isInteractiveHuman !== void 0 && { isInteractiveHuman: deps.isInteractiveHuman },
		...deps.readGitConfig !== void 0 && { readGitConfig: deps.readGitConfig },
		readStdin,
		isStdinTty,
		...deps.registryDir !== void 0 && { registryDir: deps.registryDir }
	});
	const program = createCommandProgram(ctx, createCommandMutator(ctx, { registryWriter: deps.registryDir !== void 0 || deps.registryNow !== void 0 || deps.registryCwd !== void 0 ? {
		...deps.registryDir !== void 0 && { registryDir: deps.registryDir },
		...deps.registryNow !== void 0 && { now: deps.registryNow },
		...deps.registryCwd !== void 0 && { cwd: deps.registryCwd }
	} : void 0 }), input, i18n, actor, deps, isStdinTty, now);
	const t0 = monotonicNow();
	let resolvedExit = 0;
	try {
		try {
			await program.parseAsync(argv);
			resolvedExit = ctx.exitCode;
			return ctx.exitCode;
		} catch (err) {
			if (err instanceof CommandPolicyComplete) {
				resolvedExit = ctx.exitCode;
				return resolvedExit;
			}
			if (err instanceof CommanderError) {
				if (err.exitCode === 0) {
					resolvedExit = 0;
					return 0;
				}
				ctx.failure(diagnostic$2("USAGE", {
					parser_code: err.code,
					reason: err.message
				}));
				resolvedExit = ctx.exitCode;
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
	for (const token of scanArgv(argv).slice(2)) {
		if (token.raw.startsWith("--")) break;
		chain.push(token.raw);
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