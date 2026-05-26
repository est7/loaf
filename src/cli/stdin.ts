// Phase 16 SC-4a — stdin reader (production wire).
//
// Standalone module per codex r212 (kept out of input-read.ts so the
// IO/parse module stays pure + DI-friendly). The TTY-no-hang guard is
// enforced one level up at the action-handler call site: action checks
// `isStdinTty()` BEFORE invoking readJsonInput on a stdin source,
// emits a USAGE failure on TTY (protocol §10.1:1505 "stdin is TTY +
// command expects piped input → print help + exit 2, do not hang").

export async function defaultReadStdin(): Promise<string> {
  let buf = "";
  for await (const chunk of process.stdin) {
    buf += typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8");
  }
  return buf;
}

export function defaultIsStdinTty(): boolean {
  return process.stdin.isTTY === true;
}
