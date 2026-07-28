import js from "@eslint/js";
import reactHooks from "eslint-plugin-react-hooks";
import reactRefresh from "eslint-plugin-react-refresh";
import globals from "globals";
import tseslint from "typescript-eslint";
import prettier from "eslint-config-prettier";

export default tseslint.config(
  { ignores: ["dist/", "src-tauri/target/", "node_modules/"] },
  {
    files: ["src/**/*.{ts,tsx}"],
    extends: [
      js.configs.recommended,
      ...tseslint.configs.recommended,
      reactHooks.configs.flat["recommended-latest"],
      reactRefresh.configs.vite,
    ],
    languageOptions: {
      ecmaVersion: 2022,
      globals: globals.browser,
    },
  },
  {
    // Core boundary (src/core/README.md): everything outside src/core imports
    // core ONLY via its public entry (src/core/index.ts) — deep imports into
    // adapters/repositories/SQL modules are forbidden.
    files: ["src/**/*.{ts,tsx}"],
    ignores: ["src/core/**"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              group: ["**/core/*", "**/core/*/**"],
              message:
                "Import from the core public entry (src/core) only — deep imports into core are forbidden.",
            },
          ],
        },
      ],
    },
  },
  prettier,
);
