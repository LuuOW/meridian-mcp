# Sim reports

Automated artifacts from the recurring simulation workflows:

| File pattern | Source workflow | Cadence |
|---|---|---|
| `orbital-YYYY-MM-DD.txt` | `.github/workflows/sim-orbital.yml` | Tue + Fri 06:11 UTC |
| `helix-YYYY-MM-DD.txt`   | `.github/workflows/sim-helix.yml`   | Wed 08:17 UTC (60s gap; ~25 min) |
| `photon-YYYY-MM-DD-*.json` | `.github/workflows/sim-photon.yml` | Manual (`workflow_dispatch`) |

Each file is the verbatim sim stdout for that date. Look at the latest two
to spot drift (e.g. recall@1 dropping after a `classOf` change, nDCG@5
collapsing after a corpus expansion).

To run any of them locally see `OPERATIONS.md` → "Simulations".
