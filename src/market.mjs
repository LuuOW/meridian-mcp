// market.mjs — WLD staking on arXiv paper citation outcomes
// Mechanics: parimutuel-lite, settled T+30 days via Semantic Scholar oracle

import { randomUUID }                                         from 'node:crypto'
import { readFileSync, writeFileSync, existsSync, renameSync } from 'node:fs'
import { dirname, join }                                       from 'node:path'
import { fileURLToPath }                                       from 'node:url'

const __dirname_market = dirname(fileURLToPath(import.meta.url))
const STAKES_FILE = join(__dirname_market, '..', 'data', 'stakes.json')

const MIN_STAKE_WLD   = 0.1
const MAX_STAKE_WLD   = 5.0
const HOUSE_EDGE      = 0.05   // 5% of pool goes to house on settled rounds
const SETTLEMENT_DAYS = 30

// WLD goes to the contract — not to the house wallet.
// The contract holds custody; oracle signs payouts on settlement day.
const PAYMENT_RECIPIENT = process.env.MERIDIAN_MARKET_CONTRACT
                       || '0x8A3854019b81f2Dd1CD9b65e286145d68649B769'

// ── Persistence ────────────────────────────────────────────────────────────
function loadStakes() {
  if (!existsSync(STAKES_FILE)) return {}
  try { return JSON.parse(readFileSync(STAKES_FILE, 'utf8')) }
  catch { return {} }
}

function saveStakes(data) {
  const tmp = STAKES_FILE + '.tmp'
  writeFileSync(tmp, JSON.stringify(data, null, 2), { mode: 0o600 })
  renameSync(tmp, STAKES_FILE)
}

// ── Mutex — prevents concurrent loadStakes/saveStakes race ─────────────────
let _saveLock = Promise.resolve()
function withLock(fn) {
  _saveLock = _saveLock.then(fn).catch(fn)  // chain; always advance even on error
  return _saveLock
}

// Scan all days for a reference — safe across midnight boundary (fix #1)
function findPositionByReference(stakes, reference) {
  for (const [date, day] of Object.entries(stakes)) {
    const pos = day.positions.find(p => p.reference === reference)
    if (pos) return { date, day, pos }
  }
  return null
}

// ── Date helpers ───────────────────────────────────────────────────────────
function todayUTC() { return new Date().toISOString().slice(0, 10) }
function addDays(date, n) {
  const d = new Date(date + 'T00:00:00Z')
  d.setUTCDate(d.getUTCDate() + n)
  return d.toISOString().slice(0, 10)
}

// ── Stake intent ───────────────────────────────────────────────────────────
/**
 * Create a pending stake — returns payment intent for MiniKit.
 * Does NOT activate until completeStake() verifies the on-chain tx.
 */
export function beginStake(params) {
  return withLock(() => _beginStake(params))
}

function _beginStake({
  session_hash, arxiv_id, paper_title, paper_class,
  payout_multiplier, amount_wld, date,
}) {
  const d   = date || todayUTC()
  const amt = parseFloat(
    Math.min(MAX_STAKE_WLD, Math.max(MIN_STAKE_WLD, parseFloat(amount_wld) || MIN_STAKE_WLD)).toFixed(4)
  )

  const stakes = loadStakes()
  if (!stakes[d]) {
    stakes[d] = { positions: [], settles_at: addDays(d, SETTLEMENT_DAYS), settlement: null }
  }

  // Guard: per-user per-paper max
  const alreadyStaked = stakes[d].positions
    .filter(p => p.session_hash === session_hash && p.arxiv_id === arxiv_id && p.status !== 'pending')
    .reduce((sum, p) => sum + p.amount_wld, 0)

  if (alreadyStaked + amt > MAX_STAKE_WLD) {
    throw new Error(`max ${MAX_STAKE_WLD} WLD per paper (you already staked ${alreadyStaked.toFixed(2)} WLD)`)
  }

  const reference = randomUUID().replace(/-/g, '')
  stakes[d].positions.push({
    stake_id:          randomUUID(),
    reference,
    stake_date:        d,        // stored explicitly — completeStake uses this, not todayUTC()
    session_hash,
    arxiv_id,
    title:             paper_title || arxiv_id,
    paper_class:       paper_class || 'planet',
    payout_multiplier: parseFloat(payout_multiplier) || 1.5,
    amount_wld:        amt,
    status:            'pending',
    placed_at:         new Date().toISOString(),
    confirmed_at:      null,
    transaction_id:    null,
    wallet_address:    null,
    settled_at:        null,
    payout_wld:        null,
  })
  saveStakes(stakes)

  return {
    reference,
    stake_date:        d,        // echoed back so completeStake can pass it directly
    recipient_address: PAYMENT_RECIPIENT,
    amount_wld:        amt,
    settles_at:        stakes[d].settles_at,
    arxiv_id,
  }
}

