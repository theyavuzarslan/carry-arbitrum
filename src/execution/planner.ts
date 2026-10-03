import { parseUnits } from "viem";
import { TOKENS } from "../config.ts";
import { tokenAddress } from "../tokens.ts";
import type { Address, MarketSnapshot, Opportunity, PerpMarket } from "../types.ts";
import type { Action, Amount } from "./actions.ts";

export class PlanError extends Error {}

const SLIPPAGE_BPS = Number(process.env.CARRY_SLIPPAGE_BPS ?? 50);
const PERP_SLIPPAGE_BPS = Number(process.env.CARRY_PERP_SLIPPAGE_BPS ?? 50);

let snapForAddr: MarketSnapshot | undefined;
/** Token address: the verified config list first, then the address a lending market reported on-chain. */
const addr = (s: string): Address => {
  const a = tokenAddress(s) ?? (snapForAddr?.lending.find((m) => m.symbol === s && m.asset && m.source === "onchain")?.asset as Address | undefined);
  if (!a) throw new PlanError(`no token address for ${s}`);
  return a;
};

const decimalsOf = (snap: MarketSnapshot, s: string): number =>
  snap.lending.find((m) => m.symbol === s && m.decimals !== undefined)?.decimals ?? (s === "USDC" || s === "USDT" || s === "USDC.e" ? 6 : s === "WBTC" ? 8 : 18);

const price = (snap: MarketSnapshot, s: string): number => {
  const p = snap.prices[s] ?? snap.prices[s === "WETH" ? "ETH" : s === "WBTC" ? "BTC" : s];
  if (!p) throw new PlanError(`no price for ${s}`);
  return p;
};

/** USD → token smallest units at the snapshot price. */
export const units = (snap: MarketSnapshot, s: string, usd: number): bigint =>
  parseUnits((usd / price(snap, s)).toFixed(Math.min(decimalsOf(snap, s), 12)), decimalsOf(snap, s));

const usdc = (usd: number): bigint => parseUnits(usd.toFixed(6), 6);

const perpOf = (snap: MarketSnapshot, market: string): PerpMarket => {
  const p = snap.perps.find((m) => m.gmx?.marketToken.toLowerCase() === String(market).toLowerCase());
  if (!p) throw new PlanError(`GMX market ${market} not in snapshot`);
  return p;
};

const supplyTo = (venue: string, token: Address, amount: Amount, comet?: string, eMode?: number): Action[] => {
  if (venue === "aave-v3") return [...(eMode ? [{ t: "aave.emode", id: eMode } as Action] : []), { t: "aave.supply", token, amount }];
  if (venue === "compound-v3") {
    if (!comet) throw new PlanError("compound route without comet address");
    return [{ t: "comet.supply", comet: comet as Address, token, amount }];
  }
  if (venue === "wallet" || venue === "hold") return [];
  throw new PlanError(`no builder for venue ${venue}`);
};

const borrowFrom = (venue: string, token: Address, amount: bigint, comet?: string): Action => {
  if (venue === "aave-v3") return { t: "aave.borrow", token, amount };
  if (venue === "compound-v3") return { t: "comet.withdraw", comet: comet as Address, token, amount };
  throw new PlanError(`no borrow builder for ${venue}`);
};

const cometFor = (snap: MarketSnapshot, base: string): string | undefined =>
  snap.lending.find((m) => m.venue === "compound-v3" && m.canBorrow && m.symbol === base)?.comet;

/**
 * Turn an opportunity into ordered actions for an account that starts with `capitalUsd` of USDC.
 * Sizes come from the snapshot; amounts that depend on a previous step's output use {all: token}.
 */
