import { parseAbi } from "viem";

export const erc20Abi = parseAbi([
  "function symbol() view returns (string)",
  "function decimals() view returns (uint8)",
  "function balanceOf(address) view returns (uint256)",
  "function allowance(address owner, address spender) view returns (uint256)",
  "function approve(address spender, uint256 amount) returns (bool)",
  "function transfer(address to, uint256 amount) returns (bool)",
]);

export const wethAbi = parseAbi(["function deposit() payable", "function withdraw(uint256)"]);

export const aavePoolAbi = parseAbi([
  "function getReservesList() view returns (address[])",
  "function getReserveData(address asset) view returns ((uint256 configuration,uint128 liquidityIndex,uint128 currentLiquidityRate,uint128 variableBorrowIndex,uint128 currentVariableBorrowRate,uint128 currentStableBorrowRate,uint40 lastUpdateTimestamp,uint16 id,address aTokenAddress,address stableDebtTokenAddress,address variableDebtTokenAddress,address interestRateStrategyAddress,uint128 accruedToTreasury,uint128 unbacked,uint128 isolationModeTotalDebt))",
  "function getUserAccountData(address user) view returns (uint256 totalCollateralBase,uint256 totalDebtBase,uint256 availableBorrowsBase,uint256 currentLiquidationThreshold,uint256 ltv,uint256 healthFactor)",
  "function getUserEMode(address user) view returns (uint256)",
  "function getEModeCategoryLabel(uint8 id) view returns (string)",
  "function getEModeCategoryCollateralConfig(uint8 id) view returns ((uint16 ltv,uint16 liquidationThreshold,uint16 liquidationBonus))",
  "function getEModeCategoryCollateralBitmap(uint8 id) view returns (uint128)",
  "function getEModeCategoryBorrowableBitmap(uint8 id) view returns (uint128)",
  "function supply(address asset,uint256 amount,address onBehalfOf,uint16 referralCode)",
  "function withdraw(address asset,uint256 amount,address to) returns (uint256)",
  "function borrow(address asset,uint256 amount,uint256 interestRateMode,uint16 referralCode,address onBehalfOf)",
  "function repay(address asset,uint256 amount,uint256 interestRateMode,address onBehalfOf) returns (uint256)",
  "function setUserEMode(uint8 categoryId)",
  "function setUserUseReserveAsCollateral(address asset,bool useAsCollateral)",
]);

export const aaveDataProviderAbi = parseAbi([
  "function getReserveConfigurationData(address asset) view returns (uint256 decimals,uint256 ltv,uint256 liquidationThreshold,uint256 liquidationBonus,uint256 reserveFactor,bool usageAsCollateralEnabled,bool borrowingEnabled,bool stableBorrowRateEnabled,bool isActive,bool isFrozen)",
  "function getReserveData(address asset) view returns (uint256 unbacked,uint256 accruedToTreasuryScaled,uint256 totalAToken,uint256 totalStableDebt,uint256 totalVariableDebt,uint256 liquidityRate,uint256 variableBorrowRate,uint256 stableBorrowRate,uint256 averageStableBorrowRate,uint256 liquidityIndex,uint256 variableBorrowIndex,uint40 lastUpdateTimestamp)",
  "function getReserveCaps(address asset) view returns (uint256 borrowCap,uint256 supplyCap)",
  "function getPaused(address asset) view returns (bool)",
  "function getUserReserveData(address asset,address user) view returns (uint256 currentATokenBalance,uint256 currentStableDebt,uint256 currentVariableDebt,uint256 principalStableDebt,uint256 scaledVariableDebt,uint256 stableBorrowRate,uint256 liquidityRate,uint40 stableRateLastUpdated,bool usageAsCollateralEnabled)",
]);

export const aaveOracleAbi = parseAbi([
  "function getAssetsPrices(address[] assets) view returns (uint256[])",
  "function BASE_CURRENCY_UNIT() view returns (uint256)",
]);

export const cometAbi = parseAbi([
  "function baseToken() view returns (address)",
  "function baseTokenPriceFeed() view returns (address)",
  "function getUtilization() view returns (uint256)",
  "function getSupplyRate(uint256 utilization) view returns (uint64)",
  "function getBorrowRate(uint256 utilization) view returns (uint64)",
  "function totalSupply() view returns (uint256)",
  "function totalBorrow() view returns (uint256)",
  "function decimals() view returns (uint8)",
  "function numAssets() view returns (uint8)",
  "function getAssetInfo(uint8 i) view returns ((uint8 offset,address asset,address priceFeed,uint64 scale,uint64 borrowCollateralFactor,uint64 liquidateCollateralFactor,uint64 liquidationFactor,uint128 supplyCap))",
  "function getPrice(address priceFeed) view returns (uint256)",
  "function totalsCollateral(address asset) view returns (uint128 totalSupplyAsset,uint128 _reserved)",
  "function balanceOf(address account) view returns (uint256)",
  "function borrowBalanceOf(address account) view returns (uint256)",
  "function collateralBalanceOf(address account,address asset) view returns (uint128)",
  "function supply(address asset,uint256 amount)",
  "function withdraw(address asset,uint256 amount)",
  "function isBorrowCollateralized(address account) view returns (bool)",
]);

export const uniswapQuoterAbi = parseAbi([
  "function quoteExactInputSingle((address tokenIn,address tokenOut,uint256 amountIn,uint24 fee,uint160 sqrtPriceLimitX96) params) returns (uint256 amountOut,uint160 sqrtPriceX96After,uint32 initializedTicksCrossed,uint256 gasEstimate)",
]);

export const uniswapRouterAbi = parseAbi([
  "function exactInputSingle((address tokenIn,address tokenOut,uint24 fee,address recipient,uint256 amountIn,uint256 amountOutMinimum,uint160 sqrtPriceLimitX96) params) payable returns (uint256 amountOut)",
]);

export const uniswapFactoryAbi = parseAbi([
  "function getPool(address tokenA,address tokenB,uint24 fee) view returns (address)",
]);

export const uniswapPoolAbi = parseAbi(["function liquidity() view returns (uint128)"]);

export const gmxReaderAbi = parseAbi([
  "function getAccountPositions(address dataStore,address account,uint256 start,uint256 end) view returns (((address account,address market,address collateralToken) addresses,(uint256 sizeInUsd,uint256 sizeInTokens,uint256 collateralAmount,int256 pendingImpactAmount,uint256 borrowingFactor,uint256 fundingFeeAmountPerSize,uint256 longTokenClaimableFundingAmountPerSize,uint256 shortTokenClaimableFundingAmountPerSize,uint256 increasedAtTime,uint256 decreasedAtTime) numbers,(bool isLong) flags)[])",
]);

export const gmxExchangeRouterAbi = parseAbi([
  "function multicall(bytes[] data) payable returns (bytes[] results)",
  "function sendWnt(address receiver, uint256 amount) payable",
  "function sendTokens(address token, address receiver, uint256 amount) payable",
  "function createOrder(((address receiver,address cancellationReceiver,address callbackContract,address uiFeeReceiver,address market,address initialCollateralToken,address[] swapPath) addresses,(uint256 sizeDeltaUsd,uint256 initialCollateralDeltaAmount,uint256 triggerPrice,uint256 acceptablePrice,uint256 executionFee,uint256 callbackGasLimit,uint256 minOutputAmount,uint256 validFromTime) numbers,uint8 orderType,uint8 decreasePositionSwapType,bool isLong,bool shouldUnwrapNativeToken,bool autoCancel,bytes32 referralCode,bytes32[] dataList) params) payable returns (bytes32 key)",
]);
