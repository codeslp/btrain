# Legal gate

Fill this before any observation. It is a risk screen, not legal advice.

- A **hard stop** answer ends the work. No human decision overrides it.
- Any other **red** answer stops the work until a human decides, and the decision goes in `provenance.md`.

| # | Question | Answer | Green / red |
|---|---|---|---|
| 1 | Target product, vendor, version, URL | | |
| 2 | Features in scope (list) | | |
| 3 | Does a public API, export, webhook, or open format already cover the scope? | | red if yes and the user has not chosen the rebuild anyway |
| 4 | Which terms did we accept, and when? (link and date) | | red if unknown |
| 5 | Do the terms forbid reverse engineering, decompiling, or deriving source? | | red if yes |
| 6 | Do the terms forbid scraping, automated access, or bots? | | red if yes and Phase 1 uses automation against the live product |
| 7 | Do the terms forbid building a competing product, or using the service for competitive analysis? | | red if yes |
| 8 | Which account will we observe through? Is it ours, in good standing, used as intended? | | red if not ours |
| 9 | Will observation expose other people's personal data? | | red if yes |
| 10 | Does any step need to get past auth, rate limits, bot detection, DRM, or a license check? | | **hard stop** if yes |
| 11 | Will anything be decompiled or de-minified? Is that allowed by the terms and local law? | | red if yes and not clearly allowed |
| 12 | Is the target's look distinctive enough that copying it could confuse buyers? | | red if we plan to match it |

## Background

These points explain why the gate asks what it asks. Sources are in btrain
`research/reverse-engineering-clean-room.md`.

- Copyright covers expression, not function or methods of operation (Lotus v. Borland;
  SAS v. WPL). Reimplementing an interface can be fair use (Google v. Oracle).
- Disassembly to reach functional elements has been fair use when it was the only way
  (Sega v. Accolade; Sony v. Connectix). That is a copyright defense, not a contract one.
- Contract terms can forbid reverse engineering, and courts have enforced them
  (Bowers v. Baystate; Davidson v. Jung). A clean room does not cure a breach of terms
  you accepted.
- DMCA section 1201 forbids circumventing access controls; its interoperability
  exemption is narrow.
- A clean room is only as good as its separation. AI rewrites have been challenged
  because the person or model that wrote the code had seen the original. Keep the
  provenance log.
