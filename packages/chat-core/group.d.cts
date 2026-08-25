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

export function orderGroupSpeakers(
  candidates: readonly GroupSpeakerCandidate[],
  input?: string,
  randomSource?: GroupSpeakerRandomSource,
): GroupSpeakerCandidate[];

export function selectGroupGenerationOrder(
  input: GroupSpeakerOrderInput,
  randomSource?: GroupSpeakerRandomSource,
): GroupSpeakerCandidate[];
