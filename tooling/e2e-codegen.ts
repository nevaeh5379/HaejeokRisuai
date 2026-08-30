// Playwright codegen launcher.
//
// `playwright codegen` opens a browser, records your clicks/keyboard input
// and shows ready-to-paste TypeScript test code in the Playwright Inspector
// window next to it.
//
// Usage:
//   pnpm test:e2e:codegen
//   pnpm test:e2e:codegen http://127.0.0.1:5174/?mainpage=visited
//
// A Vite dev server on port 5174 is required while recording. If none is
// running, this script starts one (with VITE_RISU_LEGAL_CONFIGURED=TRUE, the
// same environment the test runner uses) and shuts it down again when you
// close the recorder window. If a server is already up, it is reused as-is.
import { spawn } from "node:child_process";
import net from "node:net";
import { URL } from "node:url";

const tag: string = "[HaejeokRisuAI][e2e-codegen]";
const baseURL: string = process.argv[2] ?? "http://127.0.0.1:5174";
const { hostname, port } = new URL(baseURL);

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/** Resolves once a TCP connection to hostname:port succeeds. */
function isServerUp(): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.connect({ host: hostname, port: Number(port) });
    socket.once("connect", () => {
      socket.destroy();
      resolve(true);
    });
    socket.once("error", () => {
      socket.destroy();
      resolve(false);
    });
  });
}

async function main(): Promise<void> {
  const alreadyRunning: boolean = await isServerUp();

  let devServer: ReturnType<typeof spawn> | undefined;
  if (alreadyRunning) {
    console.log(`${tag} Reusing dev server already running on port ${port}.`);
  } else {
    console.log(
      `${tag} No dev server on port ${port} — starting one (pnpm run dev).`,
    );
    devServer = spawn("pnpm", ["run", "dev"], {
      stdio: "inherit",
      // Same reason as in playwright.config.ts webServer.env: without this
      // the app shows the "Legal documents not configured" screen instead
      // of the real UI (see src/lib/Others/Legal.svelte).
      env: { ...process.env, VITE_RISU_LEGAL_CONFIGURED: "TRUE" },
    });

    const webServerTimeoutMs = 300_000;
    const startedAt = Date.now();
    while (!(await isServerUp())) {
      if (Date.now() - startedAt > webServerTimeoutMs) {
        console.error(`${tag} timed out waiting for the dev server.`);
        devServer.kill("SIGTERM");
        process.exit(1);
      }
      await sleep(500);
    }
  }

  console.log(
    `${tag} Opening the Playwright recorder — click around the app and copy the generated code into a new e2e/*.spec.ts file.`,
  );

  const codegen = spawn(
    "pnpm",
    ["exec", "playwright", "codegen", "--target", "javascript", baseURL],
    { stdio: "inherit" },
  );

  codegen.on("exit", (code) => {
    if (devServer) {
      console.log(
        `${tag} Recorder closed — stopping the dev server we started.`,
      );
      devServer.kill("SIGTERM");
    }
    process.exit(code ?? 0);
  });
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});