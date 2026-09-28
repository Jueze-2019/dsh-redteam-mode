## Updated to v0.11.8 — one line added to the scoring description

The entry is unchanged in shape; one capability note was missing. The numbers already in the
current description are still exact for this revision:

| | value | how to check in the repo |
| --- | --- | --- |
| npm | [`dsh-redteam-mode@0.11.8`](https://www.npmjs.com/package/dsh-redteam-mode) | `npm view dsh-redteam-mode version` |
| agent roles | 5 executors + 1 planner session | `presets/redteam/` prompt sections, `redteam_role_prompt` enum |
| `redteam_*` tools | **53** | `grep -c "name: 'redteam_" packages/redteam-bundle/lib/tools.js` |
| native skills | **23** | `ls packages/redteam-bundle/skills \| wc -l` |
| console tabs | **12** | `packages/redteam-bundle/lib/client.js`, `const tabs = [...]` |
| scoring | **8 categories / 25 points** | `packages/redteam-bundle/lib/score-rules.js`, `DEFAULT_SCORE_POINTS` (25 entries) |

**What changed in the description:** the scoring clause now says that a login which fits no more
specific category is scored as controlling a web application system instead of being dropped. In
practice the most common real-world finding is "a credential that logs into a web console nobody
labelled" — email/OA it is not, so it used to fall through the cracks. `web-app` now explicitly
covers it (admin 100 / user 50, cap 2000 unchanged), and the same clarification went into the
scoring-rules document the plugin ships with.

Nothing else in the entry moved: same repository, same subdirectory, same category, same install
command. If the added clause makes the description too long for the list, I'm happy to shorten it —
just say which part to cut.

Regression before publishing: the repo's zero-dependency suite (14 files, 530 assertions) plus
`build --check`, which also runs as `prepublishOnly`.
