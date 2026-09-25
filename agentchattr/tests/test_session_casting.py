"""Tests for the code-review session's red_team role.

Covers per-role phase prompts (red_team gets its own Review instruction
instead of sharing the reviewer's), the template validation that keeps those
prompts attached to real participants and under the prompt cap, and distinct
casting: the builder is never cast as its own red team, whether the cast is
chosen by auto-cast, by hand in the launcher, or sent straight to the API.
"""

import asyncio
import json
import shutil
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

from starlette.requests import Request

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

import app
from session_engine import SessionEngine
from session_store import (
    MAX_PROMPT_CHARS,
    CastError,
    SessionStore,
    auto_cast,
    validate_cast,
    validate_session_template,
)
from store import MessageStore

TEMPLATES_DIR = ROOT / "session_templates"
SESSIONS_JS = ROOT / "static" / "sessions.js"
NODE = shutil.which("node")


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

    def test_code_review_keeps_builder_and_red_team_apart(self):
        self.assertIn(["builder", "red_team"], load_template("code-review")["distinct_roles"])

    def test_distinct_roles_must_name_template_roles(self):
        # A misspelt role would make the rule silently never apply.
        errors = validate_session_template(two_role_template(distinct_roles=[["builder", "red-team"]]))

        self.assertEqual(len(errors), 1)
        self.assertIn("'red-team' not in roles list", errors[0])

    def test_distinct_roles_group_needs_two_different_roles(self):
        for bad in ([["builder"]], [["builder", "builder"]], [[]], ["builder"]):
            with self.subTest(distinct_roles=bad):
                errors = validate_session_template(two_role_template(distinct_roles=bad))

                self.assertEqual(len(errors), 1, errors)
                self.assertIn("at least two different roles", errors[0])

    def test_distinct_roles_must_be_a_list_of_groups(self):
        errors = validate_session_template(two_role_template(distinct_roles={"builder": "red_team"}))

        self.assertEqual(errors, ["'distinct_roles' must be an array of role groups"])


class AutoCastTests(unittest.TestCase):
    def setUp(self):
        self.tmpl = load_template("code-review")

    def test_one_agent_cannot_fill_builder_and_red_team(self):
        with self.assertRaises(CastError) as caught:
            auto_cast(self.tmpl, ["alpha"])

        message = str(caught.exception)
        self.assertIn("'red_team'", message)
        self.assertIn("'builder'", message)
        self.assertIn("only 1 agent is online (alpha)", message)

    def test_two_agents_give_red_team_to_the_second(self):
        cast = auto_cast(self.tmpl, ["alpha", "beta"])

        self.assertEqual(cast["builder"], "alpha")
        self.assertEqual(cast["red_team"], "beta")
        self.assertEqual(sorted(cast), sorted(self.tmpl["roles"]))

    def test_three_agents_keep_the_round_robin(self):
        cast = auto_cast(self.tmpl, ["alpha", "beta", "gamma"])

        self.assertEqual(cast, {"builder": "alpha", "reviewer": "beta", "red_team": "gamma", "synthesiser": "alpha"})

    def test_no_agents_online(self):
        with self.assertRaises(CastError) as caught:
            auto_cast(self.tmpl, [])

        self.assertEqual(str(caught.exception), "not enough agents online to fill all roles")

    def test_template_without_distinct_roles_still_shares_one_agent(self):
        tmpl = load_template("design-critique")

        self.assertEqual(auto_cast(tmpl, ["solo"]), {role: "solo" for role in tmpl["roles"]})

    def test_duplicate_agent_names_count_once(self):
        with self.assertRaises(CastError):
            auto_cast(self.tmpl, ["alpha", "alpha"])

    def test_builder_never_red_teams_for_any_roster_or_role_order(self):
        orders = (self.tmpl["roles"], list(reversed(self.tmpl["roles"])), ["red_team", "reviewer", "builder"])
        for count in range(1, 6):
            agents = [f"agent{i}" for i in range(count)]
            for roles in orders:
                tmpl = dict(self.tmpl, roles=roles)
                with self.subTest(agents=count, roles=roles):
                    if count == 1:
                        with self.assertRaises(CastError):
                            auto_cast(tmpl, agents)
                        continue
                    cast = auto_cast(tmpl, agents)
                    self.assertNotEqual(cast["builder"], cast["red_team"])
                    self.assertEqual(sorted(cast), sorted(roles))
                    self.assertEqual(validate_cast(tmpl, cast), [])

    def test_every_group_is_honoured(self):
        # Three pairwise-distinct roles need three agents; two cannot do it.
        tmpl = {"roles": ["x", "y", "z"], "distinct_roles": [["x", "y"], ["y", "z"], ["x", "z"]]}

        self.assertEqual(auto_cast(tmpl, ["a", "b", "c"]), {"x": "a", "y": "b", "z": "c"})
        with self.assertRaises(CastError) as caught:
            auto_cast(tmpl, ["a", "b"])
        self.assertIn("'x' and 'y'", str(caught.exception))

    def test_leaves_its_inputs_alone(self):
        roles_before = list(self.tmpl["roles"])
        agents = ["alpha", "beta"]

        auto_cast(self.tmpl, agents)

        self.assertEqual(agents, ["alpha", "beta"])
        self.assertEqual(self.tmpl["roles"], roles_before)


