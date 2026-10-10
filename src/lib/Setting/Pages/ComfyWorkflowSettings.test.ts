import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { flushSync, mount, unmount } from "svelte";
import ComfyWorkflowSettings from "./ComfyWorkflowSettings.svelte";
import { settingsStore } from "src/ts/stores/domain/settingsStore.svelte";
import { globalFetch } from "src/ts/globalApi.svelte";
import { alertError } from "src/ts/alert";

type GlobalFetchResult = Awaited<ReturnType<typeof globalFetch>>;

vi.mock("src/ts/globalApi.svelte", () => ({ globalFetch: vi.fn() }));
vi.mock("src/ts/util", () => ({ selectSingleFile: vi.fn() }));
vi.mock("src/ts/alert", () => ({
  alertError: vi.fn(),
  alertNormal: vi.fn(),
  alertConfirm: vi.fn(),
}));
vi.mock(
  "src/lib/UI/GUI/TextAreaInput.svelte",
  async () => import("src/lib/UI/GUI/TextInput.svelte"),
);

describe("ComfyUI server workflow controls", () => {
  const jsonResponse = (
    data: unknown,
    status = 200,
  ): Awaited<ReturnType<typeof globalFetch>> => ({
    ok: status < 400,
    data,
    status,
    headers: {},
  });
  let target: HTMLDivElement;
  let instance: ReturnType<typeof mount>;
  beforeEach(() => {
    vi.resetAllMocks();
    settingsStore.init(
      {
        comfyUiUrl: "http://localhost:8188",
        comfyConfig: {
          workflow: "",
          workflows: [],
          selectedWorkflowId: "",
          timeout: 30,
          posNodeID: "",
          posInputName: "text",
          negNodeID: "",
          negInputName: "text",
        },
      },
      null,
    );
    target = document.createElement("div");
    document.body.appendChild(target);
    instance = mount(ComfyWorkflowSettings, { target });
    flushSync();
  });
  afterEach(async () => {
    await unmount(instance);
    settingsStore.dispose();
    target.remove();
    vi.useRealTimers();
  });
  const button = (text: string) =>
    Array.from(target.querySelectorAll("button")).find((element) =>
      element.textContent?.includes(text),
    )!;

  it("shows the server load button even with an empty library and displays fetched workflows", async () => {
    vi.mocked(globalFetch).mockResolvedValue(
      jsonResponse(["folder/example.json"]),
    );
    button("Load from ComfyUI").click();
    await vi.waitFor(() => {
      flushSync();
      expect(target.textContent).toContain("folder/example.json");
    });
    expect(globalFetch).toHaveBeenCalledWith(
      "http://localhost:8188/userdata?dir=workflows&recurse=true&split=false&full_info=true",
      expect.objectContaining({ method: "GET" }),
    );
    expect(alertError).not.toHaveBeenCalled();
    expect(target.textContent).not.toContain("user ID");
    expect(vi.mocked(globalFetch).mock.calls[0][1]).not.toHaveProperty(
      "headers",
    );
  });

  it.each([
    [
      "file-info objects",
      [{ path: "folder/example.json", size: 123, modified: 1000 }],
    ],
    ["split paths", [["folder/example.json", "folder", "example.json"]]],
  ])("loads and imports %s without rejecting the list", async (_name, list) => {
    const workflow = {
      "1": { class_type: "Text", inputs: { text: "prompt" } },
    };
    vi.mocked(globalFetch)
      .mockResolvedValueOnce(jsonResponse(list))
      .mockResolvedValueOnce(jsonResponse(workflow));
    button("Load from ComfyUI").click();
    await vi.waitFor(() => {
      flushSync();
      expect(target.textContent).toContain("folder/example.json");
    });
    expect(target.querySelector('[role="alert"]')).toBeNull();
    button("Import selected workflow").click();
    await vi.waitFor(() => {
      flushSync();
      expect(settingsStore.state.comfyConfig.workflows).toHaveLength(1);
    });
    expect(globalFetch).toHaveBeenLastCalledWith(
      "http://localhost:8188/userdata/workflows%2Ffolder%2Fexample.json",
      expect.objectContaining({ method: "GET" }),
    );
    expect(
      JSON.parse(settingsStore.state.comfyConfig.workflows[0].workflow),
    ).toEqual(workflow);
  });

  it("shows the received response shape when the server sends an invalid list", async () => {
    vi.mocked(globalFetch).mockResolvedValue(
      jsonResponse({ error: "Wrong endpoint" }),
    );
    button("Load from ComfyUI").click();
    await vi.waitFor(() => {
      flushSync();
      expect(target.querySelector('[role="alert"]')?.textContent).toContain(
        "object keys: error",
      );
    });
    expect(target.querySelector('[role="alert"]')?.textContent).toContain(
      "http://localhost:8188/userdata",
    );
    expect(button("Load from ComfyUI").disabled).toBe(false);
  });

  it("displays request errors inline instead of silently showing an empty list", async () => {
    vi.mocked(globalFetch).mockResolvedValue(jsonResponse("Not found", 404));
    button("Load from ComfyUI").click();
    await vi.waitFor(() => {
      flushSync();
      expect(target.querySelector('[role="alert"]')?.textContent).toContain(
        "HTTP 404",
      );
    });
    expect(target.textContent).not.toContain("No saved workflows");
    expect(button("Load from ComfyUI").disabled).toBe(false);
  });

  it("displays loading progress and explains a successful empty response", async () => {
    let complete!: (response: GlobalFetchResult) => void;
    vi.mocked(globalFetch).mockImplementation(
      () =>
        new Promise((resolve) => {
          complete = resolve;
        }),
    );
    button("Load from ComfyUI").click();
    flushSync();
    expect(target.querySelector('[role="status"]')?.textContent).toContain(
      "Loading workflow list",
    );
    complete(jsonResponse([]));
    await vi.waitFor(() => {
      flushSync();
      expect(target.textContent).toContain(
        "Save the workflow in ComfyUI first",
      );
    });
  });

  it("fetches the selected file and stores its API workflow", async () => {
    const workflow = {
      "1": { class_type: "Text", inputs: { text: "{{risu_prompt}}" } },
    };
    vi.mocked(globalFetch)
      .mockResolvedValueOnce(jsonResponse(["folder/example.json"]))
      .mockResolvedValueOnce(jsonResponse(workflow));
    button("Load from ComfyUI").click();
    await vi.waitFor(() => {
      flushSync();
      expect(button("Import selected workflow")).toBeDefined();
    });
    button("Import selected workflow").click();
    await vi.waitFor(() => {
      flushSync();
      expect(settingsStore.state.comfyConfig.workflows).toHaveLength(1);
    });
    expect(globalFetch).toHaveBeenLastCalledWith(
      "http://localhost:8188/userdata/workflows%2Ffolder%2Fexample.json",
      expect.objectContaining({ method: "GET" }),
    );
    expect(
      JSON.parse(settingsStore.state.comfyConfig.workflows![0].workflow),
    ).toEqual(workflow);
  });

  it("shows the download timeout, unlocks retry, and ignores a late response", async () => {
    let complete!: (response: GlobalFetchResult) => void;
    vi.mocked(globalFetch)
      .mockResolvedValueOnce(jsonResponse(["example.json"]))
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            complete = resolve;
          }),
      );
    button("Load from ComfyUI").click();
    await vi.waitFor(() => {
      flushSync();
      expect(button("Import selected workflow")).toBeDefined();
    });
    vi.useFakeTimers();
    button("Import selected workflow").click();
    flushSync();
    expect(target.querySelector('[role="status"]')?.textContent).toContain(
      "Downloading workflow JSON",
    );
    await vi.advanceTimersByTimeAsync(30_000);
    flushSync();
    expect(target.querySelector('[role="alert"]')?.textContent).toContain(
      "timed out after 30 seconds",
    );
    expect(target.querySelector('[role="alert"]')?.textContent).toContain(
      "Downloading workflow JSON",
    );
    expect(button("Import selected workflow").disabled).toBe(false);
    expect(vi.mocked(globalFetch).mock.calls[1][1]?.abortSignal?.aborted).toBe(
      true,
    );
    complete(jsonResponse({ "1": { class_type: "Text", inputs: {} } }));
    await vi.advanceTimersByTimeAsync(0);
    flushSync();
    expect(settingsStore.state.comfyConfig.workflows).toHaveLength(0);
  });

  it("imports a normal workflow through the upstream exporter and opens its JSON viewer", async () => {
    vi.mocked(globalFetch)
      .mockResolvedValueOnce(jsonResponse(["decode.json"]))
      .mockResolvedValueOnce(
        jsonResponse({
          nodes: [
            {
              id: 1,
              type: "CheckpointLoaderSimple",
              outputs: [{ type: "VAE" }],
            },
            { id: 2, type: "KSampler", outputs: [{ type: "LATENT" }] },
            {
              id: 18,
              type: "VAEDecode",
              widgets_values: [null],
              inputs: [
                { name: "vae", type: "VAE", link: 1 },
                { name: "samples", type: "LATENT", link: 2 },
              ],
            },
          ],
          links: [
            [1, 1, 0, 18, 0, "VAE"],
            [2, 2, 0, 18, 1, "LATENT"],
          ],
        }),
      )
      .mockResolvedValue(
        jsonResponse({
          CheckpointLoaderSimple: { input: {} },
          KSampler: { input: {} },
          VAEDecode: {
            input: { required: { vae: ["VAE"], samples: ["LATENT"] } },
          },
        }),
      );
    button("Load from ComfyUI").click();
    await vi.waitFor(() => {
      flushSync();
      expect(button("Import selected workflow")).toBeDefined();
    });
    button("Import selected workflow").click();
    await vi.waitFor(
      () => {
        flushSync();
        expect(settingsStore.state.comfyConfig.workflows).toHaveLength(1);
        expect(button("Edit JSON")).toBeDefined();
      },
      { timeout: 5_000 },
    );
    const api = JSON.parse(
      settingsStore.state.comfyConfig.workflows[0].workflow,
    );
    expect(api["18"].inputs).toEqual({ vae: ["1", 0], samples: ["2", 0] });
    expect(target.querySelector('[role="alert"]')).toBeNull();
    expect(button("Import selected workflow").disabled).toBe(false);
  });

  it("shows missing node definition errors and leaves the stored library unchanged", async () => {
    vi.mocked(globalFetch)
      .mockResolvedValueOnce(jsonResponse(["example.json"]))
      .mockResolvedValueOnce(
        jsonResponse({ nodes: [{ id: 1, type: "MissingNode" }], links: [] }),
      )
      .mockResolvedValueOnce(jsonResponse({}));
    button("Load from ComfyUI").click();
    await vi.waitFor(() => {
      flushSync();
      expect(button("Import selected workflow")).toBeDefined();
    });
    button("Import selected workflow").click();
    await vi.waitFor(() => {
      flushSync();
      expect(target.querySelector('[role="alert"]')?.textContent).toContain(
        "MissingNode",
      );
    });
    expect(target.querySelector('[role="alert"]')?.textContent).toContain(
      "Loading node definitions",
    );
    expect(button("Import selected workflow").disabled).toBe(false);
    expect(settingsStore.state.comfyConfig.workflows).toHaveLength(0);
  });

  it("shows the node-definition request phase and its HTTP failure", async () => {
    let complete!: (response: GlobalFetchResult) => void;
    vi.mocked(globalFetch)
      .mockResolvedValueOnce(jsonResponse(["example.json"]))
      .mockResolvedValueOnce(
        jsonResponse({ nodes: [{ id: 1, type: "Text" }], links: [] }),
      )
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            complete = resolve;
          }),
      );
    button("Load from ComfyUI").click();
    await vi.waitFor(() => {
      flushSync();
      expect(button("Import selected workflow")).toBeDefined();
    });
    button("Import selected workflow").click();
    await vi.waitFor(() => {
      flushSync();
      expect(target.querySelector('[role="status"]')?.textContent).toContain(
        "Loading node definitions",
      );
    });
    complete(jsonResponse("Node information unavailable", 500));
    await vi.waitFor(() => {
      flushSync();
      expect(target.querySelector('[role="alert"]')?.textContent).toContain(
        "Node information unavailable",
      );
    });
    expect(target.querySelector('[role="alert"]')?.textContent).toContain(
      "/object_info",
    );
    expect(button("Import selected workflow").disabled).toBe(false);
  });

  it("shows the node count, times out a stalled node, and ignores its late response", async () => {
    let complete!: (response: GlobalFetchResult) => void;
    vi.mocked(globalFetch)
      .mockResolvedValueOnce(jsonResponse(["example.json"]))
      .mockResolvedValueOnce(
        jsonResponse({ nodes: [{ id: 18, type: "VAEDecode" }], links: [] }),
      )
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            complete = resolve;
          }),
      );
    button("Load from ComfyUI").click();
    await vi.waitFor(() => {
      flushSync();
      expect(button("Import selected workflow")).toBeDefined();
    });
    vi.useFakeTimers();
    button("Import selected workflow").click();
    await vi.waitFor(() => {
      flushSync();
      expect(target.querySelector('[role="status"]')?.textContent).toContain(
        "Loading node definitions… (0/1)",
      );
    });
    expect(globalFetch).toHaveBeenLastCalledWith(
      "http://localhost:8188/object_info/VAEDecode",
      expect.objectContaining({ method: "GET" }),
    );
    await vi.advanceTimersByTimeAsync(30_000);
    flushSync();
    expect(target.querySelector('[role="alert"]')?.textContent).toContain(
      "VAEDecode",
    );
    expect(target.querySelector('[role="alert"]')?.textContent).toContain(
      "timed out after 30 seconds",
    );
    expect(button("Import selected workflow").disabled).toBe(false);
    complete(jsonResponse({ VAEDecode: { input: {} } }));
    await vi.advanceTimersByTimeAsync(0);
    flushSync();
    expect(settingsStore.state.comfyConfig.workflows).toHaveLength(0);
    expect(target.querySelector('[role="status"]')).toBeNull();
  });
});
