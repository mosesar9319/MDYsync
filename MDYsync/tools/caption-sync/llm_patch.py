#!/usr/bin/env python3
"""Claude places what the path could not: the daf words left between two placed
phrases, from the transcript of just that stretch.

After path_align.py has placed a shiur, some daf words are still nowhere. Read
with the stretch of transcript they must be in, most of them are plainly there:
the maggid said them and the transcriber wrote something no string comparison
recognises ("ומשום יוסף" for ומשום יתום, "כונסין לדיר לעשה" for כונסן לדיר
להתעשר, "אי אמרי לכתמנאסרת" for אי אמרת ליקדים ליעשר). On R' Bornstein's
Bechoros 58, 22 of the 25 holes left after the free fixes were like that. Others
he never read aloud at all, only explained in English.

So each hole goes to Claude as one bounded question: here are the missing daf
words, with the placed words either side; here is everything heard between those
two placed moments, numbered; which heard words are which missing words? An
answer can only point inside the hole and inside its stretch of transcript, so a
wrong one is a few seconds off, never on another line.

This is not voice_align.py's older Claude step (resolve_ambiguous_run), which
asked the open question "where on the daf does this phrase belong", 110 times a
shiur, and whose answers the path then discarded.

Two kinds of answer:
  read       he says those words there. Placed, and counted as matched.
  explained  he does not say them, but explains exactly that phrase there. The
             line is highlighted while he explains it; these words are counted
             on their own (dafWordsExplained), never as matched.

Costs Claude usage (reported per job in matchStats.claude), no ElevenLabs
credits. Runs only where the job has Anthropic credentials.
"""
import bisect
import json
from collections import namedtuple

from caption_ocr_align import WordEvent

MODEL = "claude-opus-5-5"
EFFORT = "medium"
MAX_TOKENS = 16000
FALLBACK_BETA = "server-side-fallback-2026-07-01"

SOURCE_READ = "claude-read"
SOURCE_EXPLAINED = "claude-explained"
SOURCE_LABELS = {
    SOURCE_READ: "Placed by Claude between two placed phrases (said, but garbled in the transcript)",
    SOURCE_EXPLAINED: "Explained without being read (highlighted, not counted as matched)",
}

CONTEXT_WORDS = 4            # placed daf words shown either side of a hole
OPEN_END_SECONDS = 120.0     # how far a hole at the daf's very start or end may reach
MAX_GAP_SECONDS = 480.0      # a longer stretch is not one hole's worth of transcript
MAX_GAP_HEARD_WORDS = 1800
PAD_BEFORE_SECONDS = 1.0     # transcript shown before the first placed moment...
PAD_AFTER_SECONDS = 3.0      # ...and after the second
MAX_BATCH_HEARD_WORDS = 3000  # one request's worth of transcript
MAX_BATCH_GAPS = 12
MAX_CALLS = 40
MIN_CONFIDENCE = 0.7
# A read answer may not claim far more speech than the words take to say.
READ_MAX_HEARD_PER_DAF_WORD = 4
READ_HEARD_SLACK = 3

Gap = namedtuple("Gap", "lo hi t0 t1 a b")   # daf words [lo, hi]; heard words [a, b) between t0 and t1

SCHEMA = {
    "type": "object",
    "properties": {
        "gaps": {
            "type": "array",
            "items": {
                "type": "object",
                "properties": {
                    "gap": {"type": "integer"},
                    "placements": {
                        "type": "array",
                        "items": {
                            "type": "object",
                            "properties": {
                                "first_missing": {"type": "integer"},
                                "last_missing": {"type": "integer"},
                                "first_heard": {"type": "integer"},
                                "last_heard": {"type": "integer"},
                                "kind": {"type": "string", "enum": ["read", "explained"]},
                                "confidence": {"type": "number"},
                            },
                            "required": ["first_missing", "last_missing", "first_heard", "last_heard",
                                         "kind", "confidence"],
                            "additionalProperties": False,
                        },
                    },
                },
                "required": ["gap", "placements"],
                "additionalProperties": False,
            },
        },
    },
    "required": ["gaps"],
    "additionalProperties": False,
}

