// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {IERC20} from "./interfaces/IERC20.sol";
import {IPool} from "./interfaces/IPool.sol";
import {IAaveOracle} from "./interfaces/IAaveOracle.sol";
import {ISwapRouter02} from "./interfaces/ISwapRouter02.sol";
import {IFlashLoanSimpleReceiver} from "./interfaces/IFlashLoanSimpleReceiver.sol";
import {SafeTransferLib} from "./libraries/SafeTransferLib.sol";

/// @title CarryAccount
/// @notice A single-owner smart account that holds a leveraged "staking carry" position on Aave v3.
///
///         The canonical trade (Arbitrum):
///           collateral = wstETH (earns Lido staking yield through its exchange rate)
///           debt       = WETH   (pays the Aave variable borrow rate)
///           e-mode 7   = "wstETH/WETH ETH Correlated" (LTV 94%, liquidation threshold 96%)
///
///         Net carry on equity ~= stakingYield * L - borrowRate * (L - 1), for leverage L.
///
///         Both `openLoop` and `closeLoop` are atomic: a single Aave flash loan of the DEBT asset funds
///         the swap, so the position goes from 1x to Lx (or Lx back to 0) in one transaction, with no
///         iterative borrow/swap/supply loop and no intermediate state that could be liquidated.
///
///         The account itself is the Aave borrower (`onBehalfOf == address(this)`), so no credit
///         delegation or approvals over the owner's own Aave position are needed. Every state-changing
///         entry point is restricted to `owner`; the only other external entry point is the Aave flash
///         loan callback, which is locked down to (POOL, initiator == this, flash in progress).
contract CarryAccount is IFlashLoanSimpleReceiver {
    using SafeTransferLib for address;

    // -----------------------------------------------------------------------------------------
    // Types
    // -----------------------------------------------------------------------------------------

    /// @param collateral      asset supplied to Aave (e.g. wstETH)
    /// @param debt            asset borrowed from Aave and flash-loaned (e.g. WETH)
    /// @param eMode           Aave e-mode category to enter (e.g. 7); 0 = no e-mode
    /// @param fee             Uniswap v3 pool fee tier for the collateral/debt pair (e.g. 100 = 0.01%)
    /// @param principal       amount of `collateral` pulled from the owner with transferFrom
    /// @param targetLeverage  1e18-scaled; total collateral added = principal * targetLeverage
    /// @param maxSlippageBps  max tolerated swap shortfall vs. the Aave-oracle price, in bps
    /// @param minHealthFactor 1e18-scaled; the tx reverts if the resulting Aave HF is below this
    struct OpenParams {
        address collateral;
        address debt;
        uint8 eMode;
        uint24 fee;
        uint256 principal;
        uint256 targetLeverage;
        uint256 maxSlippageBps;
        uint256 minHealthFactor;
    }

    /// @param collateral     collateral asset of the position to unwind
    /// @param debt           debt asset of the position to unwind
    /// @param fee            Uniswap v3 fee tier used to swap collateral back into debt
    /// @param maxSlippageBps max extra collateral (vs. oracle price) spent buying back the debt, in bps
    struct CloseParams {
        address collateral;
        address debt;
        uint24 fee;
        uint256 maxSlippageBps;
    }

    // -----------------------------------------------------------------------------------------
    // Constants / immutables
    // -----------------------------------------------------------------------------------------

    uint8 private constant ACTION_OPEN = 1;
    uint8 private constant ACTION_CLOSE = 2;

    uint256 private constant VARIABLE_RATE = 2;
    uint256 private constant BPS = 10_000;
    uint256 private constant WAD = 1e18;
    /// @dev Hard ceiling on the slippage an owner can accept, as a fat-finger guard.
    uint256 public constant MAX_SLIPPAGE_BPS = 500; // 5%

    address public immutable owner;
    IPool public immutable POOL;
    IAaveOracle public immutable ORACLE;
    ISwapRouter02 public immutable ROUTER;

    /// @dev Set only for the duration of our own flash loan. Transient storage (EIP-1153, supported on
    ///      Arbitrum since ArbOS 20) means it can never leak between transactions.
    bool private transient _flashActive;

    // -----------------------------------------------------------------------------------------
    // Events / errors
    // -----------------------------------------------------------------------------------------

    /// @param totalCollateral aToken balance of `collateral` after opening (collateral units)
    /// @param totalDebt       variable debt of `debt` after opening (debt units)
    /// @param healthFactor    Aave health factor after opening (1e18-scaled)
    event LoopOpened(
        address indexed collateral,
        address indexed debt,
        uint256 totalCollateral,
        uint256 totalDebt,
        uint256 healthFactor
    );
    /// @param returnedCollateral collateral sent back to the owner after the debt was fully repaid
    event LoopClosed(uint256 returnedCollateral);
    event Rescued(address indexed token, uint256 amount);

    error NotOwner();
    error NotPool();
    error BadInitiator();
    error NoActiveFlashLoan();
    error UnknownAction(uint8 action);
    error InvalidParams();
    error HealthFactorTooLow(uint256 healthFactor, uint256 minHealthFactor);

    modifier onlyOwner() {
        if (msg.sender != owner) revert NotOwner();
        _;
    }

    constructor(address _owner, IPool _pool, IAaveOracle _oracle, ISwapRouter02 _router) {
        if (_owner == address(0) || address(_pool) == address(0)) revert InvalidParams();
        owner = _owner;
        POOL = _pool;
        ORACLE = _oracle;
        ROUTER = _router;
    }

    // -----------------------------------------------------------------------------------------
    // Open
    // -----------------------------------------------------------------------------------------

    /// @notice Pull `principal` collateral from the owner and lever it up to `targetLeverage` in one tx.
    /// @dev Flow:
    ///      1. transferFrom principal, supply it, enter e-mode.
    ///      2. flashLoanSimple(debt, D) where D is the oracle value of principal * (L - 1) collateral.
    ///      3. (callback) swap D debt -> collateral, supply it, borrow D + premium, approve repayment.
    ///      4. Check the final health factor against `minHealthFactor`.
    ///      Calling it again on an existing position adds another leveraged slice on top.
    function openLoop(OpenParams calldata p) external onlyOwner {
        if (
            p.collateral == address(0) || p.debt == address(0) || p.collateral == p.debt || p.principal == 0
                || p.targetLeverage < WAD || p.maxSlippageBps > MAX_SLIPPAGE_BPS
        ) revert InvalidParams();

        // 1. Principal in, supplied as collateral.
        p.collateral.safeTransferFrom(msg.sender, address(this), p.principal);
        _supply(p.collateral, p.principal);

        // Enter the correlated e-mode category (skip if already in it, so repeat opens don't revert).
        if (POOL.getUserEMode(address(this)) != p.eMode) POOL.setUserEMode(p.eMode);

        // 2. Flash-borrow the debt asset needed to buy the extra collateral.
        uint256 extraCollateral = p.principal * (p.targetLeverage - WAD) / WAD;
        if (extraCollateral > 0) {
            uint256 flashAmount = oracleConvert(p.collateral, p.debt, extraCollateral);
            // Minimum collateral we accept for `flashAmount` of debt: oracle value minus slippage.
            uint256 minCollateralOut = extraCollateral * (BPS - p.maxSlippageBps) / BPS;
            _flashLoan(p.debt, flashAmount, abi.encode(ACTION_OPEN, abi.encode(p.collateral, p.fee, minCollateralOut)));
        }

        // 4. Safety check on the resulting position.
        (,,,,, uint256 hf) = POOL.getUserAccountData(address(this));
        if (hf < p.minHealthFactor) revert HealthFactorTooLow(hf, p.minHealthFactor);

        emit LoopOpened(
            p.collateral,
            p.debt,
            IERC20(POOL.getReserveAToken(p.collateral)).balanceOf(address(this)),
            IERC20(POOL.getReserveVariableDebtToken(p.debt)).balanceOf(address(this)),
            hf
        );
    }

    // -----------------------------------------------------------------------------------------
    // Close
    // -----------------------------------------------------------------------------------------

    /// @notice Fully unwind the position and send all remaining collateral to the owner, in one tx.
    /// @dev Flow:
    ///      1. flashLoanSimple(debt, currentVariableDebt).
    ///      2. (callback) repay all debt, withdraw just enough collateral (oracle price + slippage),
    ///         exactOutputSingle it into flashAmount + premium, approve repayment.
    ///      3. Withdraw the rest of the collateral and sweep it (and any debt-asset dust) to the owner.
    function closeLoop(CloseParams calldata p) external onlyOwner {
        if (
            p.collateral == address(0) || p.debt == address(0) || p.collateral == p.debt
                || p.maxSlippageBps > MAX_SLIPPAGE_BPS
        ) revert InvalidParams();

        // 1-2. Repay the whole debt with a flash loan (interest does not accrue within a block, so the
        //      balance read here is exactly what `repay(type(uint256).max)` will pay).
        uint256 debtOutstanding = IERC20(POOL.getReserveVariableDebtToken(p.debt)).balanceOf(address(this));
        if (debtOutstanding > 0) {
            _flashLoan(
                p.debt, debtOutstanding, abi.encode(ACTION_CLOSE, abi.encode(p.collateral, p.fee, p.maxSlippageBps))
            );
        }

        // 3. Debt is zero now: withdraw everything that is left and hand it back.
        if (IERC20(POOL.getReserveAToken(p.collateral)).balanceOf(address(this)) > 0) {
            POOL.withdraw(p.collateral, type(uint256).max, address(this));
        }
        uint256 returned = IERC20(p.collateral).balanceOf(address(this));
        if (returned > 0) p.collateral.safeTransfer(owner, returned);

        uint256 debtDust = IERC20(p.debt).balanceOf(address(this));
        if (debtDust > 0) p.debt.safeTransfer(owner, debtDust);

        emit LoopClosed(returned);
    }

    // -----------------------------------------------------------------------------------------
    // Flash loan callback
    // -----------------------------------------------------------------------------------------

    /// @inheritdoc IFlashLoanSimpleReceiver
    /// @dev Only the Aave Pool may call this, only for a flash loan this contract initiated, and only
    ///      while one of our own open/close calls is on the stack.
    function executeOperation(address asset, uint256 amount, uint256 premium, address initiator, bytes calldata params)
        external
        override
        returns (bool)
    {
        if (msg.sender != address(POOL)) revert NotPool();
        if (initiator != address(this)) revert BadInitiator();
        if (!_flashActive) revert NoActiveFlashLoan();

        (uint8 action, bytes memory data) = abi.decode(params, (uint8, bytes));
        uint256 owed = amount + premium;

        if (action == ACTION_OPEN) {
            _onOpen(asset, amount, owed, data);
        } else if (action == ACTION_CLOSE) {
            _onClose(asset, amount, owed, data);
        } else {
            revert UnknownAction(action);
        }

        // The Pool pulls `amount + premium` of `asset` from us right after this returns.
        asset.safeApprove(address(POOL), owed);
        return true;
    }

    /// @dev OPEN leg: we hold `amount` of the debt asset. Swap it all to collateral, supply, then borrow
    ///      `owed` (= amount + premium) of the debt asset against the enlarged collateral.
    function _onOpen(address debt, uint256 amount, uint256 owed, bytes memory data) private {
        (address collateral, uint24 fee, uint256 minCollateralOut) = abi.decode(data, (address, uint24, uint256));

        uint256 collateralOut = _swapExactIn(debt, collateral, fee, amount, minCollateralOut);
        _supply(collateral, collateralOut);

        // Reverts inside Aave if the borrow would exceed the (e-mode) LTV.
        POOL.borrow(debt, owed, VARIABLE_RATE, 0, address(this));
    }

    /// @dev CLOSE leg: we hold `amount` (== current debt) of the debt asset. Repay everything, then
    ///      withdraw only as much collateral as needed to buy back `owed` of the debt asset.
    function _onClose(address debt, uint256 amount, uint256 owed, bytes memory data) private {
        (address collateral, uint24 fee, uint256 maxSlippageBps) = abi.decode(data, (address, uint24, uint256));

        debt.safeApprove(address(POOL), amount);
        POOL.repay(debt, type(uint256).max, VARIABLE_RATE, address(this));

        // Oracle value of what we owe, plus slippage headroom, capped at what we actually have.
        uint256 maxCollateralIn = oracleConvert(debt, collateral, owed) * (BPS + maxSlippageBps) / BPS;
        uint256 supplied = IERC20(POOL.getReserveAToken(collateral)).balanceOf(address(this));
        if (maxCollateralIn > supplied) maxCollateralIn = supplied;
        POOL.withdraw(collateral, maxCollateralIn, address(this));

        // Exact-output swap: spend at most `maxCollateralIn`, receive exactly `owed` of the debt asset.
        // Unspent collateral stays in this contract and is swept to the owner by closeLoop.
        collateral.safeApprove(address(ROUTER), maxCollateralIn);
        ROUTER.exactOutputSingle(
            ISwapRouter02.ExactOutputSingleParams({
                tokenIn: collateral,
                tokenOut: debt,
                fee: fee,
                recipient: address(this),
                amountOut: owed,
                amountInMaximum: maxCollateralIn,
                sqrtPriceLimitX96: 0
            })
        );
        collateral.safeApprove(address(ROUTER), 0);
    }

    // -----------------------------------------------------------------------------------------
    // Owner utilities
    // -----------------------------------------------------------------------------------------

    /// @notice Send any token held by this contract (not Aave positions) back to the owner.
    function rescue(address token, uint256 amount) external onlyOwner {
        token.safeTransfer(owner, amount);
        emit Rescued(token, amount);
    }

    // -----------------------------------------------------------------------------------------
    // Views
    // -----------------------------------------------------------------------------------------

    /// @notice Snapshot of the Aave position.
    /// @return totalCollateralBase collateral value (oracle base currency, USD 8 decimals)
    /// @return totalDebtBase       debt value (oracle base currency)
    /// @return healthFactor        1e18-scaled (type(uint256).max when there is no debt)
    /// @return leverage            collateral / equity, 1e18-scaled (0 when there is no collateral)
    function position()
        external
        view
        returns (uint256 totalCollateralBase, uint256 totalDebtBase, uint256 healthFactor, uint256 leverage)
    {
        (totalCollateralBase, totalDebtBase,,,, healthFactor) = POOL.getUserAccountData(address(this));
        if (totalCollateralBase > totalDebtBase) {
            leverage = totalCollateralBase * WAD / (totalCollateralBase - totalDebtBase);
        } else if (totalCollateralBase > 0) {
            leverage = type(uint256).max; // underwater (should be unreachable before liquidation)
        }
    }

    /// @notice Value `amountFrom` of `from` in units of `to`, using the Aave oracle (the same prices Aave
    ///         uses for health factor), accounting for token decimals.
    function oracleConvert(address from, address to, uint256 amountFrom) public view returns (uint256) {
        uint256 pFrom = ORACLE.getAssetPrice(from);
        uint256 pTo = ORACLE.getAssetPrice(to);
        uint8 dFrom = IERC20(from).decimals();
        uint8 dTo = IERC20(to).decimals();
        return amountFrom * pFrom * (10 ** dTo) / (pTo * (10 ** dFrom));
    }

    // -----------------------------------------------------------------------------------------
    // Internals
    // -----------------------------------------------------------------------------------------

    function _flashLoan(address asset, uint256 amount, bytes memory params) private {
        _flashActive = true;
        POOL.flashLoanSimple(address(this), asset, amount, params, 0);
        _flashActive = false;
    }

    function _supply(address asset, uint256 amount) private {
        asset.safeApprove(address(POOL), amount);
        POOL.supply(asset, amount, address(this), 0);
    }

    function _swapExactIn(address tokenIn, address tokenOut, uint24 fee, uint256 amountIn, uint256 minOut)
        private
        returns (uint256 amountOut)
    {
        tokenIn.safeApprove(address(ROUTER), amountIn);
        amountOut = ROUTER.exactInputSingle(
            ISwapRouter02.ExactInputSingleParams({
                tokenIn: tokenIn,
                tokenOut: tokenOut,
                fee: fee,
                recipient: address(this),
                amountIn: amountIn,
                amountOutMinimum: minOut,
                sqrtPriceLimitX96: 0
            })
        );
    }
}
