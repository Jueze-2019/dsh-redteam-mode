---
name: redteam-setup
description: 【基础设施】首次使用引导：确认 FOFA_KEY、VPS 登录方式与 DeepSeek API Key 是否已提供，按 preflight 报告缺口；不提供工具下载、安装链接或教程，工具由用户自行准备
whenToUse: 用户第一次使用红队模式时；或 redteam_preflight 报出 onboarding.incomplete、缺环境变量/资源时
role: plan
category: 基础设施
tags: [setup, env]
enabled: true
---

# 首次使用引导

> **本插件不提供工具下载、安装链接或安装教程**。工具由用户自行准备；`redteam_preflight` 只报告缺什么，不代为下载、安装或给出获取地址。

## 触发

- `redteam_preflight` 返回 `onboarding.complete=false`；
- 缺 `FOFA_KEY`、VPS 登录方式、DeepSeek API Key；
- 用户明确说“环境没配好”。

## 需要用户提供

| 要什么 | 用途 | 给到哪 |
| --- | --- | --- |
| `FOFA_KEY` | 资产测绘；没有会漏掉边缘/未备案资产 | 环境变量 `FOFA_KEY` 或 `$DSH_HOME/.env` |
| VPS 登录方式 | 反弹 Shell、载荷投递、隧道中转 | `REDTEAM_VPS_HOST`（`user@host`）、`REDTEAM_VPS_KEY`（私钥路径） |
| `DEEPSEEK_API_KEY`（可选） | 公开情报检索/网页抓取 | 环境变量 `DEEPSEEK_API_KEY` |
| 其他测绘平台 key（可选） | 多源资产交叉验证 | 对应环境变量 |

一次性列清，等用户补齐；不要反复挤牙膏。

## 验证

```bash
# 只检查变量是否存在，不打印值
for k in FOFA_KEY DEEPSEEK_API_KEY REDTEAM_VPS_HOST REDTEAM_VPS_KEY; do
  [ -n "$(printenv "$k")" ] && echo "$k=set" || echo "$k=missing"
done
```

- 再跑一次 `redteam_preflight`，确认 `onboarding.complete=true`；
- 不提供工具安装命令、下载地址或教程；缺工具时只写 `needs`，由用户自行准备；
- 不要在命令、报告、evidence 里输出 key/私钥。

## 降级

- 没有 `FOFA_KEY`：只做被动收集/公开情报，资产覆盖会下降；
- 没有 VPS：不派需要反弹 Shell/隧道中转的任务；
- 没有 DeepSeek Key：`deepseek-web-intel` 不可用，其它技能不受影响；
- 缺工具：对应技能标记不可用，不要假装能跑。
