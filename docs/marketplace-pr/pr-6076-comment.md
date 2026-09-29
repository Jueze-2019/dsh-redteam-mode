## Re-verified at v0.12.1 — entry unchanged, numbers still exact

`dsh-redteam-mode@0.12.1` is on npm now (`npm view dsh-redteam-mode version` → `0.12.1`). **Nothing
this entry describes changed**, so the entry file is untouched and the diff in this PR is still the
only change.

v0.12.1 is a fix for the harness side, not for the plugin's capabilities: DSH 0.1.7-alpha.1 moved
agent presets from `$DSH_HOME/.agent-presets/` directories to `@deepseek-ai/dsh-agent-preset`
declaration rows, so on newer DSH the plugin's "red team mode" entry stopped showing up in the
new-session picker (everything else — fact base, console, tools, skills — kept working). No number
in this entry depends on that mechanism.

Re-checked at the `v0.12.1` tag:

| | value | how to check |
| --- | --- | --- |
| npm | `dsh-redteam-mode@0.12.1` | `npm view dsh-redteam-mode version` |
| native skills | **14** | `ls packages/redteam-bundle/skills \| wc -l` |
| `redteam_*` tools | **53** | `grep -o 'redteam_[a-z_]*' packages/redteam-bundle/lib/tools.js \| sort -u \| wc -l` |
| console tabs | **12** | `packages/redteam-bundle/lib/client.js` |
| scoring | **8 categories / 25 points** | `packages/redteam-bundle/lib/score-rules.js` |
| npm package ships no tool installer | confirmed | `package.json` `files` has no `scripts/`; `tools/distribution.mjs` |

Regression before publishing: the repo's zero-dependency suite (14 files, **566 assertions**) plus
`build --check`; both also run as `prepublishOnly`, so a drifted or leaking tree cannot be published.
