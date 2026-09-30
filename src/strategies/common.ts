import { DEFAULTS, GMX } from "../config.ts";
import { isEthLike, isEuro, isStable } from "../tokens.ts";
import type { Leg, LendingMarket, MarketSnapshot, Opportunity, PerpMarket, RiskAssessment, StrategyId } from "../types.ts";

export interface StrategyContext {
  snap: MarketSnapshot;
  horizonDays: number;
  referenceCapitalUsd: number;
  maxLeverage: number;
  targetHealthFactor: number;
  perpLeverage: number;
}

export const makeContext = (snap: MarketSnapshot, o: Partial<StrategyContext> = {}): StrategyContext => ({
  snap,
  horizonDays: o.horizonDays ?? DEFAULTS.horizonDays,
  referenceCapitalUsd: o.referenceCapitalUsd ?? 10_000,
  maxLeverage: o.maxLeverage ?? DEFAULTS.maxLeverage,
  targetHealthFactor: o.targetHealthFactor ?? DEFAULTS.targetHealthFactor,
  perpLeverage: o.perpLeverage ?? DEFAULTS.perpLeverage,
});

/** Native yield of simply holding the token (staking, yield-bearing stable). */
export const holdApr = (snap: MarketSnapshot, symbol: string): number =>
  snap.holdYields.find((h) => h.symbol === symbol)?.apr ?? 0;

/** Best place to supply a token. Executable venues only unless told otherwise. */
export const bestSupply = (snap: MarketSnapshot, symbol: string, executableOnly = true): LendingMarket | undefined =>
  snap.lending
    .filter((m) => m.symbol === symbol && (!executableOnly || m.executable) && m.supplyApr >= 0)
    // Compound collateral rows earn nothing and are listed per-comet; prefer real supply markets.
    .sort((a, b) => b.supplyApr - a.supplyApr || b.totalSupplyUsd - a.totalSupplyUsd)[0];

/** A way to borrow `debt` against `collateral` on one venue. */
export interface BorrowRoute {
  venue: "aave-v3" | "compound-v3";
  collateral: LendingMarket;
  debt: LendingMarket;
  borrowApr: number;
  collateralSupplyApr: number;   // what the collateral earns while posted
  ltv: number;
  liqThreshold: number;
  eMode?: number;
  eModeLabel?: string;
  availableUsd: number;
}

export const borrowRoutes = (snap: MarketSnapshot, collateral: string, debt: string): BorrowRoute[] => {
  const routes: BorrowRoute[] = [];
  const aaveColl = snap.lending.find((m) => m.venue === "aave-v3" && m.symbol === collateral);
  const aaveDebt = snap.lending.find((m) => m.venue === "aave-v3" && m.symbol === debt && m.canBorrow && m.borrowApr !== null);
  if (aaveColl && aaveDebt && collateral !== debt) {
    if (aaveColl.canCollateral) {
      routes.push({ venue: "aave-v3", collateral: aaveColl, debt: aaveDebt, borrowApr: aaveDebt.borrowApr!, collateralSupplyApr: aaveColl.supplyApr, ltv: aaveColl.ltv, liqThreshold: aaveColl.liqThreshold, availableUsd: aaveDebt.availableUsd });
    }
    for (const e of aaveColl.eModes ?? []) {
      if (!e.collateral) continue;
      const d = aaveDebt.eModes?.find((x) => x.id === e.id && x.borrowable);
      if (!d) continue;
      routes.push({ venue: "aave-v3", collateral: aaveColl, debt: aaveDebt, borrowApr: aaveDebt.borrowApr!, collateralSupplyApr: aaveColl.supplyApr, ltv: e.ltv, liqThreshold: e.liqThreshold, eMode: e.id, eModeLabel: e.label, availableUsd: aaveDebt.availableUsd });
    }
  }
  // Compound v3: the debt must be a comet's base asset and the collateral listed on that comet.
  for (const base of snap.lending.filter((m) => m.venue === "compound-v3" && m.canBorrow && m.symbol === debt)) {
    const coll = snap.lending.find((m) => m.venue === "compound-v3" && m.comet === base.comet && m.symbol === collateral && m.canCollateral);
    if (!coll || coll.ltv === 0) continue;
    routes.push({ venue: "compound-v3", collateral: coll, debt: base, borrowApr: base.borrowApr!, collateralSupplyApr: 0, ltv: coll.ltv, liqThreshold: coll.liqThreshold, availableUsd: base.availableUsd });
  }
  return routes;
};

