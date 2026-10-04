#!/usr/bin/env node
// @ts-check
/**
 * Reproducible build of the Nox anon-rpc worker bundle.
 *
 * Output (in dist/):
 *   anon-rpc-worker.js            one classic-script IIFE holding every module
 *                                 and the nox-wasm module. anon-rpc harnesses
 *                                 load it with importScripts(), so it has no
 *                                 imports, no exports and no import.meta.
 *   anon-rpc-worker.js.keccak256  keccak-256 of those exact bytes: the
 *                                 workerHash() a specifier pins (SPEC §4).
 *   build-record.json             what went in, for scripts/provenance.mjs.
 *
 * Determinism. The bytes depend only on: the source tree, the pnpm lockfile
 * (esbuild version and the node_modules layout that appears in module path
 * comments), the nox-wasm bytes, the fixed esbuild flags in BUNDLE_OPTIONS and
 * this package's tsconfig.json (passed explicitly; its `strict` setting makes
 * esbuild emit "use strict"). Paths are relative to the package directory, no
 * timestamp, commit or environment value is embedded, and nothing is minified,
 * so the bundle stays auditable. The same inputs give the same bytes on any
 * host and in any checkout location.
 *
 * Contract with the worker source (src/):
 *   - the entry point is src/index.ts (override with --entry);
 *   - "@hisoka-io/nox-wasm" and "@hisoka-io/nox-wasm/web" resolve to
 *     scripts/embed/nox-wasm-shim.js: the wasm-bindgen web glue with an init
 *     that reads the embedded bytes instead of fetching a .wasm file. The
 *     glue's own fetch-based default init is rewritten to throw, so the bundle
 *     holds no import.meta and no code path that loads a .wasm by URL;
 *   - "@hisoka-io/nox-client" resolves to the SDK's TypeScript sources in this
 *     repository (packages/nox-client/src), so the bundle is built from
 *     reviewed sources and not from a separately built dist/;
 *   - "nox-embed:wasm-bytes" exports noxWasmBytes(), the raw module bytes;
 *   - JSON imports are inlined (the pinned snapshot is
 *     snapshot/nox-snapshot.json); nothing is external, so an import that
 *     cannot be bundled (a Node built-in, a missing file) fails the build.
 *
 * Usage:
 *   node scripts/build.mjs [--entry <file>] [--outfile <file>]
 *                          [--wasm <nox_wasm_bg.wasm>] [--wasm-glue <nox_wasm.js>]
 */
import { build as esbuild, version as esbuildVersion } from "esbuild";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { parseArgs } from "node:util";
import { errorMessage, isMain, runMain } from "./lib/cli.mjs";
import { EMBED_DIR, PACKAGE_DIR, REPO_DIR } from "./lib/paths.mjs";
import { formatHashLine, KECCAK_FILE_SUFFIX, keccak256Hex, sha256Hex } from "./hash.mjs";

export { PACKAGE_DIR };
export const DEFAULT_ENTRY = "src/index.ts";
export const DEFAULT_OUTFILE = "dist/anon-rpc-worker.js";
export const BUILD_RECORD_NAME = "build-record.json";
export const BUILD_RECORD_SCHEMA = "nox-anon-rpc-worker-build/1";

/**
 * The fixed esbuild flags. They are part of the artifact identity: changing any
 * of them changes the worker hash.
 */
export const BUNDLE_OPTIONS = Object.freeze({
  bundle: true,
  format: /** @type {const} */ ("iife"),
  platform: /** @type {const} */ ("browser"),
  target: "es2022",
  charset: /** @type {const} */ ("ascii"),
  legalComments: /** @type {const} */ ("eof"),
  minify: false,
  sourcemap: false,
  treeShaking: true,
  splitting: false,
  define: Object.freeze({ "process.env.NODE_ENV": '"production"' }),
});

const WASM_MAGIC = Uint8Array.of(0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00);

/** The SDK entry the worker bundles from source. */
export const NOX_CLIENT_SOURCE = join(REPO_DIR, "packages", "nox-client", "src", "index.ts");

/**
 * The one expression in the wasm-bindgen web glue that locates the module
 * next to the script. It is the glue's only use of import.meta.
 */
