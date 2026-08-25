export type NanoGPTTransportApi = "chat" | "responses" | "messages" | "legacy";

export const NANOGPT_TRANSPORT_URLS: Readonly<{
  chat: Readonly<{ standard: string; subscription: string }>;
  responses: Readonly<{ standard: string; subscription: string }>;
  messages: Readonly<{ standard: string }>;
  legacy: Readonly<{ standard: string }>;
}>;

export function resolveNanoGPTTransportUrl(
  api: NanoGPTTransportApi,
  subscription?: boolean,
): string | null;