/** Pick the route with the best carry for a given debt/collateral ratio, respecting the LTV. */
export const bestRoute = (routes: BorrowRoute[], debtRatio: number): BorrowRoute | undefined =>
  routes
    .filter((r) => debtRatio <= r.ltv * 0.98)
    .sort((a, b) => (b.collateralSupplyApr - b.borrowApr * debtRatio) - (a.collateralSupplyApr - a.borrowApr * debtRatio))[0];

/** Minimum open interest for a GMX market to be traded; smaller pools have erratic funding. */
export const MIN_PERP_OI_USD = Number(process.env.CARRY_MIN_PERP_OI ?? 250_000);
/** Carry above this is treated as a data artifact (e.g. an almost-empty pool), not an opportunity. */
export const MAX_SANE_CARRY = 3;

/** GMX markets that are deep enough to trade. */
export const tradablePerps = (snap: MarketSnapshot): PerpMarket[] =>
  snap.perps.filter((p) => p.venue === "gmx-v2" && p.openInterestLongUsd + p.openInterestShortUsd >= MIN_PERP_OI_USD);

export const gmxPerp = (snap: MarketSnapshot, symbol: string): PerpMarket[] =>
  tradablePerps(snap).filter((p) => p.symbol === symbol);

export const cexFunding = (snap: MarketSnapshot, symbol: string): PerpMarket[] =>
  snap.perps.filter((p) => p.venue !== "gmx-v2" && p.symbol === symbol);

/**
 * One-way swap cost in bps by pair type: pegged pairs trade in 0.01% pools, majors in 0.05% pools,
 * the rest pay a 0.3% fee plus impact. Conservative on purpose.
 */
export const swapCostBps = (pair: string): number => {
  const [a = "", b = ""] = pair.split("→");
  const eth = (s: string) => isEthLike(s);
  if ((isStable(a) && isStable(b)) || (eth(a) && eth(b))) return 2;
  if ([a, b].every((s) => isStable(s) || s === "WETH" || s === "WBTC")) return 6;
  return DEFAULTS.swapCostBps + 20;
};

/** Round-trip (enter + exit) cost of the trade as a fraction of capital. */
export const roundTripCost = (legs: Leg[]): number => {
  let c = 0;
  for (const l of legs) {
    if (l.action === "swap") c += 2 * (swapCostBps(l.symbol) / 1e4) * l.weight;
    if (l.action === "short-perp" || l.action === "long-perp") c += 2 * (GMX.POSITION_FEE_BPS / 1e4) * l.weight;
    if (l.action === "buy-pt") c += 2 * (15 / 1e4) * l.weight; // Pendle AMM fee + impact, conservative
  }
  return c;
};

export const gradeOf = (score: number): RiskAssessment["grade"] => (score < 25 ? "A" : score < 45 ? "B" : score < 65 ? "C" : "D");

