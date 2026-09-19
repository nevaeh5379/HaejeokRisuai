"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs/promises");
const os = require("os");
const path = require("path");
const http = require("http");
const express = require("express");
const { once } = require("events");
const { createModelJobManager } = require("./modelJobs.cjs");

async function listen(server) {
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  return server.address().port;
}

async function close(server) {
  server.close();
  await once(server, "close");
}

async function makeTempDir() {
  return await fs.mkdtemp(path.join(os.tmpdir(), "risu-model-jobs-"));
}

test("model job survives stream client disconnect and replays the full journal", async (t) => {
  const saveDir = await makeTempDir();
  t.after(() => fs.rm(saveDir, { recursive: true, force: true }));

  const upstream = http.createServer((_req, res) => {
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.write("alpha");
    setTimeout(() => res.write("beta"), 40);
    setTimeout(() => res.end("gamma"), 80);
  });
  const upstreamPort = await listen(upstream);
  t.after(() => close(upstream));

  const lifecycleEvents = [];
  const manager = createModelJobManager({
    saveDir,
    onEvent: (phase, job, context) =>
      lifecycleEvents.push({
        phase,
        jobId: job.id,
        sourceClientId: context?.sourceClientId,
      }),
  });
  t.after(() => manager.close());
  const app = express();
  app.use(express.json({ limit: "10mb" }));
  manager.registerRoutes(app);
  const apiServer = http.createServer(app);
  const apiPort = await listen(apiServer);
  t.after(() => close(apiServer));

  const createResponse = await fetch(
    `http://127.0.0.1:${apiPort}/api/model-jobs`,
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-risu-client-id": "client-session-1",
      },
      body: JSON.stringify({
        targetUrl: `http://127.0.0.1:${upstreamPort}/v1/chat?key=super-secret`,
        method: "POST",
        headers: { Authorization: "Bearer another-secret" },
        body: '{"prompt":"private-prompt"}',
        chatId: "chat-1",
        generationId: "gen-1",
        protocol: "openai",
        streaming: true,
      }),
    },
  );
  assert.equal(createResponse.status, 200);
  const { jobId } = await createResponse.json();
  assert.equal(
    manager.listJobs("active").find((item) => item.id === jobId)
      ?.sourceClientId,
    "client-session-1",
  );

  const firstStream = await fetch(
    `http://127.0.0.1:${apiPort}/api/model-jobs/${jobId}/stream`,
  );
  const firstReader = firstStream.body.getReader();
  const first = await firstReader.read();
  assert.equal(new TextDecoder().decode(first.value), "alpha");
  await firstReader.cancel();

  await new Promise((resolve) => setTimeout(resolve, 130));
  const job = manager.getJob(jobId);
  assert.equal(job.status, "done");

  const replay = await fetch(
    `http://127.0.0.1:${apiPort}/api/model-jobs/${jobId}/stream`,
  );
  assert.equal(await replay.text(), "alphabetagamma");
  assert.equal(
    manager.listJobs("unclaimed").some((item) => item.id === jobId),
    true,
  );
  const jobEvents = lifecycleEvents.filter((event) => event.jobId === jobId);
  assert.deepEqual(
    jobEvents.map((event) => event.phase),
    ["created", "terminal"],
  );
  assert.equal(
    jobEvents.every((event) => event.sourceClientId === "client-session-1"),
    true,
  );

  const metadata = await fs.readFile(
    path.join(saveDir, "model-jobs", "index.json"),
    "utf8",
  );
  assert.equal(metadata.includes("super-secret"), false);
  assert.equal(metadata.includes("another-secret"), false);
  assert.equal(metadata.includes("private-prompt"), false);
  assert.equal(metadata.includes("client-session-1"), false);
});

