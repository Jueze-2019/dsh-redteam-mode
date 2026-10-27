---
name: asset-correlation
description: 【侦察】资产关联：域名↔IP↔C 段↔证书↔服务的图谱化
whenToUse: 信息收集阶段性收口，需要形成资产关系视图时
role: recon
category: 侦察
tags: [asset, graph, c-segment]
enabled: true
---

## 关联规则
- 域名解析 → `resolves` 边（domain → asset）
- C 段归属 → `contains` 边（segment → asset）
- 端口开放 → `exposes` 边（asset → port）
- 证书 SAN 共享 → `shares_cert` 边

## C 段特征比对（找隐藏资产）
同一 /24 内，把已确认资产的 title、页脚版权/单位落款、ICP 备案号、favicon 哈希、证书 CN/SAN、开放端口组合逐个比对；命中相同特征但未被公开 DNS 解析的 IP，标为隐藏资产，`redteam_asset_add` 入库后在 `redteam_asset_test` 记一行线索。
- favicon 哈希可用 FOFA `icon_hash=` 反查，或从 httpx/浏览器结果里取同一图标哈希。
- 不要仅凭“同 C 段”认定归属；至少叠加一种特征（title / 备案 / 证书 / 页脚）。

## T0–T3 分级（防打偏）
| 级别 | 判定 | 动作 |
| --- | --- | --- |
| T0 直接归属 | ICP / WHOIS / 证书 CN/SAN / 页脚 / 单位落款明确属于靶标；官方主域名、官方 IP、官方 App 后端 | 优先收集、评估、攻击 |
| T1 强相关 | 控股子公司/分支机构/同一法人/同一注册人/同一证书主体/官方运维合同能证明 | 可打，reason 写证据 |
| T2 弱相关 | 同 C 段/同 ASN/同 IP 旁站/同 favicon/同标题/共享托管/CDN 邻居/供应商/测试环境/历史域名 | 只作线索；**T0/T1 穷尽且用户确认后**才评估攻击 |
| T3 无关 | 其他单位/个人/公共设施 | 不碰 |

- 同 C 段、同 favicon、同标题**只是线索**；同 ICP/证书/注册人的旁站应升级 T0，不是 T2。
- 分级写进 `redteam_asset_test` 的 `test`（`relatedness=T0|T1|T2|T3`）并附归属证据；
- 没有归属证据的资产默认按 T2 处理，不能直接打。

## 归属证明（得分资产必填）
每个得分资产至少一种：ICP 备案号、证书 CN/SAN、WHOIS 注册人、首页页脚版权/单位落款、系统登录页单位名称。
写进 `redteam_asset_test` 的 `test`（`归属证明：...`），并用 `redteam_shot_add` 留首页/备案截图；报告第一节据此判强弱。

## 落库要求
通过 redteam_asset_link 写入 edge 表；重复关系幂等。
