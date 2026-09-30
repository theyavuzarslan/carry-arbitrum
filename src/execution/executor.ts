import { spawn, type ChildProcess } from "node:child_process";
import { createWalletClient, formatUnits, http, parseEther, type PublicClient } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { arbitrum } from "viem/chains";
import { aavePoolAbi, erc20Abi } from "../abis.ts";
import { AAVE, RPC_URLS, TOKENS } from "../config.ts";
import { clientFor, getClient } from "../rpc.ts";
import type { Address, ExecutionPlan, Hex, MarketSnapshot, Opportunity, TxStep } from "../types.ts";
import { chainBalances, compile, describe, ledgerBalances, type Action } from "./actions.ts";
import { pendingOrders } from "./gmx.ts";
import { planActions, units } from "./planner.ts";

export type Mode = "plan" | "fork" | "live";

/** Compile a plan for display: amounts that depend on earlier outputs use quoted estimates. */
export const buildPlan = async (opp: Opportunity, capitalUsd: number, account: Address, snap: MarketSnapshot, client: PublicClient = getClient()): Promise<ExecutionPlan> => {
  const { actions, notes } = planActions(opp, capitalUsd, snap);
  const bal = ledgerBalances({ [TOKENS.USDC]: units(snap, "USDC", capitalUsd) });
  const steps: TxStep[] = [];
  for (const a of actions) steps.push(...(await compile(a, { client, account, bal })));
  return { opportunityId: opp.id, account, capitalUsd, steps, notes };
};

// ---------------------------------------------------------------- fork (anvil)

export interface Fork { url: string; client: PublicClient; stop: () => void }

/** Start anvil forking Arbitrum One. Needs Foundry's `anvil` on PATH. */
export const startFork = async (port = Number(process.env.CARRY_FORK_PORT ?? 8547), forkUrl = RPC_URLS[0]!): Promise<Fork> => {
  const url = `http://127.0.0.1:${port}`;
  const proc: ChildProcess = spawn("anvil", ["--fork-url", forkUrl, "--port", String(port), "--chain-id", "42161", "--silent", "--no-rate-limit", "--compute-units-per-second", "1000"], { stdio: "ignore" });
  const client = clientFor(url);
  for (let i = 0; i < 60; i++) {
    try {
      await client.getBlockNumber();
      return { url, client, stop: () => proc.kill("SIGTERM") };
    } catch {
      await new Promise((r) => setTimeout(r, 500));
    }
  }
  proc.kill("SIGTERM");
  throw new Error("anvil did not start (is Foundry installed?)");
};

const rpc = (url: string, method: string, params: unknown[]) =>
  fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) }).then((r) => r.json());

/** Give a fork account ETH for gas and `capitalUsd` of USDC, bought on the real Uniswap pool. */
export const fundForkAccount = async (fork: Fork, account: Address, capitalUsd: number, snap: MarketSnapshot, log: (s: string) => void): Promise<void> => {
  const ethPx = snap.prices.ETH ?? snap.prices.WETH!;
  const needEth = (capitalUsd * 1.02) / ethPx;
  await rpc(fork.url, "anvil_setBalance", [account, `0x${(parseEther(String(Math.ceil(needEth + 2)))).toString(16)}`]);
  await rpc(fork.url, "anvil_impersonateAccount", [account]);
  const actions: Action[] = [
    { t: "wrap", wei: parseEther(needEth.toFixed(18)) },
    { t: "swap", tokenIn: TOKENS.WETH, tokenOut: TOKENS.USDC, amountIn: { all: TOKENS.WETH }, slippageBps: 100 },
  ];
  await sendActions(actions, { client: fork.client, account, send: forkSender(fork, account), log: (s) => log(`  [fund] ${s}`) });
  const bal = await fork.client.readContract({ address: TOKENS.USDC, abi: erc20Abi, functionName: "balanceOf", args: [account] });
  log(`  funded ${account} with ${formatUnits(bal, 6)} USDC (bought on the forked Uniswap pool) + gas ETH`);
};

type Sender = (s: TxStep) => Promise<Hex>;

const forkSender = (fork: Fork, account: Address): Sender => async (s) => {
  const res = (await rpc(fork.url, "eth_sendTransaction", [{ from: account, to: s.to, data: s.data, value: `0x${s.value.toString(16)}`, gas: "0x1C9C380" }])) as { result?: Hex; error?: { message: string } };
  if (res.error) throw new Error(res.error.message);
  return res.result!;
};

const liveSender = (privateKey: Hex): Sender => {
  const acct = privateKeyToAccount(privateKey);
  const wallet = createWalletClient({ account: acct, chain: arbitrum, transport: http(RPC_URLS[0]) });
  return (s) => wallet.sendTransaction({ to: s.to, data: s.data, value: s.value });
};

export interface SendResult { label: string; hash: Hex; status: "success" | "reverted"; gasUsed: bigint }

