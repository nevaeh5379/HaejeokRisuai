'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { LLM_FORMATS } = require('../../packages/protocol/modelFormat.cjs');
const { createNodeProviderExecutor } = require('./providerExecutor.cjs');

test('advertises only implemented provider formats and routes', () => {
  const executor = createNodeProviderExecutor();
  assert.equal(executor.supports(LLM_FORMATS.Echo), true);
  assert.equal(executor.supports(LLM_FORMATS.Mistral), true);
  assert.equal(executor.supports(LLM_FORMATS.OpenAICompatible), false);
  assert.deepEqual(
    [...executor.formats],
    [LLM_FORMATS.Echo, LLM_FORMATS.Mistral],
  );
  assert.deepEqual([...executor.routes], ['echo', 'openai']);
  assert.deepEqual(
    [...executor.transportFormats],
    [
      LLM_FORMATS.OpenAICompatible,
      LLM_FORMATS.OpenAIResponseAPI,
      LLM_FORMATS.OpenAILegacyInstruct,
      LLM_FORMATS.Anthropic,
      LLM_FORMATS.GoogleCloud,
      LLM_FORMATS.Cohere,
      LLM_FORMATS.NovelAI,
      LLM_FORMATS.NovelList,
      LLM_FORMATS.NanoGPT,
    ],
  );
  assert.equal(executor.supportsTransport(LLM_FORMATS.OpenAICompatible), true);
  assert.equal(executor.supportsTransport(LLM_FORMATS.OpenAIResponseAPI), true);
  assert.equal(executor.supportsTransport(LLM_FORMATS.OpenAILegacyInstruct), true);
  assert.equal(executor.supportsTransport(LLM_FORMATS.Anthropic), true);
  assert.equal(executor.supportsTransport(LLM_FORMATS.GoogleCloud), true);
  assert.equal(executor.supportsTransport(LLM_FORMATS.Cohere), true);
  assert.equal(executor.supportsTransport(LLM_FORMATS.NovelAI), true);
  assert.equal(executor.supportsTransport(LLM_FORMATS.NovelList), true);
  assert.equal(executor.supportsTransport(LLM_FORMATS.NanoGPT), true);
});


test('keeps Mistral support format-specific within the openai route', () => {
  const executor = createNodeProviderExecutor();
  assert.equal(executor.supports(LLM_FORMATS.Mistral), true);
  assert.equal(executor.supports(LLM_FORMATS.OpenAICompatible), false);
  assert.equal(executor.supports(LLM_FORMATS.NanoGPT), false);
});

test('executes echo through the shared provider route', async () => {
  const delays = [];
  const executor = createNodeProviderExecutor({
    sleep: async (delayMs) => { delays.push(delayMs); },
  });
  const result = await executor.execute({
    format: LLM_FORMATS.Echo,
    payload: { message: 'server echo', delayMs: 125 },
  });
  assert.deepEqual(result, {
    handled: true,
    response: { type: 'success', result: 'server echo' },
  });
  assert.deepEqual(delays, [125]);
});

test('executes Mistral through the official server transport', async () => {
  const calls = [];
  const controller = new AbortController();
  const executor = createNodeProviderExecutor({
    fetchImpl: async (url, options) => {
      calls.push({ url, options });
      return {
        ok: true,
        json: async () => ({ choices: [{ message: { content: 'server mistral' } }] }),
      };
    },
  });
  const result = await executor.execute({
    format: LLM_FORMATS.Mistral,
    payload: {
      body: { model: 'mistral-small', messages: [{ role: 'user', content: 'hello' }] },
      apiKey: 'secret-key',
      httpErrorPrefix: 'HTTP: ',
    },
  }, { signal: controller.signal });
  assert.deepEqual(result, {
    handled: true,
    response: { type: 'success', result: 'server mistral' },
  });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'https://api.mistral.ai/v1/chat/completions');
  assert.equal(calls[0].options.headers.authorization, 'Bearer secret-key');
  assert.equal(calls[0].options.signal, controller.signal);
  assert.equal(calls[0].options.redirect, 'error');
});

