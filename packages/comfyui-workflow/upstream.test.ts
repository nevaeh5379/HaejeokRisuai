import { describe, expect, it, vi } from "vitest";
import defaultWorkflow from "./fixtures/default.json";
import linkSeedWorkflow from "./fixtures/link-seed.json";
import nestedWorkflow from "./fixtures/nested-subgraph.json";
import { workflowToPrompt } from "./index";
import { WorkflowGraph } from "./src/graph";
import type { ObjectInfo, SerializedGraph } from "./src/types";
import { graphToPrompt } from "./src/executionUtil";
import { ExecutableNodeDTO } from "./src/executableNodeDTO";
import { InvalidLinkError, NullGraphError } from "./src/errors";
import { widgetValueStore } from "./src/widgetValueStore";

const info: ObjectInfo = {
  CheckpointLoaderSimple: {
    input: {
      required: { ckpt_name: [["v1-5-pruned-emaonly-fp16.safetensors"]] },
    },
  },
  CLIPTextEncode: { input: { required: { text: ["STRING"], clip: ["CLIP"] } } },
  EmptyLatentImage: {
    input: {
      required: { width: ["INT"], height: ["INT"], batch_size: ["INT"] },
    },
  },
  KSampler: {
    input: {
      required: {
        model: ["MODEL"],
        positive: ["CONDITIONING"],
        negative: ["CONDITIONING"],
        latent_image: ["LATENT"],
        seed: ["INT"],
        steps: ["INT"],
        cfg: ["FLOAT"],
        sampler_name: [["euler"]],
        scheduler: [["normal"]],
        denoise: ["FLOAT"],
      },
    },
  },
  VAEDecode: { input: { required: { samples: ["LATENT"], vae: ["VAE"] } } },
  SaveImage: {
    input: {
      required: {
        images: ["IMAGE"],
        filename_prefix: ["STRING", { default: "ComfyUI" }],
      },
    },
  },
};

