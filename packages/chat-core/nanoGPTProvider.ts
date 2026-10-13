export type NanoGPTTransportApi = "chat" | "responses" | "messages" | "legacy";
("use strict");

const NANOGPT_TRANSPORT_URLS: Readonly<{
  chat: Readonly<{ standard: string; subscription: string }>;
  responses: Readonly<{ standard: string; subscription: string }>;
  messages: Readonly<{ standard: string }>;
  legacy: Readonly<{ standard: string }>;
}> = Object.freeze({
  chat: Object.freeze({
    standard: "https://nano-gpt.com/api/v1/chat/completions",
    subscription: "https://nano-gpt.com/api/subscription/v1/chat/completions",
  }),
  responses: Object.freeze({
    standard: "https://nano-gpt.com/api/v1/responses",
    subscription: "https://nano-gpt.com/api/subscription/v1/responses",
  }),
  messages: Object.freeze({
    standard: "https://nano-gpt.com/api/v1/messages",
  }),
  legacy: Object.freeze({
    standard: "https://nano-gpt.com/api/v1/completions",
  }),
});

function resolveNanoGPTTransportUrl(
  api: NanoGPTTransportApi,
  subscription?: boolean,
): string | null;
function resolveNanoGPTTransportUrl(api?: any, subscription: any = false): any {
  const endpoints: any = NANOGPT_TRANSPORT_URLS[api];
  if (!endpoints) return null;
  return subscription ? (endpoints.subscription ?? null) : endpoints.standard;
}

export { NANOGPT_TRANSPORT_URLS, resolveNanoGPTTransportUrl };
