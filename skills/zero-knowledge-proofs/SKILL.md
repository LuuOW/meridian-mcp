---
name: zero-knowledge-proofs
description: Zero-knowledge proof systems authority — Groth16, PLONK, STARKs, Circom circuit authoring, snarkjs proof generation and verification, Halo2, recursive proofs, ZK-EVMs, and ZK rollup architectures including Polygon zkEVM, zkSync Era, and Starknet
orb_class: moon
keywords: ["zk", "groth16", "plonk", "stark", "circom", "snarkjs", "halo2", "recursive-proofs", "zk-evm", "zk-rollup", "polygon-zkevm", "zksync", "starknet", "noir", "prover", "verifier", "trusted-setup", "arithmetic-circuit"]
---

# Zero-Knowledge Proofs

Deep authority on ZK proof system design and implementation: circuit authoring in Circom and Halo2, proof generation and on-chain verification, system tradeoffs (Groth16 vs PLONK vs STARKs), and ZK rollup architectures. Use this skill when building ZK circuits, integrating provers into applications, or reasoning about ZK-EVM equivalence levels.

## Core Concepts

### Proof System Tradeoffs

| System | Setup | Proof Size | Verify Time | Recursive | Quantum-safe |
|--------|-------|-----------|-------------|-----------|--------------|
| Groth16 | Trusted (per-circuit) | ~200 bytes | ~1ms (on-chain ~200k gas) | With difficulty | No |
| PLONK | Trusted (universal) | ~1-2 KB | ~2ms | Yes (via IVC) | No |
| STARKs | Transparent | ~50-200 KB | ~10ms | Yes | Yes |
| Halo2 | Transparent | ~1-5 KB | Fast | Yes (accumulation) | No |

Groth16 dominates when proof size and on-chain verification cost are paramount and the circuit is stable (Tornado Cash, Semaphore). PLONK/UltraPLONK is preferred for systems needing a single trusted setup across many circuits. STARKs are mandatory when quantum resistance is required or a trusted setup is politically impossible (Starknet).

### Circom Circuit Authoring

Circom compiles to R1CS (Rank-1 Constraint System). Every computation must be expressed as quadratic constraints `a * b = c`.

```circom
pragma circom 2.1.6;

include "node_modules/circomlib/circuits/poseidon.circom";
include "node_modules/circomlib/circuits/comparators.circom";

// Prove knowledge of a preimage that hashes to a public commitment
// without revealing the preimage
template PrivateSetMembership(DEPTH) {
    // Public inputs
    signal input root;
    signal input nullifierHash;
    signal input recipient;

    // Private inputs
    signal input secret;
    signal input nullifier;
    signal input pathElements[DEPTH];
    signal input pathIndices[DEPTH];

    // Recompute the leaf commitment
    component leafHasher = Poseidon(2);
    leafHasher.inputs[0] <== nullifier;
    leafHasher.inputs[1] <== secret;

    // Nullifier hash to prevent double-spend
    component nullifierHasher = Poseidon(1);
    nullifierHasher.inputs[0] <== nullifier;
    nullifierHasher.out === nullifierHash;  // constrain public output

    // Merkle path verification
    component hashers[DEPTH];
    signal levelHashes[DEPTH + 1];
    levelHashes[0] <== leafHasher.out;

    for (var i = 0; i < DEPTH; i++) {
        hashers[i] = Poseidon(2);
        // pathIndices[i] must be 0 or 1 — enforce binary
        pathIndices[i] * (1 - pathIndices[i]) === 0;

        // Left/right ordering determined by path index
        hashers[i].inputs[0] <== (1 - pathIndices[i]) * levelHashes[i] + pathIndices[i] * pathElements[i];
        hashers[i].inputs[1] <== pathIndices[i] * levelHashes[i] + (1 - pathIndices[i]) * pathElements[i];
        levelHashes[i + 1] <== hashers[i].out;
    }
    root === levelHashes[DEPTH];
}

component main {public [root, nullifierHash, recipient]} = PrivateSetMembership(20);
```

Key gotchas:
- `<==` assigns AND constrains. `<--` assigns without constraining (use only for witness computation, never for security-critical values).
- Signals are field elements in BN254's scalar field (~254 bits). Comparators (LessThan, etc.) require explicit bit-width bounds.
- Underconstrained circuits are the #1 Circom vulnerability — the prover can set unconstrained signals to anything. Always constrain every signal that affects outputs.

### snarkjs Workflow

