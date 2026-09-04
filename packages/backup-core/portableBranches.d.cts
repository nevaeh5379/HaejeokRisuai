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

export type PortableBranchGraphMap = Record<string, PortableBranchGraph>;
export const NATIVE_BRANCH_GRAPHS_KEY: "haejeokBranchGraphs";

export function portableBranchPath(
  graph: PortableBranchGraph,
  branchId: string,
): Array<Record<string, any> & { chatId?: string }>;

export function preparePortableChatForBranchRestore<
  T extends Record<string, any>,
>(sourceChat: T, graph: PortableBranchGraph): T;

export function loadPortableBranchGraphForExport(
  chatId: string,
  loadGraph: (chatId: string) => Promise<PortableBranchGraph>,
  loadBranchMessages: (
    chatId: string,
    branchId: string,
  ) => Promise<Array<Record<string, any> & { chatId?: string }>>,
): Promise<PortableBranchGraph>;

export function attachPortableDatabaseBranchGraphs<
  T extends Record<string, any>,
>(
  database: T,
  loadGraph: (
    chatId: string,
  ) => Promise<PortableBranchGraph | null | undefined>,
): Promise<T & { haejeokBranchGraphs?: PortableBranchGraphMap }>;

export function extractPortableDatabaseBranchGraphs<
  T extends Record<string, any>,
>(source: T): { database: T; branchGraphs: PortableBranchGraphMap };

export function preparePortableDatabaseForBranchRestore<
  T extends Record<string, any>,
>(source: T): { database: T; branchGraphs: PortableBranchGraphMap };

export function expandChatBranchGraphForCompatibility<
  T extends Record<string, any>,
>(
  source: T,
  graph: PortableBranchGraph,
  idFactory?: () => string,
): { chats: T[]; activeIndex: number };

export function expandPortableDatabaseBranchGraphsForCompatibility<
  T extends Record<string, any>,
>(source: T, idFactory?: () => string): T;
