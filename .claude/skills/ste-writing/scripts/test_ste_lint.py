#!/usr/bin/env python3
"""Regression tests for ste-lint.py. Run: python3 test_ste_lint.py"""

import importlib.util
import pathlib
import sys

sys.dont_write_bytecode = True

_MOD_PATH = pathlib.Path(__file__).with_name("ste-lint.py")
_spec = importlib.util.spec_from_file_location("ste_lint", _MOD_PATH)
ste = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(ste)

failures = []


def check(name, cond, detail=""):
    status = "ok" if cond else "FAIL"
    print(f"{status}: {name}" + (f" ({detail})" if detail and not cond else ""))
    if not cond:
        failures.append(name)


# Markdown list items without terminal punctuation are separate sentences,
# not one merged long sentence (codex review finding, lane b).
bullet_list = "\n".join("- Run the short step now" for _ in range(8))
result = ste.lint(bullet_list, 20)
check(
    "bullet items are not merged into one sentence",
    result["violations"]["long_sentences"] == 0,
    f"long_sentences={result['violations']['long_sentences']}",
)
check(
    "each bullet item counts as its own sentence",
    result["sentences"] == 8,
    f"sentences={result['sentences']}",
)

numbered_list = "\n".join(f"{i}. Run the short step now" for i in range(1, 9))
numbered = ste.lint(numbered_list, 20)
check(
    "numbered-list markers are not counted as sentences",
    numbered["sentences"] == 8,
    f"sentences={numbered['sentences']}",
)

# A list block with many items is not a "long paragraph" — the skill
# tells writers to use numbered lists for steps.
check(
    "8-item list block is not a long paragraph",
    ste.lint(numbered_list, 20)["violations"]["long_paragraphs"] == 0,
)
prose_para = " ".join("The service starts now." for _ in range(7))
check(
    "7-sentence prose paragraph is still flagged",
    ste.lint(prose_para, 20)["violations"]["long_paragraphs"] == 1,
)
table = "| Cmd | Purpose |\n|---|---|\n" + "\n".join(
    f"| row{i} | does thing {i} |" for i in range(8)
)
check(
    "markdown table is not a long paragraph",
    ste.lint(table, 20)["violations"]["long_paragraphs"] == 0,
)
check(
    "headings are not list items for block detection",
    not ste.is_list_block("# One\n## Two\n### Three"),
)
heading_block = "\n".join(f"#{'#' * (i % 3)} Heading {i}" for i in range(7)) + "\nProse line."
check(
    "heading-heavy block is not exempt from the paragraph cap",
    ste.lint(heading_block, 20)["violations"]["long_paragraphs"] == 1,
    f"long_paragraphs={ste.lint(heading_block, 20)['violations']['long_paragraphs']}",
)

# A genuinely long sentence is still flagged.
long_sentence = "The system " + "very " * 25 + "slowly starts."
check(
    "long sentence still flagged",
    ste.lint(long_sentence, 20)["violations"]["long_sentences"] == 1,
)

# Soft-wrapped prose stays one sentence: a long sentence hard-wrapped
# across lines must not escape the length check (codex round-2 finding).
wrapped = "The system " + "very\nvery " * 13 + "slowly starts."
check(
    "soft-wrapped long sentence still flagged",
    ste.lint(wrapped, 20)["violations"]["long_sentences"] == 1,
)
short_wrapped = "The service starts\nquickly on boot."
check(
    "soft-wrapped short prose is one sentence",
    ste.lint(short_wrapped, 20)["sentences"] == 1,
)

# An indented continuation line belongs to its list item, so a long
# wrapped item cannot evade the length check (codex PR finding).
wrapped_item = (
    "- Run the deploy script with every flag that the release runbook names\n"
    "  and then confirm the health endpoint responds before you continue"
)
wrapped_item_result = ste.lint(wrapped_item, 20)
check(
    "wrapped list item is one sentence",
    wrapped_item_result["sentences"] == 1,
    f"sentences={wrapped_item_result['sentences']}",
)
check(
    "wrapped long list item is flagged",
    wrapped_item_result["violations"]["long_sentences"] == 1,
)
# A lazy (unindented) continuation is still part of the item (CommonMark).
lazy_item = (
    "- Run the deploy script with every flag that the release runbook names\n"
    "and then confirm the health endpoint responds before you continue"
)
lazy_result = ste.lint(lazy_item, 20)
check(
    "lazy list continuation is one sentence",
    lazy_result["sentences"] == 1,
    f"sentences={lazy_result['sentences']}",
)
check(
    "lazy long list item is flagged",
    lazy_result["violations"]["long_sentences"] == 1,
)
after_list = "- Short item here\n\nPlain prose sentence after the list."
check(
    "prose after a blank-line block boundary stays separate",
    ste.lint(after_list, 20)["sentences"] == 2,
    f"sentences={ste.lint(after_list, 20)['sentences']}",
)

