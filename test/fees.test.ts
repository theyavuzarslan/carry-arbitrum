import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { test } from "node:test";

// Fees are read from env at import time, so this runs a child process with a receiver configured.
test("configured fees reach the GMX order and the cost model", () => {
  const code = `
    import { decodeFunctionData } from "viem";
    import { gmxExchangeRouterAbi } from "./src/abis.ts";
    import { buildGmxOrder } from "./src/execution/gmx.ts";
    import { roundTripCost } from "./src/strategies/common.ts";
    const tx = buildGmxOrder({ account: "0x000000000000000000000000000000000000dEaD", market: "0xC25cEf6061Cf5dE5eb761b50E4743c1F5D7E5407", collateralToken: "0xaf88d065e77c8cC2239327C5EDb3A432268e5831", collateralAmount: 1n, sizeUsd: 100, isLong: false, markPx: 1, indexDecimals: 18, slippageBps: 50 });
    const calls = decodeFunctionData({ abi: gmxExchangeRouterAbi, data: tx.data }).args[0];
    const order = decodeFunctionData({ abi: gmxExchangeRouterAbi, data: calls[2] }).args[0];
    const cost = roundTripCost([{ action: "short-perp", venue: "gmx-v2", symbol: "x", weight: 1, apr: 0 }]);
    console.log(JSON.stringify({ receiver: order.addresses.uiFeeReceiver, cost }));`;
  const run = (env: Record<string, string>) => {
    const r = spawnSync(process.execPath, ["--input-type=module", "-e", code], { env: { ...process.env, ...env }, encoding: "utf8" });
    assert.equal(r.status, 0, r.stderr);
    return JSON.parse(r.stdout.trim().split("\n").at(-1)!) as { receiver: string; cost: number };
  };
  const off = run({ CARRY_UI_FEE_RECEIVER: "" });
  const on = run({ CARRY_UI_FEE_RECEIVER: "0x000000000000000000000000000000000000fee5", CARRY_GMX_UI_FEE_BPS: "5" });
  assert.equal(on.receiver.toLowerCase(), "0x000000000000000000000000000000000000fee5");
  // GMX 6 bps each way = 12 bps; with a 5 bps UI fee each way = 22 bps.
  assert.ok(Math.abs(off.cost - 0.0012) < 1e-12, String(off.cost));
  assert.ok(Math.abs(on.cost - 0.0022) < 1e-12, String(on.cost));
});
