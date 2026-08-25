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
  assert.deepEqual([...executor.transportFormats], [LLM_FORMATS.OpenAICompatible]);
  assert.equal(executor.supportsTransport(LLM_FORMATS.OpenAICompatible), true);
  assert.equal(executor.supportsTransport(LLM_FORMATS.NanoGPT), false);
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

test('does not expose raw transport for other openai-route formats', async () => {
  const executor = createNodeProviderExecutor();
  assert.deepEqual(await executor.executeTransport({
    format: LLM_FORMATS.NanoGPT,
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
