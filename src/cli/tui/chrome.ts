import type { I18n } from "../i18n.js";
import { CHROME_KEYS, type ChromeKey } from "../runtime-i18n-keys.js";
import type { TuiSortMode } from "./list-model.js";

export type TuiDetailField =
  | "feature"
  | "session"
  | "label"
  | "workspace"
  | "ceremony"
  | "phase"
  | "iteration"
  | "complexity"
  | "created"
  | "updated"
  | "spec_locked"
  | "verify_accepted"
  | "spec_version"
  | "tail_seq";

export type TuiDetailSection = "tasks" | "evidence" | "open_findings" | "pending";
export type TuiDetailEvidenceBadge = "pass" | "fail" | "waived";

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
  tail_seq: CHROME_KEYS.tuiDetailFieldTailSeq,
} as const satisfies Record<TuiDetailField, ChromeKey>;

const DETAIL_SECTION_KEYS = {
  tasks: CHROME_KEYS.tuiDetailSectionTasks,
  evidence: CHROME_KEYS.tuiDetailSectionEvidence,
  open_findings: CHROME_KEYS.tuiDetailSectionOpenFindings,
  pending: CHROME_KEYS.tuiDetailSectionPending,
} as const satisfies Record<TuiDetailSection, ChromeKey>;

const EVIDENCE_BADGE_KEYS = {
  pass: CHROME_KEYS.tuiDetailEvidenceBadgePass,
  fail: CHROME_KEYS.tuiDetailEvidenceBadgeFail,
  waived: CHROME_KEYS.tuiDetailEvidenceBadgeWaived,
} as const satisfies Record<TuiDetailEvidenceBadge, ChromeKey>;

export function formatTuiListTitle(i18n: I18n, activeCount: number, totalCount: number): string {
  return i18n.t(CHROME_KEYS.tuiListTitle, {
    active_count: activeCount,
    total_count: totalCount,
  });
}

export function formatTuiSortLabel(i18n: I18n, sortMode: TuiSortMode): string {
  const sort = i18n.t(
    sortMode === "time" ? CHROME_KEYS.tuiListSortTime : CHROME_KEYS.tuiListSortStatus,
  );
  return i18n.t(CHROME_KEYS.tuiListSort, { sort });
}

export function formatTuiListHelp(i18n: I18n): string {
  return i18n.t(CHROME_KEYS.tuiListHelp);
}

export function formatTuiListRowIteration(i18n: I18n, iteration: string): string {
  return i18n.t(CHROME_KEYS.tuiListRowIteration, { value: iteration });
}

export function formatTuiDetailHelp(i18n: I18n): string {
  return i18n.t(CHROME_KEYS.tuiDetailHelp);
}

export function formatTuiDetailNone(i18n: I18n): string {
  return i18n.t(CHROME_KEYS.tuiDetailNone);
}

export function formatTuiBoolean(i18n: I18n, value: boolean): string {
  return i18n.t(value ? CHROME_KEYS.tuiDetailBooleanTrue : CHROME_KEYS.tuiDetailBooleanFalse);
}

export function formatTuiDetailField(
  i18n: I18n,
  field: TuiDetailField,
  value: string | number,
): string {
  return i18n.t(DETAIL_FIELD_KEYS[field], { value });
}

export function formatTuiDetailBasedOn(i18n: I18n, spec: number, tasks: number): string {
  return i18n.t(CHROME_KEYS.tuiDetailFieldBasedOn, { spec, tasks });
}

export function formatTuiDetailSectionTitle(
  i18n: I18n,
  section: TuiDetailSection,
  count: number,
): string {
  return i18n.t(DETAIL_SECTION_KEYS[section], { count });
}

export function formatTuiDetailEvidenceBadge(i18n: I18n, badge: TuiDetailEvidenceBadge): string {
  return i18n.t(EVIDENCE_BADGE_KEYS[badge]);
}

export function formatTuiDetailSidecarSummary(i18n: I18n, path: string): string {
  return i18n.t(CHROME_KEYS.tuiDetailSidecarSummary, { path });
}

export function formatTuiDetailStepSummary(i18n: I18n, done: number, total: number): string {
  return i18n.t(CHROME_KEYS.tuiDetailStepSummary, { done, total });
}
