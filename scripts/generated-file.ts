import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

export async function writeOrCheckGeneratedFile(
  outputUrl: URL,
  generate: (source: string) => string,
  check: boolean,
): Promise<boolean> {
  const source = await readFile(outputUrl, "utf8");
  const expected = generate(source);
  if (expected === source) return false;

  if (check) {
    console.error(`generated artifact drift: ${fileURLToPath(outputUrl)}`);
    return true;
  }

  await writeFile(outputUrl, expected, "utf8");
  return true;
}

export function parseCheckMode(args: readonly string[]): boolean {
  const unexpected = args.filter((arg) => arg !== "--check");
  if (unexpected.length > 0) {
    throw new Error(`unexpected generator arguments: ${unexpected.join(" ")}`);
  }
  return args.includes("--check");
}
