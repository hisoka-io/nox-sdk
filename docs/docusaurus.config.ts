import { themes as prismThemes } from "prism-react-renderer";
import type { Config } from "@docusaurus/types";
import type * as Preset from "@docusaurus/preset-classic";

const config: Config = {
  themes: ["@docusaurus/theme-mermaid"],
  markdown: {
    mermaid: true,
  },
  title: "Hisoka",
  tagline: "Privacy layer for DeFi on Ethereum",
  favicon: "img/logo-white.svg",

  future: {
    v4: true,
  },

  url: "https://docs.hisoka.io",
  baseUrl: "/",

  organizationName: "hisoka-io",
  projectName: "nox-sdk",

  onBrokenLinks: "throw",

  i18n: {
    defaultLocale: "en",
    locales: ["en"],
  },

  presets: [
    [
      "classic",
      {
        docs: {
          sidebarPath: "./sidebars.ts",
          routeBasePath: "/",
          editUrl: "https://github.com/hisoka-io/nox-sdk/tree/main/docs/",
        },
        blog: false,
        theme: {
          customCss: "./src/css/custom.css",
        },
      } satisfies Preset.Options,
    ],
  ],

  themeConfig: {
    colorMode: {
      defaultMode: "dark",
      respectPrefersColorScheme: true,
    },
    navbar: {
      title: "Hisoka",
      logo: {
        alt: "Hisoka",
        src: "img/logo-black.svg",
        srcDark: "img/logo-white.svg",
      },
      items: [
        {
          type: "docSidebar",
          sidebarId: "docs",
          position: "left",
          label: "Docs",
        },
        {
          href: "https://map.hisoka.io",
          label: "Live Map",
          position: "right",
        },
        {
          href: "https://github.com/hisoka-io/nox",
          label: "Nox",
          position: "right",
        },
        {
          href: "https://github.com/hisoka-io/run-nox",
          label: "Run a Node",
          position: "right",
        },
        {
          href: "https://hisoka.io/",
          label: "Hisoka",
          position: "right",
        },
      ],
    },
    footer: {
      style: "dark",
      links: [
        {
          title: "Docs",
          items: [
            { label: "Overview", to: "/" },
            { label: "Quickstart", to: "/quickstart" },
            { label: "Configuration", to: "/configuration" },
          ],
        },
        {
          title: "SDK",
          items: [
            { label: "Transactions", to: "/transactions" },
            { label: "RPC Calls", to: "/rpc-calls" },
            { label: "HTTP Requests", to: "/http-requests" },
          ],
        },
        {
          title: "Links",
          items: [
            { label: "Hisoka", href: "https://hisoka.io" },
            { label: "GitHub", href: "https://github.com/hisoka-io/nox-sdk" },
          ],
        },
      ],
      copyright: `\u00A9 ${new Date().getFullYear()} Hisoka Labs`,
    },
    prism: {
      theme: prismThemes.github,
      darkTheme: prismThemes.dracula,
      additionalLanguages: ["bash", "typescript"],
    },
  } satisfies Preset.ThemeConfig,
};

export default config;
