// Install the actual packed artifact using the checkout's resolved graph/cache.
// Never resolve fresh registry metadata or substitute the checkout node_modules.
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import path from "node:path";

const [packageRoot, tarball, installDir] = process.argv.slice(2);
const stepTimeoutMs = 30_000;
function step(name, command, args) {
  const result = spawnSync(command, args, {
    cwd: installDir, encoding: "utf8", timeout: stepTimeoutMs,
    // Closed local endpoint: cache misses fail instead of retrying a remote registry.
    env: { ...process.env, BUN_CONFIG_DEFAULT_REGISTRY: "http://127.0.0.1:1" },
  });
  if (result.error || result.status !== 0)
    throw new Error(`${name} failed${result.error?.code === "ETIMEDOUT" ? ` (timeout ${stepTimeoutMs}ms)` : ""}: ${result.error?.message ?? ""}\n${result.stdout ?? ""}${result.stderr ?? ""}`);
  return result.stdout;
}
const pkg = JSON.parse(step("packed manifest", "tar", ["-xOf", tarball, "package/package.json"]));
const lockPath = path.join(packageRoot, "bun.lock");
const dependencies = pkg.dependencies ?? {};
if (!existsSync(lockPath) && Object.keys(dependencies).length > 0)
  throw new Error("dependency lock missing; run bun install in the package checkout before smoke");
const lock = existsSync(lockPath)
  ? Bun.JSONC.parse(readFileSync(lockPath, "utf8"))
  : { lockfileVersion: 1, configVersion: 1, packages: {} };
const overrides = JSON.parse(readFileSync(path.join(packageRoot, "package.json"), "utf8")).overrides;
const manifest = { private: true, dependencies: { [pkg.name]: tarball }, ...(overrides && { overrides }) };
lock.workspaces = { "": { dependencies: manifest.dependencies } };
const metadata = {};
for (const key of ["dependencies", "optionalDependencies", "peerDependencies", "bin"])
  if (pkg[key] !== undefined) metadata[key] = pkg[key];
lock.packages[pkg.name] = [
  `${pkg.name}@${tarball}`, metadata,
  `sha512-${createHash("sha512").update(readFileSync(tarball)).digest("base64")}`,
];
writeFileSync(path.join(installDir, "package.json"), JSON.stringify(manifest));
writeFileSync(path.join(installDir, "bun.lock"), JSON.stringify(lock));
// Let Bun prune/reindex the existing graph for the local tarball. No packages
// are installed in this step; the closed registry makes missing resolution fail.
step("lock preparation (local resolved graph required)", "bun", [
  "install", "--lockfile-only", "--ignore-scripts", "--registry=http://127.0.0.1:1",
]);
step("frozen install (local package cache required)", "bun", [
  "install", "--frozen-lockfile", "--ignore-scripts", "--registry=http://127.0.0.1:1",
]);
