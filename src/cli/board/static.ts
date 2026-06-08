// Visual direction adapted from GoalBuddy's MIT-licensed local goal board
// (Copyright 2026 tolibear). This file is intentionally source-shaped rather
// than generated: loaf owns the data model, GoalBuddy only informs the board UI.

import type { SubState } from "../../core/journal-entry.js";
import type { I18n } from "../i18n.js";
import {
  phaseKey,
  statusIndicatorKey,
  subStateKey,
  type Phase,
} from "../runtime-i18n-keys.js";
import type { TuiStatusBucket } from "../tui/types.js";

const BOARD_PHASES = ["TRIAGE", "SPEC", "EXECUTE", "VERIFY", "SETTLE", "DONE"] as const satisfies readonly Phase[];
const BOARD_COLUMN_DESCRIPTION_KEYS = {
  TRIAGE: "board.column.TRIAGE.description",
  SPEC: "board.column.SPEC.description",
  EXECUTE: "board.column.EXECUTE.description",
  VERIFY: "board.column.VERIFY.description",
  SETTLE: "board.column.SETTLE.description",
  DONE: "board.column.DONE.description",
} as const satisfies Record<Phase, string>;
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
  "SETTLE.reconcile",
  "SETTLE.lessons",
  "DONE.delivered",
  "DONE.archived",
  "DONE.abandoned",
] as const satisfies readonly SubState[];
const BOARD_STATUS_BUCKETS = ["done", "blocked", "running", "idle"] as const satisfies readonly TuiStatusBucket[];

type BoardChromeMessages = {
  appTitle: string;
  brand: string;
  scopeLabel: string;
  allSessions: string;
  currentCwd: string;
  refresh: string;
  themeToggle: string;
  eyebrow: string;
  heading: string;
  subtitle: string;
  active: string;
  blocked: string;
  updated: string;
  waiting: string;
  boardLabel: string;
  noSessions: string;
  none: string;
  session: string;
  sessionDetail: string;
  closeSessionDetail: string;
  loading: string;
  sessionError: string;
  iterationShort: string;
  justNow: string;
};

type BoardDetailMessages = {
  phase: string;
  subState: string;
  tailSeq: string;
  tasks: string;
  evidence: string;
  openFindings: string;
  pending: string;
  taskDoneSuffix: string;
  evidencePassingSuffix: string;
  stepsSuffix: string;
};

type BoardColumnMessage = {
  id: Phase;
  title: string;
  description: string;
};

type BoardMessages = {
  locale: string;
  chrome: BoardChromeMessages;
  detail: BoardDetailMessages;
  columns: BoardColumnMessage[];
  labels: {
    phases: Record<Phase, string>;
    subStates: Record<SubState, string>;
    statuses: Record<TuiStatusBucket, string>;
  };
};

export function renderBoardHtml(i18n: I18n): string {
  const messages = buildBoardMessages(i18n);
  return [
    "<!doctype html>",
    `<html lang="${escapeHtmlAttr(i18n.locale)}">`,
    "<head>",
    '  <meta charset="utf-8">',
    '  <meta name="viewport" content="width=device-width, initial-scale=1">',
    `  <title>${escapeHtml(messages.chrome.appTitle)}</title>`,
    `  <style>${BOARD_STYLES}</style>`,
    "</head>",
    '<body data-theme="system">',
    renderTopbar(messages),
    renderMainShell(messages),
    renderModal(messages),
    `  <script>window.__LOAF_BOARD_MESSAGES__=${scriptJson(messages)};</script>`,
    `  <script type="module">${BOARD_SCRIPT}</script>`,
    "</body>",
    "</html>",
  ].join("\n");
}

function renderTopbar(messages: BoardMessages): string {
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

function renderMainShell(messages: BoardMessages): string {
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

function renderModal(messages: BoardMessages): string {
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

function buildBoardMessages(i18n: I18n): BoardMessages {
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
      justNow: i18n.t("relative.just_now"),
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
      stepsSuffix: i18n.t("board.detail.steps_suffix"),
    },
    columns: BOARD_PHASES.map((phase) => ({
      id: phase,
      title: i18n.t(phaseKey(phase)),
      description: i18n.t(BOARD_COLUMN_DESCRIPTION_KEYS[phase]),
    })),
    labels: {
      phases: Object.fromEntries(
        BOARD_PHASES.map((phase) => [phase, i18n.t(phaseKey(phase))]),
      ) as Record<Phase, string>,
      subStates: Object.fromEntries(
        BOARD_SUB_STATES.map((subState) => [subState, i18n.t(subStateKey(subState))]),
      ) as Record<SubState, string>,
      statuses: Object.fromEntries(
        BOARD_STATUS_BUCKETS.map((status) => [status, i18n.t(statusIndicatorKey(status))]),
      ) as Record<TuiStatusBucket, string>,
    },
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
setInterval(loadSnapshot, 1500);

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
    escapeAttr(session.status_bucket) + '">' + escapeHtml(statusLabel(session.status_bucket)) + '</span></div>' +
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

function statusLabel(status) {
  return MESSAGES.labels.statuses[status] || status;
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

function scriptJson(value: unknown): string {
  return JSON.stringify(value).replaceAll("<", "\\u003c");
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function escapeHtmlAttr(value: string): string {
  return escapeHtml(value);
}