# A wide table row is structured data, not a long sentence.
wide_row = "| " + " | ".join("column value here" for _ in range(10)) + " |"
check(
    "wide table row is not a long sentence",
    ste.lint(wide_row, 20)["violations"]["long_sentences"] == 0,
)

# Possessive apostrophe-s is not a contraction (codex round-2 finding).
check(
    "possessive 's is not flagged",
    ste.lint("The user's file is in the admin's folder.", 20)["violations"]["contractions"] == 0,
)
check(
    "real 's contraction is flagged",
    ste.lint("It's ready and that's fine.", 20)["violations"]["contractions"] == 2,
)

# Code blocks and inline code are excluded from analysis.
code_text = "Use the tool.\n\n```\nutilize seamless; robust don't\n```\nRun `utilize --seamlessly` now."
code_result = ste.lint(code_text, 20)
check("code blocks stripped", code_result["total_violations"] == 0)
double_span = "Run ``seamless ` utilize`` now."
check(
    "multi-backtick code span stripped",
    ste.lint(double_span, 20)["total_violations"] == 0,
    f"violations={ste.lint(double_span, 20)['violations']}",
)
tilde_text = "Use the tool.\n\n~~~\nutilize seamless; robust don't\n~~~\nDone."
check(
    "tilde-fenced code stripped",
    ste.lint(tilde_text, 20)["total_violations"] == 0,
)
nested_fence = "Use the tool.\n\n````md\n```\nutilize seamless; robust\n```\n````\nDone."
check(
    "longer fence swallows shorter fence inside it",
    ste.lint(nested_fence, 20)["total_violations"] == 0,
)
unclosed = "Use the tool.\n\n```\nutilize seamless; robust don't"
check(
    "unclosed fence runs to end of input",
    ste.lint(unclosed, 20)["total_violations"] == 0,
)
# Removing a fenced block must keep the prose around it separated.
around_fence = "The service starts now\n```\ncode here\n```\nand the log confirms it later."
check(
    "prose around a fence stays separate sentences",
    ste.lint(around_fence, 20)["sentences"] == 2,
    f"sentences={ste.lint(around_fence, 20)['sentences']}",
)

# Inline code spans may cross a single line break, but not a blank line.
multiline_span = "Run ``utilize\nseamless`` now."
check(
    "multiline code span stripped",
    ste.lint(multiline_span, 20)["total_violations"] == 0,
    f"violations={ste.lint(multiline_span, 20)['violations']}",
)
stray_backticks = "A ` stray marker\n\nutilize ` here."
check(
    "span cannot cross a blank line",
    ste.lint(stray_backticks, 20)["violations"]["banned_words"] == 1,
)

suffixed_close = "Use the tool.\n\n```\nutilize\n```python\nseamless robust\n```\nDone."
check(
    "fence line with info string does not close an open fence",
    ste.lint(suffixed_close, 20)["total_violations"] == 0,
    f"violations={ste.lint(suffixed_close, 20)['violations']}",
)
mixed_fence = "Use the tool.\n\n```\nseamless ~~~ utilize\n```\nDone."
check(
    "tilde inside backtick fence does not close it",
    ste.lint(mixed_fence, 20)["total_violations"] == 0,
)

# A closing markdown marker after end punctuation still ends the sentence.
closers = "**The system starts.** *Then it stops.* (It logs both.) Done."
check(
    "markdown closers do not block sentence splits",
    ste.lint(closers, 20)["sentences"] == 4,
    f"sentences={ste.lint(closers, 20)['sentences']}",
)

# Common abbreviations do not end a sentence, so a long sentence with
# an embedded "e.g." cannot false-split into two short halves.
abbrev = (
    "Use short common words, e.g. start, use, and help, because they keep "
    "every instruction readable for maintainers and tired reviewers alike."
)
abbrev_result = ste.lint(abbrev, 20)
check(
    "abbreviation stays inside its sentence",
    abbrev_result["sentences"] == 1,
    f"sentences={abbrev_result['sentences']}",
)
check(
    "long sentence with abbreviation is still flagged",
    abbrev_result["violations"]["long_sentences"] == 1,
)

# An abbreviation followed by an uppercase opener ends its sentence.
abbrev_end = "Use Linux, etc. Restart the service."
check(
    "sentence-ending abbreviation still splits",
    ste.lint(abbrev_end, 20)["sentences"] == 2,
    f"sentences={ste.lint(abbrev_end, 20)['sentences']}",
)

# Mismatched backtick runs are not a code span (CommonMark leaves them
# literal), so their content stays prose.
mismatched_span = "Use ``utilize``` now."
check(
    "mismatched backtick runs stay prose",
    ste.lint(mismatched_span, 20)["violations"]["banned_words"] == 1,
    f"violations={ste.lint(mismatched_span, 20)['violations']}",
)

