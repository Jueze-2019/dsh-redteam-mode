---
name: active-scan
description: 主动端口与服务扫描（nmap/masscan），严格遵守授权范围
whenToUse: 需要确认资产存活与开放端口时
role: recon
enabled: true
---

## 前置检查
1. 确认目标 CIDR 在授权范围内。
2. 确认当前时间窗口允许主动扫描。

## 命令
- 快速存活：`nmap -sn <cidr>`
- 全端口（限速）：`nmap -sS -p- --min-rate 1000 -T4 <target> -oX runs/nmap-full.xml`
- 服务版本：`nmap -sV -sC -p <ports> <target> -oX runs/nmap-svc.xml`

## 落库要求
provenance = `active`，tool = `nmap`/`masscan`，记录 scan_run。
