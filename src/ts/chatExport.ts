import { materializePortableBranchChat } from "@risuai/backup-core/portableBranches.cjs";
import { safeStructuredClone } from "./polyfill";
import type { Chat } from "./storage/database/schema";
import type { SqlChatBranchGraphData } from "./storage/sql/ISqlStorage";

export type ChatJsonExportMode = "compatible" | "native";

export function buildChatJsonExportData(
  chat: Chat,
  mode: ChatJsonExportMode,
  graph?: SqlChatBranchGraphData,
): Chat {
  const exportedChat = safeStructuredClone(chat);
  if (mode === "native") {
    if (!graph)
      throw new Error(
        "Persistent branch graph is required for native chat export",
      );
    return materializePortableBranchChat(exportedChat, graph) as Chat;
  }

  delete exportedChat.branch;
  delete exportedChat.branchState;
  delete exportedChat.activeBranchId;
  return exportedChat;
}
