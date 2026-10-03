/**
 * Shared types. Every rate in this codebase is an annualized decimal fraction
 * (0.05 = 5% per year) and every "carry" number is signed from the holder's point of
 * view: positive means the position RECEIVES, negative means it PAYS.
 */

export type Address = `0x${string}`;
export type Hex = `0x${string}`;

/** Where a number came from. `onchain` is read straight from Arbitrum contracts. */
export type DataSource = "onchain" | "gmx-api" | "defillama" | "hyperliquid-api" | "pendle-api" | "lido-api";

/** A lending/borrowing market for one asset on one venue. */
export interface LendingMarket {
  venue: string;            // "aave-v3" | "compound-v3" | "fluid-lending" | ...
  symbol: string;           // asset symbol as the venue reports it
  asset?: Address;          // underlying token address when known
  decimals?: number;
  priceUsd?: number;
  supplyApr: number;        // base supply yield, annualized
  borrowApr: number | null; // null when the asset cannot be borrowed there
  rewardApr?: number;       // incentives, reported separately and NOT used in net carry by default
  totalSupplyUsd: number;
  totalBorrowUsd: number;
  availableUsd: number;     // liquidity that can still be borrowed or withdrawn
  ltv: number;              // max loan-to-value when used as collateral (0 = not collateral)
  liqThreshold: number;
  canCollateral: boolean;
  canBorrow: boolean;
  executable: boolean;      // true when this bot has a transaction builder for the venue
  source: DataSource;
  /** Aave e-mode categories this asset may enter as collateral / borrow in. */
  eModes?: { id: number; label: string; ltv: number; liqThreshold: number; collateral: boolean; borrowable: boolean }[];
  /** Compound v3: the base asset of the Comet market that lists this asset. */
  comet?: Address;
  cometBase?: string;
}

/** A perpetual market. Carry is what a 1 USD position earns per year from funding and borrow fees. */
export interface PerpMarket {
  venue: string;            // "gmx-v2" | "hyperliquid" | "binance" | "bybit"
  symbol: string;           // index symbol, e.g. "ETH"
  name: string;             // venue market name, e.g. "ETH/USD [ETH-USDC]"
  markPx: number;
  longCarryApr: number;     // signed: + = longs receive
  shortCarryApr: number;    // signed: + = shorts receive
  openInterestLongUsd: number;
  openInterestShortUsd: number;
  availableLongUsd: number; // capacity left for new longs
  availableShortUsd: number;
  executable: boolean;
  source: DataSource;
  gmx?: { marketToken: Address; indexToken: Address; longToken: Address; shortToken: Address; indexDecimals: number };
}

/** A native yield on holding an asset (LST staking, yield-bearing stables). */
export interface HoldYield {
  symbol: string;
  apr: number;
  source: DataSource;
  note?: string;
}

/** A Pendle PT market: fixed yield until maturity. */
export interface FixedYieldMarket {
  venue: "pendle";
  name: string;
  market: Address;
  pt: Address;
  underlying: Address;
  impliedApr: number;
  underlyingApr: number;
  liquidityUsd: number;
  expiry: string;
  daysToExpiry: number;
}

export interface MarketSnapshot {
  asOf: string;
  lending: LendingMarket[];
  perps: PerpMarket[];
  holdYields: HoldYield[];
  fixed: FixedYieldMarket[];
  prices: Record<string, number>; // symbol -> USD
  dexDepthUsd?: Record<string, number>;
  /** Arbitrum ecosystem chains (Orbit/Nova): spot assets and yields reachable by bridge, with quotes. */
  eco?: import("./sources/xchain.ts").EcoSnapshot;
  /** GoPlus token-security verdicts keyed "chainId:address" (cached 24h). */
  security?: Record<string, import("./guardrails/tokenSecurity.ts").TokenVerdict>;
  /** Cross-exchange price pairs for one-off arbitrage. */
  arb?: { cexDex: import("./sources/arb.ts").PricePair[] }; // "A/B" -> USD tradable within 1% price impact on Uniswap v3
  errors: string[];               // sources that failed; the scan continues without them
}

