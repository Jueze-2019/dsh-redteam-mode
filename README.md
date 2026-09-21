# DSH RedTeam 模式

把 [DeepSeek Harness](https://github.com/deepseek-ai)（DSH）变成一台**红队作战指挥台**：
只发一个靶标单位名称，主会话拉起一支执行智能体团队（信息收集 → 资产梳理 → 漏洞发现 → 漏洞利用 → 内网渗透），
所有发现实时落进本机 SQLite 事实库，并在界面右侧栏的常驻控制台里可视化。

> ⚠️ **仅限已获授权的攻防演练 / 渗透测试使用。** 本仓库是智能体编排与事实库的工程实现，
> **不包含任何漏洞利用代码**；使用者须自行确保对目标拥有书面授权。

**53 个 `redteam_*` 工具 · 23 个原生技能 · 12 个控制台页签 · 22 张事实库表**

---

## 安装

```sh
dsh plugin --profile web add dsh-redteam-mode
```

装完**重启一次 `dsh web`**，在界面助手栏选预设 **红队模式**，直接发靶标单位名称即可开工。
首次启动会自动装好预设与 23 个原生技能，不需要手动拷文件。

**环境准备**（首次使用）：

```sh
bash "$DSH_HOME/redteam/setup.sh" --check   # 体检：缺什么一眼看清
bash "$DSH_HOME/redteam/setup.sh"           # 装齐工具 + 引导填 FOFA_KEY / VPS
```

> 前置：DSH 能正常 `dsh web` 启动；Node.js ≥ 22.13（依赖内置 `node:sqlite`）。
> 请跑在**专供演练的 Kali 虚拟机**里，不要跑在日常办公机/宿主机上。

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

细节见 [`docs/详细文档.md`](docs/详细文档.md) 第 7 章。
</details>

---

## 功能

- **一套角色分工**：主会话只做指挥（计划、派活、核对落库、汇报），动手的活全部委派给信息收集 /
  资产梳理 / 漏洞发现 / 漏洞利用 / 内网渗透五个执行角色，同一靶标**最多 3 个并发**。
- **开工前预检**：`redteam_preflight` 逐个技能体检，缺 key、缺 VPS、缺工具一次性说清，补不齐就说降级方案。
- **得分目标**：严格对齐《突破入侵类得分规则（合并版）》的 **8 类 25 项**；上限、权限取高只计一次、
  同一资产加端口只算一次全由服务端判定，自建账号不计分。
- **右侧常驻控制台**：资产测绘（带发现时间）/ 当前测试 / 会话隧道 / 智能体 / 漏洞战果 / 攻击链 /
  得分目标 / 报告 / 攻击文件 / 知识库 / 提示词 / 技能库，共 **12 个页签**，每个带未读红点。
- **报告可复现**：每条成果都写清动作步骤（含实际命令与回显）、凭据来源、隧道搭建命令；
  缺项标「复现链不完整」，不是悄悄放过。
- **技能库 23 个**：覆盖 FOFA 测绘、子域与端口流水线、nuclei、目录爆破、未授权、凭据攻击、
  反弹 Shell、suo5 / chisel / frp 隧道、内网横向，每个技能带**可用性判定**（缺什么直接点名）。
- **数据只在本机**：全部落在 `$DSH_HOME/redteam/`，无遥测、无上报、无云端同步。

面板右上角常驻**版本号 + 一键更新**（检测到有智能体在跑会拦住）。

完整说明、53 个工具清单、开发与发版流程见 [`docs/详细文档.md`](docs/详细文档.md)。

---

## 合规

面向**授权范围内**的安全评估：攻防演练、红蓝对抗、企业自检、教学研究。
未获授权的扫描、探测、入侵或数据获取均属违法，与本项目作者无关。MIT，见 [LICENSE](LICENSE)。
