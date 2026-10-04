import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { loadConfig, sidecarAdminPort, sidecarUdpPort } from "../../src/config.js";
import { renderBuildCommand, resolveWorkerBundle } from "../../src/worker-bundle.js";

describe("bed L port layout", () => {
  it("puts nox-kps at base+10N+5 (UDP) and base+10N+6 (admin)", () => {
    expect(sidecarUdpPort(14_000, 0)).toBe(14_005);
    expect(sidecarUdpPort(14_000, 9)).toBe(14_095);
    expect(sidecarAdminPort(27_000, 3)).toBe(27_036);
  });
});

describe("NOX_WORKER_BUILD_CMD", () => {
  it("renders the two placeholders", () => {
    expect(renderBuildCommand("node b.mjs --testbed {testbed_json} --out {out}", { testbed_json: "/r/t.json", out: "/r/w.js" }))
      .toBe("node b.mjs --testbed /r/t.json --out /r/w.js");
  });

  it("rejects unknown placeholders and whitespace in values", () => {
    expect(() => renderBuildCommand("x {snapshot}", { testbed_json: "a", out: "b" })).toThrow(/\{snapshot\}/u);
    expect(() => renderBuildCommand("x {out}", { testbed_json: "a", out: "b c" })).toThrow(/whitespace/u);
  });

  it("reports a missing prebuilt bundle instead of throwing", async () => {
    const dir = mkdtempSync(join(tmpdir(), "e2e-bundle-"));
    const cfg = loadConfig({ NOX_WORKER_BUNDLE: join(dir, "absent.js") }, dir);
    const source = await resolveWorkerBundle(cfg, dir, join(dir, "testbed.json"), dir);
    expect(source.kind).toBe("missing");
  });

  it("runs the build command and reads the bundle it writes", async () => {
    const dir = mkdtempSync(join(tmpdir(), "e2e-bundle-"));
    const script = join(dir, "build.mjs");
    writeFileSync(
      script,
      'import { readFileSync, writeFileSync } from "node:fs";\n' +
        "const [input, out] = process.argv.slice(2);\n" +
        'writeFileSync(out, `/* ${JSON.parse(readFileSync(input, "utf8")).tag} */`);\n',
    );
    const testbed = join(dir, "testbed.json");
    writeFileSync(testbed, JSON.stringify({ tag: "bed-l" }));
    const cfg = loadConfig({ NOX_WORKER_BUILD_CMD: `${process.execPath} ${script} {testbed_json} {out}` }, dir);
    const source = await resolveWorkerBundle(cfg, dir, testbed, dir);
    expect(source.kind).toBe("built");
    if (source.kind === "built") expect(new TextDecoder().decode(source.bytes)).toBe("/* bed-l */");
  });

  it("fails with the log path when the build command fails", async () => {
    const dir = mkdtempSync(join(tmpdir(), "e2e-bundle-"));
    const cfg = loadConfig({ NOX_WORKER_BUILD_CMD: `${process.execPath} -e process.exit(3)` }, dir);
    await expect(resolveWorkerBundle(cfg, dir, join(dir, "t.json"), dir)).rejects.toThrow(/code 3.*worker-build\.log/su);
  });
});
