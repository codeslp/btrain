---
name: clean-room-rebuild
description: Rebuild the behavior of an existing product, API, or feature in our own stack without copying its code, text, or assets. Use when the user asks to clone, replicate, reverse engineer, rebuild, or "make our own version of" a SaaS app, web UI, protocol, or API, or to copy the 20% of an incumbent product that matters. Runs a legal gate, black-box observation into a labeled behavior spec, a spec firewall, an obligation ledger, a test-first build in a separate session, and a parity check. Not for explaining a binary you own (use reverse-engineer-anything) or for ordinary feature work.
---

# Clean-Room Rebuild

## Goal

Ship our own implementation of a target's *behavior*, with proof that it behaves the same where it must, and a record that shows nothing protected crossed over. Copyright protects expression (code, text, images, distinctive look). It does not protect function, methods of operation, or ideas. The method below keeps us on the function side and makes that provable.

The method has two sides with a wall between them:

- **Study side.** Observes the target. Writes a behavior spec. Never writes product code.
- **Build side.** Reads only the reviewed spec. Never sees the target, its captures, or its code.

In btrain, run each side in its own lane, owned by different agents (for example Claude studies and Codex builds). One agent may not hold both roles for the same target.

## Rules

- **Prefer integration over cloning.** If the target has a public API, an export, a webhook, or an open data format that does the job, stop and propose the integration. A rebuild is for the case where the incumbent is too costly, too clunky, or missing the feature.
- **Scope to what matters.** Name the features to rebuild before observing anything. "Every feature" is not a scope.
- **Our account, our data, normal use.** Observe only through an account we hold lawfully, with test data we own. No fake or extra accounts. No other customers' data.
- **No circumvention.** Never bypass auth, paywalls, rate limits, bot detection, CAPTCHAs, DRM, or license checks. Never fuzz or load-test a production service we do not own. Fuzz only our own build.
- **No decompiling into the build.** Decompiled code, minified bundles, and source maps may be read on the study side only when the ToS and law allow it, and only to describe behavior in prose. Nothing from them goes into the spec as code.
- **Agent calls are not a data pipeline.** Fetch public docs, help centers, and changelogs with deterministic scripts. Use the agent to read and summarize what was fetched, not to crawl.
- **Fail closed.** Unknown, skipped, truncated, or contradictory evidence never counts as a pass.
- **Stop and ask** when the ToS forbids reverse engineering, scraping, or competitive use, when authorization is unclear, or when the target holds personal data you would have to look at. Record the human's decision in the provenance log.

## Workflow

Keep all artifacts under `research/rebuilds/<target>/` (or `specs/<feature>/` in spec-driven repos). The build side reads only `spec.md` and `ledger.md` from that folder.

### Phase 0. Intake and legal gate (study side)

1. Ask for, or find in the conversation: the target (product, version, URL), the exact features to rebuild, our target stack, and any docs, HAR files, logs, or screenshots the user already has.
2. Check for an integration path first: public API, exports, webhooks, data formats. If one covers the scope, recommend it and stop unless the user still wants the rebuild.
3. Fill [references/legal-gate.md](references/legal-gate.md): which ToS we accepted, the clauses on reverse engineering, scraping, and competitive use, the account used, and the source of every input. Any red answer stops the work until a human decides.
4. Open `provenance.md`: a dated, append-only log of every input, who saw it, and every artifact that crossed the wall.

### Phase 1. Black-box observation (study side)

1. Write a question checklist: for each in-scope feature, what must we know (inputs, outputs, states, errors, permissions, limits) and what evidence would answer it.
2. Read public sources first: docs, help center, API reference, changelog, videos, published specs. Then observe the running product through our own account.
3. Record each user flow as a Playwright scenario with stable step IDs. Record a HAR of the scenario (`recordHar`). Take screenshots of each state.
4. Reduce captures before they are kept. Strip cookies, auth headers, tokens, and storage values. Reduce JSON bodies to field names and types. Group requests into `METHOD origin /path/{param}` templates. Never commit a raw HAR.
5. Write `spec.md` with [references/behavior-spec-template.md](references/behavior-spec-template.md). Describe behavior in our own words: features, routes, UI state machines, API surface, validation, error and empty states, permissions, limits. Label every claim **observed**, **inferred**, or **unknown**, with an evidence reference (scenario step, screenshot, doc URL).
6. Mark each observed quirk **keep** (users rely on it) or **drop** (bug we will not copy). A characterization test locks in what it sees, so decide before the build side tests it.
7. Revisit the checklist. Mark each question answered, partial, or unresolved. Do not call the spec complete while an in-scope question is unresolved; move it to an explicit open item.

