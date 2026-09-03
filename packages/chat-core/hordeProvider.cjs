"use strict";

const STABLE_HORDE_TEXT_ASYNC_URL =
  "https://stablehorde.net/api/v2/generate/text/async";
const STABLE_HORDE_TEXT_STATUS_BASE_URL =
  "https://stablehorde.net/api/v2/generate/text/status/";

function buildStableHordeStatusUrl(id) {
  if (typeof id !== "string" || id.length === 0 || id.length > 256) {
    return null;
  }
  return STABLE_HORDE_TEXT_STATUS_BASE_URL + encodeURIComponent(id);
}

module.exports = {
  STABLE_HORDE_TEXT_ASYNC_URL,
  STABLE_HORDE_TEXT_STATUS_BASE_URL,
  buildStableHordeStatusUrl,
};
