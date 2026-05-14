import { EXIT_CODE, resolveExitCode } from "../core/errors.js";

interface ErrorPayload {
  error: string;
  exitCode: number;
}

export function writeJson(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

export function writeError(error: unknown, json: boolean): number {
  const exitCode = resolveExitCode(error);
  const message =
    error instanceof Error ? error.message : "Unexpected non-error value thrown.";

  if (json) {
    const payload: ErrorPayload = { error: message, exitCode };
    process.stderr.write(`${JSON.stringify(payload, null, 2)}\n`);
    return exitCode;
  }

  process.stderr.write(`Error: ${message}\n`);
  return exitCode;
}

export { EXIT_CODE };
