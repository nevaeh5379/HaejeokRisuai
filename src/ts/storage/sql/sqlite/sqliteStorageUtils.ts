export * from "@risuai/storage-sqlite/sqliteQueries";

import {
  decodedText,
  rebuildRelationalValue,
  type RelationalNodeRow,
} from "@risuai/storage-sqlite/relationalNodeCodec";
import type { Message } from "../../database/schema";

/**
 * Rebuilds Message objects from the batched message-row join (see
 * buildMessageRowsQuery). Mirrors the worker-side rebuild used by the web
 * backend so all backends produce identical message objects.
 */
export function rebuildMessageRows(rows: Record<string, unknown>[]): Message[] {
  const nodeGroups = new Map<string, RelationalNodeRow[]>();
  const coreRows = new Map<string, Record<string, unknown>>();
  const orderedIds: string[] = [];
  for (const row of rows) {
    const id = String(row.message_id);
    if (!coreRows.has(id)) {
      coreRows.set(id, row);
      orderedIds.push(id);
    }
    if (row.node_id === null || row.node_id === undefined) continue;
    const nodes = nodeGroups.get(id) ?? [];
    nodes.push(row as RelationalNodeRow);
    nodeGroups.set(id, nodes);
  }
  return orderedIds.map((id) => {
    const core = coreRows.get(id)!;
    const nodes = nodeGroups.get(id);
    const rebuilt = nodes?.length ? rebuildRelationalValue(nodes) : {};
    const message =
      rebuilt && typeof rebuilt === "object"
        ? (rebuilt as Message)
        : ({} as Message);

    // Core columns are authoritative. Newer writes omit these duplicated
    // fields from message_extension_nodes; older databases that still contain
    // them remain readable because the core values simply replace the copies.
    message.role = String(core.message_role ?? "char") as Message["role"];
    if (!Object.prototype.hasOwnProperty.call(message, "data")) {
      message.data = decodedText(
        core.message_content_text as string | null,
        core.message_content_encoded as string | null,
      );
    }
    if (core.message_sender_name != null) {
      message.name = String(core.message_sender_name);
    } else {
      delete message.name;
    }
    if (core.message_sent_time != null) {
      message.time = Number(core.message_sent_time);
    } else {
      delete message.time;
    }
    message.chatId = id;

    if (
      core.message_generation_model != null ||
      core.message_input_tokens != null ||
      core.message_output_tokens != null
    ) {
      message.generationInfo ??= {};
      if (core.message_generation_model != null) {
        message.generationInfo.model = String(core.message_generation_model);
      }
      if (core.message_input_tokens != null) {
        message.generationInfo.inputTokens = Number(core.message_input_tokens);
      }
      if (core.message_output_tokens != null) {
        message.generationInfo.outputTokens = Number(
          core.message_output_tokens,
        );
      }
    }
    return message;
  });
}

export function rebuildBranchGraphMessages(
  rows: Record<string, unknown>[],
): Message[] {
  const comments = new Map<string, boolean>();
  for (const row of rows) {
    if (row.graph_is_comment == null) continue;
    comments.set(String(row.message_id), Boolean(row.graph_is_comment));
  }
  const messages = rebuildMessageRows(rows);
  for (const message of messages) {
    if (message.chatId && comments.has(message.chatId)) {
      message.isComment = comments.get(message.chatId)!;
    }
  }
  return messages;
}
