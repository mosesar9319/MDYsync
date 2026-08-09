// A small Levenshtein-ratio string similarity function (0-100, same scale
// and rough semantics as Python's rapidfuzz fuzz.ratio, already used
// throughout tools/caption-sync/*.py) -- Node has no equivalent built in,
// and this project's Netlify Functions had no npm dependencies at all
// before scan-daf-page.mjs, so a small self-contained implementation beats
// pulling in a new package for one function.
function levenshtein(a, b) {
  const m = a.length;
  const n = b.length;
  if (m === 0) return n;
  if (n === 0) return m;
  let prev = Array.from({ length: n + 1 }, (_, j) => j);
  for (let i = 1; i <= m; i++) {
    const curr = [i];
    for (let j = 1; j <= n; j++) {
      curr.push(a[i - 1] === b[j - 1]
        ? prev[j - 1]
        : 1 + Math.min(prev[j - 1], prev[j], curr[j - 1]));
    }
    prev = curr;
  }
  return prev[n];
}

export function ratio(a, b) {
  const distance = levenshtein(a, b);
  const maxLen = Math.max(a.length, b.length);
  if (maxLen === 0) return 100;
  return ((maxLen - distance) / maxLen) * 100;
}

/**
 * Finds the best-scoring entry in `candidates` for `query`, where `key(entry)`
 * returns the string to compare against. Returns {entry, score} or null if
 * candidates is empty.
 */
export function bestMatch(query, candidates, key) {
  let best = null;
  for (const entry of candidates) {
    const score = ratio(query, key(entry));
    if (!best || score > best.score) best = { entry, score };
  }
  return best;
}