SYSTEM = """You are finishing the alignment of a recorded Daf Yomi shiur to the printed text of the Gemara.

A rabbi reads the daf aloud phrase by phrase, usually in Ashkenazi or yeshivish pronunciation, and explains it in English as he goes. A speech-to-text system transcribed the recording. Its transcript is imperfect in a particular way: the English is mostly right, but the Hebrew and Aramaic the rabbi reads come out garbled. Words are run together or split, written in Hebrew letters or in English-letter transliteration, replaced by similar-sounding words, or cut off. For example "ומשום יוסף" was written where he read ומשום יתום, "כונסין לדיר לעשה" for כונסן לדיר להתעשר, "samech leish" for סמוך לאיש, and "אי אמרי לכתמנאסרת" for אי אמרת ליקדים ליעשר.

Another program has already placed most of the daf's words at the moment they are read. You get the holes it left. Each hole is a run of consecutive daf words it could not find, lying between two daf phrases it did place, and the full transcript of what was said between those two placed moments. Because the rabbi reads in order, the missing words, if he said them, are somewhere in that stretch.

For each hole, decide where its missing words are in the transcript.

- "read": he says those daf words there, in any pronunciation and however badly transcribed. Give the heard words that are his saying of them, and nothing more: not the English explanation around them.
- "explained": he does not say those daf words anywhere in the stretch, but at that point he explains or translates exactly that phrase in English. Give the heard words where the explanation of that phrase begins and ends. Use this only when the missing words are not read at all in the stretch.
- Leave out any missing words you cannot find either way. Leaving words out is always acceptable; a confident wrong placement is not.

Rules the answer must keep:
- The missing words are numbered M0, M1, ... within their hole, and the heard words carry their own numbers. Refer to both by those numbers only.
- A placement covers a run of consecutive missing words and a run of consecutive heard words.
- Within a hole, placements go in order: later missing words at later heard words. Two placements never share a missing word.
- The daf words shown before and after the hole are already placed. Do not give their heard words to the missing ones. The stretch often begins with the end of the phrase before and ends with the start of the phrase after.
- The rabbi often repeats a phrase he has already read while explaining it. If the missing words are said more than once, give the first time he reads them.
- confidence is your probability, from 0 to 1, that the placement is right."""


def find_gaps(canon, events, counted, heard, duration=None):
    """The holes worth asking about: [Gap] for every run of consecutive daf words
    in `counted` that no event placed, with the stretch of `heard` (a transcript,
    [{text, start, end}]) between the placed moments either side of it."""
    times = {}
    for event in events:
        for i in range(event.start_idx, event.end_idx + 1):
            times.setdefault(i, []).append(event.t)
    starts = [w["start"] for w in heard]
    end_of_audio = duration or (heard[-1]["end"] if heard else 0.0)
    gaps = []
    i, n = 0, len(canon)
    while i < n:
        if i in times or i not in counted:
            i += 1
            continue
        lo = i
        while i < n and i not in times and i in counted:
            i += 1
        hi = i - 1
        before = times.get(lo - 1)
        after = times.get(hi + 1)
        if before and after:
            # The two moments closest together with the hole between them.
            pairs = [(y - x, x, y) for x in before for y in after if y >= x]
            if not pairs:
                continue   # read out of order here: no stretch to look in
            _, t0, t1 = min(pairs)
        elif before:
            t0 = max(before)
            t1 = min(end_of_audio, t0 + OPEN_END_SECONDS)
        elif after:
            t1 = min(after)
            t0 = max(0.0, t1 - OPEN_END_SECONDS)
        else:
            continue       # nothing placed next to it at all
        if t1 - t0 > MAX_GAP_SECONDS:
            continue
        a = bisect.bisect_left(starts, t0 - PAD_BEFORE_SECONDS)
        b = bisect.bisect_right(starts, t1 + PAD_AFTER_SECONDS)
        if b <= a or b - a > MAX_GAP_HEARD_WORDS:
            continue
        gaps.append(Gap(lo, hi, t0, t1, a, b))
    return gaps


