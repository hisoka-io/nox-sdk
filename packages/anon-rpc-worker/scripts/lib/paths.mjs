// @ts-check
/** Fixed locations inside the package. */
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** Root of this package (packages/anon-rpc-worker). */
export const PACKAGE_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
/** Root of the nox-sdk repository. */
export const REPO_DIR = resolve(PACKAGE_DIR, "..", "..");
/** Build-provided virtual module implementations. */
export const EMBED_DIR = join(PACKAGE_DIR, "scripts", "embed");
/** Committed snapshot inputs and outputs (ARCHITECTURE §4.1). */
export const SNAPSHOT_DIR = join(PACKAGE_DIR, "snapshot");
/** The pinned snapshot the worker bundles. */
export const SNAPSHOT_PATH = join(SNAPSHOT_DIR, "nox-snapshot.json");
/** The discovery bootstrap the worker bundles next to the snapshot (`nox-anon-rpc-bootstrap/1`). */
export const BOOTSTRAP_PATH = join(SNAPSHOT_DIR, "nox-bootstrap.json");
/** JSON Schema of the snapshot document. */
export const SNAPSHOT_SCHEMA_PATH = join(SNAPSHOT_DIR, "nox-snapshot.schema.json");
/** Reviewed capability hints per member. */
export const CAPABILITIES_PATH = join(SNAPSHOT_DIR, "capabilities.json");
/** Networks the snapshot tools know (chain, registry, deployment block, release inputs). */
export const NETWORKS_PATH = join(PACKAGE_DIR, "scripts", "networks.json");
/** Pinned toolchain of the canonical build. */
export const TOOLCHAIN_PATH = join(PACKAGE_DIR, "scripts", "toolchain.env");
