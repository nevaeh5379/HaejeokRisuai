import { afterEach, describe, expect, it } from "vitest";
import { flushSync, mount, unmount } from "svelte";
import type { Chat, Message } from "src/ts/storage/database/schema";
import BranchGraphModalHarness from "./fixtures/BranchGraphModalHarness.svelte";

let mounted: { app: { setChat(chat: Chat): void }; target: HTMLElement } | undefined;

function message(chatId: string, role: "user" | "char", data: string): Message {
  return { chatId, role, data } as Message;
}

function linearChat(): Chat {
  return {
    id: "chat-1",
    message: [message("m1", "user", "hello"), message("m2", "char", "original")],
  } as Chat;
}

function branchedChat(): Chat {
  const first = message("m1", "user", "hello");
  const original = message("m2", "char", "original");
  const reroll = message("m3", "char", "reroll");
  return {
    id: "chat-1",
    message: [first, reroll],
    activeBranchId: "reroll",
    branchState: {
      baseMessageIndex: -1,
      activeBranchId: "reroll",
      branches: [
        { id: "root", reason: "root", createdAt: 0, branchMessageIndex: -1, messages: [first, original] },
        { id: "reroll", parentBranchId: "root", branchMessageId: "m1", branchMessageIndex: 0, reason: "reroll", createdAt: 1, messages: [first, reroll] },
      ],
    },
  } as Chat;
}

describe("BranchGraphModal persistent branch hydration", () => {
  afterEach(async () => {
    if (!mounted) return;
    await unmount(mounted.app as never);
    mounted.target.remove();
    mounted = undefined;
  });

  it("rebuilds the graph when asynchronously hydrated branch data replaces the initial linear chat", () => {
    const target = document.createElement("div");
    document.body.appendChild(target);
    const app = mount(BranchGraphModalHarness, {
      target,
      props: { initialChat: linearChat() },
    }) as unknown as { setChat(chat: Chat): void };
    mounted = { app, target };

    expect(target.querySelectorAll(".branch-node")).toHaveLength(2);
    expect(target.querySelectorAll(".branch-node--fork")).toHaveLength(0);

    app.setChat(branchedChat());
    flushSync();

    expect(target.querySelectorAll(".branch-node")).toHaveLength(3);
    expect(target.querySelectorAll(".branch-node--fork")).toHaveLength(1);
    expect(target.querySelectorAll(".branch-junction").length).toBeGreaterThan(0);
  });
});
