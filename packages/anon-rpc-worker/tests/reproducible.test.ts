import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PACKAGE_DIR } from "../scripts/lib/paths.mjs";

let dir: string;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "nox-repro-test-"));
});
afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

function runScript(script: string, args: string[], env: NodeJS.ProcessEnv): { status: number; stderr: string } {
  try {
    execFileSync("bash", [join(PACKAGE_DIR, "scripts", script), ...args], { env, stdio: ["ignore", "pipe", "pipe"] });
    return { status: 0, stderr: "" };
  } catch (error) {
    const failure = error as { status?: number; stderr?: Buffer };
    return { status: failure.status ?? -1, stderr: String(failure.stderr ?? "") };
  }
}

describe("build-wasm.sh", () => {
  it("names the expected and found version when a pinned tool differs", () => {
    const bin = join(dir, "fake-bin");
    mkdirSync(bin, { recursive: true });
    const fakeOpt = join(bin, "wasm-opt");
    writeFileSync(fakeOpt, "#!/bin/sh\necho 'wasm-opt version 116 (version_116)'\n");
    chmodSync(fakeOpt, 0o755);
    const result = runScript("build-wasm.sh", ["--check-pins"], { ...process.env, PATH: `${bin}:${process.env["PATH"] ?? ""}` });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("wasm-opt 117 required by scripts/toolchain.env, found 116");
  });
});

describe("build-worker.sh and verify-reproducible.sh", () => {
  it("reject unknown options with usage guidance", () => {
    for (const script of ["build-worker.sh", "verify-reproducible.sh", "build-wasm.sh"]) {
      const result = runScript(script, ["--bogus"], process.env);
      expect(result.status).toBe(2);
      expect(result.stderr).toContain("unknown option --bogus");
    }
  });

  it("refuse a stage they do not know", () => {
    const result = runScript("build-worker.sh", ["--stage", "docs"], process.env);
    expect(result.status).toBe(2);
    expect(result.stderr).toContain("--stage must be all, wasm or js");
  });
});

describe("reproducible-rustc.sh", () => {
  // A fake rustc that answers the sysroot probe and echoes the rewritten -C metadata argument.
  function metadataFor(workspaceRoot: string, source: string, cargoHome = "/usr/local/cargo"): string {
    const fakeRustc = join(dir, "fake-rustc");
    writeFileSync(
      fakeRustc,
      '#!/bin/sh\nif [ "$1" = "--print" ]; then echo /usr/local/rustup/toolchains/1.95.0; exit 0; fi\nfor a in "$@"; do case "$a" in metadata=*) echo "$a";; esac; done\n',
    );
    chmodSync(fakeRustc, 0o755);
    const env = { ...process.env, CARGO_HOME: cargoHome, NOX_WORKSPACE_ROOT: workspaceRoot };
    const out = execFileSync(
      "bash",
      [
        join(PACKAGE_DIR, "scripts", "reproducible-rustc.sh"),
        fakeRustc,
        "--crate-name",
        "getrandom",
        "--edition=2018",
        "--crate-type",
        "lib",
        "--target",
        "wasm32-unknown-unknown",
        source,
        "-C",
        "metadata=0123456789abcdef",
      ],
      { env },
    );
    return String(out).trim();
  }

  const registrySource = "/usr/local/cargo/registry/src/index.crates.io-1949cf8c6b5b557f/getrandom-0.2.16/src/lib.rs";

  it("gives dependency keys that do not depend on the checkout path", () => {
    const keys = ["/src", "/work/second-build/nox-sdk", "/usr/local", "/registry", "/tmp/build-1/src"].map((root) =>
      metadataFor(root, registrySource),
    );
    expect(new Set(keys).size).toBe(1);
    expect(keys[0]).toMatch(/^metadata=[0-9a-f]{32}$/);
  });

  it("gives workspace keys that do not depend on the checkout path", () => {
    const keys = ["/src", "/work/second-build/nox-sdk"].map((root) =>
      metadataFor(root, `${root}/packages/nox-wasm/src/lib.rs`),
    );
    expect(new Set(keys).size).toBe(1);
  });

  it("keeps distinct crate versions distinct", () => {
    const other = registrySource.replace("getrandom-0.2.16", "getrandom-0.2.15");
    expect(metadataFor("/src", registrySource)).not.toBe(metadataFor("/src", other));
  });
});
