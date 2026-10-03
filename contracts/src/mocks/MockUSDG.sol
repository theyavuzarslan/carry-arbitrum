// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

/// @title MockUSDG
/// @notice TESTNET ONLY. A 6-decimal stand-in for Paxos USDG with an open `mint`, used as a fallback
///         when the deployer cannot get real testnet USDG from the Paxos faucet. Worthless by design.
contract MockUSDG is ERC20 {
    constructor() ERC20("Mock USDG (testnet, no value)", "mUSDG") {}

    function decimals() public pure override returns (uint8) {
        return 6;
    }

    /// @notice Anyone can mint. Never deploy on a mainnet.
    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }
}
