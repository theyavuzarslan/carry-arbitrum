import { mkdir, readFile, writeFile } from "node:fs/promises";
import type { PublicClient } from "viem";
import { getClient } from "./rpc.ts";
import { readAaveMarkets } from "./sources/aave.ts";
import { readDexDepth } from "./sources/dexdepth.ts";
import { fixCometEthPrices, readCompoundMarkets } from "./sources/compound.ts";
import { readGmx } from "./sources/gmx.ts";
import { readFundingReference } from "./sources/hyperliquid.ts";
import { readHoldYields, readLlamaLending } from "./sources/llama.ts";
import { readPendle } from "./sources/pendle.ts";
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

  return {
    asOf: new Date().toISOString(),
    lending: [...aave, ...compound, ...llama],
    perps: [...gmx.perps, ...refs],
    holdYields: holds,
    fixed: pendle,
    prices,
    dexDepthUsd,
    errors,
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
