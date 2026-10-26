"use strict";

/**
 * One `migrateLegacyBranchState()` for every vendor.
 *
 * The legacy `branchState` blob is planned by the shared
 * `buildLegacyBranchMigrationPlan`, and applying the plan is the same sequence
 * of deletes and inserts on every driver: only the statements differ, and the
 * dialect owns those. Two reads stay with the driver because they are single
 * vendor queries with no shared logic: the legacy state itself and the linear
 * message list.
 * 브랜치 마이그레이션 계획은 공용 모듈이 만들고, 적용 순서도 동일하므로 한 번만
 * 구현합니다. 방언별 단일 조회 두 개만 드라이버가 제공합니다.
 */

import type { SqlDialect } from "./sqlDialect.ts";
import { groupMessageRows } from "./sqlStorageCommon.ts";
import type {
  MessageAttributeRow,
  MessageGenerationRow,
  MessagePromptInfoRow,
  MessagePromptItemRow,
  MessagePromptToggleRow,
} from "./relationalRows.ts";
import { asRows } from "./relationalRows.ts";
import type { MessageSplit } from "./relationalRows.ts";
import {
  rebuildMessage,
  splitMessage,
} from "./postgres/postgresRelationalCodec.ts";
import {
  buildLegacyBranchMigrationPlan,
  type LegacyBranchMigrationPlan,
} from "../../../packages/protocol/legacyBranchMigration.ts";

/** Message child tables replaced together with the migrated messages. */
const MESSAGE_CHILD_TABLES = [
  "chat.message_attributes",
  "chat.message_generation",
  "chat.message_prompt_info",
  "chat.message_prompt_toggles",
  "chat.message_prompt_items",
] as const;

/** Driver-supplied reads that carry no shared logic. */
export type BranchMigrationOptions = {
  /** `branch_count` and the legacy `branchState` value of one chat. */
  readLegacyState: () => Promise<{
    branchCount: number;
    branchState: unknown;
  }>;
  /** Linear message list of the chat, in position order. */
  readLinearMessages: () => Promise<SqlRow[]>;
  /** Decodes the stored `branchState` value (Postgres wraps JSON scalars). */
  decodeState?: (value: unknown) => unknown;
  /** Generator for the ids of the synthesized branches. */
  newId: () => string;
};

type SqlRow = Record<string, unknown>;