export const planActions = (opp: Opportunity, capitalUsd: number, snap: MarketSnapshot): { actions: Action[]; notes: string[] } => {
  if (!opp.executable) throw new PlanError(`not executable: ${opp.whyNotExecutable ?? "no builder"}`);
  if (capitalUsd > opp.capacityUsd) throw new PlanError(`capital $${capitalUsd} exceeds capacity $${Math.round(opp.capacityUsd)}`);
  snapForAddr = snap;
  const P = opp.params;
  const C = capitalUsd;
  const USDC = TOKENS.USDC as Address;
  const notes: string[] = [];
  const a: Action[] = [];

  switch (opp.strategy) {
    case "basis": {
      const perp = perpOf(snap, String(P.perpMarket));
      const spot = String(P.spot);
      const S = addr(spot);
      const Lp = Number(P.perpLeverage);
      const g = perp.gmx!;
      if (P.shape === "funded" && P.margin === "USDC") {
        const N = (C * Lp) / (Lp + 1);
        a.push({ t: "swap", tokenIn: USDC, tokenOut: S, amountIn: usdc(N), slippageBps: SLIPPAGE_BPS });
        a.push(...supplyTo(String(P.spotVenue), S, { all: S }, cometFor(snap, spot)));
        a.push({ t: "gmx.order", market: g.marketToken, collateralToken: USDC, collateralAmount: { all: USDC }, sizeUsd: N, isLong: false, markPx: perp.markPx, indexDecimals: g.indexDecimals, slippageBps: PERP_SLIPPAGE_BPS });
        notes.push(`$${N.toFixed(0)} of ${spot} hedged by a $${N.toFixed(0)} GMX short on ${Lp}x with $${(C - N).toFixed(0)} USDC margin.`);
      } else if (P.shape === "funded") {
        a.push({ t: "swap", tokenIn: USDC, tokenOut: S, amountIn: { all: USDC }, slippageBps: SLIPPAGE_BPS });
        a.push(...supplyTo(String(P.spotVenue), S, { all: S, bps: Math.round((1 - 1 / Lp) * 1e4) }, cometFor(snap, spot)));
        a.push({ t: "gmx.order", market: g.marketToken, collateralToken: S, collateralAmount: { all: S }, sizeUsd: C, isLong: false, markPx: perp.markPx, indexDecimals: g.indexDecimals, slippageBps: PERP_SLIPPAGE_BPS });
        notes.push(`Coin-margined: ${((1 - 1 / Lp) * 100).toFixed(0)}% of the ${spot} is supplied, the rest is GMX margin; the short covers the full $${C}.`);
      } else {
        const debt = C / Lp;
        a.push({ t: "swap", tokenIn: USDC, tokenOut: S, amountIn: { all: USDC }, slippageBps: SLIPPAGE_BPS });
        a.push(...supplyTo(String(P.lendVenue), S, { all: S }, String(P.comet), Number(P.eMode)));
        a.push(borrowFrom(String(P.lendVenue), USDC, usdc(debt), String(P.comet)));
        a.push({ t: "gmx.order", market: g.marketToken, collateralToken: USDC, collateralAmount: { all: USDC }, sizeUsd: C * 0.995, isLong: false, markPx: perp.markPx, indexDecimals: g.indexDecimals, slippageBps: PERP_SLIPPAGE_BPS });
        notes.push(`All $${C} in ${spot} as collateral; $${debt.toFixed(0)} USDC borrowed as GMX margin for a $${C} short.`);
      }
      break;
    }
    case "reverse-basis": {
      const perp = perpOf(snap, String(P.perpMarket));
      const spot = String(P.spot);
      const S = addr(spot);
      const g = perp.gmx!;
      const Lp = Number(P.perpLeverage);
      const N = Number(P.notionalPerCapital) * C;
      const borrowUsd = Number(P.borrowWeight) * C;
      const venue = String(P.lendVenue);
      const comet = String(P.comet) || undefined;
      a.push(...supplyTo(venue, USDC, usdc(C), comet));
      a.push(borrowFrom(venue, S, units(snap, spot, borrowUsd), comet));
      if (P.margin === spot) {
        a.push({ t: "swap", tokenIn: S, tokenOut: USDC, amountIn: { all: S, bps: Math.round((N / borrowUsd) * 1e4) }, slippageBps: SLIPPAGE_BPS });
        a.push(...supplyTo(venue, USDC, { all: USDC }, comet));
        a.push({ t: "gmx.order", market: g.marketToken, collateralToken: S, collateralAmount: { all: S }, sizeUsd: N, isLong: true, markPx: perp.markPx, indexDecimals: g.indexDecimals, slippageBps: PERP_SLIPPAGE_BPS });
      } else {
        a.push({ t: "swap", tokenIn: S, tokenOut: USDC, amountIn: { all: S }, slippageBps: SLIPPAGE_BPS });
        a.push(...supplyTo(venue, USDC, { all: USDC, bps: Math.round((1 - 1 / Lp) * 1e4) }, comet));
        a.push({ t: "gmx.order", market: g.marketToken, collateralToken: USDC, collateralAmount: { all: USDC }, sizeUsd: N, isLong: true, markPx: perp.markPx, indexDecimals: g.indexDecimals, slippageBps: PERP_SLIPPAGE_BPS });
      }
      notes.push(`Short $${borrowUsd.toFixed(0)} of ${spot} via ${venue}, long $${N.toFixed(0)} on GMX. Target HF ${opp.risk.healthFactor?.toFixed(2)}.`);
      break;
    }
    case "lend-borrow":
    case "fx-carry": {
      const X = String(P.collateral);
      const F = String(P.funding);
      const Z = String(P.target);
      const venue = String(P.lendVenue);
      const comet = String(P.comet) || undefined;
      if (X !== "USDC") a.push({ t: "swap", tokenIn: USDC, tokenOut: addr(X), amountIn: usdc(C), slippageBps: SLIPPAGE_BPS });
      a.push(...supplyTo(venue, addr(X), X === "USDC" ? usdc(C) : { all: addr(X) }, comet, Number(P.eMode)));
      const debtUsd = Number(P.debtRatio) * C;
      a.push(borrowFrom(venue, addr(F), units(snap, F, debtUsd), comet));
      if (Z !== F) a.push({ t: "swap", tokenIn: addr(F), tokenOut: addr(Z), amountIn: { all: addr(F) }, slippageBps: SLIPPAGE_BPS });
      a.push(...supplyTo(String(P.targetVenue), addr(Z), { all: addr(Z) }, cometFor(snap, Z)));
      notes.push(`Borrow $${debtUsd.toFixed(0)} ${F} against $${C} ${X}; deploy into ${Z} on ${P.targetVenue}.`);
      break;
    }
    case "lst-loop": {
      const lst = String(P.collateral);
      const L = addr(lst);
      const WETH = TOKENS.WETH as Address;
      const lev = Number(P.leverage);
      const venue = String(P.lendVenue);
      const comet = String(P.comet) || undefined;
      a.push({ t: "swap", tokenIn: USDC, tokenOut: L, amountIn: usdc(C), slippageBps: SLIPPAGE_BPS });
      if (venue === "aave-v3" && P.eMode) a.push({ t: "aave.emode", id: Number(P.eMode) });
      // Supply / borrow / swap rounds until debt reaches (L-1) x capital, each borrow within the LTV.
      const ltv = (venue === "aave-v3" ? (snap.lending.find((m) => m.venue === "aave-v3" && m.symbol === lst)?.eModes?.find((e) => e.id === Number(P.eMode))?.ltv) : snap.lending.find((m) => m.venue === "compound-v3" && m.comet === comet && m.symbol === lst)?.ltv) ?? 0.75;
      const targetDebt = (lev - 1) * C;
      let coll = C;
      let debt = 0;
      for (let round = 0; round < 15 && debt < targetDebt * 0.995; round++) {
        a.push(...supplyTo(venue, L, { all: L }, comet));
        const b = Math.min(targetDebt - debt, coll * ltv * 0.9 - debt);
        if (b <= 0) break;
        a.push(borrowFrom(venue, WETH, units(snap, "WETH", b), comet));
        a.push({ t: "swap", tokenIn: WETH, tokenOut: L, amountIn: { all: WETH }, slippageBps: SLIPPAGE_BPS });
        debt += b;
        coll += b;
      }
      a.push(...supplyTo(venue, L, { all: L }, comet));
      const rounds = a.filter((x) => x.t === "aave.borrow" || x.t === "comet.withdraw").length;
      notes.push(venue === "aave-v3"
        ? `${lev}x ${lst} loop: ${rounds} supply/borrow/swap rounds as plain transactions, or ONE CarryAccount.openLoop flash-loan transaction (used automatically in fork/live mode when contracts/out exists).`
        : `${lev}x ${lst} loop on Compound: ${rounds} supply/borrow/swap rounds (capped at 15; leverage converges just under target).`);
      break;
    }
    case "wallet": {
      const act = String(P.action);
      if (act === "supply") {
        const s = String(P.symbol);
        if (s === "WETH") notes.push("Wrap native ETH first if the idle balance is ETH.");
        a.push(...supplyTo(String(P.venue), addr(s), { all: addr(s) }, String(P.comet) || undefined));
      } else if (act === "swap") {
        a.push({ t: "swap", tokenIn: addr(String(P.from)), tokenOut: addr(String(P.to)), amountIn: { all: addr(String(P.from)) }, slippageBps: SLIPPAGE_BPS });
      } else if (act === "repay") {
        const s = String(P.symbol);
        a.push({ t: "aave.repay", token: addr(s), amount: units(snap, s, Number(P.amountUsd)) });
      } else if (act === "hedge") {
        const perp = perpOf(snap, String(P.perpMarket));
        const n = Math.min(capitalUsd, Number(P.notionalUsd));
        const Lp = Number(P.perpLeverage);
        a.push({ t: "gmx.order", market: perp.gmx!.marketToken, collateralToken: USDC, collateralAmount: usdc(n / Lp), sizeUsd: n, isLong: false, markPx: perp.markPx, indexDecimals: perp.gmx!.indexDecimals, slippageBps: PERP_SLIPPAGE_BPS });
        notes.push(`Needs $${(n / Lp).toFixed(0)} USDC in the wallet for margin.`);
      } else if (act === "close-perp") {
        const perp = perpOf(snap, String(P.market));
        a.push({ t: "gmx.order", market: perp.gmx!.marketToken, collateralToken: USDC, collateralAmount: 0n, sizeUsd: Number(P.sizeUsd), isLong: P.side === "long", markPx: perp.markPx, indexDecimals: perp.gmx!.indexDecimals, slippageBps: PERP_SLIPPAGE_BPS, decrease: true });
      } else {
        throw new PlanError(`wallet action ${act} is advisory; plan the referenced opportunity instead`);
      }
      break;
    }
    case "xchain-basis": {
      const perp = perpOf(snap, String(P.perpMarket));
      const Lp = Number(P.perpLeverage);
      const N = (C * Lp) / (Lp + 1);
      a.push({ t: "bridge", toChainId: Number(P.chainId), fromToken: USDC, toToken: P.token as Address, amountIn: usdc(N), slippageBps: SLIPPAGE_BPS });
      a.push({ t: "gmx.order", market: perp.gmx!.marketToken, collateralToken: USDC, collateralAmount: { all: USDC }, sizeUsd: N * (1 - Number(P.bridgeCost) - 0.002), isLong: false, markPx: perp.markPx, indexDecimals: perp.gmx!.indexDecimals, slippageBps: PERP_SLIPPAGE_BPS });
      notes.push(`$${N.toFixed(0)} USDC bridged into ${P.tokenSymbol} on ${P.chain}; GMX short sized to the post-bridge notional with $${(C - N).toFixed(0)} USDC margin on Arbitrum One.`);
      notes.push(`Open the short only after the bridge lands (~a minute) so the hedge never exists without the spot. In fork mode the destination side cannot be observed.`);
      break;
    }
    case "xchain-yield": {
      if (P.shape === "direct") {
        a.push({ t: "bridge", toChainId: Number(P.chainId), fromToken: USDC, toToken: P.token as Address, amountIn: usdc(C), slippageBps: SLIPPAGE_BPS });
        notes.push(`All $${C} USDC delivered as ${P.tokenSymbol} on ${P.chain} in one LI.FI transaction.`);
      } else if (P.shape === "levered") {
        const debt = Number(P.debtRatio) * C;
        a.push({ t: "aave.supply", token: USDC, amount: usdc(C) });
        a.push({ t: "aave.borrow", token: USDC, amount: usdc(debt) });
        a.push({ t: "bridge", toChainId: Number(P.chainId), fromToken: USDC, toToken: P.token as Address, amountIn: { all: USDC }, slippageBps: SLIPPAGE_BPS });
        notes.push(`$${C} USDC stays on Aave as collateral; $${debt.toFixed(0)} borrowed and delivered as ${P.tokenSymbol} on ${P.chain}.`);
      } else throw new PlanError("two-step cross-chain deposits are plan-only");
      break;
    }
    default:
      throw new PlanError(`no planner for ${opp.strategy}`);
  }
  return { actions: a, notes };
};
