import { PERP_TO_SPOT } from "../config.ts";
import { canonicalSymbol, isStable } from "../tokens.ts";
import type { Leg, Opportunity, PerpMarket } from "../types.ts";
import { assemble, bestRoute, bestSupply, borrowRoutes, cexFunding, holdApr, MAX_SANE_CARRY, pct, risk, slug, tradablePerps, type StrategyContext } from "./common.ts";

/** The margin token GMX would take for this market: a stable if the pool has one, else the spot token. */
const marginOf = (p: PerpMarket): { symbol: string; stable: boolean } => {
  const long = canonicalSymbol(p.gmx!.longToken, "?");
  const short = canonicalSymbol(p.gmx!.shortToken, "?");
  if (isStable(short)) return { symbol: short, stable: true };
  if (isStable(long)) return { symbol: long, stable: true };
  return { symbol: long, stable: false };
};

/** Spot tokens that track a GMX index. ETH can be hedged with LSTs, which adds staking yield. */
const spotChoices = (symbol: string): string[] => {
  const s = PERP_TO_SPOT[symbol];
  if (!s) return [];
  return symbol === "ETH" ? [s, "wstETH", "weETH"] : [s];
};

/**
 * Cash-and-carry: own the spot, short the GMX perp, collect the funding shorts are paid.
 * Two shapes:
 *  - funded: capital buys spot and posts perp margin separately (no debt, nothing to liquidate but the perp);
 *  - levered: spot goes into Aave/Compound as collateral and the USDC margin is borrowed against it,
 *    so all capital is spot and the carry is spot yield + funding - borrow/Lp.
 */
