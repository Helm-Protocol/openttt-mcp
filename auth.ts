// @helm-protocol/ttt-mcp — Free tier rate limit structure
// FREE_TIER_LIMIT calls/day per IP (default: 100)
// API key present → tier "paid", BUT NOT unlimited locally. Quota is enforced
// authoritatively by openttt-server (plan-based monthly quota via the
// X-TTT-API-Key header). The client must NOT grant a local unlimited pass.

import * as fs from "fs";
import * as path from "path";
import * as os from "os";

export const FREE_TIER_LIMIT = parseInt(process.env.FREE_TIER_LIMIT ?? "100", 10);

const USAGE_DIR = path.join(os.homedir(), ".ttt-mcp");
const USAGE_FILE = path.join(USAGE_DIR, "usage.json");

// In-memory counter for HTTP mode: ip → { count, resetAt }
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

function readUsageFile(): BucketEntry {
  try {
    if (!fs.existsSync(USAGE_DIR)) fs.mkdirSync(USAGE_DIR, { recursive: true });
    if (fs.existsSync(USAGE_FILE)) {
      return JSON.parse(fs.readFileSync(USAGE_FILE, "utf8")) as BucketEntry;
    }
  } catch { /* ignore */ }
  return { count: 0, resetAt: nextMidnightUtc() };
}

function writeUsageFile(entry: BucketEntry): void {
  try {
    if (!fs.existsSync(USAGE_DIR)) fs.mkdirSync(USAGE_DIR, { recursive: true });
    fs.writeFileSync(USAGE_FILE, JSON.stringify(entry), "utf8");
  } catch { /* ignore write errors */ }
}

/**
 * Check whether a call should be allowed.
 *
 * For stdio mode (clientIp === "stdio"): persists daily counter to ~/.ttt-mcp/usage.json
 * For HTTP mode (real IP): uses in-memory bucket (fast, per-process)
 *
 * @param apiKey   - API key (undefined = anonymous free tier)
 * @param clientIp - caller IP or "stdio" for local MCP process
 */
export function checkRateLimit(
  apiKey: string | undefined,
  clientIp: string
): { allowed: boolean; remaining: number; tier: "free" | "paid"; serverDelegated?: boolean } {
  // API key present: this client does NOT enforce or bypass quota locally.
  // The request is delegated to openttt-server, which enforces the plan's
  // monthly quota and returns HTTP 429 when exceeded. `remaining: -1` here
  // means "not locally counted" — it is NOT an unlimited grant.
  if (apiKey && apiKey.trim().length > 0) {
    return { allowed: true, remaining: -1, tier: "paid", serverDelegated: true };
  }

  const now = Date.now();

  // stdio mode: file-based persistence (survives server restart)
  if (clientIp === "stdio") {
    let entry = readUsageFile();
    if (now >= entry.resetAt) {
      entry = { count: 0, resetAt: nextMidnightUtc() };
    }
    if (entry.count >= FREE_TIER_LIMIT) {
      return { allowed: false, remaining: 0, tier: "free" };
    }
    entry.count += 1;
    writeUsageFile(entry);
    return { allowed: true, remaining: FREE_TIER_LIMIT - entry.count, tier: "free" };
  }

  // HTTP mode: in-memory bucket
  const bucketKey = `ip:${clientIp}`;
  let entry = buckets.get(bucketKey);
  if (!entry || now >= entry.resetAt) {
    entry = { count: 0, resetAt: nextMidnightUtc() };
    buckets.set(bucketKey, entry);
  }
  if (entry.count >= FREE_TIER_LIMIT) {
    return { allowed: false, remaining: 0, tier: "free" };
  }
  entry.count += 1;
  return { allowed: true, remaining: FREE_TIER_LIMIT - entry.count, tier: "free" };
}

/**
 * Extract API key from environment or request headers.
 * In stdio mode there are no HTTP headers — reads TTT_API_KEY env var.
 */
export function resolveApiKey(headerValue?: string): string | undefined {
  return headerValue?.trim() || process.env.TTT_API_KEY?.trim() || undefined;
}
