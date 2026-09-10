#!/usr/bin/env node
/**
 * 阶段 3 演示数据：漏洞 / 凭据 / 访问会话。
 *
 * 与 seed-demo.mjs 一样只使用 RFC 5737 文档保留网段，不对真实主机产生流量。
 * 直接调用数据核心，用于验证 vuln / credential / access 三条链路与攻击图谱。
 * 用法：node seed-findings.mjs
 */
import { join } from 'node:path'
import { homedir } from 'node:os'
import { RedteamStore } from '../packages/redteam-store/lib/core.js'

const ROOT = process.env.REDTEAM_HOME || join(process.env.DSH_HOME || join(homedir(), '.dsh'), 'redteam')
const ENGAGEMENT = process.env.REDTEAM_ENGAGEMENT || '示例科技有限公司'

const store = new RedteamStore(ROOT)
const assetIdByIp = new Map()
for (const asset of store.listAssets(ENGAGEMENT, { limit: 500 }).items) assetIdByIp.set(asset.ip, asset.id)

const assetId = (ip) => assetIdByIp.get(ip) ?? null

const VULNS = [
  {
    ip: '203.0.113.20',
    cve: 'CVE-2022-42475',
    title: 'FortiGate SSL-VPN 预认证堆溢出 RCE',
    severity: 'critical',
    status: 'candidate',
    target: 'https://vpn.example-corp.cn:443',
    source: 'nuclei',
    confidence: 0.6,
    evidence: '版本 7.0.0 落在受影响区间；未做利用验证',
    found_by_agent: 'vuln-scan',
  },
  {
    ip: '198.51.100.5',
    cve: 'CVE-2021-22893',
    title: 'Pulse Secure 认证绕过',
    severity: 'critical',
    status: 'confirmed',
    target: 'https://gw.example-corp.cn:443/dana-na/auth/url_default/welcome.cgi',
    source: 'nuclei',
    confidence: 0.9,
    evidence: '返回 200 且可访问受保护资源，已留存请求/响应于 runs/nuclei-pulse.txt',
    found_by_agent: 'vuln-scan',
  },
  {
    ip: '203.0.113.31',
    cve: 'CNVD-2021-01627',
    title: '致远OA A8 未授权 SQL 注入',
    severity: 'high',
    status: 'confirmed',
    target: 'https://erp.example-corp.cn/seeyon/htmlofficeservlet',
    source: 'nuclei',
    confidence: 0.85,
    evidence: '报错注入回显，sqlmap 二次确认',
    found_by_agent: 'vuln-scan',
  },
  {
    ip: '203.0.113.30',
    cve: 'CVE-2022-22965',
    title: 'Spring Boot Actuator 未授权信息泄露',
    severity: 'medium',
    status: 'confirmed',
    target: 'http://oa.example-corp.cn:8080/actuator/env',
    source: 'curl',
    confidence: 0.95,
    evidence: '/actuator/env 直接返回环境变量（含数据源连接串）',
    found_by_agent: 'vuln-scan',
  },
  {
    ip: '198.51.100.20',
    cve: null,
    title: 'VNC 弱口令（administrator）',
    severity: 'high',
    status: 'exploited',
    target: '198.51.100.20:5900',
    source: 'manual',
    confidence: 1,
    evidence: '使用字典命中，登录后取得桌面会话',
    found_by_agent: 'exploit',
  },
  {
    ip: '192.0.2.10',
    cve: null,
    title: 'MySQL 5.7 弱口令（root）',
    severity: 'high',
    status: 'candidate',
    target: '192.0.2.10:3306',
    source: 'manual',
    confidence: 0.5,
    evidence: '待验证（避免触发账户锁定，未做在线爆破）',
    found_by_agent: 'vuln-scan',
  },
]

for (const v of VULNS) {
  const result = store.addVuln(ENGAGEMENT, { ...v, asset_id: assetId(v.ip) })
  console.log('vuln', v.ip, v.cve || v.title, '->', JSON.stringify(result))
}

store.addCredential(ENGAGEMENT, {
  asset_id: assetId('198.51.100.20'),
  host: '198.51.100.20',
  username: 'administrator',
  secret_type: 'password',
  secret_ref: 'runs/cred-vnc-198.51.100.20.txt',
  privilege: 'admin',
  source: 'exploit',
  tool: 'vncviewer',
  note: '弱口令，明文存于 runs/ 证据文件，不写入数据库',
  found_by_agent: 'exploit',
})
store.addCredential(ENGAGEMENT, {
  asset_id: assetId('203.0.113.30'),
  host: 'oa.example-corp.cn',
  username: 'spring.datasource.username',
  secret_type: 'connection-string',
  secret_ref: 'runs/actuator-env-oa.json',
  privilege: 'db-read',
  source: 'vuln-scan',
  tool: 'curl',
  note: '来自 Actuator /env 泄露的连接串',
  found_by_agent: 'vuln-scan',
})

store.addAccess(ENGAGEMENT, {
  asset_id: assetId('198.51.100.20'),
  host: '198.51.100.20',
  username: 'administrator',
  method: 'vnc',
  privilege: 'admin',
  session_ref: 'runs/session-vnc-198.51.100.20.md',
  note: '已取得桌面会话，可作为横向移动入口',
  found_by_agent: 'exploit',
})