export const basisOpportunities = (ctx: StrategyContext): Opportunity[] => {
  const out: Opportunity[] = [];
  const Lp = ctx.perpLeverage;
  for (const perp of tradablePerps(ctx.snap).filter((p) => p.shortCarryApr > 0 && p.shortCarryApr < MAX_SANE_CARRY)) {
    const refs = cexFunding(ctx.snap, perp.symbol).map((r) => r.shortCarryApr);
    const margin = marginOf(perp);
    for (const spot of spotChoices(perp.symbol)) {
      const sup = bestSupply(ctx.snap, spot);
      const spotApr = holdApr(ctx.snap, spot) + (sup?.supplyApr ?? 0);
      const spotVenue = sup ? sup.venue : "wallet";
      const common = [risk.fundingRegime(perp.shortCarryApr, refs), risk.extremeFunding(perp.shortCarryApr), risk.asset(spot)];
      const perpLiqMove = margin.stable ? 0.9 / Lp : 1 / (Lp - 1 || 1);

      // Funded shape.
      {
        const legs: Leg[] = margin.stable
          ? [
            { action: "swap", venue: "uniswap-v3", symbol: `USDC→${spot}`, weight: Lp / (Lp + 1), apr: 0 },
            { action: sup ? "supply" : "hold", venue: spotVenue, symbol: spot, weight: Lp / (Lp + 1), apr: spotApr, note: sup ? `${spot} earns ${pct(sup.supplyApr)} supply + ${pct(holdApr(ctx.snap, spot))} native` : undefined },
            { action: "short-perp", venue: "gmx-v2", symbol: perp.name, weight: Lp / (Lp + 1), apr: perp.shortCarryApr, note: `${Lp}x, ${margin.symbol} margin` },
          ]
          : [
            // Coin-margined: the spot posted as margin is itself part of the hedge.
            { action: "swap", venue: "uniswap-v3", symbol: `USDC→${spot}`, weight: 1, apr: 0 },
            { action: sup ? "supply" : "hold", venue: spotVenue, symbol: spot, weight: 1 - 1 / Lp, apr: spotApr },
            { action: "short-perp", venue: "gmx-v2", symbol: perp.name, weight: 1, apr: perp.shortCarryApr, note: `${Lp}x, ${margin.symbol} margin (coin-margined)` },
          ];
        const w = legs[2]!.weight;
        const capacity = perp.availableShortUsd / w;
        // The executor funds margin in USDC or in the spot token itself; other margin tokens are plan-only.
        const marginOk = margin.stable ? margin.symbol === "USDC" : margin.symbol === spot;
        const executable = marginOk && (spot === PERP_TO_SPOT[perp.symbol] || spot === "wstETH");
        out.push(assemble(ctx, {
          id: slug("basis", perp.name, spot, "funded"),
          strategy: "basis",
          title: `Long ${spot} / short ${perp.name} on GMX`,
          thesis: `GMX pays ${perp.symbol} shorts ${pct(perp.shortCarryApr)}/yr. Hold ${spot} (${pct(spotApr)}) against a ${Lp}x short so price moves cancel and the funding is the return.`,
          legs,
          capacityUsd: capacity,
          riskFactors: [...common, risk.leverage(1), risk.liquidation(perpLiqMove), risk.capacity(capacity), spot !== PERP_TO_SPOT[perp.symbol] ? { points: 3, why: `${spot}/ETH basis between hedge and spot` } : { points: 0, why: "" }],
          liquidationMovePct: perpLiqMove,
          executable,
          whyNotExecutable: executable ? undefined : marginOk ? `${spot} hedge not wired for execution` : `GMX margin token ${margin.symbol} differs from spot ${spot}`,
          params: { perpMarket: perp.gmx!.marketToken, perpName: perp.name, spot, margin: margin.symbol, perpLeverage: Lp, shape: "funded", spotVenue },
        }));
      }

      // Levered shape: needs a stable-margined market and a venue that lends USDC against the spot.
      if (margin.stable) {
        const debtRatio = 1 / Lp;
        const route = bestRoute(borrowRoutes(ctx.snap, spot, "USDC"), debtRatio);
        if (route) {
          const hf = route.liqThreshold / debtRatio;
          if (hf >= ctx.targetHealthFactor) {
            const legs: Leg[] = [
              { action: "swap", venue: "uniswap-v3", symbol: `USDC→${spot}`, weight: 1, apr: 0 },
              { action: "supply", venue: route.venue, symbol: spot, weight: 1, apr: route.collateralSupplyApr + holdApr(ctx.snap, spot), note: route.eMode ? `e-mode ${route.eMode} (${route.eModeLabel})` : "collateral" },
              { action: "borrow", venue: route.venue, symbol: "USDC", weight: debtRatio, apr: -route.borrowApr, note: `HF ${hf.toFixed(2)}` },
              { action: "short-perp", venue: "gmx-v2", symbol: perp.name, weight: 1, apr: perp.shortCarryApr, note: `${Lp}x on borrowed USDC` },
            ];
            const capacity = Math.min(perp.availableShortUsd, route.availableUsd / debtRatio);
            out.push(assemble(ctx, {
              id: slug("basis", perp.name, spot, "levered", route.venue),
              strategy: "basis",
              title: `${spot} on ${route.venue} → borrow USDC → short ${perp.name}`,
              thesis: `All capital sits in ${spot} as ${route.venue} collateral; USDC borrowed at ${pct(route.borrowApr)} margins a GMX short paid ${pct(perp.shortCarryApr)}. When ${perp.symbol} rallies the collateral grows with the perp loss, so the bot re-borrows to top up margin.`,
              legs,
              capacityUsd: capacity,
              riskFactors: [...common, risk.leverage(1 + debtRatio), risk.liquidation(0.9 / Lp), risk.capacity(capacity), { points: 5, why: "two positions to rebalance (lending HF and perp margin)" }],
              healthFactor: hf,
              liquidationMovePct: 0.9 / Lp,
              executable: margin.symbol === "USDC" && (spot === PERP_TO_SPOT[perp.symbol] || spot === "wstETH"),
              whyNotExecutable: undefined,
              params: { perpMarket: perp.gmx!.marketToken, perpName: perp.name, spot, margin: "USDC", perpLeverage: Lp, shape: "levered", lendVenue: route.venue, eMode: route.eMode ?? 0, comet: route.debt.comet ?? "", debtRatio },
            }));
          }
        }
      }
    }
  }
  return out;
};