// ── World payment verification (same pattern as miniapp.mjs) ───────────────
async function verifyWorldTx({ transaction_id, app_id }) {
  const api_key = process.env.WORLD_API_KEY
  if (!api_key) throw new Error('WORLD_API_KEY not configured')
  const url =
    `https://developer.worldcoin.org/api/v2/minikit/transaction/` +
    `${encodeURIComponent(transaction_id)}?app_id=${encodeURIComponent(app_id)}&type=transaction`
  const r = await fetch(url, { headers: { Authorization: `Bearer ${api_key}` } })
  const j = await r.json()
  if (!r.ok) throw new Error(`Worldcoin tx verify failed: ${j.error || r.status}`)
  return j
}

// ── Complete stake ─────────────────────────────────────────────────────────
export async function completeStake({ reference, transaction_id, app_id, stake_date }) {
  // Fix #1: scan all dates for the reference instead of assuming todayUTC().
  // stake_date is echoed back from beginStake — use it as a hint but still
  // fall back to full scan so midnight boundary is never a failure mode.
  // A user placing a stake at 11:59 PM and confirming at 12:01 AM would break
  // if we used date || todayUTC() — the position lives in a different day bucket.
  return withLock(async () => {
    const stakes = loadStakes()
    const found = findPositionByReference(stakes, reference)
    if (!found) throw new Error('stake reference not found')

    const { pos } = found
    if (pos.status === 'active')  return pos   // idempotent
    if (pos.status !== 'pending') throw new Error(`unexpected status: ${pos.status}`)

    const tx = await verifyWorldTx({ transaction_id, app_id })
    if (tx.transaction_status === 'failed') throw new Error('transaction failed on chain')

    // Capture wallet address — log all fields so we can identify the right key if wrong
    const walletAddr = tx.from_address || tx.from || tx.sender || tx.user_address || null
    if (!walletAddr) {
      console.warn(`[market] wallet_address not found in World tx. Fields: ${Object.keys(tx).join(', ')}`)
    }

    pos.status         = 'active'
    pos.transaction_id = transaction_id
    pos.confirmed_at   = new Date().toISOString()
    pos.wallet_address = walletAddr
    saveStakes(stakes)
    return pos
  })
}

// ── Positions query ────────────────────────────────────────────────────────
export function getPositions(session_hash) {
  const stakes = loadStakes()
  const result  = []

  for (const [date, day] of Object.entries(stakes)) {
    const activePositions = day.positions.filter(p => p.status !== 'pending')
    const totalPool = activePositions.reduce((s, p) => s + p.amount_wld, 0)

    for (const pos of day.positions) {
      if (pos.session_hash !== session_hash) continue
      if (pos.status === 'pending') continue

      const paperPool = activePositions
        .filter(p => p.arxiv_id === pos.arxiv_id)
        .reduce((s, p) => s + p.amount_wld, 0)

      // Estimated payout if paper wins (before settlement is known)
      const estWinnerPool = activePositions.filter(p => p.arxiv_id === pos.arxiv_id)
      const totalWeighted = estWinnerPool.reduce((s, p) => s + p.amount_wld * p.payout_multiplier, 0)
      const myWeighted = pos.amount_wld * pos.payout_multiplier
      const estPayout = totalPool > 0 && totalWeighted > 0
        ? parseFloat(((totalPool * (1 - HOUSE_EDGE)) * (myWeighted / totalWeighted)).toFixed(4))
        : 0

      result.push({
        stake_id:          pos.stake_id,
        date,
        arxiv_id:          pos.arxiv_id,
        title:             pos.title,
        paper_class:       pos.paper_class,
        payout_multiplier: pos.payout_multiplier,
        amount_wld:        pos.amount_wld,
        status:            pos.status,
        placed_at:         pos.placed_at,
        settled_at:        pos.settled_at,
        payout_wld:        pos.payout_wld,
        settles_at:        day.settles_at,
        paper_pool_wld:    parseFloat(paperPool.toFixed(4)),
        total_pool_wld:    parseFloat(totalPool.toFixed(4)),
        est_payout_wld:    pos.status === 'active' ? estPayout : null,
        settlement_done:   Boolean(day.settlement),
      })
    }
  }

  return result.sort((a, b) => new Date(b.placed_at) - new Date(a.placed_at))
}

