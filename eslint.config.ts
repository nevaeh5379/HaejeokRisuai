import js from "@eslint/js";
import globals from "globals";
import tseslint from "typescript-eslint";
import { defineConfig, globalIgnores } from "eslint/config";

export default defineConfig([
  globalIgnores([
    // Build outputs and generated native projects.
    "**/dist/",
    "dist-*/",
    "**/build/",
    "**/.tsbuild/",
    "src-tauri/target/",
    "src-tauri/gen/",
    "android/.gradle/",
    "android/.cxx/",
    "android/capacitor-cordova-android-plugins/",
    "android/app/src/main/assets/",
    // Local data, caches, worktrees, and test reports.
    ".codegraph/",
    ".pnpm-store/",
    ".risuai/",
    ".tauri/",
    "**/.wrangler/",
    ".worktree/",
    "save/",
    "logs/",
    "coverage/",
    "test-results/",
    "playwright-report/",
    "blob-report/",
    "playwright/.cache/",
    "android-e2e/artifacts/",
    // External plugins and bundled third-party translation assets.
    "xplugin/",
    "src-others/",
    "public/assets/bergamot-translator-worker.js",
    "public/assets/translator-worker.js",
    "vite.config.*.timestamp-*",
  ]),
  {
    files: ["**/*.{js,mjs,cjs,ts,mts,cts}"],
    plugins: { js },
    extends: ["js/recommended"],
    languageOptions: { globals: { ...globals.browser, ...globals.node } },
    rules: {
      curly: ["error", "multi-line"],
    },
  },
  tseslint.configs.recommended,
]);
