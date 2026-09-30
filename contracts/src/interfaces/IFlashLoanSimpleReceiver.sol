// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @notice Callback interface for Aave v3 `flashLoanSimple`.
interface IFlashLoanSimpleReceiver {
    /// @dev Called by the Pool after it has transferred `amount` of `asset` to the receiver.
    ///      The receiver must approve the Pool to pull `amount + premium` before returning.
    function executeOperation(address asset, uint256 amount, uint256 premium, address initiator, bytes calldata params)
        external
        returns (bool);
}
