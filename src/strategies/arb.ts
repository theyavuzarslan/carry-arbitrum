import type { PricePair } from "../sources/arb.ts";
import type { Opportunity } from "../types.ts";
import { gradeOf, pct, slug, type StrategyContext } from "./common.ts";

const CEX_TAKER = 0.001;          // Binance spot taker fee
const MIN_EDGE = Number(process.env.CARRY_MIN_ARB_EDGE ?? 0.0005);

/**
 * Arbitrage is a one-off edge, not a yearly rate. These opportunities carry `params.oneOff = true`
 * and their netApr field holds the edge per round trip after costs, so they are never annualized.
 */
type ArbInput = Pick<Opportunity, "id" | "strategy" | "title" | "thesis" | "legs" | "grossApr" | "capacityUsd" | "whyNotExecutable" | "params"> & { cost: number; score: number; factors: string[] };
const arbOpp = (o: ArbInput): Opportunity => ({
  id: o.id, strategy: o.strategy, scope: "market", title: o.title, thesis: o.thesis, legs: o.legs,
  grossApr: o.grossApr, costApr: o.cost, netApr: o.grossApr - o.cost, leverage: 1, capacityUsd: o.capacityUsd,
  risk: { score: o.score, grade: gradeOf(o.score), factors: o.factors },
  executable: false, whyNotExecutable: o.whyNotExecutable, params: { ...o.params, oneOff: true },
});

/** Cross-exchange: Uniswap v3 (Arbitrum One) against Binance spot, inventory pre-positioned on both. */
export const cexDexArbs = (ctx: StrategyContext): Opportunity[] => {
  const out: Opportunity[] = [];
  for (const p of ctx.snap.arb?.cexDex ?? []) {
    // Uniswap quotes already include the pool fee and impact; the CEX side pays taker fee.
    const dirs = [
      { buy: p.a, sell: p.b, gross: p.b.sellPx / p.a.buyPx - 1 },
      { buy: p.b, sell: p.a, gross: p.a.sellPx / p.b.buyPx - 1 },
    ];
    for (const d of dirs) {
      const net = d.gross - CEX_TAKER;
      if (net < MIN_EDGE) continue;
      out.push(arbOpp({
        id: slug("cex-dex-arb", p.asset, d.buy.venue, d.sell.venue),
        strategy: "cex-dex-arb",
        title: `One-off ${pct(net, 2)}: buy ${p.asset} on ${d.buy.venue}, sell on ${d.sell.venue}`,
        thesis: `At $${p.sizeUsd.toLocaleString()} size ${p.asset} costs ${d.buy.buyPx.toFixed(4)} on ${d.buy.venue} and sells for ${d.sell.sellPx.toFixed(4)} on ${d.sell.venue}. Needs inventory on both sides (no transfer in the loop); rebalance later via a bridge or the exchange.`,
        legs: [
          { action: "swap", venue: d.buy.venue, symbol: `USD→${p.asset}`, weight: 1, apr: 0, note: d.buy.source },
          { action: "swap", venue: d.sell.venue, symbol: `${p.asset}→USD`, weight: 1, apr: d.gross, note: d.sell.source },
        ],
        grossApr: d.gross, cost: CEX_TAKER, capacityUsd: p.sizeUsd,
        score: 40, factors: ["one leg is a centralized exchange (+30)", "prices move between the two fills (+10)"],
        whyNotExecutable: "the Binance leg is off-chain",
        params: { asset: p.asset, sizeUsd: p.sizeUsd, buyVenue: d.buy.venue, sellVenue: d.sell.venue, edge: net },
      }));
    }
  }
  return out;
};

/**
 * Cross-chain: tokenized stocks on Robinhood Chain against GMX's mark for the same stock. Only exact
 * matches already validated within 3% of the mark are used. A plain "same token, two chains" check was
 * tried and removed: LI.FI index prices on thin chains produced gaps of 19% to 2,000%+ that no firm
 * quote supports, so they would be false signals.
 */
export const xchainArbs = (ctx: StrategyContext): Opportunity[] => {
  const eco = ctx.snap.eco;
  if (!eco) return [];
  const out: Opportunity[] = [];
  // Tokenized stocks vs GMX mark: a premium/discount beyond round-trip costs converges.
  for (const s of eco.spots.filter((x) => x.match === "exact")) {
    const q = eco.quotes[`${s.chainId}:${s.token.address.toLowerCase()}`];
    const cost = 2 * (q?.costFraction ?? 0.003) + 2 * 0.0006;
    const net = Math.abs(s.priceGapPct / 100) - cost;
    if (net < MIN_EDGE) continue;
    out.push(arbOpp({
      id: slug("xchain-arb", s.token.symbol, "gmx"),
      strategy: "xchain-arb",
      title: `One-off ${pct(net, 2)}: ${s.token.symbol} on ${s.chain} vs GMX ${s.perpSymbol} mark`,
      thesis: `${s.token.symbol} trades ${s.priceGapPct.toFixed(2)}% ${s.priceGapPct > 0 ? "above" : "below"} GMX's ${s.perpSymbol} mark. ${s.priceGapPct > 0 ? "Short the token, long GMX" : "Buy the token, short GMX"} and close when they converge.`,
      legs: [
        { action: "bridge", venue: "lifi", symbol: `USDC→${s.token.symbol}`, weight: 1, apr: 0, chainId: s.chainId, costOneWay: q?.costFraction ?? 0.003 },
        { action: s.priceGapPct > 0 ? "long-perp" : "short-perp", venue: "gmx-v2", symbol: s.perpName, weight: 1, apr: Math.abs(s.priceGapPct / 100) },
      ],
      grossApr: Math.abs(s.priceGapPct / 100), cost, capacityUsd: q?.depthUsd ?? 10_000,
      score: 45, factors: ["stock tokens price on US market hours; the perp trades 24/7 (+20)", "convergence timing is not guaranteed (+15)", "LI.FI index price (+10)"],
      whyNotExecutable: "convergence trades are signals in this build",
      params: { asset: s.token.symbol, chainId: s.chainId, gapPct: s.priceGapPct, edge: net },
    }));
  }
  return out;
};
