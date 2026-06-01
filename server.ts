// @helm-protocol/ttt-mcp — openttt-server REST delegation.
//
// When an API key is configured, PoT processing is delegated to the live
// openttt-server, which enforces plan-based monthly quotas via the
// `X-TTT-API-Key` header. The server returns HTTP 429 when a plan quota is
// exceeded. The client never grants unlimited access locally — quota
// enforcement is authoritative on the server side.

// Public live endpoint. Confirmed via /etc/nginx/sites-enabled/tttps
// (server_name api.kenosian.com → tttps_cluster, location /pot/) and a live
// probe (GET https://api.kenosian.com/health → 200, /pot/stats → JSON).
// Overridable for self-hosted / on-prem deployments.
export const SERVER_BASE_URL = (
  process.env.OPENTTT_SERVER_URL?.trim() || "https://api.kenosian.com"
).replace(/\/+$/, "");

// Upgrade page shown to users who hit a quota limit.
// NOTE: must point at the product/checkout page — never pricing.html.
export const UPGRADE_URL = "https://kenosian.com/products/hydra-mcp.html";

export const UPGRADE_MESSAGE =
  `Plan quota reached. Upgrade your OpenTTT plan at ${UPGRADE_URL} to continue.`;

export const FREE_TIER_UPGRADE_MESSAGE =
  `Free tier limit reached (${process.env.FREE_TIER_LIMIT ?? "100"} calls/day). ` +
  `Set TTT_API_KEY with a paid plan, or upgrade at ${UPGRADE_URL}.`;

// Thrown when the server (or local free tier) signals quota exhaustion.
// Carries a user-facing upgrade message and the upgrade URL.
export class QuotaExceededError extends Error {
  readonly upgradeUrl: string;
  readonly tier: "free" | "paid";
  constructor(message: string, tier: "free" | "paid") {
    super(message);
    this.name = "QuotaExceededError";
    this.upgradeUrl = UPGRADE_URL;
    this.tier = tier;
  }
}

interface DelegateOptions {
  apiKey: string;
  method: "GET" | "POST";
  path: string; // e.g. "/pot/generate"
  body?: unknown; // for POST
  query?: Record<string, string | number | undefined>; // for GET
  timeoutMs?: number;
}

/**
 * Quota advisory extracted from openttt-server response headers.
 * Carries optional user-facing warning strings to surface alongside tool output.
 */
export interface QuotaAdvisory {
  /** Human-readable warning from X-RateLimit-Warning header, or auto-generated when ≥80% used */
  warning?: string;
  /** Set when the server indicates overage billing is active */
  overageActive?: boolean;
  /** Remaining calls in current plan period (informational) */
  remaining?: number;
  /** Total call limit for current plan period */
  limit?: number;
  /** Plan tier string from X-RateLimit-Tier header */
  tier?: string;
}

/**
 * Successful delegation result carrying the parsed JSON body plus any quota advisory.
 */
export interface DelegateResult {
  data: unknown;
  advisory?: QuotaAdvisory;
}

/** Parse rate-limit headers from an openttt-server 2xx response. */
function parseQuotaAdvisory(headers: Headers): QuotaAdvisory | undefined {
  const remaining = headers.get("x-ratelimit-remaining");
  const limit = headers.get("x-ratelimit-limit");
  const warningHeader = headers.get("x-ratelimit-warning");
  const overage = headers.get("x-ratelimit-overage");
  const tier = headers.get("x-ratelimit-tier");

  const advisory: QuotaAdvisory = {};
  let hasContent = false;

  if (tier) {
    advisory.tier = tier;
    hasContent = true;
  }

  if (remaining !== null) {
    advisory.remaining = parseInt(remaining, 10);
    hasContent = true;
  }

  if (limit !== null) {
    advisory.limit = parseInt(limit, 10);
    hasContent = true;
  }

  // Prefer explicit server-provided warning message
  if (warningHeader) {
    advisory.warning = warningHeader;
    hasContent = true;
  } else if (advisory.remaining !== undefined && advisory.limit !== undefined && advisory.limit > 0) {
    // Auto-generate "approaching limit" when ≥80% consumed and server sent no explicit warning
    const usedRatio = 1 - advisory.remaining / advisory.limit;
    if (usedRatio >= 0.8) {
      advisory.warning = `Approaching plan limit: ${advisory.remaining} of ${advisory.limit} calls remaining this period.`;
      hasContent = true;
    }
  }

  if (overage?.toLowerCase() === "true") {
    advisory.overageActive = true;
    hasContent = true;
  }

  return hasContent ? advisory : undefined;
}

function buildUrl(path: string, query?: DelegateOptions["query"]): string {
  const url = new URL(SERVER_BASE_URL + path);
  if (query) {
    for (const [k, v] of Object.entries(query)) {
      if (v !== undefined && v !== null) url.searchParams.set(k, String(v));
    }
  }
  return url.toString();
}

/**
 * Delegate a PoT operation to openttt-server with the caller's API key.
 *
 * - Sends `X-TTT-API-Key` so the server enforces the plan's monthly quota.
 * - On HTTP 429 → throws QuotaExceededError("paid") with the upgrade message.
 * - On other non-2xx → throws a plain Error with the server message.
 * - On 2xx → returns DelegateResult { data, advisory? }.
 *   advisory carries quota warning/overage info extracted from response headers
 *   so callers can surface it to the user without altering the normal result.
 */
export async function delegateToServer(opts: DelegateOptions): Promise<DelegateResult> {
  const { apiKey, method, path, body, query, timeoutMs = 8000 } = opts;
  const url = buildUrl(path, query);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let resp: Response;
  try {
    resp = await fetch(url, {
      method,
      headers: {
        "X-TTT-API-Key": apiKey,
        ...(method === "POST" ? { "Content-Type": "application/json" } : {}),
      },
      ...(method === "POST" ? { body: JSON.stringify(body ?? {}) } : {}),
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timer);
  }

  if (resp.status === 429) {
    throw new QuotaExceededError(UPGRADE_MESSAGE, "paid");
  }

  if (!resp.ok) {
    let detail = `HTTP ${resp.status}`;
    try {
      const j = (await resp.json()) as { error?: string };
      if (j?.error) detail = j.error;
    } catch {
      /* non-JSON error body */
    }
    throw new Error(`openttt-server error: ${detail}`);
  }

  const advisory = parseQuotaAdvisory(resp.headers);

  let data: unknown;
  try {
    data = await resp.json();
  } catch {
    data = {};
  }

  return advisory ? { data, advisory } : { data };
}
