// Optional production admission component. Import has no network/resource side effects.
// Business effect idempotency must be supplied by the final application integration.
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
export class ReplayStoreError extends Error {
  constructor(reason) { super(reason); this.name = 'ReplayStoreError'; this.httpStatus = 503; }
}
export function createMemoryDbReplayStore(config) {
  const { host, port = 6379, username, password, timeoutMs = 2000 } = config;
  if (typeof host !== 'string' || !host.endsWith('.memorydb.amazonaws.com') ||
      !Number.isInteger(port) || port < 1 || port > 65535 ||
      !username || !password || !Number.isInteger(timeoutMs) || timeoutMs < 1) {
    throw new ReplayStoreError('MEMORYDB_CONFIGURATION_REQUIRED');
  }
  const Redis = require('ioredis');
  const client = new Redis.Cluster([{ host, port }], {
    lazyConnect: true, scaleReads: 'master', enableOfflineQueue: false,
    clusterRetryStrategy: () => null,
    dnsLookup: (address, callback) => callback(null, address),
    redisOptions: { username, password, tls: { minVersion: 'TLSv1.2', rejectUnauthorized: true },
      connectTimeout: timeoutMs, commandTimeout: timeoutMs, maxRetriesPerRequest: 0,
      enableOfflineQueue: false, autoResendUnfulfilledCommands: false, retryStrategy: () => null },
  });
  // Do not log credentials or surface raw client exceptions to HTTP clients.
  client.on('error', () => {});
  let connected = false;
  return {
    async connect() { try { await client.connect(); connected = true; } catch { connected = false; client.disconnect(); throw new ReplayStoreError('MEMORYDB_UNAVAILABLE'); } },
    async claim({ domain, context, nonce, ttlMs }) {
      if (!/^[0-9a-f]{64}$/.test(domain) || !/^[0-9a-f]{32}$/.test(context) ||
          !/^[0-9a-f]{32}$/.test(nonce) || !Number.isSafeInteger(ttlMs) || ttlMs < 1 || ttlMs > 602_000) {
        throw new ReplayStoreError('INVALID_REPLAY_CLAIM');
      }
      // ioredis otherwise implicitly connects on the first SET even with lazyConnect.
      if (!connected || client.status !== 'ready') throw new ReplayStoreError('MEMORYDB_NOT_CONNECTED');
      const claimId = randomUUID();
      // Cluster routing follows the current shard primary; no GET-before-SET, replica read,
      // READONLY, transparent local fallback, or automatic retry after an ambiguous response.
      try {
        const result = await client.set(`tttps:v2:${domain}:${context}:${nonce}`, claimId, 'PX', ttlMs, 'NX');
        if (result === 'OK') return { status: 'new', claimId };
        if (result === null) return { status: 'already_seen' };
        throw new Error('unexpected response');
      } catch { throw new ReplayStoreError('MEMORYDB_CLAIM_UNCONFIRMED'); }
    },
    close() { connected = false; client.disconnect(); },
  };
}
