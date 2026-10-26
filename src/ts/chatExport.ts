import type { Chat } from "./storage/database/schema";
import type { SqlChatBranchGraphData } from "./storage/sql/ISqlStorage";

export type ChatJsonExportMode = "compatible" | "native";

function cleanChatForExport(chat: Chat): Chat {
  const {
    branch: _branch,
    branchState: _branchState,
    activeBranchId: _activeBranchId,
    ...exported
  } = chat;
  return exported as Chat;
}

export function buildChatJsonExportPayload(
  chat: Chat,
  mode: ChatJsonExportMode,
  folders: unknown[],
  graph?: SqlChatBranchGraphData,
) {
  const exportedChat = cleanChatForExport(chat);
  if (mode === "native") {
    if (!graph) {
      throw new Error(
        "Persistent branch graph is required for native chat export",
      );
    }
    return {
      type: "haejeokChat" as const,
      ver: 1 as const,
      data: {
        chat: exportedChat,
        branchGraph: graph,
      },
      folders,
    };
  }
  return {
    type: "risuChat" as const,
    ver: 2 as const,
    data: exportedChat,
    folders,
  };
}
