import { DEFAULTS, PERP_TO_SPOT } from "../config.ts";
import { assemble, bestSupply, holdApr, makeContext, pct, risk, slug, swapCostBps, type StrategyContext } from "../strategies/common.ts";
import { riskAdjusted, scanMarket } from "../strategies/index.ts";
import { isStable } from "../tokens.ts";
import type { Address, MarketSnapshot, Opportunity, WalletPosition, WalletReport } from "../types.ts";
import { readWallet } from "./wallet.ts";

const MIN_USD = Number(process.env.CARRY_WALLET_MIN_USD ?? 50);

const walletOpp = (ctx: StrategyContext, o: Parameters<typeof assemble>[1] & { amountUsd: number }): Opportunity => {
  const op = assemble(ctx, { ...o, scope: "wallet" });
  op.walletImpact = { amountUsd: o.amountUsd, usdPerYear: op.netApr * o.amountUsd };
  return op;
};

/**
 * Turn a wallet's positions into concrete actions. Each opportunity's netApr is the CHANGE in carry
 * on the amount it touches, so walletImpact.usdPerYear is the extra dollars per year from acting.
 */
export const walletOpportunities = (snap: MarketSnapshot, positions: WalletPosition[], health: WalletReport["aave"], marketOpps: Opportunity[]): Opportunity[] => {
  const ctx = makeContext(snap, { referenceCapitalUsd: 10_000 });
  const out: Opportunity[] = [];
  const topExecUsd = marketOpps.filter((o) => o.executable && o.risk.score <= DEFAULTS.maxRiskScore && (o.strategy !== "basis" || o.params.shape === "funded") && !["fx-carry"].includes(o.strategy)).sort((a, b) => riskAdjusted(b) - riskAdjusted(a))[0];

  for (const p of positions) {
    if (p.usd < MIN_USD) continue;

    // Idle tokens in the wallet.
    if (p.kind === "balance") {
      const sym = p.symbol === "ETH" ? "WETH" : p.symbol;
      const sup = bestSupply(snap, sym);
      const supApr = (sup?.supplyApr ?? 0) + holdApr(snap, sym);
      if (sup && supApr - p.apr > 0.002) {
        out.push(walletOpp(ctx, {
          id: slug("wallet", "idle", p.symbol, sup.venue), strategy: "wallet",
          title: `Supply idle ${p.symbol} on ${sup.venue} (+${pct(supApr - p.apr)})`,
          thesis: `${p.amount.toFixed(4)} ${p.symbol} ($${Math.round(p.usd)}) sits idle earning ${pct(p.apr)}. ${sup.venue} pays ${pct(sup.supplyApr)}${p.symbol === "ETH" ? " after wrapping to WETH" : ""}. Same exposure, withdraw any time.`,
          legs: [{ action: "supply", venue: sup.venue, symbol: sym, weight: 1, apr: supApr - p.apr }],
          capacityUsd: p.usd, amountUsd: p.usd,
          riskFactors: [risk.venue(sup.venue), { points: 3, why: "smart-contract risk of the lending venue" }],
          executable: sup.executable, params: { action: "supply", symbol: sym, venue: sup.venue, amountUsd: p.usd, comet: sup.comet ?? "" },
        }));
      }
      // WETH/ETH earning nothing next to a staking token: switch to wstETH.
      if (sym === "WETH") {
        const st = holdApr(snap, "wstETH");
        const cost = (2 * swapCostBps("WETH→wstETH")) / 1e4;
        if (st > supApr + 0.003) out.push(walletOpp(ctx, {
          id: slug("wallet", "stake", p.symbol), strategy: "wallet",
          title: `Swap idle ${p.symbol} to wstETH (+${pct(st - p.apr)} staking)`,
          thesis: `Keeps ETH exposure and adds ${pct(st)} Lido staking yield. The WETH/wstETH 0.01% pool makes the round trip cost about ${(cost * 1e4).toFixed(0)} bps.`,
          legs: [{ action: "swap", venue: "uniswap-v3", symbol: "WETH→wstETH", weight: 1, apr: 0 }, { action: "hold", venue: "wallet", symbol: "wstETH", weight: 1, apr: st - p.apr }],
          capacityUsd: p.usd, amountUsd: p.usd,
          riskFactors: [risk.asset("wstETH")],
          executable: true, params: { action: "swap", from: "WETH", to: "wstETH", amountUsd: p.usd },
        }));
      }
      // Idle volatile spot with a rich GMX short: lock in funding by hedging.
      const perpSym = Object.entries(PERP_TO_SPOT).find(([, s]) => s === sym)?.[0];
      if (perpSym) {
        const perp = snap.perps.filter((m) => m.venue === "gmx-v2" && m.symbol === perpSym && m.openInterestLongUsd + m.openInterestShortUsd > 250_000).sort((a, b) => b.shortCarryApr - a.shortCarryApr)[0];
        if (perp && perp.shortCarryApr > 0.05) {
          const Lp = ctx.perpLeverage;
          out.push(walletOpp(ctx, {
            id: slug("wallet", "hedge", p.symbol, perp.name), strategy: "wallet",
            title: `Hedge your ${p.symbol} with a GMX short paid ${pct(perp.shortCarryApr)}`,
            thesis: `You hold $${Math.round(p.usd)} of ${p.symbol} unhedged. Shorting the same notional on ${perp.name} turns it into a cash-and-carry position: price risk off, ${pct(perp.shortCarryApr)}/yr funding on. Needs ${pct(1 / Lp, 0)} of the notional as USDC margin. Only do this if you do not want the ${p.symbol} upside.`,
            legs: [{ action: "short-perp", venue: "gmx-v2", symbol: perp.name, weight: 1, apr: perp.shortCarryApr, note: `${Lp}x` }],
            capacityUsd: Math.min(p.usd, perp.availableShortUsd), amountUsd: p.usd,
            riskFactors: [risk.extremeFunding(perp.shortCarryApr), risk.liquidation(0.9 / Lp), { points: 5, why: "gives up the spot upside" }],
            liquidationMovePct: 0.9 / Lp,
            executable: true, params: { action: "hedge", perpMarket: perp.gmx!.marketToken, perpName: perp.name, notionalUsd: p.usd, perpLeverage: Lp },
          }));
        }
      }
      // Idle tokens while borrowing the same token: repaying earns the borrow rate, risk-free.
      const debt = positions.find((d) => d.kind === "borrow" && d.symbol === sym);
      if (debt && -debt.apr > supApr) {
        const amt = Math.min(p.usd, debt.usd);
        out.push(walletOpp(ctx, {
          id: slug("wallet", "repay", p.symbol, debt.venue), strategy: "wallet",
          title: `Repay ${debt.venue} ${sym} debt with idle ${p.symbol} (saves ${pct(-debt.apr)})`,
          thesis: `You hold $${Math.round(p.usd)} ${p.symbol} idle while paying ${pct(-debt.apr)} on $${Math.round(debt.usd)} of ${sym} debt. Repaying beats every supply rate for this asset and raises your health factor.`,
          legs: [{ action: "repay", venue: debt.venue, symbol: sym, weight: 1, apr: -debt.apr - p.apr }],
          capacityUsd: amt, amountUsd: amt,
          riskFactors: [],
          executable: debt.venue === "aave-v3", params: { action: "repay", symbol: sym, venue: debt.venue, amountUsd: amt },
        }));
      }
      // Idle stables: point at the best executable market-wide carry.
      if (isStable(sym) && topExecUsd && topExecUsd.netApr > supApr + 0.01) {
        out.push(walletOpp(ctx, {
          id: slug("wallet", "deploy", p.symbol, topExecUsd.id), strategy: "wallet",
          title: `Deploy idle ${p.symbol} into: ${topExecUsd.title}`,
          thesis: `Best executable market carry right now nets ${pct(topExecUsd.netApr)} (risk ${topExecUsd.risk.grade}) versus ${pct(supApr)} for a plain supply. ${topExecUsd.thesis}`,
          legs: topExecUsd.legs,
          capacityUsd: Math.min(p.usd, topExecUsd.capacityUsd), amountUsd: p.usd,
          riskFactors: [{ points: topExecUsd.risk.score, why: `inherits ${topExecUsd.id} risk` }],
          executable: true, params: { action: "deploy", opportunityId: topExecUsd.id, amountUsd: p.usd },
        }));
      }
    }

    // Supplied on a worse venue than the best executable one.
    if (p.kind === "supply" && !(p.detail?.collateral === true && p.venue === "compound-v3")) {
      const best = bestSupply(snap, p.symbol);
      const cur = p.apr - holdApr(snap, p.symbol);
      if (best && best.venue !== p.venue && best.supplyApr - cur > 0.005) {
        out.push(walletOpp(ctx, {
          id: slug("wallet", "move-supply", p.symbol, p.venue, best.venue), strategy: "wallet",
          title: `Move ${p.symbol} supply ${p.venue} → ${best.venue} (+${pct(best.supplyApr - cur)})`,
          thesis: `Your ${p.symbol} on ${p.venue} earns ${pct(cur)}; ${best.venue} pays ${pct(best.supplyApr)}. Check it is not backing a loan before moving.`,
          legs: [{ action: "withdraw", venue: p.venue, symbol: p.symbol, weight: 1, apr: -cur }, { action: "supply", venue: best.venue, symbol: p.symbol, weight: 1, apr: best.supplyApr }],
          capacityUsd: Math.min(p.usd, best.availableUsd || p.usd), amountUsd: p.usd,
          riskFactors: [{ points: p.detail?.collateral ? 15 : 2, why: p.detail?.collateral ? "position is collateral: moving it lowers your health factor" : "venue switch" }],
          executable: best.executable, params: { action: "move-supply", symbol: p.symbol, from: p.venue, to: best.venue, amountUsd: p.usd },
        }));
      }
    }

    // Borrowing where it is dearer than another venue.
    if (p.kind === "borrow") {
      const cur = -p.apr;
      const alt = snap.lending.filter((m) => m.symbol === p.symbol && m.canBorrow && m.borrowApr !== null && m.executable && m.venue !== p.venue).sort((a, b) => a.borrowApr! - b.borrowApr!)[0];
      if (alt && cur - alt.borrowApr! > 0.003) {
        out.push(walletOpp(ctx, {
          id: slug("wallet", "refi", p.symbol, p.venue, alt.venue), strategy: "wallet",
          title: `Refinance ${p.symbol} debt ${p.venue} → ${alt.venue} (−${pct(cur - alt.borrowApr!)})`,
          thesis: `You pay ${pct(cur)} on $${Math.round(p.usd)} of ${p.symbol} debt; ${alt.venue} charges ${pct(alt.borrowApr!)}. A flash-loan refinance moves debt and collateral in one transaction.`,
          legs: [{ action: "repay", venue: p.venue, symbol: p.symbol, weight: 1, apr: cur }, { action: "borrow", venue: alt.venue, symbol: p.symbol, weight: 1, apr: -alt.borrowApr! }],
          capacityUsd: Math.min(p.usd, alt.availableUsd), amountUsd: p.usd,
          riskFactors: [{ points: 10, why: "collateral must move with the debt; the new venue may list it at a different LTV" }],
          executable: false, whyNotExecutable: "multi-venue refinance is plan-only in this build",
          params: { action: "refinance", symbol: p.symbol, from: p.venue, to: alt.venue, amountUsd: p.usd },
        }));
      }
    }

    // Perps paying heavy funding.
    if (p.kind === "perp" && p.apr < -0.1) {
      out.push(walletOpp(ctx, {
        id: slug("wallet", "perp-bleed", p.symbol, String(p.detail?.side)), strategy: "wallet",
        title: `Your ${p.detail?.side} ${p.symbol} pays ${pct(-p.apr)}/yr in funding`,
        thesis: `$${Math.round(p.usd)} of size costs about $${Math.round(-p.apr * p.usd)}/yr at the current rate. Close it, cut size, or offset it with spot so the carry stops bleeding.`,
        legs: [{ action: "close-perp", venue: "gmx-v2", symbol: p.symbol, weight: 1, apr: -p.apr }],
        capacityUsd: p.usd, amountUsd: p.usd,
        riskFactors: [{ points: 10, why: "closing realises PnL and changes your exposure" }],
        executable: true, params: { action: "close-perp", market: String(p.detail?.market ?? ""), side: String(p.detail?.side), sizeUsd: p.usd },
      }));
    }
  }

  // Health factor warnings.
  if (health && health.debtUsd > 0 && health.healthFactor < DEFAULTS.minHealthFactor) {
    const target = DEFAULTS.targetHealthFactor;
    const repay = health.debtUsd - (health.collateralUsd * (health.healthFactor * health.debtUsd / Math.max(1, health.collateralUsd))) / target;
    out.push(walletOpp(ctx, {
      id: slug("wallet", "health"), strategy: "wallet",
      title: `Aave health factor ${health.healthFactor.toFixed(2)}: repay ~$${Math.round(Math.max(0, repay))} to reach ${target}`,
      thesis: `Below ${DEFAULTS.minHealthFactor} a normal market move can trigger liquidation (a 5-10% penalty). Repaying debt or adding collateral restores the buffer.`,
      legs: [{ action: "repay", venue: "aave-v3", symbol: "debt", weight: 1, apr: 0 }],
      capacityUsd: health.debtUsd,
      riskFactors: [{ points: 80, why: "liquidation risk now" }],
      healthFactor: health.healthFactor,
      amountUsd: 0,
      executable: false, whyNotExecutable: "shown as an alert; the bot's run loop deleverages its own positions automatically",
      params: { action: "deleverage", healthFactor: health.healthFactor },
    }));
  }
  // Alerts first, then by dollars per year.
  const alert = (o: Opportunity) => (o.params.action === "deleverage" ? 1 : 0);
  return out.sort((a, b) => alert(b) - alert(a) || (b.walletImpact?.usdPerYear ?? 0) - (a.walletImpact?.usdPerYear ?? 0));
};

