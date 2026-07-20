import js from "@eslint/js";

const nodeGlobals = Object.fromEntries(
  [
    "AbortController",
    "Buffer",
    "clearInterval",
    "clearTimeout",
    "console",
    "fetch",
    "globalThis",
    "performance",
    "process",
    "setInterval",
    "setTimeout",
    "structuredClone",
    "TextDecoder",
    "TextEncoder",
    "URL",
    "URLSearchParams",
  ].map((name) => [name, "readonly"]),
);

export default [
  {
    ignores: ["node_modules/**", "out/**", ".vscode-test/**", ".pnpm-store/**"],
  },
  {
    ...js.configs.recommended,
    files: ["eslint.config.js", "prettier.config.js", "scripts/**/*.mjs"],
    languageOptions: {
      ecmaVersion: "latest",
      globals: nodeGlobals,
      sourceType: "module",
    },
    rules: {
      "no-control-regex": "off",
    },
  },
];
