// Poll ask-meridian.uk/<slug>/ until it returns 200. Used by the
// studio worker to mark a job as "live" after pushing to main.
//
// Pages deploys typically land in 30-90 seconds. We give each job
// up to 5 minutes before giving up.

export async function waitForLive(slug: string, opts?: {
  timeout_ms?: number
  interval_ms?: number
}): Promise<{ live: boolean; status?: number; url: string }> {
  const url = `https://ask-meridian.uk/blog/${slug}/`
  const timeout = opts?.timeout_ms ?? 5 * 60 * 1000
  const interval = opts?.interval_ms ?? 5_000
  const start = Date.now()
  while (Date.now() - start < timeout) {
    try {
      const res = await fetch(url, {
        method: "GET",
        headers: { "user-agent": "meridian-studio/0.1" },
        // Don't follow redirects; we want the actual response status.
        redirect: "manual",
      })
      if (res.status === 200) return { live: true, status: 200, url }
      // 404 means Pages hasn't deployed yet. Anything else: bail out.
      if (res.status !== 404) {
        return { live: false, status: res.status, url }
      }
    } catch {
      // Network blip; keep polling.
    }
    await new Promise(r => setTimeout(r, interval))
  }
  return { live: false, url }
}
