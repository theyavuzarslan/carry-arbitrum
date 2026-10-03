// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {ERC4626} from "@openzeppelin/contracts/token/ERC20/extensions/ERC4626.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {Address} from "@openzeppelin/contracts/utils/Address.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";

/// @title CarryVault
/// @author Carry
/// @notice ERC-4626 vault for managed carry strategies. Users deposit a stablecoin (USDG on Robinhood
///         Chain, USDC or USDG on Arbitrum One); the Carry bot (the `operator`) moves capital into
///         allowlisted strategy contracts and reports their value back. The vault charges a
///         performance fee on gains above a high-water mark and no management fee.
///
/// @dev Accounting model
///      - `totalAssets() = idleAssets() + deployedAssets`.
///      - `idleAssets()` is the vault's own balance of `asset`; withdrawals are served only from it.
///      - `deployedAssets` is the operator's mark of capital held in strategies. It moves two ways:
///          1. Principal flows are tracked automatically: every `operatorCall` measures the vault's
///             asset balance before and after, and adds what left (or subtracts what came back) to
///             `deployedAssets`. Moving money out therefore never changes the share price.
///          2. PnL is marked with `reportDeployed`, bounded to `maxReportChangeBps` of the current
///             `deployedAssets` and to one report per `minReportInterval`.
///      - The owner can override the mark with `syncDeployed` (e.g. after an asynchronous bridge
///        delivery lands directly in the vault). This is an explicit owner trust assumption.
///
///      Fee model
///      - `pricePerShare()` = assets per whole share, 1e18-scaled; a fresh vault reads exactly 1e18.
///      - When `pricePerShare() > highWaterMark`, the gain above the mark is
///        `G = (totalAssets + 1) * (pps - hwm) / pps`, the fee is `F = G * performanceFeeBps / 10_000`,
///        and the vault mints `s = F * (supply + 10**offset) / (totalAssets + 1 - F)` shares to
///        `feeRecipient`, so the recipient's shares are worth exactly `F` after minting. The mark is
///        then set to the post-mint price.
///      - The fee is accrued before every deposit/mint/withdraw/redeem and before fee-parameter
///        changes, and the preview/convert functions include pending fee shares, so previews are
///        exact and no depositor ever enters or exits at a pre-fee price.
///
///      Safety
///      - Inflation attacks: OpenZeppelin virtual shares with `_decimalsOffset() = 6`.
///      - The operator cannot call the asset token or the vault itself, so it cannot `transfer` /
///        `transferFrom` / `approve` vault funds directly. Allowances go through `approveTarget`,
///        which only approves allowlisted spenders.
///      - `pause()` blocks deposits and every operator action. Withdrawals of idle assets are never
///        pausable.
///
///      Not audited. Hackathon code.
contract CarryVault is ERC4626, Ownable2Step, Pausable, ReentrancyGuard {
    using SafeERC20 for IERC20;
    using Math for uint256;

    // ------------------------------------------------------------------ constants

    /// @notice Basis-point denominator.
    uint256 public constant BPS = 10_000;
    /// @notice Hard cap on the performance fee (20%).
    uint256 public constant MAX_PERFORMANCE_FEE_BPS = 2_000;
    /// @notice Hard cap on how far a single report may move `deployedAssets` (10%).
    uint256 public constant MAX_REPORT_CHANGE_BPS_LIMIT = 1_000;
    /// @notice Virtual-share offset (shares have `asset.decimals() + 6` decimals).
    uint8 public constant DECIMALS_OFFSET = 6;

    // ------------------------------------------------------------------ state

    /// @notice The Carry bot: may call allowlisted targets and report strategy value.
    address public operator;
    /// @notice Receives performance-fee shares.
    address public feeRecipient;
    /// @notice Performance fee in bps of gains above the high-water mark (default 10%).
    uint256 public performanceFeeBps = 1_000;
    /// @notice Highest post-fee `pricePerShare()` seen so far (1e18 = one asset per share).
    uint256 public highWaterMark = 1e18;
    /// @notice Maximum `totalAssets()` after a deposit.
    uint256 public depositCap;
    /// @notice Assets held in strategies, as tracked by `operatorCall` flows and marked by reports.
    uint256 public deployedAssets;
    /// @notice Max change of `deployedAssets` per `reportDeployed`, in bps of the current value (default 2%).
    uint256 public maxReportChangeBps = 200;
    /// @notice Minimum seconds between two `reportDeployed` calls (default 1 hour).
    uint256 public minReportInterval = 1 hours;
    /// @notice Timestamp of the last `reportDeployed`.
    uint256 public lastReportAt;
    /// @notice Contracts the operator may call or approve.
    mapping(address => bool) public isAllowedTarget;

    // ------------------------------------------------------------------ events

    event OperatorSet(address indexed previous, address indexed operator);
    event FeeRecipientSet(address indexed previous, address indexed feeRecipient);
    event PerformanceFeeSet(uint256 previousBps, uint256 feeBps);
    event DepositCapSet(uint256 previous, uint256 cap);
    event ReportBoundsSet(uint256 maxReportChangeBps, uint256 minReportInterval);
    event TargetAllowed(address indexed target, bool allowed);
    event TargetApproved(address indexed token, address indexed spender, uint256 amount);
    event OperatorCall(address indexed target, uint256 value, bytes4 selector, int256 idleDelta);
    event DeployedReported(uint256 previous, uint256 deployedAssets);
    event DeployedSynced(uint256 previous, uint256 deployedAssets);
    event FeeHarvested(uint256 feeShares, uint256 feeAssets, uint256 pricePerShare);
    event HighWaterMarkSet(uint256 previous, uint256 highWaterMark);

    // ------------------------------------------------------------------ errors

    error NotOperator();
    error ZeroAddress();
    error FeeTooHigh(uint256 feeBps);
    error ReportBoundTooHigh(uint256 bps);
    error TargetNotAllowed(address target);
    error ForbiddenTarget(address target);
    error DepositCapExceeded(uint256 totalAfter, uint256 cap);
    error InsufficientIdleAssets(uint256 needed, uint256 idle);
    error ReportTooLarge(uint256 previous, uint256 reported, uint256 maxChange);
    error ReportTooSoon(uint256 nextAllowedAt);

    modifier onlyOperator() {
        if (msg.sender != operator) revert NotOperator();
        _;
    }

    /// @param asset_        Underlying stablecoin (USDG / USDC).
    /// @param name_         Share token name.
    /// @param symbol_       Share token symbol.
    /// @param owner_        Owner (Ownable2Step).
    /// @param operator_     Carry bot address.
    /// @param feeRecipient_ Receives performance-fee shares.
    /// @param depositCap_   Max `totalAssets()` after a deposit, in asset units.
    constructor(
        IERC20 asset_,
        string memory name_,
        string memory symbol_,
        address owner_,
        address operator_,
        address feeRecipient_,
        uint256 depositCap_
    ) ERC20(name_, symbol_) ERC4626(asset_) Ownable(owner_) {
        if (address(asset_) == address(0) || operator_ == address(0) || feeRecipient_ == address(0)) {
            revert ZeroAddress();
        }
        operator = operator_;
        feeRecipient = feeRecipient_;
        depositCap = depositCap_;
        emit OperatorSet(address(0), operator_);
        emit FeeRecipientSet(address(0), feeRecipient_);
        emit DepositCapSet(0, depositCap_);
        emit PerformanceFeeSet(0, performanceFeeBps);
        emit ReportBoundsSet(maxReportChangeBps, minReportInterval);
    }

    /// @notice Accept native ETH (only needed if an allowlisted strategy pays out ETH or needs `value`).
    receive() external payable {}

    // ================================================================== views

    /// @notice Assets sitting in the vault, available for withdrawals.
    function idleAssets() public view returns (uint256) {
        return IERC20(asset()).balanceOf(address(this));
    }

    /// @inheritdoc ERC4626
    function totalAssets() public view override returns (uint256) {
        return idleAssets() + deployedAssets;
    }

    /// @notice Assets per whole share, 1e18-scaled, including pending fee shares (post-fee price).
    function pricePerShare() public view returns (uint256) {
        return _pps(totalAssets(), totalSupply() + pendingFeeShares());
    }

    /// @notice Fee shares `harvest()` would mint right now.
    function pendingFeeShares() public view returns (uint256 shares) {
        (shares,,) = _pendingFee();
    }

    // ================================================================== ERC-4626 overrides

    /// @dev Shares have 6 more decimals than the asset; virtual shares/assets defeat donation attacks.
    function _decimalsOffset() internal pure override returns (uint8) {
        return DECIMALS_OFFSET;
    }

    /// @dev Uses supply including pending fee shares so previews equal post-accrual execution.
    function _convertToShares(uint256 assets, Math.Rounding rounding) internal view override returns (uint256) {
        return assets.mulDiv(totalSupply() + pendingFeeShares() + 10 ** _decimalsOffset(), totalAssets() + 1, rounding);
    }

    /// @dev See `_convertToShares`.
    function _convertToAssets(uint256 shares, Math.Rounding rounding) internal view override returns (uint256) {
        return shares.mulDiv(totalAssets() + 1, totalSupply() + pendingFeeShares() + 10 ** _decimalsOffset(), rounding);
    }

    /// @notice 0 while paused; otherwise the room left under `depositCap`.
    function maxDeposit(address) public view override returns (uint256) {
        if (paused()) return 0;
        uint256 ta = totalAssets();
        return ta >= depositCap ? 0 : depositCap - ta;
    }

    /// @notice Shares equivalent of `maxDeposit`.
    function maxMint(address receiver) public view override returns (uint256) {
        return _convertToShares(maxDeposit(receiver), Math.Rounding.Floor);
    }

    /// @notice Owner's share value, capped by idle assets (deployed capital must be unwound first).
    function maxWithdraw(address owner_) public view override returns (uint256) {
        return Math.min(_convertToAssets(balanceOf(owner_), Math.Rounding.Floor), idleAssets());
    }

    /// @notice Owner's shares, capped by the shares that idle assets can redeem.
    function maxRedeem(address owner_) public view override returns (uint256) {
        return Math.min(balanceOf(owner_), _convertToShares(idleAssets(), Math.Rounding.Floor));
    }

    /// @notice Deposit `assets`. Reverts while paused or above `depositCap`.
    function deposit(uint256 assets, address receiver) public override nonReentrant whenNotPaused returns (uint256) {
        _harvest();
        _checkCap(assets);
        return super.deposit(assets, receiver);
    }

    /// @notice Mint `shares`. Reverts while paused or above `depositCap`.
    function mint(uint256 shares, address receiver) public override nonReentrant whenNotPaused returns (uint256) {
        _harvest();
        _checkCap(previewMint(shares));
        return super.mint(shares, receiver);
    }

    /// @notice Withdraw `assets` from idle balance. Never paused. Reverts with
    ///         `InsufficientIdleAssets` if the operator has not unwound enough capital.
    function withdraw(uint256 assets, address receiver, address owner_)
        public
        override
        nonReentrant
        returns (uint256)
    {
        _harvest();
        _checkIdle(assets);
        return super.withdraw(assets, receiver, owner_);
    }

    /// @notice Redeem `shares` against idle balance. Never paused. See `withdraw`.
    function redeem(uint256 shares, address receiver, address owner_) public override nonReentrant returns (uint256) {
        _harvest();
        _checkIdle(previewRedeem(shares));
        return super.redeem(shares, receiver, owner_);
    }

    // ================================================================== fees

    /// @notice Mint performance-fee shares if the price is above the high-water mark. Anyone may call.
    /// @return feeShares Shares minted to `feeRecipient`.
    function harvest() external nonReentrant returns (uint256 feeShares) {
        return _harvest();
    }

    function _harvest() internal returns (uint256 feeShares) {
        uint256 supply = totalSupply();
        uint256 feeAssets;
        uint256 pps;
        (feeShares, feeAssets, pps) = _pendingFee();
        if (supply == 0) {
            // Nobody to charge: reset the mark to the current price so a later depositor is not
            // charged for gains (e.g. donations) that happened before they entered.
            if (pps != highWaterMark) _setHwm(pps);
            return 0;
        }
        if (pps <= highWaterMark) return 0;
        if (feeShares > 0) {
            _mint(feeRecipient, feeShares);
            pps = _pps(totalAssets(), supply + feeShares);
            emit FeeHarvested(feeShares, feeAssets, pps);
        }
        _setHwm(pps);
    }

    /// @dev Returns (fee shares, fee value in assets, price per share before minting).
    function _pendingFee() internal view returns (uint256 shares, uint256 feeAssets, uint256 pps) {
        uint256 supply = totalSupply();
        uint256 ta = totalAssets();
        pps = _pps(ta, supply);
        uint256 hwm = highWaterMark;
        if (supply == 0 || pps <= hwm || performanceFeeBps == 0) return (0, 0, pps);
        uint256 gain = (ta + 1).mulDiv(pps - hwm, pps);
        feeAssets = gain.mulDiv(performanceFeeBps, BPS);
        shares = feeAssets.mulDiv(supply + 10 ** _decimalsOffset(), ta + 1 - feeAssets);
    }

    /// @dev Assets per whole share, 1e18-scaled, with OZ virtual shares/assets. Empty vault = 1e18.
    function _pps(uint256 ta, uint256 supply) internal pure returns (uint256) {
        uint256 v = 10 ** DECIMALS_OFFSET;
        return (ta + 1).mulDiv(1e18 * v, supply + v);
    }

    function _setHwm(uint256 hwm) internal {
        emit HighWaterMarkSet(highWaterMark, hwm);
        highWaterMark = hwm;
    }

    // ================================================================== operator

    /// @notice Call an allowlisted strategy contract with the vault as `msg.sender`.
    /// @dev    `target` may not be the asset token or the vault. The change in the vault's idle asset
    ///         balance is booked to `deployedAssets` (out = deployed, back = returned), so principal
    ///         movements never change the share price. Strategies must pull vault funds inside this
    ///         call; a pull at any other time would show up as a loss until reported.
    /// @param target Allowlisted contract.
    /// @param data   Calldata.
    /// @param value  Native ETH to forward (from the vault's ETH balance).
    /// @return result Raw return data.
    function operatorCall(address target, bytes calldata data, uint256 value)
        external
        nonReentrant
        onlyOperator
        whenNotPaused
        returns (bytes memory result)
    {
        if (target == asset() || target == address(this)) revert ForbiddenTarget(target);
        if (!isAllowedTarget[target]) revert TargetNotAllowed(target);

        uint256 idleBefore = idleAssets();
        result = Address.functionCallWithValue(target, data, value);
        uint256 idleAfter = idleAssets();

        int256 delta = 0;
        if (idleAfter < idleBefore) {
            uint256 out = idleBefore - idleAfter;
            deployedAssets += out;
            // forge-lint: disable-next-line(unsafe-typecast)
            delta = -int256(out); // token balances are far below 2**255
        } else if (idleAfter > idleBefore) {
            uint256 back = idleAfter - idleBefore;
            deployedAssets -= Math.min(deployedAssets, back);
            // forge-lint: disable-next-line(unsafe-typecast)
            delta = int256(back);
        }
        emit OperatorCall(target, value, data.length >= 4 ? bytes4(data[:4]) : bytes4(0), delta);
    }

    /// @notice Set an ERC-20 allowance from the vault to an allowlisted spender.
    function approveTarget(address token, address spender, uint256 amount)
        external
        nonReentrant
        onlyOperator
        whenNotPaused
    {
        if (!isAllowedTarget[spender]) revert TargetNotAllowed(spender);
        IERC20(token).forceApprove(spender, amount);
        emit TargetApproved(token, spender, amount);
    }

    /// @notice Mark the value of capital held in strategies (PnL).
    /// @dev    Bounded: |new − old| ≤ old × `maxReportChangeBps` / 10_000, and at most one report per
    ///         `minReportInterval`. Principal flows are already tracked by `operatorCall`.
    function reportDeployed(uint256 newDeployed) external onlyOperator whenNotPaused {
        uint256 next = lastReportAt + minReportInterval;
        if (lastReportAt != 0 && block.timestamp < next) revert ReportTooSoon(next);
        uint256 prev = deployedAssets;
        uint256 maxChange = prev.mulDiv(maxReportChangeBps, BPS);
        uint256 diff = newDeployed > prev ? newDeployed - prev : prev - newDeployed;
        if (diff > maxChange) revert ReportTooLarge(prev, newDeployed, maxChange);
        deployedAssets = newDeployed;
        lastReportAt = block.timestamp;
        emit DeployedReported(prev, newDeployed);
    }

    // ================================================================== owner

    /// @notice Set the operator (Carry bot).
    function setOperator(address operator_) external onlyOwner {
        if (operator_ == address(0)) revert ZeroAddress();
        emit OperatorSet(operator, operator_);
        operator = operator_;
    }

    /// @notice Set the fee recipient. Pending fees accrue to the previous recipient first.
    function setFeeRecipient(address feeRecipient_) external nonReentrant onlyOwner {
        if (feeRecipient_ == address(0)) revert ZeroAddress();
        _harvest();
        emit FeeRecipientSet(feeRecipient, feeRecipient_);
        feeRecipient = feeRecipient_;
    }

    /// @notice Set the performance fee (max 20%). Pending fees accrue at the old rate first.
    function setPerformanceFee(uint256 feeBps) external nonReentrant onlyOwner {
        if (feeBps > MAX_PERFORMANCE_FEE_BPS) revert FeeTooHigh(feeBps);
        _harvest();
        emit PerformanceFeeSet(performanceFeeBps, feeBps);
        performanceFeeBps = feeBps;
    }

    /// @notice Set the deposit cap (in asset units). Lowering it below TVL only blocks new deposits.
    function setDepositCap(uint256 cap) external onlyOwner {
        emit DepositCapSet(depositCap, cap);
        depositCap = cap;
    }

    /// @notice Set report bounds: max change per report (≤ 10%) and the minimum interval.
    function setReportBounds(uint256 maxChangeBps, uint256 interval) external onlyOwner {
        if (maxChangeBps > MAX_REPORT_CHANGE_BPS_LIMIT) revert ReportBoundTooHigh(maxChangeBps);
        maxReportChangeBps = maxChangeBps;
        minReportInterval = interval;
        emit ReportBoundsSet(maxChangeBps, interval);
    }

    /// @notice Allow or disallow a strategy contract / spender. The asset and the vault are never allowed.
    function allowTarget(address target, bool allowed) external onlyOwner {
        if (target == asset() || target == address(this) || target == address(0)) revert ForbiddenTarget(target);
        isAllowedTarget[target] = allowed;
        emit TargetAllowed(target, allowed);
    }

    /// @notice Owner override of `deployedAssets`, unbounded. For reconciling asynchronous flows
    ///         (e.g. a bridge delivery that lands in the vault outside `operatorCall`). Trust assumption.
    function syncDeployed(uint256 newDeployed) external onlyOwner {
        emit DeployedSynced(deployedAssets, newDeployed);
        deployedAssets = newDeployed;
    }

    /// @notice Pause deposits and all operator actions. Withdrawals stay open.
    function pause() external onlyOwner {
        _pause();
    }

    /// @notice Resume deposits and operator actions.
    function unpause() external onlyOwner {
        _unpause();
    }

    // ================================================================== internal checks

    function _checkCap(uint256 assets) internal view {
        uint256 totalAfter = totalAssets() + assets;
        if (totalAfter > depositCap) revert DepositCapExceeded(totalAfter, depositCap);
    }

    function _checkIdle(uint256 assets) internal view {
        uint256 idle = idleAssets();
        if (assets > idle) revert InsufficientIdleAssets(assets, idle);
    }
}
