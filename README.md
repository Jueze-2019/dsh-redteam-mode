# DSH RedTeam 模式

把 [DeepSeek Harness](https://github.com/deepseek-ai)（DSH）改造成一台**红队作战指挥台**：
发给指挥智能体的全部输入只有**一个靶标单位名称**，它会自动拉起信息收集 → 漏洞检测 → 漏洞利用 → 内网渗透四个角色，
把资产、漏洞、凭据、会话、攻击链实时落进本地 SQLite 事实库，并在界面右侧栏的常驻控制台里可视化。

> ⚠️ **仅限已获授权的攻防演练 / 渗透测试使用。**
> 本仓库是智能体编排与事实库的工程实现，**不包含任何漏洞利用代码**。
> 使用者必须自行确保对目标拥有书面授权；未经授权的扫描与入侵在绝大多数司法辖区都是违法行为。
> 作者不对任何滥用行为负责。

---

## 1. 它长什么样

```
用户：<靶标单位名称>
   │
   ├─ 主会话（指挥）：只做拆解、派任务、盯进度、分析子智能体回报、决定下一个任务
   │     ├─ 信息收集  recon     ：域名/子域/C 段/端口/指纹/Web 标题/边界与隐藏资产
   │     ├─ 漏洞检测  vuln-scan ：Nday/1day 优先，逐条确认并落 http 证据
   │     ├─ 漏洞利用  exploit   ：拿账号、WebShell、RCE、数据库，登录后遍历功能点找 getshell
   │     └─ 内网渗透  internal  ：suo5 隧道 + gogo/fscan 内网测绘 + 凭据复用 + 横向 + 核心系统
   │
   └─ 每一次发现都必须落库（未落库的发现视为无效工作）
         ↓
   SQLite 事实库（20 张表 + FTS5 全文索引）
         ↓
   右侧栏控制台 9 个页签：资产测绘 / 会话隧道 / 漏洞战果 / 攻击链 / 得分目标 / 报告 / 攻击文件 / 智能体提示词 / 技能库
```

设计上的几条硬约束：

* **得分目标驱动**：所有提示词都围绕可计分的成果（Web 权限、WebShell、RCE、服务器权限、数据库、敏感信息、边界突破、横向、核心系统）组织，信息收集只作为手段而不是产出。
* **报告只输出得分成果**：报告页只收录"拿到了分"的成果（附可复现的原始请求），没得分的漏洞、信息收集流水账一律不进报告。
* **得分不设数量上限**：同一类得分每命中一次就按分值累加（命中次数 × 分值），页面直接给「N 次命中 / +X 分」，不再有"计入上限"这类概念。
* **按作战阶段组织**：攻击链路按五个作战阶段（外网打点 → 撕破口子 → 隧道搭建·内网漫游 → 拿下资产权限 → 靶标系统权限）呈现，每阶段给出目标、手段、工具、ATT&CK 技术。
* **入口不能丢**：WebShell 与隧道必须登记进「会话隧道」面板，面板会实测连通性；每次派任务前先看 `redteam_sessions`，避免"打到后面忘了还有隧道可用"。
* **技能优先，禁止手搓**：扫描/爆破/隧道/WebShell 一律用现成工具与技能（fscan、gogo、nuclei、httpx、suo5、chisel…），手搓脚本要说明理由。

## 2. 架构

DSH 的组合分两个平面，本项目的三个包严格按平面归位：

| 包 | 平面 | 职责 |
| --- | --- | --- |
| `dsh-redteam-store` | **host** | 数据核心。SQLite 事实库（`segment / asset / port / service / fingerprint / observation / edge / tag / vuln / credential / access_session / webshell / tunnel / http_evidence / attack_step / attack_file / score_point / score_hit / scan_run / asset_name`），发布进程级服务 `ctx.redteam`，另有 JSON-in/out CLI 便于脱离界面调试。**连通性探测也在这一层**（智能体的沙箱连不出去）。零外部依赖，只用 `node:` 内置模块。 |
| `dsh-redteam-tools` | **agent** | 40 个模型工具（`redteam_*`），把事实库、得分目标、会话入口暴露给智能体；随 preset 挂载，每个会话一份。 |
| `dsh-redteam-ui` | **host + client** | 控制台。host 半侧注册 `POST /redteam/api` 桥接 `ctx.redteam`（含异步的连通性探测）；浏览器半侧是常驻右侧栏 UI（不遮挡对话）。 |

其余组成部分：

* `preset/` —— DSH agent preset（人设 + 工具行 + 委派组）。人设里写死了授权前提、得分目标、优先打什么、报告口径、已有入口必须先看、技能优先等工作纪律。
* `skills/` —— 13 个 DSH 原生技能（信息收集、指纹、主动扫描、代理池、隧道、WebShell、浏览器自动化、Kimi WebBridge、VPS 中转、gogo、fscan 等），由 `skill` 工具按需加载。
* `docs/` —— 环境配置记录。
* `redteam-proto/` —— 原型期的动态插件与灌数脚本，保留作可复现的演示数据（全部使用 RFC 5737 文档地址，无真实目标）。

## 3. 安装

### 前置

* DSH（DeepSeek Harness），能正常 `dsh web` 启动。
* Node.js ≥ 22.13（取决于 `node:sqlite`；实测 22.23.2 可用，会打印 ExperimentalWarning，属正常）。

### 3.1 让 profile 能按包名解析到这三个包

DSH 的模块解析走 profile 下的 `node_modules`，用符号链接指过来即可：

```bash
PROFILE=~/.dsh/profiles/web          # 换成你实际使用的 profile
mkdir -p "$PROFILE/node_modules"
for p in redteam-store redteam-tools redteam-ui; do
  ln -sfn "$PWD/packages/$p" "$PROFILE/node_modules/dsh-$p"
done
```

`dsh-redteam-tools` 需要宿主提供 `@deepseek-ai/dsh-tools`，按你安装 DSH 的方式补上（例如
`ln -s <dsh 安装目录>/node_modules/@deepseek-ai/dsh-tools packages/redteam-tools/node_modules/@deepseek-ai/dsh-tools`）。

### 3.2 在 profile 的 patch 层挂载 host 行

编辑 `~/.dsh/profiles/<你的 profile>/cordis.patch.yml`，追加：

```yaml
- insert:
    - id: redteam-store
      name: dsh-redteam-store
      config:
        root: !!js dshHomePath('redteam')     # 事实库根目录，默认 $DSH_HOME/redteam

    - id: redteam-ui
      name: dsh-redteam-ui
```

### 3.3 安装预设与技能

```bash
mkdir -p ~/.dsh/.agent-presets/redteam ~/.dsh/skills
cp preset/agent.cordis.yml preset/preset.yml ~/.dsh/.agent-presets/redteam/
cp skills/*.md ~/.dsh/skills/
```

### 3.4 准备外部工具（可选但强烈建议）

技能里引用的扫描器/隧道工具需要**先落到本机**，智能体才能直接用（否则只能临时下载，内网环境往往下不动）。
建议放在 `$DSH_HOME/redteam/toolkit/`，并在自己的 VPS 上开一个载荷服务（`python3 -m http.server`）供跳板机拉取。

常用清单：`nmap` `masscan` `nuclei` `sqlmap` `ffuf` `httpx(ProjectDiscovery)` `naabu` `subfinder` `dnsx` `dirsearch` `gogo` `fscan` `suo5` `chisel` `frp`，以及冰蝎 / 哥斯拉 / 蚁剑。

> ⚠️ 注意 `httpx` 命令名与 Python httpx 库的 CLI 冲突，建议用绝对路径或自建包装器（如 `pd-httpx`）。

### 3.5 重启

host 平面新增了服务与表结构，**必须重启** `dsh web`（客户端 UI 改动会自动热重载，host 改动不会）。
重启后在界面助手栏能看到「红队模式」预设，右侧栏出现 RedTeam 面板。

## 4. 使用

1. 新建会话，选择预设 **红队模式**。
2. 直接发靶标单位名称（有范围就补一句，例如某个 C 段）。
3. 主会话把任务派给角色子智能体；资产测绘页签实时长出数据，会话隧道页签记录拿到的 WebShell 与隧道。
4. 报告页签出「攻击得分链路复现报告」：按攻击链五阶段顺序排，每条得分都附可直接粘进 Yakit Repeater 的原始请求。
5. 攻击文件页签按目标分目录保存真正有效的脚本 / POC / EXP。

## 5. 能力清单

**48 个工具**（节选）：

```
redteam_engagement_open          绑定本次演练靶标，创建工作区
redteam_asset_add/query/get/stats/graph/link/assess/test
                                 资产入库、查询、关联图谱、易打性评估、测试状态流转
                                 query 支持 scope=internal|external 区分内网/外网
redteam_domain_index             按域名维度聚合（域名 → 子域 → IP → C 段）
redteam_web_list                 Web 资产清单（URL + 标题，可点击）
redteam_vuln_add/query/update    漏洞记录与状态流转；gained 记录「通过它拿到了什么权限」
redteam_http_evidence_add        原始 HTTP 证据（供报告复现）
redteam_credential_add/list      凭据（明文 secret_value + 证据引用 secret_ref）
redteam_access_add/list          已获得的访问会话
redteam_sessions                 【每次派任务前先看】WebShell / 隧道 / 凭据 / 会话一屏总览
redteam_webshell_add/list/update 已上线 WebShell 的登记与状态维护
redteam_tunnel_add/list/update   内网隧道（suo5 / socks5 / ssh -R / frp…）的登记与状态维护
                                 必须声明 entry_kind（目标侧那一端）；自建服务器上开的标 self-only，不算突破
redteam_session_check            实测所有 WebShell 与隧道的连通性并回写状态
redteam_chain_add / redteam_chain       攻击链步骤
redteam_attack_path              攻击图谱（资产 → 漏洞 → 权限 → 内网）
redteam_attack_file_add/list     攻击文件归档（按目标分目录，强制要求证据引用）
redteam_poc_search/get/add/list/update/use
                                 知识库（POC/EXP）：**全局共享、跨靶标复用**。打 Nday/1day 前先检索，
                                 命中直接取全文；互联网扒的/自己手搓的验证有效后回填，复用计数排序
redteam_score_list / redteam_score_hit / redteam_score_point_save   得分目标与得分记录
                                 同类得分不设数量上限，按命中次数累加；记分带 vuln_id 供报告复现
redteam_score_report             攻击得分链路复现报告（只收录得分的成果，附可粘进 Yakit 的原始请求）
redteam_attack_chain             攻击链五阶段（信息收集→互联网资产权限→边界突破→内网资产权限→靶标权限）+ 各阶段得分与累计分
redteam_role_prompt / redteam_roles / redteam_role_prompt_reset     四个角色的系统提示词
redteam_report_targets / redteam_report 【已弃用】旧的按目标报告
```

**默认得分点**（共 255 分，可在「得分目标」面板增删改）：

| 得分点 | 分值 | 得分点 | 分值 |
| --- | --- | --- | --- |
| 获取 Web 普通账号权限 | 10 | 获取数据库权限 | 25 |
| 获取 Web 管理员账号权限 | 20 | 获取大量敏感信息 | 20 |
| 上传 WebShell 并维持访问 | 20 | 互联网边界突破 | 30 |
| RCE / 命令执行 | 30 | 突破逻辑内网（横向移动） | 35 |
| 获取服务器权限 | 25 | 拿下核心系统 | 40 |

**提示词口径（预设与四个角色提示词都写了）**：
- **只打得分面**：动手前先问"这条线能落到哪个得分点"，答不出来就不投入；明确禁止为"覆盖全面"去测信息泄露/配置类/中低危等与得分无关的问题（最多记一行排除结论）。
- **入口必须可交付**：WebShell 必须是**冰蝎马/哥斯拉马**（一句话马/自研马用户连不上，只算临时中转）；拿到 WebShell 后**必须用 suo5 建隧道**才算打进内网，建好要登记并实测连通。
- **自己注册的账号不算得分权限**：自助注册、自己新建的用户/角色、自己给自己开的权限都不是"拿到账号权限"——得分针对**拿到别人已有的**（弱口令、凭据泄露、注入拖库、越权/提权、默认口令）。这类用 `self_created=true` 留痕：**不计分、不占上限、不进报告**，页面上标红「自建 · 不计分」。
- **自己的 VPS / 自己配置的服务器不算隧道**：只在你自己服务器上开 socks5/frp/代理没碰到目标，不算跨越靶标边界。只有目标侧发起的通道才算：`target-outbound`（目标反弹 shell 到我方 / 目标上跑 frp 客户端）、`target-http`（经目标 WebShell 的 suo5/Neo-ReGeorg）、`target-agent`（经目标已控进程转发）；纯自己服务器上开的填 `self-only`，页面标红「不算突破」，攻击链也不把它算作边界突破。
- **Nday/1day 先查知识库**：`redteam_poc_search` 一次查两层——① 本机沉淀的通用 POC/EXP ② 本机 nuclei 模板库（`~/.local/nuclei-templates`，一万多条模板 / 四千多条 CVE）；命中直接取用（模板直接 `nuclei -t <路径> -u <目标>`）；两层都没有才去互联网（`web_search`/GitHub/ExploitDB/厂商公告）或自己手搓；**验证有效后必须回填**（`redteam_poc_add`，写清来源、影响版本与验证证据，并脱敏），后面的靶标直接就能用。
- 预设与角色提示词改版后，老靶标里仍是旧版默认的提示词会自动换成新版；用户自己改过的保持不动（面板里也有「恢复默认」）。

**控制台 11 个页签**：

| 页签 | 内容 |
| --- | --- |
| 资产测绘 | C 段按**内网 / 外网**分组；列表 / 域名 / Web / 图谱四种视图；易打性评估与测试状态 |
| 会话隧道 | WebShell 与内网隧道的在线状态、最后检测时间与延迟、一键实测连通性、走隧道的现成扫描命令；每条隧道标出**是否跨越靶标边界**（目标侧通道 / 不算突破 / 待确认）；**交付纪律提示**：非冰蝎马标红「用户连不上」、缺 suo5 隧道、通道全在自己服务器上（不算突破）都会顶出提示 |
| 漏洞战果 | 按严重级排序；**拿到什么权限**列；详情直接渲染可复现的原始 HTTP 请求/响应 |
| 攻击链 | **五阶段攻击链**：信息收集 → 互联网资产权限 → 边界突破 → 内网资产权限 → 靶标权限；每阶段给阶段目标、拿到多少分（含累计）、涉及资产；边界突破阶段只列**跨越靶标边界的通道**（自己服务器上的通道另计并提示"不计突破"）；A 竖向 + B 横向（**不含打法要点/工具清单**） |
| 得分目标 | 显示**已得总分 / 满分**，可编辑得分点；命中记录一行一条（**自适应换行**：长域名/长口令/长结果都完整显示，不截断）；自己注册的账号标红「自建 · 不计分」并在工具条单独计数 |
| 报告 | 攻击得分链路复现报告：**按阶段可折叠**（默认全开，可一键全部展开/折叠，状态按靶标记住），只收录得分成果，每条附可粘进 Yakit 的原始请求；**自己注册/自建的账号整条剔除**，只在抬头说明剔除了几条 |
| 攻击文件 | 按目标文件夹组织，只收录实际生效的脚本 / POC / EXP |
| 知识库 | **POC/EXP 知识库（全局共享，跨靶标复用）+ 本机 nuclei 模板库**：按 CVE/组件/关键字/正文关键词一次搜两层——① 本机沉淀的通用 POC/EXP（只看已验证、按复用次数排序，展开看用法/验证证据/正文，可一键复制、可记一次复用）② 本机 nuclei 模板命中（一万多条模板，直接复制 `nuclei -t <路径> -u <目标>`）。打 Nday/1day 前先在这里搜 |
| 智能体提示词 | 按角色编辑，可一键恢复内置最新版 |
| 技能库 | 浏览 DSH 原生技能目录与正文 |

## 6. 数据与隐私

* 所有演练数据只写在**本机** `$DSH_HOME/redteam/engagements/<靶标>/`：SQLite 事实库、`runs/` 证据、按目标分目录的攻击文件。本项目不含任何遥测、上报或云端同步代码。
* **知识库是全局的**：`$DSH_HOME/redteam/knowledge.db` + `pocs/<code>/`，跨靶标共享 POC/EXP（所以回填前必须**脱敏**：去掉内网真实地址、自己的 VPS/域名与靶标专属参数，只留通用部分）。
* **凭据明文入库、但只在本机**：`credential.secret_value` 存口令/Hash/密钥原文（「漏洞战果」页直接显示，便于随时复用），同时用 `secret_ref` 指向 `runs/` 下的证据文件。**这个库文件是最高敏感度的资产**，不要复制、导出或提交到任何仓库/聊天工具；`.gitignore` 已排除 `engagements/`、`*.db` 等路径。
* 界面与工具的所有写操作都要求证据引用，避免"无证据的成果"。
* `.gitignore` 默认排除 `engagements/`、`runs/`、`*.db`、`*.jsonl`、凭据与密钥文件，避免误提交演练数据。

## 7. 关于密钥

仓库里**不含任何真实密钥或基础设施地址**（VPS IP 等一律是 `<你的VPS_IP>` 占位符）。
涉及外部 API 的技能一律从环境变量读取，例如 FOFA 测绘：

```bash
export FOFA_KEY=你的key       # skills/fofa-recon.md 里的客户端只读这个变量
```

如果你 fork 后要加自己的 key，请放进 `.env`（已被 `.gitignore` 忽略）或本机环境变量，不要提交。

## 8. 目录结构

```
.
├── packages/
│   ├── redteam-store/       # SQLite 事实库 + ctx.redteam 服务 + CLI + 连通性探测
│   │   └── test/            # 零依赖回归测试（node test/stages.test.mjs）
│   ├── redteam-tools/       # 48 个 redteam_* 模型工具
│   │   └── test/            # 零依赖回归测试（node test/poc-tools.test.mjs）
│   └── redteam-ui/          # 常驻右侧栏控制台（host 桥接 + 客户端 UI）
├── preset/                  # DSH agent preset（红队人设与工具行）
├── skills/                  # 13 个 DSH 原生技能
├── docs/                    # 环境配置记录（如 Kimi WebBridge 桥接）
└── redteam-proto/           # 原型脚本与演示数据（RFC 5737 文档地址）
```

## 9. 版本与回归测试

版本以 tag / Release 形式发布（[全部版本](https://github.com/Jueze-2019/dsh-redteam-mode/releases)），
当前为 **v0.6.0**。改的是本机正在用的那三个包时，记得 host 侧改动要重启 `dsh web` 才生效。

零依赖回归测试（不需要装任何东西）：

```bash
node packages/redteam-store/test/stages.test.mjs   # 阶段表自愈 + 得分归阶段 + 报告序号
node packages/redteam-store/test/prompts.test.mjs  # 角色提示词：默认值自动升级、用户自写不被覆盖
node packages/redteam-store/test/rules.test.mjs    # 判定规则：自建账号不计分、只有目标侧通道算突破
node packages/redteam-tools/test/poc-tools.test.mjs # 知识库工具：检索/回填/跨靶标共享/去重
node packages/redteam-tools/test/rule-tools.test.mjs # 工具的规则输出：score_hit / tunnel_add / sessions
```

它覆盖的是一类**静默算错分**的故障：攻击链与报告按阶段表分组，阶段行一旦缺失，
挂在那个阶段的得分会被无声丢弃（v0.4.2 修的正是 ⑤靶标权限 被旧迁移误删、
攻击链少算 40 分而得分面板仍显示 490 分的问题）。所以改迁移或阶段表后，务必跑一遍。

界面另有一套 jsdom 渲染测试（逐个页签渲染 + 交互断言），依赖 react/jsdom，
未随仓库分发；它抓到过「折叠层级失效」「报告页误报没有成果」这类只在真实
渲染路径上暴露的问题。

## 10. 合规声明

本项目面向**授权范围内的安全评估**：攻防演练、红蓝对抗、企业自检、教学研究。

* 未获授权对任何系统进行扫描、探测、入侵或数据获取，均属违法，与本项目作者无关。
* 使用前请确认授权书、测试范围（资产清单 / 时间窗 / 允许的手段）与免责条款。
* 请遵守目标所在司法辖区的法律，以及 GitHub 的服务条款。

## 11. License

MIT，见 [LICENSE](LICENSE)。