/** Parses JSON text and passes everything else through unchanged. */
export function decodeLegacyBranchState(value: unknown): unknown {
  if (typeof value !== "string") return value;
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

/**
 * Applies the legacy branch-state migration for one chat.
 * Returns whether anything was migrated.
 */
export async function migrateLegacyBranchStateWith(
  dialect: SqlDialect,
  chatId: string,
  options: BranchMigrationOptions,
): Promise<boolean> {
  const legacy = await options.readLegacyState();
  if (legacy.branchCount > 1 || legacy.branchState == null) return false;

  const decode = options.decodeState ?? decodeLegacyBranchState;
  const branchState = decode(legacy.branchState) as {
    branches?: unknown;
  } | null;
  if (!Array.isArray(branchState?.branches)) return false;
  if (branchState.branches.length <= 1) return false;

  const messages = await options.readLinearMessages();
  const plan = buildLegacyBranchMigrationPlan(
    { id: chatId, message: messages, branchState },
    options.newId,
  );
  if (!plan) return false;

  await applyBranchMigrationPlan(dialect, chatId, plan);
  return true;
}

/** Writes one migration plan: replace the graph, then the messages. */
async function applyBranchMigrationPlan(
  dialect: SqlDialect,
  chatId: string,
  plan: LegacyBranchMigrationPlan,
): Promise<void> {
  await dialect.deleteByKeys("chat.active_branches", ["chat_id"], [[chatId]]);
  await dialect.deleteByKeys(
    "chat.message_branch_links",
    ["chat_id"],
    [[chatId]],
  );
  await dialect.deleteByKeys("chat.branches", ["chat_id"], [[chatId]]);

  const splitMessages: MessageSplit[] = plan.messages.map((message) =>
    splitMessage({
      chatId,
      id: message.id,
      position: message.position,
      data: message.data,
    }),
  );

  await dialect.upsertRows(
    "chat.messages",
    splitMessages.map((item) => item.core),
  );

  const messagePairs = splitMessages.map(
    (item) => [chatId, item.core.id] as const,
  );
  for (const table of MESSAGE_CHILD_TABLES) {
    await dialect.deleteByKeys(table, ["chat_id", "message_id"], messagePairs);
  }

  await dialect.insertRows(
    "chat.message_attributes",
    splitMessages.flatMap((item) =>
      item.attributes.map((row) => ({
        chat_id: item.core.chat_id,
        message_id: item.core.id,
        key: row.key,
        value: row.value,
      })),
    ),
  );
  await dialect.insertRows(
    "chat.message_generation",
    splitMessages.flatMap((item) =>
      item.generation
        ? [
            {
              chat_id: item.core.chat_id,
              message_id: item.core.id,
              model: item.generation.model,
              generation_id: item.generation.generation_id,
              input_tokens: item.generation.input_tokens,
              output_tokens: item.generation.output_tokens,
              max_context: item.generation.max_context,
              stage1_time: item.generation.stage1_time,
              stage2_time: item.generation.stage2_time,
              stage3_time: item.generation.stage3_time,
              stage4_time: item.generation.stage4_time,
            },
          ]
        : [],
    ),
  );
  await dialect.insertRows(
    "chat.message_prompt_info",
    splitMessages.flatMap((item) =>
      item.prompt?.info
        ? [
            {
              chat_id: item.core.chat_id,
              message_id: item.core.id,
              prompt_name: item.prompt.info.prompt_name,
            },
          ]
        : [],
    ),
  );
  await dialect.insertRows(
    "chat.message_prompt_toggles",
    splitMessages.flatMap((item) =>
      (item.prompt?.toggles || []).map((row) => ({
        chat_id: item.core.chat_id,
        message_id: item.core.id,
        position: row.position,
        toggle_key: row.toggle_key,
        toggle_value: row.toggle_value,
      })),
    ),
  );
  await dialect.insertRows(
    "chat.message_prompt_items",
    splitMessages.flatMap((item) =>
      (item.prompt?.items || []).map((row) => ({
        chat_id: item.core.chat_id,
        message_id: item.core.id,
        position: row.position,
        payload: row.payload,
      })),
    ),
  );

  await dialect.insertRows(
    "chat.branches",
    plan.branches.map((branch) => ({
      chat_id: chatId,
      id: branch.id,
      parent_branch_id: branch.parentBranchId ?? null,
      fork_message_id: branch.forkMessageId ?? null,
      head_message_id: branch.headMessageId ?? null,
      reason: branch.reason,
      created_at: branch.createdAt,
    })),
  );
  await dialect.insertRows(
    "chat.message_branch_links",
    plan.links.map((link) => ({
      chat_id: chatId,
      message_id: link.messageId,
      parent_message_id: link.parentMessageId ?? null,
      origin_branch_id: link.originBranchId,
    })),
  );
  await dialect.insertRows("chat.active_branches", [
    { chat_id: chatId, branch_id: plan.activeBranchId },
  ]);
}

/**
 * Rebuilds the linear message list of one chat from the six message tables.
 * The drivers use this as {@link BranchMigrationOptions.readLineMessages}.
 */
export function rebuildLinearMessages(rows: {
  messages: readonly SqlRow[];
  attributes: readonly SqlRow[];
  generations: readonly SqlRow[];
  promptInfos: readonly SqlRow[];
  promptToggles: readonly SqlRow[];
  promptItems: readonly SqlRow[];
}): SqlRow[] {
  const attributes = groupMessageRows(
    asRows<MessageAttributeRow>(rows.attributes),
  );
  const generations = new Map<string, MessageGenerationRow>(
    asRows<MessageGenerationRow>(rows.generations).map((row) => [
      `${row.chat_id}\0${row.message_id}`,
      row,
    ]),
  );
  const promptInfos = new Map<string, MessagePromptInfoRow>(
    asRows<MessagePromptInfoRow>(rows.promptInfos).map((row) => [
      `${row.chat_id}\0${row.message_id}`,
      row,
    ]),
  );
  const promptToggles = groupMessageRows(
    asRows<MessagePromptToggleRow>(rows.promptToggles),
  );
  const promptItems = groupMessageRows(
    asRows<MessagePromptItemRow>(rows.promptItems),
  );
  return rows.messages.map((row) => {
    const key = `${row.chat_id}\0${row.id}`;
    return rebuildMessage(row, {
      attributes: attributes.get(key),
      generation: generations.get(key),
      promptInfo: promptInfos.get(key),
      promptToggles: promptToggles.get(key),
      promptItems: promptItems.get(key),
    });
  });
}
