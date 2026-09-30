import type { Leg, Opportunity } from "../types.ts";
import { assemble, borrowRoutes, holdApr, pct, risk, slug, type StrategyContext } from "./common.ts";

const LSTS = ["wstETH", "weETH", "rsETH", "ezETH", "rETH"];
const LOOP_TARGET_HF = Number(process.env.CARRY_LOOP_HF ?? 1.1);
const LOOP_MAX_LEVERAGE = Number(process.env.CARRY_LOOP_MAX_LEVERAGE ?? 5);

/**
 * Leveraged staking carry: post an LST, borrow WETH in an ETH-correlated e-mode (or on the
 * cWETHv3 comet), swap to more LST, repeat. Carry = L*(staking + supply) - (L-1)*WETH borrow.
 * The health factor only moves with the LST/ETH exchange rate, so a tighter target is acceptable.
 * The CarryAccount contract opens this in one transaction with an Aave flash loan.
 */
export const loopOpportunities = (ctx: StrategyContext): Opportunity[] => {
  const out: Opportunity[] = [];
  for (const lst of LSTS) {
    const stake = holdApr(ctx.snap, lst);
    for (const route of borrowRoutes(ctx.snap, lst, "WETH")) {
      const LT = route.liqThreshold;
      let L = Math.min(LOOP_MAX_LEVERAGE, 1 / (1 - LT / LOOP_TARGET_HF));
      while (L > 1 && (L - 1) / L > route.ltv * 0.98) L -= 0.25;
      if (L <= 1.2) continue;
      const hf = (LT * L) / (L - 1);
      const legs: Leg[] = [
        { action: "supply", venue: route.venue, symbol: lst, weight: L, apr: stake + route.collateralSupplyApr, note: `${pct(stake)} staking${route.eMode ? `, e-mode ${route.eMode}` : ""}` },
        { action: "borrow", venue: route.venue, symbol: "WETH", weight: L - 1, apr: -route.borrowApr },
        { action: "swap", venue: "uniswap-v3", symbol: `WETH→${lst}`, weight: L - 1, apr: 0 },
      ];
      const headroom = (route.collateral as { supplyHeadroomUsd?: number }).supplyHeadroomUsd ?? route.collateral.availableUsd;
      const capacity = Math.min(route.availableUsd / (L - 1), headroom / L);
      const executable = route.venue === "aave-v3" && (lst === "wstETH" || lst === "weETH") || route.venue === "compound-v3" && lst === "wstETH";
      out.push(assemble(ctx, {
        id: slug("lst-loop", lst, route.venue, route.eMode ?? 0),
        strategy: "lst-loop",
        title: `${L.toFixed(1)}x ${lst} loop on ${route.venue}${route.eMode ? ` (e-mode ${route.eMode})` : ""}`,
        thesis: `${lst} stakes at ${pct(stake)}; WETH borrows at ${pct(route.borrowApr)}. Looping ${L.toFixed(1)}x earns the spread ${L.toFixed(1)} times over on the staking side and pays it ${(L - 1).toFixed(1)} times on the debt.`,
        legs,
        capacityUsd: capacity,
        riskFactors: [risk.leverage(L), risk.liquidation(1 - 1 / hf), risk.capacity(capacity), risk.asset(lst), { points: stake - route.borrowApr < 0.003 ? 12 : 0, why: "thin staking-vs-borrow spread; a WETH rate spike flips it negative" }],
        healthFactor: hf,
        liquidationMovePct: 1 - 1 / hf,
        executable,
        whyNotExecutable: executable ? undefined : `${lst} swap route not configured`,
        params: { collateral: lst, debt: "WETH", leverage: Number(L.toFixed(2)), lendVenue: route.venue, eMode: route.eMode ?? 0, comet: route.debt.comet ?? "", targetHf: LOOP_TARGET_HF },
      }));
    }
  }
  return out;
};
