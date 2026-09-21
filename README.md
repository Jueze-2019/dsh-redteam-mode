# DSH RedTeam 模式

把 [DeepSeek Harness](https://github.com/deepseek-ai)（DSH）变成一台**红队作战指挥台**：
只发一个靶标单位名称，主会话拉起一支执行智能体团队（信息收集 → 资产梳理 → 漏洞发现 → 漏洞利用 → 内网渗透），
所有发现实时落进本机 SQLite 事实库，并在界面右侧栏的常驻控制台里可视化。

> ⚠️ **仅限已获授权的攻防演练 / 渗透测试使用。** 本仓库是智能体编排与事实库的工程实现，
> **不包含任何漏洞利用代码**。使用者必须自行确保对目标拥有书面授权；未获授权的扫描与入侵在绝大多数
> 司法辖区都是违法行为。作者不对任何滥用行为负责。

**53 个 `redteam_*` 工具 · 23 个原生技能 · 12 个控制台页签 · 22 张事实库表**

---

## 安装

```sh
dsh plugin --profile web add dsh-redteam-mode
```

装完**重启一次 `dsh web`**，在界面助手栏选择预设 **红队模式**，然后直接发靶标单位名称即可开工。
首次启动会自动把预设装到 `$DSH_HOME/.agent-presets/redteam/` 并注册 23 个原生技能，不需要手动拷任何文件。

**环境准备**（首次使用，一条命令）：

```sh
bash "$DSH_HOME/redteam/setup.sh" --check   # 体检：10 秒看清缺什么
bash "$DSH_HOME/redteam/setup.sh"           # 交互式：缺啥装啥 + 引导填 FOFA_KEY / VPS
```

脚本随包分发、幂等可重跑、零依赖、不擅自 `sudo apt`，只写 `$DSH_HOME/redteam/toolkit/` 与 `$DSH_HOME/.env`。
进红队模式后其实不用手动跑：指挥智能体的第一个动作 `redteam_preflight` 会返回 `onboarding` 状态，
首次使用会把缺口一次性列给你并引导补齐。

**前置**：DSH 能正常 `dsh web` 启动；Node.js ≥ 22.13（依赖内置 `node:sqlite`，会打印 ExperimentalWarning，属正常）。

> ⚠️ **请跑在专供演练的 Kali 虚拟机里，不要跑在日常办公电脑/宿主机上。** 本模式会真实发包、
> 上传 WebShell、建立隧道，本机还会存放 VPS 私钥与各类马；演练结束直接丢弃虚拟机最干净。

<details>
<summary>从源码装（开发者）</summary>

```bash
PROFILE=~/.dsh/profiles/web
mkdir -p "$PROFILE/node_modules"
for p in redteam-store redteam-tools redteam-ui; do
  ln -sfn "$PWD/packages/$p" "$PROFILE/node_modules/dsh-$p"
done
mkdir -p ~/.dsh/.agent-presets/redteam ~/.dsh/skills
cp preset/agent.cordis.yml preset/preset.yml ~/.dsh/.agent-presets/redteam/
cp skills/*.md ~/.dsh/skills/
```

细节（profile 补丁行、依赖软链、部署与重启脚本、发版流程）见 [`docs/详细文档.md`](docs/详细文档.md) 第 7 章。
</details>

---

## 功能

### 指挥与执行

- **六个角色**：主会话只做指挥（计划任务、派子智能体、核对落库、汇报），动手的活全部委派给
  信息收集 / 资产梳理 / 漏洞发现 / 漏洞利用 / 内网渗透五个执行角色。
- **并发闸门**：同一靶标**最多 3 个**执行智能体同时跑，实时看名额与谁在跑。
- **开工前预检**：`redteam_preflight` 逐个技能体检（文件 / 环境变量 / 本机二进制 / 基础设施），
  缺 key、缺 VPS、缺工具一次性说清，补不齐就说明降级方案，不假装能跑。

### 得分目标（严格对齐《突破入侵类得分规则（合并版）》）

- **8 个类别、25 个得分点**：一般系统 / Web 应用 / 集权系统 / 大数据系统 / 网络基础设施 /
  文件存储 / 模型与算力 / 突破网络边界。
- **口径由服务端判定**：累计上限、权限取高只计一次、同一资产+端口只算一次；
  超出上限或重复的命中标「不计分」并给出原因（把它当停止信号）。
- **自建账号不计分**：自己注册的账号只留痕，不占上限、不进报告。
- 内置得分点的分值/上限/口径随规则锁定；要自定义分值只能**新增**得分点。

### 右侧常驻控制台（12 个页签）

| 页签 | 看什么 |
| --- | --- |
| 资产测绘 | C 段按内网/外网分组；每条带**发现时间**；易打性评估与测试状态 |
| 当前测试 | 正在测的资产与状态流转 |
| 会话隧道 | WebShell / 隧道在线状态、一键实测连通性、**是否跨越靶标边界** |
| 智能体 | 并发名额、六角色职责、按角色看提示词 |
| 漏洞战果 | 按严重级排序，详情直接渲染可复现的原始 HTTP 请求/响应 |
| 攻击链 | 五阶段推进与累计得分，边界突破只列真正跨越边界的通道 |
| 得分目标 | 按规则分组展示命中、上限与「不计分」原因 |
| 报告 | 攻击得分链路复现报告（见下） |
| 攻击文件 | 按目标文件夹组织，只收录实际生效的脚本/POC/EXP |
| 知识库 | 跨靶标 POC/EXP（14 类归类）+ 本机 nuclei 模板库，一次搜两层 |
| 智能体提示词 | 按角色编辑，可一键恢复内置最新版 |
| 技能库 | 每个技能带**可用性状态**，缺哪个 key / 二进制 / VPS 直接点名 |

面板右上角常驻**版本号 + 一键更新**（检测到有智能体在跑会拦住，不打断作业）。

### 报告可复现

每条得分成果都写清「这一步怎么来的」：动作步骤（谁做的、为什么、**实际命令**、回显）、
凭据来源、隧道搭建命令、WebShell 连接要素；缺项会标**「复现链不完整」并列出缺口**，
而不是悄悄放过。每条附可粘进 Yakit 的原始请求，自建账号与「同服务重复命中」整条剔除。

### 技能库（23 个，全部对应本机真实二进制）

| 角色 | 技能 |
| --- | --- |
| 信息收集 | `fofa-recon` `passive-recon` `recon-pipeline` `active-scan` `web-fingerprint` `asset-correlation` `browser-automation` `kimi-webbridge` `cn-proxy-pool` |
| 漏洞发现 | `nuclei-scan` `dir-bruteforce` `unauth-exploit` |
| 漏洞利用 | `webshell-toolkit` `credential-attack` `shell-handler` `vps-reverse-shell` |
| 内网渗透 | `gogo-intranet` `fscan-intranet` `suo5-tunnel` `chisel-tunnel` `frp-tunnel` `lateral-movement` |
| 引导 | `redteam-setup` |

### 模型工具（53 个 `redteam_*`）

资产 / 端口 / 服务 / 指纹 / 漏洞 / 凭据 / 会话 / 隧道 / 攻击链 / 得分 / 报告 / 知识库全覆盖。
完整清单见 [`docs/详细文档.md`](docs/详细文档.md) 第 3.5 节。

### 数据与隐私

- 全部数据只写本机 `$DSH_HOME/redteam/`：无遥测、无上报、无云端同步。
- **凭据明文入库但只在本机**（面板直显便于复用）；这个库文件是最高敏感度资产，
  不要复制、导出或提交到任何仓库/聊天工具。
- 仓库不含任何真实密钥或基础设施地址；自己的 key 放 `$DSH_HOME/.env`（`chmod 600`）。

---

## 合规

本项目面向**授权范围内**的安全评估：攻防演练、红蓝对抗、企业自检、教学研究。
使用前请确认授权书、测试范围（资产清单 / 时间窗 / 允许的手段）与免责条款；
未获授权的扫描、探测、入侵或数据获取均属违法，与本项目作者无关。

MIT，见 [LICENSE](LICENSE)。
