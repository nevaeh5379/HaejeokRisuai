'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createNodeChatExecutor } = require('./chatExecutor.cjs');

function executor() {
  return createNodeChatExecutor({
    countTokensBatch: (texts) => texts.map((text) => text.length),
    createGenerationId: () => 'node-generation-id',
  });
}

function base(overrides = {}) {
  return {
    formated: [{ role: 'user', content: 'hello' }],
    maxContextTokens: 64,
    maxResponseTokens: 12,
    chatAdditionalTokens: 3,
    encoding: 'cl100k_base',
    useName: true,
    supportsInlayImage: true,
    visionQuality: 'high',
    model: 'test-model',
    ...overrides,
  };
}

test('plans generation with shared chat token accounting', async () => {
  const plan = await executor().planGeneration(base({
    formated: [{ role: 'assistant', content: 'hello', name: 'Alice', thoughts: ['think'] }],
    countThoughts: true,
  }));
  assert.equal(plan.ok, true);
  assert.equal(plan.inputTokens, 5 + 3 + 5 + 1 + 5 + 1);
  assert.equal(plan.outputTokens, 12);
  assert.equal(plan.generationId, 'node-generation-id');
  assert.equal(plan.generationModel, 'test-model');
});

test('trims removable messages with the same shared generation plan policy', async () => {
  const plan = await executor().planGeneration(base({
    formated: [
      { role: 'system', content: '12345', removable: true },
      { role: 'user', content: '1234' },
    ],
    maxContextTokens: 7,
    maxResponseTokens: 4,
    chatAdditionalTokens: 1,
  }));
  assert.equal(plan.ok, true);
  assert.deepEqual(plan.keptIndexes, [1]);
  assert.equal(plan.inputTokens, 5);
  assert.equal(plan.outputTokens, 2);
});

test('returns an over-context plan when no removable message can fit', async () => {
  const plan = await executor().planGeneration(base({
    formated: [{ role: 'user', content: '1234567890' }],
    maxContextTokens: 5,
    chatAdditionalTokens: 1,
  }));
  assert.deepEqual(plan, { ok: false, requiredTokens: 11 });
});

test('rejects malformed plan requests before tokenization', async () => {
  await assert.rejects(
    () => executor().planGeneration(base({ encoding: 'definitely-not-real' })),
    (error) => error instanceof TypeError && error.code === 'invalid_chat_plan',
  );
});
