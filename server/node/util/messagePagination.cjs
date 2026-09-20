"use strict";

const DEFAULT_MESSAGE_PAGE_LIMIT = 40;
const MAX_MESSAGE_PAGE_LIMIT = 500;

function normalizePageInteger(
  value,
  fallback,
  maximum = Number.MAX_SAFE_INTEGER,
) {
  if (value === undefined || value === null || value === "") return fallback;
  const parsed = Number.parseInt(String(value), 10);
  if (!Number.isSafeInteger(parsed) || parsed < 0) return fallback;
  return Math.min(parsed, maximum);
}

function paginateMessages(messages, options = {}) {
  const source = Array.isArray(messages) ? messages : [];
  const total = source.length;
  const limit = Math.max(
    1,
    normalizePageInteger(
      options.limit,
      DEFAULT_MESSAGE_PAGE_LIMIT,
      MAX_MESSAGE_PAGE_LIMIT,
    ),
  );
  const end = normalizePageInteger(options.before, total, total);
  const offset = Math.max(0, end - limit);

  return {
    messages: source.slice(offset, end),
    offset,
    total,
    hasMore: offset > 0,
  };
}

module.exports = {
  DEFAULT_MESSAGE_PAGE_LIMIT,
  MAX_MESSAGE_PAGE_LIMIT,
  normalizePageInteger,
  paginateMessages,
};
