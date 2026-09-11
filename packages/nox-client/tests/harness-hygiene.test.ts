import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const RETIRED_ADDRESS_HASHES = new Set([
  "477202f495460f4428fc1830c141462214dbf6fecb9a3b2ea47ec7be23b0c7c6",
  "e9ba420fbd9d4814afdc7a574eca94389be3d31b0f8287183255e3309bfd0452",
  "494345ecebf8d14d5d2b0c39a1a9be9e05f6c3a66c921795d5995de424178dd4",
  "17110ce4ec900b58d471291fb3c12a0f6d82d69cbc19c585779d84dd15eb379a",
]);

describe("internal harness hygiene", () => {
  const internal = resolve(import.meta.dirname, "internal");
  const files = readdirSync(internal)
    .filter((name) => name.endsWith(".ts") || name.endsWith(".sh"))
    .map((name) => ({ name, source: readFileSync(resolve(internal, name), "utf8") }));

  it("contains no embedded 32-byte private-key candidates", () => {
    for (const file of files) {
      expect(file.source, file.name).not.toMatch(/(?:^|[^0-9a-fA-F])[0-9a-fA-F]{64}(?:[^0-9a-fA-F]|$)/u);
    }
  });

  it("contains no retired deployment address", () => {
    for (const file of files) {
      for (const match of file.source.matchAll(/0x[0-9a-fA-F]{40}/gu)) {
        const digest = createHash("sha256")
          .update(match[0].toLowerCase())
          .digest("hex");
        expect(RETIRED_ADDRESS_HASHES.has(digest), file.name).toBe(false);
      }
    }
  });
});
