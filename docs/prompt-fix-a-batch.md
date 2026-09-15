# 提示词精准手术（A 批次）改动说明

日期：2026-09-15 · 版本：**v0.7.8**（内容对应提交 `be7909b`；首发的 v0.7.7 因 npm 暂存冲突作废，见文末「发版备注」） · 范围：**只修硬伤，不动结构**（B 结构重构 / C 机制增强未做）

起因：一次提示词审计发现提示词里存在"写了但不会生效"的指令，其中最严重的一条已经在真实靶标上造成数据丢失。

---

## 一、修了什么（6 条硬伤）

| # | 问题 | 影响 | 修法 |
|---|---|---|---|
| ① | `redteam_asset_test` 的 **`notes` 参数不存在**（schema 只有 `test`/`surface`），但 4 个角色提示词 + commander 人设 + 工具描述 + README 共 20+ 处教模型传 `notes` | 未声明参数被静默丢弃：**"排除结论/登录失败原因/重测理由"全部没落库**，台账空白 → 后面重复打 | ① 提示词统一改 `test`（追加式）；② `updateAssetTest` 同时接受 `notes` 与 `test`（兼容别名，一并追加进 `test_notes`）；③ schema 显式暴露 `notes` 别名并标注 |
| ② | `stage_code` **三处说法不一**：权威值是 `recon/internet/boundary/internal/target`，但 `redteam_chain_add` 的工具描述给的是已废弃的 `external/foothold/tunnel/privilege` | live 库 12 个靶标共 **48 条攻击链步骤带废弃值**（国电投 31、湖州 16、粤港供水 1），这些步骤在任何阶段都不计数 | ① 工具描述改为 5 个合法值 + `enum` 约束；② commander 人设补"严禁自造值 + 写了会怎样"；③ 服务端白名单校验：非法值退回 `stage` 兜底并回 `stage_hint` 告警；④ 导出 `VALID_STAGE_CODES` |
| ③ | 隧道登记示例**缺 `entry_kind`**（只是可选参数，但留空即 `legit=null`，攻击链只认 `legit===true`） | 已建好的通道不算"边界突破"分；实测 6 条隧道 3 条 `entry_kind` 为空 | 提示词补"`entry_kind` 是边界突破得分凭证，留空不计"；示例补全 `kind/listen`（必填）与 `entry_kind` |
| ④ | 提示词从没给出 **10 个得分点 code**，但 `redteam_score_hit` 的 `code` 与 `chain_add` 的 `point_code` 都必填（否则抛 `score point not found`） | 实测 3 个靶标 `score_point` 表 0 行、新疆机场改过名称 → 照硬编码清单走会直接报错 | 记分纪律写明"**必填两样：`code` + `evidence`**"并列出 10 个默认 code + "以 `redteam_score_list` 为准" |
| ⑤ | commander 人设里**写死了 VPS 真实 IP**（安装产物里被替换成了实际地址，违反 README §6"仓库里不含任何真实基础设施地址"） | 基础设施地址每次会话开场进模型上下文，极易漏进报告/攻击文件 | 改回占位符 `http://<你的VPS_IP>:9100/` + "加载技能 `vps-reverse-shell` 取当前地址" + "严禁写进任何提交物"；本机 live 文件同步清除（已确认 0 处残留） |
| ⑥ | `chain_add` 带 `point_code` 却不给 `evidence` 时**静默跳过记分**（`catch { }`） | 模型以为记上了，实际没有 | 改为回 `score_hint`："带了 point_code 但没给 evidence，本次**没有记分**"；记分真失败时也把原因回给模型 |

顺带修掉的（同一次改动里、零风险）：
- `recon` 提示词里 **`## 记分纪律` 整节 742 字逐字重复两次** → 删除重复节；
- `status` 枚举补全为 6 值（原来漏 `blocked`/`no_surface`）；
- `test_status` 查库示例、`blocked_count` 累计口径（每次 `blocked=true` 单独调用 +1）、被封 >3 次在**同一次调用**里置 `abandoned`；
- 写死的 nuclei 模板数量 → 改为"以 `redteam_poc_search` 返回的 `local_templates.total` 为准"；
- 技能清单不再硬编码（改"以系统注入的 `<available_skills>` 为准"）；
- 委派时隧道端口"必须贴真实值，不许照抄示例 1080"；
- `internal` 提示词里的 `<你的VPS_IP>` 补"这是占位符，不要原样执行"；
- `vuln-scan` 的编号断链（两段各从 1 数到 5）→ 加小标题分开。

## 二、改了哪些文件

源码（改这里才持久）：

| 文件 | 改动 |
|---|---|
| `packages/redteam-store/lib/core.js` | 4 个角色提示词（`DEFAULT_PROMPTS`）+ `updateAssetTest` + `addChainStep` + 新增导出 `VALID_STAGE_CODES` |
| `packages/redteam-tools/lib/index.js` | `asset_test` 加 `notes` 别名、`chain_add` 的 `stage_code` 改 enum + 措辞、`score_hit`/`attack_chain` 描述校正 |
| `preset/agent.cordis.yml` | commander 人设：stage_code 合法值、记分必填 code、VPS 占位符、entry_kind 凭证说明、技能清单去掉 |
| `packages/redteam-store/test/prompt-contract.test.mjs` | **新增**回归测试（17 项断言），锁住以上契约 |

