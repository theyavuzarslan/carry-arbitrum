import type { PublicClient } from "viem";
import { formatUnits } from "viem";
import { aaveDataProviderAbi, aavePoolAbi, cometAbi, erc20Abi, gmxReaderAbi } from "../abis.ts";
import { AAVE, GMX, TOKENS } from "../config.ts";
import { getClient } from "../rpc.ts";
import { holdApr } from "../strategies/common.ts";
import type { Address, LendingMarket, MarketSnapshot, WalletPosition } from "../types.ts";

export interface WalletState {
  address: Address;
  positions: WalletPosition[];
  aave?: { healthFactor: number; collateralUsd: number; debtUsd: number; eMode: number };
  compound: { comet: Address; base: string; supplyUsd: number; borrowUsd: number; collateralUsd: number }[];
}

const px = (snap: MarketSnapshot, symbol: string): number => snap.prices[symbol] ?? snap.lending.find((m) => m.symbol === symbol && m.priceUsd)?.priceUsd ?? 0;

/** Read everything the wallet holds on Arbitrum that this bot understands. */
export const readWallet = async (address: Address, snap: MarketSnapshot, client: PublicClient = getClient()): Promise<WalletState> => {
  const positions: WalletPosition[] = [];

  // 1. Idle balances: native ETH and the tokens we know.
  const eth = await client.getBalance({ address });
  if (eth > 0n) {
    const amt = Number(formatUnits(eth, 18));
    positions.push({ venue: "wallet", kind: "balance", symbol: "ETH", amount: amt, usd: amt * px(snap, "ETH"), apr: 0 });
  }
  const tokenEntries = Object.entries(TOKENS) as [string, Address][];
  const bals = await Promise.all(tokenEntries.map(async ([sym, addr]) => {
    const [bal, dec] = await Promise.all([
      client.readContract({ address: addr, abi: erc20Abi, functionName: "balanceOf", args: [address] }),
      client.readContract({ address: addr, abi: erc20Abi, functionName: "decimals" }),
    ]);
    return { sym, amt: Number(formatUnits(bal, dec)) };
  }));
  for (const { sym, amt } of bals) {
    if (amt <= 0) continue;
    positions.push({ venue: "wallet", kind: "balance", symbol: sym, amount: amt, usd: amt * px(snap, sym), apr: holdApr(snap, sym) });
  }
  // Pendle PTs.
  const pts = await Promise.all(snap.fixed.map(async (f) => {
    try {
      const [bal, dec] = await Promise.all([
        client.readContract({ address: f.pt, abi: erc20Abi, functionName: "balanceOf", args: [address] }),
        client.readContract({ address: f.pt, abi: erc20Abi, functionName: "decimals" }),
      ]);
      return { f, amt: Number(formatUnits(bal, dec)) };
    } catch {
      return { f, amt: 0 };
    }
  }));
  for (const { f, amt } of pts) if (amt > 0) positions.push({ venue: "pendle", kind: "pt", symbol: `PT-${f.name}`, amount: amt, usd: amt, apr: f.impliedApr, detail: { expiry: f.expiry.slice(0, 10), daysToExpiry: Math.round(f.daysToExpiry) } });

  // 2. Aave v3.
  let aave: WalletState["aave"];
  const aaveMarkets = snap.lending.filter((m) => m.venue === "aave-v3" && m.asset) as (LendingMarket & { asset: Address })[];
  const [acct, eMode] = await Promise.all([
    client.readContract({ address: AAVE.POOL, abi: aavePoolAbi, functionName: "getUserAccountData", args: [address] }),
    client.readContract({ address: AAVE.POOL, abi: aavePoolAbi, functionName: "getUserEMode", args: [address] }),
  ]);
  if (acct[0] > 0n || acct[1] > 0n) {
    aave = { collateralUsd: Number(acct[0]) / 1e8, debtUsd: Number(acct[1]) / 1e8, healthFactor: acct[1] === 0n ? Infinity : Number(acct[5]) / 1e18, eMode: Number(eMode) };
    const rows = await Promise.all(aaveMarkets.map(async (m) => ({ m, r: await client.readContract({ address: AAVE.DATA_PROVIDER, abi: aaveDataProviderAbi, functionName: "getUserReserveData", args: [m.asset, address] }) })));
    for (const { m, r } of rows) {
      const dec = m.decimals ?? 18;
      const sup = Number(formatUnits(r[0], dec));
      const debt = Number(formatUnits(r[2], dec));
      if (sup > 0) positions.push({ venue: "aave-v3", kind: "supply", symbol: m.symbol, amount: sup, usd: sup * (m.priceUsd ?? 0), apr: m.supplyApr + holdApr(snap, m.symbol), detail: { collateral: r[8] } });
      if (debt > 0) positions.push({ venue: "aave-v3", kind: "borrow", symbol: m.symbol, amount: debt, usd: debt * (m.priceUsd ?? 0), apr: -(m.borrowApr ?? 0) });
    }
  }

  // 3. Compound v3.
  const compound: WalletState["compound"] = [];
  const bases = snap.lending.filter((m) => m.venue === "compound-v3" && m.canBorrow && m.comet);
  await Promise.all(bases.map(async (b) => {
    const comet = b.comet!;
    const [sup, bor] = await Promise.all([
      client.readContract({ address: comet, abi: cometAbi, functionName: "balanceOf", args: [address] }),
      client.readContract({ address: comet, abi: cometAbi, functionName: "borrowBalanceOf", args: [address] }),
    ]);
    const colls = snap.lending.filter((m) => m.venue === "compound-v3" && m.comet === comet && m.canCollateral && m.asset);
    const cb = await Promise.all(colls.map(async (c) => ({ c, bal: await client.readContract({ address: comet, abi: cometAbi, functionName: "collateralBalanceOf", args: [address, c.asset!] }) })));
    const dec = b.decimals ?? 6;
    const s = Number(formatUnits(sup, dec));
    const d = Number(formatUnits(bor, dec));
    let collUsd = 0;
    if (s > 0) positions.push({ venue: "compound-v3", kind: "supply", symbol: b.symbol, amount: s, usd: s * (b.priceUsd ?? 0), apr: b.supplyApr, detail: { comet } });
    if (d > 0) positions.push({ venue: "compound-v3", kind: "borrow", symbol: b.symbol, amount: d, usd: d * (b.priceUsd ?? 0), apr: -(b.borrowApr ?? 0), detail: { comet } });
    for (const { c, bal } of cb) {
      const amt = Number(formatUnits(bal, c.decimals ?? 18));
      if (amt <= 0) continue;
      collUsd += amt * (c.priceUsd ?? 0);
      positions.push({ venue: "compound-v3", kind: "supply", symbol: c.symbol, amount: amt, usd: amt * (c.priceUsd ?? 0), apr: holdApr(snap, c.symbol), detail: { comet, collateral: true } });
    }
    if (s > 0 || d > 0 || collUsd > 0) compound.push({ comet, base: b.symbol, supplyUsd: s * (b.priceUsd ?? 0), borrowUsd: d * (b.priceUsd ?? 0), collateralUsd: collUsd });
  }));

  // 4. GMX v2 perps.
  try {
    const raw = await client.readContract({ address: GMX.READER, abi: gmxReaderAbi, functionName: "getAccountPositions", args: [GMX.DATA_STORE, address, 0n, 100n] });
    for (const p of raw) {
      const market = snap.perps.find((m) => m.gmx?.marketToken.toLowerCase() === p.addresses.market.toLowerCase());
      const size = Number(p.numbers.sizeInUsd) / 1e30;
      if (size <= 0) continue;
      const isLong = p.flags.isLong;
      const collTok = Object.entries(TOKENS).find(([, a]) => a.toLowerCase() === p.addresses.collateralToken.toLowerCase());
      const collSym = collTok?.[0] ?? "?";
      const collDec = collSym === "USDC" || collSym === "USDT" ? 6 : collSym === "WBTC" ? 8 : 18;
      const collAmt = Number(formatUnits(p.numbers.collateralAmount, collDec));
      positions.push({
        venue: "gmx-v2", kind: "perp", symbol: market?.name ?? p.addresses.market, amount: size, usd: size,
        apr: market ? (isLong ? market.longCarryApr : market.shortCarryApr) : 0,
        detail: { side: isLong ? "long" : "short", collateral: collSym, collateralUsd: collAmt * px(snap, collSym), leverage: Number((size / Math.max(1e-9, collAmt * px(snap, collSym))).toFixed(2)), market: p.addresses.market },
      });
    }
  } catch {
    /* Reader unavailable: skip perps rather than fail the whole report */
  }
  return { address, positions, aave, compound };
};
