import { describe, expect, it } from "vitest";
import { flattenRelationalValue } from "./relationalNodeCodec";
import { makeMessage } from "./sqliteTestFixtures";

/**
 * Premise check for the "generation" message load mode: message metadata
 * (promptInfo, generationInfo) is stored as relational node subtrees whose
 * root children carry the field name as a plaintext object_key, so a SQL
 * filter on object_key can exclude them without decoding anything.
 */
describe("message metadata storage layout", () => {
  it("stores promptInfo/generationInfo under plaintext root object keys", () => {
    const message = makeMessage("m1", "user", "hello", {
      time: 1234,
      generationInfo: { model: "test", inputTokens: 5 },
      promptInfo: {
        promptName: "p",
        promptToggles: [],
        promptText: [{ role: "system", content: "big prompt body" }],
      },
    });
    const rows = flattenRelationalValue(message);
    const rootChildren = rows.filter(
      (row) => row.node_id > 0 && row.parent_node_id === 0,
    );
    const keys = rootChildren
      .map((row) => row.object_key)
      .filter((key): key is string => key !== null);
    expect(keys).toContain("promptInfo");
    expect(keys).toContain("generationInfo");
    expect(keys).toContain("data");
    expect(keys).toContain("role");
    // The premise only holds if these keys are plaintext (object_key set,
    // object_key_encoded null). Keys with NUL or unpaired surrogates would be
    // base64-encoded and invisible to the SQL filter, but promptInfo and
    // generationInfo are fixed ASCII identifiers.
    const promptInfoRow = rootChildren.find((row) => row.object_key === "promptInfo");
    const generationInfoRow = rootChildren.find(
      (row) => row.object_key === "generationInfo",
    );
    expect(promptInfoRow?.object_key_encoded).toBeNull();
    expect(generationInfoRow?.object_key_encoded).toBeNull();
  });
});