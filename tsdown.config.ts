import { defineConfig } from "tsdown/config";

export default defineConfig({
  entry: {
    cli: "./src/cli.tsx",
  },
  format: ["esm"],
  platform: "node",
  target: "node22",
  clean: true,
  sourcemap: true,
});
