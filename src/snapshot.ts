import { mkdir, readFile, writeFile } from "node:fs/promises";
import type { PublicClient } from "viem";
import { getClient } from "./rpc.ts";
import { readAaveMarkets } from "./sources/aave.ts";
import { readDexDepth } from "./sources/dexdepth.ts";
import { readCexDex } from "./sources/arb.ts";
import { fixCometEthPrices, readCompoundMarkets } from "./sources/compound.ts";
import { readGmx } from "./sources/gmx.ts";
import { readFundingReference } from "./sources/hyperliquid.ts";
import { readHoldYields, readLlamaLending } from "./sources/llama.ts";
import { readPendle } from "./sources/pendle.ts";
import { matchSpots, quoteBridges, readEcoTokens, readEcoYields, type EcoSnapshot } from "./sources/xchain.ts";
import { ECO_CHAINS } from "./chains.ts";
import { PERP_TO_SPOT, TOKENS } from "./config.ts";
import { checkTokens, GOPLUS_CHAINS } from "./guardrails/tokenSecurity.ts";
import type { MarketSnapshot } from "./types.ts";

const STATE_DIR = new URL("../.state/", import.meta.url);
const CACHE = new URL("snapshot.json", STATE_DIR);

const settle = async <T>(name: string, p: Promise<T>, errors: string[], fallback: T): Promise<T> => {
  try {
    return await p;
  } catch (e) {
    errors.push(`${name}: ${(e as Error).message.split("\n")[0]}`);
    return fallback;
  }
};

/**
 * Read every source in parallel. A failing source is recorded in `errors` and the scan continues
 * with what it has, so one flaky API never blanks the board.
 */
export const takeSnapshot = async (client: PublicClient = getClient()): Promise<MarketSnapshot> => {
  const errors: string[] = [];
  const [aave, compound, gmx, llama, holds, pendle] = await Promise.all([
    settle("aave-v3", readAaveMarkets(client), errors, []),
    settle("compound-v3", readCompoundMarkets(client), errors, []),
    settle("gmx-v2", readGmx(), errors, { perps: [], prices: {}, tokens: [] }),
    settle("defillama", readLlamaLending(), errors, []),
    settle("staking", readHoldYields(), errors, []),
    settle("pendle", readPendle(), errors, []),
  ]);
  const symbols = new Set(gmx.perps.map((p) => p.symbol));
  const refs = await settle("hyperliquid", readFundingReference(symbols), errors, []);

  const prices: Record<string, number> = {};
  for (const [s, px] of Object.entries(gmx.prices)) prices[s] = px;
  for (const m of aave) if (m.priceUsd) prices[m.symbol] ??= m.priceUsd;
  prices.WETH ??= prices.ETH!;
  prices.ETH ??= prices.WETH!;
  prices.WBTC ??= prices.BTC!;
  if (prices.ETH) fixCometEthPrices(compound, prices.ETH);
  const dexDepthUsd = await settle("uniswap-depth", readDexDepth(client, prices), errors, {});
  const eco = await settle("ecosystem-chains", readEco(gmx.perps), errors, undefined);
  const cexDex = await settle("binance-arb", readCexDex(client, prices), errors, []);
  // Token security for everything the bot can hold: Arbitrum tokens, ecosystem spot and yield tokens.
  const secTargets = [
    ...Object.values(TOKENS).map((a) => ({ chainId: 42161, address: a })),
    ...aave.filter((m) => m.asset).map((m) => ({ chainId: 42161, address: m.asset })),
    ...(eco?.spots ?? []).map((s) => ({ chainId: s.chainId, address: s.token.address })),
    ...(eco?.yields ?? []).filter((y) => GOPLUS_CHAINS.has(y.chainId)).map((y) => ({ chainId: y.chainId, address: y.token.address })),
  ];
  const security = process.env.CARRY_SECURITY === "0" ? {} : await settle("goplus", checkTokens(secTargets), errors, {});

  return {
    asOf: new Date().toISOString(),
    lending: [...aave, ...compound, ...llama],
    perps: [...gmx.perps, ...refs],
    holdYields: holds,
    fixed: pendle,
    prices,
    dexDepthUsd,
    eco,
    arb: { cexDex },
    security,
    errors,
  };
};

const MAX_ECO_YIELD_QUOTES = Number(process.env.CARRY_ECO_YIELD_QUOTES ?? 6);

/**
 * Ecosystem-chain layer: tokens and yields on Robinhood Chain, Plume, ApeChain, Gravity and Nova,
 * GMX perps whose spot only exists there, and live bridge quotes for each. Off by CARRY_XCHAIN=0.
 */
const readEco = async (perps: import("./types.ts").PerpMarket[]): Promise<EcoSnapshot | undefined> => {
  if (process.env.CARRY_XCHAIN === "0") return undefined;
  const tokens = await readEcoTokens();
  const spots = matchSpots(perps, tokens, (sym) => sym in PERP_TO_SPOT);
  const yields = await readEcoYields(tokens).catch(() => []);
  // Each chain's main stablecoin: the fallback route when a vault token is not deliverable in one hop.
  const stables = ECO_CHAINS.map((c) => tokens.find((t) => t.chainId === c.id && /^(USDG|USDC)$/.test(t.symbol)) ?? tokens.find((t) => t.chainId === c.id && /^USDT$/.test(t.symbol))).filter((t): t is NonNullable<typeof t> => !!t);
  const quoteTargets = [
    ...stables.map((t) => ({ chainId: t.chainId, token: t.address })),
    ...spots.map((s) => ({ chainId: s.chainId, token: s.token.address })),
    ...yields.filter((y) => y.ccy === "USD").sort((a, b) => b.apr - a.apr).slice(0, MAX_ECO_YIELD_QUOTES).map((y) => ({ chainId: y.chainId, token: y.token.address })),
  ];
  const quotes = await quoteBridges(quoteTargets);
  return {
    chains: ECO_CHAINS.map((c) => ({ id: c.id, name: c.name, tokens: tokens.filter((t) => t.chainId === c.id).length })),
    spots, yields, quotes,
    stables: Object.fromEntries(stables.map((t) => [t.chainId, t])),
  };
};

/** Snapshot with a short on-disk cache so the CLI, bot and server do not hammer public RPCs. */
export const getSnapshot = async (opts: { maxAgeMs?: number; client?: PublicClient } = {}): Promise<MarketSnapshot> => {
  const maxAge = opts.maxAgeMs ?? 60_000;
  try {
    const cached = JSON.parse(await readFile(CACHE, "utf8")) as MarketSnapshot;
    if (Date.now() - Date.parse(cached.asOf) < maxAge) return cached;
  } catch {
    /* no cache yet */
  }
  const snap = await takeSnapshot(opts.client);
  await mkdir(STATE_DIR, { recursive: true });
  await writeFile(CACHE, JSON.stringify(snap));
  return snap;
};
