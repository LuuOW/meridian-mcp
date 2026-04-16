---
name: security-audit
description: Smart contract security auditing authority — reentrancy, flash loan attacks, oracle manipulation, access control vulnerabilities, integer overflow/underflow, front-running, signature replay, proxy storage collisions, static analysis with Slither and Mythril, fuzz testing with Echidna, and professional audit report writing
orb_class: moon
keywords: ["security-audit", "reentrancy", "flash-loan", "oracle-manipulation", "access-control", "integer-overflow", "front-running", "mev", "signature-replay", "proxy-collision", "slither", "mythril", "echidna", "fuzzing", "invariant", "audit-report", "smart-contract-security", "evm-security", "delegatecall", "selfdestruct"]
---

# Security Audit

Production authority on smart contract security: identifying, exploiting, and remediating the full taxonomy of EVM vulnerabilities. Covers manual review methodology, static analysis tooling, fuzz-based invariant testing, and professional audit report structure. Use this skill when auditing a contract, reviewing a PR for security issues, or building security tooling.

## Core Concepts

### Audit Methodology

A systematic audit follows four phases: (1) scope and threat modeling, (2) automated analysis, (3) manual line-by-line review, (4) report drafting. Never start with automated tools alone — they miss business logic bugs that are the most expensive class of exploit.

**Threat modeling questions**: Who calls each function? What invariants must always hold? What is the economic value at risk per function? Can any state transition happen out of order? What happens if any external call returns false, reverts, or re-enters?

### Reentrancy

The canonical exploit pattern. Attacker's `receive()` or `fallback()` re-enters the victim before state is updated.

```solidity
// VULNERABLE — state updated after external call
function withdraw(uint256 amount) external {
    require(balances[msg.sender] >= amount);
    (bool ok,) = msg.sender.call{value: amount}("");  // re-enters here
    require(ok);
    balances[msg.sender] -= amount;  // too late — attacker already drained
}

// FIXED — checks-effects-interactions
function withdraw(uint256 amount) external nonReentrant {
    require(balances[msg.sender] >= amount);
    balances[msg.sender] -= amount;  // effect first
    (bool ok,) = msg.sender.call{value: amount}("");  // interaction last
    require(ok);
}
```

Cross-function reentrancy: `nonReentrant` on `withdraw` does not protect `harvest()` if both read `balances`. Apply `nonReentrant` to every entry point that touches shared state. Read-only reentrancy (Curve bug 2023): a view function called mid-execution sees inconsistent state — lock views during state transitions for protocols others integrate with.

### Flash Loan Attacks

Flash loans let attackers borrow any amount atomically. Any invariant that assumes "token balance reflects legitimate deposits" is broken. Classic pattern: borrow 100M USDC, manipulate spot price in a low-liquidity pool, exploit a protocol that reads that price as an oracle, repay, profit.

```solidity
// VULNERABLE oracle
function getPrice() external view returns (uint256) {
    (uint112 r0, uint112 r1,) = pair.getReserves();
    return uint256(r1) * 1e18 / uint256(r0);  // spot price — manipulable
}

// FIXED — use TWAP
function getPrice() external view returns (uint256) {
    uint32[] memory secondsAgos = new uint32[](2);
    secondsAgos[0] = 1800;  // 30 minutes ago
    secondsAgos[1] = 0;
    (int56[] memory tickCumulatives,) = pool.observe(secondsAgos);
    int56 tickDiff = tickCumulatives[1] - tickCumulatives[0];
    int24 avgTick = int24(tickDiff / 1800);
    return TickMath.getSqrtRatioAtTick(avgTick);  // TWAP price
}
```

Chainlink oracle pitfalls: stale price (always check `updatedAt` vs `block.timestamp`), L2 sequencer uptime (use `sequencerUptimeFeed`), circuit breaker (check `answeredInRound >= roundId`).

### Access Control

```solidity
// VULNERABLE — no access control on initialize (proxy pattern)
function initialize(address admin) external {
    _admin = admin;  // anyone can call this on a freshly deployed proxy
}

// VULNERABLE — tx.origin auth (phishing attacks bypass this)
modifier onlyOwner() {
    require(tx.origin == owner);  // WRONG: use msg.sender
    _;
}

// VULNERABLE — missing access control on sensitive setter
function setOracle(address newOracle) external {
    oracle = newOracle;  // any EOA can point oracle to attacker-controlled contract
}
```

Common access control bugs: unprotected `initialize` on upgradeable proxies (Parity wallet hack pattern), missing role validation on admin functions, `tx.origin` instead of `msg.sender`, overly permissive roles (single `ADMIN` role that can do everything — should be OPERATOR / PAUSER / UPGRADER separate roles).

### Integer Overflow / Underflow

Solidity 0.8+ has built-in overflow checks. Pre-0.8 code and `unchecked {}` blocks are still vulnerable.

```solidity
// In unchecked block — wraps silently
unchecked {
    uint256 userBalance = 0;
    userBalance -= 1;  // wraps to 2^256 - 1 — attacker becomes richest user
}

// Gotcha: casting can truncate
uint256 bigValue = 2**128 + 5;
uint128 truncated = uint128(bigValue);  // == 5, silently loses upper bits
// Fix: use SafeCast
import {SafeCast} from "@openzeppelin/contracts/utils/math/SafeCast.sol";
uint128 safe = SafeCast.toUint128(bigValue);  // reverts if out of range
```

