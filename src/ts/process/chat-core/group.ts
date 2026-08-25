export interface GroupSpeakerCandidate {
  id: string;
  name: string;
  talkness: number;
  index: number;
}

export interface GroupSpeakerOrderInput {
  candidates: readonly GroupSpeakerCandidate[];
  lastMessage?: string;
  lastSpeakerId?: string;
  preserveOrder?: boolean;
}

export interface GroupSpeakerRandomSource {
  random(): number;
  shuffle<T>(items: readonly T[]): T[];
}

const defaultRandomSource: GroupSpeakerRandomSource = {
  random: Math.random,
  shuffle<T>(items: readonly T[]) {
    const result = [...items];
    for (let index = result.length - 1; index > 0; index--) {
      const target = Math.floor(Math.random() * (index + 1));
      [result[index], result[target]] = [result[target], result[index]];
    }
    return result;
  },
};

function words(data: string): string[] {
  return data.split(/\n| /g).map((word) => word.toLocaleLowerCase());
}

export function orderGroupSpeakers(
  candidates: readonly GroupSpeakerCandidate[],
  input = "",
  randomSource: GroupSpeakerRandomSource = defaultRandomSource,
): GroupSpeakerCandidate[] {
  const order: GroupSpeakerCandidate[] = [];
  const ids: string[] = [];

  if (input) {
    for (const word of words(input)) {
      for (const candidate of candidates) {
        if (words(candidate.name).includes(word)) {
          order.push(candidate);
          ids.push(candidate.id);
          break;
        }
      }
    }
  }

  for (const candidate of randomSource.shuffle(candidates)) {
    if (ids.includes(candidate.id)) continue;
    if ((candidate.talkness ?? 0.5) >= randomSource.random()) {
      order.push(candidate);
      ids.push(candidate.id);
    }
  }

  while (order.length === 0 && candidates.length > 0) {
    order.push(candidates[Math.floor(randomSource.random() * candidates.length)]);
  }
  return order;
}

export function selectGroupGenerationOrder(
  input: GroupSpeakerOrderInput,
  randomSource: GroupSpeakerRandomSource = defaultRandomSource,
): GroupSpeakerCandidate[] {
  const active = input.candidates.filter((candidate) => candidate.talkness > 0);
  if (input.preserveOrder) return [...active];
  return orderGroupSpeakers(active, input.lastMessage, randomSource).filter(
    (candidate) => candidate.id !== input.lastSpeakerId,
  );
}
