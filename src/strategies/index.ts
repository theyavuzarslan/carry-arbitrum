import type { MarketSnapshot, Opportunity } from "../types.ts";
import { basisOpportunities, reverseBasisOpportunities } from "./basis.ts";
import { carryOpportunities } from "./carry.ts";
import { makeContext, type StrategyContext } from "./common.ts";
import { fixedOpportunities } from "./fixed.ts";
import { loopOpportunities } from "./loop.ts";
import { spreadOpportunities } from "./spread.ts";

/** Risk-adjusted APR used for ranking: net carry discounted by the risk score. */
export const riskAdjusted = (o: Opportunity): number => o.netApr * (1 - o.risk.score / 150);

export interface ScanOptions extends Partial<Omit<StrategyContext, "snap">> {
  minNetApr?: number;
  minCapacityUsd?: number;
  executableOnly?: boolean;
}

export const scanMarket = (snap: MarketSnapshot, o: ScanOptions = {}): Opportunity[] => {
  const ctx = makeContext(snap, o);
  const all = [
    ...basisOpportunities(ctx),
    ...reverseBasisOpportunities(ctx),
    ...carryOpportunities(ctx),
    ...loopOpportunities(ctx),
    ...fixedOpportunities(ctx),
    ...spreadOpportunities(ctx),
  ];
  const minNet = o.minNetApr ?? 0;
  const minCap = o.minCapacityUsd ?? 10_000;
  return all
    .filter((x) => Number.isFinite(x.netApr) && x.netApr > minNet && x.capacityUsd >= minCap && (!o.executableOnly || x.executable))
    .sort((a, b) => riskAdjusted(b) - riskAdjusted(a));
};
