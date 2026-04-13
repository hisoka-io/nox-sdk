import * as crypto from "node:crypto";
import * as fs from "node:fs";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
if (typeof globalThis.require === "undefined") {
  const __filename = fileURLToPath(import.meta.url);
  globalThis.require = createRequire(__filename);
}
import { NoxClient } from "../../src/index.js";

const meshInfo = JSON.parse(fs.readFileSync("/tmp/nox_mesh/mesh_info.json", "utf-8"));

async function main() {
  const seedUrl = `http://127.0.0.1:${meshInfo.nodes[0].metrics_port}`;
  const client = await NoxClient.connect({
    seeds: [seedUrl],
    dangerouslySkipFingerprintCheck: true,
    timeoutMs: 15000,
    surbsPerRequest: 10,
  });

  const sizes = [32, 512, 1024, 2048, 4096];
  for (const size of sizes) {
    const data = crypto.randomBytes(size);
    try {
      const resp = await client.send({ tag: "Echo", data });
      let mismatches = 0;
      for (let j = 0; j < Math.min(data.length, resp.length); j++) {
        if (data[j] !== resp[j]) mismatches++;
      }
      const status = mismatches === 0 && data.length === resp.length ? "OK" : "CORRUPT";
      console.log(`echo_${size}B: ${status} sent=${data.length} recv=${resp.length} mismatches=${mismatches}`);
    } catch (e: any) {
      console.log(`echo_${size}B: ERROR ${e.message?.slice(0, 80)}`);
    }
  }
  
  client.disconnect();
}
main().catch(console.error);