// ── Market status (public) ─────────────────────────────────────────────────
export function getMarketStatus(date) {
  const d    = date || todayUTC()
  const stakes = loadStakes()
  const day  = stakes[d]

  const settles_at = addDays(d, SETTLEMENT_DAYS)
  if (!day) return { date: d, papers: [], total_pool_wld: 0, settles_at, settlement: null }

  const byPaper = {}
  for (const pos of day.positions) {
    if (pos.status !== 'active') continue
    if (!byPaper[pos.arxiv_id]) {
      byPaper[pos.arxiv_id] = {
        arxiv_id:          pos.arxiv_id,
        title:             pos.title,
        paper_class:       pos.paper_class,
        payout_multiplier: pos.payout_multiplier,
        total_staked_wld:  0,
        stake_count:       0,
      }
    }
    byPaper[pos.arxiv_id].total_staked_wld =
      parseFloat((byPaper[pos.arxiv_id].total_staked_wld + pos.amount_wld).toFixed(4))
    byPaper[pos.arxiv_id].stake_count++
  }

  const totalPool = Object.values(byPaper).reduce((s, p) => s + p.total_staked_wld, 0)

  return {
    date,
    settles_at:      day.settles_at,
    settlement:      day.settlement,
    total_pool_wld:  parseFloat(totalPool.toFixed(4)),
    papers:          Object.values(byPaper),
  }
}

// ── Settlement oracle ──────────────────────────────────────────────────────
async function fetchCitations(arxiv_id) {
  const cleanId = arxiv_id.replace(/v\d+$/, '')   // strip version suffix e.g. v1
  const url = `https://api.semanticscholar.org/graph/v1/paper/arXiv:${cleanId}?fields=citationCount,title`
  try {
    const r = await fetch(url, {
      headers: { 'User-Agent': 'Meridian/1.0 (ask-meridian.uk; citation oracle)' },
    })
    if (r.status === 404) return { citationCount: 0, found: false }
    if (!r.ok) throw new Error(`HTTP ${r.status}`)
    const j = await r.json()
    return { citationCount: j.citationCount || 0, found: true, title: j.title }
  } catch (e) {
    return { citationCount: 0, found: false, error: e.message }
  }
}

/**
 * Run settlement for a past date.
 * Calls Semantic Scholar for citation counts, distributes parimutuel payouts.
 * Should only be called after settles_at date has passed.
 */
export async function checkAndSettle(date) {
  const stakes = loadStakes()
  const day = stakes[date]
  if (!day) throw new Error(`no stakes data for ${date}`)
  if (day.settlement) throw new Error(`already settled for ${date}`)

  const activePositions = day.positions.filter(p => p.status === 'active')
  if (!activePositions.length) {
    day.settlement = {
      settled_at: new Date().toISOString(),
      oracle_results: [],
      total_pool_wld: 0,
      house_fee_wld: 0,
      total_distributed: 0,
      winner_paper_count: 0,
      no_winners: true,
      note: 'no active positions',
    }
    saveStakes(stakes)
    return day.settlement
  }

  // Fetch citation counts for each unique paper
  const paperIds = [...new Set(activePositions.map(p => p.arxiv_id))]
  const oracleResults = []
  for (const arxiv_id of paperIds) {
    const res = await fetchCitations(arxiv_id)
    oracleResults.push({ arxiv_id, ...res, won: (res.citationCount || 0) >= 1 })
    // Rate-limit: Semantic Scholar public API allows ~100 req/5min
    await new Promise(r => setTimeout(r, 300))
  }

  const winnerIds  = new Set(oracleResults.filter(r => r.won).map(r => r.arxiv_id))
  const totalPool  = activePositions.reduce((s, p) => s + p.amount_wld, 0)
  const noWinners  = winnerIds.size === 0

  let houseFee = 0
  let totalDistributed = 0

  if (noWinners) {
    // Full refund — nobody guessed a cited paper, return stakes intact
    for (const pos of day.positions) {
      if (pos.status !== 'active') continue
      pos.status     = 'refunded'
      pos.payout_wld = pos.amount_wld
      pos.settled_at = new Date().toISOString()
      totalDistributed += pos.payout_wld
    }
  } else {
    // Parimutuel: 5% house fee, remaining distributed to winners weighted by stake × multiplier
    houseFee = totalPool * HOUSE_EDGE
    const settlerPool = totalPool - houseFee

    const winnerPositions = activePositions.filter(p => winnerIds.has(p.arxiv_id))
    const totalWeighted   = winnerPositions.reduce((s, p) => s + p.amount_wld * p.payout_multiplier, 0)

    for (const pos of day.positions) {
      if (pos.status !== 'active') continue
      pos.settled_at = new Date().toISOString()

      if (winnerIds.has(pos.arxiv_id) && totalWeighted > 0) {
        const share    = (pos.amount_wld * pos.payout_multiplier) / totalWeighted
        pos.payout_wld = parseFloat((settlerPool * share).toFixed(6))
        pos.status     = 'won'
        totalDistributed += pos.payout_wld
      } else {
        pos.payout_wld = 0
        pos.status     = 'lost'
      }
    }
  }

  day.settlement = {
    settled_at:          new Date().toISOString(),
    oracle_results:      oracleResults,
    total_pool_wld:      parseFloat(totalPool.toFixed(4)),
    house_fee_wld:       parseFloat(houseFee.toFixed(4)),
    total_distributed:   parseFloat(totalDistributed.toFixed(4)),
    winner_paper_count:  winnerIds.size,
    no_winners:          noWinners,
  }

  saveStakes(stakes)
  return day.settlement
}

