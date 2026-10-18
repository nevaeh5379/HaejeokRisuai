"use strict";

const DEFAULT_MESSAGE_PAGE_LIMIT: any = 40;
const MAX_MESSAGE_PAGE_LIMIT: any = 500;

function normalizePageInteger(
  value?: any,
  fallback?: any,
  maximum: any = Number.MAX_SAFE_INTEGER,
): any {
  if (value === undefined || value === null || value === "") return fallback;
  const parsed: any = Number.parseInt(String(value), 10);
  if (!Number.isSafeInteger(parsed) || parsed < 0) return fallback;
  return Math.min(parsed, maximum);
}

function paginateMessages(messages?: any, options: any = {}): any {
  const source: any = Array.isArray(messages) ? messages : [];
  const total: any = source.length;
  const limit: any = Math.max(
    1,
    normalizePageInteger(
      options.limit,
      DEFAULT_MESSAGE_PAGE_LIMIT,
      MAX_MESSAGE_PAGE_LIMIT,
    ),
  );
  const end: any = normalizePageInteger(options.before, total, total);
  const offset: any = Math.max(0, end - limit);

  return {
    messages: source.slice(offset, end),
    offset,
    total,
    hasMore: offset > 0,
  };
}

export {
  DEFAULT_MESSAGE_PAGE_LIMIT,
  MAX_MESSAGE_PAGE_LIMIT,
  normalizePageInteger,
  paginateMessages,
};
