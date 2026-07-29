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
mixed_fence = "Use the tool.\n\n```\nseamless ~~~ utilize\n```\nDone."
check(
    "tilde inside backtick fence does not close it",
    ste.lint(mixed_fence, 20)["total_violations"] == 0,
)

# A heading is its own unit, never glued to the prose below it.
headed = "# Deployment guide overview\nThe system starts now."
check(
    "heading and following prose are separate sentences",
    ste.lint(headed, 20)["sentences"] == 2,
    f"sentences={ste.lint(headed, 20)['sentences']}",
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

# Core violation classes are detected.
sloppy = (
    "It is important to note that the powerful system was designed to utilize "
    "semantic matching; you can't spin up a deployment."
)
v = ste.lint(sloppy, 20)["violations"]
for rule in ("contractions", "semicolons", "passive_voice", "banned_words",
             "marketing_adjectives", "phrasal_verbs", "hedge_phrases"):
    check(f"detects {rule}", v[rule] >= 1, f"{rule}={v[rule]}")

# Empty input does not divide by zero.
check("empty input scores 0", ste.lint("", 20)["per_100_words"] == 0.0)

print(f"\n{len(failures)} failure(s)")
sys.exit(1 if failures else 0)
