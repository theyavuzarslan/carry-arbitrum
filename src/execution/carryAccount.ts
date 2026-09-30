import { readFileSync, existsSync } from "node:fs";
import { encodeDeployData, encodeFunctionData, parseAbi, type PublicClient } from "viem";
import { erc20Abi } from "../abis.ts";
import { AAVE, TOKENS, UNISWAP } from "../config.ts";
import type { Address, Hex } from "../types.ts";

const ARTIFACT = new URL("../../contracts/out/CarryAccount.sol/CarryAccount.json", import.meta.url);

export const carryAccountAbi = parseAbi([
  "constructor(address owner, address pool, address oracle, address router)",
  "function openLoop((address collateral,address debt,uint8 eMode,uint24 fee,uint256 principal,uint256 targetLeverage,uint256 maxSlippageBps,uint256 minHealthFactor) p)",
  "function closeLoop((address collateral,address debt,uint24 fee,uint256 maxSlippageBps) p)",
  "function position() view returns (uint256 totalCollateralBase,uint256 totalDebtBase,uint256 healthFactor,uint256 leverage)",
]);

export const contractAvailable = (): boolean => existsSync(ARTIFACT);

/** Deployment calldata for a CarryAccount owned by `owner` (needs `forge build` in contracts/). */
export const deployData = (owner: Address): Hex => {
  const art = JSON.parse(readFileSync(ARTIFACT, "utf8")) as { bytecode: { object: Hex } };
  return encodeDeployData({ abi: carryAccountAbi, bytecode: art.bytecode.object, args: [owner, AAVE.POOL, AAVE.ORACLE, UNISWAP.SWAP_ROUTER_02] });
};

export interface LoopTx { approve: { to: Address; data: Hex }; open: { to: Address; data: Hex } }

/** Approve principal to the account and open an L-x loop in one flash-loan transaction. */
export const openLoopTxs = (acct: Address, collateral: Address, principal: bigint, leverage: number, eMode: number, fee = 100): LoopTx => ({
  approve: { to: collateral, data: encodeFunctionData({ abi: erc20Abi, functionName: "approve", args: [acct, principal] }) },
  open: {
    to: acct,
    data: encodeFunctionData({
      abi: carryAccountAbi, functionName: "openLoop",
      args: [{ collateral, debt: TOKENS.WETH, eMode, fee, principal, targetLeverage: BigInt(Math.round(leverage * 1e4)) * 10n ** 14n, maxSlippageBps: 50n, minHealthFactor: 1_050_000_000_000_000_000n }],
    }),
  },
});

export const readLoop = async (client: PublicClient, acct: Address) => {
  const [c, d, hf, lev] = await client.readContract({ address: acct, abi: carryAccountAbi, functionName: "position" });
  return { collateralUsd: Number(c) / 1e8, debtUsd: Number(d) / 1e8, healthFactor: Number(hf) / 1e18, leverage: Number(lev) / 1e18 };
};
