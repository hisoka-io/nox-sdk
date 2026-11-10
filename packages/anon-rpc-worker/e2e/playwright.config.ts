import { defineConfig } from "@playwright/test";

/**
 * Chromium flags the upstream anon-rpc e2e passes (impl/test/run-e2e.mjs): expose
 * real local addresses as ICE candidates instead of mDNS names.
 */
const UPSTREAM_WEBRTC_FLAGS = [
  "--disable-features=WebRtcHideLocalIpsWithMdns",
  "--force-webrtc-ip-handling-policy=default",
];

/**
 * E2E_WEBKIT=1 adds WebKit (Safari's engine) for the KPS dial and the worker
 * boot. Off by default: WebKit needs `npx playwright install --with-deps webkit`.
 */
const WEBKIT_PROJECTS = process.env["E2E_WEBKIT"] === "1"
  ? [
      {
        name: "webkit",
        testMatch: /(?:kps-webrtc|nox-worker)\.spec\.ts$/u,
        grep: /server \(|boots by specifier|latency: boot time/u,
        use: { browserName: "webkit" as const },
      },
    ]
  : [];

export default defineConfig({
  testDir: "tests/e2e",
  testMatch: /.*\.spec\.ts$/u,
  // One worker: the mesh, anvils and KPS servers are shared, port-bound resources.
  fullyParallel: false,
  workers: 1,
  timeout: 5 * 60_000,
  expect: { timeout: 30_000 },
  outputDir: ".run/test-results",
  reporter: [["list"], ["json", { outputFile: ".run/playwright-report.json" }]],
  use: {
    browserName: "chromium",
    headless: true,
    trace: "retain-on-failure",
  },
  projects: [
    {
      name: "chromium",
      use: { launchOptions: { args: UPSTREAM_WEBRTC_FLAGS } },
    },
    {
      // Chrome's default WebRTC privacy settings (mDNS host candidates), as a
      // wallet user's browser runs them. Only the KPS probe needs this variant.
      name: "chromium-stock-webrtc",
      testMatch: /kps-webrtc\.spec\.ts$/u,
      use: { launchOptions: { args: [] } },
    },
    ...WEBKIT_PROJECTS,
  ],
});