test('returns decoded Mistral HTTP failures without browser fallback', async () => {
  const executor = createNodeProviderExecutor({
    fetchImpl: async () => ({
      ok: false,
      json: async () => ({ error: { message: 'rate limited' } }),
    }),
  });
  const result = await executor.execute({
    format: LLM_FORMATS.Mistral,
    payload: { body: { model: 'm' }, apiKey: '', httpErrorPrefix: 'HTTP: ' },
  });
  assert.deepEqual(result.response, { type: 'fail', result: 'HTTP: rate limited' });
});

test('executes official OpenAI non-streaming transport without interpreting the response', async () => {
  const calls = [];
  const controller = new AbortController();
  const executor = createNodeProviderExecutor({
    fetchImpl: async (url, options) => {
      calls.push({ url, options });
      return {
        ok: true,
        status: 200,
        text: async () => JSON.stringify({
          choices: [{ message: { content: 'raw openai response' } }],
        }),
      };
    },
  });
  const result = await executor.executeTransport({
    format: LLM_FORMATS.OpenAICompatible,
    payload: {
      body: { model: 'gpt-test', messages: [{ role: 'user', content: 'hello' }] },
      headers: {
        Authorization: 'Bearer secret-key',
        'Content-Type': 'application/json',
        Host: 'evil.example',
        'Content-Length': '999',
        'risu-auth': 'internal-secret',
      },
    },
  }, { signal: controller.signal });
  assert.deepEqual(result, {
    handled: true,
    response: {
      ok: true,
      status: 200,
      data: { choices: [{ message: { content: 'raw openai response' } }] },
    },
  });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'https://api.openai.com/v1/chat/completions');
  assert.equal(calls[0].options.headers.Authorization, 'Bearer secret-key');
  assert.equal(calls[0].options.headers.Host, undefined);
  assert.equal(calls[0].options.headers['Content-Length'], undefined);
  assert.equal(calls[0].options.headers['risu-auth'], undefined);
  assert.equal(calls[0].options.signal, controller.signal);
  assert.equal(calls[0].options.redirect, 'error');
});

test('executes official OpenAI legacy completions transport without interpreting the response', async () => {
  const calls = [];
  const executor = createNodeProviderExecutor({
    fetchImpl: async (url, options) => {
      calls.push({ url, options });
      return {
        ok: true,
        status: 200,
        text: async () => JSON.stringify({ choices: [{ text: 'legacy response' }] }),
      };
    },
  });
  const result = await executor.executeTransport({
    format: LLM_FORMATS.OpenAILegacyInstruct,
    payload: {
      body: { model: 'gpt-3.5-turbo-instruct', prompt: 'hello' },
      headers: { Authorization: 'Bearer openai-key', Host: 'evil.example' },
    },
  });
  assert.equal(result.handled, true);
  assert.equal(result.response.ok, true);
  assert.deepEqual(result.response.data, { choices: [{ text: 'legacy response' }] });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'https://api.openai.com/v1/completions');
  assert.equal(calls[0].options.headers.Authorization, 'Bearer openai-key');
  assert.equal(calls[0].options.headers.Host, undefined);
  assert.equal(calls[0].options.redirect, 'error');
});

test('executes official OpenAI Responses non-streaming transport without interpreting the response', async () => {
  const calls = [];
  const controller = new AbortController();
  const executor = createNodeProviderExecutor({
    fetchImpl: async (url, options) => {
      calls.push({ url, options });
      return {
        ok: true,
        status: 200,
        text: async () => JSON.stringify({
          status: 'completed',
          output: [{ type: 'message', content: [{ type: 'output_text', text: 'raw response' }] }],
        }),
      };
    },
  });
  const result = await executor.executeTransport({
    format: LLM_FORMATS.OpenAIResponseAPI,
    payload: {
      body: { model: 'gpt-test', input: [{ role: 'user', content: 'hello' }] },
      headers: {
        Authorization: 'Bearer secret-key',
        'Content-Type': 'application/json',
        Host: 'evil.example',
      },
    },
  }, { signal: controller.signal });
  assert.equal(result.handled, true);
  assert.equal(result.response.ok, true);
  assert.equal(result.response.status, 200);
  assert.equal(result.response.data.status, 'completed');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'https://api.openai.com/v1/responses');
  assert.equal(calls[0].options.headers.Authorization, 'Bearer secret-key');
  assert.equal(calls[0].options.headers.Host, undefined);
  assert.equal(calls[0].options.signal, controller.signal);
  assert.equal(calls[0].options.redirect, 'error');
});

