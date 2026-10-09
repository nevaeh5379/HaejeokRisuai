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
("use strict");

const defaultRandomSource: any = {
  random: Math.random,
  shuffle(items?: any): any {
    const result: any = [...items];
    for (let index: any = result.length - 1; index > 0; index--) {
      const target: any = Math.floor(Math.random() * (index + 1));
      [result[index], result[target]] = [result[target], result[index]];
    }
    return result;
  },
};

function words(data?: any): any {
  return data.split(/\n| /g).map((word?: any) => word.toLocaleLowerCase());
}

function orderGroupSpeakers(
  candidates: readonly GroupSpeakerCandidate[],
  input?: string,
  randomSource?: GroupSpeakerRandomSource,
): GroupSpeakerCandidate[];
function orderGroupSpeakers(
  candidates?: any,
  input: any = "",
  randomSource: any = defaultRandomSource,
): any {
  const order: any = [];
  const ids: any = [];

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
    order.push(
      candidates[Math.floor(randomSource.random() * candidates.length)],
    );
  }
  return order;
}

function selectGroupGenerationOrder(
  input: GroupSpeakerOrderInput,
  randomSource?: GroupSpeakerRandomSource,
): GroupSpeakerCandidate[];
function selectGroupGenerationOrder(
  input?: any,
  randomSource: any = defaultRandomSource,
): any {
  const active: any = input.candidates.filter(
    (candidate?: any) => candidate.talkness > 0,
  );
  if (input.preserveOrder) return [...active];
  return orderGroupSpeakers(active, input.lastMessage, randomSource).filter(
    (candidate?: any) => candidate.id !== input.lastSpeakerId,
  );
}

export { orderGroupSpeakers, selectGroupGenerationOrder };
