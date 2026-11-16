#!/usr/bin/env python3
"""Words a maggid says in a DIFFERENT FORM from the daf, written back the daf's way.

When a maggid reads the Gemara he does not always say what is printed. Found on
R' Sruly Bornstein's Bechoros 58 (the test shiur), where the voice engine could not
place these words at all:

  * Counting. The daf has אֶחָד, שְׁנַיִם, שְׁלֹשָׁה ... and he counts "Alef, Beis,
    Gimel, Daled ..." (or "one, two, three").
  * Dates. The daf has בְּעֶשְׂרִים וְתִשְׁעָה בֶּאֱלוּל and he says "the twenty-ninth
    day of Elul"; בְּאֶחָד בֶּאֱלוּל comes out as "Rosh Chodesh Elul".
  * A few words he swaps for a twin: לְטַעְמֵיהּ becomes "לשיטתיה".

spoken_witness() turns each such stretch of a transcript into the Hebrew words the
daf would have there, on the same clock, and returns ONLY those words. The path
aligner reads them as one more witness (path_align.align_path), so a rewrite can
place daf words but never hides what the transcript itself says; and like
everything else it has to fit the path in order and in time to count.

Only shapes that are not ordinary English are rewritten: a count needs three
numbers in a row going up by one, and a date needs a month name. Stdlib only.
"""
import re

# The daf's own (masculine) numbers, 1..10, and the teens/tens a date needs.
_UNITS = ["", "אחד", "שנים", "שלשה", "ארבעה", "חמשה", "ששה", "שבעה", "שמונה", "תשעה", "עשרה"]
_TENS = {20: "עשרים", 30: "שלשים"}

# What a maggid counts with: letter names (as a transcriber spells them) and
# English numbers.
_COUNTING = {}
for value, names in enumerate([
    (), ("alef", "aleph", "aluf"), ("beis", "bais", "bet", "beit", "bes", "bais"), ("gimel", "gimmel"),
    ("daled", "dalet", "dalid"), ("hei", "heh", "he", "hey"), ("vav", "vov", "vuv"), ("zayin", "zayen", "zion"),
    ("ches", "chet", "cheis", "het", "chess"), ("tes", "tet", "teis", "tess"), ("yud", "yod"),
]):
    for name in names:
        _COUNTING[name] = value
