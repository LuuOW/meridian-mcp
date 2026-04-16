---
name: solidity
description: Solidity smart-contract authoring authority — ERC20/ERC721/ERC1155 token standards, reentrancy guards, access control, gas optimisation, upgradeable proxies, Foundry testing, fuzzing, invariant checks, and production contract security for EVM chains
---

# solidity

Production smart-contract authoring for EVM chains. Covers the full contract lifecycle: standards compliance, security patterns, gas optimisation, testing with Foundry, and deployment hardening.

## Contract Structure

```solidity
// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";

contract FlashloanArb is ReentrancyGuard, Ownable {
    using SafeERC20 for IERC20;

    error InsufficientProfit(uint256 expected, uint256 got);
    error UnauthorizedCaller(address caller);

    event ArbExecuted(address indexed asset, uint256 profit, uint256 gasUsed);

    address public immutable POOL;       // Aave V3 Pool
    address public immutable ROUTER;     // Swap router

    constructor(address _pool, address _router) Ownable(msg.sender) {
        POOL   = _pool;
        ROUTER = _router;
    }

    modifier onlyPool() {
        if (msg.sender != POOL) revert UnauthorizedCaller(msg.sender);
        _;
    }
}
```

## Access Control Patterns

Prefer role-based over owner-only for anything beyond toy contracts.

```solidity
import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";

contract Treasury is AccessControl {
    bytes32 public constant OPERATOR = keccak256("OPERATOR");
    bytes32 public constant EMERGENCY = keccak256("EMERGENCY");

    constructor(address admin) {
        _grantRole(DEFAULT_ADMIN_ROLE, admin);
    }

    function withdraw(address to, uint256 amount) external onlyRole(OPERATOR) { /*...*/ }
    function pause()                              external onlyRole(EMERGENCY) { /*...*/ }
}
```

## Reentrancy Defence

The 2016 DAO hack is still the most common class of exploit. Follow checks-effects-interactions, use `ReentrancyGuard` on every external-facing state-mutating function that calls untrusted addresses.

```solidity
function withdraw(uint256 amount) external nonReentrant {
    // Checks
    require(balances[msg.sender] >= amount, "insufficient");
    // Effects
    balances[msg.sender] -= amount;
    // Interactions (external call LAST)
    (bool ok, ) = msg.sender.call{value: amount}("");
    require(ok, "transfer failed");
}
```

Cross-function reentrancy: separate `nonReentrant` on every entry point that reads the same state. ERC777 hooks can re-enter even on ERC20-looking functions.

## Gas Optimisation

```solidity
// 1. Pack storage slots — uint128 + uint128 = 1 slot, not 2
struct Position { uint128 amount; uint128 lastUpdated; }

// 2. Use 'immutable' for set-once constructor values (SLOAD → compile-time const)
address public immutable TOKEN;

// 3. Cache storage reads into memory when looping
function distribute() external {
    uint256 len = recipients.length;           // SLOAD once
    for (uint256 i; i < len; ++i) { /*...*/ }  // increment in unchecked block
}

// 4. Custom errors over require strings (saves ~50 gas + bytecode)
error InsufficientBalance(uint256 have, uint256 want);
if (bal < want) revert InsufficientBalance(bal, want);

// 5. Unchecked arithmetic where overflow impossible
unchecked { ++i; }
```

## Foundry Testing

```solidity
// test/FlashArb.t.sol
pragma solidity ^0.8.24;
import {Test} from "forge-std/Test.sol";
import {FlashloanArb} from "../src/FlashloanArb.sol";

contract FlashArbTest is Test {
    FlashloanArb arb;
    address constant USDC = 0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913; // Base USDC

    function setUp() public {
        vm.createSelectFork(vm.envString("BASE_RPC"), 18_000_000);
        arb = new FlashloanArb(POOL, ROUTER);
    }

    function test_Arb_ProfitableRound() public {
        uint256 balBefore = IERC20(USDC).balanceOf(address(this));
        arb.execute(USDC, 10_000e6, buildPath());
        assertGt(IERC20(USDC).balanceOf(address(this)), balBefore, "no profit");
    }

    function testFuzz_Arb_NeverLosesPrincipal(uint256 amount) public {
        amount = bound(amount, 1000e6, 1_000_000e6);
        uint256 balBefore = IERC20(USDC).balanceOf(address(this));
        try arb.execute(USDC, amount, buildPath()) {
            assertGe(IERC20(USDC).balanceOf(address(this)), balBefore);
        } catch {}  // revert is fine; loss is not
    }
}
```

Run: `forge test --fork-url $BASE_RPC -vvv`. Use `--gas-report` for gas regression tracking.

## Invariant Testing

Fuzzing state over many random transactions to check that invariants never break.

```solidity
contract ArbInvariant is Test {
    function invariant_ContractNeverLosesPrincipal() public {
        assertGe(IERC20(USDC).balanceOf(address(arb)), INITIAL_DEPOSIT);
    }
    function invariant_OnlyOwnerCanWithdraw() public {
        // ...
    }
}
```

## Upgradeable Proxies

UUPS or Transparent proxy pattern. Storage layout is immutable across upgrades — adding a field in the middle of a struct breaks everything.

```solidity
import {UUPSUpgradeable} from "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";
import {Initializable} from "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";

contract VaultV1 is Initializable, UUPSUpgradeable, AccessControlUpgradeable {
    function initialize(address admin) public initializer {
        __AccessControl_init();
        _grantRole(DEFAULT_ADMIN_ROLE, admin);
    }
    function _authorizeUpgrade(address) internal override onlyRole(DEFAULT_ADMIN_ROLE) {}
}
```

## Security Checklist

- [ ] Slither static-analysis clean: `slither .`
- [ ] Foundry fuzz tests pass with 10k+ runs: `forge test --fuzz-runs 10000`
- [ ] Invariant tests pass: `forge test --match-test invariant_`
- [ ] Mainnet fork tests cover the exact block where you'll deploy
- [ ] No `tx.origin` for auth — always `msg.sender`
- [ ] No `delegatecall` to untrusted code
- [ ] SafeERC20 for ALL transfers (USDT doesn't return bool from `transfer`)
- [ ] Pull-over-push pattern for payouts (user withdraws, not contract pushes)
- [ ] Reentrancy guards on every state-mutating external call
- [ ] Oracle price sanity checks (reject if >N% deviation from TWAP)
- [ ] Pausable with separate EMERGENCY role
- [ ] Verified on block explorer with source match
