// helix ServiceWorker.
//
// Delegates all HF CDN pinning to the shared sw-models snippet so lens /
// vision-lab / helix share one Cache Storage entry ('meridian-models-v1')
// across paths under meridian.ask-meridian.uk.
//
// SW must be served at the origin root (/sw.js) so its scope covers
// /lens/, /vision-lab/, /helix/ alike — a per-app SW under /helix/sw.js
// would only intercept /helix/* fetches, defeating the cache-sharing
// design.

import { installModelCache } from '/_lib/sw-models.mjs'

installModelCache()