def batches(gaps):
    """The gaps in requests of at most MAX_BATCH_GAPS and MAX_BATCH_HEARD_WORDS."""
    out, current, size = [], [], 0
    for gap in gaps:
        words = gap.b - gap.a
        if current and (len(current) >= MAX_BATCH_GAPS or size + words > MAX_BATCH_HEARD_WORDS):
            out.append(current)
            current, size = [], 0
        current.append(gap)
        size += words
    if current:
        out.append(current)
    return out


def describe(canon, heard, batch):
    """The user message for one request: each hole with its context and transcript."""
    parts = []
    for n, gap in enumerate(batch):
        before = " ".join(c.text for c in canon[max(0, gap.lo - CONTEXT_WORDS):gap.lo]) or "(the start of the text)"
        after = " ".join(c.text for c in canon[gap.hi + 1:gap.hi + 1 + CONTEXT_WORDS]) or "(the end of the text)"
        missing = "\n".join(f"M{k}: {canon[gap.lo + k].text}" for k in range(gap.hi - gap.lo + 1))
        said = " ".join(f"[{i}] {heard[i]['text']}" for i in range(gap.a, gap.b))
        parts.append(
            f"<hole number=\"{n}\">\n"
            f"<placed_before>{before}</placed_before>\n"
            f"<missing>\n{missing}\n</missing>\n"
            f"<placed_after>{after}</placed_after>\n"
            f"<heard seconds=\"{gap.t1 - gap.t0:.0f}\">\n{said}\n</heard>\n"
            f"</hole>")
    return ("\n\n".join(parts)
            + "\n\nFor each hole, give the placements of its missing words. Include every hole in your answer, "
              "with an empty list of placements where you place nothing.")


def accept(batch, answer, heard):
    """The placements of one answer that can be trusted, as
    [(gap, first daf word, last daf word, first heard word, last heard word, kind, confidence)].
    Anything out of range, out of order, overlapping or implausible is dropped; a
    hole whose placements contradict each other is dropped whole."""
    kept = []
    seen = set()
    items = answer.get("gaps") if isinstance(answer, dict) else None
    for item in items if isinstance(items, list) else []:
        n = item.get("gap") if isinstance(item, dict) else None
        if not isinstance(n, int) or isinstance(n, bool) or not 0 <= n < len(batch) or n in seen:
            continue
        seen.add(n)
        gap = batch[n]
        size = gap.hi - gap.lo + 1
        good = []
        placements = item.get("placements")
        for p in placements if isinstance(placements, list) else []:
            if not isinstance(p, dict):
                continue
            m0, m1, h0, h1 = (p.get(k) for k in ("first_missing", "last_missing", "first_heard", "last_heard"))
            kind, confidence = p.get("kind"), p.get("confidence")
            if not all(isinstance(v, int) and not isinstance(v, bool) for v in (m0, m1, h0, h1)):
                continue
            if kind not in ("read", "explained") or not isinstance(confidence, (int, float)):
                continue
            if confidence < MIN_CONFIDENCE or not 0 <= m0 <= m1 < size or not gap.a <= h0 <= h1 < gap.b:
                continue
            if kind == "read" and h1 - h0 + 1 > READ_MAX_HEARD_PER_DAF_WORD * (m1 - m0 + 1) + READ_HEARD_SLACK:
                continue
            good.append((m0, m1, h0, h1, kind, float(confidence)))
        good.sort()
        ordered = all(x[1] < y[0] and x[3] <= y[2] and heard[x[2]]["start"] <= heard[y[2]]["start"]
                      for x, y in zip(good, good[1:]))
        if not ordered:
            continue
        kept += [(gap, gap.lo + m0, gap.lo + m1, h0, h1, kind, confidence) for m0, m1, h0, h1, kind, confidence in good]
    return kept