for value, name in enumerate(["", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten"]):
    if name:
        _COUNTING[name] = value
MIN_COUNT_RUN = 3

_ORDINAL_UNITS = {
    "first": 1, "second": 2, "third": 3, "fourth": 4, "fifth": 5, "sixth": 6, "seventh": 7, "eighth": 8,
    "ninth": 9, "tenth": 10, "eleventh": 11, "twelfth": 12, "thirteenth": 13, "fourteenth": 14,
    "fifteenth": 15, "sixteenth": 16, "seventeenth": 17, "eighteenth": 18, "nineteenth": 19,
    "twentieth": 20, "thirtieth": 30,
}
_TENS_WORDS = {"twenty": 20, "thirty": 30}
_DIGIT_ORDINAL = re.compile(r"^(\d{1,2})(st|nd|rd|th)$")

# Month names as a transcriber spells them, and as the daf writes them.
_MONTHS = {}
for daf, names in (
    ("ניסן", ("nisan", "nissan")), ("אייר", ("iyar", "iyyar", "iyer")), ("סיון", ("sivan", "sivun", "siwan")),
    ("תמוז", ("tammuz", "tamuz")), ("אב", ("av",)), ("אלול", ("elul",)), ("תשרי", ("tishrei", "tishri")),
    ("חשון", ("cheshvan", "marcheshvan", "heshvan")), ("כסלו", ("kislev",)), ("טבת", ("teves", "tevet")),
    ("שבט", ("shvat", "shevat", "shevet")), ("אדר", ("adar",)),
):
    for name in names:
        _MONTHS[name] = daf

# Twins a maggid swaps while reading: what the transcript has -> what the daf has.
_TWINS = (
    (re.compile(r"^ל?שיט(ו)?תי?(יה|ה|ו|יהו)$"), "לטעמיה"),
    (re.compile(r"^l'?e?shit(a|o)s(a|o|ei|ei|eh|ai)?$"), "לטעמיה"),
)

_PLAIN = re.compile(r"[^a-z0-9'\-]")
_HEBREW_MARKS = re.compile(r"[^א-ת]")


def _plain(text):
    return _PLAIN.sub("", text.lower()).strip("'-")


def date_number(n):
    """A day of the month the way the daf writes it: 29 -> ["עשרים", "ותשעה"]."""
    if 1 <= n <= 10:
        return [_UNITS[n]]
    if 11 <= n <= 19:
        return [_UNITS[n - 10], "עשר"]
    if n in _TENS:
        return [_TENS[n]]
    if 21 <= n <= 29:
        return [_TENS[20], "ו" + _UNITS[n - 20]]
    return []


def _ordinal_at(plain, i):
    """The day number an ordinal starting at plain[i] says, and how many words it
    took ("twenty-ninth", "twenty ninth", "29th", "fifteenth")."""
    word = plain[i]
    m = _DIGIT_ORDINAL.match(word)
    if m:
        return int(m.group(1)), 1
    if "-" in word:
        tens, _, unit = word.partition("-")
        if tens in _TENS_WORDS and unit in _ORDINAL_UNITS and _ORDINAL_UNITS[unit] < 10:
            return _TENS_WORDS[tens] + _ORDINAL_UNITS[unit], 1
    if word in _TENS_WORDS and i + 1 < len(plain) and plain[i + 1] in _ORDINAL_UNITS \
            and _ORDINAL_UNITS[plain[i + 1]] < 10:
        return _TENS_WORDS[word] + _ORDINAL_UNITS[plain[i + 1]], 2
    if word in _ORDINAL_UNITS:
        return _ORDINAL_UNITS[word], 1
    return None, 0


def _spread(words, first, last, texts, kind):
    """New words with the given texts, spread evenly over words[first..last]'s time."""
    t0, t1 = words[first]["start"], words[last]["end"]
    step = (t1 - t0) / len(texts)
    return [{"text": text, "start": round(t0 + k * step, 3), "end": round(t0 + (k + 1) * step, 3), "spoken": kind,
             "heard": " ".join(w.get("text", "") for w in words[first:last + 1])}
            for k, text in enumerate(texts)]


def spoken_witness(words):
    """The daf-form Hebrew words for every counting run, date and twin in a
    transcript ([{text, start, end}, ...]); [] when there are none."""
    plain = [_plain(w.get("text", "")) for w in words]
    out = []
    i = 0
    while i < len(words):
        # A count: three or more numbers in a row, each one more than the last.
        if plain[i] in _COUNTING:
            j = i
            while j + 1 < len(words) and plain[j + 1] in _COUNTING and _COUNTING[plain[j + 1]] == _COUNTING[plain[j]] + 1:
                j += 1
            if j - i + 1 >= MIN_COUNT_RUN:
                for k in range(i, j + 1):
                    out += _spread(words, k, k, [_UNITS[_COUNTING[plain[k]]]], "count")
                i = j + 1
                continue
        # A date: [the] <ordinal> [day] of <month>.
        n, used = _ordinal_at(plain, i)
        if n:
            k = i + used
            if k < len(words) and plain[k] == "day":
                k += 1
            if k + 1 < len(words) and plain[k] == "of" and plain[k + 1] in _MONTHS:
                number = date_number(n)
                if number:
                    texts = ["ב" + number[0]] + number[1:] + ["ב" + _MONTHS[plain[k + 1]]]
                    out += _spread(words, i, k + 1, texts, "date")
                    i = k + 2
                    continue
        # "Rosh Chodesh <month>" is the first of it.
        if plain[i] == "rosh" and i + 2 < len(words) and plain[i + 1] in ("chodesh", "hodesh", "chodosh") \
                and plain[i + 2] in _MONTHS:
            out += _spread(words, i, i + 2, ["באחד", "ב" + _MONTHS[plain[i + 2]]], "date")
            i += 3
            continue
        # A twin.
        text = words[i].get("text", "")
        bare = _HEBREW_MARKS.sub("", text) or plain[i]
        for pattern, daf in _TWINS:
            if pattern.match(bare):
                out += _spread(words, i, i, [daf], "twin")
                break
        i += 1
    return out
