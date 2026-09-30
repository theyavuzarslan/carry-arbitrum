// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {CarryAccount} from "./CarryAccount.sol";
import {IPool} from "./interfaces/IPool.sol";
import {IAaveOracle} from "./interfaces/IAaveOracle.sol";
import {ISwapRouter02} from "./interfaces/ISwapRouter02.sol";

/// @title CarryAccountFactory
/// @notice Deploys one CarryAccount per user, wired to a fixed Aave Pool / oracle / Uniswap router.
contract CarryAccountFactory {
    IPool public immutable POOL;
    IAaveOracle public immutable ORACLE;
    ISwapRouter02 public immutable ROUTER;

    /// @notice user => their CarryAccount (zero if none yet)
    mapping(address => address) public accountOf;

    event AccountCreated(address indexed owner, address indexed account);

    error AccountExists(address account);

    constructor(IPool _pool, IAaveOracle _oracle, ISwapRouter02 _router) {
        POOL = _pool;
        ORACLE = _oracle;
        ROUTER = _router;
    }

    /// @notice Deploy a CarryAccount owned by msg.sender. One account per address.
    function createAccount() external returns (address account) {
        if (accountOf[msg.sender] != address(0)) revert AccountExists(accountOf[msg.sender]);
        account = address(new CarryAccount(msg.sender, POOL, ORACLE, ROUTER));
        accountOf[msg.sender] = account;
        emit AccountCreated(msg.sender, account);
    }
}
