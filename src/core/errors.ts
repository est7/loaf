export const EXIT_CODE = {
  success: 0,
  usage: 1,
  system: 2,
} as const;

export class CliUsageError extends Error {
  readonly exitCode = EXIT_CODE.usage;

  constructor(message: string) {
    super(message);
    this.name = "CliUsageError";
  }
}

export function resolveExitCode(error: unknown): number {
  if (error instanceof CliUsageError) {
    return error.exitCode;
  }

  return EXIT_CODE.system;
}