生成物（`node packages/redteam-bundle/tools/build.mjs` 生成，已 `--check` 通过）：`packages/redteam-bundle/lib/{store-core,tools}.js`、`presets/redteam/agent.cordis.yml`。

本机生效路径（已同步 + 备份）：
- `~/.dsh/profiles/web/node_modules/dsh-redteam-mode/{lib,skills,presets}`（备份 `lib.bak-*`）
- `~/.dsh/.agent-presets/redteam/agent.cordis.yml`（备份 `agent.cordis.yml.bak-*`）

## 三、验证

```bash
for t in packages/redteam-store/test/*.mjs packages/redteam-tools/test/*.mjs packages/redteam-bundle/test/*.mjs; do node "$t"; done
node packages/redteam-bundle/tools/build.mjs --check
```

结果：**165/165 通过**（新增 18 项），build 与源码同步。

实际生效验证：
- 新进程 PID 31040（19:28:35 启动），3080 已监听；
- `~/.dsh/.agent-presets/redteam/agent.cordis.yml` 已含新内容、VPS 真实 IP **0 处**、技能目录占位符已正确替换；
- `~/.dsh/profiles/web/node_modules/dsh-redteam-mode` 的 lib 与 bundle 逐字节一致；
- 读一次 `redteam_role_prompt` 触发角色提示词自动升级：湖州靶标 4 个角色已换成新版（recon 的重复节消失、四角色都带"必填 code"纪律）、manifest 指纹同步刷新，其余 11 个靶标在各自下次打开面板/被读取时自动升级（**用户自己改过的角色提示词不会被覆盖**，这是既有设计）。

## 四、没做的（留着看需要再说）

- **B 结构重构**：抽公共段落、四角色瘦身 ~30%、commander 章节重排、委派并发上限——纯效率优化，不影响正确性。
- **C 机制增强**：给 `tool-subagent` 配 `maxDepth: 1`（当前默认 3，靠提示词劝"不要再派子智能体"是软的）；`assets.db` 里 48 条历史废弃 `stage_code` 的清洗脚本（迁移只清 `stage_code` 不再新增的旧值，历史数据仍在）。

## 五、发版备注（npm 暂存冲突）

首发的 `v0.7.7` 遇到 npm 的暂存（staged publish）机制：

```
npm http fetch PUT 409 https://registry.npmjs.org/dsh-redteam-mode
409 Conflict - Cannot publish over previously staged version "0.7.7".
```

特征：`npm publish` 的输出**看起来成功**（最后打印 `+ dsh-redteam-mode@0.7.7`），但 tarball 取不到
（`https://registry.npmjs.org/dsh-redteam-mode/-/dsh-redteam-mode-0.7.7.tgz` → 404），
等 90 秒重试仍报同一个 409 —— 版本号被服务端的暂存记录占住。

处置：**内容不变、版本号 +1 重发**（`0.7.8`），`v0.7.7` 的 commit 与 tag 保留在 git 历史里作为记录。
以后遇到同名报错直接升版本号，不要在同一个版本号上反复重试。

**判断发布是否真的成功，别只看 npm 的输出**，用这两条验证：

```bash
curl -s -o /dev/null -w "%{http_code}\n" https://registry.npmjs.org/dsh-redteam-mode/-/dsh-redteam-mode-0.7.8.tgz   # 期望 200
npm view dsh-redteam-mode version dist-tags                                                                        # latest 应指向新版本
```

## 六、本次发布用的推送凭证（本机记录）

仓库已从 HTTPS 切到 SSH（HTTPS 无 credential helper、推不上去）：

```
origin  git@github.com:Jueze-2019/dsh-redteam-mode.git
~/.ssh/dsh-github          # 推送专用 ed25519 密钥（非默认 id_ed25519）
~/.ssh/dsh-github.pub      # 已作为 deploy key 加到 GitHub（标题：dsh-redteam-mode deploy key (jz host)）
```

`~/.ssh/config` 里为 `github.com` 固定了这把 key（`IdentitiesOnly yes`），所以 `git push` 直接可用。
换机器时要么重新生成密钥并在 GitHub 加一张 deploy key，要么改用 `gh auth login`。

发版四件套（本次实际执行的顺序）：

```bash
node packages/redteam-bundle/tools/build.mjs --check        # 生成物与源码同步
node packages/redteam-store/test/*.mjs && node packages/redteam-tools/test/*.mjs && node packages/redteam-bundle/test/*.mjs
npm version patch --no-git-tag-version                      # 改版本号
npm publish --access public                                 # 发 npm（prepublishOnly 会自动跑 --check + bundle.test）
git add -A && git commit -m "vX.Y.Z：..." && git tag -a vX.Y.Z -m "..."
git push origin main && git push origin vX.Y.Z              # 推代码与 tag
```
