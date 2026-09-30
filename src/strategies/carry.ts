import { isEthLike, isEuro, isStable } from "../tokens.ts";
import type { Leg, Opportunity } from "../types.ts";
import { assemble, borrowRoutes, holdApr, pct, risk, slug, type StrategyContext } from "./common.ts";

type Ccy = "USD" | "ETH" | "BTC" | "EUR" | "OTHER";
const ccyOf = (s: string): Ccy => (isStable(s) ? "USD" : isEthLike(s) ? "ETH" : /BTC/.test(s) ? "BTC" : isEuro(s) ? "EUR" : "OTHER");

/** FX volatility proxy per currency pair, used for the uncovered-carry risk score. */
const fxVol = (a: Ccy, b: Ccy): number => {
  if (a === b) return 0;
  const vol: Record<Ccy, number> = { USD: 0, EUR: 0.08, ETH: 0.65, BTC: 0.5, OTHER: 0.9 };
  return Math.max(vol[a], vol[b]);
};

interface Target { symbol: string; venue: string; apr: number; executable: boolean; capacityUsd: number; note: string }

/** Everywhere capital can earn a yield, executable or not, with its currency. */
const targets = (ctx: StrategyContext): Target[] => {
  const t: Target[] = [];
  for (const m of ctx.snap.lending) {
    if (m.supplyApr <= 0 || m.venue === "compound-v3" && !m.canBorrow) continue;
    // Native yield accrues on top of supply only where the venue holds the token itself (Aave/Compound).
    const native = m.source === "onchain" ? holdApr(ctx.snap, m.symbol) : 0;
    t.push({ symbol: m.symbol, venue: m.venue, apr: m.supplyApr + native, executable: m.executable, capacityUsd: m.totalSupplyUsd * 0.1, note: `${m.venue} supply` });
  }
  for (const h of ctx.snap.holdYields) {
    if (/^(wstETH)$/.test(h.symbol)) t.push({ symbol: h.symbol, venue: "hold", apr: h.apr, executable: true, capacityUsd: 5_000_000, note: h.note ?? "native yield" });
    else t.push({ symbol: h.symbol, venue: "hold", apr: h.apr, executable: false, capacityUsd: 2_000_000, note: h.note ?? "native yield" });
  }
  for (const f of ctx.snap.fixed) {
    t.push({ symbol: `PT-${f.name}`, venue: "pendle", apr: f.impliedApr, executable: false, capacityUsd: f.liquidityUsd * 0.05, note: `fixed until ${f.expiry.slice(0, 10)}` });
  }
  return t;
};

const targetCcy = (t: Target): Ccy => (t.symbol.startsWith("PT-") ? (/(USD|usd)/.test(t.symbol) ? "USD" : "OTHER") : ccyOf(t.symbol));

/**
 * Borrow a funding currency F against collateral X and deploy the loan into a target yield Z.
 *   same currency (F and Z both USD):  "lend-borrow" rate carry, no price exposure
 *   different currencies:              "fx-carry", uncovered: you are short F / long Z
 * Covered FX carry (hedging the F exposure with a perp) is the reverse-basis strategy.
 */
