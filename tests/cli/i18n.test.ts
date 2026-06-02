// ADR-0006 P0 — runtime i18n pure helpers.

import { describe, expect, test } from "vitest";

import {
  createI18n,
  resolveLocale,
  type LocaleBundle,
} from "../../src/cli/i18n.js";

const bundles = {
  en: {
    greeting: "hello {name}",
    fallback_only: "english {value}",
    nested: { label: "Label {value}" },
  },
  zh: {
    greeting: "你好 {name}",
  },
} satisfies { en: LocaleBundle; zh: LocaleBundle };

describe("ADR-0006 P0 — resolveLocale", () => {
  test("precedence: --lang future flag > LOAF_LANG > user config > project config > ambient > en", () => {
    expect(resolveLocale({
      argv: ["loaf", "status", "--lang", "zh"],
      env: { LOAF_LANG: "en", LANG: "en_US.UTF-8" },
      userConfig: { status: "ok", locale: "en" },
      projectConfig: { locale: "en" },
    })).toEqual({ ok: true, locale: "zh", source: "argv" });

    expect(resolveLocale({
      argv: ["loaf", "status"],
      env: { LOAF_LANG: "zh", LANG: "en_US.UTF-8" },
      userConfig: { status: "ok", locale: "en" },
      projectConfig: { locale: "en" },
    })).toEqual({ ok: true, locale: "zh", source: "env" });

    expect(resolveLocale({
      argv: ["loaf", "status"],
      env: { LANG: "en_US.UTF-8" },
      userConfig: { status: "ok", locale: "zh" },
      projectConfig: { locale: "en" },
    })).toEqual({ ok: true, locale: "zh", source: "user-config" });

    expect(resolveLocale({
      argv: ["loaf", "status"],
      env: { LANG: "zh_CN.UTF-8" },
      projectConfig: { locale: "en" },
    })).toEqual({ ok: true, locale: "en", source: "project-config" });

    expect(resolveLocale({
      argv: ["loaf", "status"],
      env: { LANG: "zh_CN.UTF-8" },
    })).toEqual({ ok: true, locale: "zh", source: "ambient" });

    expect(resolveLocale({
      argv: ["loaf", "status"],
      env: {},
    })).toEqual({ ok: true, locale: "en", source: "default" });
  });

  test("ambient locale parsing maps zh/en and treats C/POSIX/unsupported as en", () => {
    expect(resolveLocale({ argv: [], env: { LANG: "zh_CN.UTF-8" } })).toEqual({
      ok: true,
      locale: "zh",
      source: "ambient",
    });
    expect(resolveLocale({ argv: [], env: { LC_ALL: "en_US.UTF-8", LANG: "zh_CN.UTF-8" } })).toEqual({
      ok: true,
      locale: "en",
      source: "ambient",
    });
    expect(resolveLocale({ argv: [], env: { LC_MESSAGES: "zh_TW.UTF-8" } })).toEqual({
      ok: true,
      locale: "zh",
      source: "ambient",
    });
    expect(resolveLocale({ argv: [], env: { LANG: "C" } })).toEqual({
      ok: true,
      locale: "en",
      source: "default",
    });
    expect(resolveLocale({ argv: [], env: { LANG: "POSIX" } })).toEqual({
      ok: true,
      locale: "en",
      source: "default",
    });
    expect(resolveLocale({ argv: [], env: { LANG: "fr_FR.UTF-8" } })).toEqual({
      ok: true,
      locale: "en",
      source: "default",
    });
  });

  test("explicit invalid LOAF_LANG returns INVALID_LOCALE", () => {
    expect(resolveLocale({
      argv: [],
      env: { LOAF_LANG: "fr" },
    })).toEqual({
      ok: false,
      code: "INVALID_LOCALE",
      message: "invalid locale from LOAF_LANG: fr (expected en or zh)",
      detail: { source: "LOAF_LANG", value: "fr", accepted: ["en", "zh"] },
    });
  });

  test("invalid user config returns INVALID_LOCALE", () => {
    expect(resolveLocale({
      argv: [],
      env: {},
      userConfig: {
        status: "invalid",
        path: "/tmp/home/.loaf/config.json",
        reason: "schema validation failed for /tmp/home/.loaf/config.json",
      },
    })).toEqual({
      ok: false,
      code: "INVALID_LOCALE",
      message: "invalid locale config at /tmp/home/.loaf/config.json: schema validation failed for /tmp/home/.loaf/config.json",
      detail: {
        source: "user-config",
        path: "/tmp/home/.loaf/config.json",
        reason: "schema validation failed for /tmp/home/.loaf/config.json",
      },
    });
  });

  test("projectConfig participates only as an explicit repo-default input", () => {
    expect(resolveLocale({
      argv: [],
      env: { LANG: "zh_CN.UTF-8" },
      projectConfig: { locale: "en" },
    })).toEqual({ ok: true, locale: "en", source: "project-config" });
  });
});

describe("ADR-0006 P0 — createI18n", () => {
  test("t resolves selected locale, then en, then raw key", () => {
    const i18n = createI18n("zh", bundles);

    expect(i18n.t("greeting", { name: "Ada" })).toBe("你好 Ada");
    expect(i18n.t("fallback_only", { value: 42 })).toBe("english 42");
    expect(i18n.t("missing.key")).toBe("missing.key");
  });

  test("dot paths and interpolation work without string concatenation", () => {
    const i18n = createI18n("en", bundles);

    expect(i18n.t("nested.label", { value: "X" })).toBe("Label X");
  });

  test("missing interpolation vars remain literal and do not throw", () => {
    const i18n = createI18n("en", bundles);

    expect(i18n.t("greeting")).toBe("hello {name}");
  });
});
