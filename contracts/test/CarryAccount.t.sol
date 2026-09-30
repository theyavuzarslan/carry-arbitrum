// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test, console2} from "forge-std/Test.sol";

import {CarryAccount} from "../src/CarryAccount.sol";
import {CarryAccountFactory} from "../src/CarryAccountFactory.sol";
import {IERC20} from "../src/interfaces/IERC20.sol";
import {IPool} from "../src/interfaces/IPool.sol";
import {IAaveOracle} from "../src/interfaces/IAaveOracle.sol";
import {ISwapRouter02} from "../src/interfaces/ISwapRouter02.sol";

/// @notice Fork tests against live Arbitrum One state (Aave v3 + Uniswap v3).
///         RPC:   ARB_RPC_URL   (default https://arb1.arbitrum.io/rpc)
///         Block: ARB_FORK_BLOCK (default pinned below; set to 0 to fork at latest)
contract CarryAccountForkTest is Test {
    // --- Arbitrum One addresses -------------------------------------------------------------
    IPool constant POOL = IPool(0x794a61358D6845594F94dc1DB02A252b5b4814aD);
    IAaveOracle constant ORACLE = IAaveOracle(0xb56c2F0B653B2e0b10C9b928C8580Ac5Df02C7C7);
    ISwapRouter02 constant ROUTER = ISwapRouter02(0x68b3465833fb72A70ecDF485E0e4C7bD8665Fc45);
    address constant WETH = 0x82aF49447D8a07e3bd95BD0d56f35241523fBab1;
    address constant WSTETH = 0x5979D7b546E38E414F7E9822514be443A4800529;
    address constant WETH_VDEBT = 0x0c84331e39d6658Cd6e6b9ba04736cC4c4734351;

    uint8 constant EMODE_WSTETH_WETH = 7;
    uint24 constant FEE_1BP = 100; // WETH/wstETH 0.01% pool: by far the deepest v3 pool for the pair
    uint256 constant DEFAULT_FORK_BLOCK = 510_331_109;

    // Principal is sized to the fee-100 pool: it held ~21.5 wstETH at the pinned block, and a 3x open
    // on principal P buys 2P wstETH, so P = 5 keeps price impact negligible.
    uint256 constant PRINCIPAL = 5 ether;

    address owner = makeAddr("owner");
    address stranger = makeAddr("stranger");

    CarryAccountFactory factory;
    CarryAccount account;

    function setUp() public {
        string memory rpc = vm.envOr("ARB_RPC_URL", string("https://arb1.arbitrum.io/rpc"));
        uint256 forkBlock = vm.envOr("ARB_FORK_BLOCK", DEFAULT_FORK_BLOCK);
        if (forkBlock == 0) vm.createSelectFork(rpc);
        else vm.createSelectFork(rpc, forkBlock);

        factory = new CarryAccountFactory(POOL, ORACLE, ROUTER);
        vm.prank(owner);
        account = CarryAccount(factory.createAccount());

        deal(WSTETH, owner, 10 ether);
        vm.prank(owner);
        IERC20(WSTETH).approve(address(account), type(uint256).max);
    }

    // --- helpers ----------------------------------------------------------------------------

    function _openParams(uint256 leverage, uint256 minHf) internal pure returns (CarryAccount.OpenParams memory) {
        return CarryAccount.OpenParams({
            collateral: WSTETH,
            debt: WETH,
            eMode: EMODE_WSTETH_WETH,
            fee: FEE_1BP,
            principal: PRINCIPAL,
            targetLeverage: leverage,
            maxSlippageBps: 50, // 0.5%
            minHealthFactor: minHf
        });
    }

    function _closeParams() internal pure returns (CarryAccount.CloseParams memory) {
        return CarryAccount.CloseParams({collateral: WSTETH, debt: WETH, fee: FEE_1BP, maxSlippageBps: 50});
    }

    function _logPosition(string memory label) internal view {
        (uint256 c, uint256 d, uint256 hf, uint256 lev) = account.position();
        console2.log(label);
        console2.log("  collateral (USD 1e8):", c);
        console2.log("  debt       (USD 1e8):", d);
        console2.log("  healthFactor (1e18): ", hf);
        console2.log("  leverage     (1e18): ", lev);
    }

    // --- tests ------------------------------------------------------------------------------

    function test_factory_recordsAccount() public {
        assertEq(factory.accountOf(owner), address(account));
        assertEq(account.owner(), owner);
        vm.prank(owner);
        vm.expectRevert(abi.encodeWithSelector(CarryAccountFactory.AccountExists.selector, address(account)));
        factory.createAccount();
    }

    function test_openLoop_3x() public {
        uint256 minHf = 1.1e18;
        vm.prank(owner);
        account.openLoop(_openParams(3e18, minHf));

        (uint256 coll, uint256 debt, uint256 hf, uint256 lev) = account.position();
        _logPosition("after openLoop 3x");

        assertGt(debt, 0, "no debt");
        assertGt(coll, debt, "coll <= debt");
        assertApproxEqRel(lev, 3e18, 0.05e18, "leverage not within 5% of 3x");
        assertGe(hf, 1.05e18, "HF < 1.05");
        assertGe(hf, minHf, "HF < minHealthFactor");
        assertEq(POOL.getUserEMode(address(account)), EMODE_WSTETH_WETH, "not in e-mode 7");
        assertEq(IERC20(WSTETH).balanceOf(owner), 10 ether - PRINCIPAL, "principal not pulled");
        // Nothing should be left idle in the account.
        assertEq(IERC20(WETH).balanceOf(address(account)), 0, "idle WETH");
        assertEq(IERC20(WSTETH).balanceOf(address(account)), 0, "idle wstETH");
    }

    function test_closeLoop_returnsMostPrincipal() public {
        vm.startPrank(owner);
        account.openLoop(_openParams(3e18, 1.1e18));
        uint256 balBefore = IERC20(WSTETH).balanceOf(owner);
        account.closeLoop(_closeParams());
        vm.stopPrank();

        uint256 returned = IERC20(WSTETH).balanceOf(owner) - balBefore;
        console2.log("principal wstETH:", PRINCIPAL);
        console2.log("returned  wstETH:", returned);
        console2.log("round-trip cost (bps of principal):", (PRINCIPAL - returned) * 10_000 / PRINCIPAL);

        assertGe(returned, PRINCIPAL * 99 / 100, "returned < 99% of principal");
        assertEq(IERC20(WETH_VDEBT).balanceOf(address(account)), 0, "debt not repaid");
        (uint256 coll, uint256 debt,,) = account.position();
        assertEq(coll, 0, "collateral left in Aave");
        assertEq(debt, 0, "debt left in Aave");
        assertEq(IERC20(WSTETH).balanceOf(address(account)), 0, "wstETH stuck in account");
    }

    function test_onlyOwner() public {
        vm.startPrank(stranger);
        vm.expectRevert(CarryAccount.NotOwner.selector);
        account.openLoop(_openParams(3e18, 1.1e18));
        vm.expectRevert(CarryAccount.NotOwner.selector);
        account.closeLoop(_closeParams());
        vm.expectRevert(CarryAccount.NotOwner.selector);
        account.rescue(WSTETH, 1);
        vm.stopPrank();
    }

    function test_executeOperation_rejectsForeignCaller() public {
        bytes memory params = abi.encode(uint8(1), abi.encode(WSTETH, FEE_1BP, uint256(0)));

        // Random caller.
        vm.prank(stranger);
        vm.expectRevert(CarryAccount.NotPool.selector);
        account.executeOperation(WETH, 1 ether, 0, address(account), params);

        // Even the real Pool is rejected if someone else initiated the flash loan...
        vm.prank(address(POOL));
        vm.expectRevert(CarryAccount.BadInitiator.selector);
        account.executeOperation(WETH, 1 ether, 0, stranger, params);

        // ...or if no flash loan of ours is in progress.
        vm.prank(address(POOL));
        vm.expectRevert(CarryAccount.NoActiveFlashLoan.selector);
        account.executeOperation(WETH, 1 ether, 0, address(account), params);
    }

    /// @dev Deterministic: 3x lands at HF ~1.44, so demanding 2.0 trips our own post-check.
    function test_openLoop_revertsIfHealthTooLow_minHf() public {
        vm.prank(owner);
        vm.expectPartialRevert(CarryAccount.HealthFactorTooLow.selector);
        account.openLoop(_openParams(3e18, 2e18));
    }

    /// @dev 30x needs debt of 29/30 of collateral (96.7%) > e-mode LTV 94%, so Aave's borrow reverts
    ///      inside the flash-loan callback. A small principal is used so the swap itself (buying 29x
    ///      principal of wstETH) stays well inside the pool's depth and the revert comes from Aave's
    ///      LTV check rather than from Uniswap's amountOutMinimum.
    function test_openLoop_revertsIfHealthTooLow_30x() public {
        CarryAccount.OpenParams memory p = _openParams(30e18, 1.01e18);
        p.principal = 0.1 ether;
        vm.prank(owner);
        vm.expectRevert(bytes4(keccak256("HealthFactorLowerThanLiquidationThreshold()")));
        account.openLoop(p);
    }

    /// @dev Slippage guard: 30x on the full 5 wstETH principal would buy ~145 wstETH from a pool that
    ///      holds ~21.5, so the output falls far below the oracle-derived amountOutMinimum and the router
    ///      reverts. Proves amountOutMinimum is actually enforced.
    function test_openLoop_revertsOnExcessiveSlippage() public {
        vm.prank(owner);
        vm.expectRevert(bytes("Too little received"));
        account.openLoop(_openParams(30e18, 1.01e18));
    }

    function test_rescue() public {
        deal(WETH, address(account), 1 ether);
        vm.prank(owner);
        account.rescue(WETH, 1 ether);
        assertEq(IERC20(WETH).balanceOf(owner), 1 ether);
    }

    /// @notice Informational only: shows the borrow-rate side of the carry over 30 days.
    /// @dev Staking yield reaches wstETH through its exchange rate / oracle, which vm.warp does NOT move,
    ///      so this isolates the cost leg (WETH borrow interest) against the supply interest on wstETH.
    function test_carry_30days_logOnly() public {
        vm.prank(owner);
        account.openLoop(_openParams(3e18, 1.1e18));
        (uint256 c0, uint256 d0,,) = account.position();

        vm.warp(block.timestamp + 30 days);
        (uint256 c1, uint256 d1, uint256 hf1,) = account.position();

        int256 equity0 = int256(c0) - int256(d0);
        int256 equity1 = int256(c1) - int256(d1);
        console2.log("equity t0 (USD 1e8):", equity0);
        console2.log("equity t30 (USD 1e8):", equity1);
        console2.log("equity change (USD 1e8, excl. staking yield):", equity1 - equity0);
        console2.log("HF after 30 days:", hf1);
    }
}
