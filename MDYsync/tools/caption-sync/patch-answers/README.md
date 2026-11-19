# Holes answered in a Claude Code session

Each file here fills the holes a voice sync left in one shiur, with answers Claude
gave in a Claude Code session instead of through the Anthropic API (see
`llm_patch.py`, "Answers from a file instead of the API").

To do another shiur, from its saved transcripts (no audio, no ElevenLabs credit):

    git show origin/results:transcripts/<video id>.json.gz > /tmp/t.json.gz
    python3 voice_align.py job-audio.mp3 --refs-json '["Arakhin 2a","Arakhin 2b"]' \
        --saved-transcripts /tmp/t.json.gz --out-dir /tmp/out --patch-questions /tmp/questions.json

Answer each hole in `/tmp/questions.json` (its `system` text says how), and write
`<video id>.json` here:

    {"schema": "dafsync-patch-answers-v1", "videoId": "...",
     "placements": [{"daf": [first, last], "heard": [first, last],
                     "kind": "read" | "explained", "confidence": 0.8, "why": "..."}]}

`daf` and `heard` are the numbers the questions use: daf words by their place in
the whole text read, heard words by their place in the transcript. Check it with
`--patch-answers`, then, once on main, run "Place a shiur again from its saved
transcripts" (realign.yml) for that video id with publish on: it uses this file.