def ask(client, canon, heard, batch, refresh=None):
    """One request. Returns (answer dict or None, usage dict)."""
    import anthropic
    if refresh:
        refresh()
    usage = {"calls": 1, "inputTokens": 0, "outputTokens": 0}
    try:
        response = client.beta.messages.create(
            model=MODEL,
            max_tokens=MAX_TOKENS,
            betas=[FALLBACK_BETA],
            fallbacks="default",
            system=SYSTEM,
            messages=[{"role": "user", "content": describe(canon, heard, batch)}],
            output_config={"effort": EFFORT, "format": {"type": "json_schema", "schema": SCHEMA}},
        )
    except (anthropic.AuthenticationError, anthropic.PermissionDeniedError, anthropic.WorkloadIdentityError):
        raise   # no point asking again this job: patch() stops
    except anthropic.RateLimitError as error:
        print(f"  Claude is rate limited ({error.message}); leaving {len(batch)} hole(s) as they are.")
        return None, usage
    except anthropic.APIStatusError as error:
        print(f"  Claude answered {error.status_code} ({error.message}); leaving {len(batch)} hole(s) as they are.")
        return None, usage
    except anthropic.APIConnectionError as error:
        print(f"  Claude could not be reached ({error}); leaving {len(batch)} hole(s) as they are.")
        return None, usage
    if response.usage:
        usage["inputTokens"] = response.usage.input_tokens or 0
        usage["outputTokens"] = response.usage.output_tokens or 0
    if response.stop_reason != "end_turn":
        print(f"  Claude stopped early ({response.stop_reason}); leaving {len(batch)} hole(s) as they are.")
        return None, usage
    text = next((block.text for block in response.content if block.type == "text"), None)
    try:
        return (json.loads(text) if text else None), usage
    except json.JSONDecodeError:
        return None, usage


def patch(canon, events, counted, heard, duration=None, client=None, refresh=None, ask_claude=ask):
    """Asks Claude about every hole and returns (new events, stats).

    events: what the path placed (WordEvents). counted: the canon indices the
    shiur is measured against (path_align.counted_words). heard: the transcript
    made with hints. The new events are WordEvents with source SOURCE_READ or
    SOURCE_EXPLAINED; stats says how many daf words each placed, and what the
    requests used.
    """
    import anthropic
    gaps = find_gaps(canon, events, counted, heard, duration)
    stats = {"model": MODEL, "holes": len(gaps), "holeWords": sum(g.hi - g.lo + 1 for g in gaps),
             "calls": 0, "inputTokens": 0, "outputTokens": 0, "readWords": 0, "explainedWords": 0}
    if not gaps:
        return [], stats
    client = client or anthropic.Anthropic()
    new_events = []
    for batch in batches(gaps)[:MAX_CALLS]:
        try:
            answer, usage = ask_claude(client, canon, heard, batch, refresh)
        except (anthropic.AuthenticationError, anthropic.PermissionDeniedError, anthropic.WorkloadIdentityError) as error:
            print(f"  Claude refused the job's credentials ({error}); no more holes are asked about.")
            break
        for key in ("calls", "inputTokens", "outputTokens"):
            stats[key] += usage.get(key, 0)
        for gap, s, e, h0, h1, kind, confidence in accept(batch, answer, heard):
            source = SOURCE_READ if kind == "read" else SOURCE_EXPLAINED
            said = " ".join(heard[i]["text"] for i in range(h0, h1 + 1))
            new_events.append(WordEvent(round(heard[h0]["start"], 2), s, e, round(confidence * 100, 1), said, source))
            stats["readWords" if kind == "read" else "explainedWords"] += e - s + 1
    new_events.sort(key=lambda event: (event.t, event.start_idx))
    return new_events, stats