describe("ComfyUI Export (API) runtime", () => {
  it("exports the upstream default workflow with the VAEDecode links intact", async () => {
    const output = await workflowToPrompt(defaultWorkflow, info);
    expect(output["8"]).toEqual({
      class_type: "VAEDecode",
      inputs: { samples: ["3", 0], vae: ["4", 2] },
      _meta: { title: "VAEDecode" },
    });
    expect(output["3"].inputs).toEqual({
      model: ["4", 0],
      positive: ["6", 0],
      negative: ["7", 0],
      latent_image: ["5", 0],
      seed: 156680208700286,
      steps: 20,
      cfg: 8,
      sampler_name: "euler",
      scheduler: "normal",
      denoise: 1,
    });
    expect(output["9"].inputs).toEqual({
      images: ["8", 0],
      filename_prefix: "ComfyUI",
    });
  });

  it("ignores extra saved widget values on backend-only nodes", async () => {
    const value = structuredClone(defaultWorkflow);
    const decode = value.nodes.find((node) => node.type === "VAEDecode")!;
    decode.widgets_values = [null, "preview"];

    const output = await workflowToPrompt(value, info);
    expect(output[String(decode.id)].inputs).toEqual({
      samples: ["3", 0],
      vae: ["4", 2],
    });
    expect(output["9"].inputs.images).toEqual([String(decode.id), 0]);
  });

  it("flattens the upstream subgraph and resolves its promoted seed", async () => {
    const output = await workflowToPrompt(linkSeedWorkflow, info);
    expect(output["10:3"].class_type).toBe("KSampler");
    expect(output["10:3"].inputs.seed).toBe(1);
    expect(output["10:3"].inputs.model).toEqual(["4", 0]);
    expect(output["8"].inputs.samples).toEqual(["10:3", 0]);
    expect(output).not.toHaveProperty("10");
  });

  it("exports nested upstream subgraphs without UUID class types", async () => {
    const output = await workflowToPrompt(nestedWorkflow, info);
    expect(
      Object.values(output).every((node) =>
        Object.hasOwn(info, node.class_type),
      ),
    ).toBe(true);
    expect(Object.keys(output).some((id) => id.split(":").length >= 3)).toBe(
      true,
    );
    expect(
      Object.values(output).find((node) => node.class_type === "VAEDecode")
        ?.inputs.samples,
    ).toBeDefined();
  });

  it("uses the original asynchronous widget serializer and API-only serialization flag", async () => {
    const graph = new WorkflowGraph(
      {
        nodes: [{ id: 1, type: "Text", widgets_values: ["saved"] }],
        links: [],
      },
      { Text: { input: { required: { text: ["STRING"] } } } },
    );
    graph.nodes[0].widgets[0].serializeValue = async () => ["runtime", "value"];
    graph.nodes[0].widgets.push({
      name: "preview",
      type: "string",
      value: "ignored",
      options: { serialize: false },
    });
    try {
      const { output, workflow } = await graphToPrompt(graph);
      expect(workflow).not.toHaveProperty("extra");
      expect(output["1"].inputs).toEqual({
        text: { __value__: ["runtime", "value"] },
      });
    } finally {
      graph.dispose();
    }
  });

  it("rejects a detached node with NullGraphError", () => {
    const graph = new WorkflowGraph(
      {
        nodes: [{ id: 1, type: "Text", widgets_values: ["saved"] }],
        links: [],
      },
      { Text: { input: { required: { text: ["STRING"] } } } },
    );
    try {
      const detached = Object.assign(Object.create(graph.nodes[0]), {
        graph: undefined,
      });
      expect(() => new ExecutableNodeDTO(detached, [], new Map())).toThrow(
        NullGraphError,
      );
    } finally {
      graph.dispose();
    }
  });

  it.each(["success", "conversion failure", "loading failure"])(
    "releases promoted widgets after %s",
    async (scenario) => {
      const value = structuredClone(linkSeedWorkflow) as SerializedGraph;
      if (scenario === "conversion failure") {
        value.nodes.find((node) => node.type === "VAEDecode")!.inputs![0].link =
          999999;
      } else if (scenario === "loading failure") {
        // The subgraph at the end of the fixture registers its promoted widget
        // before loading this additional node fails.
        value.nodes.push({ id: 11, type: "MissingBackend" });
      }
      const registrations = vi.spyOn(widgetValueStore, "setWidget");
      try {
        if (scenario === "success") {
          expect(
            (await workflowToPrompt(value, info))["10:3"].inputs.seed,
          ).toBe(1);
        } else if (scenario === "conversion failure") {
          await expect(workflowToPrompt(value, info)).rejects.toThrow(
            InvalidLinkError,
          );
        } else {
          await expect(workflowToPrompt(value, info)).rejects.toThrow(
            "/object_info",
          );
        }
        expect(registrations).toHaveBeenCalled();
        for (const [id] of registrations.mock.calls) {
          expect(widgetValueStore.getWidget(id)).toBeUndefined();
        }
      } finally {
        registrations.mockRestore();
      }
    },
  );

  it("keeps promoted widget values isolated across repeated conversions", async () => {
    for (const seed of [101, 202]) {
      const value = structuredClone(linkSeedWorkflow);
      value.nodes.find((node) => node.id === 10)!.widgets_values = [seed];
      const output = await workflowToPrompt(value, info);
      expect(output["10:3"].inputs.seed).toBe(seed);
    }
    expect(
      linkSeedWorkflow.nodes.find((node) => node.id === 10)!.widgets_values,
    ).toEqual([1]);
  });

  it("preserves supplied workflow metadata without adding a frontend version", async () => {
    const value = {
      nodes: [{ id: 1, type: "Text", widgets_values: ["saved"] }],
      links: [],
      extra: { custom: "kept" },
    };
    const graph = new WorkflowGraph(value, {
      Text: { input: { required: { text: ["STRING"] } } },
    });
    try {
      const { workflow } = await graphToPrompt(graph);
      expect(workflow.extra).toEqual({ custom: "kept" });
      expect(value.extra).toEqual({ custom: "kept" });
    } finally {
      graph.dispose();
    }
  });
});
