import { expect, it, vi } from "vitest";
import { createTokenizerQueue } from "./tokenizerQueue";

it("keeps encoding away from a tokenizer being freed and replaced", async () => {
  const queue = createTokenizerQueue();
  let release!: () => void;
  const loaded = new Promise<void>((resolve) => {
    release = resolve;
  });
  let resource = { model: "primary", freed: false };
  const events: string[] = [];
  const encode = (model: string, text: string) =>
    queue(async () => {
      if (resource.model !== model) {
        resource.freed = true;
        events.push(`free:${resource.model}`);
        await loaded;
        resource = { model, freed: false };
        events.push(`load:${model}`);
      }
      if (resource.freed) throw new Error("null pointer passed to rust");
      events.push(`encode:${model}:${text}`);
      return text.length;
    });
  const illustration = encode("submodel", "illustration");
  await Promise.resolve();
  const chat = encode("primary", "chat");
  await Promise.resolve();
  expect(events).toEqual(["free:primary"]);
  release();
  expect(await Promise.all([illustration, chat])).toEqual([12, 4]);
  expect(events).toEqual([
    "free:primary",
    "load:submodel",
    "encode:submodel:illustration",
    "free:submodel",
    "load:primary",
    "encode:primary:chat",
  ]);
});

it("allows a retry after tokenizer loading fails", async () => {
  const queue = createTokenizerQueue();
  const load = vi
    .fn()
    .mockRejectedValueOnce(new Error("loading failed"))
    .mockResolvedValueOnce([1, 2]);
  const initial = queue(load);
  const retry = queue(load);
  await expect(initial).rejects.toThrow("loading failed");
  await expect(retry).resolves.toEqual([1, 2]);
  expect(load).toHaveBeenCalledTimes(2);
});
