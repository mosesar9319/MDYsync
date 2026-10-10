# Test shiur

A **test shiur** is a video the voice models are tuned on. Right now that is
R' Sruly Bernstein's "Bechoros 2" (`Zsy7oDUP6Pw`, Lakewood Daf Yomi).

Every time either voice engine is run on it, the alignment is saved as a new
**numbered run** (`Regular #1`, `Regular #2`, `Live #1`, ... — numbers count per
engine and are never reused). The player shows two dropdowns on that video, one
for each engine, open to every reader; picking a run swaps the highlighting over
to that alignment at the same moment of the video, so two runs can be compared by
playing the same stretch under each.

## Running both engines (after merging a change to either)

GitHub → Actions → **Test shiur run (both voice engines)** → Run workflow. Give a
short note on what changed — it becomes part of the run's name in the dropdown
(`Live #3 · 14 Oct 2026 · pending survives misses`).

* **Regular engine** — dispatches the ordinary voice job with `testRun: true`; it
  publishes `Regular #N` (and, as always, the default `Voice-` alignment).
* **Live engine** — `live-engine.mjs` transcribes the video with ElevenLabs, plays
  the words through `live-matcher.js` the way Live Follow's video mode does, and
  `caption-sync/test_runs.py` saves it as `Live #N`.

The same thing by hand, for the live engine:

```sh
node tools/test-shiur/live-engine.mjs --video-id Zsy7oDUP6Pw --fetch-transcript \
     --out-words words.json --refs "Bekhorot 2a,Bekhorot 2b" --out alignment.json
python3 tools/caption-sync/test_runs.py publish --alignment alignment.json \
     --out-dir <results-branch-checkout> --video-id Zsy7oDUP6Pw --engine live --notes "what changed"
```

(`--fetch-transcript` asks the site's own transcript job, which already holds the
ElevenLabs key; add `--elevenlabs` to ask ElevenLabs directly with
`ELEVENLABS_API_KEY`. Re-running with `--words words.json` reuses a transcript.)

## Where it lives

On the `results` branch:

```
video-links/Bernstein-Bekhorot-2a.json      the video, marked "testShiur": true (and locked)
test-runs/<videoId>/index.json              every run, newest last (what the dropdowns read)
test-runs/<videoId>/regular-1.json          one dafsync-alignment-v2 file per run
test-runs/<videoId>/live-1.json
```

## Making another video a test shiur

Add `"testShiur": true, "locked": true` to its `video-links/<key>.json` (the
backfill tool does it with `--test-video <id>`), rebuild `catalog.json`
(`tools/build-video-catalog.mjs`), and dispatch the workflow above with its id
and refs.