class ValidateCastTests(unittest.TestCase):
    def setUp(self):
        self.tmpl = load_template("code-review")

    def test_conflict_names_both_roles_and_the_agent(self):
        cast = {"builder": "alpha", "reviewer": "beta", "red_team": "alpha", "synthesiser": "beta"}

        self.assertEqual(
            validate_cast(self.tmpl, cast),
            ["Cast conflict: 'builder' and 'red_team' must be different agents, but both are 'alpha'."],
        )

    def test_distinct_cast_is_valid(self):
        cast = {"builder": "alpha", "reviewer": "beta", "red_team": "beta", "synthesiser": "alpha"}

        self.assertEqual(validate_cast(self.tmpl, cast), [])

    def test_uncast_role_is_not_a_conflict(self):
        self.assertEqual(validate_cast(self.tmpl, {"builder": "alpha", "red_team": ""}), [])
        self.assertEqual(validate_cast(self.tmpl, {"red_team": "alpha"}), [])

    def test_a_human_cannot_red_team_their_own_build_either(self):
        # The rule is about who holds the roles, not whether they are agents.
        self.assertEqual(len(validate_cast(self.tmpl, {"builder": "user", "red_team": "user"})), 1)

    def test_template_without_distinct_roles_accepts_a_shared_agent(self):
        tmpl = load_template("design-critique")

        self.assertEqual(validate_cast(tmpl, {role: "solo" for role in tmpl["roles"]}), [])

    def test_a_repeated_role_in_a_group_is_not_a_self_conflict(self):
        tmpl = dict(self.tmpl, distinct_roles=[["builder", "builder", "red_team"]])

        self.assertEqual(validate_cast(tmpl, {"builder": "alpha", "red_team": "beta"}), [])

    def test_cast_must_be_an_object_of_agent_names(self):
        self.assertEqual(validate_cast(self.tmpl, ["alpha", "beta"]), ["'cast' must be an object mapping role to agent"])
        self.assertEqual(
            validate_cast(self.tmpl, {"builder": ["alpha"], "red_team": ["alpha"]}),
            ["Cast for 'builder' must be an agent name", "Cast for 'red_team' must be an agent name"],
        )


def json_request(body):
    """A POST Request carrying a JSON body, for calling route handlers directly."""
    payload = json.dumps(body).encode("utf-8")

    async def receive():
        return {"type": "http.request", "body": payload, "more_body": False}

    scope = {
        "type": "http",
        "method": "POST",
        "path": "/api/sessions/start",
        "headers": [(b"content-type", b"application/json")],
        "query_string": b"",
    }
    return Request(scope, receive)


class AppHarness(SessionHarness):
    """SessionHarness wired into the app module globals the routes read."""

    agents = ("alpha", "beta")

    def setUp(self):
        super().setUp()
        saved = {name: getattr(app, name) for name in ("store", "session_store", "session_engine", "registry")}
        app.store = self.messages
        app.session_store = self.sessions
        app.session_engine = self.engine
        app.registry = self.registry

        def restore():
            for name, value in saved.items():
                setattr(app, name, value)

        self.addCleanup(restore)

    def start(self, **body):
        response = asyncio.run(app.start_session(json_request(body)))
        return response.status_code, json.loads(response.body.decode("utf-8"))


