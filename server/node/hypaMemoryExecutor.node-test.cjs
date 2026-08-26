'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createHypaMemoryExecutor } = require('./hypaMemoryExecutor.cjs');

async function drive(executor, response, scope = 'test-scope') {
  while (response.status === 'action') {
    let value;
    if (response.action.type === 'tokenize') {
      value = response.action.messages.map(() => 1);
    } else if (response.action.type === 'tokenize-texts') {
      value = response.action.texts.map(() => 1);
    } else if (response.action.type === 'summarize') {
      value = { ok: true, text: 'summary' };
    } else if (response.action.type === 'distilbart') {
      value = { ok: true, text: 'summary' };
    } else {
      throw new Error(`Unexpected action: ${response.action.type}`);
    }
    response = await executor.resume(
      response.sessionId,
      response.action.id,
      value,
      { scope },
    );
  }
  return response.result;
}

function v3Request() {
  return {
    mode: 'v3',
    chats: [
      { role: 'user', content: 'hello', memo: 'm1' },
      { role: 'assistant', content: 'world', memo: 'm2' },
    ],
    currentTokens: 10,
    maxContextTokens: 1000,
    room: { id: 'room-1' },
    character: { id: 'char-1', name: 'Test', type: 'character' },
    config: {
      maxResponse: 0,
      hypaModel: 'openai3small',
      supaMemoryKey: '',
      customEmbedding: {},
      voyageApiKey: '',
      v3Settings: {
        summarizationModel: 'subModel',
        summarizationPrompt: '',
        reSummarizationPrompt: '',
        memoryTokensRatio: 0.2,
        extraSummarizationRatio: 0.1,
        maxChatsPerSummary: 8,
        recentMemoryRatio: 0.5,
        similarMemoryRatio: 0.5,
        enableSimilarityCorrection: false,
        preserveOrphanedMemory: false,
        doNotSummarizeUserMessage: false,
        summaryChunkSeparator: '\\n\\n',
        useExperimentalImpl: true,
        queryChatCount: 2,
      },
    },
  };
}

test('Hypa V3 experimental state machine stays server-owned and returns passthrough history when no memory exists', async () => {
  const executor = createHypaMemoryExecutor();
  const started = await executor.start(v3Request(), { scope: 'test-scope' });
  assert.equal(started.status, 'action');
  assert.equal(started.action.type, 'tokenize');

  const result = await drive(executor, started);
  assert.equal(result.error, undefined);
  assert.equal(result.memory.summaries.length, 0);
  assert.deepEqual(result.chats.map((chat) => chat.memo), ['m1', 'm2']);
});

test('Hypa sessions are isolated by authenticated scope', async () => {
  const executor = createHypaMemoryExecutor();
  const started = await executor.start(v3Request(), { scope: 'owner' });
  await assert.rejects(
    executor.resume(started.sessionId, started.action.id, [1, 1], { scope: 'other' }),
    (error) => error?.code === 'hypa_session_missing',
  );
  executor.cancel(started.sessionId, { scope: 'owner' });
});

test('Hypa V2 completes on Node without embedding work when no retrieval chunks exist', async () => {
  const executor = createHypaMemoryExecutor();
  const request = {
    mode: 'v2',
    chats: [
      { role: 'user', content: 'hello', memo: 'm1' },
      { role: 'assistant', content: 'world', memo: 'm2' },
    ],
    currentTokens: 10,
    maxContextTokens: 1000,
    room: { id: 'room-2' },
    character: { id: 'char-2', name: 'Test', type: 'character' },
    config: {
      maxResponse: 0,
      hypaAllocatedTokens: 20,
      hypaChunkSize: 100,
      hypaModel: 'openai3small',
      supaModelType: 'subModel',
      supaMemoryPrompt: '',
      supaMemoryKey: '',
      customEmbedding: {},
      voyageApiKey: '',
    },
  };

  const result = await drive(
    executor,
    await executor.start(request, { scope: 'test-scope' }),
  );
  assert.equal(result.error, undefined);
  assert.equal(result.memory.mainChunks.length, 0);
  assert.equal(result.chats[0].memo, 'supaMemory');
  assert.match(result.chats[0].content, /Past Events Summary/);
});

