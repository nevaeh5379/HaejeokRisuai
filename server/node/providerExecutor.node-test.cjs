'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { LLM_FORMATS } = require('../../packages/protocol/modelFormat.cjs');
const { createNodeProviderExecutor } = require('./providerExecutor.cjs');

test('advertises only implemented provider routes', () => {
  const executor = createNodeProviderExecutor();
  assert.equal(executor.supports(LLM_FORMATS.Echo), true);
  assert.equal(executor.supports(LLM_FORMATS.OpenAICompatible), false);
  assert.deepEqual([...executor.routes], ['echo']);
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
