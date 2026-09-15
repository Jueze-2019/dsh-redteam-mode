/**
 * RedTeam 智能体工具集（preset 平面）
 *
 * 这些行只向 `tools` 注册模型可见工具，自身不发布任何服务，因此不需要 isolate realm；
 * 它们解析的是 host 平面的 `ctx.redteam`（dsh-redteam-store 发布的进程级实例）。
 *
 * 设计约定：
 *   · 写入一律走 redteam_asset_add / redteam_asset_link，智能体不直接碰 SQL；
 *   · 每次发现都带 provenance（passive|active）与 tool，保证界面上的来源标注可信；
 *   · 靶标按会话绑定：redteam_engagement_open 记住本次会话的靶标，其余工具默认沿用。
 */
import { defineTool } from '@deepseek-ai/dsh-tools'
import { ROLE_TITLES } from './store-core.js'

/** Cordis 插件名。 */
export const name = 'redteam-tools'

/** 硬依赖：资产库服务 + 工具注册表。 */
export const inject = ['redteam', 'tools']

/** sessionId → engagementId 绑定（一次会话内稳定；进程重启后由 agent 重新绑定）。 */
const bindings = new Map()

/** 从工具执行上下文取出调用方会话 id。 */
function sessionOf(exec) {
  const agent = exec && exec.agent
  const session = agent && agent.session
  return session && session.id !== undefined ? String(session.id) : undefined
}

/** 解析本次调用应作用在哪个靶标上。 */
function resolveEngagement(store, exec, explicit) {
  if (typeof explicit === 'string' && explicit.length > 0) return explicit
  const key = sessionOf(exec)
  if (key !== undefined && bindings.has(key)) return bindings.get(key)
  /* 子智能体是另一个会话，没有本会话绑定：跟随「当前靶标」指针
     （由 redteam_engagement_open / 界面切换写入），这样委派出去的角色
     不必每次都手传靶标 id。 */
  if (typeof store.activeEngagementId === 'function') {
    const active = store.activeEngagementId()
    if (active !== undefined) return active
  }
  const list = store.listEngagements()
  if (list.length === 1) return list[0].id
  throw new Error('尚未绑定靶标：请先调用 redteam_engagement_open 传入靶标单位名称')
}

/** 把一行资产压成模型可读的紧凑结构（避免把整库原始数据塞进上下文）。 */
function compactAsset(a) {
  return {
    id: a.id,
    ip: a.ip,
    segment: a.segment_cidr,
    state: a.state,
    name: a.primary_name,
    names: a.names.map((n) => n.name),
    ports: a.ports.filter((p) => p.state === 'open')
      .map((p) => p.port + '/' + p.proto + (p.service ? ' ' + [p.service, p.product, p.version].filter(Boolean).join(' ') : '') + ' [' + p.provenance + ']'),
    fingerprints: a.fingerprints.map((f) => [f.category, f.vendor, f.product, f.version].filter(Boolean).join(' ') + ' [' + f.provenance + ']'),
    passive: a.passive,
    active: a.active,
    first_seen: a.first_seen,
    last_seen: a.last_seen,
  }
}

const text = (value) => [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value, null, 2) }]

/**
 * @param ctx - 插件上下文。
 */
