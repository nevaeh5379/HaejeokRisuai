import type {
  ChatFailureResponse,
  ChatSuccessResponse,
} from "./types.cjs";

export const DEFAULT_MISTRAL_API_URL: string;

export interface MistralMessage {
  role: string;
  content: unknown;
}

export function formatMistralMessages<T extends MistralMessage>(
  messages: readonly T[],
): Array<{ role: string; content: any }>;

export function decodeMistralResponse(
  ok: boolean,
  data: any,
  httpErrorPrefix?: string,
): ChatSuccessResponse | ChatFailureResponse;
