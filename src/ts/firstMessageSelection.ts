export function normalizeFirstMessageIndex(
  index: number | null | undefined,
  alternateGreetingCount: number,
): number {
  if (
    typeof index !== "number" ||
    !Number.isInteger(index) ||
    index < -1 ||
    index >= alternateGreetingCount
  ) {
    return -1;
  }

  return index;
}

export function getSelectedFirstMessage(
  firstMessage: string | null | undefined,
  alternateGreetings: readonly string[],
  index: number | null | undefined,
): string {
  const normalizedIndex = normalizeFirstMessageIndex(
    index,
    alternateGreetings.length,
  );
  return normalizedIndex === -1
    ? (firstMessage ?? "")
    : (alternateGreetings[normalizedIndex] ?? firstMessage ?? "");
}

export function getNextFirstMessageIndex(
  index: number | null | undefined,
  alternateGreetingCount: number,
): number {
  const normalizedIndex = normalizeFirstMessageIndex(
    index,
    alternateGreetingCount,
  );
  return normalizedIndex >= alternateGreetingCount - 1
    ? -1
    : normalizedIndex + 1;
}

export function getPreviousFirstMessageIndex(
  index: number | null | undefined,
  alternateGreetingCount: number,
): number {
  const normalizedIndex = normalizeFirstMessageIndex(
    index,
    alternateGreetingCount,
  );
  return normalizedIndex === -1
    ? Math.max(-1, alternateGreetingCount - 1)
    : normalizedIndex - 1;
}
