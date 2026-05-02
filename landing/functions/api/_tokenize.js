// Shared tokenizer for the edge classifiers.
// Lowercase, replace non-alphanumeric (preserving hyphen) with whitespace,
// drop short tokens (<3 chars) and a small English stop-word set.
// Used by both the lexical scorer (_router.js) and the orbital classifier
// (_orbital.js) so token boundaries and STOP membership stay aligned.

export const STOP = new Set([
  'the','and','for','with','that','this','from','have','your','about',
  'into','what','when','where','which','their','there','these','those',
  'will','would','should','could','been','being','need','want','get',
  'set','use','using','make','made','like','also','some','any','all',
  'one','two','out','off','its',"it's",'you',"you're",'our',
])

export function tokenize(s) {
  return (s || '')
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, ' ')
    .split(/\s+/)
    .filter(t => t.length >= 3 && !STOP.has(t))
}

export function uniq(arr) { return [...new Set(arr)] }
