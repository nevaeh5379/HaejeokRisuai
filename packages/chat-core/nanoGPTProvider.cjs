'use strict';

const NANOGPT_TRANSPORT_URLS = Object.freeze({
  chat: Object.freeze({
    standard: 'https://nano-gpt.com/api/v1/chat/completions',
    subscription: 'https://nano-gpt.com/api/subscription/v1/chat/completions',
  }),
  responses: Object.freeze({
    standard: 'https://nano-gpt.com/api/v1/responses',
    subscription: 'https://nano-gpt.com/api/subscription/v1/responses',
  }),
  messages: Object.freeze({
    standard: 'https://nano-gpt.com/api/v1/messages',
  }),
  legacy: Object.freeze({
    standard: 'https://nano-gpt.com/api/v1/completions',
  }),
});

function resolveNanoGPTTransportUrl(api, subscription = false) {
  const endpoints = NANOGPT_TRANSPORT_URLS[api];
  if (!endpoints) return null;
  return subscription ? (endpoints.subscription ?? null) : endpoints.standard;
}

module.exports = { NANOGPT_TRANSPORT_URLS, resolveNanoGPTTransportUrl };
