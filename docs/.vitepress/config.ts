import { defineConfig } from "vitepress";

export default defineConfig({
  // GitHub Pages serves a project site under /<repo>/, so every asset and
  // internal link needs this prefix. Without it the deployed site 404s
  // everything while working perfectly in local dev.
  base: "/presigned-multipart-upload/",

  title: "presigned-multipart-upload",
  description:
    "Framework-independent multipart uploads to presigned URLs, with automatic retry, cancel, pause and resume from the parts that never landed.",
  cleanUrls: true,
  // The spec is design history, not documentation.
  srcExclude: ["specs/**"],

  themeConfig: {
    nav: [
      { text: "Guide", link: "/guide/getting-started" },
      { text: "Adapters", link: "/adapters/react" },
      { text: "Reference", link: "/reference/options" },
    ],

    sidebar: [
      {
        text: "Guide",
        items: [
          { text: "Getting started", link: "/guide/getting-started" },
          { text: "The backend contract", link: "/guide/backend-contract" },
          { text: "Bucket setup", link: "/guide/bucket-setup" },
          { text: "Retry and backoff", link: "/guide/retry" },
          { text: "Cancel, pause and resume", link: "/guide/lifecycle" },
          { text: "Durable resume", link: "/guide/durable-resume" },
          { text: "Very large files", link: "/guide/large-files" },
        ],
      },
      {
        text: "Adapters",
        items: [
          { text: "React", link: "/adapters/react" },
          { text: "Angular", link: "/adapters/angular" },
          { text: "Vue", link: "/adapters/vue" },
          { text: "No framework", link: "/adapters/vanilla" },
        ],
      },
      {
        text: "Reference",
        items: [
          { text: "Options", link: "/reference/options" },
          { text: "Errors", link: "/reference/errors" },
          { text: "Glossary", link: "/reference/glossary" },
        ],
      },
    ],

    outline: [2, 3],
    search: { provider: "local" },

    socialLinks: [
      {
        icon: "github",
        link: "https://github.com/moneychaudhary/presigned-multipart-upload",
      },
    ],

    editLink: {
      pattern:
        "https://github.com/moneychaudhary/presigned-multipart-upload/edit/main/docs/:path",
    },

    footer: {
      message: "Released under the MIT Licence.",
      copyright: "Copyright © Money Chaudhary",
    },
  },
});
