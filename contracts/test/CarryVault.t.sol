// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test, console2} from "forge-std/Test.sol";
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";
import {CarryVault} from "../src/CarryVault.sol";

/// @dev 6-decimal stablecoin stand-in (USDG and USDC both have 6 decimals).
contract MockUSD is ERC20 {
    constructor() ERC20("Mock Global Dollar", "mUSDG") {}

    function decimals() public pure override returns (uint8) {
        return 6;
    }

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }
}

/// @dev Minimal strategy: pulls an approved amount from the vault and can send it back.
contract MockStrategy {
    IERC20 public immutable token;

    constructor(IERC20 t) {
        token = t;
    }

    function pull(uint256 amount) external {
        token.transferFrom(msg.sender, address(this), amount);
    }

    function pushBack(address to, uint256 amount) external {
        token.transfer(to, amount);
    }
}

contract CarryVaultTest is Test {
    MockUSD usd;
    CarryVault vault;
    MockStrategy strat;

    address owner = makeAddr("owner");
    address operator = makeAddr("operator");
    address feeTo = makeAddr("feeTo");
    address alice = makeAddr("alice");
    address bob = makeAddr("bob");
    address stranger = makeAddr("stranger");

    uint256 constant CAP = 10_000_000e6;

    function setUp() public {
        usd = new MockUSD();
        vault = new CarryVault(IERC20(address(usd)), "Carry USDG Vault", "cvUSDG", owner, operator, feeTo, CAP);
        strat = new MockStrategy(IERC20(address(usd)));
        usd.mint(alice, 1_000_000e6);
        usd.mint(bob, 1_000_000e6);
        vm.prank(alice);
        usd.approve(address(vault), type(uint256).max);
        vm.prank(bob);
        usd.approve(address(vault), type(uint256).max);
    }

    function _deposit(address who, uint256 amt) internal returns (uint256) {
        vm.prank(who);
        return vault.deposit(amt, who);
    }

    /// @dev Simulate a strategy gain without the report bound: donate to the vault.
    function _gain(uint256 amt) internal {
        usd.mint(address(vault), amt);
    }

    // ------------------------------------------------------------------ basics

    function test_initialState() public view {
        assertEq(vault.asset(), address(usd));
        assertEq(vault.decimals(), 12); // 6 + offset 6
        assertEq(vault.pricePerShare(), 1e18);
        assertEq(vault.highWaterMark(), 1e18);
        assertEq(vault.performanceFeeBps(), 1000);
        assertEq(vault.maxReportChangeBps(), 200);
        assertEq(vault.owner(), owner);
        assertEq(vault.operator(), operator);
        assertEq(vault.feeRecipient(), feeTo);
    }

    function test_depositWithdraw_roundTrip() public {
        uint256 shares = _deposit(alice, 1_000e6);
        assertEq(shares, 1_000e12);
        assertEq(vault.pricePerShare(), 1e18);
        assertEq(vault.totalAssets(), 1_000e6);

        vm.prank(alice);
        uint256 burned = vault.withdraw(400e6, alice, alice);
        assertEq(burned, 400e12);
        uint256 rest = vault.balanceOf(alice);
        vm.prank(alice);
        uint256 out = vault.redeem(rest, alice, alice);
        assertEq(out, 600e6);
        assertEq(usd.balanceOf(alice), 1_000_000e6);
        assertEq(vault.totalSupply(), 0);
    }

    function test_previewsMatchExecution_withPendingFee() public {
        _deposit(alice, 1_000e6);
        _gain(100e6); // pending fee not yet harvested
        uint256 previewShares = vault.previewDeposit(500e6);
        uint256 got = _deposit(bob, 500e6);
        assertEq(got, previewShares, "previewDeposit == deposit");

        uint256 previewAssets = vault.previewRedeem(got);
        vm.prank(bob);
        uint256 out = vault.redeem(got, bob, bob);
        assertEq(out, previewAssets, "previewRedeem == redeem");
        assertApproxEqAbs(out, 500e6, 1, "bob gets back what he put in");
    }

    // ------------------------------------------------------------------ cap / pause

    function test_depositCap() public {
        vm.prank(owner);
        vault.setDepositCap(1_500e6);
        _deposit(alice, 1_000e6);
        assertEq(vault.maxDeposit(bob), 500e6);
        vm.prank(bob);
        vm.expectRevert(abi.encodeWithSelector(CarryVault.DepositCapExceeded.selector, 1_501e6, 1_500e6));
        vault.deposit(501e6, bob);
        _deposit(bob, 500e6);
        assertEq(vault.maxDeposit(bob), 0);
        vm.prank(bob);
        vm.expectRevert();
        vault.mint(1, bob);
    }

    function test_pauseBlocksDepositButNotWithdraw() public {
        _deposit(alice, 1_000e6);
        vm.prank(owner);
        vault.pause();
        assertEq(vault.maxDeposit(bob), 0);

        vm.prank(bob);
        vm.expectRevert(Pausable.EnforcedPause.selector);
        vault.deposit(1e6, bob);
        vm.prank(bob);
        vm.expectRevert(Pausable.EnforcedPause.selector);
        vault.mint(1e12, bob);

        vm.prank(alice);
        vault.withdraw(300e6, alice, alice);
        uint256 rest = vault.balanceOf(alice);
        vm.prank(alice);
        vault.redeem(rest, alice, alice);
        assertEq(usd.balanceOf(alice), 1_000_000e6);

        // operator actions blocked too
        vm.prank(owner);
        vault.allowTarget(address(strat), true);
        vm.startPrank(operator);
        vm.expectRevert(Pausable.EnforcedPause.selector);
        vault.approveTarget(address(usd), address(strat), 1);
        vm.expectRevert(Pausable.EnforcedPause.selector);
        vault.operatorCall(address(strat), abi.encodeCall(MockStrategy.pull, (1)), 0);
        vm.expectRevert(Pausable.EnforcedPause.selector);
        vault.reportDeployed(0);
        vm.stopPrank();

        vm.prank(owner);
        vault.unpause();
        _deposit(bob, 1e6);
    }

    // ------------------------------------------------------------------ operator

    function test_operatorCall_onlyAllowlisted_neverAsset() public {
        _deposit(alice, 1_000e6);
        bytes memory pull = abi.encodeCall(MockStrategy.pull, (100e6));

        vm.prank(operator);
        vm.expectRevert(abi.encodeWithSelector(CarryVault.TargetNotAllowed.selector, address(strat)));
        vault.operatorCall(address(strat), pull, 0);

        // asset token can never be called, even if someone tried to allow it
        bytes memory steal = abi.encodeCall(IERC20.transfer, (operator, 1_000e6));
        vm.prank(operator);
        vm.expectRevert(abi.encodeWithSelector(CarryVault.ForbiddenTarget.selector, address(usd)));
        vault.operatorCall(address(usd), steal, 0);
        vm.prank(owner);
        vm.expectRevert(abi.encodeWithSelector(CarryVault.ForbiddenTarget.selector, address(usd)));
        vault.allowTarget(address(usd), true);
        vm.prank(owner);
        vm.expectRevert(abi.encodeWithSelector(CarryVault.ForbiddenTarget.selector, address(vault)));
        vault.allowTarget(address(vault), true);
        vm.prank(operator);
        vm.expectRevert(abi.encodeWithSelector(CarryVault.ForbiddenTarget.selector, address(vault)));
        vault.operatorCall(address(vault), "", 0);
    }

    function test_operatorCall_tracksPrincipal_ppsUnchanged() public {
        _deposit(alice, 1_000e6);
        vm.prank(owner);
        vault.allowTarget(address(strat), true);

        vm.startPrank(operator);
        vault.approveTarget(address(usd), address(strat), 600e6);
        vault.operatorCall(address(strat), abi.encodeCall(MockStrategy.pull, (600e6)), 0);
        vm.stopPrank();

        assertEq(vault.idleAssets(), 400e6);
        assertEq(vault.deployedAssets(), 600e6);
        assertEq(vault.totalAssets(), 1_000e6);
        assertEq(vault.pricePerShare(), 1e18);
        assertEq(vault.maxWithdraw(alice), 400e6);

        // withdrawing more than idle reverts with the custom error
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(CarryVault.InsufficientIdleAssets.selector, 500e6, 400e6));
        vault.withdraw(500e6, alice, alice);
        uint256 allShares = vault.balanceOf(alice);
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(CarryVault.InsufficientIdleAssets.selector, 1_000e6, 400e6));
        vault.redeem(allShares, alice, alice);

        // operator unwinds, then full exit works
        vm.prank(operator);
        vault.operatorCall(address(strat), abi.encodeCall(MockStrategy.pushBack, (address(vault), 600e6)), 0);
        assertEq(vault.deployedAssets(), 0);
        vm.prank(alice);
        vault.redeem(allShares, alice, alice);
        assertEq(usd.balanceOf(alice), 1_000_000e6);
    }

    function test_operatorCall_bubblesRevert() public {
        vm.prank(owner);
        vault.allowTarget(address(strat), true);
        vm.prank(operator);
        vm.expectRevert(); // transferFrom without allowance
        vault.operatorCall(address(strat), abi.encodeCall(MockStrategy.pull, (1e6)), 0);
    }

    function test_approveTarget_onlyAllowlistedSpender() public {
        vm.prank(operator);
        vm.expectRevert(abi.encodeWithSelector(CarryVault.TargetNotAllowed.selector, stranger));
        vault.approveTarget(address(usd), stranger, 1e6);

        vm.prank(owner);
        vault.allowTarget(address(strat), true);
        vm.prank(operator);
        vault.approveTarget(address(usd), address(strat), 5e6);
        assertEq(usd.allowance(address(vault), address(strat)), 5e6);

        vm.prank(owner);
        vault.allowTarget(address(strat), false);
        vm.prank(operator);
        vm.expectRevert(abi.encodeWithSelector(CarryVault.TargetNotAllowed.selector, address(strat)));
        vault.approveTarget(address(usd), address(strat), 0);
    }

    function test_reportDeployed_bounded_andRateLimited() public {
        _deposit(alice, 1_000e6);
        vm.prank(owner);
        vault.allowTarget(address(strat), true);
        vm.startPrank(operator);
        vault.approveTarget(address(usd), address(strat), 1_000e6);
        vault.operatorCall(address(strat), abi.encodeCall(MockStrategy.pull, (1_000e6)), 0);

        // +2% ok, +2.01% not
        vm.expectRevert(abi.encodeWithSelector(CarryVault.ReportTooLarge.selector, 1_000e6, 1_020_100_000, 20e6));
        vault.reportDeployed(1_020_100_000);
        vault.reportDeployed(1_020e6);
        assertEq(vault.totalAssets(), 1_020e6);

        // second report inside the interval is rejected
        vm.expectRevert(abi.encodeWithSelector(CarryVault.ReportTooSoon.selector, block.timestamp + 1 hours));
        vault.reportDeployed(1_020e6);

        // after the interval, a loss larger than 2% must be marked in steps
        vm.warp(block.timestamp + 1 hours);
        vm.expectRevert();
        vault.reportDeployed(900e6);
        vault.reportDeployed(999_600_000); // -2% of 1020
        vm.stopPrank();

        // owner can reconcile without bounds
        vm.prank(owner);
        vault.syncDeployed(900e6);
        assertEq(vault.deployedAssets(), 900e6);
    }

    // ------------------------------------------------------------------ fees

    function test_harvest_feeMath_10pctGain() public {
        _deposit(alice, 1_000e6);
        _gain(100e6); // +10%
        assertEq(vault.totalAssets(), 1_100e6);

        uint256 feeShares = vault.harvest();
        assertGt(feeShares, 0);
        // fee = 10% of the 100 gain = 10 USDG, i.e. 1% of the starting TVL
        uint256 feeValue = vault.convertToAssets(vault.balanceOf(feeTo));
        assertApproxEqAbs(feeValue, 10e6, 2, "fee shares worth 10 USDG (floor rounding)");
        // alice keeps 1090 = 9% net gain
        assertApproxEqAbs(vault.convertToAssets(vault.balanceOf(alice)), 1_090e6, 2);
        // HWM moved to post-fee pps = 1.09
        assertApproxEqRel(vault.highWaterMark(), 1.09e18, 1e12);
        assertEq(vault.highWaterMark(), vault.pricePerShare());

        // no new gain -> no fee
        assertEq(vault.harvest(), 0);
        assertEq(vault.pendingFeeShares(), 0);
    }

    function test_harvest_noFeeAfterLossUntilRecovered() public {
        _deposit(alice, 1_000e6);
        _gain(100e6);
        vault.harvest();
        uint256 hwm = vault.highWaterMark();
        uint256 feeBal = vault.balanceOf(feeTo);

        // loss: 50 USDG leaves via the strategy and is marked lost by the owner
        vm.prank(owner);
        vault.allowTarget(address(strat), true);
        vm.startPrank(operator);
        vault.approveTarget(address(usd), address(strat), 50e6);
        vault.operatorCall(address(strat), abi.encodeCall(MockStrategy.pull, (50e6)), 0);
        vm.stopPrank();
        vm.prank(owner);
        vault.syncDeployed(0); // 50 lost
        assertLt(vault.pricePerShare(), hwm);
        assertEq(vault.harvest(), 0);
        assertEq(vault.highWaterMark(), hwm, "HWM does not move down");

        // partial recovery (still below HWM): no fee
        _gain(30e6);
        assertEq(vault.harvest(), 0);
        assertEq(vault.balanceOf(feeTo), feeBal);

        // full recovery + 20 above HWM: fee only on the part above HWM (≈ 10% of ~20)
        _gain(40e6);
        vault.harvest();
        uint256 newFeeValue = vault.convertToAssets(vault.balanceOf(feeTo) - feeBal);
        assertApproxEqAbs(newFeeValue, 2e6, 0.01e6);
    }

    function test_harvest_onDeposit_lateDepositorNotCharged() public {
        _deposit(alice, 1_000e6);
        _gain(100e6);
        _deposit(bob, 1_000e6); // accrues alice's fee first
        assertApproxEqAbs(vault.convertToAssets(vault.balanceOf(bob)), 1_000e6, 1);
        assertApproxEqAbs(vault.convertToAssets(vault.balanceOf(feeTo)), 10e6, 2);
        assertEq(vault.harvest(), 0);
    }

    function test_setPerformanceFee_bounds_andAccruesFirst() public {
        vm.prank(owner);
        vm.expectRevert(abi.encodeWithSelector(CarryVault.FeeTooHigh.selector, 2001));
        vault.setPerformanceFee(2001);

        _deposit(alice, 1_000e6);
        _gain(100e6);
        vm.prank(owner);
        vault.setPerformanceFee(0); // accrues 10% on the existing gain first
        assertApproxEqAbs(vault.convertToAssets(vault.balanceOf(feeTo)), 10e6, 2);
        _gain(100e6);
        assertEq(vault.harvest(), 0);
    }

    // ------------------------------------------------------------------ inflation attack

    function test_inflationAttack_firstDepositorDonation() public {
        // attacker deposits 1 wei, then donates 100k to inflate the share price
        vm.prank(stranger);
        usd.approve(address(vault), type(uint256).max);
        usd.mint(stranger, 100_001e6);
        vm.prank(stranger);
        vault.deposit(1, stranger);
        vm.prank(stranger);
        usd.transfer(address(vault), 100_000e6);

        // victim deposits 10k; virtual shares mean they still get shares worth ~10k
        uint256 shares = _deposit(alice, 10_000e6);
        assertGt(shares, 0);
        uint256 aliceValue = vault.convertToAssets(vault.balanceOf(alice));
        assertApproxEqRel(aliceValue, 10_000e6, 1e15, "victim loses < 0.1%");

        // attacker cannot profit: they redeem and get back less than they put in
        uint256 maxR = vault.maxRedeem(stranger);
        vm.prank(stranger);
        uint256 back = vault.redeem(maxR, stranger, stranger);
        assertLt(back, 100_000e6 + 1);
    }

    // ------------------------------------------------------------------ access control

    function test_onlyOwnerAndOperatorGuards() public {
        vm.startPrank(stranger);
        bytes memory notOwner = abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, stranger);
        vm.expectRevert(notOwner);
        vault.setOperator(stranger);
        vm.expectRevert(notOwner);
        vault.setFeeRecipient(stranger);
        vm.expectRevert(notOwner);
        vault.setPerformanceFee(0);
        vm.expectRevert(notOwner);
        vault.setDepositCap(0);
        vm.expectRevert(notOwner);
        vault.setReportBounds(0, 0);
        vm.expectRevert(notOwner);
        vault.allowTarget(address(strat), true);
        vm.expectRevert(notOwner);
        vault.syncDeployed(1);
        vm.expectRevert(notOwner);
        vault.pause();
        vm.expectRevert(notOwner);
        vault.unpause();

        vm.expectRevert(CarryVault.NotOperator.selector);
        vault.operatorCall(address(strat), "", 0);
        vm.expectRevert(CarryVault.NotOperator.selector);
        vault.approveTarget(address(usd), address(strat), 1);
        vm.expectRevert(CarryVault.NotOperator.selector);
        vault.reportDeployed(0);
        vm.stopPrank();

        // owner is not the operator
        vm.prank(owner);
        vm.expectRevert(CarryVault.NotOperator.selector);
        vault.reportDeployed(0);

        // two-step ownership transfer
        vm.prank(owner);
        vault.transferOwnership(bob);
        assertEq(vault.owner(), owner);
        vm.prank(bob);
        vault.acceptOwnership();
        assertEq(vault.owner(), bob);

        // zero-address guards
        vm.prank(bob);
        vm.expectRevert(CarryVault.ZeroAddress.selector);
        vault.setFeeRecipient(address(0));
    }
}

