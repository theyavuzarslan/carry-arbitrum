import { createPublicClient, fallback, http, type PublicClient } from "viem";
import { arbitrum } from "viem/chains";
import { RPC_URLS } from "./config.ts";

let client: PublicClient | undefined;

/** One shared client with RPC fallback and multicall batching (Multicall3 is on Arbitrum). */
export const getClient = (urls: string[] = RPC_URLS): PublicClient => {
  if (client) return client;
  client = createPublicClient({
    chain: arbitrum,
    batch: { multicall: { batchSize: 2048, wait: 16 } },
    transport: fallback(urls.map((u) => http(u, { timeout: 20_000, retryCount: 2 })), { rank: false }),
  }) as PublicClient;
  return client;
};

/** For fork mode: a client pointed at a single local URL. */
export const clientFor = (url: string): PublicClient =>
  createPublicClient({ chain: arbitrum, batch: { multicall: true }, transport: http(url, { timeout: 60_000 }) }) as PublicClient;

/** fetch JSON with a timeout and a readable error. */
export const getJson = async <T = unknown>(url: string, init?: RequestInit & { timeoutMs?: number }): Promise<T> => {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), init?.timeoutMs ?? 20_000);
  try {
    const res = await fetch(url, { ...init, signal: ctrl.signal });
    if (!res.ok) throw new Error(`${res.status} ${res.statusText} from ${url}`);
    return (await res.json()) as T;
  } finally {
    clearTimeout(t);
  }
};