```bash
# 1. Compile circuit
circom circuit.circom --r1cs --wasm --sym -o build/

# 2. Powers of Tau (BN254, supports up to 2^20 constraints)
snarkjs powersoftau new bn128 20 pot20_0.ptau
snarkjs powersoftau contribute pot20_0.ptau pot20_1.ptau --name="First"
snarkjs powersoftau prepare phase2 pot20_1.ptau pot20_final.ptau

# 3. Groth16 circuit-specific setup
snarkjs groth16 setup build/circuit.r1cs pot20_final.ptau circuit_0.zkey
snarkjs zkey contribute circuit_0.zkey circuit_1.zkey --name="Contributor"
snarkjs zkey export verificationkey circuit_1.zkey verification_key.json

# 4. Generate proof
node generate_witness.js circuit.wasm input.json witness.wtns
snarkjs groth16 prove circuit_1.zkey witness.wtns proof.json public.json

# 5. Verify off-chain
snarkjs groth16 verify verification_key.json public.json proof.json

# 6. Export Solidity verifier
snarkjs zkey export solidityverifier circuit_1.zkey Verifier.sol
```

### On-Chain Verification

Generated Groth16 verifiers use the pairing check `e(A, B) = e(alpha, beta) * e(vk_x, gamma) * e(C, delta)`. Gas cost is dominated by the two pairing operations (~170k gas on Ethereum). PLONK verifiers cost more (~300-400k gas) but avoid per-circuit setup.

```solidity
// Verifier.sol (auto-generated by snarkjs, do not hand-edit)
function verifyProof(
    uint[2] calldata a,
    uint[2][2] calldata b,
    uint[2] calldata c,
    uint[2] calldata input  // public signals
) public view returns (bool) { ... }
```

### Halo2 (Rust)

Halo2 uses a custom arithmetization (PLONKish) with advice/fixed/instance columns and custom gates. The accumulation scheme enables recursion without a trusted setup.

```rust
use halo2_proofs::{
    circuit::{Layouter, SimpleFloorPlanner, Value},
    plonk::{Advice, Circuit, Column, ConstraintSystem, Error, Instance, Selector},
    poly::Rotation,
};

#[derive(Clone)]
struct RangeCheckConfig {
    value: Column<Advice>,
    selector: Selector,
    instance: Column<Instance>,
}

impl<F: Field> Circuit<F> for RangeCheckCircuit<F> {
    type Config = RangeCheckConfig;
    type FloorPlanner = SimpleFloorPlanner;

    fn configure(meta: &mut ConstraintSystem<F>) -> Self::Config {
        let value = meta.advice_column();
        let selector = meta.selector();
        let instance = meta.instance_column();
        meta.enable_equality(value);
        meta.enable_equality(instance);

        meta.create_gate("range check", |meta| {
            let s = meta.query_selector(selector);
            let v = meta.query_advice(value, Rotation::cur());
            // v * (v - 1) * ... * (v - (RANGE-1)) = 0
            let range_check = (0..RANGE).fold(v.clone(), |acc, i| {
                acc * (v.clone() - Expression::Constant(F::from(i as u64)))
            });
            vec![s * range_check]
        });
        RangeCheckConfig { value, selector, instance }
    }
}
```

### ZK-EVM Equivalence Levels

Type 1 (fully Ethereum-equivalent, Taiko): proves exact EVM execution including keccak, MPT storage. Slowest prover. Type 2 (zkSync Era, Polygon zkEVM): minor deviations (different hash function for storage). Type 4 (Starknet): transpile Solidity/Cairo to a custom VM, fastest proving. Most dapps target Type 2 for compatibility.

### Recursive Proofs

Recursion lets a proof verify another proof inside a circuit, enabling proof aggregation and incrementally verifiable computation (IVC). In Halo2, use the `halo2_recursion` gadget. In Circom/PLONK: use a PLONK verifier circuit. In STARKs: use STARK-of-STARK (Starknet's SHARP aggregator does this natively).

### Common Vulnerabilities

- **Underconstrained witnesses**: signals assigned with `<--` but never constrained — prover can forge.
- **Missing range checks**: field arithmetic wraps; a "less than" comparison without `Num2Bits` decomposition is unsound.
- **Nondeterministic circuits**: two valid witnesses for the same public input break soundness.
- **Trusted setup leakage**: if toxic waste from Phase 1 is compromised, the prover can generate false proofs.
- **Hash function mismatch**: using keccak inside a circuit is expensive (~90k constraints per hash). Prefer Poseidon (< 300 constraints) or MiMC for in-circuit hashing.
