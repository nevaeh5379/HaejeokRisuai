"use strict";

const SQL_DATABASE_VENDORS = Object.freeze(["postgres", "oracle", "azure"]);
const SQL_RUNTIME_STATUSES = Object.freeze([
  "starting",
  "ready",
  "degraded",
  "unconfigured",
]);
const ASSET_STORAGE_TYPES = Object.freeze(["fs", "s3", "azuresql"]);

module.exports = {
  SQL_DATABASE_VENDORS,
  SQL_RUNTIME_STATUSES,
  ASSET_STORAGE_TYPES,
};
