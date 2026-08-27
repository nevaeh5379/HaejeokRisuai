import { settingsStore } from "src/ts/stores/domain/settingsStore.svelte";
import { risuChatParser } from "src/ts/parser/parser.svelte";
import type { ChatExecutionTarget } from "src/ts/chatTarget";
import type { character, groupChat } from "../../storage/schema";

import { jsonOutputTrimmer } from "src/ts/util";

export type JSONSchemaParserContext = {
  chara?: character | groupChat;
  chatTarget?: ChatExecutionTarget;
};

export function convertInterfaceToSchema(
  int: string,
  context: JSONSchemaParserContext = {},
) {
  if (!int.startsWith("interface ") && !int.startsWith("export interface ")) {
    return JSON.parse(int);
  }

  int = risuChatParser(int, {
    chara: context.chara,
    chatTarget: context.chatTarget,
  });

  type SchemaProp = {
    type: "array" | "string" | "number" | "boolean";
    items?: SchemaProp;
    enum?: string[];
    const?: string;
  };

  const lines = int.split("\n");
  let schema = {
    $schema: "https://json-schema.org/draft/2020-12/schema",
    type: "object",
    additionalProperties: false,
    properties: {} as { [key: string]: SchemaProp },
    required: [] as string[],
  };
  for (let i = 1; i < lines.length; i++) {
    let content = lines[i].trim();
    if (content === "{") {
      continue;
    }
    if (content === "}") {
      continue;
    }
    if (content === "") {
      continue;
    }

    let placeHolders: string[] = [];

    content = content
      .replace(/\\"/gu, "\uE9b4a")
      .replace(/\\'/gu, "\uE9b4b")
      .replace(/"(.+?)"/gu, function (match, p1) {
        placeHolders.push(match);
        return `\uE9b4d${placeHolders.length - 1}`;
      })
      .replace(/'(.+?)'/gu, function (match, p1) {
        placeHolders.push(`"${p1}"`);
        return `\uE9b4d${placeHolders.length - 1}`;
      })

      .split("//")[0]
      .trim() //remove comments

      .replace(/((number)|(string)|(boolean))\[\]/gu, "Array<$1>");

    if (content.endsWith(",") || content.endsWith(";")) {
      content = content.slice(0, -1);
    }

    let spData = content.replace(/ /g, "").split(":");

    if (spData.length !== 2) {
      throw "SyntaxError Found";
    }

    let [property, typeData] = spData;

    switch (typeData) {
      case "string":
      case "number":
      case "boolean": {
        schema.properties[property] = {
          type: typeData,
        };
        break;
      }
      case "Array<string>":
      case "Array<number>":
      case "Array<boolean>": {
        const ogType = typeData.slice(6, -1);

        schema.properties[property] = {
          type: "array",
          items: {
            type: ogType as "string" | "number" | "boolean",
          },
        };
        break;
      }
      default: {
        const types = typeData.split("|");
        const strings: string[] = [];
        for (const t of types) {
          if (!t.startsWith("\uE9b4d")) {
            throw "Unsupported Type Detected";
          }
          const textIndex = t.replace("\uE9b4d", "");
          const text = placeHolders[parseInt(textIndex)];
          const textParsed = JSON.parse(
            text.replace(/\uE9b4a/gu, '\\"').replace(/\uE9b4b/gu, "\\'"),
          );
          strings.push(textParsed);
        }
        if (strings.length === 1) {
          schema.properties[property] = {
            type: "string",
            const: strings[0],
          };
        } else {
          schema.properties[property] = {
            type: "string",
            enum: strings,
          };
        }
      }
    }

    schema.required.push(property);
  }
  return schema;
}

export function getOpenAIJSONSchema(
  schema?: string,
  context: JSONSchemaParserContext = {},
) {
  const db = settingsStore.state;
  return {
    name: "format",
    strict: db.strictJsonSchema,
    schema: convertInterfaceToSchema(schema ?? db.jsonSchema, context),
  };
}

export function getGeneralJSONSchema(
  schema?: string,
  excludes: string[] = [],
  context: JSONSchemaParserContext = {},
) {
  const db = settingsStore.state;

  function process(data: any) {
    const keys = Object.keys(data);
    for (const key of keys) {
      if (excludes.includes(key)) {
        delete data[key];
      }
      if (typeof data[key] === "object") {
        data[key] = process(data[key]);
      }
    }
    return data;
  }

  const d = convertInterfaceToSchema(schema ?? db.jsonSchema, context);
  return process(d);
}

export function extractJSON(
  data: unknown,
  format: string,
  context: JSONSchemaParserContext = {},
): string {
  const extract = (value: any, path: string): string => {
    if (value === undefined || value === null) return "";
    const [head, ...tail] = path.split(".");
    const current = value[head];
    if (current === undefined) return "";
    if (tail.length === 0) return `${current ?? ""}`;
    return extract(current, tail.join("."));
  };

  try {
    format = risuChatParser(format, {
      chara: context.chara,
      chatTarget: context.chatTarget,
    });
    if (typeof data === "string") {
      const trimmed = data.trim();
      if (!trimmed.startsWith("{") && !trimmed.startsWith("[")) return data;
      data = JSON.parse(jsonOutputTrimmer(trimmed));
    }
    return extract(data, format);
  } catch (error) {
    return typeof data === "string" ? data : "";
  }
}
