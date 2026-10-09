import { describe, expect, it } from "vitest";
import {
  convertComfyWorkflow,
  readApiWorkflow,
  type ObjectInfo,
} from "./comfyWorkflow";
import {
  InvalidLinkError,
  RecursionError,
} from "../../../packages/comfyui-workflow/src/errors";

const info: ObjectInfo = {
  Source: { input: { required: { text: ["STRING"] } } },
  Sampler: {
    input: {
      required: {
        model: ["MODEL"],
        seed: ["INT"],
        steps: ["INT"],
        sampler: [["euler", "dpm"]],
      },
    },
  },
  Sink: { input: { required: { model: ["MODEL"] } } },
};

describe("ComfyUI serialized graph conversion", async () => {
  it("keeps API exports and prompt envelopes intact without object info", async () => {
    const prompt = {
      "1": { class_type: "Source", inputs: { text: "{{risu_prompt}}" } },
    };
    expect(readApiWorkflow(prompt)).toBe(prompt);
    expect(await convertComfyWorkflow({ prompt }, {})).toBe(prompt);
    expect(() => readApiWorkflow({ bad: {} })).toThrow("Invalid workflow");
  });

  it("maps widgets using object info, skips seed controls and restores links", async () => {
    const graph = {
      nodes: [
        { id: 1, type: "Source", widgets_values: ["{{risu_prompt}}"] },
        {
          id: 2,
          type: "Sampler",
          widgets_values: [42, "randomize", 20, "euler"],
          inputs: [{ name: "model", link: 1 }],
        },
      ],
      links: [[1, 1, 0, 2, 0, "MODEL"]],
    };
    expect((await convertComfyWorkflow(graph, info))["2"].inputs).toEqual({
      model: ["1", 0],
      seed: 42,
      steps: 20,
      sampler: "euler",
    });
    expect((await convertComfyWorkflow(graph, info))["1"].inputs.text).toBe(
      "{{risu_prompt}}",
    );
  });

  it.each([false, true])(
    "keeps only the metadata title in API imports (envelope: %s) without changing the original",
    (envelope) => {
      const node = {
        class_type: "Source",
        inputs: { text: "hello", ver: "input-version" },
        _meta: {
          title: "Custom title",
          cnr_id: "comfy-core",
          ver: "0.3.0",
          aux_id: "owner/repo",
          future_metadata: "unused",
        },
      };
      const prompt = { "1": node };
      const result = readApiWorkflow(envelope ? { prompt } : prompt)!;
      expect(result["1"]._meta).toEqual({
        title: "Custom title",
      });
      expect(result["1"].inputs).toBe(node.inputs);
      expect(node._meta).toHaveProperty("cnr_id", "comfy-core");
      expect(node._meta).toHaveProperty("ver", "0.3.0");
    },
  );

  it("keeps only the title emitted by the upstream exporter", async () => {
    const api = await convertComfyWorkflow(
      {
        nodes: [
          {
            id: 1,
            type: "Source",
            title: "Custom title",
            widgets_values: ["hello"],
            properties: {
              cnr_id: "comfy-core",
              ver: "0.3.0",
              aux_id: "owner/repo",
            },
          },
        ],
        links: [],
      },
      info,
    );
    expect(api["1"]._meta).toEqual({ title: "Custom title" });
    expect(api["1"].inputs).toEqual({ text: "hello" });
  });

  it("supports named values and input_order", async () => {
    const def: ObjectInfo = {
      Source: {
        input: { required: { first: ["STRING"], second: ["STRING"] } },
        input_order: { required: ["second", "first"] },
      },
    };
    expect(
      (
        await convertComfyWorkflow(
          {
            nodes: [{ id: 1, type: "Source", widgets_values: ["b", "a"] }],
            links: [],
          },
          def,
        )
      )["1"].inputs,
    ).toEqual({ first: "a", second: "b" });
    expect(
      (
        await convertComfyWorkflow(
          {
            nodes: [
              {
                id: 1,
                type: "Source",
                widgets_values_named: { text: "hello" },
              },
            ],
            links: [],
          },
          info,
        )
      )["1"].inputs.text,
    ).toBe("hello");
  });

  it.each(["CUSTOM_OBJECT", "CUSTOM_LIST"])(
    "preserves %s widgets and subsequent values without treating sockets as widgets",
    async (type) => {
      const payload =
        type === "CUSTOM_OBJECT"
          ? {
              loras: [{ name: "style.safetensors", strength: 0.75 }],
              enabled: true,
            }
          : [{ name: "style.safetensors", strength: 0.75 }];
      const definitions: ObjectInfo = {
        Source: { input: {} },
        Custom: {
          input: {
            required: {
              model: ["MODEL"],
              loras: [type],
              strength: ["FLOAT"],
              optional_socket: ["ANY"],
            },
          },
        },
      };
      const graph = {
        nodes: [
          { id: 1, type: "Source", outputs: [{ type: "MODEL" }] },
          {
            id: 2,
            type: "Custom",
            widgets_values: [payload, 0.5],
            inputs: [
              { name: "model", type: "MODEL", link: 1 },
              { name: "loras", type, widget: { name: "loras" }, link: null },
              { name: "optional_socket", type: "ANY", link: null },
            ],
          },
        ],
        links: [[1, 1, 0, 2, 0, "MODEL"]],
      };
      const api = await convertComfyWorkflow(graph, definitions);
      expect(api["2"].inputs).toEqual({
        model: ["1", 0],
        loras: Array.isArray(payload) ? { __value__: payload } : payload,
        strength: 0.5,
      });
      expect(graph.nodes[1].widgets_values).toEqual([payload, 0.5]);
    },
  );

  it.each(["named", "positional"])(
    "preserves an unfamiliar widget with %s saved values and no widget socket",
    async (format) => {
      const payload = { items: [{ name: "style.safetensors", strength: 1 }] };
      const node = {
        id: 1,
        type: "Custom",
        ...(format === "named"
          ? { widgets_values_named: { loras: payload, text: "next" } }
          : { widgets_values: [payload, "next"] }),
      };
      const api = await convertComfyWorkflow(
        { nodes: [node], links: [] },
        {
          Custom: {
            input: { required: { loras: ["UNFAMILIAR"], text: ["STRING"] } },
          },
        },
      );
      expect(api["1"].inputs).toEqual({ loras: payload, text: "next" });
    },
  );

  it("resolves reroutes and bypass nodes and omits muted nodes", async () => {
    const graph = {
      nodes: [
        { id: 1, type: "Source", widgets_values: ["text"] },
        { id: 2, type: "Reroute", inputs: [{ name: "in", link: 1 }] },
        {
          id: 3,
          type: "Sink",
          mode: 4,
          inputs: [{ name: "model", type: "MODEL", link: 2 }],
          outputs: [{ type: "MODEL" }],
        },
        { id: 4, type: "Sink", inputs: [{ name: "model", link: 3 }] },
        { id: 5, type: "Unknown", mode: 2 },
      ],
      links: [
        [1, 1, 0, 2, 0, "MODEL"],
        [2, 2, 0, 3, 0, "MODEL"],
        [3, 3, 0, 4, 0, "MODEL"],
      ],
    };
    const api = await convertComfyWorkflow(graph, info);
    expect(Object.keys(api)).toEqual(["1", "4"]);
    expect(api["4"].inputs.model).toEqual(["1", 0]);
  });

  it("resolves primitive values including arrays without turning arrays into connections", async () => {
    const graph = {
      nodes: [
        { id: 1, type: "PrimitiveNode", widgets_values: [[1, 2, 3]] },
        {
          id: 2,
          type: "Source",
          widgets_values: [""],
          inputs: [{ name: "text", link: 1, widget: { name: "text" } }],
        },
      ],
      links: [[1, 1, 0, 2, 0, "STRING"]],
    };
    expect((await convertComfyWorkflow(graph, info))["2"].inputs.text).toEqual({
      __value__: [1, 2, 3],
    });
  });

  it("rejects missing backend definitions and invalid topology", async () => {
    await expect(
      convertComfyWorkflow(
        { nodes: [{ id: 1, type: "Missing" }], links: [] },
        info,
      ),
    ).rejects.toThrow("/object_info");
    const invalidLink = convertComfyWorkflow(
      {
        nodes: [{ id: 1, type: "Sink", inputs: [{ name: "model", link: 99 }] }],
        links: [],
      },
      info,
    );
    await expect(invalidLink).rejects.toThrow(InvalidLinkError);
    await expect(invalidLink).rejects.toThrow("No link found");
    const circular = convertComfyWorkflow(
      {
        nodes: [
          { id: 1, type: "Reroute", inputs: [{ name: "in", link: 1 }] },
          { id: 2, type: "Sink", inputs: [{ name: "model", link: 1 }] },
        ],
        links: [[1, 1, 0, 2, 0, "MODEL"]],
      },
      info,
    );
    await expect(circular).rejects.toThrow(RecursionError);
    await expect(circular).rejects.toThrow("Circular reference");
  });
});
