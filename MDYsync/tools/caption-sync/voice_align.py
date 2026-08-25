#!/usr/bin/env python3
"""Voice-based alignment for DafSync -- a standalone alternative to
caption_ocr_align.py's caption-box OCR approach, for a video with no
burned-in caption box at all.

Transcribes the video's audio with a pretrained speech model (faster-whisper,
no fine-tuning yet), then anchors that transcription against the daf's
canonical Sefaria text rather than trusting the free transcription's own
wording: only Hebrew-script word runs are considered as candidate gemara
readings at all (a shiur is mostly English explanation, occasionally
switching to read the Aramaic/Hebrew text aloud), and each run is fuzzy-
matched against a window of canonical text tracked by a cursor, the same
lock/relocalize state machine caption_ocr_align.py's match_phrase() already
uses for OCR-read caption text.

Two refinements past that baseline design, both added after testing against
real synced Chullin 95a audio:

  1. Dual scoring -- search for the best-matching window using a *phonetic*
     normalization of the Hebrew letters (collapsing acoustically-confusable
     letters: e.g. "שוטה" heard/transcribed as "שייט", ו/י both being
     glide-ish vowel letters), since ASR errors are acoustic confusions, not
     the visual ones OCR makes -- but require the same window to also clear
     a plain character-similarity floor before accepting it. Phonetic-only
     scoring recovered real matches character-only scoring missed, but also
     let a couple of coincidentally-similar-sounding hallucinated (garbled)
     transcription fragments through; requiring both to agree caught those
     without losing the phonetic recovery.

  2. A fresh lock (after starting unlocked, or after losing the lock and
     relocalizing) is only trusted once two consecutive global-search
     matches agree with each other (the second lands at or after the first,
     within a reasonable forward distance) -- a single short, ambiguous
     phrase matching *some* window elsewhere in a sugya's fairly repetitive
     opening lines turned out to be a real, distinct failure mode from
     outright noise, and neither scoring axis alone can tell "genuinely
     the right spot" from "coincidentally similar-sounding phrase
     elsewhere in the text" from a single short match.

None of this makes the underlying speech model any more accurate at
Talmudic Aramaic -- it's still zero-shot, no fine-tuning. It's the matching
layer around it that's tuned to only trust what it's actually confident
about, leaving everything else for manual correction the same way an OCR
sync's rough spots already get corrected today.
"""
import argparse
import json
import os
import re
import sys

from faster_whisper import WhisperModel
from rapidfuzz import fuzz

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from caption_ocr_align import (  # noqa: E402
    CanonWord, WordEvent, build_outputs, load_canonical, normalize_word,
)

BACK_WINDOW = 15
FWD_WINDOW = 60
# A matched run is usually already just one phrase, but whisper gives a real
# timestamp for every word in it, not just the first -- splitting each run
# into small real-timestamped sub-chunks (rather than one event anchored to
# run[0]'s time alone) means a pause mid-run (the speaker stopping to
# explain partway through a phrase that otherwise matched) shows up as a
# real time gap for build_outputs' phrase-chunking to see, instead of
# getting silently absorbed into one assumed-uniform-pace block. A word-
# count target alone can't guarantee that -- the pause could land in the
# middle of a count-based chunk just as easily as at its edge -- so a sub-
# chunk boundary is also forced at any real gap between two consecutive
# words in the run bigger than RUN_PAUSE_GAP_SECONDS.
RUN_SUBCHUNK_WORDS = 4
RUN_PAUSE_GAP_SECONDS = 1.0
# Phonetic scores run higher than character scores on the same text (less
# distinctive alphabet after collapsing confusable letters), so these two
# axes need their own floors, calibrated separately -- see the module
# docstring. Tuned against one real clip; expect these to move as more
# corrected dapim accumulate (see tools/caption-sync/voice_confusions.json).
MIN_SCORE = 60
MIN_SCORE_GLOBAL = 72
MIN_SCORE_SINGLE = 85
CHAR_FLOOR = 55
RELOCALIZE_AFTER = 12
MAX_RUN_GAP_SECONDS = 2.0

_CONFUSIONS_PATH = os.path.join(os.path.dirname(os.path.abspath(__file__)), "voice_confusions.json")


def load_phonetic_classes():
    """Letter -> phonetic-class-symbol table. Starts from the four
    confusion classes identified against real audio (see module docstring);
    voice_confusions.json (built from banked manual corrections -- see
    tools/caption-sync/build_voice_confusions.py) can override/extend it
    once there's enough corrected data to justify it, without a code
    change."""
    classes = [("A", "אעה"), ("Y", "וי"), ("K", "כחק"), ("T", "תט")]
    if os.path.exists(_CONFUSIONS_PATH):
        try:
            with open(_CONFUSIONS_PATH, encoding="utf-8") as f:
                data = json.load(f)
            if isinstance(data.get("classes"), list):
                classes = [(c["symbol"], c["letters"]) for c in data["classes"]]
        except Exception as error:
            print(f"Could not read {_CONFUSIONS_PATH}, using built-in defaults: {error}")
    table = {}
    for symbol, letters in classes:
        for ch in letters:
            table[ch] = symbol
    return table


_PHONETIC_CLASS = load_phonetic_classes()


def phonetic(norm_word: str) -> str:
    return "".join(_PHONETIC_CLASS.get(ch, ch) for ch in norm_word)


def match_phrase_dual(canon, hl_norm, hl_phon, cursor, global_search=False, window=None):
    """Same search strategy as caption_ocr_align.match_phrase(), but scores
    on the phonetic form to find the best window, then requires that same
    window to also clear a character-similarity floor. Returns
    (start_index, end_index, phonetic_score, char_score) or None.

    window, when given, overrides both the local (cursor-centered) and
    global (whole-canon) search ranges with an explicit (lo, hi) -- used by
    refine_matches to retry a run inside the tight span between two already-
    confirmed anchors. That span is trusted evidence in its own right (not a
    blind guess the way a full global search is), so it gets the more
    lenient LOCAL floor even though, like a global search, it isn't
    centered on any single cursor and so carries no distance penalty.
    """
    phon_phrase = "".join(hl_phon)
    if not phon_phrase:
        return None
    k = len(hl_phon)
    if window is not None:
        lo, hi = window
        if hi <= lo:
            return None
    elif global_search:
        if k < 2:
            return None
        lo, hi = 0, len(canon)
    else:
        lo = max(0, cursor - BACK_WINDOW)
        hi = min(len(canon), cursor + FWD_WINDOW)
    best = None
    for size in {max(1, k - 1), k, k + 1}:
        for s in range(lo, max(lo, hi - size + 1)):
            cand_phon = "".join(c.phon for c in canon[s:s + size])
            score = fuzz.ratio(phon_phrase, cand_phon)
            if not global_search and window is None:
                score -= abs(s - cursor) * 0.15
            if best is None or score > best[2]:
                best = (s, s + size - 1, score)
    if best is None:
        return None
    if window is not None:
        floor = MIN_SCORE_SINGLE if k == 1 else MIN_SCORE
    else:
        floor = MIN_SCORE_GLOBAL if global_search else (MIN_SCORE_SINGLE if k == 1 else MIN_SCORE)
    if best[2] < floor:
        return None
    s, e, phon_score = best
    char_phrase = "".join(hl_norm)
    char_cand = "".join(c.norm for c in canon[s:e + 1])
    char_score = fuzz.ratio(char_phrase, char_cand)
    if char_score < CHAR_FLOOR:
        return None
    return s, e, phon_score, char_score


