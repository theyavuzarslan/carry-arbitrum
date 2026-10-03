import { chainById } from "../chains.ts";
import { quoteKey, type BridgeQuote } from "../sources/xchain.ts";
import type { Leg, Opportunity } from "../types.ts";
import { assemble, bestSupply, cexFunding, MAX_SANE_CARRY, pct, risk, slug, type StrategyContext } from "./common.ts";

const MIN_XCHAIN_PERP_OI = Number(process.env.CARRY_MIN_XCHAIN_PERP_OI ?? 10_000);

const bridgeRisk = (q: BridgeQuote | undefined, chain: string) => [
  q ? { points: 6, why: `bridge via ${q.tool} (~${q.durationSec}s); exiting means bridging back` } : { points: 15, why: "no live bridge route" },
  { points: 4, why: `assets sit on ${chain}, an Arbitrum Orbit chain with its own sequencer` },
];

/**
 * When the spot leg of a GMX trade does not exist on Arbitrum One, source it from an Arbitrum
 * ecosystem chain: bridge USDC into the token there (one LI.FI transaction), short the GMX perp on
 * Arbitrum One with the remaining USDC as margin. Example: GMX pays SPY shorts; tokenized SPY lives
 * on Robinhood Chain.
 */
export const xchainBasisOpportunities = (ctx: StrategyContext): Opportunity[] => {
  const eco = ctx.snap.eco;
  if (!eco) return [];
  const out: Opportunity[] = [];
  const Lp = ctx.perpLeverage;
  const w = Lp / (Lp + 1);
  for (const s of eco.spots) {
    const perp = ctx.snap.perps.find((p) => p.venue === "gmx-v2" && p.name === s.perpName);
    if (!perp || perp.shortCarryApr <= 0 || perp.shortCarryApr >= MAX_SANE_CARRY) continue;
    const oi = perp.openInterestLongUsd + perp.openInterestShortUsd;
    if (oi < MIN_XCHAIN_PERP_OI) continue;
    const q = eco.quotes[quoteKey(s.chainId, s.token.address)];
    const chain = chainById(s.chainId)!;
    const usdcMargin = /USDC\]$/.test(perp.name);
    const legs: Leg[] = [
      { action: "bridge", venue: `lifi${q ? `/${q.tool}` : ""}`, symbol: `USDC→${s.token.symbol}`, weight: w, apr: 0, chainId: s.chainId, costOneWay: q?.costFraction ?? 0.01, note: `Arbitrum One → ${chain.name}` },
      { action: "hold", venue: `${chain.slug}:wallet`, symbol: s.token.symbol, weight: w, apr: 0, chainId: s.chainId, note: s.match === "proxy" ? `proxy for ${s.perpSymbol}` : s.token.name },
      { action: "short-perp", venue: "gmx-v2", symbol: perp.name, weight: w, apr: perp.shortCarryApr, note: `${Lp}x, USDC margin on Arbitrum One` },
    ];
    const capacity = Math.min(perp.availableShortUsd / w, (q?.depthUsd ?? 0) / w);
    const executable = !!q && usdcMargin;
    out.push(assemble(ctx, {
      id: slug("xchain-basis", perp.name, chain.slug, s.token.symbol),
      strategy: "xchain-basis",
      title: `Hold ${s.token.symbol} on ${chain.name} / short ${perp.name} on GMX`,
      thesis: `GMX pays ${s.perpSymbol} shorts ${pct(perp.shortCarryApr)}/yr, but ${s.perpSymbol} has no spot market on Arbitrum One. ${chain.name} lists ${s.token.symbol} (${s.token.name}${s.match === "exact" ? `, ${s.priceGapPct >= 0 ? "+" : ""}${s.priceGapPct.toFixed(2)}% vs GMX mark` : ", an ETF proxy hedged by notional"}). Bridge USDC into it in one transaction (${q ? `${pct(q.costFraction, 2)} one way, ~${q.durationSec}s` : "no route right now"}) and short the same notional on GMX.`,
      legs,
      capacityUsd: capacity,
      riskFactors: [
        risk.fundingRegime(perp.shortCarryApr, cexFunding(ctx.snap, perp.symbol).map((r) => r.shortCarryApr)),
        risk.extremeFunding(perp.shortCarryApr),
        risk.liquidation(0.9 / Lp),
        risk.capacity(capacity),
        oi < 250_000 ? { points: 10, why: `GMX ${s.perpSymbol} open interest only $${Math.round(oi / 1000)}k: funding swings fast` } : { points: 0, why: "" },
        s.kind === "stock" ? { points: 8, why: "tokenized stock: issuer eligibility rules and US market-hours pricing vs a 24/7 perp" } : { points: 0, why: "" },
        s.match === "proxy" ? { points: 12, why: `${s.token.symbol} is an ETF proxy: fees and tracking error vs ${s.perpSymbol}` } : { points: Math.round(Math.min(10, Math.abs(s.priceGapPct) * 4)), why: `spot/perp price gap ${s.priceGapPct.toFixed(2)}%` },
        ...bridgeRisk(q, chain.name),
      ],
      liquidationMovePct: 0.9 / Lp,
      executable,
      whyNotExecutable: executable ? undefined : !q ? `LI.FI has no route from Arbitrum One USDC to ${s.token.symbol} on ${chain.name} right now` : `GMX margin token for ${perp.name} is not USDC`,
      params: { perpMarket: perp.gmx!.marketToken, perpName: perp.name, chainId: s.chainId, chain: chain.name, token: s.token.address, tokenSymbol: s.token.symbol, perpLeverage: Lp, match: s.match, bridgeCost: q?.costFraction ?? -1 },
    }));
  }
  return out;
};

