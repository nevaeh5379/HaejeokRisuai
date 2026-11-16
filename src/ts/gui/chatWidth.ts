// Chat width setting (chatLimitSize) as a CSS max-width.
// 2 = wide, -1 = no limit, anything else = standard. Same sizes as PocketRisu.
export function chatMaxWidth(chatLimitSize: number): string {
  if (chatLimitSize === -1) return "100%";
  if (chatLimitSize === 2) return "72rem";
  return "48rem";
}
