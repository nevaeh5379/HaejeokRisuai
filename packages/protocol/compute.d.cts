export const TOKENIZER_ENCODINGS: readonly ['cl100k_base', 'o200k_base'];
export type TokenizerEncoding = (typeof TOKENIZER_ENCODINGS)[number];

export const VECTOR_SEARCH_METRICS: readonly ['cosine', 'dot'];
export type VectorSearchMetric = (typeof VECTOR_SEARCH_METRICS)[number];

export interface TokenizeCountRequest {
  texts: string[];
  encoding: TokenizerEncoding;
}
export interface TokenizeCountResponse { counts: number[]; }

export interface LoreMessage {
  role: string;
  data: string;
  displayName?: string;
}
export interface LoreMatchRequestItem {
  keys: string[];
  searchDepth: number;
  regex: boolean;
  fullWordMatching: boolean;
  all?: boolean;
  dontSearchWhenRecursive?: boolean;
}
export interface LoreMatchLog {
  prompt: string;
  source: string;
  activated: string;
}
export interface LoreMatchResult {
  matched: boolean;
  logs: LoreMatchLog[];
}
export interface LoreMatchBatchRequest {
  messages: LoreMessage[];
  requests: LoreMatchRequestItem[];
  username: string;
  charName: string;
}
export interface LoreMatchBatchResponse { results: LoreMatchResult[]; }

export interface LoreResolveRequest {
  messages: LoreMessage[];
  entries: Array<Record<string, unknown>>;
  username: string;
  charName: string;
}
export interface LoreResolveResponse {
  activatedIndexes: number[];
  logs: LoreMatchLog[];
}

export interface VectorIndexDescriptor { id: string; signature: string; }
export interface VectorIndexEntry extends VectorIndexDescriptor { embedding: number[]; }
export interface VectorIndexStatusRequest {
  indexId: string;
  descriptors?: VectorIndexDescriptor[];
  revision?: string;
}
export interface VectorIndexStatusResponse {
  ready: boolean;
  missingIds: string[];
  size: number;
}
export interface VectorIndexUpsertRequest {
  indexId: string;
  entries: VectorIndexEntry[];
}
export interface VectorIndexUpsertResponse { size: number; }
export interface VectorIndexSearchRequest {
  indexId: string;
  queries: number[][];
  metric: VectorSearchMetric;
  topK?: number;
}
export type VectorIndexSearchResult = Array<Array<[string, number]>>;
export interface VectorIndexSearchResponse { results: VectorIndexSearchResult; }
