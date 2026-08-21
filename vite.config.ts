import { defineConfig } from "vite";
import { svelte, vitePreprocess } from "@sveltejs/vite-plugin-svelte";
import wasm from "vite-plugin-wasm";
import strip from '@rollup/plugin-strip';
import tailwindcss from '@tailwindcss/vite'
// https://vitejs.dev/config/
export default defineConfig(({command, mode}) => {
  return {
    plugins: [
      svelte({
        preprocess: vitePreprocess(),
        onwarn: (warning, handler) => {
          // disable a11y warnings
          if (warning.code.startsWith("a11y-")) return;
          handler(warning);
        },
      }),
      tailwindcss(),
      wasm(),
      // COOP/COEP headers required for OPFS-based SQLite WASM persistence
      {
        name: 'configure-coop-coep-headers',
        configureServer: (server) => {
          server.middlewares.use((_req, res, next) => {
            res.setHeader('Cross-Origin-Embedder-Policy', 'require-corp');
            res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
            next();
          });
        },
        configurePreviewServer: (server) => {
          server.middlewares.use((_req, res, next) => {
            res.setHeader('Cross-Origin-Embedder-Policy', 'require-corp');
            res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
            next();
          });
        },
      },
      command === 'build' ? strip({
        include: '**/*.(mjs|js|svelte|ts)'
      }) : null
    ],

    // Vite options tailored for Tauri development and only applied in `tauri dev` or `tauri build`
    // prevent vite from obscuring rust errors
    clearScreen: false,
    // tauri expects a fixed port, fail if that port is not available
    server: {
      host: '0.0.0.0', // listen on all addresses
      port: 5174,
      strictPort: true,
      // hmr: false,
    },
    // to make use of `TAURI_ENV_DEBUG` and other env variables
    // https://v2.tauri.app/reference/environment-variables/
    envPrefix: ["VITE_", "TAURI_"],
    build: {
      target:'baseline-widely-available',
      // don't minify for debug builds
      minify: process.env.TAURI_ENV_DEBUG === 'true' ? false : 'oxc',
      // produce sourcemaps for debug builds
      sourcemap: process.env.TAURI_ENV_DEBUG === 'true',
      chunkSizeWarningLimit: 2000,
      // Keep the root state module out of Rolldown's large shared feature chunk.
      // Otherwise every lazy screen causes its parser/model dependencies to be
      // module-preloaded with the initial HTML through the shared stores chunk.
      rolldownOptions: {
        output: {
          codeSplitting: {
            includeDependenciesRecursively: false,
            groups: [
              {
                name: 'app-state',
                test: /src[\\/]ts[\\/]stores\.svelte\.ts$/,
                priority: 100,
              },
              {
                // Lucide icons are shared by many lazy Svelte screens. Leaving
                // them to automatic splitting creates one sub-kilobyte request
                // per icon as soon as the first screens mount.
                name: 'lucide-icons',
                test: /node_modules[\\/]@lucide[\\/]svelte[\\/]dist[\\/]icons[\\/]/,
                priority: 90,
              },
              {
                // Monaco editor is large and only needed for code/script editing.
                // Group all monaco modules into a single chunk to avoid ~80
                // per-language worker requests on initial load.
                name: 'monaco',
                test: /node_modules[\\/]monaco-editor/,
                priority: 80,
              },
              {
                // highlight.js ships ~80 language definitions as separate
                // entry points; without grouping each becomes its own request.
                name: 'highlightjs',
                test: /node_modules[\\/]highlight\.js/,
                priority: 80,
              },
              {
                // PDF.js worker + viewer — large, only needed for PDF inlays.
                name: 'pdfjs',
                test: /node_modules[\\/]pdfjs-dist/,
                priority: 80,
              },
              {
                // SQLite WASM — only needed for OPFS-backed storage.
                name: 'sqlite',
                test: /node_modules[\\/]@sqlite\.org[\\/]sqlite-wasm/,
                priority: 80,
              },
              {
                // Hugging Face transformers — large model inference lib.
                name: 'transformers',
                test: /node_modules[\\/]@huggingface[\\/]transformers/,
                priority: 80,
              },
              {
                // Web LLM — large, only needed for in-browser LLM inference.
                name: 'webllm',
                test: /node_modules[\\/]@mlc-ai[\\/]web-llm/,
                priority: 80,
              },
              {
                // Three.js — 3D rendering, only used by visual novel mode.
                name: 'three',
                test: /node_modules[\\/]three/,
                priority: 80,
              },
              {
                // Bergamot translator — WASM-based translation, lazy-loaded.
                name: 'bergamot',
                test: /node_modules[\\/]@browsermt[\\/]bergamot-translator/,
                priority: 80,
              },
              {
                // Web tokenizers — large tokenizer data, lazy-loaded.
                name: 'tokenizers',
                test: /node_modules[\\/]@mlc-ai[\\/]web-tokenizers/,
                priority: 80,
              },
              {
                // Catch-all for remaining node_modules — consolidates the long
                // tail of small dependency chunks into a single vendor chunk.
                name: 'vendor',
                test: /node_modules/,
                priority: 1,
              },
            ]
          }
        }
      }
    },
    
    optimizeDeps:{
      exclude: [
        "@browsermt/bergamot-translator",
        "@sqlite.org/sqlite-wasm"
      ],
      needsInterop:[
        "@mlc-ai/web-tokenizers"
      ]
    },

    resolve:{
      alias:{
        'src':'/src',
      }
    },
    worker: {
      format: 'es'
    }
}
});
