# DSH RedTeam 模式

把 [DeepSeek Harness](https://github.com/deepseek-ai)（DSH）改造成一台**红队作战指挥台**：
发给指挥智能体的全部输入只有**一个靶标单位名称**，它会自动拉起信息收集 → 漏洞检测 → 漏洞利用 → 内网渗透四个角色，
把资产、漏洞、凭据、攻击链实时落进本地 SQLite 事实库，并在界面右侧栏的常驻控制台里可视化。

> ⚠️ **仅限已获授权的攻防演练 / 渗透测试使用。**
> 本仓库是智能体编排与事实库的工程实现，**不包含任何漏洞利用代码**。
> 使用者必须自行确保对目标拥有书面授权；未经授权的扫描与入侵在绝大多数司法辖区都是违法行为。
> 作者不对任何滥用行为负责。

---

## 1. 它长什么样

```
用户：<靶标单位名称>
   │
   ├─ 指挥智能体（preset 人设）读取得分目标、把工作面拆给四个角色
   │     ├─ 信息收集  recon     ：域名/子域/C 段/端口/指纹/Web 标题/边界与隐藏资产
   │     ├─ 漏洞检测  vuln-scan ：Nday/1day 优先，逐条确认并落 http 证据
   │     ├─ 漏洞利用  exploit   ：拿账号、WebShell、RCE、数据库、getsell 后遍历功能点
   │     └─ 内网渗透  internal  ：凭据复用、横向移动、隧道代理、核心系统
   │
   └─ 每一次发现都必须落库（未落库的发现视为无效工作）
         ↓
   SQLite 事实库（18 张表 + FTS5 全文索引）
         ↓
   右侧栏控制台 8 个页签：资产测绘 / 漏洞战果 / 攻击链 / 得分目标 / 报告 / 攻击文件 / 智能体提示词 / 技能库
```

设计上的两个硬约束：

* **得分目标驱动**：所有提示词都围绕可计分的成果（Web 权限、WebShell、RCE、服务器权限、数据库、敏感信息、边界突破、横向、核心系统）组织，信息收集只作为手段而不是产出。
* **报告只输出成果漏洞**：报告页不列"信息收集"流水账、不列无利用价值的水洞，按 IP / URL / C 段分别成文、可展开收起。

## 2. 架构

DSH 的组合分两个平面，本项目的三个包严格按平面归位：

| 包 | 平面 | 职责 |
| --- | --- | --- |
| `dsh-redteam-store` | **host** | 数据核心。SQLite 事实库（`segment / asset / port / service / fingerprint / observation / edge / tag / vuln / credential / access_session / http_evidence / attack_step / attack_file / score_point / score_hit / scan_run / asset_name`），发布进程级服务 `ctx.redteam`，另有 JSON-in/out CLI 便于脱离界面调试。零外部依赖，只用 `node:` 内置模块。 |
| `dsh-redteam-tools` | **agent** | 31 个模型工具（`redteam_*`），把事实库和得分目标暴露给智能体；随 preset 挂载，每个会话一份。 |
| `dsh-redteam-ui` | **host + client** | 控制台。host 半侧注册 `POST /redteam/api` 桥接 `ctx.redteam`；浏览器半侧是常驻右侧栏 UI（不遮挡对话），含资产图谱、攻击链时间线、报告分组、得分面板、提示词编辑器和技能库浏览器。 |

其余组成部分：

* `preset/` —— DSH agent preset（人设 + 工具行 + 委派组），人设里写死了授权前提、得分目标、优先打什么、报告口径等工作纪律。
* `skills/` —— 10 个 DSH 原生技能（信息收集、指纹、代理池、隧道、WebShell、浏览器自动化、Kimi WebBridge 等），由 `skill` 工具按需加载。
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

### 3.4 重启

host 平面新增了服务与表结构，**必须重启** `dsh web`（客户端 UI 改动会自动热重载，host 改动不会）。
重启后在界面助手栏能看到「红队模式」预设，右侧栏出现 RedTeam 面板。

## 4. 使用

1. 新建会话，选择预设 **红队模式**。
2. 直接发靶标单位名称（有范围就补一句，例如某个 C 段）。
3. 剩下的交给它：资产测绘页签会实时长出数据，漏洞战果页签出现确认漏洞，攻击链按时间倒序/正序排列每次突破。
4. 报告页签按目标分组出报告，攻击文件页签按目标分目录保存真正有效的脚本 / POC / EXP。

## 5. 能力清单

**31 个工具**（节选）：

```
redteam_engagement_open          绑定本次演练靶标，创建工作区
redteam_asset_add/query/get/stats/graph/link/assess/test
                                 资产入库、查询、关联图谱、易打性评估、测试状态流转
redteam_domain_index             按域名维度聚合（域名 → 子域 → IP → C 段）
redteam_web_list                 Web 资产清单（URL + 标题，可点击）
redteam_vuln_add/query/update    漏洞记录与状态流转
redteam_http_evidence_add        原始 HTTP 证据（供报告复现）
redteam_credential_add/list      凭据线索（只存引用，不存明文口令）
redteam_access_add/list          已获得的访问会话
redteam_chain_add / redteam_chain       攻击链步骤
redteam_attack_path              攻击图谱（资产 → 漏洞 → 权限 → 内网）
redteam_attack_file_add/list     攻击文件归档（强制要求证据引用）
redteam_score_list / redteam_score_hit / redteam_score_point_save   得分目标与得分记录
redteam_role_prompt / redteam_roles     四个角色的当前系统提示词
redteam_report_targets / redteam_report 报告（按目标分组 / 汇总）
```

**默认得分点**（共 255 分，可在「得分目标」面板增删改）：

| 得分点 | 分值 | 得分点 | 分值 |
| --- | --- | --- | --- |
| 获取 Web 普通账号权限 | 10 | 获取数据库权限 | 25 |
| 获取 Web 管理员账号权限 | 20 | 获取大量敏感信息 | 20 |
| 上传 WebShell 并维持访问 | 20 | 互联网边界突破 | 30 |
| RCE / 命令执行 | 30 | 突破逻辑内网（横向移动） | 35 |
| 获取服务器权限 | 25 | 拿下核心系统 | 40 |

**控制台页签**：资产测绘（列表 + 图谱双视图）、漏洞战果、攻击链、得分目标、报告、攻击文件、智能体提示词、技能库。

## 6. 数据与隐私

* 所有演练数据只写在**本机** `$DSH_HOME/redteam/engagements/<靶标>/`：SQLite 事实库、`runs/` 证据、按目标分目录的攻击文件。本项目不含任何遥测、上报或云端同步代码。
* **口令与密钥只存引用**：`credential` 表落的是 `secret_ref`（指向 `runs/` 下的证据文件或凭据库条目），不存明文。
* 界面与工具的所有写操作都要求证据引用，避免"无证据的成果"。

## 7. 关于密钥

仓库里**不含任何真实密钥**。涉及外部 API 的技能一律从环境变量读取，例如 FOFA 测绘：

```bash
export FOFA_KEY=你的key       # skills/fofa-recon.md 里的客户端只读这个变量
```

如果你 fork 后要加自己的 key，请放进 `.env`（已被 `.gitignore` 忽略）或本机环境变量，不要提交。

## 8. 目录结构

```
.
├── packages/
│   ├── redteam-store/       # SQLite 事实库 + ctx.redteam 服务 + CLI
│   ├── redteam-tools/       # 31 个 redteam_* 模型工具
│   └── redteam-ui/          # 常驻右侧栏控制台（host 桥接 + 客户端 UI）
├── preset/                  # DSH agent preset（红队人设与工具行）
├── skills/                  # 10 个 DSH 原生技能
├── docs/                    # 环境配置记录（如 Kimi WebBridge 桥接）
└── redteam-proto/           # 原型脚本与演示数据（RFC 5737 文档地址）
```

## 9. 合规声明

本项目面向**授权范围内的安全评估**：攻防演练、红蓝对抗、企业自检、教学研究。

* 未获授权对任何系统进行扫描、探测、入侵或数据获取，均属违法，与本项目作者无关。
* 使用前请确认授权书、测试范围（资产清单 / 时间窗 / 允许的手段）与免责条款。
* 请遵守目标所在司法辖区的法律，以及 GitHub 的服务条款。

## 10. License

MIT，见 [LICENSE](LICENSE)。
