import { build } from "esbuild";

const shared = {
  bundle: true,
  platform: "node",
  target: "node18",
  format: "esm",
  external: ["ws", "pino", "pino-pretty", "commander"],
  sourcemap: true,
};

await Promise.all([
  build({
    ...shared,
    entryPoints: ["src/cli.ts"],
    outfile: "dist/cli.js",
    banner: { js: "#!/usr/bin/env node" },
  }),
  build({
    ...shared,
    entryPoints: ["src/agent.ts"],
    outfile: "dist/agent.js",
  }),
  build({
    ...shared,
    entryPoints: ["src/index.ts"],
    outfile: "dist/index.js",
  }),
]);

console.log("Build complete: dist/cli.js, dist/agent.js, dist/index.js");