# Soft-wrapped blockquote lines are one sentence, and a long quoted
# sentence cannot evade the length check by wrapping.
quoted = (
    "> The deploy script must run with every flag that the release\n"
    "> runbook names before the health endpoint gets checked at all."
)
quoted_result = ste.lint(quoted, 20)
check(
    "soft-wrapped blockquote is one sentence",
    quoted_result["sentences"] == 1,
    f"sentences={quoted_result['sentences']}",
)
check(
    "long wrapped blockquote sentence is flagged",
    quoted_result["violations"]["long_sentences"] == 1,
)

# An abbreviation before a numeric continuation stays mid-sentence.
abbrev_num = "Keep instructions short, i.e. 20 words or fewer for every step."
check(
    "abbreviation before a number stays inside its sentence",
    ste.lint(abbrev_num, 20)["sentences"] == 1,
    f"sentences={ste.lint(abbrev_num, 20)['sentences']}",
)

# A heading is its own unit, never glued to the prose below it.
headed = "# Deployment guide overview\nThe system starts now."
check(
    "heading and following prose are separate sentences",
    ste.lint(headed, 20)["sentences"] == 2,
    f"sentences={ste.lint(headed, 20)['sentences']}",
)

# Indented (4-space) code blocks after a blank line are code, not prose.
indented_code = "Prose stays here.\n\n    utilize seamless robust code\n    more(code); here\n\nDone."
indented_result = ste.lint(indented_code, 20)
check(
    "indented code block excluded from prose",
    indented_result["total_violations"] == 0,
    f"violations={indented_result['violations']}",
)
check(
    "prose around indented code stays separate",
    indented_result["sentences"] == 2,
    f"sentences={indented_result['sentences']}",
)

# Link destinations are not prose; link text is.
linked = "Read the [deployment guide](https://example.com/utilize-seamless;robust) now."
link_result = ste.lint(linked, 20)
check(
    "link destinations excluded from prose",
    link_result["total_violations"] == 0,
    f"violations={link_result['violations']}",
)
check(
    "link text still counted as words",
    link_result["words"] == 5,
    f"words={link_result['words']}",
)
paren_link = "See [the guide](https://example.com/utilize(seamless)robust) now."
check(
    "parenthesized link destination fully stripped",
    ste.lint(paren_link, 20)["total_violations"] == 0,
    f"violations={ste.lint(paren_link, 20)['violations']}",
)
angle_link = "See [the guide](<https://example.com/utilize seamless robust>) now."
check(
    "angle-bracket link destination fully stripped",
    ste.lint(angle_link, 20)["total_violations"] == 0,
    f"violations={ste.lint(angle_link, 20)['violations']}",
)

# Core violation classes are detected.
sloppy = (
    "It is important to note that the powerful system was designed to utilize "
    "semantic matching; you can't spin up a deployment."
)
v = ste.lint(sloppy, 20)["violations"]
for rule in ("contractions", "semicolons", "passive_voice", "banned_words",
             "marketing_adjectives", "phrasal_verbs", "hedge_phrases"):
    check(f"detects {rule}", v[rule] >= 1, f"{rule}={v[rule]}")

# A fence indented four or more spaces is not a fence opener (CommonMark
# treats it as indented code), so the prose after it is still linted.
deep_indent = "    ```\nutilize the tool now\n"
check(
    "4-space-indented delimiter does not open a fence",
    ste.lint(deep_indent, 20)["violations"]["banned_words"] == 1,
)
shallow_indent = "   ```\nutilize seamless\n   ```\nDone."
check(
    "3-space-indented fence still strips code",
    ste.lint(shallow_indent, 20)["total_violations"] == 0,
)

# Empty input does not divide by zero.
check("empty input scores 0", ste.lint("", 20)["per_100_words"] == 0.0)

# Advisory contract: unreadable files never break the exit code.
import subprocess  # noqa: E402

missing = subprocess.run(
    [sys.executable, str(_MOD_PATH), "/nonexistent/ste-lint-input.md"],
    capture_output=True,
    text=True,
    env={**__import__("os").environ, "PYTHONDONTWRITEBYTECODE": "1"},
)
check("missing input file still exits 0", missing.returncode == 0)
check(
    "missing input file is reported on stderr",
    "ste-lint-input.md" in missing.stderr,
)

import tempfile  # noqa: E402

with tempfile.NamedTemporaryFile(suffix=".md", delete=False) as tmp:
    tmp.write(b"\xff\xfe invalid utf-8 \x9c\x81")
    binary_path = tmp.name
try:
    binary = subprocess.run(
        [sys.executable, str(_MOD_PATH), binary_path],
        capture_output=True,
        text=True,
        env={**__import__("os").environ, "PYTHONDONTWRITEBYTECODE": "1"},
    )
    check("undecodable input file still exits 0", binary.returncode == 0)
    check(
        "undecodable input file is reported on stderr",
        binary_path in binary.stderr,
    )
finally:
    __import__("os").unlink(binary_path)

print(f"\n{len(failures)} failure(s)")
sys.exit(1 if failures else 0)
