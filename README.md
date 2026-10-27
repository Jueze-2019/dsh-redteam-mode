# DSH RedTeam 模式

把 [DeepSeek Harness](https://github.com/deepseek-ai)（DSH）变成一台**红队作战指挥台**：
只发一个靶标单位名称，主会话拉起一支执行智能体团队（信息收集 → 资产梳理 → 漏洞发现 → 漏洞利用 → 内网渗透），
所有发现实时落进本机 SQLite 事实库，并在界面右侧栏的常驻控制台里可视化。

> ⚠️ **仅限已获授权的攻防演练 / 渗透测试使用。** 本仓库是智能体编排与事实库的工程实现，
> **不包含任何漏洞利用代码**；使用者须自行确保对目标拥有书面授权。

**59 个 `redteam_*` 工具 · 29 个随包技能（+9 个攻击链技能见工具箱附件） · 5 个分区 / 9 个页面 · 22 张事实库表**

---

## 安装

```sh
dsh plugin --profile web add dsh-redteam-mode
```

装完**重启一次 `dsh web`**，在界面助手栏选预设 **红队模式**，直接发靶标单位名称即可开工。
首次启动会自动装好预设与 29 个随包技能，不需要手动拷文件。

**环境准备**（首次使用）：

```sh
bash "$DSH_HOME/redteam/setup.sh" --check   # 体检：缺什么一眼看清
bash "$DSH_HOME/redteam/setup.sh"           # 装齐工具 + 引导填 FOFA_KEY / VPS
```

> 前置：DSH 能正常 `dsh web` 启动；Node.js ≥ 22.13（依赖内置 `node:sqlite`）。
> 请跑在**专供演练的 Kali 虚拟机**里，不要跑在日常办公机/宿主机上。

<details>
<summary>从源码装 / 手动升级到指定版本（开发者）</summary>

**直接从 Release 安装某个版本**（不依赖 npm，也不需要下载解压）：

```sh
dsh plugin --profile web add \
  https://github.com/Jueze-2019/dsh-redteam-mode/releases/download/v0.14.3/dsh-redteam-mode-0.14.3.tgz
# 装完重启一次 dsh web
```

**下载 tarball 再装**（适合离线机器，附件同在同一下载页）：

```sh
curl -LO https://github.com/Jueze-2019/dsh-redteam-mode/releases/download/v0.14.3/dsh-redteam-mode-0.14.3.tgz
dsh plugin --profile web add ./dsh-redteam-mode-0.14.3.tgz
```

**从源码装**：

```bash
# 生成市场包 → 同步到 profile → 刷新预设/技能，一步到位（推荐）
node scripts/deploy-local.mjs
node scripts/deploy-local.mjs --restart   # 顺带重启 dsh web（会中断当前会话）
```

<details>
<summary>手工等价步骤（不推荐，容易漏东西）</summary>

```bash
PROFILE=~/.dsh/profiles/web
mkdir -p "$PROFILE/node_modules"
for p in redteam-store redteam-tools redteam-ui; do
  ln -sfn "$PWD/packages/$p" "$PROFILE/node_modules/dsh-$p"
done
# 注意：DSH ≥0.1.7 起模式列表来自 cordis.patch.yml 生成区里的 preset-redteam 声明行，
# 不再是 $DSH_HOME/.agent-presets/ 目录 —— 手工部署必须把 cordis.patch.yml 一起同步过去。
```
</details>

细节见 [`docs/详细文档.md`](docs/详细文档.md) 第 7 章。
</details>

---

## 功能

- **一套角色分工**：主会话只做指挥（计划、派活、核对落库、汇报），动手的活全部委派给信息收集 /
  资产梳理 / 漏洞发现 / 漏洞利用 / 内网渗透五个执行角色，同一靶标**默认 3 个并发（可配置）**。
- **开工前预检**：`redteam_preflight` 逐个技能体检，缺 key、缺 VPS、缺工具一次性说清，补不齐就说降级方案。
- **得分目标**：严格对齐《突破入侵类得分规则（合并版）》的 **8 类 25 项**；上限、权限取高只计一次、
  同一资产加端口只算一次全由服务端判定，自建账号不计分。凭据里说不清归属的 Web 站点
  （后台、管理端、运营平台、自研业务系统）按「控制 Web 应用系统」兜底计分，不因看不出是邮箱/OA 而漏记。
- **右侧常驻控制台**：态势 / 资产 / 成果 / 报告 / 资源 五个分区，下面 9 个页面（资产测绘、智能体、会话隧道、凭据与文件、漏洞战果、得分目标、报告、知识库、技能库），每个带未读红点。
- **面板跟着会话走**：多会话并行时不用手动挑靶标——左侧切到哪个会话，右侧就显示**那个会话绑定的靶标**
  （子智能体会话自动归到父会话；没绑过的会话回落到最后一次绑定的靶标）；
  知识库页签同源，默认筛到当前会话的靶标，一键可回到全库。
- **报告四段式**：一、靶标单位资产证明（只列得分资产，附域名/标题/主机名/隧道/同段等归属证据，标强/中/待补）；二、得分汇总表（互联网资产权限 / 边界突破 / 内网资产权限）；三、账号密码凭据权限汇总表（同一顺序，默认脱敏）；四、得分点复现（同一顺序，每条给最短报文/命令、预期回显与缺口）。供应链/跳板/未归属条目单列；嵌入代表截图，现场截图与生成摘录分开标注；
  缺项标「复现链不完整」，不是悄悄放过。
- **资产准入**：只打 T0 直接归属 / T1 强相关；T2 旁站/同 C 段只作线索，T0/T1 穷尽并经用户同意后才评估；T3 不碰。
- **作战优先级**：先进内网、再拿数据——**P0 能进内网的 RCE ＞ P1 ≥1 万条三要素数据 ＞ P2 其它**；角色提示词会按这个顺序分配预算。
- **技能库 29 个随包**：FOFA 测绘、被动收集、作战规划、专项路径、netspy 内网网段发现、DeepSeek 公开情报检索、子域与端口流水线、nuclei、目录爆破、服务与 Web
  指纹识别等，按“规划 / 侦察 / 验证 / 访问 / 内网 / 隧道 / 得分 / 基础设施”分类筛选（默认只看红队，取消勾选显示 DSH 通用）；每个技能带**可用性判定**（缺什么直接点名）。攻击链技能（凭据攻击、WebShell、
  反弹 Shell、suo5 / chisel / frp 隧道、内网横向）在 Release 附件的工具箱里按需取用。
- **数据只在本机**：全部落在 `$DSH_HOME/redteam/`，无遥测、无上报、无云端同步。

面板右上角常驻**版本号 + 一键更新**（检测到有智能体在跑会拦住）。

完整说明、59 个工具清单、开发与发版流程见 [`docs/详细文档.md`](docs/详细文档.md)。

---

## 数据与隐私（硬约束）

本仓库是**公开**的，推送即发布、无法撤回。下列内容**一律不得入库** ——
`docs/`、`README`、提交说明、Issue/PR 正文、Release 说明都算：

| 不入库 | 说明 | 该放哪 |
| --- | --- | --- |
| **演练战绩 / 战果统计** | 打了几家单位、发现多少资产 / 漏洞 / 凭据、几次得分命中、累计分值 | 仓库外的留档文件（如 `~/redteam-战绩.md`） |
| **逐单位成果明细** | 某个单位多少资产 / 端口 / 漏洞 / 内网段、是否打进内网、内网突破类型 | 同上。**"行业-编号"式脱敏也不行**：脱敏只挡"是谁"，挡不住"打成什么样" |
| **内网段清单** | 一批真实私网 C 段（单个段举例可以，成清单不行） | 同上 |
| **凭据真值** | 口令、密钥、哈希、Cookie、`secret_value` / `pass_key` 的实际值 | 只留在本机 `$DSH_HOME/redteam/engagements/*/assets.db` |

这条约束**有机检、不是靠自觉**（2026-10-12 真实事故：战绩统计曾被写进仓库根 `README` 与 `docs/`，
只能靠改写 git 历史清除）：

```bash
node scripts/check-no-confidential.mjs --selftest   # 证明规则有效（12 拦 / 5 放）
node scripts/check-no-confidential.mjs --all        # 自查工作区（含未跟踪文件）
git config core.hooksPath .githooks                 # 启用提交前闸门（scripts/deploy-local.mjs 会自动配）
```

- **提交前闸门**：`.githooks/pre-commit` 扫暂存区，命中即拦（`git commit --no-verify` 可越过，但先确认是误报）。
- **回归测试**：`packages/redteam-bundle/test/no-confidential.test.mjs` —— 跑规则自检 + 全仓扫描 +
  确认钩子确实接在提交路径上（防"规则还在、闸门没接"）。
- 确实需要在本仓库讨论这类内容时用**占位符写法**：`单位：<靶标单位>　规模：<N> 家　内网段：<私网 C 段>`。

演练数据本身只写在本机 `$DSH_HOME/redteam/`，无遥测、无上报、无云端同步。

---

## 合规

面向**授权范围内**的安全评估：攻防演练、红蓝对抗、企业自检、教学研究。
未获授权的扫描、探测、入侵或数据获取均属违法，与本项目作者无关。MIT，见 [LICENSE](LICENSE)。
