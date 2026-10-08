import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import manifest from "./upstream.json";
import defaultWorkflow from "./fixtures/default.json";
import linkSeedWorkflow from "./fixtures/link-seed.json";
import nestedWorkflow from "./fixtures/nested-subgraph.json";
import { workflowToPrompt } from "./index";
import { WorkflowGraph, type ObjectInfo } from "./graph";
import { graphToPrompt } from "./upstream/src/utils/executionUtil";

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

describe("ComfyUI Export (API) upstream runtime", () => {
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

  it("does not reject backend-only nodes for saved preview widget values", async () => {
    const value = structuredClone(defaultWorkflow);
    const decode = value.nodes.find((node) => node.type === "VAEDecode")!;
    Object.assign(decode, { id: 18, widgets_values: [null, "preview"] });
    const saveLink = value.links.find((link) => link[1] === 8)!;
    saveLink[1] = 18;
    for (const link of value.links) if (link[3] === 8) link[3] = 18;
    const output = await workflowToPrompt(value, info);
    expect(output["18"].inputs).toEqual({ samples: ["3", 0], vae: ["4", 2] });
    expect(output["9"].inputs.images).toEqual(["18", 0]);
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
      const { output } = await graphToPrompt(graph);
      expect(output["1"].inputs).toEqual({
        text: { __value__: ["runtime", "value"] },
      });
    } finally {
      graph.dispose();
    }
  });
});
