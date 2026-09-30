// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @notice Minimal subset of the Aave v3 Pool (v3.4 on Arbitrum) used by CarryAccount.
interface IPool {
    function supply(address asset, uint256 amount, address onBehalfOf, uint16 referralCode) external;

    function withdraw(address asset, uint256 amount, address to) external returns (uint256);

    /// @param interestRateMode 2 = variable (stable rate has been removed in v3.2+)
    function borrow(address asset, uint256 amount, uint256 interestRateMode, uint16 referralCode, address onBehalfOf)
        external;

    function repay(address asset, uint256 amount, uint256 interestRateMode, address onBehalfOf)
        external
        returns (uint256);

    function flashLoanSimple(
        address receiverAddress,
        address asset,
        uint256 amount,
        bytes calldata params,
        uint16 referralCode
    ) external;

    function setUserEMode(uint8 categoryId) external;

    function getUserEMode(address user) external view returns (uint256);

    function setUserUseReserveAsCollateral(address asset, bool useAsCollateral) external;

    /// @return totalCollateralBase  collateral value in oracle base currency (USD, 8 decimals)
    /// @return totalDebtBase        debt value in oracle base currency
    /// @return availableBorrowsBase remaining borrow capacity in base currency
    /// @return currentLiquidationThreshold weighted liquidation threshold (bps)
    /// @return ltv                  weighted LTV (bps)
    /// @return healthFactor         1e18-scaled health factor (type(uint256).max when no debt)
    function getUserAccountData(address user)
        external
        view
        returns (
            uint256 totalCollateralBase,
            uint256 totalDebtBase,
            uint256 availableBorrowsBase,
            uint256 currentLiquidationThreshold,
            uint256 ltv,
            uint256 healthFactor
        );

    function getReserveAToken(address asset) external view returns (address);

    function getReserveVariableDebtToken(address asset) external view returns (address);

    function FLASHLOAN_PREMIUM_TOTAL() external view returns (uint128);

    function ADDRESSES_PROVIDER() external view returns (address);
}
