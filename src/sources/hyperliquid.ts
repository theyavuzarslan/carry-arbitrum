import { HYPERLIQUID_API } from "../config.ts";
import type { PerpMarket } from "../types.ts";

/**
 * Cross-venue funding reference from Hyperliquid's `predictedFundings`, which also reports Binance
 * and Bybit. These venues are not on Arbitrum, so rows are marked non-executable: they are the
 * yardstick that tells us whether GMX funding is rich or cheap relative to the rest of the market.
 * Funding rate r per interval of h hours: longs pay r. Annualized long carry = -r * (8760 / h).
 */
type Entry = [string, { fundingRate: string; nextFundingTime: number; fundingIntervalHours: number } | null];

const VENUE: Record<string, string> = { HlPerp: "hyperliquid", BinPerp: "binance", BybitPerp: "bybit" };

export const readFundingReference = async (symbols?: Set<string>): Promise<PerpMarket[]> => {
  const res = await fetch(HYPERLIQUID_API, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ type: "predictedFundings" }),
    signal: AbortSignal.timeout(20_000),
  });
  if (!res.ok) throw new Error(`hyperliquid ${res.status}`);
  const data = (await res.json()) as [string, Entry[]][];
  const out: PerpMarket[] = [];
  for (const [coin, venues] of data) {
    if (symbols && !symbols.has(coin)) continue;
    for (const [v, e] of venues) {
      if (!e || !VENUE[v]) continue;
      const annual = Number(e.fundingRate) * (8760 / e.fundingIntervalHours);
      out.push({
        venue: VENUE[v]!, symbol: coin, name: `${coin}-PERP`, markPx: 0,
        longCarryApr: -annual, shortCarryApr: annual,
        openInterestLongUsd: 0, openInterestShortUsd: 0, availableLongUsd: 0, availableShortUsd: 0,
        executable: false, source: "hyperliquid-api",
      });
    }
  }
  return out;
};
