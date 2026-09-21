/**
 * 旧得分口径 → 《突破入侵类得分规则（合并版）》的归类映射。
 *
 * 为什么单独一份：`restore-legacy-hits.mjs`（按存档恢复单靶标）与
 * `migrate-legacy-scores.mjs`（批量迁移未迁移过的靶标）必须用**同一套判定**，
 * 否则同一个成果在两个脚本下会被归到不同得分项、算出不同分数。
 *
 * 判定顺序：先按系统名（最准）→ 再退回旧 code 兜底。
 * 同一台 Cisco 设备在不同规则下归属完全不同（Expressway 是网络设备、
 * Unified CM 是集权/统一通信核心），所以具体产品名的规则必须排在泛化词之前。
 */
export const LEGACY_CODES = ['web-account-user', 'web-account-admin', 'webshell', 'rce',
  'server-shell', 'db-access', 'sensitive-data', 'boundary', 'internal-pivot', 'core-system']

/* ── 旧 code → 新 code 的兜底映射（证据里看不出更具体的系统类型时用它） ────────── */
const CODE_MAP = {
  'web-account-user': { code: 'web-app', points: 50 },
  'web-account-admin': { code: 'web-app', points: 100 },
  webshell: { code: 'server-host', points: 10 },
  rce: { code: 'server-host', points: 50 },
  'server-shell': { code: 'server-host', points: 50 },
  'db-access': { code: 'db-credential', points: 50 },
  'internal-pivot': { code: 'terminal-access', points: 10 },
  'core-system': { code: 'central-system', points: 500 },
  boundary: { code: 'boundary-logical', points: 1000 },
  'sensitive-data': { code: 'bigdata-system', points: 100 },
}

/**
 * 证据/目标 → 归属。**先按具体系统名判定**（最准），再退回关键词，最后按旧 code 兜底。
 *
 * 为什么以主机名为主：同一台 Cisco 设备在不同规则下归属完全不同 ——
 * Expressway 是"统一通信边界/VCS"、Unified CM 是"IP 电话核心"、
 * Meeting Server 是"视频会议媒体核心"，靠 "管理后台" 之类的泛词必然判错。
 */
const HOST_RULES = [
  /* ① 数据库：最优先 —— "经 suo5 登录 MariaDB" 这类描述里常混着别的系统名，先判库 */
  [/PostgreSQL|MariaDB|MySQL|Oracle|SQL Server|数据库备库|数据库权限|数据库账号/i,
    'db-credential', 50, '数据库账号（规则 4，管理员档）'],
  /* ② 明显的服务器主机权限：SSH/CLI/root/SYSTEM，以及 WebShell/RCE 落地的结果 */
  [/(^|[^\w])ssh\s|uid=0\(root\)|MMP CLI|命令行\/CLI 管理员|冰蝎|哥斯拉|WebShell|命令执行|上传 JSP|JSP.*被执/i,
    'server-host', 50, '服务器主机权限（规则 3，管理员档）'],
  /* ③ 网络设备：规则 9 */
  [/Expressway|\bVCS\b/i, 'netdev', 200, '统一通信边界设备 Expressway/VCS（网络设备，规则 9）'],
  /* ④ 核心通信/集权系统：规则 7 —— 具体产品名，放在泛化词之前 */
  [/Unified CM|CallManager|IP 电话核心|Cisco Meeting Server|\bCMS[_\s-]?\d|Meeting Management|统一通信|视频会议核心/i,
    'central-system', 500, '统一通信/视频会议核心与集权管理（规则 7，管理员档）'],
  /* ⑤ 办公与业务系统：规则 6 */
  [/itC 中心管理服务器|会议管理平台|管理服务器|管理平台|业务系统|\bOA\b|\bERP\b|网管/i,
    'web-app', 100, '办公/业务生产系统（规则 6，管理员档）'],
  /* ⑥ 终端设备：规则 2 —— 严格子串，避免被"会议管理平台"之类误命中 */
  [/itC 视频会议终端|会议终端管理后台|视频会议终端|t_res_v3/i,
    'terminal-access', 10, '视频会议终端（终端设备，按台 10 分）'],
]

/** 命中送进规则表，返回归属或 null。 */
function classify(pointCode, evidence, targetText) {
  const text = String(evidence || '') + ' ' + String(targetText || '')
  for (const [re, code, points, why] of HOST_RULES) {
    if (re.test(text)) return { code, points, why }
  }
  const fallback = CODE_MAP[pointCode]
  return fallback === undefined ? null : { ...fallback, why: '按旧 code 兜底映射' }
}


/** 把一条旧命中归类到新得分项。返回 `{code, points, why}`，无法归类返回 null。 */
export function classifyHit(pointCode, evidence, targetText) {
  const text = String(evidence || '') + ' ' + String(targetText || '')
  for (const [re, code, points, why] of HOST_RULES) {
    if (re.test(text)) return { code, points, why }
  }
  const fallback = CODE_MAP[pointCode]
  return fallback === undefined ? null : { ...fallback, why: '按旧 code 兜底映射' }
}
