// A fake clock for the spec 023 review request loop (implementation plan,
// WS0). `runReviewRequest` takes `now` and `sleep` as arguments; a test passes
// this clock's, so a 15-minute window runs in milliseconds of real time.
//
//   const clock = createFakeClock({ start: Date.parse("2026-11-23T12:00:00Z") })
//   clock.at(14 * 60_000, () => writeProgressEvent())   // runs when time reaches minute 14
//   await runReviewRequest({ now: clock.now, sleep: clock.sleep, ... })
//
// In the default `auto` mode, `sleep(ms)` moves time forward by `ms` at once,
// runs every callback scheduled up to the new time (in time order, awaiting
// each), and then resolves on a later turn of the event loop, so I/O the
// caller started can finish. With `auto: false`, `sleep` waits until the test
// calls `advance(ms)` or `advanceTo(time)`.
//
// `now()` returns milliseconds since the epoch, like `Date.now()`. `iso()`
// returns the same time as an ISO string, for event timestamps.

const yieldTurn = () => new Promise((resolve) => setImmediate(resolve))

export function createFakeClock({ start = Date.UTC(2026, 10, 23, 12, 0, 0), auto = true } = {}) {
  let current = Number(start)
  const scheduled = []
  const sleepers = []
  let sequence = 0
  let sleepCalls = 0
  let slept = 0

  async function runDue() {
    scheduled.sort((left, right) => left.time - right.time || left.order - right.order)
    while (scheduled.length > 0 && scheduled[0].time <= current) {
      const entry = scheduled.shift()
      await entry.callback(current)
    }
  }

  function wakeSleepers() {
    sleepers.sort((left, right) => left.until - right.until || left.order - right.order)
    while (sleepers.length > 0 && sleepers[0].until <= current) {
      sleepers.shift().resolve()
    }
  }

  async function moveTo(target) {
    if (!(target >= current)) {
      throw new Error(`The fake clock cannot go back from ${current} to ${target}.`)
    }
    // Stop at each scheduled callback on the way, so a callback sees the time
    // it asked for.
    for (;;) {
      scheduled.sort((left, right) => left.time - right.time || left.order - right.order)
      const next = scheduled[0]
      if (!next || next.time > target) break
      current = Math.max(current, next.time)
      await runDue()
    }
    current = target
    await runDue()
    wakeSleepers()
  }

  const clock = {
    now: () => current,
    iso: () => new Date(current).toISOString(),
    /** Time since the clock started, in milliseconds. */
    elapsed: () => current - Number(start),
    /** How many times the code under test slept, and for how long in all. */
    stats: () => ({ sleepCalls, slept }),
    /** Run `callback` when time reaches `start + offsetMs`. */
    at(offsetMs, callback) {
      scheduled.push({ time: Number(start) + offsetMs, callback, order: sequence++ })
    },
    /** Run `callback` when time reaches the absolute time `time`. */
    atTime(time, callback) {
      scheduled.push({ time, callback, order: sequence++ })
    },
    async sleep(ms) {
      const duration = Math.max(0, Number(ms) || 0)
      sleepCalls += 1
      slept += duration
      if (auto) {
        await moveTo(current + duration)
        await yieldTurn()
        return
      }
      await new Promise((resolve) => {
        sleepers.push({ until: current + duration, resolve, order: sequence++ })
      })
    },
    async advance(ms) {
      await moveTo(current + Math.max(0, Number(ms) || 0))
      await yieldTurn()
    },
    async advanceTo(time) {
      await moveTo(time)
      await yieldTurn()
    },
    /** Sleepers still waiting (manual mode). */
    pendingSleepers: () => sleepers.length,
  }
  clock.sleep = clock.sleep.bind(clock)
  return clock
}
