import { alertError } from "src/ts/alert";
import { importPlugin } from "../plugins.svelte";
import { sleep } from "src/ts/util";

export async function hotReloadPluginFiles() {
  const observerSupported = !("FileSystemObserver" in window);
  const showOpenFilePicker = (
    window as Window & {
      showOpenFilePicker?: (options?: {
        types?: Array<{
          description?: string;
          accept?: Record<string, string[]>;
        }>;
      }) => Promise<FileSystemFileHandle[]>;
    }
  ).showOpenFilePicker;

  if (typeof showOpenFilePicker !== "function") {
    alertError(
      "Your browser does not support the File System Access API, which is required for hot-reloading plugin files.",
    );
    return;
  }

  let fileHandle: FileSystemFileHandle;
  try {
    [fileHandle] = await showOpenFilePicker({
      types: [
        {
          description: "JavaScript or TypeScript Plugin File",
          accept: {
            "text/typescript": [".ts"],
            "application/javascript": [".js"],
          },
        },
      ],
    });
  } catch (error) {
    return;
  }

  let lastModified = 0;
  const callback = async () => {
    try {
      const file = await fileHandle.getFile();
      if (file.lastModified === lastModified) {
        return;
      }
      console.log("Detected change in plugin file, reloading...");
      lastModified = file.lastModified;
      const content = await file.text();
      await importPlugin(content, {
        isHotReload: true,
        isUpdate: true,
        isTypescript: file.name.endsWith(".ts"),
      });
    } catch (e) {
      console.error("Error reading file:", e);
    }
  };

  while (true) {
    await callback();
    await sleep(500);
  }
}