class StartSessionRouteTests(AppHarness):
    """/api/sessions/start is the only way in, and the UI always sends a full cast."""

    def assert_nothing_started(self):
        self.assertEqual(self.sessions.list_all(), [])
        self.assertEqual(self.trigger.calls, [])

    def test_builder_cast_as_red_team_is_a_400(self):
        cast = {"builder": "alpha", "reviewer": "beta", "red_team": "alpha", "synthesiser": "beta"}

        status, payload = self.start(template_id="code-review", cast=cast)

        self.assertEqual(status, 400)
        self.assertEqual(
            payload["error"],
            "Cast conflict: 'builder' and 'red_team' must be different agents, but both are 'alpha'.",
        )
        self.assert_nothing_started()
        self.assertEqual(self.messages.get_recent(10), [], "no start banner for a rejected session")

    def test_distinct_cast_starts_the_session(self):
        cast = {"builder": "alpha", "reviewer": "beta", "red_team": "beta", "synthesiser": "alpha"}

        status, payload = self.start(template_id="code-review", cast=cast)

        self.assertEqual(status, 200)
        self.assertEqual(payload["cast"], cast)
        self.assertEqual(len(self.sessions.list_all()), 1)
        self.assertEqual([call["agent"] for call in self.trigger.calls], ["alpha"])

    def test_auto_cast_gives_red_team_to_the_second_agent(self):
        status, payload = self.start(template_id="code-review")

        self.assertEqual(status, 200)
        self.assertEqual(payload["cast"]["builder"], "alpha")
        self.assertEqual(payload["cast"]["red_team"], "beta")

    def test_auto_cast_with_one_agent_is_a_clear_400(self):
        self.registry.names = ["alpha"]

        status, payload = self.start(template_id="code-review")

        self.assertEqual(status, 400)
        self.assertIn("'red_team'", payload["error"])
        self.assertIn("'builder'", payload["error"])
        self.assertIn("only 1 agent is online (alpha)", payload["error"])
        self.assert_nothing_started()

    def test_auto_cast_with_no_agents_keeps_its_message(self):
        self.registry.names = []

        status, payload = self.start(template_id="code-review")

        self.assertEqual(status, 400)
        self.assertEqual(payload["error"], "not enough agents online to fill all roles")

    def test_cast_that_is_not_an_object_is_a_400(self):
        status, payload = self.start(template_id="code-review", cast=["alpha", "beta"])

        self.assertEqual(status, 400)
        self.assertIn("'cast' must be an object", payload["error"])
        self.assert_nothing_started()

    def test_a_draft_template_is_held_to_its_own_distinct_roles(self):
        # Drafts take a separate path to their template; the check must follow it.
        # The route reads draft_message_id with a truthiness test, so keep the
        # draft off message id 0 (a real draft card is never the first message).
        self.messages.add("user", "Design a session for red-teaming.")
        draft = self.messages.add(
            "system",
            "Session draft",
            msg_type="session_draft",
            metadata={"valid": True, "template": two_role_template(distinct_roles=[["builder", "red_team"]])},
        )

        status, payload = self.start(draft_message_id=draft["id"], cast={"builder": "alpha", "red_team": "alpha"})

        self.assertEqual(status, 400)
        self.assertIn("'builder' and 'red_team'", payload["error"])
        self.assert_nothing_started()


class BuiltinTemplateTests(AppHarness):
    """A draft or custom template must not take a built-in template's id.

    Replacing code-review that way silently dropped its builder/red_team rule
    for every later code-review session: in memory when the draft was run,
    and across restarts once it was saved.
    """

    def shadow_draft(self):
        self.messages.add("user", "Design a code review session.")  # keep the draft off id 0
        shadow = {
            "id": "code-review",
            "name": "Code Review",
            "roles": ["builder", "red_team"],
            "phases": [{"name": "Only", "participants": ["builder", "red_team"], "prompt": "Go.", "is_output": True}],
        }
        return self.messages.add(
            "system", "Session draft", msg_type="session_draft", metadata={"valid": True, "template": shadow}
        )

    def assert_builtin_rule_holds(self, sessions):
        tmpl = sessions.get_template("code-review")
        self.assertFalse(tmpl.get("is_custom"))
        self.assertEqual(tmpl["distinct_roles"], [["builder", "red_team"]])

    def test_running_a_draft_leaves_the_builtin_in_place(self):
        draft = self.shadow_draft()

        # The draft declares no distinct_roles of its own, so its cast is fine.
        status, payload = self.start(
            draft_message_id=draft["id"], channel="drafts", cast={"builder": "alpha", "red_team": "alpha"}
        )
        self.assertEqual(status, 200)
        self.assertEqual(payload["template_id"], f"draft-{draft['id']}")
        self.assert_builtin_rule_holds(self.sessions)

        conflict = {"builder": "alpha", "reviewer": "beta", "red_team": "alpha", "synthesiser": "beta"}
        status, _ = self.start(template_id="code-review", channel="general", cast=conflict)
        self.assertEqual(status, 400, "the built-in code-review must still refuse builder == red_team")

    def test_saving_a_draft_leaves_the_builtin_in_place_across_a_restart(self):
        draft = self.shadow_draft()

        response = asyncio.run(app.save_draft(json_request({"message_id": draft["id"]})))

        self.assertEqual(response.status_code, 200)
        saved_id = json.loads(response.body.decode("utf-8"))["template_id"]
        self.assertEqual(saved_id, f"custom-{draft['id']}")
        self.assert_builtin_rule_holds(self.sessions)
        reloaded = SessionStore(str(Path(self.tmp.name) / "session_runs.json"), templates_dir=str(TEMPLATES_DIR))
        self.assert_builtin_rule_holds(reloaded)
        self.assertIsNotNone(reloaded.get_template(saved_id))

    def test_a_custom_template_file_cannot_replace_a_builtin(self):
        # A custom_templates.json saved before this guard existed, or edited by hand.
        root = Path(self.tmp.name)
        (root / "custom_templates.json").write_text(
            json.dumps([{"id": "code-review", "name": "Shadow", "roles": ["builder"], "phases": []}]), "utf-8"
        )

        reloaded = SessionStore(str(root / "session_runs.json"), templates_dir=str(TEMPLATES_DIR))

        self.assert_builtin_rule_holds(reloaded)


