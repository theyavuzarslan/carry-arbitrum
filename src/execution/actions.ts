import { encodeFunctionData, maxUint256, type PublicClient } from "viem";
import { aavePoolAbi, cometAbi, erc20Abi, wethAbi } from "../abis.ts";
import { AAVE, GMX, TOKENS, UNISWAP } from "../config.ts";
import type { Address, Hex, TxStep } from "../types.ts";
import { getClient } from "../rpc.ts";
import { chainById } from "../chains.ts";
import { lifiQuote } from "../sources/xchain.ts";
import { buildGmxOrder } from "./gmx.ts";
import { bestRoute, exactInputData } from "./uniswap.ts";

/**
 * An amount is either exact, or "a share of whatever the account holds of this token when the step
 * runs". The second form lets a supply use the real output of the swap before it.
 */
export type Amount = bigint | { all: Address; bps?: number };

export type Action =
  | { t: "wrap"; wei: bigint }
  | { t: "swap"; tokenIn: Address; tokenOut: Address; amountIn: Amount; slippageBps: number }
  | { t: "aave.supply"; token: Address; amount: Amount }
  | { t: "aave.borrow"; token: Address; amount: bigint }
  | { t: "aave.repay"; token: Address; amount: Amount }
  | { t: "aave.withdraw"; token: Address; amount: bigint | "max" }
  | { t: "aave.emode"; id: number }
  | { t: "comet.supply"; comet: Address; token: Address; amount: Amount }
  | { t: "comet.withdraw"; comet: Address; token: Address; amount: bigint }
  | { t: "gmx.order"; market: Address; collateralToken: Address; collateralAmount: Amount; sizeUsd: number; isLong: boolean; markPx: number; indexDecimals: number; slippageBps: number; decrease?: boolean }
  | { t: "bridge"; toChainId: number; fromToken: Address; toToken: Address; amountIn: Amount; slippageBps: number }
  | { t: "raw"; step: TxStep };

export const describe = (a: Action): string => {
  switch (a.t) {
    case "wrap": return `wrap ${a.wei} wei ETH → WETH`;
    case "swap": return `swap ${sym(a.tokenIn)} → ${sym(a.tokenOut)} on Uniswap v3`;
    case "aave.supply": return `supply ${sym(a.token)} to Aave v3`;
    case "aave.borrow": return `borrow ${sym(a.token)} from Aave v3 (variable)`;
    case "aave.repay": return `repay ${sym(a.token)} on Aave v3`;
    case "aave.withdraw": return `withdraw ${sym(a.token)} from Aave v3`;
    case "aave.emode": return `enable Aave e-mode ${a.id}`;
    case "comet.supply": return `supply ${sym(a.token)} to Compound v3`;
    case "comet.withdraw": return `withdraw/borrow ${sym(a.token)} from Compound v3`;
    case "gmx.order": return `GMX ${a.decrease ? "decrease" : "open"} ${a.isLong ? "long" : "short"} $${Math.round(a.sizeUsd)}`;
    case "bridge": return `bridge ${sym(a.fromToken)} → ${a.toToken.slice(0, 8)} on chain ${a.toChainId} via LI.FI`;
    case "raw": return a.step.label;
  }
};

/** Keeper gas the GMX v2.2 contracts charge an increase order for (4,177,115 gwei at 1.0115 gwei). */
export const GMX_ORDER_GAS = 4_200_000n;

const symBy = new Map(Object.entries(TOKENS).map(([s, a]) => [a.toLowerCase(), s]));
export const sym = (a: Address): string => symBy.get(a.toLowerCase()) ?? a.slice(0, 8);

/**
 * Balance source used while compiling. In execution it reads the chain; in plan mode it tracks an
 * estimated ledger so later steps can reference outputs of earlier ones.
 */
export interface Balances {
  get(token: Address): Promise<bigint>;
  add(token: Address, delta: bigint): void;
  live: boolean;
}

export const chainBalances = (client: PublicClient, account: Address): Balances => ({
  live: true,
  get: (token) => client.readContract({ address: token, abi: erc20Abi, functionName: "balanceOf", args: [account] }),
  add: () => {},
});

