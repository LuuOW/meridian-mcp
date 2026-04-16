---
name: tokenomics
description: Token economic design authority — supply schedules, emission curves, vesting and cliff structures, bonding curves, liquidity bootstrapping pools, governance token design, veToken and vote-escrowed models, staking reward mechanics, token sink design, incentive alignment analysis, and Gini coefficient distribution analysis for crypto protocols
orb_class: moon
keywords: ["tokenomics", "emission-curve", "vesting", "bonding-curve", "liquidity-bootstrapping", "lbp", "vetoken", "ve-model", "staking", "token-sink", "governance", "inflation", "supply-schedule", "incentive-alignment", "gini-coefficient", "flywheel", "protocol-owned-liquidity", "pol", "curve-wars", "gauge-voting"]
---

# Tokenomics

Deep authority on token economic system design for crypto protocols: supply and emission modeling, vesting structures, bonding curves, liquidity bootstrapping, veToken governance models, staking mechanics, and incentive alignment. Use this skill when designing, analyzing, or auditing the economic layer of a blockchain protocol or DeFi application.

## Core Concepts

### Supply Schedule Design

A supply schedule answers: how many tokens exist at time T, and who controls them? The four canonical allocations are team/advisors (10-20%), investors (15-25%), ecosystem/treasury (30-40%), and community/public (20-40%). Every allocation should have explicit vesting.

```python
import numpy as np
import matplotlib.pyplot as plt

def emission_schedule(months: int, initial_supply: float, target_supply: float,
                      decay_rate: float) -> np.ndarray:
    """Exponential decay emission — common for DeFi protocols."""
    t = np.arange(months)
    # Monthly emission decays geometrically
    monthly_emission = (target_supply - initial_supply) * (1 - decay_rate) * (decay_rate ** t)
    cumulative = initial_supply + np.cumsum(monthly_emission)
    return np.clip(cumulative, 0, target_supply)

# Curve-style: 43% emitted in year 1, halving roughly annually
supply = emission_schedule(months=60, initial_supply=0,
                           target_supply=1_000_000_000, decay_rate=0.85)
```

Key design tension: high early emissions bootstrap liquidity and users but create sell pressure. Low emissions reduce inflation but fail to attract liquidity miners. Common solution: front-load ecosystem incentives, back-load team/investor unlocks.

### Vesting and Cliff Structures

Standard venture-backed token vesting: 12-month cliff, 36-month linear vest. On-chain enforcement via `VestingWallet` (OpenZeppelin) or custom schedules.

```solidity
// Solidity vesting with cliff
contract TokenVesting {
    struct Grant {
        uint128 total;
        uint128 released;
        uint64  start;
        uint64  cliff;    // seconds after start before any tokens unlock
        uint64  duration; // total vest duration in seconds
    }

    mapping(address => Grant) public grants;

    function releasable(address beneficiary) public view returns (uint256) {
        Grant memory g = grants[beneficiary];
        if (block.timestamp < g.start + g.cliff) return 0;
        uint256 elapsed = block.timestamp - g.start;
        uint256 vested = elapsed >= g.duration
            ? g.total
            : (uint256(g.total) * elapsed) / g.duration;
        return vested - g.released;
    }
}
```

Gotchas: token price at cliff unlock creates cliff-sell events. Stagger cliffs across team members by 30-60 days to reduce synchronized sell pressure. Consider release tranches instead of linear: 25% at cliff, 25% at 18mo, 25% at 24mo, 25% at 36mo — aligns team incentives with protocol milestones.

### Bonding Curves

A bonding curve is an automated market maker between a token and a reserve asset, where price is a deterministic function of supply. Used for continuous token models, curation markets, and protocol-owned liquidity.

```python
# Bancor-style bonding curve
# Price = Reserve / (Supply * CRR)
# where CRR = Constant Reserve Ratio (0 < CRR ≤ 1)

def bancor_price(reserve: float, supply: float, crr: float) -> float:
    return reserve / (supply * crr)

def bancor_buy(reserve: float, supply: float, crr: float,
               deposit: float) -> tuple[float, float]:
    """Returns (tokens_minted, new_price)"""
    new_supply = supply * ((1 + deposit / reserve) ** crr)
    tokens = new_supply - supply
    new_price = (reserve + deposit) / (new_supply * crr)
    return tokens, new_price

# Linear bonding curve: price = m * supply + b
# Simple, transparent, but no reserve ratio — issuer takes all proceeds
def linear_price(supply: float, m: float = 0.001, b: float = 0.01) -> float:
    return m * supply + b

def linear_buy_cost(supply: float, amount: float, m: float = 0.001, b: float = 0.01) -> float:
    """Integral of linear price from supply to supply+amount"""
    return m * supply * amount + 0.5 * m * amount**2 + b * amount
```