export const GLUE_URL_EXPRESSION = "new URL('nox_wasm_bg.wasm', import.meta.url)";

/** What the build puts in its place: the embedded module is the only source. */
export const GLUE_URL_REPLACEMENT =
  '(() => { throw new Error("nox-wasm: this worker bundle embeds its WebAssembly module and never loads one by URL"); })()';

/** Typed build failure; `code` is stable, the message says what to do. */
export class BuildError extends Error {
  /**
   * @param {string} message
   * @param {"missing-input" | "invalid-wasm" | "bundle-failed" | "bundle-check-failed" | "usage"} code
   */
  constructor(message, code) {
    super(message);
    this.name = "BuildError";
    this.code = code;
  }
}

/**
 * @typedef {object} WasmInput
 * @property {string} wasmPath  absolute path of nox_wasm_bg.wasm
 * @property {string} gluePath  absolute path of the wasm-bindgen web glue (nox_wasm.js)
 */

/**
 * Locate the nox-wasm web build through Node's node_modules lookup from the
 * package directory (the workspace link of "@hisoka-io/nox-wasm").
 * @param {string} packageDir
 * @returns {WasmInput}
 */
export function resolveNoxWasm(packageDir) {
  let dir = packageDir;
  for (;;) {
    const manifest = join(dir, "node_modules", "@hisoka-io", "nox-wasm", "package.json");
    if (existsSync(manifest)) {
      const root = realpathSync(dirname(manifest));
      return {
        wasmPath: join(root, "pkg-web", "nox_wasm_bg.wasm"),
        gluePath: join(root, "pkg-web", "nox_wasm.js"),
      };
    }
    const parent = dirname(dir);
    if (parent === dir) {
      throw new BuildError(
        `@hisoka-io/nox-wasm is not installed for ${packageDir}; run \`pnpm install\` at the repository root`,
        "missing-input",
      );
    }
    dir = parent;
  }
}

/**
 * @typedef {object} BuildOptions
 * @property {string} [packageDir] package root; esbuild paths are relative to it
 * @property {string} [entry]      entry point, relative to packageDir
 * @property {string} [outfile]    output file, relative to packageDir
 * @property {string} [tsconfig]   tsconfig passed to esbuild, relative to packageDir
 * @property {string} [wasm]       nox_wasm_bg.wasm to embed (default: the nox-wasm web build)
 * @property {string} [wasmGlue]   wasm-bindgen web glue matching `wasm`
 * @property {boolean} [write]     write the outputs (default true)
 */

/**
 * @typedef {object} ModuleInput
 * @property {string} path            relative to the package directory, "/" separators
 * @property {number} bytes
 * @property {string | null} sha256   null for build-generated virtual modules
 */

/**
 * @typedef {object} BuildRecord
 * @property {string} schema
 * @property {{ path: string, bytes: number, keccak256: string, sha256: string }} artifact
 * @property {string} entry
 * @property {{ path: string, sha256: string }} tsconfig
 * @property {{ version: string, options: Record<string, unknown> }} esbuild
 * @property {{ path: string, bytes: number, sha256: string, keccak256: string }} wasm
 * @property {ModuleInput[]} modules
 */

/**
 * @typedef {object} BuildResult
 * @property {Uint8Array} bundle      the artifact bytes
 * @property {string} outfile         absolute output path
 * @property {BuildRecord} record
 */

/**
 * Bundle the worker. Pure function of its inputs; see the file header.
 * @param {BuildOptions} [options]
 * @returns {Promise<BuildResult>}
 */