test('executes official Anthropic non-streaming transport without interpreting the response', async () => {
  const calls = [];
  const controller = new AbortController();
  const executor = createNodeProviderExecutor({
    fetchImpl: async (url, options) => {
      calls.push({ url, options });
      return {
        ok: true,
        status: 200,
        text: async () => JSON.stringify({
          content: [{ type: 'text', text: 'raw anthropic response' }],
        }),
      };
    },
  });
  const result = await executor.executeTransport({
    format: LLM_FORMATS.Anthropic,
    payload: {
      body: { model: 'claude-test', messages: [{ role: 'user', content: 'hello' }] },
      headers: {
        'x-api-key': 'secret-key',
        'anthropic-version': '2023-06-01',
        'anthropic-dangerous-direct-browser-access': 'true',
      },
    },
  }, { signal: controller.signal });
  assert.deepEqual(result, {
    handled: true,
    response: {
      ok: true,
      status: 200,
      data: { content: [{ type: 'text', text: 'raw anthropic response' }] },
    },
  });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'https://api.anthropic.com/v1/messages');
  assert.equal(calls[0].options.headers['x-api-key'], 'secret-key');
  assert.equal(calls[0].options.headers['anthropic-version'], '2023-06-01');
  assert.equal(calls[0].options.headers['anthropic-dangerous-direct-browser-access'], undefined);
  assert.equal(calls[0].options.signal, controller.signal);
  assert.equal(calls[0].options.redirect, 'error');
});

test('executes official Google Gemini non-streaming transport with a pinned endpoint', async () => {
  const calls = [];
  const controller = new AbortController();
  const executor = createNodeProviderExecutor({
    fetchImpl: async (url, options) => {
      calls.push({ url, options });
      return {
        ok: true,
        status: 200,
        text: async () => JSON.stringify({
          candidates: [{ content: { parts: [{ text: 'raw gemini response' }] } }],
        }),
      };
    },
  });
  const result = await executor.executeTransport({
    format: LLM_FORMATS.GoogleCloud,
    payload: {
      modelId: 'gemini-3.7-flash',
      apiKey: 'google-key',
      body: { contents: [{ role: 'user', parts: [{ text: 'hello' }] }] },
      headers: { 'Content-Type': 'application/json', Host: 'evil.example' },
    },
  }, { signal: controller.signal });
  assert.equal(result.handled, true);
  assert.equal(result.response.ok, true);
  assert.equal(
    calls[0].url,
    'https://generativelanguage.googleapis.com/v1beta/models/gemini-3.7-flash:generateContent?key=google-key',
  );
  assert.equal(calls[0].options.headers.Host, undefined);
  assert.equal(calls[0].options.signal, controller.signal);
  assert.equal(calls[0].options.redirect, 'error');
});

test('rejects unsafe Google model identifiers before fetch', async () => {
  const executor = createNodeProviderExecutor({
    fetchImpl: async () => {
      throw new Error('fetch should not run');
    },
  });
  await assert.rejects(
    executor.executeTransport({
      format: LLM_FORMATS.GoogleCloud,
      payload: {
        modelId: '../evil',
        apiKey: 'google-key',
        body: { contents: [] },
        headers: { 'Content-Type': 'application/json' },
      },
    }),
    /safe model identifier/,
  );
});

test('executes official Cohere non-streaming transport without interpreting the response', async () => {
  const calls = [];
  const executor = createNodeProviderExecutor({
    fetchImpl: async (url, options) => {
      calls.push({ url, options });
      return {
        ok: true,
        status: 200,
        text: async () => JSON.stringify({ text: 'raw cohere response' }),
      };
    },
  });
  const result = await executor.executeTransport({
    format: LLM_FORMATS.Cohere,
    payload: {
      body: { message: 'hello', chat_history: [] },
      headers: { Authorization: 'Bearer cohere-key', 'Content-Type': 'application/json' },
    },
  });
  assert.equal(result.handled, true);
  assert.equal(result.response.ok, true);
  assert.deepEqual(result.response.data, { text: 'raw cohere response' });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'https://api.cohere.com/v1/chat');
  assert.equal(calls[0].options.headers.Authorization, 'Bearer cohere-key');
  assert.equal(calls[0].options.redirect, 'error');
});