Key bonding curve risks: front-running on buy transactions (use commit-reveal or slippage limits), rug risk if the issuer can drain the reserve, and reflexivity (falling price drains reserve, lowering price further).

### Liquidity Bootstrapping Pools (LBP)

LBPs (Balancer) start with a high token weight (e.g., 96% token / 4% USDC) that decays to an equilibrium (50/50) over 3-7 days. This creates natural downward price pressure that discourages bots and whales from front-running the launch, since buying early inflates prices that will mechanically fall.

```python
def lbp_spot_price(token_balance: float, token_weight: float,
                   usdc_balance: float, usdc_weight: float,
                   swap_fee: float = 0.001) -> float:
    """Balancer spot price formula."""
    return (token_balance / token_weight) / (usdc_balance / usdc_weight) / (1 - swap_fee)

# Day 0: weights = (0.96, 0.04) → artificially high token price
# Day 7: weights = (0.50, 0.50) → market-discovered price
```

LBP is not a yield mechanism — it is a price discovery and fair launch tool. Advise against using LBPs for secondary liquidity.

### veToken (Vote-Escrowed) Model

Pioneered by Curve Finance (veCRV). Users lock tokens for up to 4 years, receiving voting power proportional to `amount × (remaining_lock / max_lock)`. Locked tokens earn boosted rewards and gauge voting rights.

```
veBalance(user) = locked_amount × (time_remaining / MAX_LOCK)
MAX_LOCK = 4 years = 126,144,000 seconds

Boost multiplier (Curve): min(2.5, 0.4 + 0.6 × (user_veBalance / total_veSupply) × (pool_liquidity / user_liquidity))
```

The veToken flywheel: protocols bribe veCRV holders (via Votium, Hidden Hand) to direct CRV emissions to their pool. This creates the "Curve Wars" — protocols accumulate veCRV to reduce their own borrowing cost. Convex Finance (cvxCRV) abstracts this by pooling individual locks.

Design considerations for new veToken systems:
- **Lock length vs. liquidity**: long max locks (4yr) concentrate power among early whales. Consider shorter locks (6-12mo) for broader participation.
- **Non-transferability**: veTokens must be non-transferable to prevent vote market formation outside your control.
- **Decay mechanism**: voting power decays linearly to zero at lock expiry. Users must re-lock to maintain influence — creates regular check-in pressure.

### Token Sinks

Emission without sinks is inflation. Sinks are mechanisms that permanently or temporarily remove tokens from circulating supply:

| Sink Type | Example | Permanence |
|-----------|---------|------------|
| Burn on use | BNB gas fee burn | Permanent |
| Protocol fee buyback+burn | GMX ETH fees → GLP | Permanent |
| Lock (veToken) | veCRV locks | Temporary |
| Staking with unbonding | Cosmos chains | Temporary |
| NFT minting cost | Land sales | Permanent |
| Governance deposit | Proposal bonds | Temporary |

A healthy protocol should have measurable deflation or supply equilibrium at maturity. Model sink velocity: `net_inflation_rate = emission_rate - sink_rate`. If sink_rate < emission_rate at any protocol maturity state, you have a structural sell-pressure problem.

### Gini Coefficient and Distribution Analysis

Gini coefficient measures token concentration inequality (0 = perfect equality, 1 = one holder owns everything). A Gini > 0.8 at launch is a governance security risk (single entity can pass any proposal).

```python
import numpy as np

def gini(balances: np.ndarray) -> float:
    """Compute Gini coefficient from array of token balances."""
    balances = np.sort(balances[balances > 0])
    n = len(balances)
    cumulative = np.cumsum(balances)
    return (2 * np.sum((np.arange(1, n+1) * balances)) - (n + 1) * cumulative[-1]) / (n * cumulative[-1])

# On-chain: query top-1000 holders from Etherscan API or Dune Analytics
# Check: top-10 holder concentration (should be < 40% for decentralized governance)
# Check: DAO treasury vs circulating supply ratio
```

Governance attack threshold: an attacker needs >50% of voting power for a simple majority or >33% to veto on many governance systems. Model the cost-of-attack at different token prices. If a governance attack costs less than the treasury value, the protocol is economically exploitable.

### Incentive Alignment Checklist

- [ ] Team vesting is longer than investor vesting (skin in the game)
- [ ] Emission schedule peaks before product-market fit is expected (not after)
- [ ] Protocol fee switch routes revenue to long-term holders (stakers/veHolders), not market sellers
- [ ] Token utility is required (not optional) for protocol use — creates genuine demand
- [ ] Treasury has ≥ 24 months of runway at current burn rate
- [ ] Governance quorum threshold is achievable with realistic participation (< 10% of circulating supply)
- [ ] Sink mechanisms are modeled at 1x, 5x, and 10x protocol growth — do they scale?
- [ ] Top-10 holder concentration < 40%
- [ ] No single entity controls > 15% of governance votes at launch
