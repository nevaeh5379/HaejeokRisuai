export interface LegacyBranchMigrationMessage {
  id: string;
  position: number;
  data: Record<string, unknown>;
}
export interface LegacyBranchMigrationLink {
  messageId: string;
  parentMessageId?: string;
  originBranchId: string;
}
export interface LegacyBranchMigrationBranch {
  id: string;
  parentBranchId?: string;
  forkMessageId?: string;
  headMessageId?: string;
  reason: "root" | "manual" | "reroll";
  createdAt: number;
  runtimeState: Record<string, unknown>;
}
export interface LegacyBranchMigrationPlan {
  chatId: string;
  activeBranchId: string;
  branches: LegacyBranchMigrationBranch[];
  messages: LegacyBranchMigrationMessage[];
  links: LegacyBranchMigrationLink[];
}
export function buildLegacyBranchMigrationPlan(chat: any, idFactory: () => string): LegacyBranchMigrationPlan | null;
export function materializeLegacyTimeline(chat: any, branch: any): any[];
