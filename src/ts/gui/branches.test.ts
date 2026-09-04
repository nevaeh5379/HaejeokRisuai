import { describe, expect, it } from "vitest";

import {
  buildChatGraphGitLanes,
  buildChatMessageGraph,
  getChatBranches,
  getChatBranchesFromPersistentGraph,
  type ChatGraphTimeline,
} from "./branches";
import type { Chat, Message } from "../storage/database/schema";

function message(chatId: string, role: Message["role"], data: string): Message {
  return { chatId, role, data };
}

function timeline(
  branchId: string,
  messages: Message[],
  active = false,
): ChatGraphTimeline {
  return {
    branchId,
    messages,
    active,
    reason: branchId === "root" ? "root" : "reroll",
  };
}

describe("buildChatMessageGraph", () => {
  it("shows every shared and alternative message exactly once", () => {
    const u1 = message("u1", "user", "hello");
    const a1 = message("a1", "char", "first answer");
    const u2 = message("u2", "user", "continue");
    const original = message("a2", "char", "original answer");
    const reroll = message("a2-alt", "char", "alternative answer");

    const graph = buildChatMessageGraph([
      timeline("root", [u1, a1, u2, original]),
      timeline("reroll", [u1, a1, u2, reroll], true),
    ]);

    expect(graph.nodes).toHaveLength(5);
    expect(graph.timelineCount).toBe(2);
    expect(graph.nodes.map((node) => node.preview)).toEqual([
      "hello",
      "first answer",
      "continue",
      "original answer",
      "alternative answer",
    ]);
  });

  it("places alternative responses horizontally at their actual fork message", () => {
    const u1 = message("u1", "user", "hello");
    const a1 = message("a1", "char", "first answer");
    const u2 = message("u2", "user", "continue");
    const original = message("a2", "char", "original answer");
    const reroll = message("a2-alt", "char", "alternative answer");
    const graph = buildChatMessageGraph([
      timeline("root", [u1, a1, u2, original]),
      timeline("reroll", [u1, a1, u2, reroll], true),
    ]);

    const fork = graph.nodes.find((node) => node.id === "message:u2")!;
    const originalNode = graph.nodes.find((node) => node.id === "message:a2")!;
    const rerollNode = graph.nodes.find(
      (node) => node.id === "message:a2-alt",
    )!;
    expect(fork.branchPoint).toBe(true);
    expect(fork.continuationCount).toBe(2);
    expect(originalNode.y).toBe(rerollNode.y);
    expect(originalNode.x).not.toBe(rerollNode.x);
  });

  it("marks the complete active message path and its terminal", () => {
    const shared = message("u1", "user", "hello");
    const original = message("a1", "char", "original");
    const alternative = message("a1-alt", "char", "alternative");
    const graph = buildChatMessageGraph([
      timeline("root", [shared, original]),
      timeline("reroll", [shared, alternative], true),
    ]);

    expect(
      graph.nodes.find((node) => node.id === "message:u1")?.activePath,
    ).toBe(true);
    expect(
      graph.nodes.find((node) => node.id === "message:a1")?.activePath,
    ).toBe(false);
    expect(
      graph.nodes.find((node) => node.id === "message:a1-alt")?.activeTerminal,
    ).toBe(true);
    expect(
      graph.edges.find((edge) => edge.to === "message:a1-alt")?.active,
    ).toBe(true);
  });

  it("exposes an empty branch as a terminal on the message where it split", () => {
    const u1 = message("u1", "user", "hello");
    const a1 = message("a1", "char", "answer");
    const u2 = message("u2", "user", "continue");
    const graph = buildChatMessageGraph([
      timeline("root", [u1, a1, u2]),
      { ...timeline("manual", [u1, a1], true), reason: "manual" },
    ]);

    const fork = graph.nodes.find((node) => node.id === "message:a1")!;
    expect(fork.branchPoint).toBe(true);
    expect(fork.terminals).toEqual([
      { branchId: "manual", reason: "manual", active: true },
    ]);
    expect(fork.activeTerminal).toBe(true);
  });

  it("merges copied legacy messages without chat IDs beneath the same parent", () => {
    const sharedUser: Message = { role: "user", data: "hello" };
    const sharedAnswer: Message = { role: "char", data: "same answer" };
    const graph = buildChatMessageGraph([
      timeline("root", [
        sharedUser,
        sharedAnswer,
        { role: "user", data: "left" },
      ]),
      timeline(
        "reroll",
        [
          { ...sharedUser },
          { ...sharedAnswer },
          { role: "user", data: "right" },
        ],
        true,
      ),
    ]);

    expect(graph.nodes).toHaveLength(4);
    expect(
      graph.nodes.filter((node) => node.preview === "same answer"),
    ).toHaveLength(1);
    expect(
      graph.nodes.find((node) => node.preview === "same answer")?.branchPoint,
    ).toBe(true);
  });

  it("collapses a long linear stretch while preserving its endpoints and active path", () => {
    const messages = Array.from({ length: 120 }, (_, index) =>
      message(
        `m${index}`,
        index % 2 === 0 ? "user" : "char",
        `message ${index + 1}`,
      ),
    );
    const graph = buildChatMessageGraph([timeline("root", messages, true)]);

    const summary = graph.nodes.find((node) => node.kind === "summary")!;
    expect(graph.messageCount).toBe(120);
    expect(graph.collapsedMessageCount).toBe(114);
    expect(graph.nodes).toHaveLength(7);
    expect(summary.collapsedCount).toBe(114);
    expect(summary.messageIndex).toBe(3);
    expect(summary.endMessageIndex).toBe(116);
    expect(summary.activePath).toBe(true);
    expect(
      graph.edges.filter(
        (edge) => edge.from === summary.id || edge.to === summary.id,
      ),
    ).toHaveLength(2);
    expect(
      graph.edges
        .filter((edge) => edge.from === summary.id || edge.to === summary.id)
        .every((edge) => edge.active),
    ).toBe(true);
  });

  it("keeps every message when density is all", () => {
    const messages = Array.from({ length: 120 }, (_, index) =>
      message(
        `full-${index}`,
        index % 2 === 0 ? "user" : "char",
        `full message ${index + 1}`,
      ),
    );

    const graph = buildChatMessageGraph([timeline("root", messages, true)], {
      density: "all",
    });

    expect(graph.nodes).toHaveLength(120);
    expect(graph.collapsedMessageCount).toBe(0);
    expect(graph.nodes.every((node) => node.kind === "message")).toBe(true);
  });

  it("compresses linear runs to branch landmarks when density is branches", () => {
    const shared = Array.from({ length: 12 }, (_, index) =>
      message(
        `landmark-${index}`,
        index % 2 === 0 ? "user" : "char",
        `landmark ${index + 1}`,
      ),
    );
    const original = message("landmark-original", "char", "original ending");
    const alternative = message("landmark-alt", "char", "alternative ending");

    const graph = buildChatMessageGraph(
      [
        timeline("root", [...shared, original]),
        timeline("reroll", [...shared, alternative], true),
      ],
      { density: "branches" },
    );

    const fork = graph.nodes.find((node) => node.id === "message:landmark-11")!;
    expect(graph.nodes).toHaveLength(5);
    expect(graph.collapsedMessageCount).toBe(10);
    expect(graph.nodes.filter((node) => node.kind === "summary")).toHaveLength(
      1,
    );
    expect(fork.branchPoint).toBe(true);
    expect(
      graph.nodes.some((node) => node.id === "message:landmark-original"),
    ).toBe(true);
    expect(graph.nodes.some((node) => node.id === "message:landmark-alt")).toBe(
      true,
    );
  });

  it("never collapses the exact fork point in a long chat", () => {
    const shared = Array.from({ length: 100 }, (_, index) =>
      message(
        `shared-${index}`,
        index % 2 === 0 ? "user" : "char",
        `shared ${index + 1}`,
      ),
    );
    const original = message("original", "char", "original ending");
    const alternative = message("alternative", "char", "alternative ending");
    const graph = buildChatMessageGraph([
      timeline("root", [...shared, original]),
      timeline("reroll", [...shared, alternative], true),
    ]);

    const fork = graph.nodes.find((node) => node.id === "message:shared-99")!;
    const originalNode = graph.nodes.find(
      (node) => node.id === "message:original",
    )!;
    const alternativeNode = graph.nodes.find(
      (node) => node.id === "message:alternative",
    )!;
    expect(graph.collapsedMessageCount).toBeGreaterThan(0);
    expect(fork.kind).toBe("message");
    expect(fork.branchPoint).toBe(true);
    expect(originalNode.y).toBe(alternativeNode.y);
    expect(originalNode.x).not.toBe(alternativeNode.x);
  });
});

