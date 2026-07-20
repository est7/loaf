import type { I18n } from "../../i18n.js";
import { taskKindKey, taskStatusKey, type TaskStatus } from "../../runtime-i18n-keys.js";
import type { TaskFullProjection } from "../../../core/task-schema.js";

export function formatTaskListKind(i18n: I18n, kind: TaskFullProjection["kind"]): string {
  if (i18n.locale === "en") return kind;
  return i18n.t(taskKindKey(kind));
}

export function formatTaskStatus(i18n: I18n, status: TaskStatus): string {
  return i18n.t(taskStatusKey(status));
}
