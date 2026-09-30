## Updated for v0.12.5 — two described numbers changed, plus two new capabilities

`dsh-redteam-mode@0.12.5` is on npm (`npm view dsh-redteam-mode version` → `0.12.5`). This entry
update keeps the description exact after a console revision:

| | before | now | why |
| --- | --- | --- | --- |
| console tabs | 12 | **9** | three tabs were folded into the pages they belong to (see below) |
| concurrency | "up to three concurrent agents" | **user-configurable, three by default** | was an env var + restart; now a setting in the console, effective immediately |

The three merged tabs, so a reader can still find everything the entry used to enumerate:

- **current test** → inside *asset mapping*, next to the C-segment/external/internal groupings
- **agent prompts** → inside *agents* (concurrency setting, role roster and prompt editing on one page)
- **attack files** → a sub-tab of *findings*, and every vulnerability now lists the attack files
  archived against it (`attack_file.vuln_id`), so the two are cross-referenced

Two capabilities added in the same release, now mentioned in the description:

- the **skill library** reports, for each unusable skill, *why* it is unusable **and the concrete
  repair steps** (missing tool → how to install it, per tool; missing `FOFA_KEY` → where to get it
  and how to self-test; VPS placeholder → the three ways to fill it). Coverage: 54 tools and 23 skills.
- the **agents** tab exposes the concurrency limit with an explicit warning that a single model API
  key shares one concurrency/rate budget, so raising it too far destabilises a run instead of
  speeding it up.

Re-verified at the `v0.12.5` tag:

| | value | how to check |
| --- | --- | --- |
| npm | `dsh-redteam-mode@0.12.5` | `npm view dsh-redteam-mode version` |
| console tabs | **9** | `grep -A12 'const tabs = \[' packages/redteam-ui/lib/client.js` |
| native skills | **14** | `ls packages/redteam-bundle/skills \| wc -l` |
| `redteam_*` tools | **53** | `grep -o 'redteam_[a-z_]*' packages/redteam-bundle/lib/tools.js \| sort -u \| wc -l` |
| scoring | **8 categories / 25 points** | `packages/redteam-bundle/lib/score-rules.js` |
| npm package ships no tool installer | confirmed | `package.json` `files` has no `scripts/`; `tools/distribution.mjs` |

Regression before publishing: the repo's zero-dependency suite (14 files, 564 assertions) plus
`build --check`; both also run as `prepublishOnly`.