test('executes official NovelAI variants through pinned server endpoints', async () => {
  const calls = [];
  const executor = createNodeProviderExecutor({
    fetchImpl: async (url, options) => {
      calls.push({ url, options });
      return {
        ok: true,
        status: 200,
        text: async () => JSON.stringify({ output: 'raw novelai response' }),
      };
    },
  });

  for (const [variant, expectedUrl] of [
    ['kayra', 'https://text.novelai.net/ai/generate'],
    ['clio', 'https://api.novelai.net/ai/generate'],
  ]) {
    const result = await executor.executeTransport({
      format: LLM_FORMATS.NovelAI,
      payload: {
        variant,
        body: { input: 'hello', model: `${variant}-v1`, parameters: {} },
        headers: { Authorization: 'Bearer novelai-key', Host: 'evil.example' },
      },
    });
    assert.equal(result.handled, true);
    assert.equal(result.response.ok, true);
    assert.deepEqual(result.response.data, { output: 'raw novelai response' });
    assert.equal(calls.at(-1).url, expectedUrl);
    assert.equal(calls.at(-1).options.headers.Authorization, 'Bearer novelai-key');
    assert.equal(calls.at(-1).options.headers.Host, undefined);
    assert.equal(calls.at(-1).options.redirect, 'error');
  }
});

test('rejects unknown NovelAI transport variants before fetch', async () => {
  let called = false;
  const executor = createNodeProviderExecutor({
    fetchImpl: async () => {
      called = true;
      throw new Error('fetch should not run');
    },
  });
  await assert.rejects(
    executor.executeTransport({
      format: LLM_FORMATS.NovelAI,
      payload: {
        variant: 'custom',
        body: { input: 'hello' },
        headers: { Authorization: 'Bearer novelai-key' },
      },
    }),
    /variant must be kayra or clio/,
  );
  assert.equal(called, false);
});

test('executes the default NovelList transport through its pinned endpoint', async () => {
  const calls = [];
  const executor = createNodeProviderExecutor({
    fetchImpl: async (url, options) => {
      calls.push({ url, options });
      return {
        ok: true,
        status: 200,
        text: async () => JSON.stringify({ data: ['raw novellist response'] }),
      };
    },
  });
  const result = await executor.executeTransport({
    format: LLM_FORMATS.NovelList,
    payload: {
      body: { text: 'hello', model: 'supertrin' },
      headers: { Authorization: 'Bearer novellist-key', Host: 'evil.example' },
    },
  });
  assert.equal(result.handled, true);
  assert.equal(result.response.ok, true);
  assert.deepEqual(result.response.data, { data: ['raw novellist response'] });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'https://api.tringpt.com//api');
  assert.equal(calls[0].options.headers.Authorization, 'Bearer novellist-key');
  assert.equal(calls[0].options.headers.Host, undefined);
  assert.equal(calls[0].options.redirect, 'error');
});

test('executes NanoGPT chat and Responses transports through pinned endpoints', async () => {
  const calls = [];
  const executor = createNodeProviderExecutor({
    fetchImpl: async (url, options) => {
      calls.push({ url, options });
      return {
        ok: true,
        status: 200,
        text: async () => JSON.stringify({ choices: [{ message: { content: 'nano' } }] }),
      };
    },
  });
  const cases = [
    ['chat', false, 'https://nano-gpt.com/api/v1/chat/completions'],
    ['chat', true, 'https://nano-gpt.com/api/subscription/v1/chat/completions'],
    ['responses', false, 'https://nano-gpt.com/api/v1/responses'],
    ['responses', true, 'https://nano-gpt.com/api/subscription/v1/responses'],
  ];
  for (const [api, subscription, expectedUrl] of cases) {
    const result = await executor.executeTransport({
      format: LLM_FORMATS.NanoGPT,
      payload: {
        api,
        subscription,
        body: { model: 'nano-model' },
        headers: { Authorization: 'Bearer nano-key', Host: 'evil.example' },
      },
    });
    assert.equal(result.handled, true);
    assert.equal(result.response.ok, true);
    assert.equal(calls.at(-1).url, expectedUrl);
    assert.equal(calls.at(-1).options.headers.Authorization, 'Bearer nano-key');
    assert.equal(calls.at(-1).options.headers.Host, undefined);
    assert.equal(calls.at(-1).options.redirect, 'error');
  }
});