test("startup converts orphaned running jobs into recoverable failures", async (t) => {
  const saveDir = await makeTempDir();
  t.after(() => fs.rm(saveDir, { recursive: true, force: true }));
  const root = path.join(saveDir, "model-jobs");
  await fs.mkdir(root, { recursive: true });
  await fs.writeFile(path.join(root, "restart-job.journal"), "partial");
  await fs.writeFile(
    path.join(root, "index.json"),
    JSON.stringify([
      {
        id: "restart-job",
        chatId: "chat-2",
        generationId: "gen-2",
        protocol: "openai",
        streaming: true,
        recoverable: true,
        status: "running",
        upstreamStatus: 200,
        createdAt: Date.now() - 1000,
        endedAt: null,
        bytes: 7,
        claimed: false,
      },
    ]),
  );

  const manager = createModelJobManager({ saveDir });
  t.after(() => manager.close());
  const job = manager.getJob("restart-job");
  assert.equal(job.status, "failed");
  assert.match(job.error, /server restart/i);
  assert.equal(
    manager.listJobs("unclaimed").some((item) => item.id === "restart-job"),
    true,
  );
});

test("model jobs allow different chats concurrently and emit lifecycle events", async (t) => {
  const saveDir = await makeTempDir();
  t.after(() => fs.rm(saveDir, { recursive: true, force: true }));
  const upstream = http.createServer((_req, res) => {
    setTimeout(() => res.end("ok"), 80);
  });
  const upstreamPort = await listen(upstream);
  t.after(() => close(upstream));

  const events = [];
  const manager = createModelJobManager({
    saveDir,
    onEvent: (phase, job) => events.push({ phase, chatId: job.chatId }),
  });
  t.after(() => manager.close());

  const request = (chatId) => ({
    targetUrl: `http://127.0.0.1:${upstreamPort}/v1/chat`,
    method: "POST",
    body: "{}",
    chatId,
    generationId: `gen-${chatId}`,
    protocol: "openai",
    streaming: false,
  });
  const first = manager.createJob(request("chat-a"));
  const duplicate = manager.createJob(request("chat-a"));
  const second = manager.createJob(request("chat-b"));

  assert.ok(first.jobId);
  assert.equal(duplicate.httpStatus, 409);
  assert.equal(duplicate.jobId, first.jobId);
  assert.ok(second.jobId);
  assert.notEqual(second.jobId, first.jobId);
  assert.equal(manager.listJobs("active").length, 2);

  await Promise.all([first.runPromise, second.runPromise]);
  assert.equal(manager.getJob(first.jobId).status, "done");
  assert.equal(manager.getJob(second.jobId).status, "done");
  assert.deepEqual(
    events
      .filter((event) => event.phase === "created")
      .map((event) => event.chatId)
      .sort(),
    ["chat-a", "chat-b"],
  );
  assert.deepEqual(
    events
      .filter((event) => event.phase === "terminal")
      .map((event) => event.chatId)
      .sort(),
    ["chat-a", "chat-b"],
  );
});

test("active model jobs can be aborted from another client", async (t) => {
  const saveDir = await makeTempDir();
  t.after(() => fs.rm(saveDir, { recursive: true, force: true }));
  const upstream = http.createServer((_req, res) => {
    res.writeHead(200, { "content-type": "text/plain" });
    res.write("partial");
    setTimeout(() => res.end("late"), 500);
  });
  const upstreamPort = await listen(upstream);
  t.after(() => close(upstream));

  const manager = createModelJobManager({ saveDir });
  t.after(() => manager.close());
  const created = manager.createJob({
    targetUrl: `http://127.0.0.1:${upstreamPort}/v1/chat`,
    method: "POST",
    body: "{}",
    chatId: "remote-cancel-chat",
    generationId: "remote-cancel-generation",
    protocol: "openai",
    streaming: true,
  });
  assert.ok(created.jobId);
  assert.equal(manager.listJobs("active").length, 1);

  const deleted = await manager.deleteJob(created.jobId);
  assert.deepEqual(deleted, { success: true, aborted: true });
  await created.runPromise;
  assert.equal(manager.getJob(created.jobId).status, "aborted");
  assert.equal(manager.listJobs("active").length, 0);
});