export function apply(ctx) {
  const store = ctx.redteam

  ctx.tools.register(defineTool({
    name: 'redteam_engagement_open',
    description: '打开或创建一次攻防演练靶标（按单位名称），并把当前会话绑定到该靶标。后续所有资产工具默认作用于它。若靶标已存在则直接复用其资产库。',
    parameters: {
      target: { type: 'string', required: true, description: '靶标单位名称，例如「示例科技有限公司」' },
      scope: {
        type: 'array',
        description: '授权范围 CIDR 列表（强烈建议显式给出；未给则沿用既有范围）',
        items: { type: 'string' },
      },
    },
    output: { schema: { type: 'string' }, render: (_args, value) => text(value) },
    async execute(args, exec) {
      const engagement = store.openEngagement(args.target, args.scope)
      const key = sessionOf(exec)
      if (key !== undefined) bindings.set(key, engagement.id)
      return JSON.stringify({
        ok: true,
        engagement,
        stats: store.stats(engagement.id),
        note: '已绑定到当前会话；请确认授权范围后再发起主动探测。',
      }, null, 2)
    },
  }))

  ctx.tools.register(defineTool({
    name: 'redteam_asset_add',
    description: '把一个资产及其端口/服务/指纹写入资产库（幂等 upsert）。每条发现必须标注 provenance：被动收集填 passive，主动探测填 active，并填写 tool（数据源或工具名）。',
    parameters: {
      engagement: { type: 'string', description: '靶标 id；省略则用当前会话绑定的靶标' },
      ip: { type: 'string', required: true, description: '资产 IP（IPv4）' },
      state: { type: 'string', description: 'live | dead | unknown，默认 unknown' },
      primary_name: { type: 'string', description: '主域名/主机名' },
      provenance: { type: 'string', required: true, enum: ['passive', 'active'], description: '本条发现的来源：被动或主动' },
      tool: { type: 'string', description: '数据源或工具名，例如 crt.sh / nmap / nuclei / curl' },
      names: {
        type: 'array',
        description: '该资产关联的域名/证书名',
        items: {
          type: 'object',
          additionalProperties: false,
          properties: {
            name: { type: 'string', required: true },
            kind: { type: 'string', description: 'domain | hostname | cert_cn，默认 domain' },
            provenance: { type: 'string', enum: ['passive', 'active'] },
          },
        },
      },
      ports: {
        type: 'array',
        description: '开放端口及其服务/指纹',
        items: {
          type: 'object',
          additionalProperties: false,
          properties: {
            port: { type: 'number', required: true },
            proto: { type: 'string', description: 'tcp（默认）| udp' },
            service: { type: 'string', description: '服务名，例如 http / mysql' },
            product: { type: 'string', description: '产品名，例如 nginx' },
            version: { type: 'string', description: '版本，例如 1.24.0' },
            banner: { type: 'string', description: '原始 banner 片段' },
            url: { type: 'string', description: 'Web 服务可直接访问的完整 URL，例如 https://oa.example.com:8443/portal' },
            title: { type: 'string', description: 'Web 页面标题（HTTP 探测获取），例如「致远OA 登录」' },
            provenance: { type: 'string', enum: ['passive', 'active'] },
            tool: { type: 'string' },
            fingerprints: {
              type: 'array',
              items: {
                type: 'object',
                additionalProperties: false,
                properties: {
                  category: { type: 'string', description: 'Web服务器 | 中间件 | 框架 | CMS | 数据库 | VPN网关 …' },
                  vendor: { type: 'string' },
                  product: { type: 'string' },
                  version: { type: 'string' },
                  evidence: { type: 'string', description: '判定依据，例如响应头 / 路径 / banner' },
                  confidence: { type: 'number', description: '0–1' },
                },
              },
            },
          },
        },
      },
    },
    output: { schema: { type: 'string' }, render: (_args, value) => text(value) },
    async execute(args, exec) {
      const id = resolveEngagement(store, exec, args.engagement)
      const asset = {
        ip: args.ip, state: args.state, primary_name: args.primary_name,
        provenance: args.provenance, tool: args.tool,
        names: args.names, ports: args.ports,
      }
      const result = store.importBundle(id, { scan: { tool: args.tool, argv: ['redteam_asset_add'] }, assets: [asset] })
      const written = store.listAssets(id, { ip: args.ip, limit: 1 }).items[0]
      return JSON.stringify({ ok: true, engagement: id, counts: result.counts, asset: written ? compactAsset(written) : null }, null, 2)
    },
  }))

  ctx.tools.register(defineTool({
    name: 'redteam_asset_link',
    description: '在资产库中写入一条关系边（图谱与后续横向分析共用）。relation 例如 resolves / exposes / contains / trusts / shares_cert。',
    parameters: {
      engagement: { type: 'string' },
      src_kind: { type: 'string', required: true, description: 'segment | asset | domain | port …' },
      src_id: { type: 'string', required: true },
      dst_kind: { type: 'string', required: true },
      dst_id: { type: 'string', required: true },
      relation: { type: 'string', required: true },
      confidence: { type: 'number' },
    },
    output: { schema: { type: 'string' }, render: (_args, value) => text(value) },
    async execute(args, exec) {
      const id = resolveEngagement(store, exec, args.engagement)
      const result = store.importBundle(id, {
        edges: [{
          src_kind: args.src_kind, src_id: args.src_id,
          dst_kind: args.dst_kind, dst_id: args.dst_id,
          relation: args.relation, confidence: args.confidence,
        }],
      })
      return JSON.stringify({ ok: true, edges: result.counts.edges }, null, 2)
    },
  }))

  ctx.tools.register(defineTool({
    name: 'redteam_asset_query',
    description: '检索资产库。支持按 C 段、端口、服务、指纹、来源、内外网维度（scope）、排序（sort）、关键词（全文，覆盖 IP/域名/banner/服务/指纹）过滤。返回紧凑结果，含每个资产的开放端口与指纹及内外网归属。',
    parameters: {
      engagement: { type: 'string' },
      cidr: { type: 'string', description: 'C 段，例如 203.0.113.0/24' },
      port: { type: 'number', description: '开放端口' },
      service: { type: 'string', description: '服务/产品名关键词，例如 nginx' },
      fingerprint: { type: 'string', description: '指纹关键词，例如 Tomcat / Spring' },
      provenance: { type: 'string', enum: ['passive', 'active'], description: '只看被动或主动来源' },
      q: { type: 'string', description: '全文检索词（空格分隔多词为 AND）' },
      state: { type: 'string', enum: ['live', 'dead', 'unknown'] },
      scope: { type: 'string', enum: ['internal', 'external'], description: '内外网维度：internal=内网/私网地址，external=互联网可达' },
      sort: { type: 'string', enum: ['priority', 'todo', 'ports', 'ip'], description: '排序：priority=易打性优先（默认），todo=待测优先，ports=端口多优先，ip=按 IP' },
      limit: { type: 'number', description: '返回条数上限，默认 50，最大 200' },
    },
    output: { schema: { type: 'string' }, render: (_args, value) => text(value) },
    async execute(args, exec) {
      const id = resolveEngagement(store, exec, args.engagement)
      const limit = Math.min(Number(args.limit) || 50, 200)
      const result = store.listAssets(id, {
        cidr: args.cidr, port: args.port, service: args.service,
        fingerprint: args.fingerprint, provenance: args.provenance,
        q: args.q, state: args.state, scope: args.scope, sort: args.sort, limit,
      })
      return JSON.stringify({
        ok: true, engagement: id, total: result.total, returned: result.items.length,
        items: result.items.map(compactAsset),
      }, null, 2)
    },
  }))

  ctx.tools.register(defineTool({
    name: 'redteam_asset_get',
    description: '取单个资产的完整详情：全部端口与服务、指纹、采集溯源时间线、关系边。用于深入分析某个目标。',
    parameters: {
      engagement: { type: 'string' },
      id: { type: 'number', required: true, description: '资产 id（来自 redteam_asset_query 结果）' },
    },
    output: { schema: { type: 'string' }, render: (_args, value) => text(value) },
    async execute(args, exec) {
      const id = resolveEngagement(store, exec, args.engagement)
      const asset = store.getAsset(id, args.id)
      if (asset === undefined) return JSON.stringify({ ok: false, error: 'asset not found' })
      return JSON.stringify({ ok: true, asset }, null, 2)
    },
  }))

  ctx.tools.register(defineTool({
    name: 'redteam_asset_stats',
    description: '资产测绘概览：C 段数、资产数（存活）、开放端口、服务、指纹、被动/主动溯源条数，以及各 C 段的明细。',
    parameters: { engagement: { type: 'string' } },
    output: { schema: { type: 'string' }, render: (_args, value) => text(value) },
    async execute(args, exec) {
      const id = resolveEngagement(store, exec, args.engagement)
      return JSON.stringify({ ok: true, engagement: id, stats: store.stats(id), segments: store.listSegments(id) }, null, 2)
    },
  }))

  ctx.tools.register(defineTool({
    name: 'redteam_asset_graph',
    description: '导出资产图谱（C 段 → 资产 → 开放端口，含域名解析边），用于拓扑推理与横向移动路径规划。节点数超过上限时按 C 段缩小范围。',
    parameters: {
      engagement: { type: 'string' },
      cidr: { type: 'string', description: '只取某个 C 段的子图' },
      maxNodes: { type: 'number', description: '节点上限，默认 300' },
    },
    output: { schema: { type: 'string' }, render: (_args, value) => text(value) },
    async execute(args, exec) {
      const id = resolveEngagement(store, exec, args.engagement)
      const maxNodes = Math.min(Number(args.maxNodes) || 300, 1000)
      const graph = store.graph(id, { cidr: args.cidr })
      if (graph.nodes.length > maxNodes) {
        return JSON.stringify({
          ok: false,
          error: '图谱节点过多（' + graph.nodes.length + ' > ' + maxNodes + '），请指定 cidr 缩小范围',
          segments: store.listSegments(id).map((s) => ({ cidr: s.cidr, assets: s.assets })),
        }, null, 2)
      }
      return JSON.stringify({ ok: true, engagement: id, nodes: graph.nodes, edges: graph.edges }, null, 2)
    },
  }))

  ctx.tools.register(defineTool({
    name: 'redteam_role_prompt',
    description: '取出某个红队角色（信息收集/漏洞检测/漏洞利用/内网渗透）当前生效的系统提示词。委派子智能体时，把该提示词作为角色约束放进任务描述。',
    parameters: {
      engagement: { type: 'string' },
      role: { type: 'string', required: true, enum: ['recon', 'vuln-scan', 'exploit', 'internal'] },
    },
    output: { schema: { type: 'string' }, render: (_args, value) => text(value) },
    async execute(args, exec) {
      const id = resolveEngagement(store, exec, args.engagement)
      const found = store.listPrompts(id).find((p) => p.role === args.role)
      if (found === undefined) return JSON.stringify({ ok: false, error: 'unknown role' })
      return JSON.stringify({
        ok: true, role: found.role, title: found.title,
        updated_at: found.updated_at, prompt: found.content,
      }, null, 2)
    },
  }))

  ctx.tools.register(defineTool({
    name: 'redteam_roles',
    description: '列出红队角色及其职责标题（信息收集 / 漏洞检测 / 漏洞利用 / 内网渗透）。',
    parameters: {},
    output: { schema: { type: 'string' }, render: (_args, value) => text(value) },
    async execute() {
      return JSON.stringify({
        ok: true,
        roles: Object.entries(ROLE_TITLES).map(([role, title]) => ({ role, title })),
      }, null, 2)
    },
  }))

  ctx.tools.register(defineTool({
    name: 'redteam_asset_test',
    description: '记录对某个资产的测试情况：本次做了什么测试（`test`，追加式）、还剩什么攻击面（`surface`，覆盖式）、当前测试状态、是否被 WAF 封禁。**每个资产开始测之前先调一次（status=testing），测完/放弃再调一次**——资产测绘页面据此显示「未测试 / 测试中 / 已测试 / 被封禁 / 已放弃 / 无攻击面」。排除结论、登录失败原因、重测理由都写在 `test` 里。',
    parameters: {
      engagement: { type: 'string' },
      asset_id: { type: 'number', description: '资产 id（与 ip 二选一，优先 asset_id）' },
      ip: { type: 'string', description: '资产 IP' },
      status: { type: 'string', enum: ['untested', 'testing', 'tested', 'blocked', 'abandoned', 'no_surface'], description: '测试状态：未测试/测试中/已测试/被封禁/已放弃/无攻击面' },
      test: { type: 'string', description: '本次做了什么测试（**追加**到测试记录，例如「nmap 全端口 + nuclei cve 模板 + 接口越权」）。排除结论、登录失败原因、重测理由都写这里。' },
      notes: { type: 'string', description: 'test 的兼容别名（老提示词里的写法），效果与 test 相同，会一并追加到测试记录。' },
      surface: { type: 'string', description: '还剩什么攻击面可测（覆盖式，例如「SMB 445 未测；Web /api 未做越权」）' },
      blocked: { type: 'boolean', description: '本次是否被 WAF/防护封禁（true 时封禁计数 +1）' },
      updated_by: { type: 'string', description: '记录角色，例如 recon / vuln-scan' },
    },
    output: { schema: { type: 'string' }, render: (_args, value) => text(value) },
    async execute(args, exec) {
      const id = resolveEngagement(store, exec, args.engagement)
      const result = store.updateAssetTest(id, { ...args, engagement: undefined })
      return JSON.stringify({ ok: true, engagement: id, ...result }, null, 2)
    },
  }))

  /* ================================================================== 漏洞检测 */

  ctx.tools.register(defineTool({
    name: 'redteam_vuln_add',
    description: '记录一条漏洞发现（漏洞检测角色）。带 cve 时按 (asset_id, cve, target) 幂等更新。severity：critical|high|medium|low|info；status：candidate（待验证）|confirmed（已验证）|false-positive|exploited|fixed。必须附证据（请求/响应片段、复现命令、证据文件路径）。',
    parameters: {
      engagement: { type: 'string' },
      asset_id: { type: 'number', description: '资产 id（来自 redteam_asset_query）' },
      cve: { type: 'string', description: 'CVE / CNVD 编号（无编号可省略）' },
      title: { type: 'string', required: true, description: '漏洞标题' },
      severity: { type: 'string', required: true, enum: ['critical', 'high', 'medium', 'low', 'info'] },
      status: { type: 'string', enum: ['candidate', 'confirmed', 'false-positive', 'exploited', 'fixed'] },
      target: { type: 'string', description: '受影响的目标，如 https://host:443/path 或 ip:port' },
      source: { type: 'string', description: '发现方式：nuclei / sqlmap / curl / manual …' },
      confidence: { type: 'number', description: '0–1' },
      evidence: { type: 'string', description: '证据：请求/响应摘要、命令、证据文件路径' },
      found_by_agent: { type: 'string', description: '发现角色，默认 vuln-scan' },
      gained: { type: 'string', description: '【重要】通过这个漏洞拿到了什么权限/成果，写得分口径的短标签，多项用顿号或逗号分隔，例如「服务器权限、内网隧道」「后台管理员账号」「数据库权限」' },
    },
    output: { schema: { type: 'string' }, render: (_args, value) => text(value) },
    async execute(args, exec) {
      const id = resolveEngagement(store, exec, args.engagement)
      const result = store.addVuln(id, { ...args, engagement: undefined, found_by_agent: args.found_by_agent || 'vuln-scan' })
      return JSON.stringify({ ok: true, engagement: id, ...result, stats: store.vulnStats(id) }, null, 2)
    },
  }))

  ctx.tools.register(defineTool({
    name: 'redteam_vuln_query',
    description: '检索漏洞库：按严重级、状态、CVE、资产、C 段或关键词过滤。用于挑选待利用目标或核对误报。',
    parameters: {
      engagement: { type: 'string' },
      severity: { type: 'string', enum: ['critical', 'high', 'medium', 'low', 'info'] },
      status: { type: 'string', enum: ['candidate', 'confirmed', 'false-positive', 'exploited', 'fixed'] },
      cve: { type: 'string' },
      asset_id: { type: 'number' },
      cidr: { type: 'string' },
      q: { type: 'string', description: '标题/CVE/目标/证据关键词' },
      limit: { type: 'number', description: '默认 50，最大 200' },
    },
    output: { schema: { type: 'string' }, render: (_args, value) => text(value) },
    async execute(args, exec) {
      const id = resolveEngagement(store, exec, args.engagement)
      const result = store.listVulns(id, { ...args, engagement: undefined, limit: Math.min(Number(args.limit) || 50, 200) })
      return JSON.stringify({ ok: true, engagement: id, total: result.total, items: result.items, stats: store.vulnStats(id) }, null, 2)
    },
  }))

  ctx.tools.register(defineTool({
    name: 'redteam_vuln_update',
    description: '更新漏洞状态/严重级/证据（例如验证后置为 confirmed、利用成功后置为 exploited、误报置为 false-positive）。',
    parameters: {
      engagement: { type: 'string' },
      id: { type: 'number', required: true, description: '漏洞 id' },
      status: { type: 'string', enum: ['candidate', 'confirmed', 'false-positive', 'exploited', 'fixed'] },
      severity: { type: 'string', enum: ['critical', 'high', 'medium', 'low', 'info'] },
      evidence: { type: 'string' },
      confidence: { type: 'number' },
      gained: { type: 'string', description: '通过这个漏洞拿到了什么权限/成果（得分口径短标签，多项用顿号分隔）' },
      title: { type: 'string' },
    },
    output: { schema: { type: 'string' }, render: (_args, value) => text(value) },
    async execute(args, exec) {
      const id = resolveEngagement(store, exec, args.engagement)
      const result = store.updateVuln(id, args.id, { status: args.status, severity: args.severity, evidence: args.evidence, confidence: args.confidence, gained: args.gained, title: args.title })
      return JSON.stringify({ ok: result.updated, engagement: id, ...result, stats: store.vulnStats(id) }, null, 2)
    },
  }))

  /* ================================================================== 漏洞利用 / 内网渗透 */

  ctx.tools.register(defineTool({
    name: 'redteam_credential_add',
    description: '记录一条凭据（漏洞利用/内网渗透角色）。**必须把口令/密钥明文写进 secret_value**——面板要直接显示明文供随时复用；同时用 secret_ref 指向 runs/ 下的证据文件。注意：本库只在本机，禁止把库文件或导出内容提交到任何仓库。',
    parameters: {
      engagement: { type: 'string' },
      host: { type: 'string', required: true, description: '所属主机（IP 或域名）' },
      username: { type: 'string' },
      secret_type: { type: 'string', description: 'password | hash | key | token | connection-string，默认 password' },
      secret_value: { type: 'string', description: '【必填】凭据明文：口令 / Hash / 私钥 / Token / 连接串' },
      secret_ref: { type: 'string', description: '证据引用路径，例如 runs/cred-vnc-10.0.0.5.txt' },
      privilege: { type: 'string', description: '该凭据的权限级别，如 admin / user / db-read' },
      asset_id: { type: 'number' },
      source: { type: 'string', description: '来源：exploit / dump / config-leak …' },
      tool: { type: 'string' },
      note: { type: 'string' },
      found_by_agent: { type: 'string' },
    },
    output: { schema: { type: 'string' }, render: (_args, value) => text(value) },
    async execute(args, exec) {
      const id = resolveEngagement(store, exec, args.engagement)
      const result = store.addCredential(id, { ...args, engagement: undefined })
      return JSON.stringify({ ok: true, engagement: id, ...result }, null, 2)
    },
  }))

  ctx.tools.register(defineTool({
    name: 'redteam_credential_list',
    description: '列出已收集的凭据（含明文 secret_value），用于凭据复用与横向移动。',
    parameters: {
      engagement: { type: 'string' },
      host: { type: 'string' },
      username: { type: 'string' },
    },
    output: { schema: { type: 'string' }, render: (_args, value) => text(value) },
    async execute(args, exec) {
      const id = resolveEngagement(store, exec, args.engagement)
      return JSON.stringify({ ok: true, engagement: id, items: store.listCredentials(id, { host: args.host, username: args.username }) }, null, 2)
    },
  }))

  ctx.tools.register(defineTool({
    name: 'redteam_access_add',
    description: '记录一次成功获得的访问会话（横向移动起点）。method 例如 vnc/rdp/ssh/web-shell/webshell/db；privilege 例如 admin/user/system。',
    parameters: {
      engagement: { type: 'string' },
      host: { type: 'string', required: true },
      username: { type: 'string' },
      method: { type: 'string', required: true, description: '获得访问的方式' },
      privilege: { type: 'string' },
      asset_id: { type: 'number' },
      session_ref: { type: 'string', description: '会话/证据引用，例如 runs/session-vnc-10.0.0.5.md' },
      note: { type: 'string' },
      found_by_agent: { type: 'string' },
    },
    output: { schema: { type: 'string' }, render: (_args, value) => text(value) },
    async execute(args, exec) {
      const id = resolveEngagement(store, exec, args.engagement)
      const result = store.addAccess(id, { ...args, engagement: undefined })
      return JSON.stringify({ ok: true, engagement: id, ...result }, null, 2)
    },
  }))

  ctx.tools.register(defineTool({
    name: 'redteam_access_list',
    description: '列出已获得的访问会话。',
    parameters: {
      engagement: { type: 'string' },
      host: { type: 'string' },
    },
    output: { schema: { type: 'string' }, render: (_args, value) => text(value) },
    async execute(args, exec) {
      const id = resolveEngagement(store, exec, args.engagement)
      return JSON.stringify({ ok: true, engagement: id, items: store.listAccess(id, { host: args.host }) }, null, 2)
    },
  }))

  ctx.tools.register(defineTool({
    name: 'redteam_role_prompt_reset',
    description: '把角色系统提示词恢复为内置默认（新版模板）。老靶标想用上最新版角色提示词时用它；省略 role 则四个角色全部重置。',
    parameters: {
      engagement: { type: 'string' },
      role: { type: 'string', enum: ['recon', 'vuln-scan', 'exploit', 'internal'] },
    },
    output: { schema: { type: 'string' }, render: (_args, value) => text(value) },
    async execute(args, exec) {
      const id = resolveEngagement(store, exec, args.engagement)
      const result = store.resetPrompts(id, args.role)
      return JSON.stringify({ ok: true, engagement: id, ...result }, null, 2)
    },
  }))

  /* ---------- WebShell 与内网隧道：打的过程中随时复用，避免"打到后面忘了还有入口" ---------- */

  ctx.tools.register(defineTool({
    name: 'redteam_sessions',
    description: '【每次决策前后都要看】一屏总览当前所有可复用入口：已上线的 WebShell、可用的内网隧道（含监听地址与可达网段）、凭据、访问会话，并给出在线/离线统计。打内网前先看这里，不要重复造轮子，也不要忘记已有的隧道。',
    parameters: { engagement: { type: 'string' } },
    output: { schema: { type: 'string' }, render: (_args, value) => text(value) },
    async execute(args, exec) {
      const id = resolveEngagement(store, exec, args.engagement)
      const summary = store.sessionSummary(id)
      return JSON.stringify({
        ok: true, engagement: id, totals: summary.totals,
        webshells: summary.webshells.map((w) => ({
          id: w.id, url: w.url, type: w.shell_type, pass_key: w.pass_key, privilege: w.privilege,
          status: w.status, asset_ip: w.asset_ip, last_check: w.last_check, note: w.note,
        })),
        tunnels: summary.tunnels.map((t) => ({
          id: t.id, kind: t.kind, listen: t.listen, entry: t.entry, reach: t.reach,
          entry_kind: t.entry_kind, legit: t.legit,
          status: t.status, asset_ip: t.asset_ip, command: t.command, last_check: t.last_check, note: t.note,
        })),
        hint: '隧道 status=active 时可直接给扫描器用：-socks5 <listen> 或 --proxy socks5://<listen>；webshell status=online 时用对应客户端连接。'
          + ' 注意 legit=false（entry_kind=self-only，只在自己的 VPS/自建服务器上）**不算跨越靶标边界、不算突破**；legit=null 表示未声明 entry_kind，用 redteam_tunnel_update 补上目标侧那一端。',
      }, null, 2)
    },
  }))

  ctx.tools.register(defineTool({
    name: 'redteam_webshell_add',
    description: '登记一个已上线的 WebShell。**必须上传冰蝎马（behinder）或哥斯拉马（godzilla）的加密马**——用户在控制台要用对应客户端直连，一句话马/自研马/MemShell 用户连不上，不算可交付的入口。shell_type 只能填 godzilla | behinder；确实只能用其它形式时填 other 并在 note 里写清为什么。同一 url+pass_key 重复登记会合并刷新。登记后所有角色智能体都能复用它，不要重复打点。',
    parameters: {
      engagement: { type: 'string' },
      url: { type: 'string', required: true, description: 'WebShell 完整 URL' },
      shell_type: { type: 'string', description: 'godzilla（哥斯拉）| behinder（冰蝎）；其它形式才用 antsword/other 并说明原因' },
      pass_key: { type: 'string', description: '连接密码 / 密钥（冰蝎马写 pass，哥斯拉写 key）' },
      privilege: { type: 'string', description: '当前权限，例如 www-data / root / iis' },
      secret_ref: { type: 'string', description: '凭据/证据引用，例如 runs/ws-10.0.0.5.txt（不要把明文口令写进库）' },
      asset_id: { type: 'number' },
      note: { type: 'string' },
      found_by_agent: { type: 'string' },
    },
    output: { schema: { type: 'string' }, render: (_args, value) => text(value) },
    async execute(args, exec) {
      const id = resolveEngagement(store, exec, args.engagement)
      const result = store.addWebshell(id, { ...args, engagement: undefined, status: 'online' })
      return JSON.stringify({ ok: true, engagement: id, ...result }, null, 2)
    },
  }))

  ctx.tools.register(defineTool({
    name: 'redteam_webshell_list',
    description: '列出已登记的 WebShell（含在线状态与最后检查时间）。',
    parameters: {
      engagement: { type: 'string' },
      status: { type: 'string', description: 'online | offline | unknown' },
      asset_id: { type: 'number' },
    },
    output: { schema: { type: 'string' }, render: (_args, value) => text(value) },
    async execute(args, exec) {
      const id = resolveEngagement(store, exec, args.engagement)
      return JSON.stringify({ ok: true, engagement: id, items: store.listWebshells(id, args) }, null, 2)
    },
  }))

  ctx.tools.register(defineTool({
    name: 'redteam_webshell_update',
    description: '更新 WebShell 状态（被删/掉线/权限变化）或补充说明。',
    parameters: {
      engagement: { type: 'string' },
      id: { type: 'number', required: true, description: 'WebShell 记录 id' },
      status: { type: 'string', description: 'online | offline | dead | unknown' },
      privilege: { type: 'string' },
      note: { type: 'string' },
      check_note: { type: 'string' },
    },
    output: { schema: { type: 'string' }, render: (_args, value) => text(value) },
    async execute(args, exec) {
      const eng = resolveEngagement(store, exec, args.engagement)
      const result = store.updateWebshell(eng, args.id, args)
      return JSON.stringify({ ok: true, engagement: eng, ...result }, null, 2)
    },
  }))

  ctx.tools.register(defineTool({
    name: 'redteam_tunnel_add',
    description: '登记一条内网隧道。**打进内网必须先用技能 suo5-tunnel 通过 WebShell/HTTP 建 socks5（kind=suo5）**；没有隧道就不要手搓内网探测脚本。listen 写本机可用地址（如 127.0.0.1:1080），reach 写它能到达的网段。登记后扫描器可直接 -socks5 <listen>。\n\n**红线：自己的 VPS / 自己配置的服务器不算隧道。** 只在你自己服务器上开的 socks5、frp 服务端、代理，没有碰到目标，**不算跨越靶标边界、不算边界突破或内网突破**（这类填 entry_kind=self-only，会被标成"不算突破"）。**必须说清目标侧的那一端**：\n· target-outbound — 目标主动连出到我方（**自己服务器收目标反弹 shell**、目标上跑 frp/Stowaway 客户端）；\n· target-http — 经目标 WebShell/HTTP 通道（suo5、Neo-ReGeorg、reGeorg）；\n· target-agent — 经目标已控进程/会话转发（SSH -R 由目标发起等）。',
    parameters: {
      engagement: { type: 'string' },
      kind: { type: 'string', required: true, description: 'suo5（首选，走 WebShell/HTTP）| socks5 | ssh-r | frp | chisel | other' },
      listen: { type: 'string', required: true, description: '本地监听地址 host:port' },
      entry: { type: 'string', description: '入口：WebShell URL / 跳板机 / 命令' },
      reach: { type: 'string', description: '可达网段，例如 10.0.0.0/8' },
      entry_kind: { type: 'string', description: '【重要】通道的目标侧那一端是什么：target-outbound（目标反弹 shell 到我方/目标上跑 frp 客户端）| target-http（经目标 WebShell 的 suo5/Neo-ReGeorg）| target-agent（经目标已控进程转发）| self-only（只在自己 VPS/自建服务器上，**不算突破**）' },
      webshell_id: { type: 'number', description: '由哪个 WebShell 建立' },
      asset_id: { type: 'number' },
      command: { type: 'string', description: '建立命令，便于重建' },
      pid: { type: 'string' },
      note: { type: 'string' },
      found_by_agent: { type: 'string' },
    },
    output: { schema: { type: 'string' }, render: (_args, value) => text(value) },
    async execute(args, exec) {
      const id = resolveEngagement(store, exec, args.engagement)
      const result = store.addTunnel(id, { ...args, engagement: undefined, status: 'active' })
      return JSON.stringify({ ok: true, engagement: id, ...result }, null, 2)
    },
  }))

  ctx.tools.register(defineTool({
    name: 'redteam_tunnel_list',
    description: '列出已登记的内网隧道（含状态、监听地址、可达网段、entry_kind 与 legit 判定）。**legit=false 表示只在自己 VPS/自建服务器上开的通道，不算跨越靶标边界、不算突破**；legit=null 表示未声明 entry_kind。',
    parameters: {
      engagement: { type: 'string' },
      status: { type: 'string', description: 'active | down | unknown' },
    },
    output: { schema: { type: 'string' }, render: (_args, value) => text(value) },
    async execute(args, exec) {
      const id = resolveEngagement(store, exec, args.engagement)
      return JSON.stringify({ ok: true, engagement: id, items: store.listTunnels(id, args) }, null, 2)
    },
  }))

  ctx.tools.register(defineTool({
    name: 'redteam_tunnel_update',
    description: '更新隧道状态（关闭/失效/更换监听地址）或补 entry_kind 判定。用完隧道务必标为 down 并说明，避免后续误用。**老记录没声明入口归属的（legit=null，界面显示"待确认"），用 entry_kind 补上目标侧那一端**，补完才算突破凭证。',
    parameters: {
      engagement: { type: 'string' },
      id: { type: 'number', required: true },
      status: { type: 'string', description: 'active | down | closed | unknown' },
      listen: { type: 'string' },
      reach: { type: 'string' },
      entry: { type: 'string', description: '入口：WebShell URL / 跳板机 / 命令' },
      entry_kind: { type: 'string', description: '补声明目标侧那一端：target-outbound | target-http | target-agent | self-only（只在自己服务器上，不算突破）' },
      note: { type: 'string' },
      check_note: { type: 'string' },
    },
    output: { schema: { type: 'string' }, render: (_args, value) => text(value) },
    async execute(args, exec) {
      const eng = resolveEngagement(store, exec, args.engagement)
      const result = store.updateTunnel(eng, args.id, args)
      return JSON.stringify({ ok: true, engagement: eng, ...result }, null, 2)
    },
  }))

  ctx.tools.register(defineTool({
    name: 'redteam_session_check',
    description: '实测所有 WebShell 与隧道的连通性（由 host 侧真实发起 HTTP / TCP 连接），并把在线/离线状态回写数据库。开工前和长时间任务后各跑一次。',
    parameters: {
      engagement: { type: 'string' },
      timeoutMs: { type: 'number', description: '单次探测超时，默认 6000ms' },
    },
    output: { schema: { type: 'string' }, render: (_args, value) => text(value) },
    async execute(args, exec) {
      const id = resolveEngagement(store, exec, args.engagement)
      const result = await store.probeSessions(id, { timeoutMs: args.timeoutMs })
      const online = result.webshells.filter((w) => w.status === 'online').length
      const active = result.tunnels.filter((t) => t.status === 'active').length
      return JSON.stringify({
        ok: true, engagement: id, checked_at: result.checkedAt,
        summary: `WebShell 在线 ${online}/${result.webshells.length}，隧道可用 ${active}/${result.tunnels.length}`,
        webshells: result.webshells, tunnels: result.tunnels,
      }, null, 2)
    },
  }))

  ctx.tools.register(defineTool({
    name: 'redteam_attack_path',
    description: '导出攻击图谱：资产拓扑 + 漏洞节点 + 已控制资产（meta.owned）。用于横向移动路径规划与战果汇报。节点过多时用 cidr 缩小范围。',
    parameters: {
      engagement: { type: 'string' },
      cidr: { type: 'string' },
      maxNodes: { type: 'number', description: '默认 400' },
    },
    output: { schema: { type: 'string' }, render: (_args, value) => text(value) },
    async execute(args, exec) {
      const id = resolveEngagement(store, exec, args.engagement)
      const maxNodes = Math.min(Number(args.maxNodes) || 400, 1500)
      const graph = store.attackGraph(id, { cidr: args.cidr })
      if (graph.nodes.length > maxNodes) {
        return JSON.stringify({
          ok: false,
          error: '图谱节点过多（' + graph.nodes.length + ' > ' + maxNodes + '），请指定 cidr 缩小范围',
          summary: graph.summary,
        }, null, 2)
      }
      return JSON.stringify({
        ok: true, engagement: id, summary: graph.summary,
        owned: graph.nodes.filter((n) => n.meta && n.meta.owned).map((n) => n.label),
        nodes: graph.nodes, edges: graph.edges,
      }, null, 2)
    },
  }))

  /* ================================================================== 域名 / Web 资产 */

  ctx.tools.register(defineTool({
    name: 'redteam_web_list',
    description: '列出 Web 资产（含可直接访问的 URL 与页面标题）。做 Web 渗透前先看这里，优先从接口入手。',
    parameters: {
      engagement: { type: 'string' },
      cidr: { type: 'string' },
      limit: { type: 'number' },
    },
    output: { schema: { type: 'string' }, render: (_args, value) => text(value) },
    async execute(args, exec) {
      const id = resolveEngagement(store, exec, args.engagement)
      const result = store.listWeb(id, { cidr: args.cidr, limit: args.limit })
      return JSON.stringify({
        ok: true, engagement: id, total: result.total,
        items: result.items.map((w) => ({
          url: w.url || ('http' + (w.port === 443 || w.port === 8443 || w.port === 9443 ? 's' : '') + '://' + w.ip + (w.port === 80 || w.port === 443 ? '' : ':' + w.port)),
          title: w.title, ip: w.ip, segment: w.segment_cidr, port: w.port,
          service: [w.service, w.product, w.version].filter(Boolean).join(' '),
          provenance: w.provenance, asset_id: w.asset_id,
        })),
      }, null, 2)
    },
  }))

  ctx.tools.register(defineTool({
    name: 'redteam_domain_index',
    description: '按域名维度聚合资产：每个域名关联了哪些 IP/资产。用于梳理主域名、子域与 C 段的关系。',
    parameters: { engagement: { type: 'string' } },
    output: { schema: { type: 'string' }, render: (_args, value) => text(value) },
    async execute(args, exec) {
      const id = resolveEngagement(store, exec, args.engagement)
      return JSON.stringify({ ok: true, engagement: id, items: store.domainIndex(id) }, null, 2)
    },
  }))

  /* ================================================================== 得分目标 */

  ctx.tools.register(defineTool({
    name: 'redteam_score_list',
    description: '查看得分目标面板：所有得分点（名称/分类/分值/是否已拿下/命中证据）与总分进度。**每次规划下一步之前先看这里**，按分值高低决定先打什么。',
    parameters: { engagement: { type: 'string' } },
    output: { schema: { type: 'string' }, render: (_args, value) => text(value) },
    async execute(args, exec) {
      const id = resolveEngagement(store, exec, args.engagement)
      const result = store.listScorePoints(id, {})
      return JSON.stringify({
        ok: true, engagement: id, summary: result.summary,
        items: result.items.map((p) => ({
          id: p.id, code: p.code, name: p.name, category: p.category, points: p.points,
          enabled: p.enabled, achieved: p.hits.length > 0, hits: p.hits.length,
          evidence: p.hits.map((h) => (h.target ? h.target + '：' : '') + h.evidence).slice(0, 3),
        })),
      }, null, 2)
    },
  }))

  ctx.tools.register(defineTool({
    name: 'redteam_score_hit',
    description: '记录一次得分（同类得分**不设数量上限**，每个真实命中都按分值累加：命中次数 × 分值）。**证据只写结果**：目标资产 + 拿到了什么（账号/密码/权限/数据量），不要写取得过程与路径——过程由攻击得分链路负责。能指向"用哪个漏洞拿到的"时请带上 vuln_id，报告会自动附上该漏洞的原始请求。\n\n**红线一：账号类得分必须先实测能登录。** 拿到账号/口令后要用浏览器（browser-automation / kimi-webbridge）或等价会话实测登录成功、能交互访问页面，才记 web-account-* 这类分——**只有凭据不算拿到账号**；登不进去的写进 redteam_asset_test 的 `test` 参数（追加式记录），不要用不存在的字段名。\n\n**红线二：自己注册的账号不算得分权限。** 通过注册接口自助注册、自己新建的用户/角色/后台账号、自己给自己开的权限，都**不是**"拿到账号权限"——演练得分针对的是**拿到别人已有的**账号与权限（弱口令、凭据泄露、SQL 注入拖出的账号、越权/提权到已有账号、默认口令、复用已有凭据）。这类自建账号用 self_created=true 记录（留过程），**不计分、不计数、不进报告**。',
    parameters: {
      engagement: { type: 'string' },
      code: { type: 'string', description: '得分点 code（或 point_id / point_name 任选其一）' },
      point_id: { type: 'number' },
      point_name: { type: 'string' },
      target: { type: 'string', description: '目标资产：URL / ip:port / 主机名' },
      asset_id: { type: 'number', description: '目标资产在库里的 id' },
      vuln_id: { type: 'number', description: '【建议填】用哪个漏洞拿到的分（报告据此附原始请求）' },
      step_id: { type: 'number', description: '对应的攻击链步骤 id（可选）' },
      evidence: { type: 'string', required: true, description: '【必填】结果：拿到的东西，例如「后台管理员 tomcat/Tomcat@2024（已实测浏览器可登录）」「数据库账号 root/xxx」「导出 1.2 万条用户数据」' },
      self_created: { type: 'boolean', description: '【重要】这个账号/权限是不是**自己注册、自己创建**的？是则填 true —— 只作过程记录，不计分、不进报告。拿到别人已有的账号/权限不要填（默认 false）。' },
      note: { type: 'string' },
      recorded_by: { type: 'string' },
    },
    output: { schema: { type: 'string' }, render: (_args, value) => text(value) },
    async execute(args, exec) {
      const id = resolveEngagement(store, exec, args.engagement)
      const result = store.addScoreHit(id, { ...args, engagement: undefined })
      return JSON.stringify({ ok: true, engagement: id, ...result }, null, 2)
    },
  }))

  ctx.tools.register(defineTool({
    name: 'redteam_score_point_save',
    description: '新增或修改得分点（分值/名称/分类/说明/启用）。用户也会在界面上编辑；智能体只在必要时用（例如发现规则里还有未被记录的得分项）。带 id 为修改，不带 id 为新增。',
    parameters: {
      engagement: { type: 'string' },
      id: { type: 'number', description: '已有得分点 id（修改时传）' },
      name: { type: 'string', required: true },
      code: { type: 'string', description: '短代码（新增时建议给，便于记录得分）' },
      category: { type: 'string', description: '分类，如 账号权限 / 服务器权限 / 数据库 / 网络突破 / 数据 / 核心目标' },
      points: { type: 'number', description: '分值' },
      description: { type: 'string', description: '得分条件说明' },
      enabled: { type: 'boolean' },
    },
    output: { schema: { type: 'string' }, render: (_args, value) => text(value) },
    async execute(args, exec) {
      const id = resolveEngagement(store, exec, args.engagement)
      const result = store.saveScorePoint(id, { ...args, engagement: undefined })
      return JSON.stringify({ ok: true, engagement: id, ...result }, null, 2)
    },
  }))

  ctx.tools.register(defineTool({
    name: 'redteam_asset_assess',
    description: '给资产做「易打性评估」：预期能拿下哪些成果（账号权限/RCE/服务器权限/数据库权限/敏感数据/边界突破）、优先级多高、判断理由。信息收集收口时对每个资产调用一次，供指挥者按性价比排序。',
    parameters: {
      engagement: { type: 'string' },
      asset_id: { type: 'number' },
      ip: { type: 'string' },
      priority: { type: 'string', enum: ['high', 'medium', 'low'], description: 'high 容易出成果 / medium 一般 / low 难打或价值低' },
      potential: { type: 'string', description: '预期成果，如「账号权限+RCE」「数据库权限」「大量敏感信息」' },
      reason: { type: 'string', description: '判断理由：指纹版本命中 Nday、接口未鉴权、口令弱、暴露数据库、WAF 强弱等' },
      assessed_by: { type: 'string' },
    },
    output: { schema: { type: 'string' }, render: (_args, value) => text(value) },
    async execute(args, exec) {
      const id = resolveEngagement(store, exec, args.engagement)
      const result = store.assessAsset(id, { ...args, engagement: undefined })
      return JSON.stringify({ ok: true, engagement: id, ...result }, null, 2)
    },
  }))

  /* ================================================================== 证据 / 攻击链 / 报告 */

  ctx.tools.register(defineTool({
    name: 'redteam_http_evidence_add',
    description: '保存一条 HTTP 证据：原始请求与响应。报告会把它渲染成可粘贴进 Burp Suite / Yakit 的原始报文，因此 request 必须是完整可重放的原始请求（含请求行、Host 等头部、必要时 body）。',
    parameters: {
      engagement: { type: 'string' },
      vuln_id: { type: 'number', description: '关联的漏洞 id（建议填）' },
      asset_id: { type: 'number' },
      label: { type: 'string', description: '这条证据的用途，例如「越权读取用户列表」' },
      method: { type: 'string', description: 'GET/POST/…' },
      url: { type: 'string' },
      status: { type: 'number', description: '响应状态码' },
      request: { type: 'string', required: true, description: '原始请求全文（Burp 可直接粘贴）' },
      response: { type: 'string', description: '响应全文或关键片段' },
      note: { type: 'string' },
      captured_by: { type: 'string', description: '采集角色' },
    },
    output: { schema: { type: 'string' }, render: (_args, value) => text(value) },
    async execute(args, exec) {
      const id = resolveEngagement(store, exec, args.engagement)
      const result = store.addHttpEvidence(id, { ...args, engagement: undefined })
      return JSON.stringify({ ok: true, engagement: id, ...result }, null, 2)
    },
  }))

  ctx.tools.register(defineTool({
    name: 'redteam_chain_add',
    description: '记录一个攻击链步骤（攻击链页面与报告按 seq 排序展示）。stage：recon（信息收集）| vuln（漏洞发现）| exploit（利用）| access（获得权限）| pivot（内网突破）| data（敏感数据）| other。',
    parameters: {
      engagement: { type: 'string' },
      stage: { type: 'string', required: true, enum: ['recon', 'vuln', 'exploit', 'access', 'pivot', 'data', 'other'] },
      title: { type: 'string', required: true, description: '一句话描述这一步做了什么' },
      detail: { type: 'string', description: '细节：payload、凭据来源、命令、影响范围' },
      asset_id: { type: 'number' },
      vuln_id: { type: 'number' },
      access_id: { type: 'number' },
      evidence_ref: { type: 'string', description: '证据文件/会话引用，例如 runs/session-vnc.md' },
      recorded_by: { type: 'string' },
      point_code: { type: 'string', description: '【这一步拿了分就填】得分点 code（如 rce / webshell / boundary），服务端会自动记一次分并把步骤与得分互相挂上。**必须同时给 evidence，否则不会记分**（步骤照常入库）。' },
      stage_code: { type: 'string', enum: ['recon', 'internet', 'boundary', 'internal', 'target'], description: '所属作战阶段（只有这 5 个合法值）：recon(信息收集) | internet(互联网资产权限) | boundary(边界突破·搭隧道) | internal(内网资产权限) | target(靶标系统权限)。写别的值（如外部工具常见的 external/foothold/tunnel/privilege）会被忽略并退回按 stage 兜底，步骤就不落在任何阶段。' },
      evidence: { type: 'string', description: '配合 point_code 使用：这一分拿到了什么（目标资产 + 账号/权限/数据量）——**不填就不记分**。' },
      self_created: { type: 'boolean', description: '配合 point_code 使用：这一步拿到的账号/权限是**自己注册/自建**的吗？是则 true（只留过程，不计分）' },
      target: { type: 'string', description: '配合 point_code 使用：目标资产' },
      seq: { type: 'number', description: '不填则自动追加到链尾' },
    },
    output: { schema: { type: 'string' }, render: (_args, value) => text(value) },
    async execute(args, exec) {
      const id = resolveEngagement(store, exec, args.engagement)
      const result = store.addChainStep(id, { ...args, engagement: undefined })
      return JSON.stringify({ ok: true, engagement: id, ...result }, null, 2)
    },
  }))

  ctx.tools.register(defineTool({
    name: 'redteam_chain',
    description: '读取完整攻击链（按步骤顺序），用于汇报与检查链路是否闭合（入口 → 权限 → 内网突破）。',
    parameters: { engagement: { type: 'string' } },
    output: { schema: { type: 'string' }, render: (_args, value) => text(value) },
    async execute(args, exec) {
      const id = resolveEngagement(store, exec, args.engagement)
      return JSON.stringify({ ok: true, engagement: id, items: store.listChain(id) }, null, 2)
    },
  }))

  ctx.tools.register(defineTool({
    name: 'redteam_attack_file_add',
    description: '保存一个**实际生效**的攻击文件（脚本/POC/EXP/字典）到目标文件夹，供复用与交付。目录结构：attack-files/<IP|URL主机|C段>/<文件名>。evidence 必填且必须写清验证效果（例如"回显 uid=0"、"未授权返回 200 并含数据"）——**没打通的、只是尝试过的脚本不要放进来**。',
    parameters: {
      engagement: { type: 'string' },
      target: { type: 'string', required: true, description: '目标：IP、URL 或 C 段（同一 IP 的多个端口会归到该 IP 文件夹）' },
      name: { type: 'string', required: true, description: '文件名，例如 cve-2021-22893.sh / vnc_brute.py' },
      kind: { type: 'string', enum: ['poc', 'exp', 'script', 'wordlist', 'other'], description: '类型：poc 验证 / exp 利用 / script 脚本 / wordlist 字典' },
      description: { type: 'string', description: '这个文件做什么（一句话）' },
      evidence: { type: 'string', required: true, description: '有效性证据：实际打通的输出/回显/影响，或对应漏洞/证据 id' },
      content: { type: 'string', description: '文件内容（与 path 二选一）' },
      path: { type: 'string', description: '已存在的文件路径（相对靶标目录或绝对路径），会复制进目标文件夹（与 content 二选一）' },
      asset_id: { type: 'number' },
      vuln_id: { type: 'number' },
      created_by: { type: 'string' },
    },
    output: { schema: { type: 'string' }, render: (_args, value) => text(value) },
    async execute(args, exec) {
      const id = resolveEngagement(store, exec, args.engagement)
      const result = store.addAttackFile(id, { ...args, engagement: undefined })
      return JSON.stringify({ ok: true, engagement: id, ...result }, null, 2)
    },
  }))

  ctx.tools.register(defineTool({
    name: 'redteam_attack_file_list',
    description: '列出已保存的攻击文件（按目标文件夹分组）。开始打某个目标前先看这里，避免重复造轮子。',
    parameters: {
      engagement: { type: 'string' },
      target: { type: 'string', description: '只看某个目标' },
    },
    output: { schema: { type: 'string' }, render: (_args, value) => text(value) },
    async execute(args, exec) {
      const id = resolveEngagement(store, exec, args.engagement)
      if (args.target) return JSON.stringify({ ok: true, engagement: id, items: store.listAttackFiles(id, { target: args.target }) }, null, 2)
      return JSON.stringify({ ok: true, engagement: id, folders: store.attackFileTree(id) }, null, 2)
    },
  }))

  ctx.tools.register(defineTool({
    name: 'redteam_report_targets',
    description: '【已弃用，改用 redteam_score_report】按目标查看成果报告（每个 IP / URL / C 段一份）：成果漏洞（含可粘贴进 Burp/Yakit 的原始请求）、已获权限、凭据、攻击文件、攻击链。用于按目标汇报或检查某个目标还缺什么。',
    parameters: {
      engagement: { type: 'string' },
      target: { type: 'string', description: '只看某个目标的报告' },
    },
    output: { schema: { type: 'string' }, render: (_args, value) => text(value) },
    async execute(args, exec) {
      const id = resolveEngagement(store, exec, args.engagement)
      const result = store.reportTargets(id, {})
      const picked = args.target ? result.targets.filter((t) => t.key === args.target || t.label === args.target) : result.targets
      return JSON.stringify({
        ok: true, engagement: id, generated_at: result.generated_at, totals: result.totals,
        targets: picked.map((t) => ({ key: t.key, label: t.label, segment: t.segment, stats: t.stats })),
      }, null, 2)
    },
  }))

  ctx.tools.register(defineTool({
    name: 'redteam_attack_chain',
    description: '攻击链：按攻击面位置串起来的五个阶段 —— ① 信息收集（互联网侧）→ ② 互联网资产权限 → ③ 边界突破（搭隧道）→ ④ 内网资产权限 → ⑤ 靶标权限。返回每阶段的阶段目标、**实际拿到多少分与累计分**、涉及资产、以及边界突破阶段的真实隧道。开工时看它明确"现在在第几阶段、下一步该打哪一阶段"，汇报时按阶段给结论。',
    parameters: { engagement: { type: 'string' } },
    output: { schema: { type: 'string' }, render: (_args, value) => text(value) },
    async execute(args, exec) {
      const id = resolveEngagement(store, exec, args.engagement)
      const chain = store.scoreChain(id)
      return JSON.stringify({
        ok: true, engagement: id,
        totals: { points: chain.summary.points, totalPoints: chain.summary.totalPoints, hits: chain.summary.hits },
        stages: (chain.stages || []).map((st) => ({
          code: st.code, name: st.name, goal: st.goal,
          points: st.points, cumulative: st.cumulative, counted: st.counted, hits: st.hits,
          steps: st.steps, tools: st.tools,
          methods: (st.sections || []).map((x) => x.label + '：' + (x.items || []).join('、')),
          scored: st.items.map((x) => ({ point: x.point_name, points: x.points, counted: x.counted, target: x.target })),
          assets: (st.assets || []).map((a) => a.ip + (a.scope === 'internal' ? '(内网)' : '(外网)') + ' 贡献' + a.points + '分'),
          tunnels: (st.tunnels || []).map((t) => t.kind + ' ' + t.listen + ' [' + t.status + '] 可达 ' + (t.reach || '—')),
        })),
        hint: '得分阶段是自动推导的（core-system→靶标、boundary→边界突破，其余按资产内外网归属）；写攻击链步骤时带 stage_code（只接受 recon/internet/boundary/internal/target）步骤计数才会落到正确阶段，写别的值会被忽略。',
      }, null, 2)
    },
  }))


  ctx.tools.register(defineTool({
    name: 'redteam_score_report',
    description: '攻击得分链路复现报告：只收录"拿到了分"的成果（没得分的漏洞不进报告），每一项都尽量附上可直接粘贴进 Yakit Repeater 复现的原始请求。需要交付报告时用这个，而不是 redteam_report。',
    parameters: {
      engagement: { type: 'string' },
      limit: { type: 'number', description: '最多多少项，默认 500' },
      markdown: { type: 'boolean', description: 'true=返回 markdown 全文（默认 true）；false=只返回条目摘要' },
    },
    output: { schema: { type: 'string' }, render: (_args, value) => text(value) },
    async execute(args, exec) {
      const id = resolveEngagement(store, exec, args.engagement)
      const r = store.scoreReport(id, { limit: args.limit })
      if (args.markdown === false) {
        return JSON.stringify({ ok: true, engagement: id, summary: r.summary,
          items: r.items.map((x) => ({ seq: x.seq, point: x.point_name, points: x.points, counted: x.counted,
            target: x.target, gained: x.gained, requests: x.requests.length, missing_evidence: x.missing_evidence })) }, null, 2)
      }
      return JSON.stringify({ ok: true, engagement: id, summary: r.summary, markdown: r.markdown }, null, 2)
    },
  }))

  ctx.tools.register(defineTool({
    name: 'redteam_report',
    description: '【已弃用，改用 redteam_score_report】生成成果报告（Markdown）：只收录**已验证/已利用且中危以上**的成果漏洞（每条附可粘贴进 Burp/Yakit 的原始请求）、攻击链、已获权限与凭据、修复建议。信息收集的资产清单、待验证/误报、低危与信息级水洞都不会出现在报告里。想让发现进报告：先 redteam_vuln_update 置为 confirmed（验证通过）或 exploited（利用成功），再 redteam_http_evidence_add 补原始请求。',
    parameters: { engagement: { type: 'string' } },
    output: { schema: { type: 'string' }, render: (_args, value) => text(value) },
    async execute(args, exec) {
      const id = resolveEngagement(store, exec, args.engagement)
      const result = store.report(id)
      return JSON.stringify({ ok: true, engagement: id, generated_at: result.generated_at, stats: result.stats, markdown: result.markdown }, null, 2)
    },
  }))

  /* ── 知识库（POC/EXP）：全局共享，跨靶标复用 ───────────────────────────────
     为什么单列一组工具：通用 POC/EXP 是一次性投入、长期复用的资产。打 Nday/1day
     之前先查这里，能省掉整轮"去互联网找 + 手搓 + 调试"的时间；验证有效的通用
     POC/EXP 必须回填，后面的靶标和智能体直接就能用。 */

  ctx.tools.register(defineTool({
    name: 'redteam_poc_search',
    description: '【打 Nday/1day 前的第一步】先查"现成的"两层：① **知识库**（本机沉淀的通用 POC/EXP，跨靶标共享，按"已验证 → 复用次数"排序）② **本机 nuclei 模板库**（上万条模板，CVE/组件名直接命中）。命中就取用：知识库用 redteam_poc_get 拿全文，模板直接 `nuclei -t <相对路径>`。**不要重复去互联网找或重新手搓**。两层都没有，再去互联网搜索或自己手搓，验证有效后用 redteam_poc_add 回填知识库。',
    parameters: {
      q: { type: 'string', description: '关键字：组件+版本、漏洞名、路径片段、正文里的特征串都行' },
      cve: { type: 'string', description: 'CVE / CNVD 编号，例如 CVE-2023-21839' },
      component: { type: 'string', description: '组件/产品名，例如 Weblogic、Shiro、泛微 OA、Nacos' },
      kind: { type: 'string', description: 'poc | exp | script | template | payload' },
      language: { type: 'string', description: 'python | go | java | bash | http | nuclei | js | php' },
      source: { type: 'string', description: 'web（互联网）| self（手搓）| manual（人工）| nuclei-template' },
      verified: { type: 'boolean', description: 'true 只看实测验证过的（优先用这些）' },
      templateLimit: { type: 'number', description: '本机 nuclei 模板最多返回几条，默认 20' },
      limit: { type: 'number', description: '知识库条目上限，默认 200' },
    },
    output: { schema: { type: 'string' }, render: (_args, value) => text(value) },
    async execute(args) {
      const items = store.searchPocs(args)
      const stats = store.pocStats()
      const q = args.q || args.cve || args.component || ''
      const tpl = q
        ? store.searchTemplates(q, Math.min(Number(args.templateLimit) || 20, 100))
        : { dir: store.nucleiTemplatesDir() || null, total: store.templateStats().total, items: [] }
      const tplStats = store.templateStats()
      const hit = items.length > 0 || (tpl.items || []).length > 0
      return JSON.stringify({
        ok: true,
        knowledge_base: { total: stats.total, verified: stats.verified, reused: stats.reused },
        local_templates: { dir: tplStats.dir, total: tplStats.total, cve_templates: tplStats.cve, matched: (tpl.items || []).length },
        count: items.length,
        hint: hit
          ? '命中现成的：知识库条目用 redteam_poc_get 取全文；nuclei 模板直接用 `nuclei -t <模板相对路径>`。用完 redteam_poc_use 记一次复用。'
          : '知识库与本机模板库都没有：去互联网搜索（web_search / GitHub / ExploitDB / 厂商公告）或自己手搓，验证有效后务必 redteam_poc_add 回填知识库。',
        templates: (tpl.items || []).map((t) => ({ path: t.path, name: t.name, severity: t.severity, tags: t.tags })),
        items: items.map((x) => ({
          id: x.id, code: x.code, title: x.title, kind: x.kind, cve: x.cve, component: x.component,
          versions: x.versions, language: x.language, source: x.source, source_url: x.source_url,
          verified: x.verified === 1, verified_note: x.verified_note, hit_count: x.hit_count,
          tags: x.tags, usage: x.usage, path: x.path, has_content: x.has_content === 1,
        })),
      }, null, 2)
    },
  }))

  ctx.tools.register(defineTool({
    name: 'redteam_poc_get',
    description: '取一条知识库 POC/EXP 的**完整内容**（正文 + 用法 + 验证记录 + 落盘路径），可直接照用或改造成目标专用脚本。不传 id 时可用 code（redteam_poc_search 返回里的 code 字段）。',
    parameters: {
      id: { type: 'number', description: '知识库条目 id' },
      code: { type: 'string', description: '知识库条目的稳定标识（search 结果里的 code）' },
    },
    output: { schema: { type: 'string' }, render: (_args, value) => text(value) },
    async execute(args) {
      const row = store.getPoc(args.id !== undefined ? args.id : args.code)
      if (row === undefined) return JSON.stringify({ ok: false, error: '知识库没有这一条（先用 redteam_poc_search 检索）' }, null, 2)
      return JSON.stringify({ ok: true, ...row }, null, 2)
    },
  }))

  ctx.tools.register(defineTool({
    name: 'redteam_poc_add',
    description: '把**通用可复用**的 POC/EXP 落进知识库（跨靶标共享）。从互联网拿到的、自己手搓的、或已经调通验证过的都往这里放——只收录真正有效的，并写清来源与验证证据。判断标准：**换个目标还能用**的进知识库；只对本次靶标有效的脚本走 redteam_attack_file_add（攻击文件页）。同名（同一 code）会合并刷新，可用于更新版本。',
    parameters: {
      title: { type: 'string', required: true, description: '标题：组件 + 漏洞名/编号，例如「Weblogic T3 反序列化 CVE-2023-21839」' },
      kind: { type: 'string', description: 'poc（验证）| exp（利用）| script | template | payload' },
      cve: { type: 'string', description: 'CVE / CNVD 编号' },
      component: { type: 'string', description: '组件/产品名（便于按组件检索）' },
      versions: { type: 'string', description: '影响版本范围' },
      severity: { type: 'string', description: 'critical | high | medium | low' },
      language: { type: 'string', description: 'python | go | java | bash | http | nuclei | js | php' },
      source: { type: 'string', description: 'web（互联网扒的）| self（自己手搓）| manual（人工）| nuclei-template' },
      source_url: { type: 'string', description: '来源链接（互联网来源必填，便于复核）' },
      description: { type: 'string', description: '这个 POC 干什么、原理要点、前提条件' },
      usage: { type: 'string', description: '用法：完整命令行示例 + 需要替换的参数' },
      content: { type: 'string', description: '正文：脚本/POC 源码、原始请求包、nuclei 模板、调用步骤' },
      path: { type: 'string', description: '也可以给本机已有文件路径（相对 pocs/ 或绝对路径），由知识库读取正文' },
      filename: { type: 'string', description: '正文落盘文件名，默认按语言给（poc.py / poc.sh / poc.yaml…）' },
      verified: { type: 'boolean', description: '是否已实测验证（**只有在真实目标上验证过的才填 true**）' },
      verified_note: { type: 'string', description: '验证证据：在哪台目标、什么回显/结果、是否需要认证' },
      tags: { type: 'string', description: '逗号分隔标签，例如「java,反序列化,rce」' },
      created_by: { type: 'string', description: '哪个角色/智能体沉淀的' },
    },
    output: { schema: { type: 'string' }, render: (_args, value) => text(value) },
    async execute(args) {
      const r = store.savePoc(args)
      return JSON.stringify({ ok: true, created: r.created, code: r.poc.code, path: r.path,
        verified: r.poc.verified === 1, hint: '已进知识库，后续任何靶标的智能体 redteam_poc_search 都能直接命中。' }, null, 2)
    },
  }))

  ctx.tools.register(defineTool({
    name: 'redteam_poc_list',
    description: '列出知识库里的 POC/EXP（可按 kind/source/component/verified 过滤，不带条件就是全部）。用于盘点"我们手上已经有哪些现成武器"，避免重复搜集。',
    parameters: {
      kind: { type: 'string' }, source: { type: 'string' }, component: { type: 'string' },
      verified: { type: 'boolean' }, limit: { type: 'number' },
    },
    output: { schema: { type: 'string' }, render: (_args, value) => text(value) },
    async execute(args) {
      const items = store.searchPocs(args)
      const stats = store.pocStats()
      return JSON.stringify({ ok: true, stats: { total: stats.total, verified: stats.verified, by_kind: stats.byKind, by_source: stats.bySource },
        count: items.length,
        items: items.map((x) => ({ id: x.id, code: x.code, title: x.title, kind: x.kind, cve: x.cve, component: x.component,
          language: x.language, source: x.source, verified: x.verified === 1, hit_count: x.hit_count, tags: x.tags })) }, null, 2)
    },
  }))

  ctx.tools.register(defineTool({
    name: 'redteam_poc_update',
    description: '更新知识库条目：补验证结论（verified + verified_note）、修正影响版本、补用法或正文、改标签。**在真实目标上验证通过后，一定要回来把 verified 置 true 并写清证据**——后续智能体会优先用已验证的。',
    parameters: {
      id: { type: 'number', description: '知识库条目 id' },
      code: { type: 'string', description: '或用 code 指定条目' },
      patch: {
        type: 'object', additionalProperties: true,
        description: '{ verified, verified_note, versions, usage, description, content, tags, severity, component, cve, source, source_url, language }',
      },
      verified: { type: 'boolean', description: '便捷写法：直接传 verified' },
      verified_note: { type: 'string', description: '便捷写法：直接传验证证据' },
    },
    output: { schema: { type: 'string' }, render: (_args, value) => text(value) },
    async execute(args) {
      const patch = Object.assign({}, args.patch || {})
      if (args.verified !== undefined) patch.verified = args.verified
      if (args.verified_note !== undefined) patch.verified_note = args.verified_note
      const row = store.updatePoc(args.id !== undefined ? args.id : args.code, patch)
      return JSON.stringify({ ok: true, id: row.id, code: row.code, verified: row.verified === 1, verified_note: row.verified_note, updated_at: row.updated_at }, null, 2)
    },
  }))

  ctx.tools.register(defineTool({
    name: 'redteam_poc_use',
    description: '记一次知识库 POC/EXP 的复用（用在哪个靶标/目标）。复用次数高的条目会排前面，方便后来者优先选经过实战的武器。',
    parameters: {
      id: { type: 'number' },
      code: { type: 'string' },
      used_on: { type: 'string', description: '用在哪：靶标名 / 目标 IP / URL' },
    },
    output: { schema: { type: 'string' }, render: (_args, value) => text(value) },
    async execute(args) {
      const r = store.markPocUsed(args.id !== undefined ? args.id : args.code, args.used_on)
      return JSON.stringify(r, null, 2)
    },
  }))
}
