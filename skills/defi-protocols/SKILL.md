---
name: defi-protocols
description: DeFi protocol authority — flashloans, AMM design, lending markets, concentrated liquidity, MEV, triangular and cross-DEX arbitrage, stablecoin depeg dynamics, and on-chain capital routing across Uniswap V3, Aerodrome, Balancer, Curve, and Aave V3 on Ethereum, Base, Arbitrum, Optimism, and Polygon
keywords: ["defi", "protocols", "amm", "mev", "dex", "uniswap", "v3", "aerodrome", "balancer", "curve", "aave", "ethereum", "base", "arbitrum", "optimism", "polygon", "protocol", "authority", "flashloans", "design"]
orb_class: moon
---

# defi-protocols

Production DeFi routing across lending, AMMs, and arbitrage. Covers how capital moves on-chain: flashloan mechanics, AMM math, liquidity fragmentation, and the physics of price discovery across DEXes and chains.

## Flashloan Mechanics

Flashloans let you borrow uncollateralised capital for a single transaction, provided you repay with fee in the same block. Aave V3 is the dominant provider — 0.05% fee, supports all major assets.

```solidity
function executeOperation(
    address asset,
    uint256 amount,
    uint256 premium,
    address initiator,
    bytes calldata params
) external returns (bool) {
    // 1. Flashloan asset is now in this contract
    // 2. Execute arbitrage path: e.g. USDC → WETH (Uniswap) → cbETH (Aerodrome) → USDC (Curve)
    // 3. Repay amount + premium before this function returns
    IERC20(asset).approve(address(POOL), amount + premium);
    return true;
}
```

Balancer V2 offers 0-fee flashloans for pool assets — cheaper but asset-limited. Uniswap V3 has flash swaps (borrow tokenA, repay tokenB in same tx).

## Triangular Arbitrage

Three-leg price loops across DEXes exploit stale pricing on correlated assets. Classic examples: USDC/USDT/DAI, WETH/cbETH/ETH, WBTC/tBTC.

```python
# Detect a USDC → WETH → cbETH → USDC arbitrage
r1 = quote_uniswap_v3(USDC, WETH, 10_000_000_000)        # USDC → WETH
r2 = quote_aerodrome(WETH, cbETH, r1)                     # WETH → cbETH
r3 = quote_curve(cbETH, USDC, r2)                         # cbETH → USDC
profit_bps = (r3 - 10_000_000_000) * 10_000 // 10_000_000_000
```

Profit requires: `gross_bps - (2 * swap_fee_bps + flashloan_fee_bps + gas_in_bps) > threshold`. Most triangles are <5bps — sub-basis-point precision on quotes matters.

## AMM Math — Uniswap V3 Concentrated Liquidity

V3 pools expose liquidity in price ranges (ticks), not uniformly. Price is `sqrtPriceX96^2 / 2^192`. Out-of-range liquidity earns nothing; in-range liquidity earns fees but suffers impermanent loss.

```python
# Quote from a V3 pool (simplified, in-range only)
from eth_abi import decode
def quote_v3(pool, amount_in, zero_for_one):
    # Delegate to quoter contract — it simulates the swap
    result = quoter.quoteExactInputSingle(
        token_in, token_out, fee_tier, amount_in, 0
    )
    return result.amountOut
```

Fee tiers: 100 (stable pairs), 500 (correlated like WETH/cbETH), 3000 (volatile pairs), 10000 (exotic). Always quote across all tiers and pick best.

## Aerodrome / Velodrome (V-AMM + Volatile + Stable pools)

Base's main DEX. Two pool types: stable (x^3*y + y^3*x) for stablecoins and correlated pairs, volatile (x*y) for uncorrelated. Stable pools dominate Base liquidity for stablecoin arbitrage.

## MEV — Extraction and Defence

Searchers front-run public mempool arbitrages. Counter-strategies:

- **Flashbots / MEV-Share** — private transaction submission, no mempool leak
- **Private RPC** endpoints on Base / Arbitrum — builders bundle directly
- **Atomic execution** — wrap the full arb in a single contract call, revert if unprofitable

For Base specifically: CB-Sequencer's FIFO ordering plus low latency reduces but doesn't eliminate MEV. Submit via `sequencer.base.org` private RPC for best inclusion odds.

## Stablecoin Depeg Dynamics

USDC, USDT, DAI, FRAX — each has different depeg modes. USDC: custodian redemption (Circle), so hard-pegs within 1bp in normal times. USDT: no on-chain redemption, soft-peg ~10-30bps typical. DAI: Maker vault arbitrage keeps it tight.

Depeg arbitrage: when stablecoin deviates >50bps from $1, it's either a banking incident (USDC March 2023) or momentary liquidity imbalance (resolves in minutes via Curve pools).

## Cross-DEX Price Discovery

1inch Aggregation API v6 gives best execution path across 100+ sources. Use `protocols=` filter to exclude high-gas paths for small amounts.

```python
# Get best quote for USDC→WETH on Base, Uniswap-V3 + Aerodrome only
params = {
    "src":  USDC, "dst": WETH, "amount": "10000000000",
    "protocols": "BASE_UNISWAP_V3,BASE_AERODROME",
    "includeTokensInfo": "false",
}
r = requests.get("https://api.1inch.dev/swap/v6.0/8453/quote",
                 headers={"Authorization": f"Bearer {KEY}"}, params=params)
```

## Chain-Specific Notes

- **Base (8453)** — CB-Sequencer, low fees (~$0.01 per swap), Aerodrome dominant. Best chain for stablecoin triangular arb.
- **Arbitrum (42161)** — Uniswap V3 + Camelot + GMX. Medium fees.
- **Optimism (10)** — Velodrome (Aerodrome fork). Similar to Base but smaller TVL.
- **Polygon (137)** — QuickSwap + Uniswap V3. High inflation from MATIC rewards muddies some arbs.
- **Ethereum mainnet** — highest liquidity but gas makes most triangular arbs unprofitable <$100k notional.

## Production Checklist

- [ ] Flashloan path simulated off-chain before submission (fork-test with Tenderly or Foundry)
- [ ] All quotes refreshed within same block — use `eth_call` at specific block number
- [ ] Slippage bounds on every leg (reverts if quote degrades >N bps in mempool)
- [ ] Gas estimate with 20% buffer — profit calc must survive gas spike
- [ ] Private RPC or Flashbots bundle submission — never mempool for profitable arbs
- [ ] Profit in USD cleared on-chain net of gas, flashloan fee, swap fees
- [ ] Circuit breaker: halt bot if 3 consecutive reverts (quote source is stale)
