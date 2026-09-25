"""Tests for the code-review session's red_team role.

Covers per-role phase prompts (red_team gets its own Review instruction
instead of sharing the reviewer's) and the template validation that keeps
those prompts attached to real participants and under the prompt cap.
"""

import json
import sys
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from session_engine import SessionEngine
from session_store import MAX_PROMPT_CHARS, SessionStore, validate_session_template
from store import MessageStore

TEMPLATES_DIR = ROOT / "session_templates"


class FakeRegistry:
    """Just enough of RuntimeRegistry for the session engine and start route."""

    def __init__(self, names):
        self.names = list(names)

    def is_registered(self, name):
        return name in self.names

    def get_active_names(self):
        return list(self.names)


class RecordingTrigger:
    """Stands in for AgentTrigger and records every prompt it would queue."""

    def __init__(self):
        self.calls = []

    def trigger_sync(self, agent_name, message="", channel="general", job_id=None, **kwargs):
        self.calls.append({"agent": agent_name, "channel": channel, "prompt": kwargs.get("prompt", "")})


def load_template(template_id):
    return json.loads((TEMPLATES_DIR / f"{template_id}.json").read_text("utf-8"))


def two_role_template(**overrides):
    """A valid one-phase template with builder and red_team."""
    tmpl = {
        "name": "Two roles",
        "roles": ["builder", "red_team"],
        "phases": [
            {"name": "Only", "participants": ["builder", "red_team"], "prompt": "Do it.", "is_output": True},
        ],
    }
    tmpl.update(overrides)
    return tmpl


def instruction_of(prompt):
    """The INSTRUCTION line an agent receives, without its label."""
    for block in prompt.split("\n\n"):
        if block.startswith("INSTRUCTION: "):
            return block[len("INSTRUCTION: "):]
    raise AssertionError(f"no INSTRUCTION line in prompt:\n{prompt}")


class SessionHarness(unittest.TestCase):
    """A real SessionStore, MessageStore and SessionEngine over a temp dir."""

    agents = ("alpha", "beta", "gamma")

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        root = Path(self.tmp.name)
        self.sessions = SessionStore(str(root / "session_runs.json"), templates_dir=str(TEMPLATES_DIR))
        self.messages = MessageStore(str(root / "messages.jsonl"))
        self.registry = FakeRegistry(self.agents)
        self.trigger = RecordingTrigger()
        self.engine = SessionEngine(self.sessions, self.messages, self.trigger, self.registry)


class RolePromptTests(SessionHarness):
    def setUp(self):
        super().setUp()
        self.tmpl = self.sessions.get_template("code-review")
        self.review = next(p for p in self.tmpl["phases"] if p["name"] == "Review")
        self.session = {"current_phase": self.tmpl["phases"].index(self.review), "goal": "", "channel": "general"}

    def test_red_team_gets_its_own_review_instruction(self):
        prompt = self.engine._assemble_prompt(self.session, self.tmpl, self.review, "red_team")

        self.assertEqual(instruction_of(prompt), self.review["role_prompts"]["red_team"])
        self.assertTrue(instruction_of(prompt).startswith("Try to break it"))
        self.assertNotIn(self.review["prompt"], prompt)

    def test_reviewer_keeps_the_phase_instruction(self):
        prompt = self.engine._assemble_prompt(self.session, self.tmpl, self.review, "reviewer")

        self.assertEqual(instruction_of(prompt), self.review["prompt"])

    def test_red_team_keeps_the_dissent_mandate(self):
        # The role prompt replaces the instruction, not the dissent line.
        prompt = self.engine._assemble_prompt(self.session, self.tmpl, self.review, "red_team")

        self.assertIn("Do not repeat or defer to other participants.", prompt)

    def test_phase_without_role_prompts_uses_the_phase_prompt(self):
        phase = {"name": "Plain", "participants": ["red_team"], "prompt": "Phase text."}

        prompt = self.engine._assemble_prompt(self.session, self.tmpl, phase, "red_team")

        self.assertEqual(instruction_of(prompt), "Phase text.")

    def test_role_missing_from_the_map_uses_the_phase_prompt(self):
        phase = {
            "name": "Mixed",
            "participants": ["reviewer", "red_team"],
            "prompt": "Phase text.",
            "role_prompts": {"red_team": "Break it."},
        }

        prompt = self.engine._assemble_prompt(self.session, self.tmpl, phase, "reviewer")

        self.assertEqual(instruction_of(prompt), "Phase text.")

    def test_blank_role_prompt_falls_back_to_the_phase_prompt(self):
        phase = {
            "name": "Blank",
            "participants": ["red_team"],
            "prompt": "Phase text.",
            "role_prompts": {"red_team": "   "},
        }

        prompt = self.engine._assemble_prompt(self.session, self.tmpl, phase, "red_team")

        self.assertEqual(instruction_of(prompt), "Phase text.")

    def test_triggered_agents_receive_their_own_review_instructions(self):
        # The path an agent actually sees: start, reach each Review turn, trigger.
        cast = {"builder": "alpha", "reviewer": "beta", "red_team": "gamma", "synthesiser": "alpha"}
        session = self.engine.start_session("code-review", "general", cast, "user")
        session = self.sessions.advance_phase(session["id"])  # Review: reviewer's turn
        self.engine._trigger_current(session)
        session = self.sessions.advance_turn(session["id"])  # Review: red_team's turn
        self.engine._trigger_current(session)

        prompts = {call["agent"]: call["prompt"] for call in self.trigger.calls}
        self.assertEqual(instruction_of(prompts["beta"]), self.review["prompt"])
        self.assertEqual(instruction_of(prompts["gamma"]), self.review["role_prompts"]["red_team"])


