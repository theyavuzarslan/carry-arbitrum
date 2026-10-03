// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Script, console2} from "forge-std/Script.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {CarryAccountFactory} from "../src/CarryAccountFactory.sol";
import {CarryVault} from "../src/CarryVault.sol";
import {MockUSDG} from "../src/mocks/MockUSDG.sol";
import {IPool} from "../src/interfaces/IPool.sol";
import {IAaveOracle} from "../src/interfaces/IAaveOracle.sol";
import {ISwapRouter02} from "../src/interfaces/ISwapRouter02.sol";

/// @notice Deploys CarryAccountFactory with per-chain defaults (override with AAVE_POOL / AAVE_ORACLE /
///         UNISWAP_ROUTER):
///         - Arbitrum Sepolia (421614): Aave v3 Pool 0xBfC9…2Eff, its oracle 0xEf95…5c00 (read from the
///           Pool's ADDRESSES_PROVIDER), Uniswap SwapRouter02 0x101F…663E.
///         - Arbitrum One (42161): the fork-tested addresses.
///         The leveraged loop itself needs Aave e-mode 7 (wstETH/WETH) and a liquid Uniswap pool, which only
///         Arbitrum One has; on Sepolia the factory and accounts deploy and are wired to real Aave/Uniswap.
///
///   forge script script/Deploy.s.sol:DeployArbitrum --rpc-url arbitrum_sepolia --account carry-deployer --broadcast
contract DeployArbitrum is Script {
    address constant ARB_AAVE_POOL = 0x794a61358D6845594F94dc1DB02A252b5b4814aD;
    address constant ARB_AAVE_ORACLE = 0xb56c2F0B653B2e0b10C9b928C8580Ac5Df02C7C7;
    address constant ARB_UNISWAP_ROUTER02 = 0x68b3465833fb72A70ecDF485E0e4C7bD8665Fc45;

    address constant SEP_AAVE_POOL = 0xBfC91D59fdAA134A4ED45f7B584cAf96D7792Eff;
    address constant SEP_AAVE_ORACLE = 0xEf95A6B9e88Bd509Fd67BA741cf2b263DaC65c00;
    address constant SEP_UNISWAP_ROUTER02 = 0x101F443B4d1b059569D643917553c771E1b9663E;

    function run() external returns (CarryAccountFactory factory) {
        bool sepolia = block.chainid == 421614;
        require(sepolia || block.chainid == 42161, "use Arbitrum One or Arbitrum Sepolia");
        address pool = vm.envOr("AAVE_POOL", sepolia ? SEP_AAVE_POOL : ARB_AAVE_POOL);
        address oracle = vm.envOr("AAVE_ORACLE", sepolia ? SEP_AAVE_ORACLE : ARB_AAVE_ORACLE);
        address router = vm.envOr("UNISWAP_ROUTER", sepolia ? SEP_UNISWAP_ROUTER02 : ARB_UNISWAP_ROUTER02);
        require(pool.code.length > 0 && oracle.code.length > 0 && router.code.length > 0, "missing code");

        vm.startBroadcast();
        factory = new CarryAccountFactory(IPool(pool), IAaveOracle(oracle), ISwapRouter02(router));
        vm.stopBroadcast();

        console2.log("chainId              ", block.chainid);
        console2.log("CarryAccountFactory  ", address(factory));
        console2.log("  pool               ", pool);
        console2.log("  oracle             ", oracle);
        console2.log("  router             ", router);
    }
}

/// @dev Shared vault deployment. Owner = broadcaster; OPERATOR / FEE_RECIPIENT default to it;
///      DEPOSIT_CAP defaults to 10,000 units of a 6-decimal stablecoin. If `seed > 0` and the deployer
///      holds enough of the asset, it deposits `seed` so the vault has on-chain activity.
abstract contract DeployVaultBase is Script {
    function _deployVault(address asset, string memory name, string memory symbol, bool useMock, uint256 seed)
        internal
        returns (CarryVault vault)
    {
        vm.startBroadcast();
        (, address sender,) = vm.readCallers();
        if (useMock) {
            MockUSDG mock = new MockUSDG();
            mock.mint(sender, 10_000e6);
            asset = address(mock);
            console2.log("MockUSDG             ", asset);
        }
        address operator = vm.envOr("OPERATOR", sender);
        address feeRecipient = vm.envOr("FEE_RECIPIENT", sender);
        uint256 cap = vm.envOr("DEPOSIT_CAP", uint256(10_000e6));
        vault = new CarryVault(IERC20(asset), name, symbol, sender, operator, feeRecipient, cap);

        uint256 bal = IERC20(asset).balanceOf(sender);
        if (seed > 0 && bal >= seed) {
            IERC20(asset).approve(address(vault), seed);
            vault.deposit(seed, sender);
            console2.log("  seed deposit       ", seed);
        } else if (seed > 0) {
            console2.log("  seed deposit SKIPPED, deployer asset balance:", bal);
        }
        vm.stopBroadcast();

        console2.log("chainId              ", block.chainid);
        console2.log("CarryVault           ", address(vault));
        console2.log("  asset              ", asset);
        console2.log("  owner              ", sender);
        console2.log("  operator           ", operator);
        console2.log("  feeRecipient       ", feeRecipient);
        console2.log("  depositCap         ", cap);
        console2.log("  performanceFeeBps  ", vault.performanceFeeBps());
        console2.log("  totalSupply        ", vault.totalSupply());
    }
}

