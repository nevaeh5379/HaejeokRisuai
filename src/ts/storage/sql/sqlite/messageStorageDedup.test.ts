import { describe, expect, it } from "vitest";
import { createEmptySqlCommit } from "../sqlCommit";
import * as sqliteCommit from "@risuai/storage-sqlite/commit/apply";
import * as nodeCodec from "@risuai/storage-sqlite/schema/codec";
import { rebuildMessageRows } from "./sqliteStorageUtils";

describe("message SQL core/extension split", () => {
  it("does not duplicate normal message bodies into extension nodes", async () => {
    const body = "x".repeat(1024 * 1024);
    const commit = createEmptySqlCommit(0);
    commit.messages.push({
      id: "message-1",
      chatId: "chat-1",
      position: 0,
      data: {
        role: "char",
        data: body,
        name: "Bot",
        time: 123,
        generationInfo: {
          model: "model",
          inputTokens: 10,
          outputTokens: 20,
          generationId: "gen",
        },
        promptInfo: { promptName: "Prompt" },
      },
    });
    const statements: { sql: string; bind: unknown[] }[] = [];
    await sqliteCommit.apply(commit, async (sql, bind = []) => {
      statements.push({ sql, bind });
    });
    const messageInsert = statements.find(({ sql }) =>
      sql.includes("INSERT INTO messages"),
    );
    expect(messageInsert?.bind).toContain(body);
    const extensionStatements = statements.filter(({ sql }) =>
      sql.includes("message_extension_nodes"),
    );
    expect(extensionStatements.length).toBeGreaterThan(0);
    expect(
      extensionStatements.some(({ bind }) =>
        bind.some((value) => value === body),
      ),
    ).toBe(false);
  });

  it("rebuilds core fields when extension nodes only contain extras", () => {
    const extension = {
      promptInfo: { promptName: "Prompt" },
      generationInfo: { generationId: "gen-1", maxContext: 12345 },
      disabled: true,
    };
    const rows = nodeCodec.flatten(extension).map((node) => ({
      ...node,
      message_id: "message-1",
      message_role: "char",
      message_content_text: "hello",
      message_sender_name: "Bot",
      message_sent_time: 456,
      message_generation_model: "model-1",
      message_input_tokens: 12,
      message_output_tokens: 34,
    }));
    const [message] = rebuildMessageRows(rows);
    expect(message).toMatchObject({
      chatId: "message-1",
      role: "char",
      data: "hello",
      name: "Bot",
      time: 456,
      disabled: true,
      promptInfo: { promptName: "Prompt" },
      generationInfo: {
        generationId: "gen-1",
        maxContext: 12345,
        model: "model-1",
        inputTokens: 12,
        outputTokens: 34,
      },
    });
  });

  it("skips empty message metadata entirely during replace restore", async () => {
    const commit = createEmptySqlCommit(0, "replace-entities");
    commit.messages.push({
      id: "message-plain",
      chatId: "chat-1",
      position: 0,
      data: { role: "user", data: "plain body" },
    });
    const statements: { sql: string; bind: unknown[] }[] = [];
    await sqliteCommit.apply(commit, async (sql, bind = []) => {
      statements.push({ sql, bind });
    });
    expect(
      statements.filter((statement) =>
        statement.sql.includes("INSERT INTO messages"),
      ),
    ).toHaveLength(1);
    expect(
      statements.some((statement) =>
        statement.sql.includes("message_extension_nodes"),
      ),
    ).toBe(false);
  });
});
