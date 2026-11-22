"use strict";

/*
 * Pagination helpers shared by list endpoints.
 *
 * Conventions:
 *   - `page`    1-based, defaults to 1, must be a positive integer string.
 *   - `limit`   page size, defaults to DEFAULT_LIMIT, capped at MAX_LIMIT.
 *   - Responses include `page`, `limit`, `total`, `hasMore` and `Link`
 *     headers (`rel="next"` / `rel="prev"` / `rel="last"` / `rel="self"`).
 */

const DEFAULT_LIMIT = 25;
const MAX_LIMIT = 200;
const DEFAULT_PAGE = 1;

function parsePositiveInt(raw) {
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim();
  if (!/^\d+$/.test(trimmed)) return null;
  const value = Number.parseInt(trimmed, 10);
  return Number.isSafeInteger(value) ? value : null;
}

function parsePage(req) {
  const parsed = parsePositiveInt(req.query.page);
  return parsed === null || parsed < 1 ? DEFAULT_PAGE : parsed;
}

function parseLimit(req, { defaultLimit = DEFAULT_LIMIT, maxLimit = MAX_LIMIT } = {}) {
  const parsed = parsePositiveInt(req.query.limit);
  if (parsed === null || parsed < 1) return defaultLimit;
  return Math.min(parsed, maxLimit);
}

function paginateArray(items, { page = DEFAULT_PAGE, limit = DEFAULT_LIMIT } = {}) {
  const total = items.length;
  const start = (page - 1) * limit;
  const pageItems = start >= total ? [] : items.slice(start, start + limit);
  const hasMore = start + limit < total;
  const totalPages = Math.max(Math.ceil(total / limit), 1);
  return {
    items: pageItems,
    page,
    limit,
    total,
    hasMore,
    nextPage: hasMore ? page + 1 : null,
    prevPage: page > DEFAULT_PAGE ? page - 1 : null,
    totalPages
  };
}

function pageLinks(req, opts = {}) {
  const pageParam = opts.pageParam || "page";
  const limitParam = opts.limitParam || "limit";
  const limit = opts.limit;
  const baseUrl = String(req.originalUrl || req.url || "/");
  const queryIndex = baseUrl.indexOf("?");
  const pathPart = queryIndex === -1 ? baseUrl : baseUrl.slice(0, queryIndex);
  const params = new URLSearchParams(queryIndex === -1 ? "" : baseUrl.slice(queryIndex + 1));
  params.delete(pageParam);
  params.delete(limitParam);
  if (Number.isFinite(limit)) params.set(limitParam, String(limit));

  const page = opts.page || 1;
  const links = [];
  const build = (targetPage) => {
    params.set(pageParam, String(targetPage));
    const qs = params.toString();
    params.delete(pageParam);
    return `${pathPart}?${qs}`;
  };
  if (opts.nextPage) links.push({ rel: "next", url: build(opts.nextPage) });
  if (opts.prevPage) links.push({ rel: "prev", url: build(opts.prevPage) });
  if (opts.totalPages && page < opts.totalPages) links.push({ rel: "last", url: build(opts.totalPages) });
  return links;
}

/** Sets the `Link` header for the current response (HATEOAS-style paging). */
function setLinkHeader(res, req, opts = {}) {
  const links = pageLinks(req, {
    page: opts.page,
    limit: opts.limit,
    nextPage: opts.nextPage,
    prevPage: opts.prevPage,
    totalPages: opts.totalPages,
    pageParam: opts.pageParam,
    limitParam: opts.limitParam
  });
  if (links.length > 0) {
    res.setHeader("Link", links.map((link) => `<${link.url}>; rel="${link.rel}"`).join(", "));
  }
}

module.exports = { DEFAULT_LIMIT, MAX_LIMIT, parsePage, parseLimit, paginateArray, pageLinks, setLinkHeader };