### Phase 1.5. Spec firewall (a third agent or the human)

A reviewer who is neither the study author nor the builder checks `spec.md` for leaked expression:

- copied sentences, labels, or help text beyond short functional names;
- code, CSS values, SQL, regexes, or config lifted from the target;
- images, icons, fonts, or other assets;
- a description of distinctive look (trade dress) instead of function;
- any credential, token, or personal data.

Fix and re-review until clean. Record the approved spec's `git` hash in `provenance.md`. Only that version crosses the wall.

### Phase 2. Architecture and obligation ledger (build side)

1. Split the spec into modules, each with a strict input/output contract (zod, pydantic, or typed interfaces) and a dependency graph that sets the build order.
2. Write `ledger.md` with [references/obligation-ledger.md](references/obligation-ledger.md). Each spec claim to reproduce becomes an obligation with an ID, an owning module, the case types it needs (positive, negative, malformed, empty, permission-denied, concurrency, cancellation), and its fixtures. An obligation closes only when a passing test names its ID.

### Phase 3. Implementation loop (build side)

The build session must not see the target. Deny it the target's domain (for example a `WebFetch` deny rule or a browser blocklist) and keep `captures/` out of its context.

For each module in build order:

1. Write the tests for its obligations first. Run them and see them fail.
2. Write the code from the spec and contracts only.
3. Run the tests. On failure, read the output, find the mismatch, fix, and run again. Loop until every obligation for the module passes.
4. If the spec is wrong or silent, do not guess from memory of the target. File a question to the study side and wait for a spec revision through the firewall.

### Phase 4. Reconciliation and parity (both sides, through the wall)

1. Wire the modules together. Run end-to-end Playwright tests against our app.
2. The study side alone runs the same scenarios against the target and against our build, compares the reduced captures and screenshots, and returns **divergence descriptions only** (never target captures) to the build side.
3. Close or explicitly accept each divergence. Unknown or truncated comparisons do not pass.

### Phase 5. Distinctiveness and close-out

1. Give the rebuild its own name, branding, and copy. In FCC repos, write user-facing copy with `callie-voice`.
2. Scan our code and UI strings against the study-side captures for long verbatim matches. Rewrite any that are not short functional terms.
3. Revisit the Phase 1 checklist and the ledger. Report answered, partial, and unresolved items honestly.
4. Close `provenance.md` with the final commit hash.

## Acceptance checks

- The legal gate is filled, and every red item has a recorded human decision.
- Every spec claim has a label and an evidence reference. No raw HAR, cookie, token, or personal data is committed.
- The firewall review passed, and its spec hash is in `provenance.md`.
- Every in-scope obligation has an owner, fixtures for each required case type, and a passing test that names its ID.
- End-to-end parity has no unexplained divergence.
- The verbatim-match scan is clean.
- The study and build sessions were different agents, and the build session never had the target in context.

## btrain handoff

- Study lane locks `research/rebuilds/<target>/` except `build/`. Build lane locks the product code and tests.
- Study lane hands the firewall review to a reviewer who is not the builder. The build lane's `Why this was done` field names the spec hash it built from.
- Put open spec questions in the build lane's `Remaining gaps`, not in a side channel.

## Related skills

- `reverse-engineer-anything`: rea's evidence-first study method for shipped binaries, packages, bundled JavaScript, and pages you own. Study side only.
- `test-writer`, `integration-test-check`, `tessl__webapp-testing`: build-side tests and Playwright scenarios.
- `secure-by-default`: any rebuilt auth, permission, or mutating route.