describe("buildChatGraphGitLanes", () => {
  it("keeps the active continuation in its current lane and moves alternatives aside", () => {
    const shared = message("lane-shared", "user", "shared");
    const original = message("lane-original", "char", "original");
    const activeAlternative = message(
      "lane-active",
      "char",
      "active alternative",
    );
    const graph = buildChatMessageGraph([
      timeline("root", [shared, original]),
      timeline("reroll", [shared, activeAlternative], true),
    ]);

    const lanes = buildChatGraphGitLanes(graph);

    expect(lanes.laneByNodeId.get("message:lane-shared")).toBe(0);
    expect(lanes.laneByNodeId.get("message:lane-active")).toBe(0);
    expect(lanes.laneByNodeId.get("message:lane-original")).not.toBe(0);
    expect(lanes.columns).toBe(2);
  });
});

describe("getChatBranches", () => {
  it("builds from the explicitly pinned chat instead of global selection", () => {
    const chat = {
      message: [
        message("u1", "user", "focused tab message"),
        message("a1", "char", "focused tab response"),
      ],
    } as Chat;

    const graph = getChatBranches(chat);

    expect(graph.messageCount).toBe(2);
    expect(graph.timelineCount).toBe(1);
    expect(graph.nodes.map((node) => node.preview)).toEqual([
      "focused tab message",
      "focused tab response",
    ]);
  });

  it("renders edited user input from the persistent SQL graph as a separate branch node", () => {
    const graph = getChatBranchesFromPersistentGraph({
      branches: [
        {
          id: "root",
          chatId: "chat-1",
          headMessageId: "a2",
          reason: "root",
          createdAt: 1,
        },
        {
          id: "edit",
          chatId: "chat-1",
          parentBranchId: "root",
          forkMessageId: "a1",
          headMessageId: "u2-edit",
          reason: "manual",
          createdAt: 10,
        },
      ],
      activeBranchId: "edit",
      messages: [
        message("u1", "user", "first prompt"),
        message("a1", "char", "first answer"),
        message("u2", "user", "original input"),
        message("a2", "char", "original response"),
        message("u2-edit", "user", "edited input"),
      ],
      links: [
        { messageId: "u1", originBranchId: "root" },
        { messageId: "a1", parentMessageId: "u1", originBranchId: "root" },
        { messageId: "u2", parentMessageId: "a1", originBranchId: "root" },
        { messageId: "a2", parentMessageId: "u2", originBranchId: "root" },
        {
          messageId: "u2-edit",
          parentMessageId: "a1",
          originBranchId: "edit",
        },
      ],
    });
    const originalInput = graph.nodes.find(
      (node) => node.preview === "original input",
    )!;
    const editedInput = graph.nodes.find(
      (node) => node.preview === "edited input",
    )!;
    const fork = graph.nodes.find((node) => node.preview === "first answer")!;

    expect(graph.timelineCount).toBe(2);
    expect(originalInput.id).not.toBe(editedInput.id);
    expect(originalInput.y).toBe(editedInput.y);
    expect(fork.branchPoint).toBe(true);
    expect(editedInput.activeTerminal).toBe(true);
  });
});
