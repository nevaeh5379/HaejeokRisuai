"use strict";

const STABLE_HORDE_TEXT_ASYNC_URL: "https://stablehorde.net/api/v2/generate/text/async" =
  "https://stablehorde.net/api/v2/generate/text/async";
const STABLE_HORDE_TEXT_STATUS_BASE_URL: "https://stablehorde.net/api/v2/generate/text/status/" =
  "https://stablehorde.net/api/v2/generate/text/status/";

function buildStableHordeStatusUrl(id: string): string | null;
function buildStableHordeStatusUrl(id?: any): any {
  if (typeof id !== "string" || id.length === 0 || id.length > 256) {
    return null;
  }
  return STABLE_HORDE_TEXT_STATUS_BASE_URL + encodeURIComponent(id);
}

export {
  STABLE_HORDE_TEXT_ASYNC_URL,
  STABLE_HORDE_TEXT_STATUS_BASE_URL,
  buildStableHordeStatusUrl,
};
