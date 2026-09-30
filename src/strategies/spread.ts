import type { Opportunity } from "../types.ts";
import { assemble, cexFunding, MAX_SANE_CARRY, pct, risk, slug, tradablePerps, type StrategyContext } from "./common.ts";

/**
 * Same asset, two venues: short where shorts are paid more, long where longs pay less (or are paid).
 * One leg is on GMX (Arbitrum); the other is on Hyperliquid / Binance / Bybit, so these are
 * signals, not executable trades. They cover the many GMX markets with no Arbitrum spot token.
 */
export const spreadOpportunities = (ctx: StrategyContext): Opportunity[] => {
  const out: Opportunity[] = [];
  const Lp = ctx.perpLeverage;
  const w = Lp / 2; // capital split across two margined legs
  for (const g of tradablePerps(ctx.snap)) {
    for (const dir of ["short-gmx", "long-gmx"] as const) {
      const gApr = dir === "short-gmx" ? g.shortCarryApr : g.longCarryApr;
      if (gApr >= MAX_SANE_CARRY) continue;
      // Hedge on whichever reference venue is cheapest for the opposite side.
      const r = cexFunding(ctx.snap, g.symbol).sort((a, b) => (dir === "short-gmx" ? b.longCarryApr - a.longCarryApr : b.shortCarryApr - a.shortCarryApr))[0];
      if (!r) continue;
      {
        const rApr = dir === "short-gmx" ? r.longCarryApr : r.shortCarryApr;
        const net = gApr + rApr;
        if (net < 0.05) continue;
        const cap = (dir === "short-gmx" ? g.availableShortUsd : g.availableLongUsd) / w;
        out.push(assemble(ctx, {
          id: slug("funding-spread", g.name, r.venue, dir),
          strategy: "funding-spread",
          title: `${g.symbol}: ${dir === "short-gmx" ? "short GMX / long" : "long GMX / short"} ${r.venue}`,
          thesis: `GMX ${g.name} ${dir === "short-gmx" ? "shorts" : "longs"} earn ${pct(gApr)}; the opposite side on ${r.venue} ${rApr >= 0 ? "earns" : "costs"} ${pct(Math.abs(rApr))}. Delta-neutral across venues for ${pct(net)} gross on the hedged notional.`,
          legs: [
            { action: dir === "short-gmx" ? "short-perp" : "long-perp", venue: "gmx-v2", symbol: g.name, weight: w, apr: gApr },
            { action: dir === "short-gmx" ? "long-perp" : "short-perp", venue: r.venue, symbol: `${g.symbol}-PERP`, weight: w, apr: rApr },
          ],
          capacityUsd: cap,
          riskFactors: [risk.offchainLeg(), risk.extremeFunding(gApr), risk.liquidation(0.9 / Lp), risk.capacity(cap), risk.asset(g.symbol), { points: 8, why: "funding on both venues resets hourly" }],
          liquidationMovePct: 0.9 / Lp,
          executable: false,
          whyNotExecutable: `${r.venue} leg is off Arbitrum`,
          params: { gmxMarket: g.gmx!.marketToken, gmxName: g.name, refVenue: r.venue, direction: dir },
        }));
      }
    }
  }
  return out;
};
