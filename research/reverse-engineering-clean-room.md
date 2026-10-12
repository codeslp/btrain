# Reverse Engineering and Clean-Room Rebuilds for Agents

**Date:** 2026-10-12
**Status:** Adopted. Two bundled skills: `reverse-engineer-anything` (vendored) and `clean-room-rebuild` (new).
**Sources evaluated:** [morluto/rea](https://github.com/morluto/rea) at `c9aecde`, and a pasted four-phase "Autonomous Reverse Engineering and Clean-Room Reimplementation Agent" prompt.

## Question

btrain agents are being asked to "rebuild the 20% of product X that matters" for client
work (first case: Fowler Culinary Concepts, see `zo_cal/impl-notes/fcc-opportunity-research.md`).
What method should a bundled skill teach so that agents can do this well, and without
copying protected expression or breaching terms?

## Summary

Neither source is enough alone.

- **rea** is a large evidence-gathering toolkit (MCP server, CLI, and one main skill) for
  shipped binaries, packages, bundled JavaScript, HAR captures, and pages you own. Its
  evidence discipline is excellent. But its skill expects the same agent to read
  decompiled code and then build, which is the opposite of a clean room. On building, the
  skill says only to "use normal coding tools and separate observed behavior from design
  choices".
- **The pasted method** supplies the build half that rea lacks: architecture with strict
  I/O contracts and a build order, a test-then-fix loop per module, and end-to-end
  reconciliation. It has no legal gate, no wall between observer and implementer, no
  observed/inferred/unknown labels, unsafe capture handling, and it says to fuzz the
  target, which against someone else's production SaaS risks breach and trespass claims.

We ship rea's skill unchanged for study work, and a new `clean-room-rebuild` skill that
merges the pasted method's build loop with rea's evidence rules and adds the missing gates.

## rea

| Item | Finding |
|---|---|
| License | MIT, copyright 2026 morluto. Third-party engines keep their own licenses. Vendoring is allowed with the notice. |
| Install | `npx rea-agents setup` registers the MCP server per client and copies the skill. Skill-only: `npx skills add morluto/rea --skill reverse-engineer-anything`. |
| Main skill | `.agents/skills/reverse-engineer-anything/` (metadata version 40) plus six reference guides. |
| Tool assumptions | Hopper, Ghidra, or IDA; JADX/Apktool; Wakaru; HAR or mitmproxy files; Chrome DevTools Protocol; Playwright; WABT; Binwalk/Unblob. |
| Without the MCP server | The skill names REA tools throughout, so most of it does nothing. Its evidence rules still apply. |
| Stance | `DISCLAIMER.md` names lawful uses (interoperability, preservation, security research, software you own) and refuses DRM or license circumvention, auth or bot-protection bypass, and copying protected code or assets. |

Ideas from rea's docs that `clean-room-rebuild` adopts:

- **Evidence labels.** Every conclusion is an observation, an inference, or an unknown, with an evidence reference.
- **Question checklist.** Turn the request into questions with the evidence each needs; revisit and mark answered, partial, or unresolved before finishing.
- **Obligation ledger** (`docs/reconstruction-obligation-ledgers.md`). Each claim to reproduce has an ID, an owner, required case types, and fixtures. It closes only when a passing check names it.
- **Fail closed** (`docs/reconstruction-readiness.md`). Fail, unknown, unsupported, truncated, or skipped never counts as a pass.
- **Value-free captures** (`docs/browser-observation.md`). Cookies, auth headers, and storage values are never kept; JSON bodies keep field names and types only.
- **Scripted scenarios** (`docs/browser-scenario-contract.md`). Playwright steps with stable IDs, and step-by-step comparison of two captures.
- **API surface from HAR.** Requests grouped by method, origin, and path template. Nothing is replayed.

Not adopted: decompilation or source recovery as a build input, and the native-binary
toolchain for web-product work.

## Legal background

This is a risk screen for engineers, not legal advice. Several sources are secondary.

**Copyright protects expression, not function.**
- Lotus v. Borland: a menu command hierarchy is an uncopyrightable method of operation. ([summary](https://en.wikipedia.org/wiki/Lotus_Development_Corp._v._Borland_International,_Inc.))
- Apple v. Microsoft: look-and-feel claims are split into elements and compared one by one. ([Justia](https://law.justia.com/cases/federal/appellate-courts/F3/35/1435/605245/))
- SAS v. WPL (CJEU 2012): functionality and programming languages are not protected, and a licensee may observe, study, and test. Copying the manual's wording did infringe. ([RPC](https://www.rpclegal.com/thinking/ip/no-copyright-in-software-functionality-sas-v-wpl-the-final-chapter/))
- Google v. Oracle (2021): reimplementing API declarations was fair use. ([Jones Day](https://www.jonesday.com/en/insights/2021/04/supreme-court-google-wins-copyright-battle))

**Intermediate copying while studying.** Sega v. Accolade and Sony v. Connectix held
disassembly fair use when it was the only way to reach functional elements.
([Connectix](https://en.wikipedia.org/wiki/Sony_Computer_Entertainment,_Inc._v._Connectix_Corp.))

**Contract is the bigger risk for SaaS.**
- Bowers v. Baystate enforced a license ban on reverse engineering over a fair-use defense. ([summary](https://en.wikipedia.org/wiki/Bowers_v._Baystate_Technologies,_Inc.))
- Davidson v. Jung (bnetd) enforced EULA and ToS bans and found DMCA liability. ([422 F.3d 630](https://law.resource.org/pub/us/case/reporter/F3/422/422.F3d.630.04-3654.html))
- hiQ v. LinkedIn: the CFAA does not reach public data, but contract and other claims remain. ([Goldman](https://blog.ericgoldman.org/archives/2022/05/once-again-linkedin-cant-use-cfaa-to-stop-unwanted-scraping-hiq-v-linkedin.htm))
- X Corp. v. Bright Data (2024) preempted some ToS claims against scraping public content, but later let trespass claims proceed over fake accounts and IP rotation.
- **Upshot:** a clean room defends against copyright claims, not against breach of terms you accepted. The skill therefore reads the terms first and stops on a red answer.

**DMCA section 1201.** The interoperability exemption covers circumvention only to make an
independently created program interoperate. Bypassing a SaaS product's auth, rate limits,
or bot protection is outside it. ([Project DisCo](https://project-disco.org/intellectual-property/070617-interoperability-and-the-copyright-offices-section-1201-report/))

**Trade dress.** A distinctive, non-functional look can be protected, so the rebuild gets
its own name, branding, and copy.

**Clean-room precedent.** Phoenix's IBM BIOS clone: engineers who studied the original
wrote a code-free English spec; engineers who had never seen it built from the spec; the
exchanges were logged. ([history](https://historyofinformation.com/detail.php?id=3391))
The 2026 chardet dispute showed the AI weak point: an LLM rewrite was challenged because
its driver had seen the original, and similarity scores did not settle it.
([ShiftMag](https://shiftmag.dev/license-laundering-and-the-death-of-clean-room-8528/))
A model's training exposure cannot be audited, so the provenance log carries the weight.

## Existing agent skills for cloning

`clone-team`, `ai-website-cloner-template` (`/clone-website`), and Firecrawl's
`open-lovable` aim at pixel-perfect copies of pages. That is the trade-dress and
expression risk, and reviews report that they copy the look of complex apps but not the
logic. None separates study from build. These were assessed from listings, not by
running them.

## Decision

1. **Vendor `reverse-engineer-anything` unchanged** on both skill surfaces, with the MIT
   `LICENSE` and a `VENDORED.md` that pins the upstream commit and says btrain does not
   install the REA MCP server.
2. **Add `clean-room-rebuild`**, btrain's own skill:
   - Phase 0: intake, integration-first check, legal gate, provenance log.
   - Phase 1: study side observes through our own account; Playwright scenarios with step IDs; value-free HAR reduction; a behavior spec with every claim labeled; keep/drop decision for each quirk.
   - Phase 1.5: a spec firewall review by someone who is neither study author nor builder.
   - Phase 2: modules with typed contracts and an obligation ledger.
   - Phase 3: test-first build in a session that cannot see the target.
   - Phase 4: parity runs where only divergence descriptions cross the wall; fail closed.
   - Phase 5: own branding and copy, verbatim-match scan, close the provenance log.
3. **Map the wall onto btrain lanes.** Study and build are different lanes owned by
   different agents; the build lane names the spec hash it built from.
4. **Respect the agent-call rule.** Public docs are fetched by deterministic scripts; agents
   read and summarize, they do not crawl.

## Open items

- The README "Bundled Skills" table should list both skills. README.md was locked by lane e
  when this landed; add the two rows after that lane merges.
- Whether to register the REA MCP server anywhere is an operator choice. Nothing in btrain
  depends on it.
- The legal points need a lawyer's review before any client-facing rebuild of a product
  whose terms forbid reverse engineering.