export const carryOpportunities = (ctx: StrategyContext): Opportunity[] => {
  const out: Opportunity[] = [];
  const HF = ctx.targetHealthFactor;
  const allTargets = targets(ctx);
  const fundings = ["USDC", "USDT", "USDC.e", "DAI", "WETH", "WBTC", "EURS", "GHO"];
  const collaterals = ["USDC", "USDT", "WETH", "WBTC", "wstETH"];
  for (const X of collaterals) {
    for (const F of fundings) {
      for (const route of borrowRoutes(ctx.snap, X, F)) {
        const b = route.liqThreshold / HF; // debt/collateral so HF lands on target
        if (b > route.ltv * 0.98) continue;
        const cX = ccyOf(X);
        const cF = ccyOf(F);
        // Keep the collateral in the capital's currency class to stay readable: X is what you hold.
        for (const Z of allTargets) {
          if (Z.symbol === F && Z.venue === route.venue) continue;
          const cZ = targetCcy(Z);
          if (cZ === "OTHER") continue;
          const spread = Z.apr - route.borrowApr;
          if (spread <= 0.005) continue;
          const legs: Leg[] = [
            { action: "supply", venue: route.venue, symbol: X, weight: 1, apr: route.collateralSupplyApr + holdApr(ctx.snap, X), note: route.eMode ? `e-mode ${route.eMode}` : "collateral" },
            { action: "borrow", venue: route.venue, symbol: F, weight: b, apr: -route.borrowApr, note: `HF ${HF.toFixed(2)}` },
          ];
          if (Z.symbol !== F) legs.push({ action: "swap", venue: Z.symbol.startsWith("PT-") ? "pendle" : "uniswap-v3", symbol: `${F}→${Z.symbol}`, weight: b, apr: 0 });
          legs.push({ action: Z.symbol.startsWith("PT-") ? "buy-pt" : Z.venue === "hold" ? "hold" : "supply", venue: Z.venue, symbol: Z.symbol, weight: b, apr: Z.apr, note: Z.note });
          const fxMismatch = fxVol(cF, cZ);
          // The collateral's own currency matters too: USDC collateral funding ETH is an ETH short.
          const strategy = cF === cZ ? "lend-borrow" : "fx-carry";
          const executable = Z.executable && route.venue !== undefined && (Z.venue === "aave-v3" || Z.venue === "compound-v3" || Z.venue === "hold");
          const capacity = Math.min(route.availableUsd / b, Z.capacityUsd / b);
          const liqMove = cX === cF ? undefined : 1 - 1 / HF; // price move of X vs F that liquidates
          out.push(assemble(ctx, {
            id: slug(strategy, X, route.venue, route.eMode ?? 0, F, Z.venue, Z.symbol),
            strategy,
            title: strategy === "fx-carry"
              ? `FX carry: fund in ${F} (${pct(route.borrowApr)}), invest in ${Z.symbol} (${pct(Z.apr)})`
              : `Borrow ${F} at ${pct(route.borrowApr)} on ${route.venue}, earn ${pct(Z.apr)} in ${Z.symbol} (${Z.venue})`,
            thesis: strategy === "fx-carry"
              ? `Classic carry: borrow the low-yield currency ${F} against ${X} and hold the high-yield ${Z.symbol}. Uncovered: you are short ${cF} vs ${cZ}; the carry of ${pct(spread)} on ${(b * 100).toFixed(0)}% of capital must beat the ${cF}/${cZ} move.`
              : `Rate carry within ${cF}: ${route.venue} lends ${F} at ${pct(route.borrowApr)} against ${X}; ${Z.venue} pays ${pct(Z.apr)} on ${Z.symbol}. Spread ${pct(spread)} on ${(b * 100).toFixed(0)}% of capital, on top of ${X}'s own yield.`,
            legs,
            capacityUsd: capacity,
            riskFactors: [
              risk.leverage(1 + b),
              risk.liquidation(liqMove),
              risk.capacity(capacity),
              risk.asset(Z.symbol.replace(/^PT-/, "")),
              fxMismatch ? { points: Math.round(fxMismatch * 45), why: `uncovered ${cF}/${cZ} exposure (~${Math.round(fxMismatch * 100)}% annual vol)` } : { points: 0, why: "" },
              Z.executable ? { points: 0, why: "" } : risk.venue(Z.venue),
              { points: 4, why: "floating borrow rate can rise above the target yield" },
            ],
            healthFactor: HF,
            liquidationMovePct: liqMove,
            executable,
            whyNotExecutable: executable ? undefined : `${Z.venue} ${Z.symbol} has no transaction builder in this bot`,
            params: { collateral: X, funding: F, target: Z.symbol, targetVenue: Z.venue, lendVenue: route.venue, eMode: route.eMode ?? 0, comet: route.debt.comet ?? "", debtRatio: b },
          }));
        }
      }
    }
  }
  // Keep the best few per (strategy, funding, target) to avoid a wall of near-duplicates.
  const best = new Map<string, Opportunity>();
  for (const o of out) {
    const k = `${o.strategy}|${o.params.funding}|${o.params.target}|${o.params.targetVenue}`;
    const cur = best.get(k);
    if (!cur || o.netApr - o.risk.score / 1000 > cur.netApr - cur.risk.score / 1000) best.set(k, o);
  }
  return [...best.values()];
};
