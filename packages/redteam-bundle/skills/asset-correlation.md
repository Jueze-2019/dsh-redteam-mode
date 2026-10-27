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

## 归属证明（得分资产必填）
每个得分资产至少一种：ICP 备案号、证书 CN/SAN、WHOIS 注册人、首页页脚版权/单位落款、系统登录页单位名称。
写进 `redteam_asset_test` 的 `test`（`归属证明：...`），并用 `redteam_shot_add` 留首页/备案截图；报告第一节据此判强弱。

## 落库要求
通过 redteam_asset_link 写入 edge 表；重复关系幂等。