export async function buildWorker(options = {}) {
  const packageDir = resolve(options.packageDir ?? PACKAGE_DIR);
  const entry = options.entry ?? DEFAULT_ENTRY;
  const outfile = resolve(packageDir, options.outfile ?? DEFAULT_OUTFILE);
  const tsconfigPath = resolve(packageDir, options.tsconfig ?? "tsconfig.json");
  const write = options.write ?? true;

  requireFile(
    resolve(packageDir, entry),
    `worker entry point ${entry} not found in ${packageDir}`,
  );
  requireFile(
    tsconfigPath,
    `${tsconfigPath} not found: the tsconfig is part of the bundle identity (its "strict" setting decides whether esbuild emits "use strict"), so the build refuses to guess`,
  );

  const located = options.wasm === undefined ? resolveNoxWasm(packageDir) : undefined;
  const wasmPath = options.wasm === undefined
    ? /** @type {WasmInput} */ (located).wasmPath
    : resolve(options.wasm);
  const gluePath = options.wasmGlue === undefined
    ? (located ?? resolveNoxWasm(packageDir)).gluePath
    : resolve(options.wasmGlue);
  const buildHint = "run `pnpm --filter @hisoka-io/nox-wasm build:web`, or scripts/verify-reproducible.sh for the pinned toolchain";
  requireFile(wasmPath, `nox-wasm module not found at ${wasmPath}; ${buildHint}`);
  requireFile(gluePath, `nox-wasm web glue not found at ${gluePath}; ${buildHint}`);
  const wasmBytes = readFileSync(wasmPath);
  if (wasmBytes.length < WASM_MAGIC.length || !WASM_MAGIC.every((byte, i) => wasmBytes[i] === byte)) {
    throw new BuildError(
      `${wasmPath} is not a WebAssembly 1.0 binary (bad magic/version header)`,
      "invalid-wasm",
    );
  }
  const wasmBase64 = wasmBytes.toString("base64");

  const manifest = readPackageManifest(packageDir);
  const banner = `/* ${manifest.name} ${manifest.version} | ${manifest.license} | https://github.com/hisoka-io/nox-sdk */`;

  /** @type {import("esbuild").BuildResult<{ metafile: true, write: false }>} */
  let result;
  try {
    result = await esbuild({
      ...BUNDLE_OPTIONS,
      define: { ...BUNDLE_OPTIONS.define },
      absWorkingDir: packageDir,
      entryPoints: [entry],
      outfile,
      tsconfig: tsconfigPath,
      banner: { js: banner },
      metafile: true,
      write: false,
      logLevel: "silent",
      logOverride: { "empty-import-meta": "error" },
      plugins: [noxEmbedPlugin({ wasmBase64, gluePath })],
    });
  } catch (error) {
    throw new BuildError(`esbuild failed for ${entry}: ${errorMessage(error)}`, "bundle-failed");
  }
  for (const warning of result.warnings) {
    const where = warning.location === null ? "" : ` (${warning.location.file}:${warning.location.line})`;
    process.stderr.write(`build.mjs: esbuild warning [${warning.id}]${where}: ${warning.text}\n`);
  }

  if (result.outputFiles.length !== 1) {
    throw new BuildError(
      `expected exactly one output file, esbuild produced ${result.outputFiles.length}`,
      "bundle-check-failed",
    );
  }
  const output = /** @type {import("esbuild").OutputFile} */ (result.outputFiles[0]);
  const bundle = output.contents;
  checkBundle(output.text, wasmBase64);

  const record = makeRecord({
    packageDir,
    entry,
    outfile,
    tsconfigPath,
    banner,
    wasmPath,
    wasmBytes,
    bundle,
    metafile: result.metafile,
  });

  if (write) writeOutputs(packageDir, outfile, bundle, record);
  return { bundle, outfile, record };
}

/**
 * esbuild plugin that provides the embedded-WASM modules.
 * @param {{ wasmBase64: string, gluePath: string }} inputs
 * @returns {import("esbuild").Plugin}
 */
function noxEmbedPlugin({ wasmBase64, gluePath }) {
  // esbuild evaluates these filters as Go regular expressions: no JS flags.
  return {
    name: "nox-embed",
    setup(build) {
      build.onResolve({ filter: /^@hisoka-io\/nox-wasm(?:\/web)?$/ }, () => ({
        path: join(EMBED_DIR, "nox-wasm-shim.js"),
      }));
      build.onResolve({ filter: /^nox-embed:wasm-bytes$/ }, () => ({
        path: join(EMBED_DIR, "wasm-bytes.js"),
      }));
      build.onResolve({ filter: /^@hisoka-io\/nox-client$/ }, () => ({ path: NOX_CLIENT_SOURCE }));
      build.onResolve({ filter: /^nox-embed:wasm-glue$/ }, () => ({ path: gluePath }));
      build.onLoad({ filter: /nox_wasm\.js$/ }, (args) => {
        if (args.path !== gluePath) return undefined;
        return { contents: rewriteGlue(readFileSync(gluePath, "utf8"), gluePath), loader: "js", resolveDir: dirname(gluePath) };
      });
      build.onResolve({ filter: /^nox-embed:wasm-base64$/ }, () => ({
        path: "wasm-base64",
        namespace: "nox-embed",
      }));
      build.onLoad({ filter: /^wasm-base64$/, namespace: "nox-embed" }, () => ({
        contents: `export default ${JSON.stringify(wasmBase64)};\n`,
        loader: "js",
      }));
    },
  };
}

