import type { BlockedRealmCreator } from "./storage/database/schema";

type RealmCreatorData = {
  creator?: string;
};

export function isRealmCreatorBlocked(
  blockedCreators: BlockedRealmCreator[],
  creator?: string,
): boolean {
  if (!creator || blockedCreators.length === 0) {
    return false;
  }
  for (let i = 0; i < blockedCreators.length; i++) {
    if (blockedCreators[i].id === creator) {
      return true;
    }
  }
  return false;
}

export function addBlockedRealmCreator(
  blockedCreators: BlockedRealmCreator[],
  creator: BlockedRealmCreator,
): BlockedRealmCreator[] {
  if (!creator.id || isRealmCreatorBlocked(blockedCreators, creator.id)) {
    return blockedCreators;
  }

  return [...blockedCreators, creator];
}

export function removeBlockedRealmCreator(
  blockedCreators: BlockedRealmCreator[],
  creatorId: string,
): BlockedRealmCreator[] {
  return blockedCreators.filter(
    (blockedCreator) => blockedCreator.id !== creatorId,
  );
}

export function filterBlockedRealmCards<T extends RealmCreatorData>(
  cards: T[],
  blockedCreators: BlockedRealmCreator[],
): T[] {
  if (cards.length === 0 || blockedCreators.length === 0) {
    return cards;
  }

  const blockedSet = new Set<string>();
  for (let i = 0; i < blockedCreators.length; i++) {
    const id = blockedCreators[i].id;
    if (id) blockedSet.add(id);
  }

  if (blockedSet.size === 0) {
    return cards;
  }

  const result: T[] = [];
  for (let i = 0; i < cards.length; i++) {
    const card = cards[i];
    if (!card.creator || !blockedSet.has(card.creator)) {
      result.push(card);
    }
  }
  return result;
}
