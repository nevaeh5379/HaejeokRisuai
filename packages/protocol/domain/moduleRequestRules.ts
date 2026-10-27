export interface ModuleRequestRule {
  enabled: boolean;
  phrases: string[];
  sourceModuleId?: string;
  role?: "user" | "assistant" | "system";
  /** Optional advanced limit, counted from the end of the entire request. */
  lastMessages?: number;
  /** "any": match if any phrase matches (default). "all": all phrases in same message. "all_request": all phrases across entire request. */
  matchMode?: "any" | "all" | "all_request";
}