export type StrategyId =
  | "basis"              // long spot / short perp, collect funding (cash and carry)
  | "reverse-basis"      // short spot via borrow / long perp, collect negative funding
  | "lend-borrow"        // borrow a low-rate asset, lend a high-rate asset (rate carry, FX-style)
  | "fx-carry"           // borrow a low-yield currency, hold a high-yield currency, optionally hedged
  | "lst-loop"           // leveraged staking yield via e-mode
  | "fixed-carry"        // borrow floating, buy fixed PT yield
  | "funding-spread"     // same perp, different venues
  | "xchain-basis"       // spot on an Arbitrum ecosystem chain, short perp on GMX (Arbitrum One)
  | "xchain-yield"       // carry target that only exists on an Arbitrum ecosystem chain
  | "cex-dex-arb"        // one-off: same asset, Uniswap (Arbitrum One) vs Binance
  | "xchain-arb"         // one-off: same asset across Arbitrum chains, or stock token vs GMX mark
  | "wallet";            // wallet-specific (refinance, idle, unhedged, health)

/** One leg of a trade, sized as a fraction of the capital committed. */
export interface Leg {
  action: "supply" | "borrow" | "short-perp" | "long-perp" | "swap" | "hold" | "buy-pt" | "repay" | "withdraw" | "close-perp" | "bridge";
  /** Chain the leg lives on; omitted = Arbitrum One. */
  chainId?: number;
  /** One-way cost as a fraction of notional when it is quoted (bridges). */
  costOneWay?: number;
  venue: string;
  symbol: string;
  weight: number;           // notional / capital (a 2x loop's supply leg has weight 2)
  apr: number;              // signed carry of this leg per unit notional (borrow legs are negative)
  note?: string;
}

export interface RiskAssessment {
  score: number;            // 0 (safe) .. 100 (dangerous)
  grade: "A" | "B" | "C" | "D";
  healthFactor?: number;    // for legs with debt
  liquidationMovePct?: number; // adverse price move that liquidates, as a fraction
  factors: string[];        // human-readable reasons
}

export interface Opportunity {
  id: string;
  strategy: StrategyId;
  scope: "market" | "wallet";
  title: string;
  thesis: string;
  legs: Leg[];
  grossApr: number;         // sum(weight * apr) over legs, on capital
  costApr: number;          // entry + exit costs amortized over the holding horizon
  netApr: number;           // grossApr - costApr
  leverage: number;         // gross notional / capital
  capacityUsd: number;      // how much capital the thinnest leg can absorb
  risk: RiskAssessment;
  executable: boolean;      // every leg has a builder in this bot
  whyNotExecutable?: string;
  params: Record<string, string | number | boolean>;
  /** Wallet opportunities: USD that the action applies to and USD/yr it changes. */
  walletImpact?: { amountUsd: number; usdPerYear: number };
}

/** One transaction the executor will send. */
export interface TxStep {
  label: string;
  to: Address;
  data: Hex;
  value: bigint;
  /** Optional check read after the step: a human description of expected state. */
  expect?: string;
}

export interface ExecutionPlan {
  opportunityId: string;
  account: Address;
  capitalUsd: number;
  steps: TxStep[];
  notes: string[];
  /** Pre-trade guardrails at this size: token security and entry/exit liquidity. */
  guard?: import("./guardrails/index.ts").GuardReport;
}

export interface WalletPosition {
  venue: string;
  kind: "balance" | "supply" | "borrow" | "perp" | "pt";
  symbol: string;
  amount: number;
  usd: number;
  apr: number;              // signed carry this position currently earns
  detail?: Record<string, string | number | boolean>;
}

export interface WalletReport {
  address: Address;
  asOf: string;
  netWorthUsd: number;
  currentCarryUsdPerYear: number;
  currentCarryApr: number;
  aave?: { healthFactor: number; collateralUsd: number; debtUsd: number; eMode: number };
  positions: WalletPosition[];
  opportunities: Opportunity[];
  potentialCarryUsdPerYear: number;
}
