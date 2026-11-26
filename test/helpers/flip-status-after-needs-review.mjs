// Preload for a btrain child process: `node --import <this file> cli.mjs ...`.
//
// It simulates another agent that moves a lane on right after btrain writes
// `Status: needs-review` and before btrain dispatches the reviewer. btrain
// writes the handoff file with a temporary file and a rename (writeText), so
// the hook runs after the rename that publishes needs-review to the file
// named by BTRAIN_TEST_FLIP_HANDOFF. It rewrites that status to
// BTRAIN_TEST_FLIP_STATUS once, then writes BTRAIN_TEST_FLIP_MARK so the test
// can prove the flip happened. Both happen before btrain's await of the
// rename returns, so btrain's next read of the lane sees the new status:
// no second process and no timing.
import fs from "node:fs/promises"

const handoffPath = process.env.BTRAIN_TEST_FLIP_HANDOFF || ""
const nextStatus = process.env.BTRAIN_TEST_FLIP_STATUS || "ready-for-pr"
const markPath = process.env.BTRAIN_TEST_FLIP_MARK || ""

if (handoffPath) {
  const rename = fs.rename
  let flipped = false

  async function sameFile(left, right) {
    try {
      return (await fs.realpath(left)) === (await fs.realpath(right))
    } catch {
      return false
    }
  }

  fs.rename = async function renameThenFlip(from, to, ...rest) {
    const result = await rename.call(this, from, to, ...rest)
    if (!flipped && (await sameFile(String(to), handoffPath))) {
      const content = await fs.readFile(handoffPath, "utf8")
      if (content.includes("Status: needs-review")) {
        flipped = true
        await fs.writeFile(handoffPath, content.replace("Status: needs-review", `Status: ${nextStatus}`), "utf8")
        if (markPath) await fs.writeFile(markPath, `flipped to ${nextStatus}\n`, "utf8")
      }
    }
    return result
  }
}