/**
 * Carry targets that only exist on ecosystem chains (Morpho USDG vaults and USDe on Robinhood Chain,
 * Nest RWA vaults on Plume). Two shapes: bridge capital straight in, or keep USDC on Aave
 * (Arbitrum One) as collateral and bridge only the borrowed USDC (rate carry across chains).
 */
export const xchainYieldOpportunities = (ctx: StrategyContext): Opportunity[] => {
  const eco = ctx.snap.eco;
  if (!eco) return [];
  const out: Opportunity[] = [];
  const floating = bestSupply(ctx.snap, "USDC");
  const aaveUsdc = ctx.snap.lending.find((m) => m.venue === "aave-v3" && m.symbol === "USDC" && m.canBorrow);
  for (const y of eco.yields.filter((x) => x.ccy === "USD")) {
    const chain = chainById(y.chainId)!;
    const q = eco.quotes[quoteKey(y.chainId, y.token.address)];
    if (!q) {
      // No one-hop route into the vault token: price the bridge to the chain's stablecoin instead and
      // show the trade as a plan-only signal (the deposit on the destination chain is manual).
      const st = eco.stables?.[y.chainId];
      const q2 = st ? eco.quotes[quoteKey(y.chainId, st.address)] : undefined;
      if (!st || !q2) continue;
      out.push(assemble(ctx, {
        id: slug("xchain-yield", chain.slug, y.project, y.symbol, "two-step"),
        strategy: "xchain-yield",
        title: `Bridge to ${st.symbol} on ${chain.name}, deposit into ${y.symbol} (${pct(y.apr)})`,
        thesis: `${y.project} on ${chain.name} pays ${pct(y.apr)} base on ${y.symbol}, which has no Arbitrum One market. LI.FI bridges USDC → ${st.symbol} on ${chain.name} for ${pct(q2.costFraction)} one way (~${q2.durationSec}s); the vault deposit is a second step on ${chain.name}.`,
        legs: [
          { action: "bridge", venue: `lifi/${q2.tool}`, symbol: `USDC→${st.symbol}`, weight: 1, apr: 0, chainId: y.chainId, costOneWay: q2.costFraction },
          { action: "supply", venue: `${chain.slug}:${y.project}`, symbol: y.symbol, weight: 1, apr: y.apr, chainId: y.chainId, note: `TVL $${Math.round(y.tvlUsd / 1e6)}M` },
        ],
        capacityUsd: Math.min(q2.depthUsd ?? 0, y.tvlUsd * 0.05),
        riskFactors: [{ points: 10, why: `${y.symbol}: RWA/credit vault, redemption terms and exit liquidity` }, ...bridgeRisk(q2, chain.name), risk.capacity(Math.min(q2.depthUsd ?? 0, y.tvlUsd * 0.05)), risk.venue(y.project)],
        executable: false,
        whyNotExecutable: `the ${y.project} deposit on ${chain.name} has no builder yet; the bridge leg is quoted live`,
        params: { chainId: y.chainId, chain: chain.name, token: y.token.address, tokenSymbol: y.symbol, project: y.project, shape: "two-step", viaToken: st.address },
      }));
      continue;
    }
    const venue = `${chain.slug}:${y.project}`;
    const assetRisk = /usdg|usdc/i.test(y.symbol) && y.project === "morpho-blue" ? { points: 4, why: `${y.symbol} Morpho vault: curator and market risk` } : { points: 10, why: `${y.symbol} on ${y.project}: issuer, redemption terms and exit liquidity` };
    const common = [assetRisk, ...bridgeRisk(q, chain.name), risk.capacity(q.depthUsd ?? 0)];

    // Shape 1: bridge capital in.
    {
      const legs: Leg[] = [
        { action: "bridge", venue: `lifi/${q.tool}`, symbol: `USDC→${y.symbol}`, weight: 1, apr: 0, chainId: y.chainId, costOneWay: q.costFraction, note: `Arbitrum One → ${chain.name}` },
        { action: "hold", venue, symbol: y.symbol, weight: 1, apr: y.apr, chainId: y.chainId, note: `${y.project}, TVL $${Math.round(y.tvlUsd / 1e6)}M${y.rewardApr ? `, +${pct(y.rewardApr)} rewards not counted` : ""}` },
      ];
      out.push(assemble(ctx, {
        id: slug("xchain-yield", chain.slug, y.project, y.symbol, "direct"),
        strategy: "xchain-yield",
        title: `Bridge USDC into ${y.symbol} on ${chain.name} (${pct(y.apr)})`,
        thesis: `${y.project} on ${chain.name} pays ${pct(y.apr)} base on ${y.symbol}; the best USDC supply on Arbitrum One pays ${floating ? pct(floating.supplyApr) : "n/a"}. LI.FI delivers ${y.symbol} directly from Arbitrum One USDC for ${pct(q.costFraction)} one way.`,
        legs, capacityUsd: q.depthUsd ?? 0, riskFactors: common, executable: true,
        params: { chainId: y.chainId, chain: chain.name, token: y.token.address, tokenSymbol: y.symbol, project: y.project, shape: "direct", floatingApr: floating?.supplyApr ?? 0 },
      }));
    }
    // Shape 2: USDC collateral stays on Aave (Arbitrum One); bridge only the loan.
    if (aaveUsdc?.borrowApr != null) {
      const b = aaveUsdc.liqThreshold / ctx.targetHealthFactor;
      if (y.apr - aaveUsdc.borrowApr - 2 * q.costFraction * (365 / ctx.horizonDays) <= 0.005) continue;
      const legs: Leg[] = [
        { action: "supply", venue: "aave-v3", symbol: "USDC", weight: 1, apr: aaveUsdc.supplyApr, note: "collateral stays on Arbitrum One" },
        { action: "borrow", venue: "aave-v3", symbol: "USDC", weight: b, apr: -aaveUsdc.borrowApr, note: `HF ${ctx.targetHealthFactor}` },
        { action: "bridge", venue: `lifi/${q.tool}`, symbol: `USDC→${y.symbol}`, weight: b, apr: 0, chainId: y.chainId, costOneWay: q.costFraction },
        { action: "hold", venue, symbol: y.symbol, weight: b, apr: y.apr, chainId: y.chainId },
      ];
      out.push(assemble(ctx, {
        id: slug("xchain-yield", chain.slug, y.project, y.symbol, "levered"),
        strategy: "xchain-yield",
        title: `Borrow USDC on Aave (${pct(aaveUsdc.borrowApr)}), bridge into ${y.symbol} on ${chain.name} (${pct(y.apr)})`,
        thesis: `Cross-chain rate carry: collateral and debt stay on Arbitrum One, the borrowed USDC earns ${pct(y.apr)} on ${chain.name}. The loan's health factor does not depend on the bridged leg, but repaying it requires bridging back.`,
        legs, capacityUsd: Math.min((q.depthUsd ?? 0) / b, aaveUsdc.availableUsd / b), riskFactors: [...common, risk.leverage(1 + b), { points: 5, why: "debt on one chain, asset on another" }],
        healthFactor: ctx.targetHealthFactor, executable: true,
        params: { chainId: y.chainId, chain: chain.name, token: y.token.address, tokenSymbol: y.symbol, project: y.project, shape: "levered", debtRatio: b },
      }));
    }
  }
  return out;
};
