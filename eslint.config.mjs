import js from "@eslint/js";
import eslintConfigPrettier from "eslint-config-prettier";
import reactHooks from "eslint-plugin-react-hooks";
import globals from "globals";
import tseslint from "typescript-eslint";

export default tseslint.config(
  {
    ignores: [
      "dist/**",
      ".docs-dist/**",
      "docs/.vitepress/**",
      ".netlify/**",
      ".tanstack/**",
      "coverage/**",
      "node_modules/**",
      "src/routeTree.gen.ts",
      "db/**",
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ["**/*.{ts,tsx,js,jsx,mjs,cjs}"],
    languageOptions: {
      ecmaVersion: "latest",
      sourceType: "module",
      globals: {
        ...globals.browser,
        ...globals.node,
      },
    },
    plugins: {
      "react-hooks": reactHooks,
    },
    rules: {
      ...reactHooks.configs.recommended.rules,
    },
  },
  {
    files: ["src/**/*.{ts,tsx,js,jsx,mjs,cjs}"],
    ignores: [
      "src/lib/scripts/**",
      "src/lib/listings/refinement/**",
      "src/lib/listings/enrichment/**",
      "src/lib/listings/ingestion/**",
    ],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              group: [
                "@/lib/listings/refinement/**",
                "@/lib/listings/enrichment/**",
                "./refinement/**",
                "../refinement/**",
                "./enrichment/**",
                "../enrichment/**",
              ],
              message:
                "Web/runtime modules must not import listing refinement or enrichment internals. Keep these dependencies in CLI-only paths.",
            },
          ],
        },
      ],
    },
  },
  eslintConfigPrettier,
);
