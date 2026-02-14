/**
 * Busy-Range Cache — In-Memory TTL Cache
 *
 * Caches Google Calendar busy ranges per tenant + time window
 * to avoid hammering the Google API on every availability check.
 *
 * Key format: `{tenantId}:{fromEpoch}:{toEpoch}`
 * Default TTL: 30 seconds (configurable via CALENDAR_BUSY_CACHE_TTL_SECONDS)
 *
 * Thread-safe for single-process Node.js. For multi-process, each
 * process maintains its own cache (acceptable — short TTL means
 * staleness is bounded to a few seconds).
 */

import { env } from '../../config/env.js';

export interface BusyRange {
  start: number; // epoch ms
  end: number;   // epoch ms
}

interface CacheEntry {
  ranges: BusyRange[];
  expiresAt: number; // epoch ms
}

const cache = new Map<string, CacheEntry>();

/**
 * Build a cache key from tenant + time window.
 * Rounds from/to to the nearest minute to improve cache hit rate
 * (slightly different Date objects for "same" query won't miss).
 */
function buildKey(tenantId: string, from: Date, to: Date): string {
  // Round to minute boundaries
  const fromMin = Math.floor(from.getTime() / 60000) * 60000;
  const toMin   = Math.floor(to.getTime() / 60000) * 60000;
  return `${tenantId}:${fromMin}:${toMin}`;
}

/**
 * Get cached busy ranges for a tenant + window.
 * Returns null on cache miss or expiry.
 */
export function getCachedBusyRanges(
  tenantId: string,
  from: Date,
  to: Date,
): BusyRange[] | null {
  const key = buildKey(tenantId, from, to);
  const entry = cache.get(key);

  if (!entry) return null;

  if (Date.now() > entry.expiresAt) {
    // Expired — remove and return miss
    cache.delete(key);
    return null;
  }

  return entry.ranges;
}

/**
 * Store busy ranges in the cache with TTL.
 */
export function setCachedBusyRanges(
  tenantId: string,
  from: Date,
  to: Date,
  ranges: BusyRange[],
): void {
  const key = buildKey(tenantId, from, to);
  const ttlMs = env.CALENDAR_BUSY_CACHE_TTL_SECONDS * 1000;

  cache.set(key, {
    ranges,
    expiresAt: Date.now() + ttlMs,
  });
}

/**
 * Evict all cached entries for a tenant (e.g., after a booking changes the calendar).
 */
export function invalidateTenantCache(tenantId: string): void {
  for (const key of cache.keys()) {
    if (key.startsWith(`${tenantId}:`)) {
      cache.delete(key);
    }
  }
}

/**
 * Clear the entire cache (useful for tests).
 */
export function clearBusyRangeCache(): void {
  cache.clear();
}

/**
 * Get cache stats (for debug endpoints).
 */
export function getBusyRangeCacheStats(): { size: number; ttlSeconds: number } {
  return {
    size: cache.size,
    ttlSeconds: env.CALENDAR_BUSY_CACHE_TTL_SECONDS,
  };
}