/**
 * Reverse cash-and-carry: when GMX pays LONGS, go long the perp and short the spot by borrowing it
 * against USDC and selling it. The sale proceeds are re-supplied as collateral. This is also covered
 * FX carry: borrow the low-yield currency (ETH), hold the high-yield one (USDC), hedge with the perp.
 */
export const reverseBasisOpportunities = (ctx: StrategyContext): Opportunity[] => {
  const out: Opportunity[] = [];
  const Lp = ctx.perpLeverage;
  const HF = ctx.targetHealthFactor;
  for (const perp of tradablePerps(ctx.snap).filter((p) => p.longCarryApr > 0 && p.longCarryApr < MAX_SANE_CARRY)) {
    const spot = PERP_TO_SPOT[perp.symbol];
    if (!spot) continue;
    const margin = marginOf(perp);
    const refs = cexFunding(ctx.snap, perp.symbol).map((r) => r.longCarryApr);
    for (const route of borrowRoutes(ctx.snap, "USDC", spot)) {
      const LT = route.liqThreshold;
      // Size the perp notional N (per 1 USD capital) so the lending health factor lands on target.
      const N = margin.stable ? (LT) / (HF - LT + LT / Lp) : LT / (HF * (1 + 1 / Lp) - LT);
      const borrowW = margin.stable ? N : N * (1 + 1 / Lp);
      const usdcW = margin.stable ? 1 - N / Lp + N : 1 + N;
      if (borrowW / usdcW > route.ltv * 0.98 || N <= 0) continue;
      const legs: Leg[] = [
        { action: "supply", venue: route.venue, symbol: "USDC", weight: usdcW, apr: route.collateralSupplyApr, note: "capital + sale proceeds" },
        { action: "borrow", venue: route.venue, symbol: spot, weight: borrowW, apr: -route.borrowApr, note: margin.stable ? undefined : "includes the coin margin" },
        { action: "swap", venue: "uniswap-v3", symbol: `${spot}→USDC`, weight: N, apr: 0 },
        { action: "long-perp", venue: "gmx-v2", symbol: perp.name, weight: N, apr: perp.longCarryApr, note: `${Lp}x, ${margin.symbol} margin` },
      ];
      const capacity = Math.min(perp.availableLongUsd / N, route.availableUsd / borrowW);
      out.push(assemble(ctx, {
        id: slug("reverse-basis", perp.name, route.venue),
        strategy: "reverse-basis",
        title: `Borrow ${spot} on ${route.venue}, sell, long ${perp.name}`,
        thesis: `GMX pays ${perp.symbol} longs ${pct(perp.longCarryApr)}/yr while ${spot} costs ${pct(route.borrowApr)} to borrow. Short spot via ${route.venue}, long the perp, keep the USDC earning ${pct(route.collateralSupplyApr)}.`,
        legs,
        capacityUsd: capacity,
        riskFactors: [risk.fundingRegime(perp.longCarryApr, refs), risk.extremeFunding(perp.longCarryApr), risk.leverage(usdcW), risk.liquidation(0.9 / Lp), risk.capacity(capacity), { points: 6, why: "ETH-margined long pool: funding flips fast when OI rebalances" }],
        healthFactor: HF,
        liquidationMovePct: 0.9 / Lp,
        executable: margin.symbol === "USDC" || margin.symbol === spot,
        whyNotExecutable: margin.symbol === "USDC" || margin.symbol === spot ? undefined : `GMX margin token ${margin.symbol} differs from ${spot}`,
        params: { perpMarket: perp.gmx!.marketToken, perpName: perp.name, spot, margin: margin.symbol, perpLeverage: Lp, lendVenue: route.venue, comet: route.debt.comet ?? "", notionalPerCapital: N, borrowWeight: borrowW, supplyWeight: usdcW },
      }));
    }
  }
  return out;
};
