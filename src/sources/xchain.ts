import { mkdir, readFile, writeFile } from "node:fs/promises";
import { ARBITRUM_ONE, ECO_CHAINS, SPOT_ALIASES, chainById } from "../chains.ts";
import { FEES, LLAMA_YIELDS, TOKENS } from "../config.ts";
import { getJson } from "../rpc.ts";
import { isStable, normalizeSymbol } from "../tokens.ts";
import type { Address, Hex, PerpMarket } from "../types.ts";

const LIFI = process.env.LIFI_API_URL ?? "https://li.quest/v1";
const lifiHeaders = (): Record<string, string> => (process.env.LIFI_API_KEY ? { "x-lifi-api-key": process.env.LIFI_API_KEY } : {});

export interface EcoToken { chainId: number; symbol: string; address: Address; decimals: number; priceUsd: number; name: string }

/** A spot asset on an ecosystem chain that hedges a GMX perp whose spot is not on Arbitrum One. */
export interface EcoSpot {
  perpSymbol: string;
  perpName: string;
  chainId: number;
  chain: string;
  token: EcoToken;
  match: "exact" | "proxy";
  kind: "stock" | "commodity" | "crypto";
  priceGapPct: number; // token price vs GMX mark (exact matches only)
}

/** A yield on an ecosystem chain whose token LI.FI can deliver straight from Arbitrum One. */
export interface EcoYield {
  chainId: number;
  chain: string;
  project: string;
  symbol: string;
  apr: number;          // base APY only; incentives are excluded
  rewardApr: number;
  tvlUsd: number;
  ccy: "USD" | "ETH" | "OTHER";
  token: EcoToken;      // the token to bridge into (vault share or the yield-bearing token)
}

export interface BridgeQuote {
  key: string;
  fromChainId: number;
  toChainId: number;
  fromToken: Address;
  toToken: Address;
  fromAmountUsd: number;
  toAmountUsd: number;
  costFraction: number;     // 1 - out/in in USD, one way, all fees included
  durationSec: number;
  tool: string;
  asOf: string;
  /** Measured depth: largest tested size (USD) whose one-way cost stayed under 1.5%. */
  depthUsd?: number;
}

export interface EcoSnapshot {
  chains: { id: number; name: string; tokens: number }[];
  spots: EcoSpot[];
  yields: EcoYield[];
  quotes: Record<string, BridgeQuote>;
  /** chainId → that chain's main stablecoin (USDG/USDC/USDT), used for two-step routes. */
  stables?: Record<number, EcoToken>;
}

/** Every LI.FI-listed token on the ecosystem chains, with LI.FI's USD price. */
export const readEcoTokens = async (): Promise<EcoToken[]> => {
  const ids = ECO_CHAINS.map((c) => c.id).join(",");
  const res = await getJson<{ tokens: Record<string, { symbol: string; address: Address; decimals: number; priceUSD?: string; name: string }[]> }>(`${LIFI}/tokens?chains=${ids}`, { headers: lifiHeaders(), timeoutMs: 30_000 });
  return Object.entries(res.tokens).flatMap(([cid, list]) => list.map((t) => ({ chainId: Number(cid), symbol: t.symbol, address: t.address, decimals: t.decimals, priceUsd: Number(t.priceUSD ?? 0), name: t.name })));
};

/** GMX perps with no Arbitrum One spot, matched to a token on an ecosystem chain. */
export const matchSpots = (perps: PerpMarket[], tokens: EcoToken[], hasArbSpot: (symbol: string) => boolean): EcoSpot[] => {
  const out: EcoSpot[] = [];
  for (const p of perps.filter((x) => x.venue === "gmx-v2" && x.markPx > 0)) {
    if (hasArbSpot(p.symbol)) continue;
    const alias = SPOT_ALIASES[p.symbol];
    if (!alias) continue;
    for (const t of tokens.filter((x) => alias.symbols.includes(x.symbol.toUpperCase()) || alias.symbols.includes(x.symbol))) {
      const gap = t.priceUsd ? (t.priceUsd / p.markPx - 1) * 100 : NaN;
      // An exact match must price like the perp's index; otherwise it is not the same asset.
      if (alias.match === "exact" && !(Math.abs(gap) <= 3)) continue;
      out.push({ perpSymbol: p.symbol, perpName: p.name, chainId: t.chainId, chain: chainById(t.chainId)!.name, token: t, match: alias.match, kind: alias.kind, priceGapPct: Number.isFinite(gap) ? gap : 0 });
    }
  }
  return out;
};

