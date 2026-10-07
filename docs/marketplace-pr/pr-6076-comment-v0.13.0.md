## Re-verified at v0.13.0 — entry updated for the new capability

The entry gained one capability this round, so the description changed; everything else (repo,
subdirectory, category, install command) is untouched. Numbers re-checked against the repo:

| | value | how to check |
| --- | --- | --- |
| npm | [`dsh-redteam-mode@0.13.0`](https://www.npmjs.com/package/dsh-redteam-mode) | `npm view dsh-redteam-mode version` |
| agent roles | 5 executors + 1 planner session | `presets/redteam/` prompt sections |
| `redteam_*` tools | **56** (was 53) | `grep -c "name: 'redteam_" packages/redteam-bundle/lib/tools.js` |
| native skills | **14** shipped (+9 attack-chain skills as a separate toolkit attachment) | `ls packages/redteam-bundle/skills \| wc -l` |
| console tabs | **9** | `packages/redteam-bundle/lib/client.js`, `const tabs = [...]` |
| fact-base tables | **22** | `packages/redteam-bundle/lib/schema.js`, `DDL` |
| scoring | 8 categories / 25 points (unchanged) | `packages/redteam-bundle/lib/score-rules.js` |

**What changed in the description.** Two clauses were added/updated:

1. **Evidence screenshots.** A screenshot can now be registered against a score point and is shown
   inline in the console (expand the point) and embedded in the report. Two details worth stating in
   the entry because they are deliberate design decisions rather than bugs: at most **three
   representative shots per score point** (a bulk result like dozens of endpoints would otherwise
   flood both the console and the report), and on-site screenshots are kept **strictly apart** from
   record-generated evidence cards — the console labels them differently and the report prints a
   "generated, not an on-site screenshot" note, so a generated card can never be mistaken for
   captured evidence.
2. **Tool count** 53 → 56 (`redteam_shot_add` / `redteam_shot_list` / `redteam_shot_delete`).

The report clause was also extended: a score entry now carries a reproduction entry that is either a
paste-ready HTTP request for Burp/Yakit or a runnable command, plus success criteria and an evidence
index, with the evidence screenshot next to it.

**Regression before publishing:** the repo's zero-dependency suite — 15 files, **595 assertions**
(added a dedicated evidence-screenshot test plus console/report render assertions) — and
`build --check`, which also runs as `prepublishOnly`.

Nothing else in the entry moved. If the longer description is a problem for the list, tell me which
clause to cut and I will shorten it.
