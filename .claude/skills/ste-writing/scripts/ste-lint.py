#!/usr/bin/env python3
"""Advisory STE lint: score prose for Simplified Technical English violations.

Clean-room implementation of the heuristics described in woosal1337's ep01
"cure for AI slop" experiment, adapted for this repo. Reports violations per
100 words. Always exits 0 — this is an advisory signal, never a gate.

Usage:
    ste-lint.py [--strict] [--json] [FILE ...]
    cat prose.md | ste-lint.py
"""

import argparse
import json
import re
import sys

BE = r"(?:am|is|are|was|were|be|been|being)"
PP_IRREG = (
    r"(?:done|made|sent|read|built|written|given|taken|shown|known|found|held|"
    r"kept|left|lost|set|put|run|seen|told|thought|brought|bought|caught|"
    r"taught|chosen|driven|drawn|grown|thrown|broken|spoken|hidden|forgotten)"
)

PHRASAL_VERBS = [
    "spin up", "spins up", "spun up", "reach out", "reached out", "kick off",
    "kicks off", "kicked off", "roll out", "rolls out", "rolled out",
    "tear down", "ramp up", "ramps up", "circle back", "drill down",
    "touch base", "double down", "figure out", "carve out",
]

BANNED_WORDS = [
    "commence", "commences", "commenced", "utilize", "utilizes", "utilized",
    "utilization", "leverage", "leverages", "leveraged", "facilitate",
    "facilitates", "facilitated", "plethora", "amongst", "whilst", "myriad",
    "endeavor", "ascertain", "aforementioned", "henceforth", "subsequently",
    "furthermore", "moreover", "additionally", "delve", "delves", "delved",
    "in order to", "a number of", "prior to", "in the event that",
]

MARKETING_ADJECTIVES = [
    "seamless", "seamlessly", "robust", "powerful", "cutting-edge",
    "revolutionary", "blazing", "blazingly", "elegant", "enterprise-grade",
    "world-class", "state-of-the-art", "best-in-class", "game-changing",
    "effortless", "effortlessly", "supercharge", "supercharges",
    "turbocharge", "unlock", "unlocks", "empower", "empowers", "delightful",
    "magical", "sleek", "next-generation", "battle-tested",
]

HEDGE_PHRASES = [
    "it is important to note", "it should be noted", "it's worth noting",
    "it is worth noting", "as mentioned", "as noted above", "needless to say",
    "at the end of the day", "keep in mind that", "please note that",
]

# 's is only a contraction on known stems; elsewhere it is possessive.
RE_CONTRACTION = re.compile(
    r"\b\w+[’'](?:t|re|ve|ll|d|m)\b"
    r"|\b(?:it|that|there|here|what|who|she|he|one|let|where|when|how|why)[’']s\b",
    re.IGNORECASE,
)
RE_PASSIVE = re.compile(rf"\b{BE}\s+(?:\w+ed|{PP_IRREG})\b", re.IGNORECASE)
RE_ING_MAIN = re.compile(rf"\b{BE}\s+\w+ing\b", re.IGNORECASE)
RE_NOMINALIZATION = re.compile(
    r"\b(?:perform(?:s|ed|ing)?|conduct(?:s|ed|ing)?|carr(?:y|ies|ied)\s+out|"
    r"make(?:s)?\s+use\s+of|made\s+use\s+of)\b"
    r"|\b\w+(?:tion|ment|ance|ence)s?\s+of\b",
    re.IGNORECASE,
)
RE_EMDASH = re.compile(r"[—–]")
RE_WORD = re.compile(r"\b[\w'’-]+\b")


def word_list_regex(items):
    alts = "|".join(re.escape(w) for w in items)
    return re.compile(rf"\b(?:{alts})\b", re.IGNORECASE)


RE_PHRASAL = word_list_regex(PHRASAL_VERBS)
RE_BANNED = word_list_regex(BANNED_WORDS)
RE_MARKETING = word_list_regex(MARKETING_ADJECTIVES)
RE_HEDGES = word_list_regex(HEDGE_PHRASES)


def strip_code(text):
    text = re.sub(r"```.*?```|~~~.*?~~~", " ", text, flags=re.DOTALL)
    text = re.sub(r"`[^`\n]+`", " ", text)
    return text


RE_LINE_MARKER = re.compile(r"^\s*(?:[-*+]|\d+[.)]|#+|>)\s+")
RE_SENT_SPLIT = re.compile(r"(?<=[.!?])\s+")


