export interface PortableBranchGraph {
  branches: Array<{
    id: string;
    chatId: string;
    parentBranchId?: string;
    forkMessageId?: string;
    headMessageId?: string;
    reason: "root" | "manual" | "reroll";
    createdAt: number;
  }>;
  activeBranchId?: string;
  messages: Array<Record<string, any> & { chatId?: string }>;
  links: Array<{
    messageId: string;
    parentMessageId?: string;
    originBranchId: string;
  }>;
}

export function materializePortableBranchChat<T extends Record<string, any>>(
  sourceChat: T,
  graph: PortableBranchGraph,
): T & { branchState?: Record<string, any>; activeBranchId?: string };

export function materializePortableDatabaseBranches<
  T extends Record<string, any>,
>(
  database: T,
  loadGraph: (
    chatId: string,
  ) => Promise<PortableBranchGraph | null | undefined>,
): Promise<T>;
