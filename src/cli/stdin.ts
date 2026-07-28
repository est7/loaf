// Process-level stdin adapters. main() is their single owner and injects them
// into input ingestion, hook parsing, and the few genuinely interactive
// command lanes.

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