/**
 * Replace the glue's URL-based module lookup (see GLUE_URL_EXPRESSION). The
 * expression must occur exactly once; a wasm-bindgen upgrade that changes the
 * glue fails the build here instead of silently shipping a fetch path.
 * @param {string} source
 * @param {string} gluePath
 * @returns {string}
 */
export function rewriteGlue(source, gluePath) {
  const occurrences = source.split(GLUE_URL_EXPRESSION).length - 1;
  if (occurrences !== 1) {
    throw new BuildError(
      `${gluePath}: expected the wasm-bindgen glue to contain ${JSON.stringify(GLUE_URL_EXPRESSION)} exactly once, found ${occurrences}; ` +
        "review scripts/embed/nox-wasm-shim.js against the new glue before bundling it",
      "bundle-check-failed",
    );
  }
  const rewritten = source.replace(GLUE_URL_EXPRESSION, GLUE_URL_REPLACEMENT);
  if (rewritten.includes("import.meta")) {
    throw new BuildError(`${gluePath}: the glue uses import.meta outside the module lookup; review the embed shim`, "bundle-check-failed");
  }
  return rewritten;
}

/**
 * Structural checks on the emitted bundle.
 * @param {string} text
 * @param {string} wasmBase64
 */
function checkBundle(text, wasmBase64) {
  if (!text.includes(JSON.stringify(wasmBase64))) {
    throw new BuildError(
      "the bundle does not embed the nox-wasm module: the worker source must import \"@hisoka-io/nox-wasm\" or \"nox-embed:wasm-bytes\" and use it, or tree shaking drops the bytes",
      "bundle-check-failed",
    );
  }
  if (text.includes("import.meta")) {
    throw new BuildError(
      "the bundle references import.meta, which has no meaning in a classic script loaded by importScripts()",
      "bundle-check-failed",
    );
  }
}

/**
 * @param {{ packageDir: string, entry: string, outfile: string, tsconfigPath: string, banner: string,
 *           wasmPath: string, wasmBytes: Buffer, bundle: Uint8Array, metafile: import("esbuild").Metafile }} parts
 * @returns {BuildRecord}
 */
function makeRecord(parts) {
  const { packageDir, entry, outfile, tsconfigPath, banner, wasmPath, wasmBytes, bundle, metafile } = parts;
  /** @type {ModuleInput[]} */
  const modules = Object.keys(metafile.inputs)
    .sort()
    .map((path) => {
      const input = /** @type {{ bytes: number }} */ (metafile.inputs[path]);
      const onDisk = !path.includes(":") && existsSync(resolve(packageDir, path));
      return {
        path,
        bytes: input.bytes,
        sha256: onDisk ? sha256Hex(readFileSync(resolve(packageDir, path))) : null,
      };
    });
  return {
    schema: BUILD_RECORD_SCHEMA,
    artifact: {
      path: toPosix(relative(packageDir, outfile)),
      bytes: bundle.byteLength,
      keccak256: keccak256Hex(bundle),
      sha256: sha256Hex(bundle),
    },
    entry: toPosix(entry),
    tsconfig: {
      path: toPosix(relative(packageDir, tsconfigPath)),
      sha256: sha256Hex(readFileSync(tsconfigPath)),
    },
    esbuild: {
      version: esbuildVersion,
      options: { ...BUNDLE_OPTIONS, define: { ...BUNDLE_OPTIONS.define }, banner },
    },
    wasm: {
      path: toPosix(relative(packageDir, wasmPath)),
      bytes: wasmBytes.byteLength,
      sha256: sha256Hex(wasmBytes),
      keccak256: keccak256Hex(wasmBytes),
    },
    modules,
  };
}

