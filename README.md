# DSH RedTeam 模式

> ⚠️ **仅限已获授权的攻防演练 / 渗透测试使用。**
> 本仓库是智能体编排与事实库的工程实现，**不包含任何漏洞利用代码**。
> 使用者必须自行确保对目标拥有书面授权；未经授权的扫描与入侵在绝大多数司法辖区都是违法行为。
> 作者不对任何滥用行为负责。

把 [DeepSeek Harness](https://github.com/deepseek-ai)（DSH）改造成一台**红队作战指挥台**：
发给指挥智能体的全部输入只有**一个靶标单位名称**，它会自动拉起信息收集 → 漏洞检测 → 漏洞利用 → 内网渗透四个角色，
把资产、漏洞、凭据、会话、攻击链实时落进本地 SQLite 事实库，并在界面右侧栏的常驻控制台里可视化。

| | |
| --- | --- |
| 装法 | `dsh plugin --profile web add dsh-redteam-mode`（一条命令） |
| 规模 | 48 个 `redteam_*` 模型工具 · 13 个原生技能 · 11 个控制台页签 · 22 张事实库表 |
| 数据 | 全部落在本机 `$DSH_HOME/redteam/`，无遥测、无上报、无云端同步 |
| 当前版本 | **v0.7.6** |

**目录**：[快速开始](#1-快速开始) · [使用](#2-使用) · [能力](#3-能力) · [架构与目录](#4-架构与目录) · [数据与隐私](#5-数据与隐私) · [密钥与外部-api](#6-密钥与外部-api) · [开发与发版](#7-开发回归测试与发版) · [合规声明](#8-合规声明)

---

## 1. 快速开始

### 1.1 从插件市场装（推荐）

```sh
dsh plugin --profile web add dsh-redteam-mode
```

装完**重启一次 `dsh web`**，然后在 **设置 → 插件市场** 里也能搜到（关键字 `redteam`）。
首次启动会自动把自带的 `红队模式` 预设装到 `$DSH_HOME/.agent-presets/redteam/`、注册 13 个原生技能，
不需要手动拷任何文件。

**前置**：DSH 能正常 `dsh web` 启动；Node.js ≥ 22.13（依赖内置 `node:sqlite`，会打印 ExperimentalWarning，属正常）。

### 1.2 从源码装（开发者 / 想改代码的人）

仓库里的三个源码包 `redteam-store` / `redteam-tools` / `redteam-ui` 是**唯一源码**，
`packages/redteam-bundle`（包名 `dsh-redteam-mode`）由 `tools/build.mjs` 从它们生成，是自包含的市场包。

```bash
PROFILE=~/.dsh/profiles/web          # 换成你实际使用的 profile

# ① 让 profile 能按包名解析到这三个包（DSH 的模块解析走 profile 下的 node_modules）
mkdir -p "$PROFILE/node_modules"
for p in redteam-store redteam-tools redteam-ui; do
  ln -sfn "$PWD/packages/$p" "$PROFILE/node_modules/dsh-$p"
done

# ② dsh-redteam-tools 需要宿主提供 @deepseek-ai/dsh-tools，按你的 DSH 安装方式补上：
#    ln -s <dsh 安装目录>/node_modules/@deepseek-ai/dsh-tools \
#          packages/redteam-tools/node_modules/@deepseek-ai/dsh-tools

# ③ 在 profile 的 patch 层挂载 host 行：编辑 "$PROFILE/cordis.patch.yml"，追加
#    - insert:
#        - id: redteam-store
#          name: dsh-redteam-store
#          config:
#            root: !!js dshHomePath('redteam')     # 事实库根目录，默认 $DSH_HOME/redteam
#        - id: redteam-ui
#          name: dsh-redteam-ui

# ④ 安装预设与技能
mkdir -p ~/.dsh/.agent-presets/redteam ~/.dsh/skills
cp preset/agent.cordis.yml preset/preset.yml ~/.dsh/.agent-presets/redteam/
cp skills/*.md ~/.dsh/skills/
```

> ③ 里手写的 `redteam-store` / `redteam-ui` 两行**只适用于这种源码装法**。
> 换成 1.1 的市场装法前，必须先跑 1.3 的迁移把这些行清掉，否则两套行会一起挂载、服务重复注册。

**外部工具（可选但强烈建议）**：技能里引用的扫描器/隧道工具先落到本机，智能体才能直接用（内网环境往往下不动）。
建议放 `$DSH_HOME/redteam/toolkit/`：`nmap` `masscan` `nuclei` `sqlmap` `ffuf` `httpx(ProjectDiscovery)` `naabu` `subfinder` `dnsx` `dirsearch` `gogo` `fscan` `suo5` `chisel` `frp`，以及冰蝎 / 哥斯拉 / 蚁剑；也可以在自己 VPS 上开个 `python3 -m http.server` 供跳板机拉取。
注意 `httpx` 命令名与 Python httpx 库的 CLI 冲突，建议用绝对路径或自建包装器（如 `pd-httpx`）。

### 1.3 从预发布版升级（0.7.0 之前装过开发版）

那些机器的 `cordis.patch.yml` 里有手写的 `redteam-store` / `redteam-ui` 两行，与市场包的行冲突
（0.7.0 报 `duplicate loader entry id`，0.7.1 起变成 `service "redteam" has been registered`）。
装完市场包后跑一次迁移，只删这两条连子行，其它内容与注释原样保留、写回前自动备份、幂等：

```sh
cd ~/.dsh/profiles/web
node node_modules/dsh-redteam-mode/lib/migrate-legacy-rows.mjs --dry-run   # 预演
node node_modules/dsh-redteam-mode/lib/migrate-legacy-rows.mjs             # 执行
```

新装的机器、已经在用 0.7.0+ 的机器都不需要跑。

### 1.4 重启

host 平面新增了服务与表结构，**必须重启 `dsh web`**（客户端 UI 改动会自动热重载，host 改动不会）。
重启后在界面助手栏能看到「红队模式」预设，右侧栏出现 RedTeam 面板。

---

## 2. 使用

1. 新建会话，选择预设 **红队模式**。
2. 直接发靶标单位名称（有范围就补一句，例如某个 C 段）。
3. 主会话只做四件事——拆任务、派子智能体、分析回报、决定下一个任务；动手的活（扫描/爆破/利用/上传/登录遍历/内网探测）全部委派给角色子智能体。
4. 每次发现都必须落库（`redteam_asset_add` / `vuln_add` / `http_evidence_add` / `credential_add` / `access_add` / `chain_add` / `score_hit`）——**未落库的发现视为无效工作**。
5. 看结果：资产测绘页签实时长数据，会话隧道页签记 WebShell 与隧道，得分目标页签给总分进度，报告页签出可复现的攻击得分链路报告。

```
用户：<靶标单位名称>
   │
   ├─ 主会话（指挥）：拆解 / 派任务 / 盯进度 / 分析回报 / 决定下一个任务
   │     ├─ 信息收集  recon     域名·子域·C 段·端口·指纹·Web 标题·边界与隐藏资产
   │     ├─ 漏洞检测  vuln-scan Nday/1day 优先，逐条确认并落原始 HTTP 证据
   │     ├─ 漏洞利用  exploit   拿账号 → 浏览器实测登录 → 遍历功能点 → WebShell / RCE / 数据库
   │     └─ 内网渗透  internal  suo5 隧道 → gogo/fscan 测绘 → 凭据复用 → 横向 → 核心系统
   │
   └─ 全部发现落进 SQLite 事实库（22 张表 + FTS5 全文索引）
            ↓
      右侧栏控制台 11 个页签
```

---

## 3. 能力

### 3.1 默认得分点（共 255 分，可在「得分目标」面板增删改）

| 得分点 | 分值 | 得分点 | 分值 |
| --- | --- | --- | --- |
| 获取 Web 普通账号权限 | 10 | 获取数据库权限 | 25 |
| 获取 Web 管理员账号权限 | 20 | 获取大量敏感信息 | 20 |
| 上传 WebShell 并维持访问 | 20 | 互联网边界突破 | 30 |
| RCE / 命令执行 | 30 | 突破逻辑内网（横向移动） | 35 |
| 获取服务器权限 | 25 | 拿下核心系统 | 40 |

### 3.2 控制台 11 个页签

| 页签 | 内容 |
| --- | --- |
| 资产测绘 | C 段按**内网 / 外网**分组；列表 / 域名 / Web / 图谱四种视图；易打性评估与测试状态 |
| 当前测试 | 正在测的资产与状态流转（未测试 / 测试中 / 已测试 / 被封禁 / 已放弃 / 无攻击面） |
| 会话隧道 | WebShell 与隧道在线状态、最后检测时间与延迟、一键实测连通性、走隧道的现成扫描命令；每条隧道标出**是否跨越靶标边界**；非冰蝎马标红「用户连不上」、缺 suo5 隧道、通道全在自己服务器上都顶出提示 |
| 漏洞战果 | 按严重级排序；**拿到什么权限**列；详情直接渲染可复现的原始 HTTP 请求/响应 |
| 攻击链 | **五阶段**：信息收集 → 互联网资产权限 → 边界突破 → 内网资产权限 → 靶标权限；每阶段给目标、拿到多少分（含累计）、涉及资产；边界突破阶段只列**跨越靶标边界的通道** |
| 得分目标 | 已得总分 / 满分；命中记录一行一条（自适应换行，不截断）；自建账号标红「自建 · 不计分」并单独计数 |
| 报告 | 攻击得分链路复现报告：按阶段可折叠，只收录得分成果，每条附可粘进 Yakit 的原始请求；自建账号整条剔除 |
| 攻击文件 | 按目标文件夹组织，只收录实际生效的脚本 / POC / EXP |
| 知识库 | POC/EXP 知识库（**全局共享、跨靶标复用**）+ 本机 nuclei 模板库：按 CVE/组件/关键字一次搜两层 |
| 智能体提示词 | 按角色编辑，可一键恢复内置最新版 |
| 技能库 | 浏览 DSH 原生技能目录与正文 |

### 3.3 提示词纪律（预设与四个角色提示词都写了）

- **只打得分面**：动手前先问“这条线能落到哪个得分点”，答不出来就不投入；明确禁止为“覆盖全面”去测信息泄露/配置类/中低危等与得分无关的问题（最多记一行排除结论）。
- **拿到账号权限必须用浏览器实测登录、交互访问**：**只有凭据不算拿到账号**——拿到账号/口令后用 `browser-automation` / `kimi-webbridge` 真实登录进后台或业务页（验证码自己识别），抓到会话 Cookie/Token 并 `redteam_access_add`（method=web-login）登记，**登录成功才记账号权限分**；目标只在内网可达时先建 suo5 隧道再用浏览器 `--proxy-server=socks5://127.0.0.1:1080` 登录；登不进去（哈希未破解 / 二次认证 / 限制来源 IP）用 `redteam_asset_test` 的 `test`（追加式）记一行结论即可，不当成果记分。内网拿到凭据同样先试内网管理端（堡垒机 / 运维平台 / 数据库后台 / 域控）。
- **记分必填两样**：`redteam_score_hit` 的 `code`（`web-account-user` / `web-account-admin` / `webshell` / `rce` / `server-shell` / `db-access` / `sensitive-data` / `boundary` / `internal-pivot` / `core-system`，以 `redteam_score_list` 的实际值为准）+ `evidence`（只写结果：目标资产 + 账号/权限/数据量）。缺任一项服务端直接报错；能带 `vuln_id` 就带上，报告会据此附上原始请求。
- **入口必须可交付**：WebShell 必须是**冰蝎马 / 哥斯拉马**（一句话马、自研马用户连不上，只算临时中转）；拿到 WebShell 后**必须用 suo5 建隧道**才算打进内网，建好要登记（`kind` / `listen` 必填）并实测连通。**`entry_kind` 是边界突破得分的凭证**：留空则 `legit=null`、页面显示「待确认」，不计入边界突破——发现历史隧道留空要立刻 `redteam_tunnel_update` 补上。
- **攻击链步骤必带 `stage_code`**，只有 5 个合法值：`recon`（信息收集）/ `internet`（互联网资产权限）/ `boundary`（边界突破）/ `internal`（内网资产权限）/ `target`（靶标权限）。写别的值会被忽略并退回按 `stage` 兜底，步骤就不落在任何阶段（页面计数为 0）。
- **自己注册的账号不算得分权限**：自助注册、自己新建的用户/角色、自己给自己开的权限都不是“拿到账号权限”——得分针对**拿到别人已有的**（弱口令、凭据泄露、注入拖库、越权/提权、默认口令）。这类用 `self_created=true` 留痕：**不计分、不占上限、不进报告**。
- **自己的 VPS / 自己配置的服务器不算隧道**：只在自己服务器上开 socks5/frp/代理没碰到目标，不算跨越靶标边界。只有目标侧发起的通道才算：`target-outbound`（目标反弹 shell 到我方 / 目标上跑 frp 客户端）、`target-http`（经目标 WebShell 的 suo5 / Neo-ReGeorg）、`target-agent`（经目标已控进程转发）；纯自己服务器上开的填 `self-only`，页面标红「不算突破」，攻击链也不把它算作边界突破。
- **Nday/1day 先查知识库**：`redteam_poc_search` 一次查两层——① 本机沉淀的通用 POC/EXP ② 本机 nuclei 模板库（`~/.local/nuclei-templates`）；命中直接取用（模板直接 `nuclei -t <路径> -u <目标>`）；两层都没有才去互联网（`web_search` / GitHub / ExploitDB / 厂商公告）或自己手搓；**验证有效后必须回填**（`redteam_poc_add`，写清来源、影响版本与验证证据，并脱敏）。
- **打之前先查库**：动手前先看该资产的 `test_status` / 已有漏洞 / 现成 WebShell·隧道·凭据，打过的不再打；测完立刻回写 `redteam_asset_test`。
- 预设与角色提示词改版后，老靶标里仍是旧版默认的提示词会自动换成新版，用户自己改过的保持不动（面板里也有「恢复默认」）。
  角色提示词是**按靶标**存的（`$DSH_HOME/redteam/engagements/<靶标>/agents/*.md`），只在读取时才比对升级——所以改完提示词后，老靶标要一个个打开面板才跟上。要一次性批量刷新：

  ```bash
  node scripts/refresh-all-prompts.mjs --dry-run   # 先看会改哪些（不落盘）
  node scripts/refresh-all-prompts.mjs             # 批量升级（自动备份 .bak-<时间戳>）
  ```

  输出里若出现 `用户自写(保留)`，说明那个角色确实被人工改过，脚本不会覆盖它；判定语义与面板完全一致（复用服务端的 `refreshDefaultPrompts`）。

### 3.4 模型工具（48 个 `redteam_*`，节选）

```
redteam_engagement_open          绑定本次演练靶标，创建工作区
redteam_asset_add/query/get/stats/graph/link/assess/test
                                 资产入库、查询、关联图谱、易打性评估、测试状态流转
                                 query 支持 scope=internal|external 区分内网/外网
redteam_domain_index             按域名维度聚合（域名 → 子域 → IP → C 段）
redteam_web_list                 Web 资产清单（URL + 标题）
redteam_vuln_add/query/update    漏洞记录与状态流转；gained 记「通过它拿到了什么权限」
redteam_http_evidence_add        原始 HTTP 证据（供报告复现）
redteam_credential_add/list      凭据（明文 secret_value + 证据引用 secret_ref）
redteam_access_add/list          已获得的访问会话
redteam_sessions                 【每次派任务前先看】WebShell / 隧道 / 凭据 / 会话一屏总览
redteam_webshell_add/list/update 已上线 WebShell 的登记与状态维护（shell_type=behinder|godzilla）
redteam_tunnel_add/list/update   内网隧道登记与状态维护（必须声明 entry_kind）
redteam_session_check            实测所有 WebShell 与隧道的连通性并回写状态
redteam_chain_add / redteam_chain / redteam_attack_path
                                 攻击链步骤与攻击图谱（资产 → 漏洞 → 权限 → 内网）
redteam_attack_file_add/list     攻击文件归档（按目标分目录，强制要求证据引用）
redteam_poc_search/get/add/list/update/use
                                 知识库：全局共享、跨靶标复用，打 Nday/1day 前先检索
redteam_score_list / redteam_score_hit / redteam_score_point_save
                                 得分目标与得分记录；同类不设上限，记分带 vuln_id 供报告复现
redteam_score_report             攻击得分链路复现报告（只收录得分成果）
redteam_attack_chain             攻击链五阶段 + 各阶段得分与累计分
redteam_role_prompt / redteam_roles / redteam_role_prompt_reset
                                 四个角色的系统提示词
```

设计上的硬约束：

* **得分目标驱动**：所有提示词都围绕可计分成果（Web 权限、WebShell、RCE、服务器权限、数据库、敏感信息、边界突破、横向、核心系统）组织，信息收集只是手段不是产出。
* **报告只输出得分成果**：没得分的漏洞、信息收集流水账一律不进报告。
* **得分不设数量上限**：同类得分每命中一次按分值累加，页面直接给「N 次命中 / +X 分」。
* **入口不能丢**：WebShell 与隧道必须登记进「会话隧道」，面板会实测连通性；每次派任务前先看 `redteam_sessions`。
* **技能优先，禁止手搓**：扫描/爆破/隧道/WebShell 一律用现成工具与技能（fscan、gogo、nuclei、httpx、suo5、chisel…），手搓脚本必须说明理由。

---

## 4. 架构与目录

DSH 的组合分两个平面，各包严格按平面归位：

| 包 | 平面 | 职责 |
| --- | --- | --- |
| `dsh-redteam-store`（`packages/redteam-store`） | **host** | 数据核心。SQLite 事实库（22 张表 + FTS5），发布进程级服务 `ctx.redteam`，另有 JSON-in/out CLI 便于脱离界面调试。**连通性探测也在这一层**（智能体的沙箱连不出去）。零外部依赖，只用 `node:` 内置模块。 |
| `dsh-redteam-tools`（`packages/redteam-tools`） | **agent** | 48 个模型工具（`redteam_*`），把事实库、得分目标、会话入口暴露给智能体；随 preset 挂载，每个会话一份。 |
| `dsh-redteam-ui`（`packages/redteam-ui`） | **host + client** | 控制台。host 半侧注册 `POST /redteam/api` 桥接 `ctx.redteam`（含异步连通性探测）；浏览器半侧是常驻右侧栏 UI。 |
| `dsh-redteam-mode`（`packages/redteam-bundle`） | **市场包** | 自包含单包：`lib/` 由 `tools/build.mjs` 从上面三个包生成，预设与 13 个技能一并打包，供 `dsh plugin add` 一条命令安装。 |

```
.
├── packages/
│   ├── redteam-store/       # 事实库 + ctx.redteam 服务 + CLI + 连通性探测（test/ 零依赖回归测试）
│   ├── redteam-tools/       # 48 个 redteam_* 模型工具（test/ 零依赖回归测试）
│   ├── redteam-ui/          # 常驻右侧栏控制台（host 桥接 + 客户端 UI）
│   └── redteam-bundle/      # 市场包 dsh-redteam-mode（lib/ 为生成物，presets/ 与 skills/ 随包）
├── preset/                  # DSH agent preset（人设 + 工具行 + 委派组）
├── skills/                  # 13 个 DSH 原生技能
├── docs/                    # 环境配置记录（Kimi WebBridge 桥接、上架市场的步骤）
└── redteam-proto/           # 原型脚本与演示数据（全部使用 RFC 5737 文档地址，无真实目标）
```

---

## 5. 数据与隐私

* 所有演练数据只写在**本机** `$DSH_HOME/redteam/engagements/<靶标>/`：SQLite 事实库、`runs/` 证据、按目标分目录的攻击文件。本项目不含任何遥测、上报或云端同步代码。
* **知识库是全局的**：`$DSH_HOME/redteam/knowledge.db` + `pocs/<code>/`，跨靶标共享 POC/EXP（所以回填前必须**脱敏**：去掉内网真实地址、自己的 VPS/域名与靶标专属参数，只留通用部分）。
* **凭据明文入库、但只在本机**：`credential.secret_value` 存口令/Hash/密钥原文（「漏洞战果」页直接显示，便于随时复用），同时用 `secret_ref` 指向 `runs/` 下的证据文件。**这个库文件是最高敏感度的资产**，不要复制、导出或提交到任何仓库/聊天工具。
* 界面与工具的所有写操作都要求证据引用，避免“无证据的成果”。
* `.gitignore` 默认排除 `engagements/`、`runs/`、`*.db`、`*.jsonl`、凭据与密钥文件，避免误提交演练数据。

## 6. 密钥与外部 API

仓库里**不含任何真实密钥或基础设施地址**（VPS IP 等一律是 `<你的VPS_IP>` 占位符）。
涉及外部 API 的技能一律从环境变量读取，例如 FOFA 测绘：

```bash
export FOFA_KEY=你的key       # skills/fofa-recon.md 里的客户端只读这个变量
```

fork 后要加自己的 key，请放进 `.env`（已被 `.gitignore` 忽略）或本机环境变量，不要提交。

---

## 7. 开发、回归测试与发版

改的是本机正在用的那三个源码包时：**host 侧改动要重启 `dsh web` 才生效**（改了 `redteam-store` / `redteam-ui` 一侧尤其如此）；改完别忘了重新生成市场包：

```bash
node packages/redteam-bundle/tools/build.mjs          # 从三个源码包生成 bundle 的 lib/、预设、技能
node packages/redteam-bundle/tools/build.mjs --check  # 只校验是否漂移（CI / 发版前用）
```

零依赖回归测试（不需要装任何东西）：

```bash
node packages/redteam-store/test/stages.test.mjs      # 阶段表自愈 + 得分归阶段 + 报告序号
node packages/redteam-store/test/prompts.test.mjs     # 角色提示词：默认值自动升级、用户自写不被覆盖
node packages/redteam-store/test/rules.test.mjs       # 判定规则：自建账号不计分、只有目标侧通道算突破
node packages/redteam-store/test/prompt-contract.test.mjs # 提示词—工具契约：参数真实存在、stage_code 白名单、缺证据必告警
node packages/redteam-tools/test/poc-tools.test.mjs   # 知识库工具：检索/回填/跨靶标共享/去重
node packages/redteam-tools/test/rule-tools.test.mjs  # 工具的规则输出：score_hit / tunnel_add / sessions
node packages/redteam-tools/test/tool-schema.test.mjs # 工具 schema 结构自检（含 DSH 官方校验器）
node packages/redteam-bundle/test/bundle.test.mjs     # 打包契约 / 泄露自检 / 首次启动自举 / 迁移脚本
```

> ⚠️ **改工具参数 schema 后务必跑 `tool-schema.test.mjs`**：DSH 在挂载预设时会校验每个工具的 schema，
> 一旦不合法（例如 `type: 'object'` 没写 `additionalProperties`），**整个预设 mount 失败**——该会话任何
> resume 都失败，客户端命令菜单会不停重试、每次重试都要整份解码会话日志，足以把 dsh 进程 CPU 打满、
> 界面卡住（v0.6.1 真出过这个事故，v0.6.2 修复并加了这道自检）。

**发版**：

```bash
cd packages/redteam-bundle
node tools/build.mjs --check && node test/bundle.test.mjs   # 也会由 prepublishOnly 自动跑
npm version patch && npm publish --access public            # 需要 npm 账号（本机 ~/.npmrc 里的 token）
git tag vX.Y.Z && git push origin main --tags
```

之后往精选列表 [awesome-dsh-plugin](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin) 提 PR 加一条，
市场和目录站当天自动收录；文案要点与验收口径见 [`docs/marketplace.md`](docs/marketplace.md)。

---

## 8. 合规声明

本项目面向**授权范围内的安全评估**：攻防演练、红蓝对抗、企业自检、教学研究。

* 未获授权对任何系统进行扫描、探测、入侵或数据获取，均属违法，与本项目作者无关。
* 使用前请确认授权书、测试范围（资产清单 / 时间窗 / 允许的手段）与免责条款。
* 请遵守目标所在司法辖区的法律，以及 GitHub 的服务条款。

## 9. License

MIT，见 [LICENSE](LICENSE)。