// ── Leaderboard ────────────────────────────────────────────────────────────
/**
 * Aggregate all-time stats per staker from stakes.json.
 * Anonymise by truncating wallet_address; fall back to session_hash prefix.
 * Returns top-N sorted by total_won desc, then total_staked desc.
 */
export function getLeaderboard({ limit = 50 } = {}) {
  const stakes  = loadStakes()
  const byStaker = {}   // key: wallet_address || 'anon:' + session_hash.slice(0,8)

  for (const day of Object.values(stakes)) {
    for (const pos of day.positions) {
      if (pos.status === 'pending') continue

      // Identify staker — prefer wallet_address, fall back to anonymised session_hash
      const key = pos.wallet_address
        ? pos.wallet_address.toLowerCase()
        : `anon:${pos.session_hash.slice(0, 12)}`

      if (!byStaker[key]) {
        byStaker[key] = {
          address:          pos.wallet_address || null,
          anon:             !pos.wallet_address,
          total_staked_wld: 0,
          total_won_wld:    0,
          positions:        0,
          won:              0,
          lost:             0,
          active:           0,
        }
      }

      const s = byStaker[key]
      s.total_staked_wld = parseFloat((s.total_staked_wld + pos.amount_wld).toFixed(4))
      s.positions++

      if (pos.status === 'won') {
        s.won++
        s.total_won_wld = parseFloat((s.total_won_wld + (pos.payout_wld || 0)).toFixed(4))
      } else if (pos.status === 'lost') {
        s.lost++
      } else if (pos.status === 'active') {
        s.active++
      }
    }
  }

  const rows = Object.entries(byStaker).map(([key, s]) => {
    const settled = s.won + s.lost
    return {
      display:          s.address ? truncateAddr(s.address) : `Player ${key.slice(5, 11)}`,
      address:          s.address,
      total_staked_wld: s.total_staked_wld,
      total_won_wld:    s.total_won_wld,
      net_wld:          parseFloat((s.total_won_wld - s.total_staked_wld).toFixed(4)),
      win_rate:         settled > 0 ? parseFloat((s.won / settled).toFixed(3)) : null,
      positions:        s.positions,
      won:              s.won,
      lost:             s.lost,
      active:           s.active,
    }
  })

  rows.sort((a, b) =>
    b.total_won_wld - a.total_won_wld ||
    b.total_staked_wld - a.total_staked_wld
  )

  return rows.slice(0, limit).map((r, i) => ({ rank: i + 1, ...r }))
}

/**
 * All public picks for a given wallet address — used by leaderboard drill-down.
 * Returns non-pending positions sorted by placed_at desc.
 * Does NOT expose session_hash.
 */
export function getStakerPicks(address) {
  const stakes = loadStakes()
  const result = []
  const addrLow = address.toLowerCase()

  for (const [date, day] of Object.entries(stakes)) {
    for (const pos of day.positions) {
      if (!pos.wallet_address) continue
      if (pos.wallet_address.toLowerCase() !== addrLow) continue
      if (pos.status === 'pending') continue
      result.push({
        date,
        arxiv_id:          pos.arxiv_id,
        title:             pos.title,
        paper_class:       pos.paper_class,
        payout_multiplier: pos.payout_multiplier,
        amount_wld:        pos.amount_wld,
        status:            pos.status,
        payout_wld:        pos.payout_wld,
        placed_at:         pos.placed_at,
        settles_at:        day.settles_at,
      })
    }
  }

  return result.sort((a, b) => new Date(b.placed_at) - new Date(a.placed_at))
}

