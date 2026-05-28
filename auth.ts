// @helm-protocol/ttt-mcp — Free tier rate limit structure
// FREE_TIER_LIMIT calls/day per IP (default: 100)
// API key present → unlimited (key validation deferred to server)

const FREE_TIER_LIMIT = parseInt(process.env.FREE_TIER_LIMIT ?? "100", 10);

// In-memory counter: ipOrKey → { count, resetAt }
interface BucketEntry {
  count: number;
  resetAt: number; // Unix ms — resets at midnight UTC
}

const buckets = new Map<string, BucketEntry>();

function nextMidnightUtc(): number {
  const now = new Date();
  const midnight = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1)
  );
  return midnight.getTime();
}

/**
 * Check whether a call should be allowed.
 *
 * @param apiKey  - API key from X-API-Key header (undefined = anonymous free tier)
 * @param clientIp - caller IP (used as bucket key when no API key)
 * @returns { allowed: boolean; remaining: number; tier: "free" | "paid" }
 */
export function checkRateLimit(
  apiKey: string | undefined,
  clientIp: string
): { allowed: boolean; remaining: number; tier: "free" | "paid" } {
  // API key present → paid tier, no limit enforced here
  if (apiKey && apiKey.trim().length > 0) {
    return { allowed: true, remaining: -1, tier: "paid" };
  }

  const bucketKey = `ip:${clientIp}`;
  const now = Date.now();
  let entry = buckets.get(bucketKey);

  if (!entry || now >= entry.resetAt) {
    entry = { count: 0, resetAt: nextMidnightUtc() };
    buckets.set(bucketKey, entry);
  }

  if (entry.count >= FREE_TIER_LIMIT) {
    return {
      allowed: false,
      remaining: 0,
      tier: "free",
    };
  }

  entry.count += 1;
  return {
    allowed: true,
    remaining: FREE_TIER_LIMIT - entry.count,
    tier: "free",
  };
}

/**
 * Extract API key from environment or request headers string.
 * In stdio (npx) mode there are no HTTP headers — uses TTT_API_KEY env var.
 */
export function resolveApiKey(headerValue?: string): string | undefined {
  return headerValue?.trim() || process.env.TTT_API_KEY?.trim() || undefined;
}