interface Pool { pool: string; chain: string; project: string; symbol: string; tvlUsd: number; apyBase: number | null; apyReward: number | null; underlyingTokens?: string[] | null }

/**
 * Yields on ecosystem chains (DefiLlama) joined to a deliverable token (LI.FI list). The token is
 * found by the pool's symbol; pools whose share token LI.FI cannot deliver are dropped, because the
 * bot could not enter them in one hop.
 */
export const readEcoYields = async (tokens: EcoToken[], minTvlUsd = 1_000_000): Promise<EcoYield[]> => {
  const pools = await getJson<{ data: Pool[] }>(`${LLAMA_YIELDS}/pools`, { timeoutMs: 40_000 });
  const byLlama = new Map(ECO_CHAINS.map((c) => [c.llamaName, c]));
  const out: EcoYield[] = [];
  for (const p of pools.data) {
    const c = byLlama.get(p.chain);
    if (!c || p.tvlUsd < minTvlUsd || !(p.apyBase && p.apyBase > 0) || p.symbol.includes("-")) continue;
    const tok = tokens.find((t) => t.chainId === c.id && t.symbol.toUpperCase() === p.symbol.toUpperCase());
    if (!tok) continue;
    const under = (p.underlyingTokens ?? []).map((u) => tokens.find((t) => t.chainId === c.id && t.address.toLowerCase() === u.toLowerCase())?.symbol ?? "");
    // USD if the token or its underlying is a stable; Nest-style RWA vault shares with no listed
    // underlying are inferred USD when they price near $1 (share value drifts up with yield).
    const ccy = isStable(normalizeSymbol(tok.symbol)) || under.some((s) => isStable(normalizeSymbol(s))) || /USD/i.test(tok.symbol) || (tok.priceUsd >= 0.95 && tok.priceUsd <= 1.35) ? "USD" : /ETH/i.test(tok.symbol) ? "ETH" : "OTHER";
    out.push({ chainId: c.id, chain: c.name, project: p.project, symbol: tok.symbol, apr: p.apyBase / 100, rewardApr: (p.apyReward ?? 0) / 100, tvlUsd: p.tvlUsd, ccy, token: tok });
  }
  return out;
};

// ---------------------------------------------------------------- bridge quotes

export interface LifiQuote {
  estimate: { fromAmountUSD?: string; toAmountUSD?: string; toAmount: string; toAmountMin: string; executionDuration: number; approvalAddress: Address };
  transactionRequest: { to: Address; data: Hex; value: string; gasLimit?: string };
  tool: string;
}

/** A live LI.FI quote from Arbitrum One. With a real fromAddress the returned transaction is sendable. */
export const lifiQuote = async (a: { toChainId: number; fromToken: Address; toToken: Address; fromAmount: bigint; fromAddress: Address; slippage?: number }): Promise<LifiQuote> => {
  const q = new URLSearchParams({
    fromChain: String(ARBITRUM_ONE), toChain: String(a.toChainId), fromToken: a.fromToken, toToken: a.toToken,
    fromAmount: a.fromAmount.toString(), fromAddress: a.fromAddress, slippage: String(a.slippage ?? 0.005),
  });
  // Carry's integrator fee, paid at execution through LI.FI's fee forwarder (config FEES).
  if (FEES.lifiIntegrator) { q.set("integrator", FEES.lifiIntegrator); q.set("fee", String(FEES.lifiFeeBps / 1e4)); }
  const res = await fetch(`${LIFI}/quote?${q}`, { headers: lifiHeaders(), signal: AbortSignal.timeout(40_000) });
  const body = (await res.json()) as LifiQuote & { message?: string };
  if (!res.ok || !body.transactionRequest) throw new Error(`LI.FI quote failed: ${body.message ?? res.status}`);
  return body;
};