/** Full wallet report: positions, current carry, and what acting on the suggestions adds. */
export const walletReport = async (address: Address, snap: MarketSnapshot): Promise<WalletReport> => {
  const state = await readWallet(address, snap);
  const marketOpps = scanMarket(snap);
  const opportunities = walletOpportunities(snap, state.positions, state.aave, marketOpps);
  let netWorth = 0;
  let carry = 0;
  for (const p of state.positions) {
    if (p.kind === "perp") netWorth += Number(p.detail?.collateralUsd ?? 0);
    else netWorth += p.kind === "borrow" ? -p.usd : p.usd;
    carry += p.usd * p.apr;
  }
  // Suggestions can overlap (e.g. "supply idle USDC" and "deploy idle USDC"); count the best per asset.
  const bestPerAmount = new Map<string, number>();
  for (const o of opportunities) {
    // Ids look like wallet:<kind>:<asset>:...; alternatives on the same asset do not stack.
    const key = o.id.split(":")[2] ?? o.id;
    bestPerAmount.set(key, Math.max(bestPerAmount.get(key) ?? 0, o.walletImpact?.usdPerYear ?? 0));
  }
  const potential = [...bestPerAmount.values()].reduce((s, x) => s + Math.max(0, x), 0);
  return {
    address,
    asOf: new Date().toISOString(),
    netWorthUsd: netWorth,
    currentCarryUsdPerYear: carry,
    currentCarryApr: netWorth > 0 ? carry / netWorth : 0,
    aave: state.aave,
    positions: state.positions.sort((a, b) => b.usd - a.usd),
    opportunities,
    potentialCarryUsdPerYear: potential,
  };
};

export type { Address };
