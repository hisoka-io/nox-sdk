// `pnpm testbed`: start bed L and keep it running for manual work (a browser
// pointed at the host page, the SDK's own scripts, a nox-kps under a debugger).
//
//   pnpm testbed            chains + resolver + host page + 10-node mesh (+ nox-kps when NOX_KPS_CMD is set)
//   pnpm testbed --no-mesh  chains + resolver + host page only
//
// Prints the endpoints, writes <run>/testbed.json, and tears everything down
// on SIGINT or SIGTERM. Logs stay in the run directory.

import { describeError } from "../errors.js";
import { loadConfig } from "../config.js";
import { startHostServer } from "../host-server.js";
import {
  createRunPaths,
  describeTestbed,
  startChains,
  startMeshWithSidecars,
  startResolver,
  writeTestbedInfo,
  type MeshWithSidecars,
} from "../testbed.js";

async function main(argv: readonly string[]): Promise<void> {
  const unknown = argv.filter((arg) => arg !== "--no-mesh");
  if (unknown.length > 0) throw new Error(`unknown arguments: ${unknown.join(" ")} (accepted: --no-mesh)`);
  const withMesh = !argv.includes("--no-mesh");

  const config = loadConfig();
  const paths = createRunPaths(config, "cli");
  const stops: (() => Promise<void>)[] = [];
  const stopAll = async (): Promise<void> => {
    for (const stop of stops.reverse()) {
      try {
        await stop();
      } catch (error) {
        console.error(`[testbed] teardown: ${describeError(error)}`);
      }
    }
  };
  let stopping = false;
  const onSignal = (signal: NodeJS.Signals): void => {
    if (stopping) return;
    stopping = true;
    console.log(`[testbed] ${signal}: stopping`);
    void stopAll().then(() => process.exit(0));
  };
  process.on("SIGINT", onSignal);
  process.on("SIGTERM", onSignal);

  try {
    console.log(`[testbed] run directory ${paths.root}`);
    const chains = await startChains(config, paths);
    stops.push(() => chains.stop());
    const resolver = await startResolver();
    stops.push(() => resolver.server.close());
    const host = await startHostServer(config.e2eRoot);
    stops.push(() => host.close());
    let mesh: MeshWithSidecars | undefined;
    if (withMesh) {
      console.log(`[testbed] starting ${config.mesh.nodes}-node mesh (base port ${config.mesh.basePort})`);
      mesh = await startMeshWithSidecars(config, paths, chains.upstream);
      stops.push(() => mesh?.stop() ?? Promise.resolve());
    }
    const info = describeTestbed({
      config,
      paths,
      chains,
      resolver,
      hostPageOrigin: host.origin,
      ...(mesh === undefined ? {} : { mesh }),
    });
    const file = writeTestbedInfo(paths, info);
    console.log(`[testbed] specifier chain  ${chains.specifier.url} (chain ${chains.specifier.chainId})`);
    console.log(`[testbed] upstream chain   ${chains.upstream.url} (chain ${chains.upstream.chainId})`);
    console.log(`[testbed] resolver         ${resolver.server.origin}/keccak/<hh>/<62 hex>`);
    console.log(`[testbed] host page        ${host.pageUrl("0.3.2")} (window.e2e)`);
    if (mesh !== undefined) {
      console.log(`[testbed] mesh seed        ${mesh.mesh.seedUrl}/topology`);
      for (const node of info.mesh?.nodes ?? []) {
        console.log(
          `[testbed]   node ${node.id} role ${node.role} ingress ${node.ingressUrl}` +
            (node.kpsAddress === undefined ? "" : ` kps ${node.kpsAddress}`),
        );
      }
    }
    console.log(`[testbed] wrote ${file}; Ctrl-C stops everything`);
  } catch (error) {
    await stopAll();
    throw error;
  }
}

main(process.argv.slice(2)).catch((error: unknown) => {
  console.error(`[testbed] ${describeError(error)}`);
  process.exit(1);
});