/** Compile each action against live balances just before sending it, then wait for the receipt. */
export const sendActions = async (actions: Action[], o: { client: PublicClient; account: Address; send: Sender; log: (s: string) => void }): Promise<SendResult[]> => {
  const out: SendResult[] = [];
  const bal = chainBalances(o.client, o.account);
  for (const a of actions) {
    const steps = await compile(a, { client: o.client, account: o.account, bal });
    for (const s of steps) {
      // Simulate first so a revert shows its reason instead of a bare failed receipt.
      try {
        await o.client.call({ account: o.account, to: s.to, data: s.data, value: s.value });
      } catch (e) {
        throw new Error(`simulation failed at "${s.label}": ${(e as Error).message.split("\n").slice(0, 3).join(" ")}`);
      }
      const hash = await o.send(s);
      const r = await o.client.waitForTransactionReceipt({ hash });
      out.push({ label: s.label, hash, status: r.status, gasUsed: r.gasUsed });
      o.log(`${r.status === "success" ? "✓" : "✗"} ${s.label}  (gas ${r.gasUsed})`);
      if (r.status !== "success") throw new Error(`reverted: ${s.label} (${hash})`);
    }
    void describe;
  }
  return out;
};

export interface AccountState {
  usdc: string; weth: string; eth: string;
  aave: { collateralUsd: number; debtUsd: number; healthFactor: number };
  gmxPendingOrders: Hex[];
  tokens: Record<string, string>;
}

export const readAccountState = async (client: PublicClient, account: Address): Promise<AccountState> => {
  const [acct, orders, eth] = await Promise.all([
    client.readContract({ address: AAVE.POOL, abi: aavePoolAbi, functionName: "getUserAccountData", args: [account] }),
    pendingOrders(client, account).catch(() => [] as Hex[]),
    client.getBalance({ address: account }),
  ]);
  const tokens: Record<string, string> = {};
  for (const [s, a] of Object.entries(TOKENS)) {
    const [b, d] = await Promise.all([
      client.readContract({ address: a, abi: erc20Abi, functionName: "balanceOf", args: [account] }),
      client.readContract({ address: a, abi: erc20Abi, functionName: "decimals" }),
    ]);
    if (b > 0n) tokens[s] = formatUnits(b, d);
  }
  return {
    usdc: tokens.USDC ?? "0", weth: tokens.WETH ?? "0", eth: formatUnits(eth, 18),
    aave: { collateralUsd: Number(acct[0]) / 1e8, debtUsd: Number(acct[1]) / 1e8, healthFactor: acct[1] === 0n ? Infinity : Number(acct[5]) / 1e18 },
    gmxPendingOrders: orders,
    tokens,
  };
};

export interface ExecuteOptions {
  mode: Mode;
  capitalUsd: number;
  account?: Address;
  privateKey?: Hex;
  confirm?: boolean;
  fork?: Fork;
  log?: (s: string) => void;
}

export interface ExecuteResult { mode: Mode; account: Address; plan: ExecutionPlan; txs: SendResult[]; before?: AccountState; after?: AccountState }

/**
 * Run an opportunity.
 *  plan: compile only (nothing sent).
 *  fork: anvil fork of Arbitrum One; a fresh account is funded with USDC bought on the real pool,
 *        then every transaction is sent and must succeed. GMX orders stay pending (no keepers).
 *  live: signs with CARRY_PRIVATE_KEY; refuses without confirm=true or above CARRY_MAX_CAPITAL_USD.
 */
export const execute = async (opp: Opportunity, snap: MarketSnapshot, o: ExecuteOptions): Promise<ExecuteResult> => {
  const log = o.log ?? console.log;
  if (o.mode === "plan") {
    const account = o.account ?? ("0x000000000000000000000000000000000000c0DE" as Address);
    return { mode: "plan", account, plan: await buildPlan(opp, o.capitalUsd, account, snap), txs: [] };
  }
  if (o.mode === "live") {
    const cap = Number(process.env.CARRY_MAX_CAPITAL_USD ?? 1000);
    if (!o.privateKey) throw new Error("live mode needs CARRY_PRIVATE_KEY");
    if (!o.confirm) throw new Error("live mode needs --yes: it sends real transactions");
    if (o.capitalUsd > cap) throw new Error(`capital $${o.capitalUsd} exceeds CARRY_MAX_CAPITAL_USD=$${cap}`);
    if (opp.risk.score > Number(process.env.CARRY_MAX_RISK ?? 60)) throw new Error(`risk score ${opp.risk.score} above CARRY_MAX_RISK`);
    const account = privateKeyToAccount(o.privateKey).address;
    const client = getClient();
    const plan = await buildPlan(opp, o.capitalUsd, account, snap, client);
    const before = await readAccountState(client, account);
    const { actions } = planActions(opp, o.capitalUsd, snap);
    const txs = await sendActions(actions, { client, account, send: liveSender(o.privateKey), log });
    return { mode: "live", account, plan, txs, before, after: await readAccountState(client, account) };
  }
  // fork
  const fork = o.fork ?? (await startFork());
  try {
    const account = o.account ?? (`0x${[...crypto.getRandomValues(new Uint8Array(20))].map((b) => b.toString(16).padStart(2, "0")).join("")}` as Address);
    log(`fork ${fork.url} at block ${await fork.client.getBlockNumber()}, account ${account}`);
    await fundForkAccount(fork, account, o.capitalUsd, snap, log);
    const before = await readAccountState(fork.client, account);
    const plan = await buildPlan(opp, o.capitalUsd, account, snap, fork.client);
    const { actions } = planActions(opp, o.capitalUsd, snap);
    const txs = await sendActions(actions, { client: fork.client, account, send: forkSender(fork, account), log });
    const after = await readAccountState(fork.client, account);
    return { mode: "fork", account, plan, txs, before, after };
  } finally {
    if (!o.fork) fork.stop();
  }
};
