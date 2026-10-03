import { mkdir, readFile, writeFile } from "node:fs/promises";
import type { Address } from "../types.ts";

/**
 * Token security from GoPlus (https://gopluslabs.io), checked before any token enters a plan.
 * Supported here: Arbitrum One (42161), Robinhood Chain (4663), Gravity (1625). Tokens on other
 * chains come back "unverified", which live mode treats as a block.
 */
const GOPLUS = process.env.GOPLUS_API_URL ?? "https://api.gopluslabs.io/api/v1";
export const GOPLUS_CHAINS = new Set([42161, 4663, 1625]);
const CACHE = new URL("../../.state/goplus.json", import.meta.url);
const TTL_MS = 24 * 3_600_000;

export type Verdict = "pass" | "warn" | "block" | "unverified";
export interface TokenVerdict {
  chainId: number;
  address: Address;
  symbol?: string;
  verdict: Verdict;
  reasons: string[];
  /** Sum of DEX liquidity GoPlus reports for the token on that chain (USD). */
  dexLiquidityUsd?: number;
  checkedAt: string;
}

type Raw = Record<string, unknown> & { dex?: { liquidity?: string; name?: string }[]; token_symbol?: string };
const flag = (r: Raw, k: string) => r[k] === "1" || r[k] === 1;
const num = (r: Raw, k: string) => (r[k] === undefined || r[k] === null || r[k] === "" ? 0 : Number(r[k]));

let lastCall = 0;
const MAX_TAX = Number(process.env.CARRY_MAX_TOKEN_TAX ?? 0.005);

/** Turn a GoPlus record into a verdict. Hard failures block; admin powers common to majors warn. */
export const evaluate = (chainId: number, address: Address, r: Raw | undefined): TokenVerdict => {
  const base = { chainId, address, checkedAt: new Date().toISOString() };
  if (!r) return { ...base, verdict: GOPLUS_CHAINS.has(chainId) ? "unverified" : "unverified", reasons: [GOPLUS_CHAINS.has(chainId) ? "GoPlus returned no data for this token" : "GoPlus does not cover this chain"] };
  const block: string[] = [];
  const warn: string[] = [];
  if (flag(r, "is_honeypot")) block.push("honeypot: tokens cannot be sold");
  if (flag(r, "cannot_sell_all")) block.push("cannot sell the full balance");
  if (flag(r, "cannot_buy")) block.push("buying is disabled");
  if (num(r, "buy_tax") > MAX_TAX || num(r, "sell_tax") > MAX_TAX) block.push(`transfer tax ${(num(r, "buy_tax") * 100).toFixed(1)}% buy / ${(num(r, "sell_tax") * 100).toFixed(1)}% sell`);
  if (flag(r, "owner_change_balance")) block.push("owner can change balances");
  if (flag(r, "hidden_owner")) block.push("hidden owner");
  if (flag(r, "selfdestruct")) block.push("contract can self-destruct");
  if (flag(r, "slippage_modifiable") || flag(r, "personal_slippage_modifiable")) block.push("owner can change the tax");
  if (flag(r, "trading_cooldown")) block.push("trading cooldown");
  if (flag(r, "is_airdrop_scam")) block.push("airdrop scam");
  if (r.is_open_source === "0") block.push("contract source not verified");
  // Admin powers that nearly every major token has (USDC, USDT0, WETH, ARB are upgradeable proxies,
  // stablecoins can blacklist) are reported as information, not warnings: flagging them would make
  // every trade "warn" and hide the real signals.
  const info: string[] = [];
  if (flag(r, "is_proxy")) info.push("upgradeable proxy");
  if (flag(r, "is_blacklisted")) info.push("issuer can blacklist");
  if (flag(r, "transfer_pausable")) info.push("transfers pausable");
  if (flag(r, "is_mintable")) warn.push("mintable");
  if (flag(r, "external_call")) warn.push("calls external contracts on transfer");
  const dexLiquidityUsd = (r.dex ?? []).reduce((s, d) => s + Number(d.liquidity ?? 0), 0);
  const reasons = [...block, ...warn, ...(info.length ? [`admin powers (info): ${info.join(", ")}`] : [])];
  return { ...base, symbol: r.token_symbol, verdict: block.length ? "block" : warn.length ? "warn" : "pass", reasons, dexLiquidityUsd };
};

const load = async (): Promise<Record<string, TokenVerdict>> => {
  try { return JSON.parse(await readFile(CACHE, "utf8")); } catch { return {}; }
};

/** Check tokens (cached 24h). One request per token: GoPlus batches sometimes return a subset. */
export const checkTokens = async (tokens: { chainId: number; address: Address }[]): Promise<Record<string, TokenVerdict>> => {
  const cache = await load();
  const out: Record<string, TokenVerdict> = {};
  const key = (c: number, a: string) => `${c}:${a.toLowerCase()}`;
  const todo = [...new Map(tokens.map((t) => [key(t.chainId, t.address), t])).values()];
  for (const t of todo) {
    const k = key(t.chainId, t.address);
    const c = cache[k];
    if (c && Date.now() - Date.parse(c.checkedAt) < TTL_MS) { out[k] = c; continue; }
    if (!GOPLUS_CHAINS.has(t.chainId)) { out[k] = evaluate(t.chainId, t.address, undefined); continue; }
    try {
      // The keyless tier rate-limits bursts: pace requests and retry an empty answer once.
      let rec: Raw | undefined;
      for (let attempt = 0; attempt < 3 && !rec; attempt++) {
        if (attempt || lastCall) await new Promise((r) => setTimeout(r, Math.max(0, (attempt ? 6000 : 2200) - (Date.now() - lastCall))));
        lastCall = Date.now();
        const res = await fetch(`${GOPLUS}/token_security/${t.chainId}?contract_addresses=${t.address}`, { signal: AbortSignal.timeout(20_000) });
        const body = (await res.json()) as { code: number; message?: string; result?: Record<string, Raw> };
        rec = body.result?.[t.address.toLowerCase()];
        if (rec && Object.keys(rec).length === 0) rec = undefined;
      }
      const v = evaluate(t.chainId, t.address, rec);
      out[k] = v;
      if (v.verdict !== "unverified") cache[k] = v;
    } catch (e) {
      out[k] = { chainId: t.chainId, address: t.address, verdict: "unverified", reasons: [`GoPlus unreachable: ${(e as Error).message}`], checkedAt: new Date().toISOString() };
    }
  }
  await mkdir(new URL("../../.state/", import.meta.url), { recursive: true });
  await writeFile(CACHE, JSON.stringify(cache));
  return out;
};
