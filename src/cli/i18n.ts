// ADR-0006 P0 — CLI presentation i18n helpers.
//
// Locale resolution and bundle lookup belong to the CLI presentation layer.
// Stable core modules must not import this file.

import enBundle from "../../i18n/en.json" with { type: "json" };
import zhBundle from "../../i18n/zh.json" with { type: "json" };

export const LOCALES = ["en", "zh"] as const;
export type Locale = (typeof LOCALES)[number];

export type LocaleBundle = {
  readonly [key: string]: unknown;
};

export type I18n = {
  readonly locale: Locale;
  t: (
    keyPath: string,
    vars?: Record<string, string | number | boolean | null | undefined>,
  ) => string;
};

export type LocaleResolution =
  | { ok: true; locale: Locale; source: "argv" | "env" | "user-config" | "project-config" | "ambient" | "default" }
  | {
      ok: false;
      code: "INVALID_LOCALE";
      message: string;
      detail: Record<string, unknown>;
    };

export type LocaleConfigInput =
  | { status: "ok"; locale: unknown }
  | { status: "absent" }
  | { status: "invalid"; path: string; reason: string };

export type ProjectLocaleInput = {
  locale?: Locale | undefined;
};

export type ResolveLocaleInput = {
  argv: readonly string[];
  env: Record<string, string | undefined>;
  userConfig?: LocaleConfigInput | undefined;
  projectConfig?: ProjectLocaleInput | undefined;
};

export const BUILTIN_BUNDLES = {
  en: enBundle as LocaleBundle,
  zh: zhBundle as LocaleBundle,
} satisfies Record<Locale, LocaleBundle>;

export const DEFAULT_I18N: I18n = createI18n("en", BUILTIN_BUNDLES);

function isLocale(value: unknown): value is Locale {
  return typeof value === "string" && (LOCALES as readonly string[]).includes(value);
}

function invalidLocale(source: string, value: unknown): LocaleResolution {
  return {
    ok: false,
    code: "INVALID_LOCALE",
    message: `invalid locale from ${source}: ${String(value)} (expected en or zh)`,
    detail: { source, value, accepted: [...LOCALES] },
  };
}

function parseLangArg(argv: readonly string[]): string | undefined {
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === "--lang") return argv[i + 1];
    if (arg.startsWith("--lang=")) return arg.slice("--lang=".length);
  }
  return undefined;
}

function parseAmbientLocale(env: Record<string, string | undefined>): Locale | null {
  const raw = env.LC_ALL ?? env.LC_MESSAGES ?? env.LANG;
  if (!raw || raw === "C" || raw === "POSIX") return null;
  const normalized = raw.toLowerCase();
  if (normalized.startsWith("zh")) return "zh";
  if (normalized.startsWith("en")) return "en";
  return null;
}

export function resolveLocale(input: ResolveLocaleInput): LocaleResolution {
  const argvLocale = parseLangArg(input.argv);
  if (argvLocale !== undefined) {
    if (!isLocale(argvLocale)) return invalidLocale("--lang", argvLocale);
    return { ok: true, locale: argvLocale, source: "argv" };
  }

  const envLocale = input.env.LOAF_LANG;
  if (envLocale !== undefined) {
    if (!isLocale(envLocale)) return invalidLocale("LOAF_LANG", envLocale);
    return { ok: true, locale: envLocale, source: "env" };
  }

  if (input.userConfig?.status === "invalid") {
    return {
      ok: false,
      code: "INVALID_LOCALE",
      message: `invalid locale config at ${input.userConfig.path}: ${input.userConfig.reason}`,
      detail: {
        source: "user-config",
        path: input.userConfig.path,
        reason: input.userConfig.reason,
      },
    };
  }
  if (input.userConfig?.status === "ok") {
    if (!isLocale(input.userConfig.locale)) {
      return invalidLocale("user-config", input.userConfig.locale);
    }
    return { ok: true, locale: input.userConfig.locale, source: "user-config" };
  }

  if (input.projectConfig?.locale !== undefined) {
    return { ok: true, locale: input.projectConfig.locale, source: "project-config" };
  }

  const ambient = parseAmbientLocale(input.env);
  if (ambient !== null) return { ok: true, locale: ambient, source: "ambient" };

  return { ok: true, locale: "en", source: "default" };
}

function lookup(bundle: LocaleBundle, keyPath: string): string | undefined {
  let cur: unknown = bundle;
  for (const part of keyPath.split(".")) {
    if (typeof cur === "string") return undefined;
    if (typeof cur !== "object" || cur === null) return undefined;
    cur = (cur as Record<string, unknown>)[part];
    if (cur === undefined) return undefined;
  }
  return typeof cur === "string" ? cur : undefined;
}

function interpolate(
  template: string,
  vars: Record<string, string | number | boolean | null | undefined> | undefined,
): string {
  return template.replace(/\{([A-Za-z0-9_]+)\}/g, (match, key: string) => {
    const value = vars?.[key];
    return value === undefined ? match : String(value);
  });
}

export function createI18n(
  locale: Locale,
  bundles: Record<Locale, LocaleBundle>,
): I18n {
  return {
    locale,
    t(keyPath, vars) {
      const template =
        lookup(bundles[locale], keyPath) ??
        lookup(bundles.en, keyPath) ??
        keyPath;
      return interpolate(template, vars);
    },
  };
}
