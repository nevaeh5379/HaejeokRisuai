export const NOVELAI_GENERATE_URLS: Readonly<{
  kayra: "https://text.novelai.net/ai/generate";
  clio: "https://api.novelai.net/ai/generate";
}>;
export function resolveNovelAIGenerateUrl(
  variant: "kayra" | "clio",
): string | null;
