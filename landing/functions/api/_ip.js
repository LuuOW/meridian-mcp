// Owner-IP allowlist matching with IPv6 /64 prefix support.
//
// Residential IPv6 addresses rotate frequently within a /64 (the standard
// subnet ISPs hand out). Exact-string matching breaks on every rotation;
// /64 prefix matching means setting OWNER_IPS once covers all subsequent
// rotations on the same network.
//
// OWNER_IPS env var: comma-separated list of IPv4 or IPv6 addresses (or
// IPv6 /64 prefixes). Example:
//   OWNER_IPS="203.0.113.42, 2803:9810:3e2e:4210:45d6:477a:4b3a:155d"
// matches that exact IPv4 + any IPv6 in the 2803:9810:3e2e:4210::/64 net.

export function ownerEntries(env) {
  return (env.OWNER_IPS || '')
    .split(',')
    .map(s => s.trim())
    .filter(Boolean)
}

// Expand a possibly-compressed IPv6 string to its full 8-group form.
// Returns null if the input isn't a parseable IPv6 address.
export function expandV6(ip) {
  if (typeof ip !== 'string' || !ip.includes(':')) return null
  const parts = ip.split('::')
  if (parts.length > 2) return null
  const head = parts[0] ? parts[0].split(':') : []
  const tail = parts[1] ? parts[1].split(':') : []
  const fill = 8 - head.length - tail.length
  if (fill < 0) return null
  if (parts.length === 1 && head.length !== 8) return null
  const groups = [...head, ...Array(fill).fill('0'), ...tail]
  if (groups.some(g => !/^[0-9a-fA-F]{0,4}$/.test(g))) return null
  return groups.map(g => g.padStart(4, '0').toLowerCase()).join(':')
}

// First 4 groups (the /64 prefix) of an IPv6 address, or null.
export function prefix64(ip) {
  const expanded = expandV6(ip)
  if (!expanded) return null
  return expanded.split(':').slice(0, 4).join(':')
}

export function isOwnerIp(ip, env) {
  if (!ip || ip === 'unknown') return false
  const entries = ownerEntries(env)
  if (entries.length === 0) return false

  const ipPrefix = prefix64(ip)
  for (const e of entries) {
    if (e === ip) return true                 // exact match (IPv4 or IPv6)
    if (ipPrefix && prefix64(e) === ipPrefix) return true   // /64 match
  }
  return false
}
