import { parseUnits, type PublicClient } from "viem";
import { bestRoute } from "../execution/uniswap.ts";
import { getClient } from "../rpc.ts";
import { tokenAddress } from "../tokens.ts";
import type { Address, MarketSnapshot, Opportunity } from "../types.ts";
import { checkTokens, type TokenVerdict, type Verdict } from "./tokenSecurity.ts";

export interface GuardCheck { name: string; verdict: Verdict; detail: string }
export interface GuardReport { verdict: "pass" | "warn" | "block"; checks: GuardCheck[]; capitalUsd: number; asOf: string }

const ARB = 42161;
const MAX_RT_LOSS_BLOCK = Number(process.env.CARRY_MAX_ROUNDTRIP_LOSS ?? 0.015);
const MAX_RT_LOSS_WARN = 0.006;
/** Tokens the operator has reviewed and accepts despite a GoPlus block, e.g. "42161:0xfc5a…". */
const ALLOW = new Set((process.env.CARRY_TOKEN_ALLOWLIST ?? "").split(",").map((s) => s.trim().toLowerCase()).filter(Boolean));

const addrOf = (snap: MarketSnapshot, symbol: string): Address | undefined =>
  tokenAddress(symbol) ?? (snap.lending.find((m) => m.symbol === symbol && m.asset && m.source === "onchain")?.asset as Address | undefined);

/** Every token a trade would hold, by chain. Synthetic exposures (perps, PTs) carry no token. */
export const tokensOf = (opp: Opportunity, snap: MarketSnapshot): { chainId: number; address: Address; symbol: string }[] => {
  const out: { chainId: number; address: Address; symbol: string }[] = [];
  const add = (symbol: string, chainId: number) => {
    if (!symbol || symbol.startsWith("PT-") || symbol === "USD" || symbol === "debt") return;
    if (chainId !== ARB) {
      if (opp.params.tokenSymbol === symbol && typeof opp.params.token === "string") out.push({ chainId, address: opp.params.token as Address, symbol });
      return;
    }
    const a = addrOf(snap, symbol);
    if (a) out.push({ chainId, address: a, symbol });
  };
  for (const l of opp.legs) {
    if (l.action.endsWith("perp")) continue;
    const chain = l.chainId ?? ARB;
    if (l.action === "swap" || l.action === "bridge") {
      const [a = "", b = ""] = l.symbol.split("→");
      add(a, l.action === "bridge" ? ARB : chain);
      add(b, chain);
    } else add(l.symbol, chain);
  }
  return [...new Map(out.map((t) => [`${t.chainId}:${t.address.toLowerCase()}`, t])).values()];
};

const secKey = (c: number, a: string) => `${c}:${a.toLowerCase()}`;

/** Token security verdicts for an opportunity from a snapshot's cached checks (no network). */
export const securityOf = (opp: Opportunity, snap: MarketSnapshot): { token: string; v: TokenVerdict }[] =>
  tokensOf(opp, snap).flatMap((t) => {
    const v = snap.security?.[secKey(t.chainId, t.address)];
    if (!v) return [];
    const allowed = ALLOW.has(secKey(t.chainId, t.address)) && v.verdict === "block";
    return [{ token: t.symbol, v: allowed ? { ...v, verdict: "warn" as const, reasons: [`allowlisted by operator despite: ${v.reasons.join("; ")}`] } : v }];
  });

/**
 * Pre-trade guardrails at the actual size. Runs before any fork or live execution and inside every plan.
 *  1. Token security (GoPlus) for every token the trade would hold.
 *  2. Entry AND exit liquidity: Uniswap round trip at size, lending exit cash and utilization, borrow
 *     headroom, GMX open-interest headroom and exit impact, destination-chain DEX depth for bridged tokens.
 */