/* ---- HTTP 证据（报告里渲染成可直接粘贴进 Burp/Yakit 的原始报文） ---- */
const vulnIdByCve = new Map()
for (const v of store.listVulns(ENGAGEMENT, { limit: 100 }).items) if (v.cve) vulnIdByCve.set(v.cve, v.id)

store.addHttpEvidence(ENGAGEMENT, {
  vuln_id: vulnIdByCve.get('CVE-2021-22893') ?? null,
  asset_id: assetId('198.51.100.5'),
  label: 'Pulse Secure 认证绕过 — 直接访问受保护资源',
  method: 'GET',
  url: 'https://gw.example-corp.cn/dana-na/auth/url_default/welcome.cgi',
  status: 200,
  request: [
    'GET /dana-na/auth/url_default/welcome.cgi HTTP/1.1',
    'Host: gw.example-corp.cn',
    'User-Agent: Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36',
    'Accept: */*',
    'Connection: close',
    '',
  ].join('\n'),
  response: [
    'HTTP/1.1 200 OK',
    'Server: Pulse Secure',
    'Content-Type: text/html; charset=utf-8',
    '',
    '<html>...受保护的用户门户内容（未携带任何 Cookie 即返回）...</html>',
  ].join('\n'),
  note: '未认证直接返回用户门户，说明存在认证绕过',
  captured_by: 'vuln-scan',
})

store.addHttpEvidence(ENGAGEMENT, {
  vuln_id: vulnIdByCve.get('CVE-2022-22965') ?? null,
  asset_id: assetId('203.0.113.30'),
  label: 'Actuator /env 未授权读取（泄露数据源连接串）',
  method: 'GET',
  url: 'http://oa.example-corp.cn:8080/actuator/env',
  status: 200,
  request: [
    'GET /actuator/env HTTP/1.1',
    'Host: oa.example-corp.cn:8080',
    'User-Agent: curl/8.5.0',
    'Accept: */*',
    '',
  ].join('\n'),
  response: [
    'HTTP/1.1 200 OK',
    'Content-Type: application/vnd.spring-boot.actuator.v3+json',
    '',
    '{"activeProfiles":["prod"],"propertySources":[{"name":"applicationConfig",',
    ' "properties":{"spring.datasource.url":{"value":"jdbc:mysql://192.0.2.10:3306/oa"},',
    ' "spring.datasource.username":{"value":"oa_rw"}}}]}',
  ].join('\n'),
  note: '未认证即可读取环境变量，含数据库连接串',
  captured_by: 'vuln-scan',
})

/* ---- 攻击链（页面与报告按 seq 排序展示） ---- */
const steps = [
  { stage: 'recon', title: '被动信息收集：证书透明 + DNS 得到 3 个 C 段与 10 个域名', detail: 'crt.sh / dig / whois；产出 14 个资产、22 个开放端口', recorded_by: 'recon' },
  { stage: 'recon', title: '主动扫描确认 Web 资产与标题', detail: 'nmap + curl 取 URL/标题；发现 VPN、OA、邮件、ERP 等入口', recorded_by: 'recon' },
  { stage: 'vuln', title: '接口与组件指纹比对发现 2 个严重漏洞', cve: 'CVE-2021-22893', detail: 'Pulse Secure 认证绕过；FortiGate SSL-VPN 预认证 RCE（待验证）', recorded_by: 'vuln-scan' },
  { stage: 'vuln', title: 'Actuator 未授权泄露数据库连接串', cve: 'CVE-2022-22965', detail: 'jdbc:mysql://192.0.2.10:3306/oa（账号 oa_rw）', recorded_by: 'vuln-scan' },
  { stage: 'exploit', title: '利用 VNC 弱口令拿到 198.51.100.20 桌面会话', detail: 'administrator / 弱口令；已记录凭据引用', recorded_by: 'exploit' },
  { stage: 'access', title: '建立访问会话并落地证据', detail: 'runs/session-vnc-198.51.100.20.md', recorded_by: 'exploit' },
  { stage: 'pivot', title: '（待推进）suo5 隧道进入生产网 192.0.2.0/24', detail: '隧道端点与本地端口记录后继续横向', recorded_by: 'internal' },
]
for (const s of steps) {
  store.addChainStep(ENGAGEMENT, {
    ...s,
    vuln_id: s.cve ? (vulnIdByCve.get(s.cve) ?? null) : null,
    asset_id: s.stage === 'exploit' || s.stage === 'access' ? assetId('198.51.100.20') : null,
  })
}

console.log('--- 统计 ---')
console.log(JSON.stringify(store.stats(ENGAGEMENT)))
console.log('--- 攻击链 ---')
console.log(store.listChain(ENGAGEMENT).map((s) => s.seq + '. [' + s.stage + '] ' + s.title).join('\n'))
console.log('--- 报告体积 ---')
console.log(store.report(ENGAGEMENT).markdown.length, 'bytes')
console.log('--- 漏洞统计 ---')
console.log(JSON.stringify(store.vulnStats(ENGAGEMENT)))
console.log('--- 攻击图谱 ---')
const graph = store.attackGraph(ENGAGEMENT)
console.log('nodes', graph.nodes.length, 'edges', graph.edges.length, 'summary', JSON.stringify(graph.summary))
console.log('owned assets:', graph.nodes.filter((n) => n.meta && n.meta.owned).map((n) => n.label).join(', ') || '(none)')
console.log('vuln nodes:', graph.nodes.filter((n) => n.kind === 'vuln').map((n) => n.label + '(' + n.meta.severity + ')').join(', '))
store.close()
