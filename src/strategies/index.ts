import type { MarketSnapshot, Opportunity } from "../types.ts";
import { securityOf } from "../guardrails/index.ts";
import { basisOpportunities, reverseBasisOpportunities } from "./basis.ts";
import { carryOpportunities } from "./carry.ts";
import { makeContext, type StrategyContext } from "./common.ts";
import { fixedOpportunities } from "./fixed.ts";
import { loopOpportunities } from "./loop.ts";
import { spreadOpportunities } from "./spread.ts";
import { xchainBasisOpportunities, xchainYieldOpportunities } from "./xchain.ts";
import { cexDexArbs, xchainArbs } from "./arb.ts";

/** Risk-adjusted APR used for ranking: net carry discounted by the risk score. */
export const riskAdjusted = (o: Opportunity): number => o.netApr * (1 - o.risk.score / 150);
// One-off arbitrage edges are not yearly rates: listed after the carry trades, ranked among themselves.
const isOneOff = (o: Opportunity) => o.params.oneOff === true;

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
    ...xchainBasisOpportunities(ctx),
    ...xchainYieldOpportunities(ctx),
    ...cexDexArbs(ctx),
    ...xchainArbs(ctx),
  ];
  // Token-security gate: a GoPlus block makes a trade non-executable and adds risk; it stays visible
  // so the user sees why. Unverified tokens add risk points.
  for (const x of all) {
    const sec = securityOf(x, snap);
    const blocked = sec.filter((s) => s.v.verdict === "block");
    const unverified = sec.filter((s) => s.v.verdict === "unverified");
    if (blocked.length) {
      x.executable = false;
      x.whyNotExecutable = `token security (GoPlus): ${blocked.map((b) => `${b.token}: ${b.v.reasons.join(", ")}`).join("; ")}`;
      x.risk.score = Math.min(100, x.risk.score + 40);
      x.risk.factors.unshift(`token security block: ${blocked.map((b) => b.token).join(", ")} (+40)`);
    } else if (unverified.length) {
      x.risk.score = Math.min(100, x.risk.score + 8);
      x.risk.factors.push(`token security unverified: ${unverified.map((u) => u.token).join(", ")} (+8)`);
    }
    x.risk.grade = x.risk.score < 25 ? "A" : x.risk.score < 45 ? "B" : x.risk.score < 65 ? "C" : "D";
  }
  const minNet = o.minNetApr ?? 0;
  const minCap = o.minCapacityUsd ?? 10_000;
  return all
    .filter((x) => Number.isFinite(x.netApr) && x.netApr > minNet && x.capacityUsd >= minCap && (!o.executableOnly || x.executable))
    .sort((a, b) => Number(isOneOff(a)) - Number(isOneOff(b)) || riskAdjusted(b) - riskAdjusted(a));
};