/**
 * Write the bundle, its keccak record and the build record. The default dist/
 * is emptied first so a renamed output can never leave a stale bundle behind.
 * @param {string} packageDir
 * @param {string} outfile
 * @param {Uint8Array} bundle
 * @param {BuildRecord} record
 */
function writeOutputs(packageDir, outfile, bundle, record) {
  const outDir = dirname(outfile);
  if (outDir === join(packageDir, "dist")) {
    rmSync(outDir, { recursive: true, force: true });
  } else {
    for (const file of [outfile, `${outfile}${KECCAK_FILE_SUFFIX}`, join(outDir, BUILD_RECORD_NAME)]) {
      rmSync(file, { force: true });
    }
  }
  mkdirSync(outDir, { recursive: true });
  writeFileSync(outfile, bundle);
  writeFileSync(
    `${outfile}${KECCAK_FILE_SUFFIX}`,
    formatHashLine(record.artifact.keccak256, outfile.slice(outDir.length + 1)),
  );
  writeFileSync(join(outDir, BUILD_RECORD_NAME), `${JSON.stringify(record, null, 2)}\n`);
}

/**
 * @param {string} packageDir
 * @returns {{ name: string, version: string, license: string }}
 */
function readPackageManifest(packageDir) {
  const path = join(packageDir, "package.json");
  requireFile(path, `package.json not found in ${packageDir}`);
  /** @type {unknown} */
  const manifest = JSON.parse(readFileSync(path, "utf8"));
  if (typeof manifest !== "object" || manifest === null) {
    throw new BuildError(`${path} is not a JSON object`, "missing-input");
  }
  const fields = /** @type {Record<string, unknown>} */ (manifest);
  const name = fields["name"];
  const version = fields["version"];
  const license = fields["license"];
  if (typeof name !== "string" || typeof version !== "string" || typeof license !== "string") {
    throw new BuildError(`${path} must declare string name, version and license fields`, "missing-input");
  }
  return { name, version, license };
}

/**
 * @param {string} path
 * @param {string} message
 */
function requireFile(path, message) {
  if (!existsSync(path)) throw new BuildError(message, "missing-input");
}

/**
 * @param {string} path
 * @returns {string}
 */
function toPosix(path) {
  return path.split(sep).join("/");
}

/**
 * @param {string[]} argv
 * @returns {Promise<number>}
 */
export async function main(argv) {
  const { values } = parseArgs({
    args: argv,
    options: {
      entry: { type: "string" },
      outfile: { type: "string" },
      wasm: { type: "string" },
      "wasm-glue": { type: "string" },
      help: { type: "boolean", short: "h", default: false },
    },
  });
  if (values.help) {
    process.stdout.write(
      "usage: build.mjs [--entry src/index.ts] [--outfile dist/anon-rpc-worker.js] [--wasm <file>] [--wasm-glue <file>]\n",
    );
    return 0;
  }
  /** @type {BuildOptions} */
  const options = {};
  if (values.entry !== undefined) options.entry = values.entry;
  if (values.outfile !== undefined) options.outfile = values.outfile;
  if (values.wasm !== undefined) options.wasm = values.wasm;
  if (values["wasm-glue"] !== undefined) options.wasmGlue = values["wasm-glue"];
  const { record } = await buildWorker(options);
  const { artifact, wasm } = record;
  process.stdout.write(
    [
      `anon-rpc worker: ${artifact.path} (${artifact.bytes} bytes)`,
      `  keccak256 ${artifact.keccak256}  (the workerHash a specifier pins)`,
      `  sha256    ${artifact.sha256}`,
      `  nox-wasm  ${wasm.path} (${wasm.bytes} bytes, sha256 ${wasm.sha256})`,
      `  esbuild   ${record.esbuild.version}, ${record.modules.length} modules`,
      "",
    ].join("\n"),
  );
  return 0;
}

if (isMain(import.meta.url)) runMain("build.mjs", main);
