import { getAddress } from "viem";
import type { Address } from "./types.ts";

/**
 * Arbitrum One addresses. Each was checked live with read-only calls on 2026-09-30
 * (see docs/VERIFICATION.md for the exact call and what it returned).
 */
export const CHAIN_ID = 42161;

export const RPC_URLS: string[] = (process.env.ARB_RPC_URLS ?? process.env.ARB_RPC_URL ?? "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean)
  .concat(["https://arb1.arbitrum.io/rpc", "https://arbitrum-one-rpc.publicnode.com", "https://arbitrum.drpc.org"]);

export const TOKENS = {
  WETH: "0x82aF49447D8a07e3bd95BD0d56f35241523fBab1",
  USDC: "0xaf88d065e77c8cC2239327C5EDb3A432268e5831",
  "USDC.e": "0xFF970A61A04b1cA14834A43f5dE4533eBDDB5CC8",
  USDT: "0xFd086bC7CD5C481DCC9C85ebE478A1C0b69FCbb9",
  DAI: "0xDA10009cBd5D07dd0CeCc66161FC93D7c9000da1",
  WBTC: "0x2f2a2543B76A4166549F7aaB2e75Bef0aefC5B0f",
  ARB: "0x912CE59144191C1204E64559FE8253a0e49E6548",
  LINK: "0xf97f4df75117a78c1A5a0DBb814Af92458539FB4",
  wstETH: "0x5979D7b546E38E414F7E9822514be443A4800529",
  weETH: "0x35751007a407ca6FEFfE80b3cB397736D2cf4dbe",
  rETH: "0xEC70Dcb4A1EFa46b8F2D97C310C9c4790ba5ffA8",
  EURS: "0xD22a58f79e9481D1a88e00c343885A588b34b68B",
  GMX: "0xfc5A1A6EB076a2C7aD06eD22C90d7E710E35ad0a",
} as const satisfies Record<string, Address>;

export const AAVE = {
  POOL: "0x794a61358D6845594F94dc1DB02A252b5b4814aD",
  ADDRESSES_PROVIDER: "0xa97684ead0e402dC232d5A977953DF7ECBaB3CDb",
  DATA_PROVIDER: "0x243Aa95cAC2a25651eda86e80bEe66114413c43b",
  ORACLE: "0xb56c2F0B653B2e0b10C9b928C8580Ac5Df02C7C7",
} as const satisfies Record<string, Address>;

/** Compound v3 Comet proxies. `baseToken()` was read on each to confirm the base asset. */
export const COMPOUND = {
  cUSDCv3: { comet: "0x9c4ec768c28520B50860ea7a15bd7213a9fF58bf", base: "USDC" },
  "cUSDC.ev3": { comet: "0xA5EDBDD9646f8dFF606d7448e414884C7d905dCA", base: "USDC.e" },
  cUSDTv3: { comet: "0xd98Be00b5D27fc98112BdE293e487f8D4cA57d07", base: "USDT" },
  cWETHv3: { comet: "0x6f7D514bbD4aFf3BcD1140B7344b32f063dEe486", base: "WETH" },
} as const satisfies Record<string, { comet: Address; base: string }>;

/** Uniswap v3. SwapRouter02.factory() and QuoterV2.factory() both return FACTORY. */
export const UNISWAP = {
  FACTORY: "0x1F98431c8aD98523631AE4a59f267346ea31F984",
  SWAP_ROUTER_02: "0x68b3465833fb72A70ecDF485E0e4C7bD8665Fc45",
  QUOTER_V2: "0x61fFE014bA17989E743c5F6cB21bF9697530B21e",
} as const satisfies Record<string, Address>;

/** GMX v2.2 deployment, from GMX's contracts manifest; Reader/DataStore round-trip checked. */
export const GMX = {
  API: process.env.GMX_API_URL ?? "https://arbitrum-api.gmxinfra.io",
  DATA_STORE: "0xFD70de6b91282D8017aA4E741e9Ae325CAb992d8",
  READER: "0xfA26cBb46e2614609406de08CA1Dc7f70a684184",
  EXCHANGE_ROUTER: "0x7dE39FF2e232A2203196788d37e234cF8F1b83f1",
  ORDER_VAULT: "0x31eF83a530Fde1B38EE9A18093A333D8Bbbc40D5",
  ROUTER: "0x7452c558d45f8afC8c83dAe62C3f8A5BE19c71f6",
  /** Floor for the execution fee; the actual fee is sized from the live gas price. Keepers refund excess. */
  EXECUTION_FEE_WEI: 600_000_000_000_000n,
  /** Market-open and market-close fees are 4-6 bps of size; we assume the worse case. */
  POSITION_FEE_BPS: 6,
} as const;

export const PENDLE_API = "https://api-v2.pendle.finance/core";
export const LLAMA_YIELDS = "https://yields.llama.fi";
export const HYPERLIQUID_API = "https://api.hyperliquid.xyz/info";
export const LIDO_APR_API = "https://eth-api.lido.fi/v1/protocol/steth/apr/sma";

/** Map venue symbols (GMX uses "ETH", "BTC") to the Arbitrum spot token that tracks them. */
export const PERP_TO_SPOT: Record<string, keyof typeof TOKENS> = {
  ETH: "WETH",
  BTC: "WBTC",
  ARB: "ARB",
  LINK: "LINK",
  GMX: "GMX",
};

/**
 * Protocol fees: how Carry earns on self-custody execution. Both are paid by the user on-chain at
 * execution time through the venues' own integrator hooks, and both are charged in every net APR the
 * scanner shows, so users see what they actually keep.
 *  - GMX v2 UI fee: the ExchangeRouter pays `uiFeeReceiver` a fee on position size. The receiver
 *    sets its own factor (ExchangeRouter.setUiFeeFactor); GMX caps it at 10 bps
 *    (DataStore MAX_UI_FEE_FACTOR = 1e27 / 1e30, read 2026-10-04).
 *  - LI.FI integrator fee: a fraction of the bridged amount, forwarded to the integrator's fee wallet.
 */
export const FEES = {
  gmxUiFeeReceiver: getAddress((process.env.CARRY_UI_FEE_RECEIVER || "0x0000000000000000000000000000000000000000").toLowerCase()) as Address,
  gmxUiFeeBps: Number(process.env.CARRY_GMX_UI_FEE_BPS ?? 5),
  lifiIntegrator: process.env.CARRY_LIFI_INTEGRATOR ?? "",
  lifiFeeBps: Number(process.env.CARRY_LIFI_FEE_BPS ?? 10),
};
export const feesEnabled = () => ({
  gmx: FEES.gmxUiFeeReceiver !== "0x0000000000000000000000000000000000000000" ? FEES.gmxUiFeeBps : 0,
  lifi: FEES.lifiIntegrator ? FEES.lifiFeeBps : 0,
});

/** Strategy and risk defaults. Every one can be overridden from the CLI or env. */
export const DEFAULTS = {
  horizonDays: Number(process.env.CARRY_HORIZON_DAYS ?? 30),
  minNetApr: Number(process.env.CARRY_MIN_NET_APR ?? 0.04),
  maxLeverage: Number(process.env.CARRY_MAX_LEVERAGE ?? 3),
  targetHealthFactor: Number(process.env.CARRY_TARGET_HF ?? 1.6),
  minHealthFactor: Number(process.env.CARRY_MIN_HF ?? 1.3),
  perpLeverage: Number(process.env.CARRY_PERP_LEVERAGE ?? 2),
  swapCostBps: 10,
  minCapacityUsd: 50_000,
  maxRiskScore: Number(process.env.CARRY_MAX_RISK ?? 60),
};

export const SECONDS_PER_YEAR = 31_536_000;
