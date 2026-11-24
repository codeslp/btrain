// `node --import ./test/helpers/fake-slack-preload.mjs src/brain_train/cli.mjs ...`
//
// Makes a btrain subprocess answer Slack calls from the fake in
// test/helpers/fake-slack.mjs and append each call to the JSONL log that
// BTRAIN_FAKE_SLACK_LOG names. Build the environment with
// `fakeSlackProcessEnv` and read the calls back with `readFakeSlackLog`.
// Without BTRAIN_FAKE_SLACK_LOG this preload changes nothing.
import { installFakeSlackFromEnv } from "./fake-slack.mjs"

installFakeSlackFromEnv(process.env)