function truncateAddr(addr) {
  if (!addr || addr.length < 10) return addr
  return `${addr.slice(0, 6)}…${addr.slice(-4)}`
}

// ── On-chain payout broadcaster ────────────────────────────────────────────
/**
 * After checkAndSettle() computes payouts off-chain, this function:
 *   1. Builds the winner list (staker wallet addresses + amounts)
 *   2. Signs a payout batch with the oracle key
 *   3. Broadcasts executePayout() to MeridianMarket on World Chain
 *
 * Staker wallet addresses come from the World ID session → we look them up
 * via the Worldcoin Developer Portal transaction API (tx contains `to` = contract,
 * `from` = user wallet). The transaction_id is stored on each active position.
 */
export async function broadcastSettlement(date) {
  const { ethers } = await import('ethers')
  const stakes = loadStakes()
  const day    = stakes[date]
  if (!day?.settlement) throw new Error(`${date} not yet settled off-chain`)

  const CONTRACT  = process.env.MERIDIAN_MARKET_CONTRACT || '0x8A3854019b81f2Dd1CD9b65e286145d68649B769'
  const ORACLE_KEY = process.env.MERIDIAN_ORACLE_KEY
  const RPC        = process.env.WORLD_CHAIN_RPC || 'https://worldchain-mainnet.g.alchemy.com/public'

  if (!ORACLE_KEY) throw new Error('MERIDIAN_ORACLE_KEY not set')

  const provider = new ethers.JsonRpcProvider(RPC)
  const oracle   = new ethers.Wallet(ORACLE_KEY, provider)

  // Build recipient list from settled positions
  const winners  = day.positions.filter(p => p.status === 'won'      && p.payout_wld > 0)
  const refunded = day.positions.filter(p => p.status === 'refunded' && p.payout_wld > 0)
  const allPayees = [...winners, ...refunded]

  // Fix #3: if wallet_address is missing, log clearly and skip broadcast.
  // Do NOT call executePayout with empty arrays — that would permanently consume
  // the batchId on-chain with no transfers (bug #2 mitigation on the JS side).
  const missing = allPayees.filter(p => !p.wallet_address)
  if (missing.length) {
    console.error(`[broadcast] ${date}: ${missing.length} payee(s) missing wallet_address — cannot broadcast. stake_ids: ${missing.map(p => p.stake_id).join(', ')}`)
  }
  const payees = allPayees.filter(p => p.wallet_address)

  const houseFeeAmt = BigInt(Math.round(day.settlement.house_fee_wld * 1e18))

  // Fix #3 continued: nothing to send — abort cleanly rather than consuming batchId
  if (payees.length === 0 && houseFeeAmt === 0n) {
    throw new Error(`${date}: no payees with wallet_address and no house fee — skipping broadcast to preserve batchId`)
  }

  const recipients = payees.map(p => p.wallet_address)
  const amounts    = payees.map(p => BigInt(Math.round(p.payout_wld * 1e18)))

  // batchId = keccak256(date + "meridian")
  const batchId = ethers.keccak256(ethers.toUtf8Bytes(`meridian-${date}`))

  // Sign the payout batch
  const msgHash = ethers.keccak256(
    ethers.AbiCoder.defaultAbiCoder().encode(
      ['string', 'bytes32', 'address[]', 'uint256[]', 'uint256'],
      ['MeridianPayout', batchId, recipients, amounts, houseFeeAmt]
    )
  )
  const sig = await oracle.signMessage(ethers.getBytes(msgHash))

  // ABI for executePayout
  const abi = [
    'function executePayout(bytes32 batchId, address[] calldata recipients, uint256[] calldata amounts, uint256 houseFeeAmt, bytes calldata sig) external'
  ]
  const contract = new ethers.Contract(CONTRACT, abi, oracle)

  console.log(`[settle] broadcasting on-chain payout for ${date}: ${payees.length} recipients, pool=${totalPool} WLD`)
  const tx = await contract.executePayout(batchId, recipients, amounts, houseFeeAmt, sig)
  console.log(`[settle] tx submitted: ${tx.hash}`)
  const receipt = await tx.wait()
  console.log(`[settle] confirmed in block ${receipt.blockNumber}`)

  // Store tx hash in settlement record
  day.settlement.onchain_tx   = tx.hash
  day.settlement.onchain_block = receipt.blockNumber
  saveStakes(stakes)

  return { tx: tx.hash, block: receipt.blockNumber, recipients: payees.length }
}
