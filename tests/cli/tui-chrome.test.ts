import { describe, expect, test } from "vitest";

import { BUILTIN_BUNDLES, createI18n, DEFAULT_I18N } from "../../src/cli/i18n.js";
import {
  formatTuiBoolean,
  formatTuiDetailEvidenceBadge,
  formatTuiDetailField,
  formatTuiDetailHelp,
  formatTuiDetailNone,
  formatTuiDetailSectionTitle,
  formatTuiListHelp,
  formatTuiListRowIteration,
  formatTuiListTitle,
  formatTuiSortLabel,
} from "../../src/cli/tui/chrome.js";

const ZH_I18N = createI18n("zh", BUILTIN_BUNDLES);

describe("TUI chrome localization", () => {
  test("keeps en chrome stable", () => {
    expect(formatTuiListTitle(DEFAULT_I18N, 2, 5)).toBe("loaf sessions (2 active / 5 total)");
    expect(formatTuiSortLabel(DEFAULT_I18N, "time")).toBe("sort: time");
    expect(formatTuiListRowIteration(DEFAULT_I18N, "3")).toBe("iter 3");
    expect(formatTuiListHelp(DEFAULT_I18N)).toBe(
      "[↑/↓] move · [space] fold · [a] active/all · [s] sort · [r] refresh · [q] quit",
    );
    expect(formatTuiDetailField(DEFAULT_I18N, "feature", "auth-refresh")).toBe("feature: auth-refresh");
    expect(formatTuiDetailSectionTitle(DEFAULT_I18N, "tasks", 3)).toBe("tasks (3)");
    expect(formatTuiDetailEvidenceBadge(DEFAULT_I18N, "pass")).toBe("pass");
  });

  test("localizes zh chrome while preserving key glyphs", () => {
    expect(formatTuiListTitle(ZH_I18N, 2, 5)).toBe("loaf sessions (2 活跃 / 5 总计)");
    expect(formatTuiSortLabel(ZH_I18N, "status")).toBe("排序: 状态");
    expect(formatTuiListRowIteration(ZH_I18N, "3")).toBe("迭代 3");
    expect(formatTuiListHelp(ZH_I18N)).toBe(
      "[↑/↓] 移动 · [space] 折叠 · [a] 活跃/全部 · [s] 排序 · [r] 刷新 · [q] 退出",
    );
    expect(formatTuiDetailHelp(ZH_I18N)).toBe("[Esc] 返回 · [q] 退出");
    expect(formatTuiDetailNone(ZH_I18N)).toBe("(无)");
    expect(formatTuiDetailField(ZH_I18N, "feature", "auth-refresh")).toBe("功能: auth-refresh");
    expect(formatTuiDetailField(ZH_I18N, "spec_locked", formatTuiBoolean(ZH_I18N, true))).toBe("规格已锁定: 是");
    expect(formatTuiDetailSectionTitle(ZH_I18N, "open_findings", 1)).toBe("未关闭发现 (1)");
    expect(formatTuiDetailEvidenceBadge(ZH_I18N, "waived")).toBe("已豁免");
  });
});
