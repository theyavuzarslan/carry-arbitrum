import { PENDLE_API, CHAIN_ID } from "../config.ts";
import { getJson } from "../rpc.ts";
import type { Address, FixedYieldMarket } from "../types.ts";

interface Row {
  name: string; address: Address; expiry: string; pt: string; underlyingAsset: string;
  details: { liquidity: number; impliedApy: number; underlyingApy?: number; aggregatedApy?: number };
}

const strip = (id: string): Address => id.split("-")[1] as Address;

/** Active Pendle PT markets on Arbitrum. The PT locks `impliedApr` until expiry. */
export const readPendle = async (minLiquidityUsd = 1_000_000): Promise<FixedYieldMarket[]> => {
  const res = await getJson<{ markets: Row[] }>(`${PENDLE_API}/v1/${CHAIN_ID}/markets/active`);
  const now = Date.now();
  return res.markets
    .filter((m) => m.details.liquidity >= minLiquidityUsd)
    .map((m) => {
      const days = (Date.parse(m.expiry) - now) / 86_400_000;
      return {
        venue: "pendle" as const,
        name: m.name,
        market: m.address,
        pt: strip(m.pt),
        underlying: strip(m.underlyingAsset),
        impliedApr: m.details.impliedApy,
        underlyingApr: m.details.underlyingApy ?? 0,
        liquidityUsd: m.details.liquidity,
        expiry: m.expiry,
        daysToExpiry: days,
      };
    })
    .filter((m) => m.daysToExpiry > 3);
};
