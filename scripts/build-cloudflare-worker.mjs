import { mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const outfile = resolve(root, "dist/cloudflare-worker/worker.js");

await mkdir(dirname(outfile), { recursive: true });

await build({
  entryPoints: [resolve(root, "src/adapters/cloudflare-worker/worker.ts")],
  outfile,
  bundle: true,
  format: "esm",
  // Target the Cloudflare Workers runtime (workerd), not Node. This makes esbuild pick
  // the worker/browser export conditions of dependencies (viem, ox, mppx) instead of their
  // Node builds, so we don't accidentally bundle Node-only code paths.
  platform: "browser",
  conditions: ["workerd", "worker", "browser", "import", "module", "default"],
  mainFields: ["module", "browser", "main"],
  // Any residual `node:*` import is left for the runtime to resolve via the
  // `nodejs_compat` compatibility flag (set on the Worker version in Terraform).
  external: ["node:*", "cloudflare:*"],
  target: "es2022",
  sourcemap: true,
  legalComments: "eof",
  logLevel: "info"
});

console.log(`Cloudflare Worker bundle written to ${outfile}`);
