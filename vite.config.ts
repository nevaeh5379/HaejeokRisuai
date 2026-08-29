import { existsSync, realpathSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { defineConfig, searchForWorkspaceRoot } from "vite";
import { svelte } from "@sveltejs/vite-plugin-svelte";
import wasm from "vite-plugin-wasm";
import strip from '@rollup/plugin-strip';
import tailwindcss from '@tailwindcss/vite'
import { resolveBuildVersion } from './tooling/build-version.mjs'

const localCommonJsPackages = ['chat-core', 'protocol', 'backup-core'] as const
const localCommonJsDependencies = localCommonJsPackages.flatMap((packageName) =>
  readdirSync(resolve(process.cwd(), `packages/${packageName}`))
    .filter((file) => file.endsWith('.cjs'))
    .map((file) => `@risuai/${packageName}/${file}`)
)

// https://vitejs.dev/config/
export default defineConfig(({command, mode}) => {
  const buildVersion = resolveBuildVersion()
  console.log(`[HaejeokRisuAI] Build version: ${buildVersion.buildTag} (${buildVersion.source})`)

  return {
    define: {
      'import.meta.env.VITE_HAEJEOK_BUILD_TAG': JSON.stringify(buildVersion.buildTag),
      'import.meta.env.VITE_HAEJEOK_BUILD_NUMBER': JSON.stringify(buildVersion.buildNumber ?? 0),
    },
    plugins: [
      svelte({
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
      // Inject globalThis.__NODE__ for local node-server development when VITE_NODE_SERVER is true
      {
        name: 'node-server-dev-inject',
        transformIndexHtml(html) {
          if (process.env.VITE_NODE_SERVER === 'true' || process.env.NODE_SERVER === 'true') {
            return html.replace(
              '<head>',
              '<head>\n    <script>globalThis.__NODE__ = true; globalThis.__RISU_LEGAL_CONFIGURED__ = true;</script>'
            );
          }
          return html;
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
      fs: {
        allow: [
          searchForWorkspaceRoot(process.cwd()),
          ...(existsSync(resolve(process.cwd(), 'node_modules'))
            ? [searchForWorkspaceRoot(realpathSync(resolve(process.cwd(), 'node_modules')))]
            : []),
        ],
      },
      // hmr: false,
      proxy: {
        '/api': {
          target: process.env.VITE_BACKEND_URL || 'http://127.0.0.1:6001',
          changeOrigin: true,
          ws: true,
        },
        '/proxy': {
          target: process.env.VITE_BACKEND_URL || 'http://127.0.0.1:6001',
          changeOrigin: true,
        },
        '/proxy2': {
          target: process.env.VITE_BACKEND_URL || 'http://127.0.0.1:6001',
          changeOrigin: true,
          ws: true,
        },
        '/hub-proxy': {
          target: process.env.VITE_BACKEND_URL || 'http://127.0.0.1:6001',
          changeOrigin: true,
        },
        '/v1': {
          target: process.env.VITE_BACKEND_URL || 'http://127.0.0.1:6001',
          changeOrigin: true,
        },
      },
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
      // Optional tokenizer/runtime bundles are intentionally shipped as large lazy chunks.
      // Warn only if a future chunk grows beyond the current expected ceiling.
      chunkSizeWarningLimit: 6000,
      // Keep the root state module out of Rolldown's large shared feature chunk.
      // Otherwise every lazy screen causes its parser/model dependencies to be
      // module-preloaded with the initial HTML through the shared stores chunk.
      rolldownOptions: {
        checks: {
          // Rolldown's relative plugin timing heuristic is noisy for known-heavy
          // Vite/WASM asset plugins and does not indicate a correctness issue.
          pluginTimings: false,
        },
        onLog(level, log, handler) {
          // These dynamic imports intentionally preserve lazy/circular-safe call
          // sites even though the target is also imported elsewhere in the app.
          if (log.code === 'INEFFECTIVE_DYNAMIC_IMPORT') return;

          // Several browser-oriented WASM libraries contain guarded Node paths.
          // Vite correctly replaces them with browser externals; the warning is
          // expected and preserving Vite's shim is safer than aliasing the APIs.
          if (log.message.includes('has been externalized for browser compatibility')) return;

          handler(level, log);
        },
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
                // Heavy runtimes used only by optional/lazy features. Keeping
                // them in the catch-all vendor chunk makes Rolldown preload
                // Lua, browser inference, transpilation, audio and tokenizer
                // code on the initial screen even when those features are idle.
                name: 'optional-runtime',
                test: /node_modules[\/](?:@dqbd[\/]tiktoken|sucrase|onnxruntime(?:-web|-common)?|@breezystack[\/]lamejs|sortablejs|wavefile|wasmoon|acorn(?:-walk)?|astring|peerjs|peerjs-js-binarypack|webrtc-adapter|sdp|diff|source-map|html-to-image|@huggingface[\/]jinja|@risuai[\/]ccardlib|svelte-awesome-color-picker|ts-interface-checker|svelte-awesome-slider|colord|@jridgewell[\/](?:trace-mapping|sourcemap-codec|resolve-uri|gen-mapping)|ollama)(?=[\/]|$)/,
                priority: 95,
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
                // FFmpeg.wasm — media conversion for the log exporter, lazy-loaded.
                name: 'ffmpeg',
                test: /node_modules[\\/]@ffmpeg[\\/]/,
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
      include: localCommonJsDependencies,
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
        '@risuai/chat-core':resolve(process.cwd(), 'packages/chat-core'),
        '@risuai/protocol':resolve(process.cwd(), 'packages/protocol'),
        '@risuai/backup-core':resolve(process.cwd(), 'packages/backup-core'),
      }
    },
    worker: {
      format: 'es',
      rolldownOptions: {
        checks: {
          pluginTimings: false,
        },
        onLog(level, log, handler) {
          if (log.message.includes('has been externalized for browser compatibility')) return;
          handler(level, log);
        },
      },
    }
}
});
