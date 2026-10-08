import { describe, expect, it } from "vitest";
import {
  convertComfyWorkflow,
  readApiWorkflow,
  type ObjectInfo,
} from "./comfyWorkflow";

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

describe("ComfyUI serialized graph conversion", () => {
  it("keeps API exports and prompt envelopes intact without object info", () => {
    const prompt = {
      "1": { class_type: "Source", inputs: { text: "{{risu_prompt}}" } },
    };
    expect(readApiWorkflow(prompt)).toBe(prompt);
    expect(convertComfyWorkflow({ prompt }, {})).toBe(prompt);
    expect(() => readApiWorkflow({ bad: {} })).toThrow("Invalid workflow");
  });

  it("maps widgets using object info, skips seed controls and restores links", () => {
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
    expect(convertComfyWorkflow(graph, info)["2"].inputs).toEqual({
      model: ["1", 0],
      seed: 42,
      steps: 20,
      sampler: "euler",
    });
    expect(convertComfyWorkflow(graph, info)["1"].inputs.text).toBe(
      "{{risu_prompt}}",
    );
  });

  it("supports named values and input_order", () => {
    const def: ObjectInfo = {
      Source: {
        input: { required: { first: ["STRING"], second: ["STRING"] } },
        input_order: { required: ["second", "first"] },
      },
    };
    expect(
      convertComfyWorkflow(
        {
          nodes: [{ id: 1, type: "Source", widgets_values: ["b", "a"] }],
          links: [],
        },
        def,
      )["1"].inputs,
    ).toEqual({ first: "a", second: "b" });
    expect(
      convertComfyWorkflow(
        {
          nodes: [
            { id: 1, type: "Source", widgets_values_named: { text: "hello" } },
          ],
          links: [],
        },
        info,
      )["1"].inputs.text,
    ).toBe("hello");
  });

  it("resolves reroutes and bypass nodes and omits muted nodes", () => {
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
    const api = convertComfyWorkflow(graph, info);
    expect(Object.keys(api)).toEqual(["1", "4"]);
    expect(api["4"].inputs.model).toEqual(["1", 0]);
  });

  it("resolves primitive values including arrays without turning arrays into connections", () => {
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
    expect(convertComfyWorkflow(graph, info)["2"].inputs.text).toEqual({
      __value__: [1, 2, 3],
    });
  });

  it("rejects missing definitions, missing links, custom widget layouts and cycles", () => {
    expect(() =>
      convertComfyWorkflow(
        { nodes: [{ id: 1, type: "Subgraph" }], links: [] },
        info,
      ),
    ).toThrow("Export (API)");
    expect(() =>
      convertComfyWorkflow(
        {
          nodes: [{ id: 1, type: "Source", widgets_values: ["a", "extra"] }],
          links: [],
        },
        info,
      ),
    ).toThrow("Export (API)");
    expect(() =>
      convertComfyWorkflow(
        {
          nodes: [
            { id: 1, type: "Sink", inputs: [{ name: "model", link: 99 }] },
          ],
          links: [],
        },
        info,
      ),
    ).toThrow("link 99");
    expect(() =>
      convertComfyWorkflow(
        {
          nodes: [
            { id: 1, type: "Reroute", inputs: [{ name: "in", link: 1 }] },
            { id: 2, type: "Sink", inputs: [{ name: "model", link: 1 }] },
          ],
          links: [[1, 1, 0, 2, 0, "MODEL"]],
        },
        info,
      ),
    ).toThrow("cyclic");
  });
});
