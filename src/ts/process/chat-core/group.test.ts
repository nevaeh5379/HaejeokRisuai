import { describe, expect, it } from "vitest";
import {
  orderGroupSpeakers,
  selectGroupGenerationOrder,
  type GroupSpeakerCandidate,
  type GroupSpeakerRandomSource,
} from "./group";

const candidates: GroupSpeakerCandidate[] = [
  { id: "a", name: "Alice", talkness: 1, index: 0 },
  { id: "b", name: "Bob", talkness: 0.5, index: 1 },
  { id: "c", name: "Carol", talkness: -1, index: 2 },
];

const deterministic: GroupSpeakerRandomSource = {
  random: () => 0.25,
  shuffle: (items) => [...items],
};

describe("group speaker policy", () => {
  it("prioritizes characters explicitly mentioned in the latest message", () => {
    expect(orderGroupSpeakers(candidates.slice(0, 2), "hello bob", deterministic)[0].id).toBe("b");
  });

  it("uses talkness probabilities for unmentioned candidates", () => {
    expect(orderGroupSpeakers(candidates.slice(0, 2), "", deterministic).map((item) => item.id)).toEqual(["a", "b"]);
  });

  it("falls back to one speaker when probability selection produces none", () => {
    const never: GroupSpeakerRandomSource = {
      random: () => 0.9,
      shuffle: (items) => [...items],
    };
    expect(orderGroupSpeakers([{ ...candidates[1], talkness: 0.1 }], "", never)).toHaveLength(1);
  });

  it("filters inactive and previous speakers in randomized group mode", () => {
    expect(selectGroupGenerationOrder({
      candidates,
      lastMessage: "hello",
      lastSpeakerId: "a",
    }, deterministic).map((item) => item.id)).toEqual(["b"]);
  });

  it("preserves configured order without excluding the previous speaker", () => {
    expect(selectGroupGenerationOrder({
      candidates,
      lastSpeakerId: "a",
      preserveOrder: true,
    }).map((item) => item.id)).toEqual(["a", "b"]);
  });
});