/** Assemble an opportunity from legs, computing gross, cost, net and capacity consistently. */
export const assemble = (
  ctx: StrategyContext,
  a: {
    id: string; strategy: StrategyId; title: string; thesis: string; legs: Leg[];
    capacityUsd: number; riskFactors: { points: number; why: string }[];
    healthFactor?: number; liquidationMovePct?: number; executable: boolean; whyNotExecutable?: string;
    params: Opportunity["params"]; scope?: "market" | "wallet";
  },
): Opportunity => {
  const gross = a.legs.reduce((s, l) => s + l.weight * l.apr, 0);
  const txCount = a.legs.filter((l) => l.action !== "hold").length * 2;
  const gasUsd = txCount * 0.03; // Arbitrum: a few cents per tx
  const costFraction = roundTripCost(a.legs) + gasUsd / ctx.referenceCapitalUsd;
  const costApr = costFraction * (365 / ctx.horizonDays);
  const leverage = a.legs.filter((l) => ["supply", "hold", "short-perp", "long-perp", "buy-pt"].includes(l.action)).reduce((s, l) => Math.max(s, l.weight), 0);
  const score = Math.max(0, Math.min(100, a.riskFactors.reduce((s, f) => s + f.points, 0)));
  return {
    id: a.id,
    strategy: a.strategy,
    scope: a.scope ?? "market",
    title: a.title,
    thesis: a.thesis,
    legs: a.legs,
    grossApr: gross,
    costApr,
    netApr: gross - costApr,
    leverage,
    capacityUsd: Math.max(0, a.capacityUsd),
    risk: {
      score: Math.round(score),
      grade: gradeOf(score),
      healthFactor: a.healthFactor,
      liquidationMovePct: a.liquidationMovePct,
      factors: a.riskFactors.filter((f) => f.points !== 0).sort((x, y) => y.points - x.points).map((f) => `${f.why} (+${f.points})`),
    },
    executable: a.executable,
    whyNotExecutable: a.whyNotExecutable,
    params: a.params,
  };
};

/** Standard risk contributions shared by strategies. */
export const risk = {
  leverage: (l: number) => ({ points: Math.round(Math.max(0, l - 1) * 7), why: `${l.toFixed(1)}x gross leverage` }),
  liquidation: (move: number | undefined) =>
    move === undefined ? { points: 0, why: "" } : { points: Math.round(Math.max(0, 35 - move * 100)), why: `liquidation after a ${(move * 100).toFixed(0)}% adverse move` },
  capacity: (usd: number) => ({ points: usd < 50_000 ? 20 : usd < 250_000 ? 10 : usd < 1_000_000 ? 4 : 0, why: `capacity ${Math.round(usd / 1000)}k USD` }),
  fundingRegime: (carry: number, reference: number[]) => {
    // Funding far above what other venues pay tends to mean-revert: the carry is less durable.
    if (!reference.length) return { points: 8, why: "no cross-venue funding reference" };
    const ref = reference.reduce((s, x) => s + x, 0) / reference.length;
    const gap = carry - ref;
    return { points: Math.round(Math.min(20, Math.max(0, gap * 60))), why: `funding ${(gap * 100).toFixed(1)}pp above CEX average (mean-reversion risk)` };
  },
  asset: (symbol: string) => {
    if (isStable(symbol) && /^(USDC|USDT|DAI)$/.test(symbol)) return { points: 0, why: "" };
    if (isStable(symbol)) return { points: 8, why: `${symbol} peg / issuer risk` };
    if (isEuro(symbol)) return { points: 6, why: `${symbol} thin liquidity` };
    if (/^(wstETH|weETH|rETH|rsETH|ezETH)$/.test(symbol)) return { points: symbol === "wstETH" ? 3 : 7, why: `${symbol} depeg vs ETH` };
    if (isEthLike(symbol) || symbol === "WBTC") return { points: 0, why: "" };
    return { points: 6, why: `${symbol} is volatile and thinner` };
  },
  /** Very high funding on GMX comes from near-empty pools and resets within hours. */
  extremeFunding: (carry: number) => ({ points: carry > 1 ? 35 : carry > 0.5 ? 20 : carry > 0.3 ? 10 : 0, why: `${Math.round(carry * 100)}%/yr funding is unlikely to persist` }),
  offchainLeg: () => ({ points: 10, why: "one leg sits off Arbitrum (CEX or Hyperliquid)" }),
  venue: (venue: string) => ({ points: ["aave-v3", "compound-v3", "gmx-v2", "uniswap-v3"].includes(venue) ? 0 : 6, why: `${venue} not integrated for execution` }),
};

export const pct = (x: number, d = 2) => `${(x * 100).toFixed(d)}%`;
export const slug = (...parts: (string | number)[]) => parts.join(":").replace(/[^A-Za-z0-9:._-]/g, "").toLowerCase();
