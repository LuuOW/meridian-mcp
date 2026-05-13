// Browser-local router client for the shared-origin deployment.
//
// Replaces the legacy mcp.ask-meridian.uk/v1/route POST (which proxied
// to GitHub Models / Llama-3.3-70B) with an in-browser Llama-3.2-3B
// inference loop via /_lib/route-task.mjs. Same exported surface so
// miniapp/app.js and vision-lab/lab.js consume it unchanged.
//
// Quality note: 3B locally is meaningfully smaller than 70B remotely,
// but it keeps the demo runnable offline after the one-time ~1.8 GB
// model download. Adjust expectations on the candidate prose; orbital
// ranking quality is unaffected (pure-JS classifier).

import { routeTaskBrowser, sendFeedbackBrowser } from '/_lib/route-task.mjs'

export async function routeTask(task, { limit = 5, signal } = {}) {
  return routeTaskBrowser({ task, limit, candidates: limit })
}

// Stage progression preserved so consumers can render the same pipeline
// animation. Stages are emitted as the browser actually moves through
// them — no faked timing.
export async function routeTaskStream(task, { limit = 5, signal, onProgress } = {}) {
  const onStage = (stage, info) => onProgress?.({ stage, ...info })
  onProgress?.({ stage: 'connected' })
  return routeTaskBrowser({ task, limit, candidates: limit, onStage })
}

export const sendFeedback = sendFeedbackBrowser
