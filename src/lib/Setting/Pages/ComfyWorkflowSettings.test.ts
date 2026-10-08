import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { flushSync, mount, unmount } from "svelte";
import ComfyWorkflowSettings from "./ComfyWorkflowSettings.svelte";
import { settingsStore } from "src/ts/stores/domain/settingsStore.svelte";
import { fetchNative } from "src/ts/globalApi.svelte";
import { alertError } from "src/ts/alert";

vi.mock("src/ts/globalApi.svelte", () => ({ fetchNative: vi.fn() }));
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
  let target: HTMLDivElement;
  let instance: ReturnType<typeof mount>;
  beforeEach(() => {
    vi.clearAllMocks();
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
  });
  const button = (text: string) =>
    Array.from(target.querySelectorAll("button")).find((element) =>
      element.textContent?.includes(text),
    )!;

  it("shows the server load button even with an empty library and displays fetched workflows", async () => {
    vi.mocked(fetchNative).mockResolvedValue(
      new Response(JSON.stringify(["folder/example.json"])),
    );
    button("Load from ComfyUI").click();
    await vi.waitFor(() => {
      flushSync();
      expect(target.textContent).toContain("folder/example.json");
    });
    expect(fetchNative).toHaveBeenCalledWith(
      "http://localhost:8188/userdata?dir=workflows&recurse=true&split=false",
      expect.objectContaining({ method: "GET" }),
    );
    expect(alertError).not.toHaveBeenCalled();
    expect(target.textContent).not.toContain("user ID");
    expect(vi.mocked(fetchNative).mock.calls[0][1]).not.toHaveProperty(
      "headers",
    );
  });

  it("displays request errors inline instead of silently showing an empty list", async () => {
    vi.mocked(fetchNative).mockResolvedValue(
      new Response("Not found", { status: 404 }),
    );
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
    let complete!: (response: Response) => void;
    vi.mocked(fetchNative).mockImplementation(
      () =>
        new Promise((resolve) => {
          complete = resolve;
        }),
    );
    button("Load from ComfyUI").click();
    flushSync();
    expect(target.querySelector('[role="status"]')?.textContent).toContain(
      "Working",
    );
    complete(new Response("[]"));
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
    vi.mocked(fetchNative)
      .mockResolvedValueOnce(
        new Response(JSON.stringify(["folder/example.json"])),
      )
      .mockResolvedValueOnce(new Response(JSON.stringify(workflow)));
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
    expect(fetchNative).toHaveBeenLastCalledWith(
      "http://localhost:8188/userdata/workflows%2Ffolder%2Fexample.json",
      expect.objectContaining({ method: "GET" }),
    );
    expect(
      JSON.parse(settingsStore.state.comfyConfig.workflows![0].workflow),
    ).toEqual(workflow);
  });
});
