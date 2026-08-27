import { expect, test, vi } from "vitest";

const parser = vi.hoisted(() =>
  vi.fn((text: string, arg?: any) =>
    text.replaceAll("{{char}}", arg?.chara?.name ?? "fallback"),
  ),
);

vi.mock("src/ts/parser/parser.svelte", () => ({ risuChatParser: parser }));
vi.mock("src/ts/storage/database.svelte", () => ({
  getDatabase: () => ({ strictJsonSchema: true, jsonSchema: "" }),
}));
vi.mock("src/ts/util", () => ({ jsonOutputTrimmer: (value: string) => value }));

import {
  convertInterfaceToSchema,
  extractJSON,
  getGeneralJSONSchema,
  getOpenAIJSONSchema,
} from "./jsonSchema";

const context = {
  chara: { name: "Target Character" } as never,
  chatTarget: { characterIndex: 2, chatIndex: 5 },
};

test("passes generation context into interface schema parsing", () => {
  const schema = convertInterfaceToSchema(
    'interface Result {\n  speaker: "{{char}}"\n}',
    context,
  );

  expect(schema.properties.speaker.const).toBe("Target Character");
  expect(parser).toHaveBeenCalledWith(expect.any(String), context);
});

test("preserves context through provider schema helpers", () => {
  const source = 'interface Result {\n  speaker: "{{char}}"\n}';
  expect(getOpenAIJSONSchema(source, context).schema.properties.speaker.const).toBe(
    "Target Character",
  );
  expect(
    getGeneralJSONSchema(source, ["$schema"], context).properties.speaker.const,
  ).toBe("Target Character");
});

test("uses generation context when extracting structured output", () => {
  const value = extractJSON(
    JSON.stringify({ "Target Character": "scoped-value" }),
    "{{char}}",
    context,
  );

  expect(value).toBe("scoped-value");
  expect(parser).toHaveBeenLastCalledWith("{{char}}", context);
});

test("extracts nested fields from already parsed objects", () => {
  expect(extractJSON({ result: { name: "ok" } }, "result.name", context)).toBe(
    "ok",
  );
});