import { appVer } from "./storage/database.svelte";
import { hubURL } from "./hub";
import { isNodeServer, isTauri } from "./platform";

export type hubType = {
  name: string;
  desc: string;
  download: string;
  id: string;
  img: string;
  tags: string[];
  viewScreen: "none" | "emotion" | "imggen";
  hasLore: boolean;
  hasEmotion: boolean;
  hasAsset: boolean;
  creator?: string;
  creatorName?: string;
  hot: number;
  license: string;
  authorname?: string;
  original?: string;
  type: string;
  hidden?: boolean;
};

export let hubAdditionalHTML = "";

export async function getRisuHub(arg: {
  search: string;
  page: number;
  nsfw: boolean;
  sort: string;
}): Promise<hubType[]> {
  try {
    arg.search += " __shared";
    const platform = !isNodeServer && !isTauri ? "web" : "other";
    const stringArg = `search==${arg.search}&&page==${arg.page}&&nsfw==${arg.nsfw}&&sort==${arg.sort}&&web==${platform}`;
    const response = await fetch(
      `${hubURL}/realm/${encodeURIComponent(stringArg)}?cache=30`,
      {
        headers: {
          "x-risuai-info": `${appVer};${isNodeServer ? "node" : isTauri ? "tauri" : "web"}`,
        },
      },
    );
    if (!response.ok) return [];
    const result = await response.json();
    if (Array.isArray(result)) return result;
    hubAdditionalHTML = result.additionalHTML || hubAdditionalHTML;
    return result.cards;
  } catch {
    return [];
  }
}