/// @notice TESTNET (primary path): CarryVault on Robinhood Chain testnet (chainId 46630).
///         Default asset: Paxos testnet USDG 0x7E95…802F (from docs.paxos.com, checked with cast and the
///         testnet Blockscout). Get some at faucet.paxos.com and the script seeds the vault with
///         SEED_DEPOSIT (default 1 USDG). If you cannot get testnet USDG, set USE_MOCK_USDG=true: the
///         script deploys MockUSDG, mints 10,000 to you, and seeds the vault with it.
///
///   forge script script/Deploy.s.sol:DeployRobinhoodTestnet --rpc-url robinhood_testnet --account carry-deployer --broadcast
contract DeployRobinhoodTestnet is DeployVaultBase {
    address constant TESTNET_USDG = 0x7E955252E15c84f5768B83c41a71F9eba181802F;

    function run() external returns (CarryVault) {
        require(block.chainid == 46630, "not Robinhood Chain testnet");
        bool useMock = vm.envOr("USE_MOCK_USDG", false);
        return _deployVault(
            vm.envOr("VAULT_ASSET", TESTNET_USDG),
            "Carry USDG Vault (testnet)",
            "cvUSDG",
            useMock,
            vm.envOr("SEED_DEPOSIT", uint256(1e6))
        );
    }
}

/// @notice MAINNET: CarryVault over Paxos USDG on Robinhood Chain (chainId 4663).
///   forge script script/Deploy.s.sol:DeployRobinhoodVault --rpc-url robinhood --account carry-deployer --broadcast
contract DeployRobinhoodVault is DeployVaultBase {
    /// @dev Canonical Paxos USDG on Robinhood Chain (docs.paxos.com + docs.robinhood.com/chain/contracts).
    address constant USDG = 0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168;

    function run() external returns (CarryVault) {
        require(block.chainid == 4663, "not Robinhood Chain");
        return _deployVault(
            vm.envOr("VAULT_ASSET", USDG), "Carry USDG Vault", "cvUSDG", false, vm.envOr("SEED_DEPOSIT", uint256(0))
        );
    }
}

/// @notice Optional vault on Arbitrum. Arbitrum Sepolia (421614): Paxos testnet USDG 0xFFC9…1892, seeds
///         1 USDG if you hold it. Arbitrum One (42161): native USDC (set VAULT_ASSET to
///         0x004B506865409877C9fA29bfb1ebA929984B9bbC for Paxos USDG), no seed by default.
///   forge script script/Deploy.s.sol:DeployArbitrumVault --rpc-url arbitrum_sepolia --account carry-deployer --broadcast
contract DeployArbitrumVault is DeployVaultBase {
    address constant USDC = 0xaf88d065e77c8cC2239327C5EDb3A432268e5831;
    address constant SEPOLIA_USDG = 0xFFC95faa3d63Cde504a05B567C600B78C0b41892;

    function run() external returns (CarryVault) {
        bool sepolia = block.chainid == 421614;
        require(sepolia || block.chainid == 42161, "use Arbitrum One or Arbitrum Sepolia");
        address asset = vm.envOr("VAULT_ASSET", sepolia ? SEPOLIA_USDG : USDC);
        bool isUsdc = asset == USDC;
        return _deployVault(
            asset,
            isUsdc ? "Carry USDC Vault" : "Carry USDG Vault",
            isUsdc ? "cvUSDC" : "cvUSDG",
            false,
            vm.envOr("SEED_DEPOSIT", sepolia ? uint256(1e6) : uint256(0))
        );
    }
}
