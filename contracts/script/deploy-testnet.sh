#!/usr/bin/env bash
# One-command testnet deploy.
#
#   ./script/deploy-testnet.sh            # Robinhood Chain testnet: CarryVault over Paxos testnet USDG (+1 USDG seed deposit if you hold it)
#   ./script/deploy-testnet.sh sepolia    # Arbitrum Sepolia: CarryAccountFactory
#
# Signing (pick one; never type a key on the command line):
#   a) keystore (recommended): cast wallet import parity-deployer --interactive   -> uses ACCOUNT=parity-deployer
#   b) env var: set -a; source "/path/to/.env"; set +a   -> PRIVATE_KEY is passed as "$PRIVATE_KEY"
#
# Env: ACCOUNT (default parity-deployer), USE_MOCK_USDG=true (deploy MockUSDG instead of real testnet USDG),
#      OPERATOR, FEE_RECIPIENT, DEPOSIT_CAP, SEED_DEPOSIT, ARBISCAN_API_KEY (Sepolia verification).
#      DRY_RUN=1 DEPLOYER=0x... simulates only (no key needed, nothing sent).
set -euo pipefail
cd "$(dirname "$0")/.."

TARGET="${1:-robinhood}"
ACCOUNT="${ACCOUNT:-parity-deployer}"

if [[ -n "${DRY_RUN:-}" ]]; then
  DEPLOYER="${DEPLOYER:?set DEPLOYER=0x... for a dry run}"
  SIGN=(--sender "$DEPLOYER")
elif [[ -n "${PRIVATE_KEY:-}" ]]; then
  SIGN=(--private-key "$PRIVATE_KEY")
  DEPLOYER="$(cast wallet address --private-key "$PRIVATE_KEY")"
else
  SIGN=(--account "$ACCOUNT")
  DEPLOYER="$(cast wallet address --account "$ACCOUNT")"
fi

case "$TARGET" in
  robinhood)
    RPC=robinhood_testnet; CHAIN=46630; SCRIPT=DeployRobinhoodTestnet
    EXPLORER=https://explorer.testnet.chain.robinhood.com
    VERIFY=(--verify --verifier blockscout --verifier-url "$EXPLORER/api/")
    USDG=0x7E955252E15c84f5768B83c41a71F9eba181802F
    ;;
  sepolia)
    RPC=arbitrum_sepolia; CHAIN=421614; SCRIPT=DeployArbitrum
    EXPLORER=https://sepolia.arbiscan.io
    if [[ -n "${ARBISCAN_API_KEY:-}" ]]; then VERIFY=(--verify); else VERIFY=(); echo "ARBISCAN_API_KEY not set: skipping verification"; fi
    USDG=""
    ;;
  *) echo "usage: $0 [robinhood|sepolia]"; exit 1 ;;
esac

echo "== Deployer $DEPLOYER on chain $CHAIN"
[[ "$(cast chain-id --rpc-url "$RPC")" == "$CHAIN" ]] || { echo "RPC is not chain $CHAIN"; exit 1; }
echo "   ETH balance: $(cast balance "$DEPLOYER" --ether --rpc-url "$RPC")"
if [[ -n "$USDG" && "${USE_MOCK_USDG:-false}" != "true" ]]; then
  BAL=$(cast call "$USDG" "balanceOf(address)(uint256)" "$DEPLOYER" --rpc-url "$RPC" | awk '{print $1}')
  echo "   testnet USDG balance (6 dec): $BAL"
  if [[ "$BAL" == "0" ]]; then
    echo "   (no USDG: the vault deploys, but the seed deposit is skipped. Get USDG at https://faucet.paxos.com/ first, or set USE_MOCK_USDG=true)"
  fi
fi

if [[ -n "${DRY_RUN:-}" ]]; then
  forge script "script/Deploy.s.sol:$SCRIPT" --rpc-url "$RPC" "${SIGN[@]}"
  echo "(dry run: nothing was sent)"; exit 0
fi
forge script "script/Deploy.s.sol:$SCRIPT" --rpc-url "$RPC" "${SIGN[@]}" --broadcast --slow ${VERIFY[@]+"${VERIFY[@]}"}

echo
echo "== Deployed (from broadcast/Deploy.s.sol/$CHAIN/run-latest.json)"
python3 - "$CHAIN" "$EXPLORER" <<'EOF'
import json, sys
chain, explorer = sys.argv[1], sys.argv[2]
d = json.load(open(f"broadcast/Deploy.s.sol/{chain}/run-latest.json"))
for tx in d["transactions"]:
    name = tx.get("contractName") or ""
    if tx.get("transactionType") == "CREATE":
        print(f"{name:22} {explorer}/address/{tx['contractAddress']}")
    elif (tx.get("function") or "").startswith("deposit"):
        print(f"{'seed deposit tx':22} {explorer}/tx/{tx['hash']}")
EOF
