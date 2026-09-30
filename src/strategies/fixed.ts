import type { Opportunity } from "../types.ts";
import { assemble, bestSupply, pct, risk, slug, type StrategyContext } from "./common.ts";

/**
 * Fixed-vs-floating carry: a Pendle PT locks its implied yield until expiry. We compare it with the
 * best floating stable yield the bot can execute; the spread is the carry for taking duration.
 * PTs are not collateral on Aave/Compound Arbitrum, so this is shown unlevered.
 */
export const fixedOpportunities = (ctx: StrategyContext): Opportunity[] => {
  const floating = ["USDC", "USDT"].map((s) => bestSupply(ctx.snap, s)).filter(Boolean).sort((a, b) => b!.supplyApr - a!.supplyApr)[0];
  return ctx.snap.fixed.map((f) => {
    const spread = f.impliedApr - (floating?.supplyApr ?? 0);
    const horizon = Math.min(ctx.horizonDays, f.daysToExpiry);
    return assemble({ ...ctx, horizonDays: horizon }, {
      id: slug("fixed-carry", f.name, f.expiry.slice(0, 10)),
      strategy: "fixed-carry",
      title: `PT-${f.name} fixed ${pct(f.impliedApr)} to ${f.expiry.slice(0, 10)}`,
      thesis: `Pendle PT-${f.name} locks ${pct(f.impliedApr)} for ${Math.round(f.daysToExpiry)} days, ${pct(spread)} over the best floating stable rate (${floating ? `${floating.venue} ${floating.symbol} ${pct(floating.supplyApr)}` : "n/a"}). Hold to expiry to realise it; selling early exposes you to rate moves.`,
      legs: [
        { action: "swap", venue: "pendle", symbol: `USDC→${f.name}`, weight: 1, apr: 0 },
        { action: "buy-pt", venue: "pendle", symbol: `PT-${f.name}`, weight: 1, apr: f.impliedApr, note: `${Math.round(f.daysToExpiry)}d to expiry` },
      ],
      capacityUsd: f.liquidityUsd * 0.05,
      riskFactors: [risk.asset(f.name), risk.capacity(f.liquidityUsd * 0.05), risk.venue("pendle"), { points: f.daysToExpiry > 90 ? 6 : 2, why: `${Math.round(f.daysToExpiry)}d duration` }],
      executable: false,
      whyNotExecutable: "Pendle swaps need calldata from Pendle's hosted router API; plan-only in this build",
      params: { market: f.market, pt: f.pt, expiry: f.expiry, floatingApr: floating?.supplyApr ?? 0, spreadApr: spread },
    });
  });
};
