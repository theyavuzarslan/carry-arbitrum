import { encodeAbiParameters, encodeFunctionData, keccak256, type PublicClient } from "viem";
import { gmxDataStoreAbi, gmxExchangeRouterAbi } from "../abis.ts";
import { GMX } from "../config.ts";
import type { Address, Hex } from "../types.ts";

const ZERO = "0x0000000000000000000000000000000000000000" as const;
const ZERO32 = `0x${"00".repeat(32)}` as Hex;
export const ORDER_TYPE = { MarketIncrease: 2, MarketDecrease: 4 } as const;

export interface GmxOrderInput {
  account: Address;
  market: Address;
  collateralToken: Address;
  collateralAmount: bigint;      // smallest units; sent to OrderVault on increase
  sizeUsd: number;               // position size delta in USD
  isLong: boolean;
  markPx: number;                // USD per index token
  indexDecimals: number;
  slippageBps: number;
  decrease?: boolean;
  executionFeeWei?: bigint;
}

/** GMX prices are USD * 10^(30 - indexDecimals) per whole token. */
const scalePrice = (px: number, indexDecimals: number): bigint => {
  const decimals = 30 - indexDecimals;
  // Keep 8 significant decimals from the float, then scale with bigint to avoid overflow.
  const micro = BigInt(Math.round(px * 1e8));
  return decimals >= 8 ? micro * 10n ** BigInt(decimals - 8) : micro / 10n ** BigInt(8 - decimals);
};

/**
 * One ExchangeRouter.multicall: sendWnt(fee) + sendTokens(collateral) + createOrder. This is the same
 * three-call shape the GMX UI sends. A keeper executes the order at the next oracle price; on a fork
 * there are no keepers, so the order stays pending (and is visible in the DataStore order list).
 */
export const buildGmxOrder = (o: GmxOrderInput): { to: Address; data: Hex; value: bigint } => {
  const fee = o.executionFeeWei ?? GMX.EXECUTION_FEE_WEI;
  // Adverse direction for the acceptable price: buying (long increase / short decrease) fills higher.
  const buying = o.decrease ? !o.isLong : o.isLong;
  const acceptable = o.markPx * (buying ? 1 + o.slippageBps / 1e4 : 1 - o.slippageBps / 1e4);
  const params = {
    addresses: { receiver: o.account, cancellationReceiver: o.account, callbackContract: ZERO, uiFeeReceiver: ZERO, market: o.market, initialCollateralToken: o.collateralToken, swapPath: [] as Address[] },
    numbers: {
      sizeDeltaUsd: BigInt(Math.floor(o.sizeUsd * 1e6)) * 10n ** 24n,
      initialCollateralDeltaAmount: o.collateralAmount,
      triggerPrice: 0n,
      acceptablePrice: scalePrice(acceptable, o.indexDecimals),
      executionFee: fee,
      callbackGasLimit: 0n,
      minOutputAmount: 0n,
      validFromTime: 0n,
    },
    orderType: o.decrease ? ORDER_TYPE.MarketDecrease : ORDER_TYPE.MarketIncrease,
    decreasePositionSwapType: 0,
    isLong: o.isLong,
    shouldUnwrapNativeToken: false,
    autoCancel: false,
    referralCode: ZERO32,
    dataList: [] as Hex[],
  } as const;
  const calls: Hex[] = [encodeFunctionData({ abi: gmxExchangeRouterAbi, functionName: "sendWnt", args: [GMX.ORDER_VAULT, fee] })];
  if (!o.decrease && o.collateralAmount > 0n) calls.push(encodeFunctionData({ abi: gmxExchangeRouterAbi, functionName: "sendTokens", args: [o.collateralToken, GMX.ORDER_VAULT, o.collateralAmount] }));
  calls.push(encodeFunctionData({ abi: gmxExchangeRouterAbi, functionName: "createOrder", args: [params] }));
  return { to: GMX.EXCHANGE_ROUTER, value: fee, data: encodeFunctionData({ abi: gmxExchangeRouterAbi, functionName: "multicall", args: [calls] }) };
};

const hashString = (s: string) => keccak256(encodeAbiParameters([{ type: "string" }], [s]));
const ACCOUNT_ORDER_LIST = hashString("ACCOUNT_ORDER_LIST");
const accountOrderListKey = (account: Address) => keccak256(encodeAbiParameters([{ type: "bytes32" }, { type: "address" }], [ACCOUNT_ORDER_LIST, account]));

/** Pending GMX order keys for an account, straight from the DataStore. */
export const pendingOrders = async (client: PublicClient, account: Address): Promise<Hex[]> => {
  const key = accountOrderListKey(account);
  const n = await client.readContract({ address: GMX.DATA_STORE, abi: gmxDataStoreAbi, functionName: "getBytes32Count", args: [key] });
  if (n === 0n) return [];
  return [...(await client.readContract({ address: GMX.DATA_STORE, abi: gmxDataStoreAbi, functionName: "getBytes32ValuesAt", args: [key, 0n, n] }))];
};
