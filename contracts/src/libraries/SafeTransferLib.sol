// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "../interfaces/IERC20.sol";

/// @notice Tiny safe-transfer helpers. Tolerates tokens that return no bool (e.g. USDT-style)
///         and tokens that require the allowance to be zeroed before being changed.
library SafeTransferLib {
    error TransferFailed(address token);
    error ApproveFailed(address token);

    function safeTransfer(address token, address to, uint256 amount) internal {
        (bool ok, bytes memory data) = token.call(abi.encodeCall(IERC20.transfer, (to, amount)));
        if (!_succeeded(token, ok, data)) revert TransferFailed(token);
    }

    function safeTransferFrom(address token, address from, address to, uint256 amount) internal {
        (bool ok, bytes memory data) = token.call(abi.encodeCall(IERC20.transferFrom, (from, to, amount)));
        if (!_succeeded(token, ok, data)) revert TransferFailed(token);
    }

    /// @dev Sets an exact allowance. If the plain approve fails (USDT-style "must be 0 first"),
    ///      reset to zero and retry.
    function safeApprove(address token, address spender, uint256 amount) internal {
        (bool ok, bytes memory data) = token.call(abi.encodeCall(IERC20.approve, (spender, amount)));
        if (_succeeded(token, ok, data)) return;
        (ok, data) = token.call(abi.encodeCall(IERC20.approve, (spender, 0)));
        if (!_succeeded(token, ok, data)) revert ApproveFailed(token);
        (ok, data) = token.call(abi.encodeCall(IERC20.approve, (spender, amount)));
        if (!_succeeded(token, ok, data)) revert ApproveFailed(token);
    }

    /// @dev A call succeeded if it did not revert and either returned nothing (from a contract)
    ///      or returned an ABI-encoded `true`.
    ///      Calls to addresses without code "succeed" at the EVM level, so that case is rejected.
    function _succeeded(address token, bool ok, bytes memory data) private view returns (bool) {
        if (!ok) return false;
        if (data.length == 0) return token.code.length > 0;
        return data.length >= 32 && abi.decode(data, (bool));
    }
}