# A small, fixed set of recurring Gemara discourse markers/formulas -- they
# show up on nearly every daf but are a register a general-purpose Hebrew
# ASR model's training data (mostly Modern Israeli Hebrew, not Talmudic
# study) likely under-represents. Always included in the prompt below,
# regardless of which daf is being synced.
COMMON_GEMARA_TERMS = [
    "תא שמע", "איתמר", "תניא", "מתניתין", "גמרא", "אמר מר", "מאי טעמא",
    "והתניא", "אמר רבא", "אמר אביי", "בעי מיניה", "איבעיא להו",
]
# Short, extremely common connectives -- too generic (and too short) to
# need any ASR biasing help, so excluding them from build_keyterm_prompt's
# per-daf sample keeps its limited word budget spent on words that actually
# benefit from it (names, technical terms, less common vocabulary).
_KEYTERM_STOPWORDS = {
    "של", "את", "על", "אל", "כי", "לא", "הוא", "היא", "זה", "מה",
    "לו", "בו", "כן", "עד", "גם", "רק", "כל", "יש", "אין", "אם",
}


def build_keyterm_list(canon, max_terms=50):
    """This daf's own distinctive vocabulary, plus COMMON_GEMARA_TERMS, as a
    list of terms to bias an ASR engine toward.

    Deduplicated first (a daf repeats plenty of its own vocabulary, and a
    term already banked helps just as much as the same term banked five
    times -- spending the budget on distinct words covers strictly more of
    the text), then sampled evenly across the whole deduplicated list so a
    job spanning several refs doesn't have its vocabulary dominated by
    whichever ref happens to load first. Common short connectives are
    filtered out (see _KEYTERM_STOPWORDS): they don't need biasing help and
    would just eat budget that belongs to names and technical terms.

    Shared by both engines, which have very different budgets for it --
    see build_keyterm_prompt (Whisper, tight) and transcribe_elevenlabs
    (Scribe, up to 1000 terms) for each one's own max_terms.
    """
    seen = set()
    distinctive = []
    for w in canon:
        n = w.norm
        if len(n) < 3 or n in _KEYTERM_STOPWORDS or n in seen:
            continue
        seen.add(n)
        distinctive.append(n)
    sample = []
    if distinctive:
        step = max(1, len(distinctive) // max_terms)
        sample = distinctive[::step][:max_terms]
    return COMMON_GEMARA_TERMS + sample


def build_keyterm_prompt(canon, max_words=50):
    """build_keyterm_list as a single prompt string, for Whisper's
    initial_prompt -- which biases the decoder's word choices, and unlike a
    paid ASR API's keyterm-list feature costs nothing extra: the model
    already being run just gets a better starting context, for free.

    max_words is deliberately conservative (COMMON_GEMARA_TERMS alone is
    already ~20 words, and Hebrew tends to split into more BPE tokens per
    word than English in a multilingual tokenizer) -- Whisper truncates an
    overlong prompt from whichever end it doesn't like, silently discarding
    part of a carefully built list, so staying well under that ceiling
    beats finding it by accident.
    """
    terms = build_keyterm_list(canon, max_terms=max_words)
    return " ".join(terms) if terms else None


ELEVENLABS_URL = "https://api.elevenlabs.io/v1/speech-to-text"
ELEVENLABS_MODEL = "scribe_v2"
# The API's own documented ceiling is 1000 terms / 50 chars each. Staying
# well under it: a daf's genuinely distinct vocabulary is nowhere near 1000
# words anyway (see build_keyterm_list's dedup), and a keyterm list padded
# out to a hard limit with increasingly marginal words is not obviously
# better than a focused one.
ELEVENLABS_MAX_KEYTERMS = 400


def _multipart_body(fields, file_field, filename, file_bytes):
    """Encode multipart/form-data by hand. Returns (content_type, body).

    Hand-rolled rather than pulling in `requests` -- caption_ocr_align.py's
    own Sefaria fetch already sticks to stdlib urllib, and the voice job's
    pip install line stays as-is.

    `fields` is a list of (name, value) PAIRS, not a dict, specifically so a
    repeated name can appear more than once -- which is how a list-valued
    field (keyterms) is encoded here.
    """
    import uuid
    boundary = uuid.uuid4().hex
    out = []
    for name, value in fields:
        out.append(f"--{boundary}\r\n".encode())
        out.append(f'Content-Disposition: form-data; name="{name}"\r\n\r\n'.encode())
        out.append(f"{value}\r\n".encode("utf-8"))
    out.append(f"--{boundary}\r\n".encode())
    out.append(
        f'Content-Disposition: form-data; name="{file_field}"; filename="{filename}"\r\n'
        f"Content-Type: application/octet-stream\r\n\r\n".encode()
    )
    out.append(file_bytes)
    out.append(b"\r\n")
    out.append(f"--{boundary}--\r\n".encode())
    return f"multipart/form-data; boundary={boundary}", b"".join(out)


def transcribe_elevenlabs(audio_path, keyterms=None, api_key=None):
    """Transcribe via ElevenLabs Scribe, returning the same (words, duration)
    shape transcribe() does, so everything downstream (hebrew_script_runs and
    the whole matching state machine) is engine-agnostic.

    Two things this buys over the local Whisper path, both structural rather
    than just "a better model":

      1. Real automatic multilingual/code-switching. language_code is left
         unset here on purpose so the API detects per-request. The local
         Whisper path can't do that -- it force-sets language="he" for the
         whole file, because standard Whisper detects language ONCE from the
         opening ~30s and would otherwise lock a shiur that opens in English
         into English mode for its entire length, garbling exactly the
         Hebrew/Aramaic reading this pipeline depends on.
      2. A real keyterm bias list (up to 1000 terms) rather than Whisper's
         initial_prompt, which soft-primes through a much smaller context
         window.

    Response words carry a `type` ("word" / "spacing" / "audio_event");
    only real words are kept. `logprob` is passed through as `prob` for
    shape-compatibility with the Whisper path -- note it is a LOG
    probability (<= 0), not the 0..1 value Whisper reports, so the two
    aren't numerically comparable. Nothing downstream reads `prob` today;
    if anything ever does, it has to account for which engine produced it.
    """
    import urllib.error
    import urllib.request

    api_key = api_key or os.environ.get("ELEVENLABS_API_KEY")
    if not api_key:
        raise RuntimeError(
            "ELEVENLABS_API_KEY is not set -- required for --engine elevenlabs.")

    fields = [
        ("model_id", ELEVENLABS_MODEL),
        ("timestamps_granularity", "word"),
    ]
    # A list-valued multipart field, sent as a repeated field name. NOTE:
    # ElevenLabs documents `keyterms` as "a list of strings" but publishes no
    # example of how to encode that in a multipart body, and this could not
    # be tested here (no API key in this environment). Repeated field names
    # are the ordinary multipart convention for lists, but if the API rejects
    # it or silently ignores the bias, the alternative worth trying is a
    # single `keyterms` field holding a JSON-encoded array string --
    # i.e. replace this loop with:
    #     fields.append(("keyterms", json.dumps(keyterms, ensure_ascii=False)))
    for term in (keyterms or [])[:ELEVENLABS_MAX_KEYTERMS]:
        if len(term) < 50:
            fields.append(("keyterms", term))

    with open(audio_path, "rb") as f:
        file_bytes = f.read()
    content_type, body = _multipart_body(
        fields, "file", os.path.basename(audio_path), file_bytes)

    print(f"Uploading {len(file_bytes) / 1e6:.1f}MB to ElevenLabs "
          f"({ELEVENLABS_MODEL}, {sum(1 for n, _ in fields if n == 'keyterms')} keyterms)...")
    request = urllib.request.Request(
        ELEVENLABS_URL, data=body,
        headers={"xi-api-key": api_key, "Content-Type": content_type})
    try:
        with urllib.request.urlopen(request, timeout=1800) as response:
            data = json.load(response)
    except urllib.error.HTTPError as error:
        detail = error.read().decode("utf-8", "replace")[:500]
        raise RuntimeError(f"ElevenLabs returned {error.code}: {detail}") from error

    print(f"Detected language: {data.get('language_code')} "
          f"(p={data.get('language_probability')})")
    words = []
    for w in data.get("words") or []:
        if w.get("type") not in (None, "word"):
            continue
        if w.get("start") is None or w.get("end") is None:
            continue
        words.append({"start": w["start"], "end": w["end"],
                      "text": w.get("text", ""), "prob": w.get("logprob")})
    duration = data.get("audio_duration_secs")
    if not duration:
        # Same requirement the Whisper path's info.duration comment explains:
        # the player degrades highlighting accuracy when this doesn't match
        # the video's real length, so falling back to the last word's end
        # time (which under-reports whenever there's trailing silence/outro)
        # is a last resort, not a normal path.
        duration = words[-1]["end"] if words else 0.0
    return words, duration


def transcribe(audio_path, model_size="small", initial_prompt=None):
    print(f"Loading whisper model: {model_size} (CPU, int8)...")
    model = WhisperModel(model_size, device="cpu", compute_type="int8")
    segments, info = model.transcribe(
        audio_path, language="he", word_timestamps=True, vad_filter=True,
        initial_prompt=initial_prompt,
    )
    print(f"Detected/forced language: {info.language} (p={info.language_probability:.2f})")
    words = []
    for seg in segments:
        for w in (seg.words or []):
            words.append({"start": w.start, "end": w.end, "text": w.word, "prob": w.probability})
    # info.duration is the real audio file length -- NOT the same as the
    # last recognized word's end time, which used to be used for this and
    # under-reports whenever there's trailing content after the last word
    # Whisper picks up (outro music, silence, etc.). The player warns (and
    # degrades highlighting accuracy) whenever this doesn't match the
    # video's own real duration, so it has to be right.
    return words, info.duration


def hebrew_script_runs(words):
    """Group consecutive Hebrew-script words into runs -- a run breaks on
    any non-Hebrew word (English explanation) or a gap between consecutive
    Hebrew words, since either means we've left a continuous stretch of
    actual reading."""
    runs = []
    current = []
    for w in words:
        n = normalize_word(w["text"])
        if not n:
            if current:
                runs.append(current)
                current = []
            continue
        if current and w["start"] - current[-1]["end"] > MAX_RUN_GAP_SECONDS:
            runs.append(current)
            current = []
        current.append({**w, "norm": n, "phon": phonetic(n)})
    if current:
        runs.append(current)
    return runs


# Claude Opus 5 -- this step is deliberately low-volume (only the minority
# of runs deterministic matching can't place at all) and each call resolves
# a genuinely hard case that stays wrong, unmatched, or manually corrected
# otherwise, so accuracy matters more than shaving cost/latency the way it
# would for a called-constantly step. See voice_align.py's own design
# discussion for the reasoning against Sonnet/Haiku here.
ANTHROPIC_MODEL = "claude-opus-5"
# No real backward slack: by the time resolve_ambiguous_run is called,
# match_phrase_dual's own GLOBAL search (which scans the entire canon, not
# just forward from cursor) has already failed to find this run anywhere --
# so if the true phrase were behind cursor with any real acoustic
# resemblance, that search would already have caught it. The only thing
# LLM_WINDOW_BACK=0 gives up is a hypothetical backward re-read the
# deterministic pass ALSO couldn't recognize acoustically, which the model
# reasoning about it isn't any better positioned to catch than fuzzy search
# already wasn't -- not worth the added risk of it picking a coincidentally-
# similar earlier phrase in a repetitive sugya (see the module docstring's
# own account of that exact failure mode).
LLM_WINDOW_BACK = 0
# Fallback only -- used when find_forward_anchor finds nothing to bound the
# window with (see below), which by design is now the less common path
# since a real anchor already bounds the common case tightly. Kept modest
# rather than generous for the same reason as LLM_WINDOW_BACK=0: a wide
# blind window costs precision (more chances for a coincidental match in
# repetitive text) for very little recall (a shiur is almost always
# continuous forward reading; a multi-hundred-word unexplained gap is rare
# enough that leaving it for manual review is the safer default).
LLM_WINDOW_FWD = 40
# Absolute ceiling on the candidate window's size regardless of how far a
# real forward anchor (see find_forward_anchor) turns out to be -- a huge
# window costs tokens/latency for no real benefit, since a phrase that far
# from the last confirmed position is more likely a bad anchor (a
# coincidental fuzzy match elsewhere) than a genuine multi-minute tangent.
LLM_WINDOW_MAX = 400
# Below this, treat the model's own uncertainty as "no rescue" rather than
# accepting a low-confidence guess -- consistent with every other floor in
# this file (MIN_SCORE/MIN_SCORE_GLOBAL/CHAR_FLOOR): only trust what's
# actually confident, leave the rest for manual correction.
LLM_MIN_CONFIDENCE = 0.6
# How many runs past an ambiguous one find_forward_anchor is willing to look
# before giving up and letting resolve_ambiguous_run fall back to the fixed
# LLM_WINDOW_FWD guess.
LLM_LOOKAHEAD_RUNS = 12
# Small slack past a forward anchor's own start -- the ambiguous phrase
# should read right up TO that confirmed position, not past it, but the
# anchor run's first recognized word can itself be a little late (a
# half-swallowed opening word ASR dropped), so the window's right edge
# leaves a couple words of room rather than cutting exactly at the anchor.
LLM_ANCHOR_PAD = 3


def find_forward_anchor(canon, runs, start_idx, cursor, max_lookahead=LLM_LOOKAHEAD_RUNS):
    """Look ahead through the next few Hebrew-script runs after start_idx for
    the next one deterministic matching (match_phrase_dual, global search)
    can confidently place on its own -- i.e. the next point in the shiur
    match_runs' own forward pass will eventually lock back onto, whether or
    not it's actually been processed yet.

    Gives resolve_ambiguous_run a real, evidence-based right edge for its
    candidate window instead of only ever guessing a fixed distance forward:
    if the rabbi goes on a long tangent before returning to the text, the
    true target could be much further than LLM_WINDOW_FWD; if it's much
    closer, a tighter window is also a more precise one for the model to
    reason within. Read-only -- doesn't touch match_runs' own cursor/lock
    state, just looks ahead at what it will find later.

    Only accepts an anchor strictly after `cursor` (the last confirmed
    position) -- a global match landing at or before it isn't "the next"
    anything. Returns the anchor's canonical start index, or None if
    nothing in the lookahead window matches confidently (a real gap, or the
    shiur is ending) -- resolve_ambiguous_run falls back to its fixed
    window in that case.
    """
    for run in runs[start_idx:start_idx + max_lookahead]:
        hl_norm = [w["norm"] for w in run]
        hl_phon = [w["phon"] for w in run]
        m = match_phrase_dual(canon, hl_norm, hl_phon, 0, global_search=True)
        if m is not None and m[0] > cursor:
            return m[0]
    return None

_LLM_RESCUE_SCHEMA = {
    "type": "object",
    "properties": {
        "is_reading_daf_text": {
            "type": "boolean",
            "description": "False if the transcript doesn't correspond to any "
                            "of the printed words shown -- a name mentioned in "
                            "passing, a quote from elsewhere, noise -- rather "
                            "than forcing a match.",
        },
        "start_index": {"type": "integer", "description": "First index (from the numbered list) being read."},
        "end_index": {"type": "integer", "description": "Last index (from the numbered list) being read, inclusive."},
        "confidence": {"type": "number", "description": "0 to 1."},
    },
    "required": ["is_reading_daf_text", "start_index", "end_index", "confidence"],
    "additionalProperties": False,
}


def resolve_ambiguous_run(canon, cursor, run, forward_anchor=None, client=None):
    """When deterministic fuzzy/phonetic matching (match_phrase_dual) can't
    confidently place a Hebrew-script run anywhere in the daf, ask a
    reasoning model to do what string-similarity search structurally can't:
    use CONTEXT -- what's plausible for the rabbi to be reading right now,
    given where the shiur already is, the daf's own actual wording, and
    (when known) where the shiur confirmedly picks the text back up shortly
    after this -- not just which stretch of text looks acoustically closest
    to ASR text that's already known to be unreliable (or match_phrase_dual
    would have accepted it).

    forward_anchor, from find_forward_anchor(), is the canonical index of
    the next run deterministic matching will confidently place on its own --
    a real, evidence-based right edge for the candidate window, used
    instead of the fixed LLM_WINDOW_FWD guess when available. Bounding the
    window between two confirmed points (the last one behind, this anchor
    ahead) rather than guessing a fixed distance forward both tightens
    precision when the anchor is close and preserves recall when it's a
    genuine tangent further out than LLM_WINDOW_FWD would have reached.

    Deliberately the LAST resort, not the first, and never the primary
    matching mechanism -- see match_runs, which only calls this after BOTH
    match_phrase_dual passes (phonetic and character-similarity) have
    already failed on a real audio run. Also gated on k>=2 words, for the
    same reason match_phrase_dual's own global_search refuses k<2 runs: a
    lone stray Hebrew word/name said in passing is exactly the case NOT
    worth spending a model call on, not a genuinely ambiguous phrase.

    Returns (start_index, end_index, confidence*100, confidence*100) --
    matching match_phrase_dual's own (s, e, phon_score, char_score) shape
    (there's only one real score dimension here, not two independent axes,
    so both slots carry the same value) precisely so match_runs() doesn't
    need to know or care which mechanism produced a given match. Returns
    None if the model doesn't think this is daf text being read, its own
    confidence doesn't clear LLM_MIN_CONFIDENCE, the call fails, or the
    response doesn't parse into a usable range.
    """
    import anthropic

    if len(run) < 2:
        return None

    lo = max(0, cursor - LLM_WINDOW_BACK)
    if forward_anchor is not None and forward_anchor > cursor:
        hi = min(len(canon), forward_anchor + LLM_ANCHOR_PAD)
    else:
        hi = min(len(canon), cursor + LLM_WINDOW_FWD)
    hi = min(hi, lo + LLM_WINDOW_MAX)
    if lo >= hi:
        return None
    window = canon[lo:hi]
    candidate_text = "\n".join(f"{i}: {w.text}" for i, w in enumerate(window))
    transcript_text = " ".join(w["text"] for w in run)

    anchor_note = ""
    if forward_anchor is not None and lo <= forward_anchor < hi:
        anchor_note = (
            f" Index {forward_anchor - lo} is where the rabbi is confirmed "
            f"to be reading again shortly after this transcript -- the "
            f"phrase you're placing should end at or before there."
        )

    client = client or anthropic.Anthropic()
    try:
        response = client.messages.create(
            model=ANTHROPIC_MODEL,
            max_tokens=1024,
            system=(
                "You resolve which exact phrase of a printed Talmud (Gemara) "
                "page a rabbi is reading aloud in a Daf Yomi shiur, from an "
                "imperfect speech-recognition transcript of that moment. The "
                "shiur is mostly English explanation, with the rabbi "
                "periodically reading the Hebrew/Aramaic text aloud -- often "
                "in Ashkenazi/Yeshivish pronunciation (e.g. transcribed as "
                "'amar Rav Yuda amar Shmuel' for אמר רב יהודה אמר שמואל). "
                "Expect transliteration and acoustic confusion in the "
                "transcript (vowels and similar-sounding letters are the "
                "least reliable part of it), not a literal match to the "
                "printed text. The numbered word list below is the actual "
                "printed daf -- ground truth. Never invent, correct, or "
                "reorder its wording; only select a contiguous range of "
                "indices from exactly what's listed. If the transcript "
                "doesn't correspond to any of these printed words, say so "
                "rather than forcing a match."
            ),
            messages=[{
                "role": "user",
                "content": (
                    f"Printed daf text, numbered (index {cursor - lo} is the "
                    f"reader's last confirmed position -- the rabbi is most "
                    f"likely at or somewhat past there, but may have jumped "
                    f"elsewhere).{anchor_note}\n{candidate_text}\n\n"
                    f"Speech-recognized transcript of what was just read "
                    f"aloud:\n{transcript_text}\n\n"
                    f"Which contiguous range of the numbered list above is "
                    f"being read right now?"
                ),
            }],
            output_config={"format": {"type": "json_schema", "schema": _LLM_RESCUE_SCHEMA}},
        )
    except anthropic.AuthenticationError:
        raise  # bad/missing key -- match_runs disables rescue for the rest of the job
    except anthropic.APIError as error:
        print(f"LLM rescue call failed ({error}); leaving this run unmatched.")
        return None

    text = next((b.text for b in response.content if b.type == "text"), None)
    if not text:
        return None
    try:
        result = json.loads(text)
    except json.JSONDecodeError:
        return None

    if not result.get("is_reading_daf_text"):
        return None
    confidence = result.get("confidence")
    if not isinstance(confidence, (int, float)) or confidence < LLM_MIN_CONFIDENCE:
        return None
    start_index, end_index = result.get("start_index"), result.get("end_index")
    if not isinstance(start_index, int) or not isinstance(end_index, int):
        return None
    if start_index > end_index or start_index < 0 or end_index >= len(window):
        return None  # out-of-range indices -- treat as an unusable response, not a crash

    s, e = lo + start_index, lo + end_index
    score = confidence * 100
    return s, e, score, score


# --- Iterative gap refinement --------------------------------------------
#
# match_runs (pass 0) is a single fast forward sweep -- by design it leaves
# real matches on the table: a run that misses the local search while
# locked is skipped outright (not even tried against global search or LLM
# rescue) until RELOCALIZE_AFTER consecutive misses pile up, and a
# pending-but-never-confirmed candidate is silently dropped rather than
# revisited. refine_matches (below) is a second stage that treats pass 0's
# output as a first draft: every run it left unresolved, or resolved at low
# confidence, gets reconsidered -- this time bounded by REAL confirmed
# anchors on both sides (not just a forward-looking guess), which is
# usually a dramatically tighter, more trustworthy search space than
# anything pass 0 could construct while still mid-sweep.
#
# It runs in passes because resolving one gap can create a brand new
# anchor immediately next to another still-unresolved gap, which is
# exactly the "revisit A/B/C once D resolves" behavior this whole design
# exists for. See refine_matches' own docstring for the convergence and
# cost-bounding mechanics.

# Hard ceiling on refinement passes, independent of the no-progress
# convergence check refine_matches uses to stop early -- a backstop against
# any pathological case that keeps finding *something* to change forever
# without actually converging.
MAX_REFINE_PASSES = 5
# Hard ceiling on total LLM calls spent refining ONE job, on top of
# whatever pass 0's own inline rescue already used. Gap-batching (one call
# per contiguous unresolved stretch, not one per run) already keeps normal
# per-pass call count low; this mostly guards a pathological video (bad
# audio throughout, most of the shiur ambiguous) against runaway cost
# rather than shaping the normal case.
MAX_REFINE_LLM_CALLS = 40
# A CONFIRMED match below this score is still eligible to be reconsidered
# if the anchors bounding it change. Deliberately a stricter "call this
# settled" bar than LLM_MIN_CONFIDENCE*100=60 or MIN_SCORE_GLOBAL=72, which
# are "trust this at all" floors, not "stop looking for something better"
# ones.
REVISIT_CONFIDENCE_THRESHOLD = 80
# A single LLM gap-rescue call's transcript block is capped at this many
# runs -- a very long unresolved stretch (bad audio throughout a whole
# section) gets split across several calls instead of one huge prompt.
GAP_MAX_RUNS_PER_CALL = 15

_LLM_GAP_SCHEMA = {
    "type": "object",
    "properties": {
        "resolutions": {
            "type": "array",
            "description": "One entry per transcript fragment you can confidently place. "
                            "Omit any fragment you can't place rather than forcing a match.",
            "items": {
                "type": "object",
                "properties": {
                    "run_index": {"type": "integer", "description": "Which [run N] fragment this resolves."},
                    "start_index": {"type": "integer", "description": "First index (from the numbered list) being read."},
                    "end_index": {"type": "integer", "description": "Last index (from the numbered list) being read, inclusive."},
                    "confidence": {"type": "number", "description": "0 to 1."},
                },
                "required": ["run_index", "start_index", "end_index", "confidence"],
                "additionalProperties": False,
            },
        },
    },
    "required": ["resolutions"],
    "additionalProperties": False,
}


def resolve_ambiguous_gap(canon, lo, hi, gap_runs, client=None):
    """Batch-resolve every run in one gap with a SINGLE LLM call, given
    firm anchors on both sides -- lo and hi are the real, already-confirmed
    canonical positions immediately bounding this gap (see refine_matches),
    not a guess, so unlike resolve_ambiguous_run's own window this one
    needs no padding or fallback distance.

    gap_runs is [(run_idx, run), ...] in audio order, all belonging to the
    same gap. Returns {run_idx: (s, e, score, score)} -- same 4-tuple shape
    match_phrase_dual/resolve_ambiguous_run use -- for every run the model
    placed with acceptable confidence. Silently omits (never guesses at)
    any run it isn't confident about.

    Batching the whole gap into one call, rather than one call per run,
    both cuts cost and gives the model strictly more to work with: the
    full, real transcript continuity across the gap, not one isolated
    fragment at a time.
    """
    import anthropic

    if hi <= lo or not gap_runs:
        return {}
    window = canon[lo:hi]
    candidate_text = "\n".join(f"{i}: {w.text}" for i, w in enumerate(window))
    transcript_block = "\n".join(
        f"[run {idx}] " + " ".join(w["text"] for w in run) for idx, run in gap_runs)

    client = client or anthropic.Anthropic()
    try:
        response = client.messages.create(
            model=ANTHROPIC_MODEL,
            max_tokens=2048,
            system=(
                "You resolve which exact phrases of a printed Talmud (Gemara) "
                "page a rabbi is reading aloud in a Daf Yomi shiur, from "
                "imperfect speech-recognition transcripts of several moments "
                "in a row -- all falling strictly between two positions in "
                "the printed text that are ALREADY confirmed by other means, "
                "so the true answer for every fragment is somewhere in the "
                "numbered list below (unless a fragment isn't daf text at "
                "all, e.g. a name or aside). The shiur is mostly English "
                "explanation, with the rabbi periodically reading the "
                "Hebrew/Aramaic text aloud -- often in Ashkenazi/Yeshivish "
                "pronunciation (e.g. transcribed as 'amar Rav Yuda amar "
                "Shmuel' for אמר רב יהודה אמר שמואל). Expect transliteration "
                "and acoustic confusion in the transcript, not a literal "
                "match. The numbered word list is the actual printed daf -- "
                "ground truth; never invent, correct, or reorder its "
                "wording. Each [run N] is a separate fragment, already in "
                "the order they were spoken -- if you place more than one, "
                "their printed-text ranges must stay in that same order "
                "too. Leave a fragment out of your answer entirely rather "
                "than forcing a match you're not confident in."
            ),
            messages=[{
                "role": "user",
                "content": (
                    f"Printed daf text between two confirmed positions, "
                    f"numbered:\n{candidate_text}\n\n"
                    f"Transcript fragments, in the order they were spoken:\n"
                    f"{transcript_block}\n\n"
                    f"For each fragment you can confidently place, give its "
                    f"contiguous range in the numbered list above."
                ),
            }],
            output_config={"format": {"type": "json_schema", "schema": _LLM_GAP_SCHEMA}},
        )
    except anthropic.AuthenticationError:
        raise  # bad/missing key -- refine_matches disables rescue for the rest of the job
    except anthropic.APIError as error:
        print(f"LLM gap-rescue call failed ({error}); leaving this gap unresolved.")
        return {}

    text = next((b.text for b in response.content if b.type == "text"), None)
    if not text:
        return {}
    try:
        result = json.loads(text)
    except json.JSONDecodeError:
        return {}

    valid_run_indices = {idx for idx, _ in gap_runs}
    resolved = {}
    for item in result.get("resolutions") or []:
        run_idx = item.get("run_index")
        if run_idx not in valid_run_indices or run_idx in resolved:
            continue  # unknown or duplicate run_index -- keep the first, ignore the rest
        confidence = item.get("confidence")
        if not isinstance(confidence, (int, float)) or confidence < LLM_MIN_CONFIDENCE:
            continue
        start_index, end_index = item.get("start_index"), item.get("end_index")
        if not isinstance(start_index, int) or not isinstance(end_index, int):
            continue
        if start_index > end_index or start_index < 0 or end_index >= len(window):
            continue  # out-of-range indices -- treat as an unusable response, not a crash
        s, e = lo + start_index, lo + end_index
        resolved[run_idx] = (s, e, confidence * 100, confidence * 100)

    # Order-preservation sanity check: resolved runs must land in the same
    # relative order they were spoken in, or the whole batch is untrustworthy
    # -- a response that reorders the reading got confused, and partially
    # trusting an internally-inconsistent answer risks corrupting the
    # timeline worse than just leaving the gap for manual review.
    ordered = [resolved[idx] for idx, _ in gap_runs if idx in resolved]
    if any(ordered[i][0] > ordered[i + 1][0] for i in range(len(ordered) - 1)):
        print("LLM gap-rescue response was internally out of order; discarding it.")
        return {}
    return resolved


def refine_matches(canon, runs, run_matches, llm_client=None, debug=False,
                    max_passes=MAX_REFINE_PASSES, max_llm_calls=MAX_REFINE_LLM_CALLS):
    """Iteratively revisit whatever pass 0 (match_runs) left unresolved or
    low-confidence, using newly established anchors as tightening context --
    "solve the puzzle" rather than "transcribe once and stop" (see the
    section docstring above). Mutates run_matches IN PLACE; returns
    (llm_calls_used, passes_run).

    One pass = one left-to-right sweep grouping consecutive not-yet-settled
    runs (None, or a confirmed match below REVISIT_CONFIDENCE_THRESHOLD)
    into gaps, each bounded by the nearest settled run on either side (or
    the sequence's own start/end). For each gap:

      1. Retry match_phrase_dual for every run in it, restricted to the
         tight span between the two real bounding anchors -- free (no
         network), and can succeed here even where pass 0's search failed,
         because the search space collapsed from "the whole canon" (global
         search's floor is the strict MIN_SCORE_GLOBAL) to a few dozen
         words between two known points (the more lenient LOCAL floor
         applies -- see match_phrase_dual's window= handling).
      2. Whatever's still unresolved (plus anything already resolved but
         below REVISIT_CONFIDENCE_THRESHOLD) goes to ONE batched LLM call
         per gap (resolve_ambiguous_gap), chunked at GAP_MAX_RUNS_PER_CALL
         runs per call for a very long stretch.
      3. A revised match only overwrites an existing one if it scores
         higher -- this stage only ever improves the picture, never
         quietly downgrades it.

    A gap is only re-attempted in a later pass if its bounding anchors
    actually changed since the last attempt (tracked per run index) --
    otherwise nothing about the evidence changed and repeating the call
    would just burn budget on the same answer. Since gaps only ever shrink
    and their boundaries only ever tighten, this signature check both
    keeps cost down AND guarantees the loop reaches a fixed point: once a
    full pass changes nothing, every gap's signature is identical to what
    was already tried, so the next pass (if it ran at all) would too --
    stopping there is exact, not just a heuristic. max_passes/max_llm_calls
    are backstops on top of that, not the primary stopping mechanism.
    """
    if llm_client is not None:
        import anthropic
    n = len(runs)
    last_signature = {}  # run_idx -> (prev_anchor_idx, next_anchor_idx) last attempted with
    llm_calls = 0
    passes_run = 0

    for _pass_num in range(max_passes):
        passes_run += 1
        changed = False
        i = 0
        while i < n:
            match = run_matches[i]
            if match is not None and match["score"] >= REVISIT_CONFIDENCE_THRESHOLD:
                i += 1
                continue
            j = i
            while j < n:
                m = run_matches[j]
                if m is not None and m["score"] >= REVISIT_CONFIDENCE_THRESHOLD:
                    break
                j += 1
            gap_indices = list(range(i, j))
            prev_idx = i - 1 if i > 0 else None
            next_idx = j if j < n else None
            signature = (prev_idx, next_idx)

            if all(last_signature.get(idx) == signature for idx in gap_indices):
                i = j
                continue
            for idx in gap_indices:
                last_signature[idx] = signature

            lo = run_matches[prev_idx]["e"] + 1 if prev_idx is not None else 0
            hi = run_matches[next_idx]["s"] if next_idx is not None else len(canon)
            hi = min(hi, lo + LLM_WINDOW_MAX)
            if lo >= hi:
                i = j
                continue

            gap_runs = [(idx, runs[idx]) for idx in gap_indices]
            resolved_this_gap = {}

            # 1) Deterministic retry first, in the now-tight window.
            for idx, run in gap_runs:
                hl_norm = [w["norm"] for w in run]
                hl_phon = [w["phon"] for w in run]
                m = match_phrase_dual(canon, hl_norm, hl_phon, 0, window=(lo, hi))
                if m is not None:
                    s, e, phon_score, _char_score = m
                    resolved_this_gap[idx] = (s, e, phon_score, "deterministic-relocalized")

            # 2) Whatever's left, batched into as few LLM calls as
            #    GAP_MAX_RUNS_PER_CALL allows.
            still_unresolved = [(idx, run) for idx, run in gap_runs if idx not in resolved_this_gap]
            for chunk_start in range(0, len(still_unresolved), GAP_MAX_RUNS_PER_CALL):
                if llm_client is None or llm_calls >= max_llm_calls:
                    break
                chunk = still_unresolved[chunk_start:chunk_start + GAP_MAX_RUNS_PER_CALL]
                llm_calls += 1
                try:
                    llm_results = resolve_ambiguous_gap(canon, lo, hi, chunk, client=llm_client)
                except anthropic.AuthenticationError as error:
                    print(f"LLM gap-rescue disabled for the rest of this job ({error}).")
                    llm_client = None
                    llm_results = {}
                for idx, (s, e, score, _char) in llm_results.items():
                    resolved_this_gap[idx] = (s, e, score, "llm-rescue")

            # Apply -- never overwrite an existing match with a worse one.
            for idx, (s, e, score, source) in resolved_this_gap.items():
                existing = run_matches[idx]
                if existing is not None and existing["score"] >= score:
                    continue
                run_matches[idx] = {"s": s, "e": e, "score": score, "source": source}
                changed = True
                if debug:
                    print(f"  refine pass {passes_run}: run {idx} -> [{s}-{e}] {source} score={score:.1f}")

            i = j

        if not changed:
            break

    return llm_calls, passes_run


# Human-readable labels for match_runs'/refine_matches' matchStats.bySource,
# and for the console/UI rundown built from it -- see _build_match_stats.
MATCH_SOURCE_LABELS = {
    "deterministic-local": "Deterministic matching (locked tracking)",
    "deterministic-global": "Deterministic matching (relocalized)",
    "deterministic-relocalized": "Deterministic matching (re-checked between anchors)",
    "llm-rescue": "LLM rescue (Claude)",
}


def _build_match_stats(runs, run_matches, passes=1, llm_calls=0):
    """Per-mechanism word/run counts, plus the actual unmatched runs
    (heard text + timestamps), for the "how many words did each tool
    match, and which ones weren't matched at all" rundown surfaced to an
    admin after a job finishes (see build_outputs/main -- this gets
    embedded straight into the published alignment as `matchStats`).

    run_matches is a same-length list of either None (never resolved by
    anything, through every pass) or {"s","e","score","source"} -- source
    is a MATCH_SOURCE_LABELS key."""
    stats = {
        "totalRuns": len(runs),
        "totalWords": sum(len(r) for r in runs),
        "matchedWords": 0,
        "unmatchedWords": 0,
        "bySource": {},
        "unmatched": [],
        "passes": passes,
        "llmCalls": llm_calls,
    }
    for run, match in zip(runs, run_matches):
        words = len(run)
        if match is None:
            stats["unmatchedWords"] += words
            stats["unmatched"].append({
                "start": round(run[0]["start"], 2),
                "end": round(run[-1]["end"], 2),
                "text": " ".join(w["text"] for w in run),
            })
            continue
        stats["matchedWords"] += words
        bucket = stats["bySource"].setdefault(
            match["source"], {"label": MATCH_SOURCE_LABELS.get(match["source"], match["source"]),
                               "runs": 0, "words": 0})
        bucket["runs"] += 1
        bucket["words"] += words
    return stats


def _make_events(run, s, e, score):
    """One WordEvent per real sub-chunk of the run's own ASR word timings
    (see RUN_SUBCHUNK_WORDS/RUN_PAUSE_GAP_SECONDS), proportionally mapped
    onto the matched canonical span -- rather than one event anchored to
    just run[0]'s time for the whole thing."""
    k = len(run)
    span = e - s + 1
    ranges = []
    chunk_start = 0
    for i in range(1, k):
        gap = run[i]["start"] - run[i - 1]["end"]
        if gap > RUN_PAUSE_GAP_SECONDS or (i - chunk_start) >= RUN_SUBCHUNK_WORDS:
            ranges.append((chunk_start, i - 1))
            chunk_start = i
    ranges.append((chunk_start, k - 1))

    out = []
    for w0, w1 in ranges:
        cs = s + min(span - 1, round(span * w0 / k))
        ce = max(cs, s + min(span - 1, round(span * (w1 + 1) / k) - 1))
        out.append(WordEvent(round(run[w0]["start"], 2), cs, ce, round(score, 1),
                              " ".join(w["text"] for w in run[w0:w1 + 1])))
    return out


def _build_events(runs, run_matches):
    """Materialize the final WordEvent list from run_matches, once -- after
    pass 0 AND every refine_matches pass have finished. Kept separate from
    match_runs' own loop so a later pass can revise a run's match (upgrade
    its score, or resolve it for the first time) by just editing
    run_matches in place, without anything having already committed
    irreversible events for it."""
    events = []
    for run, match in zip(runs, run_matches):
        if match is None:
            continue
        events.extend(_make_events(run, match["s"], match["e"], match["score"]))
    return events


def match_runs(canon, runs, debug=False, llm_rescue=False):
    """The cursor/lock/relocalize/pending-confirmation state machine (see
    module docstring point 2) -- pass 0 of the overall pipeline, a single
    fast forward sweep. Returns (run_matches, llm_calls): run_matches is a
    list, one entry per run, of either None (never confirmed) or
    {"s", "e", "score", "source"}; llm_calls is how many rescue calls this
    pass made. Whatever's left None, or confirmed at low confidence, is
    handed to refine_matches for further passes -- see process_video and
    that function's own docstring for the full picture; this function's
    output isn't final on its own.

    llm_rescue additionally tries resolve_ambiguous_run for any run global
    fuzzy/phonetic matching can't place at all, rather than just discarding
    it (see that function's own docstring) -- including a forward-looking
    peek (find_forward_anchor) at the next run deterministic matching will
    itself confidently place later, so the rescue call gets a real
    evidence-based right edge for its candidate window instead of only
    ever guessing a fixed distance forward."""
    cursor = 0
    locked = False
    local_misses = 0
    pending = None
    run_matches = [None] * len(runs)
    llm_calls = 0
    llm_client = None
    if llm_rescue:
        import anthropic
        llm_client = anthropic.Anthropic()

    for idx, run in enumerate(runs):
        hl_norm = [w["norm"] for w in run]
        hl_phon = [w["phon"] for w in run]

        if locked:
            m = match_phrase_dual(canon, hl_norm, hl_phon, cursor)
            if m is not None:
                s, e, phon_score, char_score = m
                cursor = s
                local_misses = 0
                run_matches[idx] = {"s": s, "e": e, "score": phon_score, "source": "deterministic-local"}
                if debug:
                    print(f"  t={run[0]['start']:7.2f}  [{s}-{e}] phon={phon_score:.1f} char={char_score:.1f}  "
                          f"{' '.join(w['text'] for w in run)}")
                continue
            local_misses += 1
            if local_misses < RELOCALIZE_AFTER:
                continue
            locked = False  # lost the lock -- fall through to relocalizing below

        m = match_phrase_dual(canon, hl_norm, hl_phon, cursor, global_search=True)
        source = "deterministic-global"
        if m is None and llm_client is not None:
            # A real anchor -- the next run deterministic matching will
            # itself confidently place, whether or not it's been reached
            # yet -- gives the rescue call a tighter, evidence-based window
            # than blindly guessing LLM_WINDOW_FWD words forward.
            anchor = find_forward_anchor(canon, runs, idx + 1, cursor)
            llm_calls += 1
            try:
                m = resolve_ambiguous_run(canon, cursor, run, forward_anchor=anchor, client=llm_client)
            except anthropic.AuthenticationError as error:
                # A bad/missing key will fail identically on every remaining
                # run -- disable rescue for the rest of the job rather than
                # repeating (and logging) the same failure for each one.
                print(f"LLM rescue disabled for the rest of this job ({error}).")
                llm_client = None
            if m is not None:
                source = "llm-rescue"
                if debug:
                    anchor_note = f" (anchored to word {anchor})" if anchor is not None else ""
                    print(f"  t={run[0]['start']:7.2f}  LLM rescue -> [{m[0]}-{m[1]}] "
                          f"confidence={m[2]:.1f}{anchor_note}")
        if m is None:
            pending = None  # an unmatched run in between breaks any pending candidate
            continue
        s, e, phon_score, char_score = m
        if pending is not None and s >= pending["s"] and s - pending["s"] <= FWD_WINDOW:
            # Two consecutive global matches agreeing on forward progression
            # -- confirmed. Both the pending run and this one are now
            # trusted; the pending one was withheld until now.
            run_matches[pending["idx"]] = {"s": pending["s"], "e": pending["e"],
                                            "score": pending["phon_score"], "source": pending["source"]}
            run_matches[idx] = {"s": s, "e": e, "score": phon_score, "source": source}
            cursor = s
            locked = True
            local_misses = 0
            pending = None
            if debug:
                print(f"  t={run[0]['start']:7.2f}  LOCK confirmed at [{s}-{e}]")
        else:
            pending = {"s": s, "e": e, "phon_score": phon_score, "char_score": char_score,
                       "run": run, "idx": idx, "source": source}

    return run_matches, llm_calls


# The env vars anthropic.Anthropic() itself reads for workload identity
# federation (see https://platform.claude.com/docs/en/manage-claude/wif-reference)
# -- all four of RULE_ID/ORGANIZATION_ID/SERVICE_ACCOUNT_ID and one of the
# two token vars must be set for the SDK to attempt a federated exchange.
_ANTHROPIC_WIF_ENV_VARS = (
    "ANTHROPIC_FEDERATION_RULE_ID", "ANTHROPIC_ORGANIZATION_ID", "ANTHROPIC_SERVICE_ACCOUNT_ID",
)
_ANTHROPIC_WIF_TOKEN_ENV_VARS = ("ANTHROPIC_IDENTITY_TOKEN_FILE", "ANTHROPIC_IDENTITY_TOKEN")


def _anthropic_credentials_available():
    """Whether anthropic.Anthropic() has any plausible way to authenticate
    -- a plain API key/auth token, workload identity federation (voice-
    job.yml's own setup, as of the WIF migration -- see that file), or a
    named profile. Mirrors the SDK's own credential precedence so llm_rescue
    auto-detects correctly regardless of which of those a given job
    actually has configured, the same way a bare ANTHROPIC_API_KEY check
    alone used to gate this before WIF was wired in."""
    env = os.environ
    if env.get("ANTHROPIC_API_KEY") or env.get("ANTHROPIC_AUTH_TOKEN"):
        return True
    if env.get("ANTHROPIC_PROFILE"):
        return True
    if all(env.get(name) for name in _ANTHROPIC_WIF_ENV_VARS) \
            and any(env.get(name) for name in _ANTHROPIC_WIF_TOKEN_ENV_VARS):
        return True
    return False


def process_video(video_path, refs, model_size="small", cache_dir=None, debug=False,
                  engine="whisper", fallback=True, llm_rescue=None, refine=True):
    canon, segments = load_canonical(refs, cache_dir)
    print(f"Canonical text: {len(segments)} segments, {len(canon)} words")
    for c in canon:
        c.phon = phonetic(c.norm)

    words = duration = None
    if engine == "elevenlabs":
        keyterms = build_keyterm_list(canon, max_terms=ELEVENLABS_MAX_KEYTERMS)
        if debug:
            print(f"Keyterms ({len(keyterms)}): {' '.join(keyterms[:40])}...")
        try:
            words, duration = transcribe_elevenlabs(video_path, keyterms=keyterms)
        except Exception as error:
            # A missing key, a rate limit, an API outage -- none of these are
            # reasons to fail a sync job outright when a working local engine
            # is sitting right here. Falls back rather than dying, loudly
            # enough that a silently-degraded run is still obvious in the log.
            if not fallback:
                raise
            print(f"ElevenLabs transcription failed ({error}); "
                  f"falling back to local whisper.")
            words = duration = None

    if words is None:
        prompt = build_keyterm_prompt(canon)
        if debug and prompt:
            print(f"Keyterm prompt ({len(prompt.split())} words): {prompt}")
        words, duration = transcribe(video_path, model_size, initial_prompt=prompt)
    print(f"Transcribed {len(words)} words ({duration:.1f}s audio)")
    runs = hebrew_script_runs(words)
    print(f"{len(runs)} Hebrew-script word runs")

    if llm_rescue is None:
        llm_rescue = _anthropic_credentials_available()
    run_matches, llm_calls = match_runs(canon, runs, debug=debug, llm_rescue=llm_rescue)

    refine_passes = 0
    if refine and runs:
        # Deterministic re-checking between real anchors always runs, LLM-
        # or-not -- it's free and strictly additive. The LLM half of it
        # only runs if pass 0's own rescue would have (same env/flag gate).
        llm_client = None
        if llm_rescue:
            import anthropic
            llm_client = anthropic.Anthropic()
        refine_calls, refine_passes = refine_matches(canon, runs, run_matches, llm_client=llm_client, debug=debug)
        llm_calls += refine_calls

    events = _build_events(runs, run_matches)
    stats = _build_match_stats(runs, run_matches, passes=1 + refine_passes, llm_calls=llm_calls)
    print(f"Matched {stats['matchedWords']} of {stats['totalWords']} words "
          f"({stats['passes']} pass{'es' if stats['passes'] != 1 else ''}, "
          f"{stats['llmCalls']} LLM call{'s' if stats['llmCalls'] != 1 else ''})")
    for bucket in stats["bySource"].values():
        print(f"  {bucket['label']}: {bucket['words']} words ({bucket['runs']} runs)")
    if stats["unmatched"]:
        print(f"  Not matched -- left for manual review: {stats['unmatchedWords']} words "
              f"({len(stats['unmatched'])} runs)")

    return canon, segments, events, duration, stats


def main():
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("video")
    p.add_argument("--refs-json", required=True,
                   help='Sefaria refs as a JSON array string, e.g. \'["Chullin 95a", "Chullin 95b"]\'.')
    p.add_argument("--model", default="small", help="faster-whisper model size (default: small)")
    p.add_argument("--engine", default=os.environ.get("VOICE_ENGINE", "whisper"),
                   choices=["whisper", "elevenlabs"],
                   help="Transcription engine (default: whisper, or $VOICE_ENGINE). "
                        "'elevenlabs' needs $ELEVENLABS_API_KEY and falls back to "
                        "whisper if the API call fails, unless --no-fallback.")
    p.add_argument("--no-fallback", action="store_true",
                   help="Fail outright instead of falling back to local whisper when "
                        "--engine elevenlabs errors. Use when comparing engines, so a "
                        "silent fallback can't be mistaken for an ElevenLabs result.")
    p.add_argument("--llm-rescue", dest="llm_rescue", action="store_true", default=None,
                   help="Use Claude to resolve Hebrew-script runs deterministic "
                        "matching can't place at all, instead of discarding them "
                        "(default: on automatically if the anthropic SDK has any "
                        "usable credentials -- an API key or workload identity "
                        "federation -- see _anthropic_credentials_available).")
    p.add_argument("--no-llm-rescue", dest="llm_rescue", action="store_false",
                   help="Disable the LLM rescue step even if Anthropic credentials are available.")
    p.add_argument("--no-refine", dest="refine", action="store_false", default=True,
                   help="Skip the iterative gap-refinement passes after pass 0 (see "
                        "refine_matches) -- pass 0's own single sweep is the final result. "
                        "Mainly for comparing the two stages against each other.")
    p.add_argument("--out-dir", default="out")
    p.add_argument("--debug", action="store_true")
    args = p.parse_args()

    refs = json.loads(args.refs_json)
    os.makedirs(args.out_dir, exist_ok=True)
    canon, segments, events, duration, stats = process_video(
        args.video, refs, model_size=args.model, cache_dir=args.out_dir, debug=args.debug,
        engine=args.engine, fallback=not args.no_fallback, llm_rescue=args.llm_rescue,
        refine=args.refine)
    if not events:
        print("No confident matches found -- check the audio and refs.")
        sys.exit(1)

    alignment, word_map = build_outputs(
        canon, segments, events, duration, args.video, refs,
        generator="voice_align.py", title_prefix="Voice recognition alignment")
    # Embedded straight into the published alignment (publish_alignment.py
    # dumps this dict as-is) so the reader who ran the sync can see the
    # rundown -- which tool matched how much, and what was never matched at
    # all -- without digging through the Actions log. See app.js's
    # pollServerSyncResult for where this surfaces in the sync dialog.
    alignment["matchStats"] = stats

    a_path = os.path.join(args.out_dir, "alignment.json")
    w_path = os.path.join(args.out_dir, "wordmap.json")
    json.dump(alignment, open(a_path, "w", encoding="utf-8"), ensure_ascii=False, indent=2)
    json.dump(word_map, open(w_path, "w", encoding="utf-8"), ensure_ascii=False, indent=2)
    print(f"Wrote {a_path} ({len(alignment['segments'])} segments)")
    print(f"Wrote {w_path} ({len(word_map['entries'])} word-span entries)")


if __name__ == "__main__":
    main()
