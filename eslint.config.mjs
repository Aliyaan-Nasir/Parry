// ESLint for the TypeScript outside the web app (which has its own config): the packages, the
// services, the API and the scripts.
import { defineConfig, globalIgnores } from "eslint/config";
import tseslint from "typescript-eslint";

export default defineConfig([
  ...tseslint.configs.recommended,
  {
    rules: {
      "@typescript-eslint/consistent-type-imports": ["error", { fixStyle: "inline-type-imports" }],
      "@typescript-eslint/no-unused-vars": ["error", { argsIgnorePattern: "^_", varsIgnorePattern: "^_" }],
    },
  },
  globalIgnores(["**/dist/**", "**/node_modules/**", "apps/web/**", "contracts/**", "enclave/**", "internal/**", "tools/**"]),
]);