test('rejects malformed NanoGPT transport selectors before fetch', async () => {
  let called = false;
  const executor = createNodeProviderExecutor({
    fetchImpl: async () => {
      called = true;
      throw new Error('fetch should not run');
    },
  });
  await assert.rejects(
    executor.executeTransport({
      format: LLM_FORMATS.NanoGPT,
      payload: { api: 'custom', subscription: false, body: {}, headers: {} },
    }),
    /api must be chat or responses/,
  );
  await assert.rejects(
    executor.executeTransport({
      format: LLM_FORMATS.NanoGPT,
      payload: { api: 'chat', subscription: 'yes', body: {}, headers: {} },
    }),
    /subscription must be a boolean/,
  );
  assert.equal(called, false);
});

test('returns raw OpenAI error payloads to the browser interpreter', async () => {
  const executor = createNodeProviderExecutor({
    fetchImpl: async () => ({
      ok: false,
      status: 429,
      text: async () => JSON.stringify({ error: { message: 'rate limited' } }),
    }),
  });
  const result = await executor.executeTransport({
    format: LLM_FORMATS.OpenAICompatible,
    payload: {
      body: { model: 'gpt-test' },
      headers: { Authorization: 'Bearer key' },
    },
  });
  assert.deepEqual(result, {
    handled: true,
    response: {
      ok: false,
      status: 429,
      data: { error: { message: 'rate limited' } },
    },
  });
});

test('does not expose raw transport for unsupported NanoGPT variants yet', async () => {
  const executor = createNodeProviderExecutor();
  assert.deepEqual(await executor.executeTransport({
    format: LLM_FORMATS.NanoGPTMessages,
    payload: { body: {}, headers: {} },
  }), { handled: false });
});

test('rejects malformed OpenAI transport payloads before fetch', async () => {
  let called = false;
  const executor = createNodeProviderExecutor({
    fetchImpl: async () => {
      called = true;
      throw new Error('should not fetch');
    },
  });
  await assert.rejects(
    executor.executeTransport({
      format: LLM_FORMATS.OpenAICompatible,
      payload: { body: [], headers: {} },
    }),
    /openai body must be an object/,
  );
  assert.equal(called, false);
});

test('returns unhandled for unsupported provider formats', async () => {
  const executor = createNodeProviderExecutor();
  assert.deepEqual(await executor.execute({
    format: LLM_FORMATS.OpenAICompatible,
    payload: {},
  }), { handled: false });
});

test('rejects malformed echo payloads', async () => {
  const executor = createNodeProviderExecutor();
  await assert.rejects(
    executor.execute({
      format: LLM_FORMATS.Echo,
      payload: { message: 123 },
    }),
    /echo message must be a string/,
  );
});

test('rejects malformed Mistral payloads before fetch', async () => {
  let called = false;
  const executor = createNodeProviderExecutor({
    fetchImpl: async () => {
      called = true;
      throw new Error('should not fetch');
    },
  });
  await assert.rejects(
    executor.execute({
      format: LLM_FORMATS.Mistral,
      payload: { body: [], apiKey: 'key' },
    }),
    /mistral body must be an object/,
  );
  assert.equal(called, false);
});

test('rejects malformed provider execution requests', async () => {
  const executor = createNodeProviderExecutor();
  await assert.rejects(
    executor.execute({ format: 'echo', payload: {} }),
    /format must be an integer/,
  );
  await assert.rejects(
    executor.execute({ format: LLM_FORMATS.Echo }),
    /payload must be an object/,
  );
});
