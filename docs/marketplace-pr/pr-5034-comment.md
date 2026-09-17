## Updated to v0.9.0 — the numbers in this entry were stale

Thanks for keeping the list — sorry for the noise. The entry file was written when the plugin was
`v0.7.0`; it has since been reworked, so **every number in the current description is wrong**
(four roles / 48 tools). Corrected facts, all verifiable in the repo and on npm:

| | was (v0.7.0) | now (v0.9.0) |
| --- | --- | --- |
| npm | `dsh-redteam-mode@0.7.0` | [`dsh-redteam-mode@0.9.0`](https://www.npmjs.com/package/dsh-redteam-mode) |
| agent roles | 4 | **5 executors + 1 planner session** (recon / asset triage / vulnerability discovery / exploitation / internal pivot) |
| `redteam_*` tools | 48 | **53** (adds `redteam_preflight`, `redteam_agent_slot`, `redteam_session_bind`, `redteam_session_info`, `redteam_asset_timeline`) |
| console tabs | 11 | **12** (adds the agent-roster tab; assets gained a discovery timeline view) |
| concurrency | unlimited | planner session hard-capped at **3 concurrent agents** (`redteam_agent_slot` reads the real `ctx.subagents` count) |
| sessions | one global target pointer | **per-session target binding** (root-session keyed, subagents inherit via `session.header.parentSession`) |

New in 0.9.0, in case it matters for the category call: preflight skill/resource check that asks the
user for a missing key or VPS instead of silently failing; asset **discovery timestamps**; a
**category-organised** POC/EXP knowledge base that records creation time and the asset each entry was
found on; and a report where every score item spells out *how it was obtained* (actions, exact
commands, credential provenance, tunnel build commands) instead of only the result.

Verification I ran for this PR originally still holds — `dsh plugin --profile web add dsh-redteam-mode`
on a clean `DSH_HOME` and a fresh profile, then restart and (a) the preset mounts, (b) the right-side
console loads, (c) the sidebar/console tabs render. The 0.9.0 build additionally passed the repo's
zero-dependency regression suite (10 files, 297 assertions, including a client-bundle load check and a
preset self-heal check). `prepublishOnly` runs `build --check` + the bundle contract test.

I'll push the description fix to this branch now. Happy to change the category, the wording, or split
anything out if you'd prefer it filed differently.