export const runGuardrails = async (opp: Opportunity, capitalUsd: number, snap: MarketSnapshot, client: PublicClient = getClient()): Promise<GuardReport> => {
  const checks: GuardCheck[] = [];
  // 1. Token security, fresh where the snapshot lacks it.
  const toks = tokensOf(opp, snap);
  const verdicts = await checkTokens(toks);
  for (const t of toks) {
    let v = verdicts[secKey(t.chainId, t.address)]!;
    if (v.verdict === "block" && ALLOW.has(secKey(t.chainId, t.address))) v = { ...v, verdict: "warn", reasons: [`allowlisted by operator despite: ${v.reasons.join("; ")}`] };
    checks.push({ name: `security ${t.symbol}${t.chainId !== ARB ? ` (chain ${t.chainId})` : ""}`, verdict: v.verdict, detail: v.reasons.join("; ") || "no issues found by GoPlus" });
  }
  // 2. Liquidity per leg.
  for (const l of opp.legs) {
    const usd = l.weight * capitalUsd;
    if (l.action === "swap" && l.venue === "uniswap-v3") {
      const [a = "", b = ""] = l.symbol.split("→");
      const A = addrOf(snap, a);
      const B = addrOf(snap, b);
      const pa = snap.prices[a] ?? (a === "WETH" ? snap.prices.ETH : undefined);
      if (!A || !B || !pa) { checks.push({ name: `liquidity ${l.symbol}`, verdict: "warn", detail: "could not price this pair" }); continue; }
      try {
        const dec = snap.lending.find((m) => m.symbol === a && m.decimals !== undefined)?.decimals ?? (a === "USDC" ? 6 : 18);
        const amtIn = parseUnits((usd / pa).toFixed(Math.min(dec, 12)), dec);
        const fwd = await bestRoute(client, A, B, amtIn);
        const back = await bestRoute(client, B, A, fwd.amountOut);
        const loss = 1 - Number(back.amountOut) / Number(amtIn);
        checks.push({ name: `entry+exit ${l.symbol}`, verdict: loss > MAX_RT_LOSS_BLOCK ? "block" : loss > MAX_RT_LOSS_WARN ? "warn" : "pass", detail: `round trip at $${Math.round(usd).toLocaleString()} loses ${(loss * 100).toFixed(2)}% (fees + impact, both directions quoted)` });
      } catch (e) {
        checks.push({ name: `entry+exit ${l.symbol}`, verdict: "block", detail: `no Uniswap route: ${(e as Error).message}` });
      }
    }
    if (l.action === "supply" && (l.venue === "aave-v3" || l.venue === "compound-v3")) {
      const m = snap.lending.find((x) => x.venue === l.venue && x.symbol === l.symbol && (l.venue === "aave-v3" || x.canBorrow));
      if (!m) continue; // Compound collateral can always be withdrawn while the loan is healthy
      const cash = Math.max(0, m.totalSupplyUsd - m.totalBorrowUsd);
      const util = m.totalSupplyUsd > 0 ? m.totalBorrowUsd / m.totalSupplyUsd : 0;
      checks.push({ name: `exit ${l.symbol} supply on ${l.venue}`, verdict: cash < usd ? "block" : cash < 5 * usd || util > 0.95 ? "warn" : "pass", detail: `$${Math.round(cash).toLocaleString()} withdrawable cash for a $${Math.round(usd).toLocaleString()} position, utilization ${(util * 100).toFixed(1)}%` });
    }
    if (l.action === "borrow") {
      const m = snap.lending.find((x) => x.venue === l.venue && x.symbol === l.symbol && x.canBorrow);
      if (m) checks.push({ name: `entry ${l.symbol} borrow on ${l.venue}`, verdict: m.availableUsd < usd ? "block" : m.availableUsd < 3 * usd ? "warn" : "pass", detail: `$${Math.round(m.availableUsd).toLocaleString()} borrowable for $${Math.round(usd).toLocaleString()}` });
    }
    if ((l.action === "short-perp" || l.action === "long-perp") && l.venue === "gmx-v2") {
      const p = snap.perps.find((x) => x.venue === "gmx-v2" && x.name === l.symbol);
      if (!p) continue;
      const room = l.action === "short-perp" ? p.availableShortUsd : p.availableLongUsd;
      const oi = p.openInterestLongUsd + p.openInterestShortUsd;
      checks.push({ name: `entry ${p.name}`, verdict: room < usd ? "block" : room < 3 * usd ? "warn" : "pass", detail: `$${Math.round(room).toLocaleString()} open-interest room for $${Math.round(usd).toLocaleString()}` });
      // A position that is a large share of open interest becomes the skew: GMX's adaptive funding
      // then turns against it, and closing it moves the price. Block above half, warn above 15%.
      const share = usd / Math.max(oi, 1);
      checks.push({ name: `size vs ${p.name} open interest`, verdict: share > 0.5 ? "block" : share > 0.15 ? "warn" : "pass", detail: `position would be ${(share * 100).toFixed(1)}% of open interest ($${Math.round(oi).toLocaleString()}); ${share > 0.5 ? "it would flip the skew, so the funding it is paid would turn against it" : "exit impact is acceptable"}` });
    }
    if (l.action === "bridge" && l.chainId) {
      const tok = toks.find((t) => t.chainId === l.chainId);
      const v = tok ? verdicts[secKey(tok.chainId, tok.address)] : undefined;
      const depth = v?.dexLiquidityUsd ?? 0;
      checks.push(depth
        ? { name: `exit ${tok!.symbol} on chain ${l.chainId}`, verdict: depth < 2 * usd ? "block" : depth < 10 * usd ? "warn" : "pass", detail: `$${Math.round(depth).toLocaleString()} DEX liquidity reported for $${Math.round(usd).toLocaleString()}; exit = sell there or bridge back via LI.FI` }
        : { name: `exit on chain ${l.chainId}`, verdict: "warn", detail: "destination DEX liquidity unknown; exit route back is not pre-quoted" });
    }
  }
  const verdict = checks.some((c) => c.verdict === "block") ? "block" : checks.some((c) => c.verdict === "warn" || c.verdict === "unverified") ? "warn" : "pass";
  return { verdict, checks, capitalUsd, asOf: new Date().toISOString() };
};

/** In live mode an unverified token is treated as a block unless CARRY_ALLOW_UNVERIFIED=1. */
export const blocksExecution = (r: GuardReport, mode: "plan" | "fork" | "live"): string[] =>
  r.checks.filter((c) => c.verdict === "block" || (mode === "live" && c.verdict === "unverified" && process.env.CARRY_ALLOW_UNVERIFIED !== "1")).map((c) => `${c.name}: ${c.detail}`);
