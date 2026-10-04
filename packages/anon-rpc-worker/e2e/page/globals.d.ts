import type { E2EPageApi } from "./api.js";

declare global {
  interface Window {
    /** Installed by page/probe-page.ts once the harness bundle has loaded. */
    e2e: E2EPageApi;
  }
}
