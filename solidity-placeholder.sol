// SPDX-License-Identifier: MIT
pragma solidity ^0.8.0;

import "@aave/protocol-v2/contracts/flashloan/base/FlashLoanReceiverBase.sol";
import "@aave/protocol-v2/contracts/interfaces/ILendingPoolAddressesProvider.sol";
import "@uniswap/v2-periphery/contracts/interfaces/IUniswapV2Router02.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";

contract FlashLoanArbitrage is FlashLoanReceiverBase {
    address private owner;
    IUniswapV2Router02 private uniswapRouter;

    constructor(address _addressProvider, address _uniswapRouter) FlashLoanReceiverBase(ILendingPoolAddressesProvider(_addressProvider)) {
        owner = msg.sender;
        uniswapRouter = IUniswapV2Router02(_uniswapRouter);
    }

    modifier onlyOwner() {
        require(msg.sender == owner, "Caller is not the owner");
        _;
    }

    function executeOperation(
        address[] calldata assets,
        uint256[] calldata amounts,
        uint256[] calldata premiums,
        address initiator,
        bytes calldata params
    ) external override returns (bool) {
        // Decode parameters and execute arbitrage trades
        (address dex1, address dex2, uint256 amount) = abi.decode(params, (address, address, uint256));

        // Approve tokens for trading on DEXs
        IERC20(assets[0]).approve(address(uniswapRouter), amounts[0]);

        // Implement arbitrage trading logic
        // Example: swap tokens on dex1 and dex2 and calculate profit

        // Repay the flash loan
        uint256 totalDebt = amounts[0] + premiums[0];
        IERC20(assets[0]).transferFrom(initiator, address(this), totalDebt);
        IERC20(assets[0]).approve(address(LENDING_POOL), totalDebt);

        return true;
    }

    function requestFlashLoan(address token, uint256 amount, address dex1, address dex2) external onlyOwner {
        address receiverAddress = address(this);
        address onBehalfOf = address(this);
        bytes memory params = abi.encode(dex1, dex2, amount);
        uint16 referralCode = 0;

        address[] memory assets = new address[](1);
        assets[0] = token;

        uint256[] memory amounts = new uint256[](1);
        amounts[0] = amount;

        uint256[] memory modes = new uint256[](1);
        modes[0] = 0;

        LENDING_POOL.flashLoan(receiverAddress, assets, amounts, modes, onBehalfOf, params, referralCode);
    }

    function withdraw(address token) external onlyOwner {
        uint256 balance = IERC20(token).balanceOf(address(this));
        require(balance > 0, "No balance to withdraw");
        IERC20(token).transfer(owner, balance);
    }
}