# Loads static/sessions.js in a bare VM with stub globals, then answers each
# case read from stdin with _autoCast or _castConflicts.
_SESSIONS_JS_RUNNER = r"""
const fs = require("fs")
const vm = require("vm")
const context = { window: {}, Hub: { on() {} }, Store: { watch() {} }, console }
vm.createContext(context)
vm.runInContext(fs.readFileSync(process.argv[1], "utf8"), context, { filename: "sessions.js" })
const cases = JSON.parse(fs.readFileSync(0, "utf8"))
const results = cases.map((c) => (c.op === "autoCast" ? context._autoCast(c.tmpl, c.agents) : context._castConflicts(c.tmpl, c.cast)))
process.stdout.write(JSON.stringify(results))
"""


@unittest.skipUnless(NODE, "node is not installed")
class LauncherParityTests(unittest.TestCase):
    """static/sessions.js keeps a copy of the casting rule for the launcher.

    Both copies run on the same inputs here, so they cannot drift apart.
    """

    def run_launcher(self, cases):
        result = subprocess.run(
            [NODE, "-e", _SESSIONS_JS_RUNNER, str(SESSIONS_JS)],
            input=json.dumps(cases),
            capture_output=True,
            text=True,
            timeout=30,
        )
        self.assertEqual(result.returncode, 0, result.stderr)
        return json.loads(result.stdout)

    def test_auto_cast_matches_the_server(self):
        code_review = load_template("code-review")
        templates = {
            "code-review": code_review,
            "code-review reversed": dict(code_review, roles=list(reversed(code_review["roles"]))),
            "debate": load_template("debate"),
            "triangle": {"roles": ["x", "y", "z"], "distinct_roles": [["x", "y"], ["y", "z"], ["x", "z"]]},
        }
        cases = [
            {"label": f"{label}, {count} agents", "tmpl": tmpl, "agents": [f"agent{i}" for i in range(count)]}
            for label, tmpl in templates.items()
            for count in range(5)
        ]
        cases.append({"label": "duplicate names", "tmpl": code_review, "agents": ["alpha", "alpha", "beta"]})

        launcher = self.run_launcher([{"op": "autoCast", "tmpl": c["tmpl"], "agents": c["agents"]} for c in cases])

        for case, launcher_cast in zip(cases, launcher):
            with self.subTest(case=case["label"]):
                try:
                    expected = auto_cast(case["tmpl"], case["agents"])
                except CastError:
                    expected = None  # the launcher returns null and leaves the pick to the user
                self.assertEqual(launcher_cast, expected)

    def test_conflicts_match_the_server(self):
        code_review = load_template("code-review")
        casts = [
            {"builder": "alpha", "reviewer": "beta", "red_team": "alpha", "synthesiser": "beta"},
            {"builder": "alpha", "reviewer": "beta", "red_team": "beta", "synthesiser": "alpha"},
            {"builder": "alpha", "red_team": ""},
            {},
        ]

        launcher = self.run_launcher([{"op": "castConflicts", "tmpl": code_review, "cast": cast} for cast in casts])

        for cast, launcher_conflicts in zip(casts, launcher):
            with self.subTest(cast=cast):
                self.assertEqual(launcher_conflicts, validate_cast(code_review, cast))


if __name__ == "__main__":
    unittest.main()
