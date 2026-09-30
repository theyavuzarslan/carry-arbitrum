// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @notice Aave v3 price oracle. Prices are in the base currency (USD, 8 decimals on Arbitrum).
interface IAaveOracle {
    function getAssetPrice(address asset) external view returns (uint256);
}
