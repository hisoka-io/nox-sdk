// Builds the KPS-only repro page, serves it on localhost and runs it in one
// browser against one KPS address. Prints the page's JSON result; exits 1 when
// a step failed.
//
//   node tools/kps-repro/run.mjs <chromium|webkit> <ip>:<port>:<certhash>
//
// The address is a node's KPS entry, e.g. an anchor from the worker's
// snapshot/nox-bootstrap.json. To try a phone, serve the built folder
// (.run/kps-repro) over HTTPS and open repro.html?addr=<address>.

import { createServer } from "node:http";
import { mkdirSync, readFileSync, copyFileSync } from "node:fs";
import { dirname, extname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { chromium, webkit } from "@playwright/test";

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT = join(HERE, "..", "..", ".run", "kps-repro");
const RUN_TIMEOUT_MS = 60_000;
const TYPES = { ".html": "text/html; charset=utf-8", ".js": "text/javascript" };

const [browserName, address] = process.argv.slice(2);
const engines = { chromium, webkit };
if (!(browserName in engines) || typeof address !== "string" || address.length === 0) {
  console.error("usage: node tools/kps-repro/run.mjs <chromium|webkit> <ip>:<port>:<certhash>");
  process.exit(2);
}

mkdirSync(OUT, { recursive: true });
await build({
  entryPoints: [join(HERE, "repro.ts")],
  bundle: true,
  format: "esm",
  target: "es2022",
  outfile: join(OUT, "repro.js"),
  logLevel: "warning",
});
copyFileSync(join(HERE, "repro.html"), join(OUT, "repro.html"));

const server = createServer((req, res) => {
  const path = new URL(req.url ?? "/", "http://localhost").pathname;
  const file = path === "/repro.js" ? "repro.js" : "repro.html";
  res.writeHead(200, { "content-type": TYPES[extname(file)] });
  res.end(readFileSync(join(OUT, file)));
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const { port } = server.address();

const browser = await engines[browserName].launch({ headless: true });
let result;
try {
  const page = await browser.newPage();
  await page.goto(`http://127.0.0.1:${port}/repro.html?addr=${encodeURIComponent(address)}`);
  await page.waitForFunction(() => window.kpsRepro?.done === true, undefined, { timeout: RUN_TIMEOUT_MS });
  result = await page.evaluate(() => window.kpsRepro);
} finally {
  await browser.close();
  server.close();
}
console.log(JSON.stringify(result, null, 2));
process.exit(result.ok ? 0 : 1);