const QUOTE_CACHE = new URL("../../.state/bridge-quotes.json", import.meta.url);
const QUOTE_TTL_MS = 15 * 60_000;
const PROBE_ADDR = "0x000000000000000000000000000000000000dEaD" as Address;

const loadCache = async (): Promise<Record<string, BridgeQuote>> => {
  try { return JSON.parse(await readFile(QUOTE_CACHE, "utf8")); } catch { return {}; }
};

/**
 * Price the bridge for each destination token: a quote at $1k, $10k and $50k from USDC on
 * Arbitrum One. One-way cost comes from the $10k quote; depth is the largest size under 1.5%.
 * Cached for 15 minutes: LI.FI's keyless tier is rate-limited.
 */
export const quoteBridges = async (targets: { chainId: number; token: Address }[]): Promise<Record<string, BridgeQuote>> => {
  const cache = await loadCache();
  const out: Record<string, BridgeQuote> = {};
  const uniq = [...new Map(targets.map((t) => [`${t.chainId}:${t.token.toLowerCase()}`, t])).values()];
  // Three targets at a time: fast enough, and polite to the keyless rate limit.
  const one = async (t: { chainId: number; token: Address }) => {
    const key = `${t.chainId}:${t.token.toLowerCase()}`;
    const c = cache[key];
    if (c && Date.now() - Date.parse(c.asOf) < QUOTE_TTL_MS) { out[key] = { ...c, costFraction: Math.max(0.0005, c.costFraction) }; return; }
    let base: BridgeQuote | undefined;
    let depth = 0;
    for (const usd of [10_000, 1_000, 50_000]) {
      try {
        const q = await lifiQuote({ toChainId: t.chainId, fromToken: TOKENS.USDC, toToken: t.token, fromAmount: BigInt(usd) * 1_000_000n, fromAddress: PROBE_ADDR });
        const inUsd = Number(q.estimate.fromAmountUSD ?? usd);
        const outUsd = Number(q.estimate.toAmountUSD ?? 0);
        // Floor at 5 bps: destination stables are sometimes priced above $1 by the quote API, which
        // would otherwise make a bridge look like it pays you.
        const cost = outUsd > 0 ? Math.max(0.0005, 1 - outUsd / inUsd) : 1;
        if (cost <= 0.015) depth = Math.max(depth, usd);
        if (usd === 10_000 || !base) base = { key, fromChainId: ARBITRUM_ONE, toChainId: t.chainId, fromToken: TOKENS.USDC, toToken: t.token, fromAmountUsd: inUsd, toAmountUsd: outUsd, costFraction: cost, durationSec: q.estimate.executionDuration, tool: q.tool, asOf: new Date().toISOString() };
      } catch {
        if (usd === 10_000) break; // no route at the reference size: skip the rest
      }
    }
    if (base) out[key] = { ...base, depthUsd: depth };
  };
  for (let i = 0; i < uniq.length; i += 3) await Promise.all(uniq.slice(i, i + 3).map(one));
  await mkdir(new URL("../../.state/", import.meta.url), { recursive: true });
  await writeFile(QUOTE_CACHE, JSON.stringify({ ...cache, ...out }));
  return out;
};

export const quoteKey = (chainId: number, token: Address) => `${chainId}:${token.toLowerCase()}`;

/** Poll LI.FI until a bridge transfer is DONE or FAILED on the destination chain. */
export const waitForBridge = async (txHash: Hex, timeoutMs = 15 * 60_000, log: (s: string) => void = () => {}): Promise<"DONE" | "FAILED" | "TIMEOUT"> => {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    try {
      const r = (await getJson<{ status: string; substatus?: string }>(`${LIFI}/status?txHash=${txHash}`, { headers: lifiHeaders() }));
      if (r.status === "DONE") return "DONE";
      if (r.status === "FAILED" || r.status === "INVALID") return "FAILED";
      log(`bridge ${txHash.slice(0, 10)}… ${r.status}${r.substatus ? ` (${r.substatus})` : ""}`);
    } catch { /* not indexed yet */ }
    await new Promise((r) => setTimeout(r, 10_000));
  }
  return "TIMEOUT";
};
