# Test shiur

A **test shiur** is a video the voice models are tuned on. Right now that is
R' Sruly Bornstein's "Bechoros 58" (`TWCiP96dKXU`, Lakewood Daf Yomi); before it,
his "Bechoros 2" (`Zsy7oDUP6Pw`), whose runs are still there.

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
  publishes `Regular #N` (and, as always, the default `Voice-` alignment). Two
  inputs choose how it runs, and go into the run's name:
  * `aligner`: `path` (the whole shiur as one ordered path — `path_align.py`) or
    `phrase` (the older phrase-by-phrase matcher alone).
  * `witnesses`: which transcripts the path is given — `hints,relisten` (the
    default: one made with the daf's words as a hint list, then a second listen to
    just the holes the path left, each clip hinted with only the daf words that
    belong there, at most 15 minutes of extra audio), `hints`, `hints,plain` (adds
    one made without the hint list), or `hints,plain,slow` (`slow` is the audio
    played at 0.75 speed). `plain` and `slow` are each one more ElevenLabs
    transcription of the whole shiur — about 1,000 credits an hour each.
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

## Measuring a change: the answer key

A Bornstein shiur has nothing to check a run against but your own ears. A Mercaz
Daf Yomi shiur does: its burned-in captions say where on the daf the shiur is at
every moment. So run the voice engine on one, and score the result against its
caption alignment (`by-ref/<Tractate>-<daf>.json` on the results branch):

```sh
python3 tools/caption-sync/voice_align.py audio.mp3 --refs-json '["Bekhorot 39b","Bekhorot 40a","Bekhorot 40b"]' --out-dir out
python3 tools/caption-sync/score_against_captions.py --voice out/alignment.json --captions Bekhorot-40a.json
```

(`--transcript saved.json`, repeatable, reuses transcripts instead of paying for
new ones.) On "Bechoros 40" (`dK7n4zCn5yY`), November 2026: the phrase matcher
without its Claude step kept the highlight within 5 words of the captions 48% of
the time, the live engine 67%, the path aligner with two transcripts 87%.

## Where it lives

On the `results` branch:

```
video-links/Bornstein-Bekhorot-2a.json      the video, marked "testShiur": true (and locked)
test-runs/<videoId>/index.json              every run, newest last (what the dropdowns read)
test-runs/<videoId>/regular-1.json          one dafsync-alignment-v2 file per run
test-runs/<videoId>/live-1.json
```

## Making another video a test shiur

Dispatch the workflow above with its id, refs and maggid. Its first job
(`tools/test-shiur/register.mjs`, then `tools/build-video-catalog.mjs`) writes the
`video-links/<key>.json` files with `"testShiur": true, "locked": true` and
rebuilds `catalog.json`; a daf that already links a different video is left alone.
