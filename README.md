# DSH RedTeam 模式

> ⚠️ **仅限已获授权的攻防演练 / 渗透测试使用。**
> 本仓库是智能体编排与事实库的工程实现，**不包含任何漏洞利用代码**。
> 使用者必须自行确保对目标拥有书面授权；未经授权的扫描与入侵在绝大多数司法辖区都是违法行为。
> 作者不对任何滥用行为负责。

把 [DeepSeek Harness](https://github.com/deepseek-ai)（DSH）改造成一台**红队作战指挥台**：
发给指挥智能体的全部输入只有**一个靶标单位名称**，它会拉起信息收集 → 资产梳理 → 漏洞发现 → 漏洞利用 → 内网渗透五个执行角色，
把资产、漏洞、凭据、会话、攻击链实时落进本地 SQLite 事实库，并在界面右侧栏的常驻控制台里可视化。

| | |
| --- | --- |
| 装法 | `dsh plugin --profile web add dsh-redteam-mode`（一条命令） |
| 规模 | 53 个 `redteam_*` 模型工具 · **23 个原生技能** · 12 个控制台页签 · 22 张事实库表 |
| 数据 | 全部落在本机 `$DSH_HOME/redteam/`，无遥测、无上报、无云端同步 |
| 当前版本 | **v0.11.3** |

**目录**：[快速开始](#1-快速开始) · [使用](#2-使用) · [能力](#3-能力) · [架构与目录](#4-架构与目录) · [数据与隐私](#5-数据与隐私) · [密钥与外部-api](#6-密钥与外部-api) · [开发与发版](#7-开发回归测试与发版) · [合规声明](#8-合规声明)

---

## 1. 快速开始

### 1.1 从插件市场装（推荐）

```sh
dsh plugin --profile web add dsh-redteam-mode
```

装完**重启一次 `dsh web`**，然后在 **设置 → 插件市场** 里也能搜到（关键字 `redteam`）。
首次启动会自动把自带的 `红队模式` 预设装到 `$DSH_HOME/.agent-presets/redteam/`、注册 **23 个原生技能**，
不需要手动拷任何文件。

### 1.1.1 首次使用：一键铺环境（推荐第一个动作）

```sh
bash "$DSH_HOME/redteam/setup.sh" --check   # 体检：10 秒看清缺什么
bash "$DSH_HOME/redteam/setup.sh"           # 交互式：缺啥装啥 + 引导填 FOFA_KEY / VPS
bash "$DSH_HOME/redteam/setup.sh" --yes     # 全自动（配置用已有值）
```

脚本**随包分发**（市场包装完就在 `$DSH_HOME/redteam/setup.sh`，不需要仓库）、
**幂等**（坏了会自动重下自愈）、**零依赖**（只用 curl/python3/tar/unzip）、
**不动系统**（只写 `$DSH_HOME/redteam/toolkit/` 与 `$DSH_HOME/.env`，不擅自 `sudo apt`）。
所有下载走 GitHub `releases/latest` API 取真实资产，并做**三层完整性校验**：

1. 下载后与 API 声明的字节数逐字节对账（截断的二进制会静默失效——文件在、权限对、运行却零输出）；
2. 解压出的二进制真跑一次 `--version/-h` 冒烟；
3. 最终体检只认"真能跑起来"，不通过的单独列出并提示重下。

它做四件事：① 装工具 ② 体检 nuclei 模板库 ③ 收配置（FOFA_KEY、VPS 地址与私钥） ④ 实测通道并写完成标记。

**进红队模式后其实不用手动跑**：指挥智能体的第一个动作 `redteam_preflight` 会返回 `onboarding` 状态，
首次使用（`onboarding.complete=false`）时它会自动加载 `redteam-setup` 技能、把缺口**一次性列给你**并引导补齐。

**前置**：DSH 能正常 `dsh web` 启动；Node.js ≥ 22.13（依赖内置 `node:sqlite`，会打印 ExperimentalWarning，属正常）。

> ⚠️ **请跑在专供演练的 Kali 虚拟机里，不要跑在用户日常办公电脑/宿主机上。**
> 本模式会真实发包、上传 WebShell、建立隧道；本机还会存放 VPS 私钥与各类马。
> 跑在宿主机上会带来三个实际问题：安全软件/EDR 拦查误伤日常环境、扫描流量从你常用出口 IP 出去影响正常上网、
> 演练结束难以彻底清理。**演练完虚拟机直接丢弃最干净。**
> 指挥智能体在首次开工时也会提醒一次（见 `redteam-setup` 技能）。

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

**外部工具**：`bash "$DSH_HOME/redteam/setup.sh" --yes` 会自动装齐（见 1.1.1）。
工具箱落在 `$DSH_HOME/redteam/toolkit/`，分两部分：
- **PATH 上的系统工具**（Kali 自带，脚本只体检不擅自 apt）：`nmap` `masscan` `nuclei` `sqlmap` `ffuf` `feroxbuster` `gobuster` `hydra` `hashcat` `john` `wpscan` `nikto` `whatweb` `amass` `theHarvester` `msfconsole` `searchsploit` `proxychains4` `socat`；
- **工具箱二进制**（脚本自动下载）：`gogo` `fscan` `suo5` `chisel` `frpc/frps` `subfinder` `dnsx` `naabu` `httpx(PD)` `ksubdomain` `ligolo-ng(proxy/agent)` `gowitness` `OneForAll`，以及冰蝎 / 哥斯拉 / 蚁剑。

**两个易踩的坑**：
- `httpx` 与 Python httpx 库的 CLI 冲突 —— 用 `pd-httpx` 包装器或绝对路径 `$DSH_HOME/redteam/toolkit/httpx/httpx`；
- `OneForAll` 是源码 + 独立 `.venv`（`$DSH_HOME/redteam/toolkit/oneforall/OneForAll-0.4.5/`），用 `.venv/bin/python oneforall.py` 跑。

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
2. 直接发靶标单位名称（有范围就补一句，例如某个 C 段）——**发出名称即视为已授权，不会再问你授权范围**。
3. 主会话先做**技能与资源预检**（`redteam_preflight`）：缺 key / 缺 VPS / 缺工具会一次性列清向你要，补不齐就说明降级并给替代方案。
4. 然后主会话只做四件事——计划任务、派子智能体、分析回报、决定下一个任务；**动手的活全部委派**，且**同时最多 3 个执行智能体**（默认一个一个派）。
5. 每次发现都必须落库（`redteam_asset_add` / `vuln_add` / `http_evidence_add` / `credential_add` / `access_add` / `chain_add` / `score_hit`）——**未落库的发现视为无效工作**。
6. 看结果：资产测绘页签（含**发现时间**）、智能体页签（并发名额与六角色）、会话隧道页签、得分目标页签、报告页签（**每条成果都写清怎么拿到的**）。

```
用户：<靶标单位名称>
   │
   ├─ ① 预检：redteam_preflight（技能能不能用 / 缺什么 key·VPS·工具）
   │
   ├─ 主会话 plan（指挥，不动手）：计划 / 派活 / 核对落库 / 汇报（并发 ≤ 3）
   │     ├─ 信息收集  recon     被动(FOFA·证书·被动DNS) + 主动探测，把资产**收全**（含边缘·未备案）
   │     ├─ 资产梳理  assess    **一条一条过**，评易打性并全部落库，产出"先打谁"
   │     ├─ 漏洞发现  vuln-scan 先查库去重 → Nday/1day 优先 → 前端接口未授权 → 逐条落库+原始请求
   │     ├─ 漏洞利用  exploit   先拿服务器权限（冰蝎/哥斯拉马，用户必须能连上）→ 建 suo5 隧道（实测通内网）→ 其它得分
   │     └─ 内网渗透  internal  走隧道，依次拉起 ①②③④ 做内网，重点是挖出**所有内网网段**
   │
   └─ 全部发现落进 SQLite 事实库（22 张表 + FTS5 全文索引）
            ↓
      右侧栏控制台 12 个页签 · 右上角「版本 + 一键更新」
```

---

## 3. 能力

### 3.1 默认得分点（25 项，严格对齐《突破入侵类得分规则（合并版）》)

每一条的分值、上限与计分口径都由规则文档决定，**写在 `score_point` 表里、可被 `redteam_score_list` 读到**：

| 系统类别 | 档位 | 单条上限 | 计分口径 |
| --- | --- | --- | --- |
| **控制一般系统** | | | |
| 域名控制权限 | 一级 50 / 二级 20 分/个 | 400 | system |
| 终端权限（手机、Pad、PC、打印机、摄像头、wifi 路由器等） | 5 / 10 分/台 | 600 | system |
| 服务器主机权限（含 webshell 权限） | 普通 10 / 管理员 50 分/个 | 600 | system |
| 数据库连接账号密码（含 SQL 注入） | 普通 10 / 管理员 50 / 未授权 10 分/个 | 400 | system |
| **控制 Web 应用系统** | | | |
| 邮箱系统 / 办公自动化与业务生产系统权限 | 管理员 100 / 普通 50 分/个 | 2000 | system |
| **控制集权系统** | | | |
| 集权系统权限（运维 / 身份 / 组网 / 终端管理后台） | 管理员 500 / 普通 50 分/个 | 4000 | system |
| **控制大数据系统** | | | |
| 大数据系统权限 | 管理员 1000 / 普通 100 分/个 | 4000 | system |
| **控制网络基础设施** | | | |
| 网络设备权限（防火墙、路由器、交换机、网闸、光闸、摆渡机、VPN 等） | 普通 100 / 管理员 200 / 加成 200·1000 分 | 2000 | service |
| 工业互联网系统权限 | 管理员 200 / 设备 10 分/个 | 2000 | system |
| 云管理平台控制权（含 PaaS 云平台，如 K8S、红帽 OpenShift 等） | 管理员 500 / 节点 10 分/台 | 2000 | system |
| 物联网设备管控平台权限 | 平台 200 / 连接点 10 / 核心网 +5000 分 | 2000 | system |
| 安全设备权限（IPS、IDS、审计设备、WAF 等非集权类安全设备） | 管理员 200 分 | 1000 | service |
| 网络设备 · 借助该设备进行网络重定向或业务劫持 | 重定向 / 业务劫持 +200 分 | 2000 | none |
| 网络设备 · 植入远控程序并成功进行后续攻击 | 植入远控 + 后续攻击 1000 分 | 2000 | none |
| 物联网 · 经端点设备打入核心网并控制重要系统 | 核心网 +5000 分 | 5000 | none |
| **文件存储类系统** | | | |
| 文件存储类系统权限（FTP、对象存储、企业 NAS、企业网盘等） | 管理员 50 / 普通 10 分/个 | 500 | system |
| **控制模型相关系统** | | | |
| 模型智能体、skill 等 agent 工具（并能操作 agent 进行攻击） | 100–500 分/个 | 4000 | service |
| 算力管理平台权限 / 训练数据与知识库系统权限 | 系统管理权限 500 分/个 | 4000 | system |
| 模型相关数据系统权限 | 系统管理员权限 500 分/个 | 4000 | system |
| 算力基础设施 · 管理员权限 | 管理员 500 分/个 | 2000 | system |
| 算力基础设施 · 算力卡资源 / 算力卡池化平台 | 10 分/卡 | 2000 | none |
| **突破网络边界** | | | |
| 进入逻辑隔离业务内网 | 1000 分 | — | target |
| 进入逻辑强隔离业务内网 | 10000 分 | — | target |
| 进入物理隔离内网、核心生产网 | 30000 分 | — | target |
| 借助供应链运维通道或云服务进入内网 | 1000 分（最多 3000） | 3000 | service |

`dedup_scope` 的含义：

- `service` —— 同一（资产, 端口）只算分值最高的那条；账号、数据库、网络设备等按服务拿满。
- `system` —— 同一（资产, 端口, 系统名）只算最高权限一次；邮箱 / OA / 集权系统等"同一个系统只计一次最高权限"。
- `target` —— 整个目标只算一次；突破网络边界四档用它。
- `none` —— 不去重，按台 / 卡 / 节点数累加；终端、算力卡用它。

**通用规则 G1–G8**（横切全部条目）：

- **G1 权限取高、只计一次**：同一系统、同一主机、同一数据库上取得多种权限时，只按最高权限计一次分（既获取管理员又获取普通权限的，只给管理员权限分）。
- **G2 数据成果另行计分**：邮件数据、业务数据、数据资产等成果按数据重要程度单独计分，不与权限分混算。
- **G3 上限口径**：各项分值上限针对单个防守单位及其所有下属机构，达到上限后不再累计。
- **G4 设备/终端按台（个）计分**：打印机、wifi 路由器 5 分/台；PC、Pad、手机、摄像头、电子大屏 10 分/台；云上主机、容器、托管互联设备、物联网连接点等按 10 分/台（个）。批量控制按"被控节点"折算。
- **G5 数据规模翻倍**：含大量数据系统（重要数据量超 1 亿条或 10TB）得分翻倍；控制知识库相关系统得分翻倍。不含系统产生的普通日志数据。
- **G6 IPv6 倍数**：利用 IPv6 取得的成果分数 ×3，但上限仍按对应系统类型的原上限计算，不因倍数突破上限。
- **G7 证明材料**：突破网络边界须提供隔离设备控制截图、能访问内网的截图证明等；控制的手机、Pad 等终端设备应能证明与目标单位的关系；网络设备权限需提供路由表等证据或连接量截图。
- **G8 兜底条款**：其他系统、服务器、设备等权限不预设分值，由专项组研判后给分。

**计分口径由服务端判定，不靠自觉**：

- 每条规则有**累计上限**：同一 rule 的命中按分值从高到低累计，超出上限的部分标为「不计分」只作过程留痕，`redteam_score_hit` 会回一条 warning 说明原因（把它当停止信号，换规则或换资产推进）。
- **权限取高、只计一次**（G1）：同一服务 / 同一系统上既有普通权限又有管理员权限时，只算管理员那条，先记的普通权限会被顶掉并转为不计分。
- **自建账号不计分**：自助注册 / 自建用户角色只留痕（`self_created=true`），不计分、不占上限、不进报告。
- **分值按档位填写**：`points` 只用于在"同一条规则的多档"里指明这次是哪一档（如服务器权限普通档 10 / 管理员档 50）。服务端会校验它落在合理区间内，**不能用它调分**。
- **原始序号（src）**：每条得分点保留《合并版》里的"原序号"用于对账；面板「得分目标」页签按上面的 8 个类别分组展示。
- **内置得分点不可改分值、不可删除**：分值、上限、口径、名称与条款正文随规则锁定（同一 rule 的上限按组内所有点累计，单独改分值会让一条命中吃掉整组上限）。要自定义分值时**新增得分点**——自建点可以随意编辑，也不会被版本升级清掉。

### 3.2 控制台 12 个页签

| 页签 | 内容 |
| --- | --- |
| 资产测绘 | C 段按**内网 / 外网**分组；列表 / **发现时间** / 域名 / Web 四种视图；每条资产带**发现时间**（第一次入库的时刻，重复采集只刷新「最近采集」）；易打性评估与测试状态 |
| 当前测试 | 正在测的资产与状态流转（未测试 / 测试中 / 已测试 / 被封禁 / 已放弃 / 无攻击面） |
| 会话隧道 | WebShell 与隧道在线状态、最后检测时间与延迟、一键实测连通性、走隧道的现成扫描命令；每条隧道标出**是否跨越靶标边界**；非冰蝎马标红「用户连不上」、缺 suo5 隧道、通道全在自己服务器上都顶出提示 |
| 智能体 | **并发名额**（同一靶标最多 3 个，实时看在跑几个）、六角色职责速览、按角色查看提示词 |
| 漏洞战果 | 按严重级排序；**拿到什么权限**列；详情直接渲染可复现的原始 HTTP 请求/响应 |
| 攻击链 | **五阶段**：信息收集 → 互联网资产权限 → 边界突破 → 内网资产权限 → 靶标权限；每阶段给目标、拿到多少分（含累计）、涉及资产；边界突破阶段只列**跨越靶标边界的通道** |
| 得分目标 | 已得总分（不显示"满分"——总分由实际成果累加而来）；按《合并版》8 个类别分组，**内置得分点的分值/上限/口径由规则锁定**（表单里置灰并说明原因，可改的只有「启用/停用」；要自定义分值请新增得分点，自建点不会被版本升级清掉）；命中记录一行一条（自适应换行，不截断）；自建账号标红「自建 · 不计分」并单独计数；**同资产同端口的重复账号/库权限、以及超出规则上限的命中标黄「不计分」**，并在条目上单列原因 |
| 报告 | 攻击得分链路复现报告：按阶段可折叠，只收录得分成果，每条附可粘进 Yakit 的原始请求；**每条都给出「这一步怎么来的」**——动作步骤（谁做的、为什么、**实际命令**、回显）+ 凭据来源（账号密码怎么来的）+ 隧道搭建命令（隧道怎么搭的）+ WebShell 连接要素；缺步骤/缺命令的条目会标「复现链不完整」并列出缺口；文末附**资产发现时间**附录；自建账号与「同服务重复命中」整条剔除（抬头分别给出剔除了多少条） |
| 攻击文件 | 按目标文件夹组织，只收录实际生效的脚本 / POC / EXP |
| 知识库 | POC/EXP 知识库（**全局共享、跨靶标复用**）+ 本机 nuclei 模板库：按 CVE/组件/关键字一次搜两层。**按归类分组**（14 类：RCE / 反序列化 / 文件上传 / SQL 注入 / 未授权 / 认证绕过 / 弱口令 / SSRF / XXE / 目录穿越 / 信息泄露 / 提权横向 / 隧道 / 其它），每条标出**建立时间**、**来源靶标**与**发现资产**，可按这三项筛选 |
| 智能体提示词 | 按角色编辑，可一键恢复内置最新版 |
| 技能库 | 浏览 DSH 原生技能目录与正文；**每个技能带可用性状态**（可用 / 不可用 / 未知）——判定「技能文件存在 + 正文能加载 + 必需环境变量已设 + 正文引用的本机路径存在 + 没有未填的基础设施占位符」，缺口（缺哪个 key、缺哪个二进制、VPS 还是占位符）直接列出来，可「只看不可用/未知」与「重查可用性」 |

**每个页签带未读红点**：某页签出现了新内容（新资产 / 新漏洞 / 新得分 / 新隧道 / 新知识库条目…）就点一个红点，**点开那个页签看过之后才消失**；未读状态按靶标记在本机 localStorage，第一次打开面板不会满屏红点（那一次视为已读起点）。

面板右上角常驻 **版本号 + 自动更新**：启动时静默对比 npm 上的最新版本，有新版本点亮按钮 → 弹窗显示当前/最新/安装位置/阻塞项 → 一键安装并自动重启 `dsh web`（**检测到有智能体在跑会拦住**，不会打断作业）。

### 3.3 作战纪律（预设与六个角色提示词都写了）

- **只打得分面**：动手前先问“这条线能落到哪个得分点”，答不出来就不投入；明确禁止为“覆盖全面”去测信息泄露/配置类/中低危等与得分无关的问题（最多记一行排除结论）。
- **拿到账号权限必须用浏览器实测登录、交互访问**：**只有凭据不算拿到账号**——拿到账号/口令后用 `browser-automation` / `kimi-webbridge` 真实登录进后台或业务页（验证码自己识别），抓到会话 Cookie/Token 并 `redteam_access_add`（method=web-login）登记，**登录成功才记账号权限分**；目标只在内网可达时先建 suo5 隧道再用浏览器 `--proxy-server=socks5://127.0.0.1:1080` 登录；登不进去（哈希未破解 / 二次认证 / 限制来源 IP）用 `redteam_asset_test` 的 `test`（追加式）记一行结论即可，不当成果记分。内网拿到凭据同样先试内网管理端（堡垒机 / 运维平台 / 数据库后台 / 域控）。
- **只在有增量时汇报**：主会话**只在得到分数、发现新资产（新网段/新入口），或需要用户出手（缺 key/VPS/账号/范围）与遇到真实卡点、阶段推进时才发消息**，且只写增量、同一批成果只报一次；没有新东西就安静地继续派下一个子智能体，**不要每轮复述进度**（省 token）。用户主动问进度/要报告时照常完整回答。
- **记分必填两样**：`redteam_score_hit` 的 `code`（如 `domain-control` / `terminal-access` / `server-host` / `db-credential` / `web-app` / `central-system` / `bigdata-system` / `netdev` / `cloud-platform` / `model-compute` / `computepower-admin` / `boundary-logical`，**以 `redteam_score_list` 的实际值为准**；旧 code `web-account-*`、`webshell`、`rce`、`server-shell`、`db-access`、`sensitive-data`、`boundary`、`internal-pivot`、`core-system` 已随合并版作废）+ `evidence`（只写结果：目标资产 + 账号/权限/数据量）。缺任一项服务端直接报错；能带 `vuln_id` 就带上，报告会据此附上原始请求。
- **入口必须可交付**：WebShell 必须是**冰蝎马 / 哥斯拉马**（一句话马、自研马用户连不上，只算临时中转）；拿到 WebShell 后**必须用 suo5 建隧道**才算打进内网，建好要登记（`kind` / `listen` 必填）并实测连通。**`entry_kind` 是边界突破得分的凭证**：留空则 `legit=null`、页面显示「待确认」，不计入边界突破——发现历史隧道留空要立刻 `redteam_tunnel_update` 补上。
- **攻击链步骤必带 `stage_code`**，只有 5 个合法值：`recon`（信息收集）/ `internet`（互联网资产权限）/ `boundary`（边界突破）/ `internal`（内网资产权限）/ `target`（靶标权限）。写别的值会被忽略并退回按 `stage` 兜底，步骤就不落在任何阶段（页面计数为 0）。
- **自己注册的账号不算得分权限**：自助注册、自己新建的用户/角色、自己给自己开的权限都不是“拿到账号权限”——得分针对**拿到别人已有的**（弱口令、凭据泄露、注入拖库、越权/提权、默认口令）。这类用 `self_created=true` 留痕：**不计分、不占上限、不进报告**。
- **账号权限与数据库权限按「同一资产 + 同一端口」只算一次**：同一个服务上拿到**最高权限账号即拿满**（业务系统普通档 50 分 / 管理员档 100 分争同一个名额，只算分值最高的那条；`db-credential` 同口径）。**不要在同一个服务上刷多个账号凑分**——`redteam_score_hit` 会回 warning 说明"该服务已拿满、这条不计分"，把它当停止信号，换端口/资产或换得分点推进；记这类分时 `target` 带端口（`http://h:8080/admin`、`10.0.0.5:6379`）或传 `port`。
- **自己的 VPS / 自己配置的服务器不算隧道**：只在自己服务器上开 socks5/frp/代理没碰到目标，不算跨越靶标边界。只有目标侧发起的通道才算：`target-outbound`（目标反弹 shell 到我方 / 目标上跑 frp 客户端）、`target-http`（经目标 WebShell 的 suo5 / Neo-ReGeorg）、`target-agent`（经目标已控进程转发）；纯自己服务器上开的填 `self-only`，页面标红「不算突破」，攻击链也不把它算作边界突破。
- **Nday/1day 先查知识库**：`redteam_poc_search` 一次查两层——① 本机沉淀的通用 POC/EXP ② 本机 nuclei 模板库（`~/.local/nuclei-templates`）；命中直接取用（模板直接 `nuclei -t <路径> -u <目标>`）；两层都没有才去互联网（`web_search` / GitHub / ExploitDB / 厂商公告）或自己手搓；**验证有效后必须回填**（`redteam_poc_add`，写清来源、影响版本与验证证据，并脱敏）。
- **打之前先查库**：动手前先看该资产的 `test_status` / 已有漏洞 / 现成 WebShell·隧道·凭据，打过的不再打；测完立刻回写 `redteam_asset_test`。
- **子智能体是叶子节点（硬约束）**：预设在 `tool-subagent` 上用 `toolFilter.deny` 把 `subagent` / `subagent_fork` / `workflow` / `ralph` 从**子会话的工具目录里直接摘掉**，子智能体连看都看不到这些工具——不再只靠提示词劝"不许再往下委派"；同时 `maxDepth: 1` 作二道保险（默认 3 层太深）。
- **技能 key 放 `$DSH_HOME/.env`**（`FOFA_KEY` 等）：dsh 启动时会读这个文件（不覆盖已继承的变量），`scripts/restart-dsh-web.sh` 重启时也会 source 它——**放这里一次配好，之后每次重启都在**；只有一次性/CI 场景才用命令行 `export`。文件里有明文密钥，权限保持 `600`。
- **开工先预检**：主会话第一件事是 `redteam_preflight`（逐个技能查必需环境变量、本机工具与二进制、外部 VPS），缺什么一次性向用户要；补不齐就说明哪部分能力降级并给替代方案（如 FOFA 不可用 → crt.sh / 被动 DNS / subfinder）。
- **技能可用性只有一份判定**：面板「技能库」页签显示的与 `redteam_preflight` 判定的是同一份实现（`packages/redteam-store/lib/skill-availability.js`），所见即智能体所判。
- **内网信息收集用 gogo + fscan，不要拿 nmap 一台台扫**：`recon` 角色提示词写明——走隧道先用 `gogo-intranet` 铺面（存活/端口/服务/指纹/关键信息）、再用 `fscan-intranet` 打点（弱口令/未授权/高危漏洞，命中项记进资产 `surface` 交漏洞发现角色）；**每发现一个新网段就再跑一轮**，直到没有新网段、没有新存活。
- **并发硬约束 ≤ 3**：`redteam_agent_slot` 读 `ctx.subagents` 的真实运行数，满了直接拒绝派活（不是靠提示词自觉）；默认一个一个派、按顺序推进。
- **会话隔离**：靶标绑定按**根会话**记账（`session.header.parentSession` 走到顶），子智能体沿父链继承父会话的靶标；另一个会话 `open` 别的靶标不会影响它，未绑定的会话也不会被静默塞进别人的库（明确报错并要求 `redteam_session_bind`）。
- **落库要能溯源**：攻击步骤必须写 `tool`（**实际命令原文**）与 `result`（回显），凭据写 `source`（弱口令/注入拖库/配置泄露/凭据复用…），隧道写 `command` + `entry_kind`——报告里"账号密码怎么来的、隧道怎么搭建的"完全靠这几列。
- **公共段落由代码注入**：授权、记分、查库、落库溯源、交付口径这五段只写一份（`COMMON_AUTH` / `COMMON_SCORE_RULES` / `COMMON_DB_LOOKUP` / `COMMON_EVIDENCE` / `COMMON_HANDOFF`），由 `DEFAULT_PROMPTS` 在末尾按角色拼接注入——面板/工具/测试拿到的仍是完整正文。提示词源文件拆成 `prompts.src.js`（公共段落）+ `prompts.roles.md`（六个角色正文），跑 `node packages/redteam-store/tools/gen-prompts.mjs` 生成回 `core.js`（幂等，可反复跑）。
- 预设与角色提示词改版后，老靶标里仍是旧版默认的提示词会自动换成新版，用户自己改过的保持不动（面板里也有「恢复默认」）。
  角色提示词是**按靶标**存的（`$DSH_HOME/redteam/engagements/<靶标>/agents/*.md`），只在读取时才比对升级——所以改完提示词后，老靶标要一个个打开面板才跟上。要一次性批量刷新：

  ```bash
  node scripts/refresh-all-prompts.mjs --dry-run   # 先看会改哪些（不落盘）
  node scripts/refresh-all-prompts.mjs             # 批量升级（自动备份 .bak-<时间戳>）
  node scripts/refresh-all-prompts.mjs --force     # v0.9.0 六个角色整体重写：连"用户自写"也换成新版
  ```

  > v0.9.0 把六个角色提示词**全部重写**，历史默认指纹表按设计清空：老靶标里残留的旧提示词会被判为"用户自写"而保留——要一次性换成新版用 `--force`（覆盖前自动 `.bak` 备份）。

  输出里若出现 `用户自写(保留)`，说明那个角色确实被人工改过，脚本不会覆盖它；判定语义与面板完全一致（复用服务端的 `refreshDefaultPrompts`）。

### 3.4 技能库（23 个，按角色归类）

| 角色 | 技能 | 说明 |
| --- | --- | --- |
| **信息收集** | `fofa-recon` | FOFA API 测绘（限速客户端，避免 45012） |
| | `passive-recon` | 纯被动：crt.sh / dig / whois，不接触目标 |
| | `recon-pipeline` | **PD 流水线**：subfinder → dnsx → naabu → httpx（+ OneForAll / ksubdomain / gowitness） |
| | `active-scan` | 主动端口与服务扫描（nmap / masscan / naabu） |
| | `web-fingerprint` | 指纹：框架 / 中间件 / CMS / 组件版本 |
| | `asset-correlation` | 域名↔IP↔C 段↔证书↔服务的图谱化 |
| | `browser-automation` | 无依赖 headless Chrome：渲染抓取 / 截图 / 抓接口清单 |
| | `kimi-webbridge` | 驱动真实 Chrome（复用登录态） |
| | `cn-proxy-pool` | 国内免费代理池（只做命令级代理，绝不动系统配置） |
| **资产梳理** | （技能由资产库承担） | 逐条评估落在 `redteam_asset_assess`，图谱落在 `redteam_asset_link` |
| **漏洞发现** | `nuclei-scan` | **模板化检测主力**（13,742 个模板：CVE / 暴露面 / 配置缺陷 / 默认口令） |
| | `dir-bruteforce` | 目录与文件爆破：feroxbuster / ffuf / dirsearch / gobuster |
| | `unauth-exploit` | 未授权服务利用：Redis / MySQL / MSSQL / ES / Docker / SMB … |
| **漏洞利用** | `webshell-toolkit` | 冰蝎 / 哥斯拉 / 蚁剑的落地与使用 |
| | `credential-attack` | **凭据攻击**：hydra 在线爆破 + hashcat/john 离线破解 + 凭据复用 |
| | `shell-handler` | **反弹 Shell 与会话**：MSF handler / web_delivery / nc / socat |
| | `vps-reverse-shell` | VPS 中转：监听、非交互会话驱动、载荷投递 |
| **内网渗透** | `gogo-intranet` | 大网段低噪声测绘与指纹（先铺面） |
| | `fscan-intranet` | 内网普查打点：弱口令 / 未授权 / 高危漏洞（再打点） |
| | `suo5-tunnel` | WebShell → SOCKS5 隧道（主通道） |
| | `chisel-tunnel` | HTTP/WebSocket 隧道与端口转发（最易穿透出网限制） |
| | `frp-tunnel` | frps + frpc 长期稳定穿透与端口映射 |
| | `lateral-movement` | **横向与提权**：Impacket（PtH / PsExec / WMI / Kerberos / 凭据转储）+ enum4linux |
| **引导** | `redteam-setup` | 首次使用引导：装齐工具、收 FOFA_KEY 与 VPS、验证通道 |

每条技能的可用性由 `packages/redteam-store/lib/skill-availability.js` **统一判定**（文件存在 + 正文可加载 + 必需环境变量已设 + 引用的本机路径存在 + 基础设施已配），
面板「技能库」页签与 `redteam_preflight` 用的是同一份结论。

### 3.5 模型工具（53 个 `redteam_*`，节选）

```
redteam_preflight                【开工第一件事】技能与资源预检：环境变量 / 本机工具 / VPS，缺什么列给用户
redteam_agent_slot               并发闸门：看名额 / 占位 / 释放（同一靶标最多 3 个执行智能体）
redteam_engagement_open          绑定本次演练靶标（**只绑本会话**，不影响其它会话），创建工作区
redteam_session_bind             把一个已有靶标绑到当前会话（多会话并行时各绑各的）
redteam_session_info             看当前会话绑的是哪个靶标（会话 id / 父会话 / 根会话 / 绑定链）
redteam_asset_add/query/get/stats/graph/link/assess/test
                                 资产入库、查询、关联图谱、易打性评估、测试状态流转
                                 query 支持 scope=internal|external 区分内网/外网
redteam_asset_timeline           资产发现时间线：按天聚合新增资产（内/外网）+ 最近发现清单
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
                                 chain_add 必带 tool（实际命令）+ result（回显）+ agent（谁做的）——报告溯源靠它
redteam_attack_file_add/list     攻击文件归档（按目标分目录，强制要求证据引用）
redteam_poc_search/get/add/list/update/use
                                 知识库：全局共享、跨靶标复用，打 Nday/1day 前先检索
                                 add 带 category 归类 + engagement/asset_target 来源溯源；search 可按归类/靶标/资产筛
redteam_score_list / redteam_score_hit / redteam_score_point_save
                                 得分目标与得分记录；同类不设上限，记分带 vuln_id 供报告复现
redteam_score_report             攻击得分链路复现报告（只收录得分成果）
redteam_attack_chain             攻击链五阶段 + 各阶段得分与累计分
redteam_role_prompt / redteam_roles / redteam_role_prompt_reset
                                 六个角色（主会话 + 五个执行角色）的系统提示词
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
| `dsh-redteam-tools`（`packages/redteam-tools`） | **agent** | 53 个模型工具（`redteam_*`），把事实库、得分目标、会话入口暴露给智能体；随 preset 挂载，每个会话一份。**靶标绑定按根会话隔离**，子智能体沿父链继承。 |
| `dsh-redteam-ui`（`packages/redteam-ui`） | **host + client** | 控制台。host 半侧注册 `POST /redteam/api` 桥接 `ctx.redteam`（含异步连通性探测）；浏览器半侧是常驻右侧栏 UI。 |
| `dsh-redteam-mode`（`packages/redteam-bundle`） | **市场包** | 自包含单包：`lib/` 由 `tools/build.mjs` 从上面三个包生成，预设与 23 个技能一并打包，供 `dsh plugin add` 一条命令安装。 |

```
.
├── packages/
│   ├── redteam-store/       # 事实库 + ctx.redteam 服务 + CLI + 连通性探测（test/ 零依赖回归测试）
│   ├── redteam-tools/       # 53 个 redteam_* 模型工具（test/ 零依赖回归测试）
│   ├── redteam-ui/          # 常驻右侧栏控制台（host 桥接 + 客户端 UI）
│   └── redteam-bundle/      # 市场包 dsh-redteam-mode（lib/ 为生成物，presets/ 与 skills/ 随包）
├── preset/                  # DSH agent preset（人设 + 工具行 + 委派组）
├── skills/                  # 23 个 DSH 原生技能
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
node packages/redteam-store/test/prompt-contract.test.mjs # 提示词—工具契约：笔记别名、stage_code 白名单、六角色公共段落注入
node packages/redteam-tools/test/session-isolation.test.mjs # 会话隔离 / 资产发现时间 / 报告溯源 / 知识库归类 / 并发闸门 / 技能预检
node packages/redteam-ui/test/client-load.test.mjs        # 客户端 bundle 能加载：注册 id、导出契约、槽位挂载与卸载
node packages/redteam-tools/test/poc-tools.test.mjs   # 知识库工具：检索/回填/跨靶标共享/去重
node packages/redteam-tools/test/rule-tools.test.mjs  # 工具的规则输出：score_hit / tunnel_add / sessions
node packages/redteam-tools/test/tool-schema.test.mjs # 工具 schema 结构自检（含 DSH 官方校验器）
node packages/redteam-bundle/test/bundle.test.mjs     # 打包契约 / 泄露自检 / 首次启动自举 / 迁移脚本
```

> ⚠️ **改工具参数 schema 后务必跑 `tool-schema.test.mjs`**：DSH 在挂载预设时会校验每个工具的 schema，
> 一旦不合法（例如 `type: 'object'` 没写 `additionalProperties`），**整个预设 mount 失败**——该会话任何
> resume 都失败，客户端命令菜单会不停重试、每次重试都要整份解码会话日志，足以把 dsh 进程 CPU 打满、
> 界面卡住（v0.6.1 真出过这个事故，v0.6.2 修复并加了这道自检）。

### 7.1 部署到本机正在跑的那套（开发态）

**别用 `cp` 把打包预设拷进 `$DSH_HOME/.agent-presets/redteam/`** —— 打包模板里技能目录是
`{{REDTEAM_SKILLS_DIR}}` 占位符，只有 `installPreset()` 会把它替换成真实路径；直接 cp 会让 YAML
把它解析成对象，`skill-filesystem` 配置校验失败，**整个预设挂载失败 → 建不了会话、发消息就报错**
（v0.9.0 真实事故）。用这条命令走官方部署路径：

```bash
node scripts/deploy-local.mjs            # 生成 bundle → 同步 profile 的 lib/presets/skills → installPreset(force) 刷新预设
```

然后是**重启 dsh web**：

```bash
# 在**你自己的终端**里跑（不要在智能体工具调用里跑，见下面的坑）
setsid nohup bash scripts/restart-dsh-web.sh >> runs/restart-dsh-web.log 2>&1 &
```

> ⚠️ **重启不要从智能体的工具调用里发起**（v0.9.0 反复踩）：工具调用被中断/超时时，harness 会把它
> 所在的**整个进程组**一起收掉，`setsid` 出来的重启脚本也会跟着被杀 —— 表现就是"旧进程已经被杀、
> 新进程没起来、界面打不开"，得人工再跑一次。**让用户在自己的终端里执行**上面这条命令最稳。
> `scripts/restart-dsh-web.sh` 已做两道防呆：不给 PID 时自己从 3080 端口反查正在跑的实例（否则会再起
> 一个端口冲突的实例、日志写着"重启完成"其实代码没换）；旧进程退不干净、端口仍被占用时**直接放弃启动**
> 而不是硬起。
>
> 面板右上角的**「一键更新」按钮不受此限**：重启由 host 进程自己发起的（`process.exit` + 预置重启脚本），
> 不存在"发起方被中断"的问题。

> `deploy-local.mjs` 会同步 **`lib/` + `presets/` + `skills/`** 三处：`installPreset()` 是从**已安装包**的 `presets/` 读模板再落地的，只同步 `lib/` 会让它用上一次部署留下的旧预设覆盖用户预设（表现是「代码新的、人设旧的」，严重时把带占位符的坏预设写回去）。
>
> `installPreset()` 现在也会**自愈**已存在的坏预设：占位符残留、或技能目录指向已失效的旧包路径
> （换 npx 缓存 hash、重装 profile、源码包↔市场包互切都会造成），都会在下次启动时就地修好，
> 且只改技能目录那一行、不碰用户自己改的内容（回归测试：`bundle.test.mjs`）。

### 7.2 老数据补齐

改了数据结构后，把本机已有的靶标库与知识库一次性补齐（新列是按库懒加载补的，不开面板就一直旧结构）：

```bash
node scripts/migrate-v090.mjs --dry-run   # 只报告会动什么
node scripts/migrate-v090.mjs             # 补列 + 回填发现时间 + 老 POC 推归类
```

改了提示词源文件后，重新生成 `core.js` 里的提示词区段（幂等，可反复跑）：

```bash
node packages/redteam-store/tools/gen-prompts.mjs
```

**发版**：

```bash
cd packages/redteam-bundle
node tools/build.mjs --check && node test/bundle.test.mjs   # 也会由 prepublishOnly 自动跑
npm version patch && npm publish --access public            # 需要 npm 账号（本机 ~/.npmrc 里的 token）
git tag vX.Y.Z && git push origin main --tags
```

发完 npm 与 tag 后**别忘了建 GitHub Release**（说明写在 `docs/releases/vX.Y.Z.md`）：

```bash
bash scripts/release-notes.sh vX.Y.Z     # 需要 gh 登录（gh auth login）或 GH_TOKEN
bash scripts/release-notes.sh --check    # 只查哪些 tag 还没有 Release
```

> **只推 tag 不建 Release，Releases 页面是不会更新的**（v0.9.0/0.9.1/0.9.2 漏过一次）。
> 完整发版清单见 [`docs/marketplace.md`](docs/marketplace.md) 第 2 节末尾。

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