test('Hypa V3 embeddings and similarity ranking execute on the Node backend', async () => {
  const originalFetch = global.fetch;
  let embeddingCalls = 0;
  global.fetch = async (_url, options) => {
    embeddingCalls += 1;
    const body = JSON.parse(options.body);
    const inputs = Array.isArray(body.input) ? body.input : [body.input];
    return {
      ok: true,
      status: 200,
      async text() {
        return JSON.stringify({
          data: inputs.map(() => ({ embedding: [1, 0, 0] })),
        });
      },
    };
  };

  try {
    const executor = createHypaMemoryExecutor();
    const request = v3Request();
    request.currentTokens = 10;
    request.maxContextTokens = 100;
    request.chats = [
      { role: 'user', content: 'old event', memo: 'm1' },
      { role: 'user', content: 'remember this', memo: 'm2' },
    ];
    request.room.hypaV3Data = {
      summaries: [
        {
          text: 'An old event happened.',
          chatMemos: ['m1'],
          isImportant: false,
          tags: [],
        },
      ],
    };
    request.config.hypaModel = 'custom';
    request.config.customEmbedding = {
      url: 'http://embedding.test',
      key: 'test-key',
      model: 'test-model',
    };
    request.config.v3Settings.memoryTokensRatio = 0.5;
    request.config.v3Settings.recentMemoryRatio = 0;
    request.config.v3Settings.similarMemoryRatio = 1;
    request.config.v3Settings.queryChatCount = 1;

    const result = await drive(
      executor,
      await executor.start(request, { scope: 'embedding-scope' }),
      'embedding-scope',
    );

    assert.ok(embeddingCalls >= 2, 'document and query embeddings should be fetched by Node');
    assert.match(result.chats[0].content, /An old event happened\./);
    assert.deepEqual(result.memory.metrics.lastSimilarSummaries, [0]);

    const callsAfterWarmup = embeddingCalls;
    await drive(
      executor,
      await executor.start(structuredClone(request), { scope: 'embedding-scope' }),
      'embedding-scope',
    );
    assert.equal(embeddingCalls, callsAfterWarmup, 'warm document and query embeddings should both be reused');
    assert.ok(executor.getQueryCacheStats('embedding-scope').hits >= 1);

    const cleared = executor.clearQueryCache('embedding-scope');
    assert.ok(cleared.entries >= 1);
    await drive(
      executor,
      await executor.start(structuredClone(request), { scope: 'embedding-scope' }),
      'embedding-scope',
    );
    assert.equal(embeddingCalls, callsAfterWarmup + 1, 'clearing query cache should refetch only the query embedding');
  } finally {
    global.fetch = originalFetch;
  }
});


test('legacy HypaMemory retrieval also uses the Node vector backend', async () => {
  const originalFetch = global.fetch;
  let embeddingCalls = 0;
  global.fetch = async (_url, options) => {
    embeddingCalls += 1;
    const body = JSON.parse(options.body);
    return {
      ok: true,
      status: 200,
      async text() {
        return JSON.stringify({
          data: body.input.map(() => ({ embedding: [1, 0, 0] })),
        });
      },
    };
  };

  try {
    const executor = createHypaMemoryExecutor();
    const chats = Array.from({ length: 15 }, (_, index) => ({
      role: index % 2 === 0 ? 'user' : 'assistant',
      content: `message ${index + 1}`,
      memo: `m${index + 1}`,
    }));
    const request = {
      mode: 'legacy',
      chats,
      currentTokens: 91,
      maxContextTokens: 100,
      room: {
        id: 'legacy-room',
        supaMemoryData: `hypa:\n${JSON.stringify([
          { id: 'm15', supa: 'old summary', hypa: ['remembered event'] },
        ])}`,
      },
      character: { id: 'legacy-char', name: 'Alice', type: 'character' },
      config: {
        hypaModel: 'custom',
        supaModelType: 'subModel',
        supaMemoryPrompt: '',
        supaMemoryKey: '',
        maxSupaChunkSize: 1000,
        removePunctuationHypa: false,
        userName: 'User',
        customEmbedding: {
          url: 'http://embedding.test',
          key: 'test-key',
          model: 'test-model',
        },
        voyageApiKey: '',
      },
    };

    const result = await drive(
      executor,
      await executor.start(request, { scope: 'legacy-scope' }),
      'legacy-scope',
    );
    assert.ok(embeddingCalls >= 2);
    assert.equal(result.error, undefined);
    assert.equal(result.chats[0].memo, 'supaMemory');
    assert.match(result.chats[0].content, /past events: remembered event/);
  } finally {
    global.fetch = originalFetch;
  }
});