/// @notice Fork test against the real Paxos USDG on Robinhood Chain (chainId 4663).
///         Env: ROBINHOOD_RPC_URL (default public RPC), ROBINHOOD_FORK_BLOCK (default 0 = latest; the public RPC is not an archive node,
///         so old blocks fail with "historical state ... is not available"),
///         SKIP_ROBINHOOD_FORK=true to skip if the public RPC is down.
contract CarryVaultRobinhoodForkTest is Test {
    address constant USDG = 0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168;
    /// @dev Large USDG holder (~52.4M USDG at block 79426618), used as the funding source via prank.
    address constant USDG_WHALE = 0x8366a39CC670B4001A1121B8F6A443A643e40951;

    CarryVault vault;
    address user = makeAddr("user");

    function setUp() public {
        if (vm.envOr("SKIP_ROBINHOOD_FORK", false)) vm.skip(true);
        string memory rpc = vm.envOr("ROBINHOOD_RPC_URL", string("https://rpc.mainnet.chain.robinhood.com"));
        uint256 blk = vm.envOr("ROBINHOOD_FORK_BLOCK", uint256(0));
        if (blk == 0) vm.createSelectFork(rpc);
        else vm.createSelectFork(rpc, blk);
        assertEq(block.chainid, 4663);
        vault = new CarryVault(IERC20(USDG), "Carry USDG Vault", "cvUSDG", address(this), address(this), address(this), 10_000e6);
    }

    function test_fork_robinhood_usdg_depositWithdraw() public {
        assertEq(ERC20(USDG).decimals(), 6);
        assertEq(ERC20(USDG).symbol(), "USDG");

        vm.prank(USDG_WHALE);
        IERC20(USDG).transfer(user, 1_000e6);
        assertEq(IERC20(USDG).balanceOf(user), 1_000e6);

        vm.startPrank(user);
        IERC20(USDG).approve(address(vault), type(uint256).max);
        uint256 shares = vault.deposit(1_000e6, user);
        assertEq(shares, 1_000e12);
        assertEq(vault.totalAssets(), 1_000e6);
        assertEq(vault.pricePerShare(), 1e18);
        vault.withdraw(250e6, user, user);
        vault.redeem(vault.balanceOf(user), user, user);
        vm.stopPrank();

        assertEq(IERC20(USDG).balanceOf(user), 1_000e6);
        assertEq(vault.totalSupply(), 0);
        console2.log("USDG vault round trip on Robinhood Chain fork, chainId", block.chainid);
    }
}