### Front-Running and MEV

Front-running occurs when a pending transaction in the mempool is observed and a higher-gas transaction is inserted before it. Relevant for: DEX trades (sandwich attacks), NFT mints at fixed price, liquidations, oracle updates.

Mitigations:
- **Commit-reveal**: hash the action in tx1, reveal in tx2 after a block delay.
- **Slippage parameters**: `amountOutMin` on every swap — a sandwiched trade will fail if output is below minimum.
- **Private mempool**: use Flashbots Protect RPC or MEV Blocker for sensitive transactions.
- **Dutch auctions**: for token launches, descending price removes the advantage of going first.

```solidity
// Commit-reveal for fair lottery
mapping(bytes32 => address) public commits;

function commit(bytes32 hash) external {
    commits[hash] = msg.sender;
}

function reveal(uint256 nonce, string calldata choice) external {
    bytes32 hash = keccak256(abi.encodePacked(nonce, choice, msg.sender));
    require(commits[hash] == msg.sender, "invalid commit");
    delete commits[hash];
    // process revealed choice
}
```

### Signature Replay

Signed messages must include: chain ID, contract address, nonce, and expiry. Missing any one field enables replay on another chain, another contract, or the same action twice.

```solidity
// EIP-712 structured data hashing — replay-resistant
bytes32 public constant PERMIT_TYPEHASH = keccak256(
    "Permit(address owner,address spender,uint256 value,uint256 nonce,uint256 deadline)"
);

function _hashPermit(address owner, address spender, uint256 value,
                     uint256 nonce, uint256 deadline) internal view returns (bytes32) {
    return _hashTypedDataV4(keccak256(abi.encode(
        PERMIT_TYPEHASH, owner, spender, value, nonce, deadline
    )));
}

// Always burn the nonce after use
function permit(address owner, address spender, uint256 value,
                uint256 deadline, uint8 v, bytes32 r, bytes32 s) external {
    require(block.timestamp <= deadline, "expired");
    bytes32 hash = _hashPermit(owner, spender, value, _nonces[owner]++, deadline);
    require(owner == ECDSA.recover(hash, v, r, s), "invalid sig");
    _approve(owner, spender, value);
}
```

### Proxy Storage Collisions

In `delegatecall` proxy patterns, the proxy and implementation share storage layout by slot position, not by variable name. Adding a variable in the proxy that occupies slot 0 will corrupt the implementation's slot-0 variable.

```
Transparent Proxy storage layout:
Slot 0: _implementation  (proxy's ERC1967 slot)
Slot 1: _admin

Implementation storage layout:
Slot 0: owner           ← COLLISION if implementation and proxy both declare slot-0 vars
Slot 1: balance
```

EIP-1967 fixes this by using pseudo-random slots (`keccak256("eip1967.proxy.implementation") - 1`). OpenZeppelin's UUPS and TransparentUpgradeableProxy use EIP-1967. Never inherit from the proxy contract in the implementation.

Storage collision in upgrades: appending new state variables is safe; inserting or reordering existing variables is catastrophic. Use storage gap patterns: `uint256[50] private __gap;` at the end of every upgradeable base contract.

### Static Analysis Tooling

```bash
# Slither — fastest, highest true-positive rate
pip install slither-analyzer
slither . --config-file slither.config.json --checklist
slither . --detect reentrancy-eth,unprotected-upgrade,arbitrary-send-eth

# Mythril — symbolic execution, finds deeper logic bugs but slower
pip install mythril
myth analyze src/Contract.sol --solc-version 0.8.24 --execution-timeout 90

# Echidna — property-based fuzzer
# Install via binary or Docker
echidna . --contract VaultTest --config echidna.yaml --test-mode assertion
```

Echidna property test pattern:
```solidity
contract VaultEchidna is Vault {
    address internal constant USER = address(0x10000);

    // Invariant: total assets >= total shares (no rounding loss)
    function echidna_assets_gte_shares() public view returns (bool) {
        return totalAssets() >= totalSupply();
    }

    // Invariant: no one can drain more than they deposited
    function echidna_no_free_withdrawal() public returns (bool) {
        uint256 before = asset.balanceOf(USER);
        vm.prank(USER);
        try this.withdraw(type(uint256).max, USER, USER) {} catch {}
        return asset.balanceOf(USER) <= before + deposited[USER];
    }
}
```

### Audit Report Structure

A professional finding has five fields: **Title** (specific, not "reentrancy"), **Severity** (Critical/High/Medium/Low/Informational using CVSS-inspired: impact × likelihood), **Description** (what the bug is, which lines, the attack path), **Proof of Concept** (working exploit or PoC test), **Recommendation** (specific code fix, not "add access control").

Severity tiers:
- **Critical**: direct loss of funds, governance takeover, permanent DoS. CVSS ≥ 9.0.
- **High**: indirect loss, requires specific conditions but realistic. CVSS 7.0-8.9.
- **Medium**: griefing, temporary DoS, centralization risk. CVSS 4.0-6.9.
- **Low**: best practice violation, unlikely loss path. CVSS < 4.0.
- **Informational**: gas optimizations, code clarity, NatSpec gaps.

Always provide a diff showing the fix, not just prose. Always re-test the fix — "acknowledged" findings with an inadequate fix are a common source of second-audit exploits.