export const ledgerBalances = (start: Record<string, bigint> = {}): Balances => {
  const m = new Map(Object.entries(start).map(([k, v]) => [k.toLowerCase(), v]));
  return {
    live: false,
    get: async (t) => m.get(t.toLowerCase()) ?? 0n,
    add: (t, d) => m.set(t.toLowerCase(), (m.get(t.toLowerCase()) ?? 0n) + d),
  };
};

const resolve = async (a: Amount, bal: Balances): Promise<bigint> => {
  if (typeof a === "bigint") return a;
  const b = await bal.get(a.all);
  return (b * BigInt(a.bps ?? 10_000)) / 10_000n;
};

const approve = (token: Address, spender: Address, amount: bigint): TxStep => ({
  label: `approve ${sym(token)} for ${spender === AAVE.POOL ? "Aave" : spender === UNISWAP.SWAP_ROUTER_02 ? "Uniswap" : spender === GMX.ROUTER ? "GMX Router" : spender.toLowerCase() === "0x1231deb6f5749ef6ce6943a275a1d3e7486f4eae" ? "LI.FI Diamond" : spender.slice(0, 8)} (exact amount)`,
  to: token,
  data: encodeFunctionData({ abi: erc20Abi, functionName: "approve", args: [spender, amount] }),
  value: 0n,
});

