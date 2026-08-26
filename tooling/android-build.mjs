import { build } from "vite";

process.env.VITE_RISU_LEGAL_CONFIGURED = "TRUE";
// Capacitor is the full RisuAI application with native storage, not the
// stripped-down Risu Lite build. Force this off even if the caller happens to
// have VITE_RISU_LITE set in their shell environment.
process.env.VITE_RISU_LITE = "FALSE";

await build({
  build: {
    outDir: "dist",
  },
});
