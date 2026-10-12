// ADR-0006 P0 — runtime i18n pure helpers.

import { describe, expect, test } from "vitest";

import { createI18n, resolveLocale, type LocaleBundle } from "../../src/cli/i18n.js";

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
  test("precedence: LOAF_LANG > user config > ambient > en", () => {
    expect(
      resolveLocale({
        env: { LOAF_LANG: "zh", LANG: "en_US.UTF-8" },
        userConfig: { status: "ok", locale: "en" },
      }),
    ).toEqual({ ok: true, locale: "zh", source: "env" });

    expect(
      resolveLocale({
        env: { LANG: "en_US.UTF-8" },
        userConfig: { status: "ok", locale: "zh" },
      }),
    ).toEqual({ ok: true, locale: "zh", source: "user-config" });

    expect(
      resolveLocale({
        env: { LANG: "zh_CN.UTF-8" },
      }),
    ).toEqual({ ok: true, locale: "zh", source: "ambient" });

    expect(
      resolveLocale({
        env: {},
      }),
    ).toEqual({ ok: true, locale: "en", source: "default" });
  });

  test("ambient locale parsing maps zh/en and treats C/POSIX/unsupported as en", () => {
    expect(resolveLocale({ env: { LANG: "zh_CN.UTF-8" } })).toEqual({
      ok: true,
      locale: "zh",
      source: "ambient",
    });
    expect(resolveLocale({ env: { LC_ALL: "en_US.UTF-8", LANG: "zh_CN.UTF-8" } })).toEqual({
      ok: true,
      locale: "en",
      source: "ambient",
    });
    expect(resolveLocale({ env: { LC_MESSAGES: "zh_TW.UTF-8" } })).toEqual({
      ok: true,
      locale: "zh",
      source: "ambient",
    });
    expect(resolveLocale({ env: { LANG: "C" } })).toEqual({
      ok: true,
      locale: "en",
      source: "default",
    });
    expect(resolveLocale({ env: { LANG: "POSIX" } })).toEqual({
      ok: true,
      locale: "en",
      source: "default",
    });
    expect(resolveLocale({ env: { LANG: "fr_FR.UTF-8" } })).toEqual({
      ok: true,
      locale: "en",
      source: "default",
    });
  });

  test("explicit invalid LOAF_LANG returns INVALID_LOCALE", () => {
    expect(
      resolveLocale({
        env: { LOAF_LANG: "fr" },
      }),
    ).toEqual({
      ok: false,
      code: "INVALID_LOCALE",
      detail: { source: "LOAF_LANG", value: "fr", accepted: ["en", "zh"] },
    });
  });

  test("invalid user config returns INVALID_LOCALE", () => {
    expect(
      resolveLocale({
        env: {},
        userConfig: {
          status: "invalid",
          path: "/tmp/home/.loaf/config.json",
          reason: "schema validation failed for /tmp/home/.loaf/config.json",
        },
      }),
    ).toEqual({
      ok: false,
      code: "INVALID_LOCALE",
      detail: {
        source: "user-config",
        accepted: ["en", "zh"],
        path: "/tmp/home/.loaf/config.json",
        reason: "schema validation failed for /tmp/home/.loaf/config.json",
      },
    });
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
