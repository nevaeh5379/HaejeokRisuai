import { describe, expect, it, vi } from "vitest";
import {
  parseComfyWorkflowList,
  fetchComfyWorkflowObjectInfo,
} from "./comfyWorkflowRequest";

const url = "http://localhost:8188/userdata?dir=workflows&full_info=true";

describe("ComfyUI userdata workflow lists", () => {
  it.each([
    ["paths", ["folder/a.json", "readme.txt", "b.JSON"]],
    [
      "file info",
      [
        { path: "folder/a.json", size: 123, modified: 1000 },
        { path: "readme.txt", size: 20 },
        { path: "b.JSON" },
      ],
    ],
    [
      "split paths",
      [
        ["folder/a.json", "folder", "a.json"],
        ["readme.txt", "readme.txt"],
        ["b.JSON", "b.JSON"],
      ],
    ],
  ])("reads %s returned by the userdata API", (_name, value) => {
    expect(parseComfyWorkflowList(value, url)).toEqual([
      "b.JSON",
      "folder/a.json",
    ]);
  });

  it("normalizes Windows paths and removes duplicate entries", () => {
    expect(
      parseComfyWorkflowList(
        [{ path: "folder\\a.json" }, "folder/a.json"],
        url,
      ),
    ).toEqual(["folder/a.json"]);
    expect(parseComfyWorkflowList([], url)).toEqual([]);
  });

  it("includes the response shape and URL when the response is not a list", () => {
    expect(() =>
      parseComfyWorkflowList({ error: "Unexpected endpoint" }, url),
    ).toThrow("object keys: error");
    expect(() => parseComfyWorkflowList({ nodes: [], links: [] }, url)).toThrow(
      url,
    );
    expect(() => parseComfyWorkflowList([123], url)).toThrow("entry 0: number");
  });
});

describe("ComfyUI workflow node definitions", () => {
  const workflow = { nodes: [{ id: 18, type: "VAEDecode" }], links: [] };
  const decode = { input: { required: { samples: ["LATENT"], vae: ["VAE"] } } };
  const createUrl = (path: string) => `http://localhost:8188/api${path}`;

  it("loads only the required type without downloading the aggregate catalog", async () => {
    const getJson = vi
      .fn()
      .mockResolvedValue({ VAEDecode: decode, Unused: { input: {} } });
    expect(
      await fetchComfyWorkflowObjectInfo(workflow, getJson, createUrl),
    ).toEqual({ VAEDecode: decode });
    expect(getJson).toHaveBeenCalledTimes(1);
    expect(getJson).toHaveBeenCalledWith("/object_info/VAEDecode");
  });

  it.each([{}, [], { VAEDecode: { input: null } }])(
    "rejects missing or malformed node definitions (%j)",
    async (response) => {
      const getJson = vi.fn().mockResolvedValue(response);
      await expect(
        fetchComfyWorkflowObjectInfo(workflow, getJson, createUrl),
      ).rejects.toThrow("Node 18 (VAEDecode) has no valid definition");
      expect(getJson).toHaveBeenCalledTimes(1);
    },
  );

  it("includes the response shape and address when the node is absent", async () => {
    const getJson = vi.fn().mockResolvedValue({ error: "unexpected" });
    await expect(
      fetchComfyWorkflowObjectInfo(workflow, getJson, createUrl),
    ).rejects.toThrow(
      "Node 18 (VAEDecode) has no valid definition in ComfyUI.\nhttp://localhost:8188/api/object_info/VAEDecode\nReceived object keys: error",
    );
  });

  it("preserves the node identity and HTTP failure", async () => {
    const getJson = vi.fn().mockRejectedValue(new Error("ComfyUI HTTP 500"));
    await expect(
      fetchComfyWorkflowObjectInfo(workflow, getJson, createUrl),
    ).rejects.toThrow("Could not load node 18 (VAEDecode)");
  });

  it("collects backend types from active subgraphs and skips unused definitions and virtual nodes", async () => {
    const graph = {
      nodes: [
        { id: 1, type: "subgraph" },
        { id: 2, type: "Note" },
        { id: 3, type: "MissingMuted", mode: 2 },
      ],
      links: [],
      definitions: {
        subgraphs: [
          { id: "subgraph", nodes: [{ id: 18, type: "VAEDecode" }], links: [] },
          {
            id: "unused",
            nodes: [{ id: 19, type: "MissingUnused" }],
            links: [],
          },
        ],
      },
    };
    const getJson = vi.fn().mockResolvedValue({ VAEDecode: decode });
    expect(
      await fetchComfyWorkflowObjectInfo(graph, getJson, createUrl),
    ).toEqual({ VAEDecode: decode });
    expect(getJson).toHaveBeenCalledTimes(1);
  });

  it("skips requests when there are no backend nodes", async () => {
    const getJson = vi.fn();
    expect(
      await fetchComfyWorkflowObjectInfo(
        { nodes: [{ type: "Note" }] },
        getJson,
        createUrl,
      ),
    ).toEqual({});
    expect(getJson).not.toHaveBeenCalled();
  });

  it("deduplicates types, loads at most three concurrently, and reports completions", async () => {
    const graph = {
      nodes: ["A", "B", "C", "D", "A"].map((type, id) => ({ id, type })),
    };
    const complete = new Map<string, (value: unknown) => void>();
    const getJson = vi.fn(
      (path: string) =>
        new Promise<unknown>((resolve) => complete.set(path, resolve)),
    );
    const progress = vi.fn();
    const result = fetchComfyWorkflowObjectInfo(
      graph,
      getJson,
      createUrl,
      progress,
    );
    expect(getJson.mock.calls.map(([path]) => path)).toEqual([
      "/object_info/A",
      "/object_info/B",
      "/object_info/C",
    ]);
    expect(progress).toHaveBeenLastCalledWith(0, 4);
    complete.get("/object_info/B")!({ B: decode });
    await vi.waitFor(() => expect(getJson).toHaveBeenCalledTimes(4));
    expect(progress).toHaveBeenLastCalledWith(1, 4);
    for (const type of ["A", "C", "D"])
      complete.get(`/object_info/${type}`)!({ [type]: decode });
    expect(await result).toEqual({
      A: decode,
      B: decode,
      C: decode,
      D: decode,
    });
    expect(progress).toHaveBeenLastCalledWith(4, 4);
  });

  it("stops scheduling and reporting progress after an error", async () => {
    const graph = {
      nodes: ["A", "B", "C", "D"].map((type, id) => ({ id, type })),
    };
    let complete!: (value: unknown) => void;
    const getJson = vi
      .fn()
      .mockRejectedValueOnce(new Error("offline"))
      .mockImplementation(() => new Promise((resolve) => (complete = resolve)));
    const progress = vi.fn();
    await expect(
      fetchComfyWorkflowObjectInfo(graph, getJson, createUrl, progress),
    ).rejects.toThrow("offline");
    complete({ C: decode });
    await Promise.resolve();
    expect(getJson).toHaveBeenCalledTimes(3);
    expect(progress).toHaveBeenCalledTimes(1);
  });
});
