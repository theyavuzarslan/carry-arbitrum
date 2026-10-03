#!/usr/bin/env bash
# Video demo, one scene per judging criterion. Run all scenes with pauses:  ./scripts/demo.sh
# or one scene:  ./scripts/demo.sh 3
# Scenes read live data; numbers will differ from the deck, which is fine (that is the point).
set -uo pipefail
cd "$(dirname "$0")/.."
CLI="node src/cli.ts"
LOW_HF_WALLET=0x62f4Dd8B542b7c949AC86C7f1Dc5c68655E0fB34   # public Aave borrower, picked from Borrow events
VAULT=0x330677cDA0fc0C7a184A3a150fb08De973A9C4F1
RH_TESTNET=https://rpc.testnet.chain.robinhood.com/rpc

title() { printf "\n\033[1;36m== %s ==\033[0m\n\n" "$1"; }
pause() { [[ -n "${ONE:-}" ]] || read -r -p $'\n[enter for next scene] ' _; }

scene1() { title "1. Real problem: every carry trade on Arbitrum, ranked after costs and risk"; $CLI scan --exec --top 8; }
scene2() { title "2. Innovation: stocks on Robinhood Chain hedged on GMX (Arbitrum One)"; $CLI scan --strategy xchain-basis --top 5; }
scene3() { title "3. Product-market fit: paste any wallet, see what to do"; $CLI wallet "$LOW_HF_WALLET"; }
scene4() {
  title "4. Guardrails: token security (GoPlus) and liquidity at the real size"
  $CLI check xchain-basis:spcxusdeth-usdc:robinhood:spcx --capital 50000
  echo; echo "GMX-token trade, blocked by GoPlus:"
  $CLI show basis:gmxusdgmx-usdc:gmx:funded 2>/dev/null | grep -E '"whyNotExecutable"'
}
scene5() { title "5. Execution: exact transactions for a \$10k ARB cash-and-carry (nothing sent)"; $CLI plan basis:arbusdarb-usdc:arb:funded --capital 10000 | tail -20; }
scene6() {
  title "6. Smart contracts: CarryAccount opened a 5x loop in one flash-loan tx (fork of Arbitrum One)"
  grep -E "✓|loop open" docs/evidence/fork-lst-loop-carryaccount.log | tail -6
  echo; echo "Live re-run (takes 5-10 min on a public RPC): $CLI execute lst-loop:wsteth:aave-v3:7 --mode fork --capital 8000"
}
scene7() {
  title "7. Deployed: USDG CarryVault on Robinhood Chain testnet"
  for f in "name()(string)" "asset()(address)" "totalAssets()(uint256)" "performanceFeeBps()(uint256)" "owner()(address)"; do
    printf "%-28s %s\n" "$f" "$(cast call $VAULT "$f" --rpc-url $RH_TESTNET 2>&1 | head -1)"
  done
  echo; echo "https://explorer.testnet.chain.robinhood.com/address/$VAULT"
}

if [[ $# -gt 0 ]]; then ONE=1 "scene$1"; exit; fi
for i in 1 2 3 4 5 6 7; do "scene$i"; pause; done
