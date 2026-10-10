import type { CatalogDiagnostic } from "../core/error-catalog.js";
import { RuntimeStoreError } from "../core/session-runtime.js";

/** Preserve the established CLI mapping for runtime status errors. */
export function runtimeStoreDiagnostic(
  error: RuntimeStoreError,
  source: string,
): CatalogDiagnostic {
  const detail = {
    source,
    runtime_code: error.code,
    reason: error.message,
    ...(error.holder !== undefined && { holder: error.holder }),
  };
  if (error.code === "RUNTIME_LOCK_TIMEOUT" || error.code === "RUNTIME_LOCK_INVALID") {
    // The RuntimeStoreError constructor requires lock metadata for these codes.
    return {
      code: "LOCK_TIMEOUT",
      detail: {
        ...detail,
        ...error.lockDetail!,
        timeout_seconds: error.lockDetail!.timeout_seconds,
      },
    };
  }
  return { code: "SCHEMA_VALIDATION_FAILED", detail };
}