/** Compile one action into the transactions it needs (approvals are exact, never unlimited). */
export const compile = async (a: Action, ctx: { client: PublicClient; account: Address; bal: Balances }): Promise<TxStep[]> => {
  const { client, account, bal } = ctx;
  switch (a.t) {
    case "wrap": {
      bal.add(TOKENS.WETH, a.wei);
      return [{ label: describe(a), to: TOKENS.WETH, data: encodeFunctionData({ abi: wethAbi, functionName: "deposit" }), value: a.wei }];
    }
    case "swap": {
      const amt = await resolve(a.amountIn, bal);
      if (amt === 0n) throw new Error(`nothing to swap: ${sym(a.tokenIn)} balance is 0`);
      // Route discovery and quotes read mainnet state directly: on a fork they would otherwise pull
      // dozens of pool slots through anvil one by one. The fork is at the same block, so prices match.
      const route = await bestRoute(getClient(), a.tokenIn, a.tokenOut, amt);
      const { data, minOut } = exactInputData(route, account, amt, a.slippageBps);
      bal.add(a.tokenIn, -amt);
      bal.add(a.tokenOut, route.amountOut);
      return [approve(a.tokenIn, UNISWAP.SWAP_ROUTER_02, amt), {
        label: `swap ${amt} ${sym(a.tokenIn)} → ≥${minOut} ${sym(a.tokenOut)} via ${route.tokens.map(sym).join("/")} fees ${route.fees.join("/")}`,
        to: UNISWAP.SWAP_ROUTER_02, data, value: 0n, expect: `quote ${route.amountOut}`,
      }];
    }
    case "aave.supply": {
      const amt = await resolve(a.amount, bal);
      bal.add(a.token, -amt);
      return [approve(a.token, AAVE.POOL, amt), { label: `supply ${amt} ${sym(a.token)} to Aave`, to: AAVE.POOL, value: 0n, data: encodeFunctionData({ abi: aavePoolAbi, functionName: "supply", args: [a.token, amt, account, 0] }) }];
    }
    case "aave.borrow": {
      bal.add(a.token, a.amount);
      return [{ label: `borrow ${a.amount} ${sym(a.token)} from Aave`, to: AAVE.POOL, value: 0n, data: encodeFunctionData({ abi: aavePoolAbi, functionName: "borrow", args: [a.token, a.amount, 2n, 0, account] }) }];
    }
    case "aave.repay": {
      const amt = await resolve(a.amount, bal);
      bal.add(a.token, -amt);
      return [approve(a.token, AAVE.POOL, amt), { label: `repay ${amt} ${sym(a.token)} on Aave`, to: AAVE.POOL, value: 0n, data: encodeFunctionData({ abi: aavePoolAbi, functionName: "repay", args: [a.token, amt, 2n, account] }) }];
    }
    case "aave.withdraw": {
      const amt = a.amount === "max" ? maxUint256 : a.amount;
      return [{ label: `withdraw ${a.amount} ${sym(a.token)} from Aave`, to: AAVE.POOL, value: 0n, data: encodeFunctionData({ abi: aavePoolAbi, functionName: "withdraw", args: [a.token, amt, account] }) }];
    }
    case "aave.emode":
      return [{ label: describe(a), to: AAVE.POOL, value: 0n, data: encodeFunctionData({ abi: aavePoolAbi, functionName: "setUserEMode", args: [a.id] }) }];
    case "comet.supply": {
      const amt = await resolve(a.amount, bal);
      bal.add(a.token, -amt);
      return [approve(a.token, a.comet, amt), { label: `supply ${amt} ${sym(a.token)} to Compound`, to: a.comet, value: 0n, data: encodeFunctionData({ abi: cometAbi, functionName: "supply", args: [a.token, amt] }) }];
    }
    case "comet.withdraw": {
      bal.add(a.token, a.amount);
      return [{ label: `withdraw ${a.amount} ${sym(a.token)} from Compound (borrows if base)`, to: a.comet, value: 0n, data: encodeFunctionData({ abi: cometAbi, functionName: "withdraw", args: [a.token, a.amount] }) }];
    }
    case "gmx.order": {
      const coll = await resolve(a.collateralAmount, bal);
      bal.add(a.collateralToken, -coll);
      // GMX requires executionFee >= estimated keeper gas x tx.gasprice. Measured on a fork: an increase
      // order needs ~4.13M gas-equivalents. Size from the live gas price with headroom; keepers refund excess.
      const gasPrice = await client.getGasPrice();
      const est = gasPrice * GMX_ORDER_GAS * 13n / 10n;
      const executionFeeWei = est > GMX.EXECUTION_FEE_WEI ? est : GMX.EXECUTION_FEE_WEI;
      const tx = buildGmxOrder({ executionFeeWei, account, market: a.market, collateralToken: a.collateralToken, collateralAmount: coll, sizeUsd: a.sizeUsd, isLong: a.isLong, markPx: a.markPx, indexDecimals: a.indexDecimals, slippageBps: a.slippageBps, decrease: a.decrease });
      const steps: TxStep[] = [];
      if (!a.decrease && coll > 0n) steps.push(approve(a.collateralToken, GMX.ROUTER, coll));
      steps.push({ label: `GMX ${a.decrease ? "decrease" : "increase"} ${a.isLong ? "LONG" : "SHORT"} $${Math.round(a.sizeUsd)} with ${coll} ${sym(a.collateralToken)} collateral`, to: tx.to, data: tx.data, value: tx.value, expect: "order created; a GMX keeper fills it at the next oracle price" });
      return steps;
    }
    case "bridge": {
      // Quote at send time with the real sender and amount: the returned transaction is the one to sign.
      const amt = await resolve(a.amountIn, bal);
      if (amt === 0n) throw new Error(`nothing to bridge: ${sym(a.fromToken)} balance is 0`);
      const q = await lifiQuote({ toChainId: a.toChainId, fromToken: a.fromToken, toToken: a.toToken, fromAmount: amt, fromAddress: account, slippage: a.slippageBps / 1e4 });
      bal.add(a.fromToken, -amt);
      const chain = chainById(a.toChainId)?.name ?? String(a.toChainId);
      const tx = q.transactionRequest;
      return [approve(a.fromToken, q.estimate.approvalAddress, amt), {
        label: `bridge ${amt} ${sym(a.fromToken)} → ≥${q.estimate.toAmountMin} of ${a.toToken} on ${chain} via LI.FI/${q.tool} (~${q.estimate.executionDuration}s)`,
        to: tx.to, data: tx.data, value: BigInt(tx.value ?? "0"),
        expect: `${q.estimate.toAmount} delivered on ${chain} by the ${q.tool} solver/bridge; not observable on Arbitrum One`,
      }];
    }
    case "raw":
      return [a.step];
  }
};

export type { Hex };