def sentences_of(text):
    """Split into sentences with markdown awareness:
    - Adjacent prose lines are soft wraps of one sentence; join them so a
      hard-wrapped long sentence cannot escape the length check.
    - List items, headings, and blockquote lines are separate units, so
      unpunctuated items never merge into one long pseudo-sentence. An
      indented line after a list item is that item's soft-wrapped
      continuation and stays in the same sentence.
    - Table rows are structured data and produce no sentences."""
    sents = []
    buffer = []
    buffer_is_item = False

    def emit(chunk):
        for part in RE_SENT_SPLIT.split(chunk):
            part = part.strip()
            if re.search(r"\w", part):
                sents.append(part)

    def flush():
        nonlocal buffer_is_item
        if buffer:
            emit(" ".join(buffer))
            buffer.clear()
        buffer_is_item = False

    for line in text.splitlines():
        stripped = line.strip()
        if not stripped or stripped.startswith("|"):
            flush()
        elif RE_LINE_MARKER.match(line):
            flush()
            buffer.append(RE_LINE_MARKER.sub("", line).strip())
            buffer_is_item = True
        elif buffer_is_item and line[:1] in (" ", "\t"):
            buffer.append(stripped)
        else:
            if buffer_is_item:
                flush()
            buffer.append(stripped)
    flush()
    return sents


def is_list_block(paragraph):
    """A paragraph whose lines are mostly list items or table rows. Exempt
    from the six-sentence paragraph cap: the skill directs steps into lists,
    and tables are structured data, not prose."""
    lines = [line for line in paragraph.splitlines() if line.strip()]
    marked = sum(
        1
        for line in lines
        if RE_LINE_MARKER.match(line) or line.lstrip().startswith("|")
    )
    return bool(lines) and marked >= len(lines) / 2


def lint(text, max_words):
    prose = strip_code(text)
    words = RE_WORD.findall(prose)
    sents = sentences_of(prose)
    paragraphs = [p for p in re.split(r"\n\s*\n", prose) if p.strip()]

    counts = {
        "long_sentences": sum(
            1 for s in sents if len(RE_WORD.findall(s)) > max_words
        ),
        "semicolons": prose.count(";"),
        "contractions": len(RE_CONTRACTION.findall(prose)),
        "passive_voice": len(RE_PASSIVE.findall(prose)),
        "ing_main_verbs": len(RE_ING_MAIN.findall(prose)),
        "nominalizations": len(RE_NOMINALIZATION.findall(prose)),
        "phrasal_verbs": len(RE_PHRASAL.findall(prose)),
        "banned_words": len(RE_BANNED.findall(prose)),
        "marketing_adjectives": len(RE_MARKETING.findall(prose)),
        "hedge_phrases": len(RE_HEDGES.findall(prose)),
        "long_paragraphs": sum(
            1
            for p in paragraphs
            if not is_list_block(p) and len(sentences_of(p)) > 6
        ),
    }
    total = sum(counts.values())
    n_words = len(words)
    per100 = round(total * 100 / n_words, 2) if n_words else 0.0
    return {
        "words": n_words,
        "sentences": len(sents),
        "violations": counts,
        "total_violations": total,
        "per_100_words": per100,
        "em_dashes": len(RE_EMDASH.findall(prose)),  # slop marker, not a violation
    }


def report(name, result):
    print(f"== {name} ==")
    print(f"words: {result['words']}  sentences: {result['sentences']}")
    for rule, n in result["violations"].items():
        if n:
            print(f"  {rule}: {n}")
    print(f"total: {result['total_violations']}  per 100 words: {result['per_100_words']}")
    if result["em_dashes"]:
        print(f"  (slop marker) em/en dashes: {result['em_dashes']}")


def main():
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("files", nargs="*", help="files to lint; stdin when omitted")
    ap.add_argument("--strict", action="store_true", help="20-word sentence limit (default 25)")
    ap.add_argument("--json", action="store_true", help="emit JSON")
    args = ap.parse_args()

    max_words = 20 if args.strict else 25
    if args.files:
        inputs = []
        for path in args.files:
            with open(path, encoding="utf-8") as fh:
                inputs.append((path, fh.read()))
    else:
        inputs = [("<stdin>", sys.stdin.read())]

    results = {name: lint(text, max_words) for name, text in inputs}
    if args.json:
        print(json.dumps(results, indent=2))
    else:
        for name, result in results.items():
            report(name, result)

    # Advisory only: never fail the caller.
    sys.exit(0)


if __name__ == "__main__":
    main()
