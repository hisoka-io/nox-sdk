// One `forge build` before any test file runs, so parallel test files never race on out/ and cache/.
import { forgeBuild } from "../tools/artifacts.ts";

export default async function setup(): Promise<void> {
  await forgeBuild();
}
