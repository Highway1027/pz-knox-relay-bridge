# Knox Relay Bridge testing

Blocking right now: nothing.

Automated checks: npm test (transport, telemetry, retry, protocol validators) and the
packaged smoke test (node scripts/smoke-packaged.mjs --real-pz, see AGENTS.md).
Rules: last section.

Bridge hand tests usually run inside a Knox Mission Board sitting (its docs/TESTING.md),
because the Bridge only shows its work together with the mod and the webapp.

---

No open sittings.

## Results so far

- 27-10-2026: file moved to the shared format. The old gates below passed or are
  outdated; their full steps are in git history (docs/TESTING.md before 27-10-2026).
- Phase 4 gate (test mission to PZ, restart, no repeats): passed on B42.20.4.
- Telemetry gate on B42.20.4 and Phase 5A schema check: passed, superseded by later Knox
  sittings.
- Experimental global audio probe (Bridge 0.2.8, Connector 0.20.0): no result recorded;
  see docs/PROTOCOL.md "Experimental global audio test" if it comes back.

## How this file works

Same rules in every project (source: testing-format.md in Tim's ai-setup repo).

- Automated first: unit tests and the self-test check what a script can. This file
  holds only what they cannot: the look, real clicks and keys, a second player or
  device, real AI text, live data.
- "Blocking right now" names only a test whose result changes the next step.
- A sitting is one topic Tim can test in one go, with an estimated time.
- Each sitting takes the next letter (after Z start at A again). Steps use that letter:
  D1, D2, sub-steps D2.1. A big sitting can have parts; each part takes the next letter.
- "Before you start" holds only what Tim must do or check, and how he sees he has the
  right build (which version, shown where). The agent builds, installs and deploys
  beforehand; if it could not, the sitting says what Tim must do instead.
- When a self-test or scenario covers part of a sitting, the first step runs it and
  says which result to expect.
- One action per line, then what you should see on its own line, starting with "-> ".
- Name the exact button, menu, page or test tool.
- Plain text in steps: no bold, italics or backticks. A blank line between steps.
  Sub-steps on their own lines, indented under the step. Lines under about 90 characters.
- A step earlier results make quite safe says "(assumed, based on <result>)": a glance.
- Set-up a step needs (items, objects, sample data) comes from a test tool the build
  adds, never from Tim spawning it by hand.
- Each time a sitting is added or changed, re-read the whole file: one self-test run
  per session of sittings, sittings that share a set-up merged, steps in the order Tim
  walks through them.
- Tim reports by id ("D3 failed"). A step he does not mention counts as passed.
- Passed steps are removed, with one dated line under "Results so far" (newest first).
  When that list gets long, older lines move to TESTING_HISTORY.md.