class TemplateValidationTests(unittest.TestCase):
    def test_bundled_templates_are_valid(self):
        # Bundled templates are not validated at load, so this is their only check.
        for path in sorted(TEMPLATES_DIR.glob("*.json")):
            with self.subTest(template=path.name):
                self.assertEqual(validate_session_template(json.loads(path.read_text("utf-8"))), [])

    def test_code_review_gives_red_team_its_own_review_prompt(self):
        review = next(p for p in load_template("code-review")["phases"] if p["name"] == "Review")

        self.assertIn("red_team", review["role_prompts"])
        self.assertNotIn("reviewer", review["role_prompts"])

    def test_prompt_cap_is_200_characters(self):
        # The cap predates role prompts; role prompts reuse it rather than add one.
        self.assertEqual(MAX_PROMPT_CHARS, 200)
        tmpl = two_role_template()
        tmpl["phases"][0]["prompt"] = "x" * (MAX_PROMPT_CHARS + 1)

        errors = validate_session_template(tmpl)

        self.assertEqual(len(errors), 1)
        self.assertIn("prompt too long", errors[0])

    def test_role_prompt_at_the_cap_is_accepted(self):
        tmpl = two_role_template()
        tmpl["phases"][0]["role_prompts"] = {"red_team": "x" * MAX_PROMPT_CHARS}

        self.assertEqual(validate_session_template(tmpl), [])

    def test_role_prompt_over_the_cap_is_rejected(self):
        tmpl = two_role_template()
        tmpl["phases"][0]["role_prompts"] = {"red_team": "x" * (MAX_PROMPT_CHARS + 1)}

        errors = validate_session_template(tmpl)

        self.assertEqual(len(errors), 1)
        self.assertIn("red_team", errors[0])
        self.assertIn(f"{MAX_PROMPT_CHARS + 1} chars, max {MAX_PROMPT_CHARS}", errors[0])

    def test_role_prompt_must_belong_to_a_participant_of_its_phase(self):
        # red_team is a template role, but not a participant of the phase that
        # carries its prompt, so the prompt could never be used.
        tmpl = {
            "name": "Split",
            "roles": ["builder", "red_team"],
            "phases": [
                {"name": "Build", "participants": ["builder"], "prompt": "Build.",
                 "role_prompts": {"red_team": "Break it."}},
                {"name": "Break", "participants": ["red_team"], "prompt": "Break.", "is_output": True},
            ],
        }

        errors = validate_session_template(tmpl)

        self.assertEqual(len(errors), 1)
        self.assertIn("Phase 1", errors[0])
        self.assertIn("red_team", errors[0])
        self.assertIn("not a participant", errors[0])

    def test_role_prompt_for_an_unknown_role_is_rejected(self):
        tmpl = two_role_template()
        tmpl["phases"][0]["role_prompts"] = {"red-team": "Break it."}  # typo for red_team

        errors = validate_session_template(tmpl)

        self.assertEqual(len(errors), 1)
        self.assertIn("red-team", errors[0])

    def test_role_prompts_must_map_roles_to_non_empty_strings(self):
        for bad in (["red_team"], "red_team", {"red_team": ""}, {"red_team": "  "}, {"red_team": 5}):
            with self.subTest(role_prompts=bad):
                tmpl = two_role_template()
                tmpl["phases"][0]["role_prompts"] = bad

                errors = validate_session_template(tmpl)

                self.assertEqual(len(errors), 1, errors)
                self.assertIn("role", errors[0])


if __name__ == "__main__":
    unittest.main()
