// @ts-check
/** Small helpers shared by the command-line scripts. */
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";

/**
 * True when the module at `moduleUrl` is the script Node was started with.
 * @param {string} moduleUrl `import.meta.url` of the caller
 * @returns {boolean}
 */
export function isMain(moduleUrl) {
  const entry = process.argv[1];
  if (entry === undefined) return false;
  try {
    return realpathSync(entry) === realpathSync(fileURLToPath(moduleUrl));
  } catch {
    return false;
  }
}

/**
 * Message of any thrown value.
 * @param {unknown} error
 * @returns {string}
 */
export function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Run a CLI `main` and turn its result or failure into the process exit code.
 * @param {string} name script name used as the error prefix
 * @param {(argv: string[]) => Promise<number>} main
 */
export function runMain(name, main) {
  main(process.argv.slice(2)).then(
    (code) => {
      process.exitCode = code;
    },
    (error) => {
      const code = error instanceof Error && "code" in error ? ` [${String(error.code)}]` : "";
      process.stderr.write(`${name}: ${errorMessage(error)}${code}\n`);
      process.exitCode = 1;
    },
  );
}
