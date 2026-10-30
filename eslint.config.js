// The house rules from CLAUDE.md, enforced rather than remembered.
import js from "@eslint/js";
import globals from "globals";
import tseslint from "typescript-eslint";

/** The outside world. The Core reaches it only through the injected Platform. */
const OUTSIDE_WORLD_GLOBALS = [
  "XMLHttpRequest",
  "fetch",
  "navigator",
  "window",
  "localStorage",
  "sessionStorage",
  "indexedDB",
  "setTimeout",
  "setInterval",
  "clearTimeout",
  "clearInterval",
  "requestAnimationFrame",
].map((name) => ({
  name,
  message: "Reach the outside world through the Platform (src/platform/).",
}));

export default tseslint.config(
  { ignores: ["dist/", "node_modules/", "playground/", "coverage/"] },

  js.configs.recommended,
  ...tseslint.configs.recommended,

  {
    files: ["**/*.{ts,tsx,js,mjs}"],
    languageOptions: { globals: { ...globals.browser, ...globals.node } },
    rules: {
      "@typescript-eslint/no-explicit-any": "error",
      "@typescript-eslint/no-unused-vars": ["error", { argsIgnorePattern: "^_" }],
    },
  },

  // Code conventions: arrow functions everywhere, no classes, no method shorthand, no getters.
  {
    files: ["src/**/*.ts"],
    rules: {
      "func-style": ["error", "expression"],
      "prefer-arrow-callback": "error",
      "no-restricted-syntax": [
        "error",
        {
          selector: "FunctionDeclaration",
          message: "Declare functions as arrows assigned to a const.",
        },
        {
          selector: "ClassDeclaration, ClassExpression",
          message: "No classes: use factories and plain objects.",
        },
        {
          selector: "Property[method=true]",
          message: "Object behaviour is arrow properties, not method shorthand.",
        },
        {
          selector: "Property[kind='get'], Property[kind='set']",
          message: "No getters: expose a mutable state object instead.",
        },
      ],
    },
  },
  // The one class, on purpose: extending Error is what gives adopters instanceof and a stack.
  {
    files: ["src/errors.ts"],
    rules: { "no-restricted-syntax": "off" },
  },

  // The Platform seam: only src/platform/ may touch timers, the network, storage, clocks or randomness.
  {
    files: ["src/**/*.ts"],
    ignores: ["src/platform/**"],
    rules: {
      "no-restricted-globals": ["error", ...OUTSIDE_WORLD_GLOBALS],
      "no-restricted-properties": [
        "error",
        { object: "Date", property: "now", message: "Use platform.now()." },
        { object: "Math", property: "random", message: "Use platform.random()." },
        {
          object: "globalThis",
          property: "fetch",
          message: "Reach the network through the Platform.",
        },
      ],
    },
  },
  // The server helper runs in your backend, not the browser Core: the Platform
  // seam and the no-classes rule are about the Core.
  {
    files: ["src/server.ts"],
    rules: { "no-restricted-globals": "off", "no-restricted-properties": "off" },
  },
  // The JSON Transport is the one other door: it is your backend's client, not
  // the Core's, and adopters swap it out (or its fetch) wholesale.
  {
    files: ["src/http-transport.ts"],
    rules: { "no-restricted-properties": "off" },
  },

  // Tests may use timers and casts to script the fakes.
  {
    files: ["test/**/*.ts"],
    rules: { "@typescript-eslint/no-non-null-assertion": "off" },
  },
);
