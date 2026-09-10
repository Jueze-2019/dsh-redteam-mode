#!/usr/bin/env node
/**
 * 演示数据生成器：输出 store.mjs 的 import 请求（JSON）。
 * 全部使用 RFC 5737 文档保留网段（203.0.113.0/24、192.0.2.0/24、198.51.100.0/24），
 * 不对真实主机产生任何流量，仅用于界面与查询联调。
 * 用法：node seed-demo.mjs | node store.mjs
 */
const ENGAGEMENT = process.env.REDTEAM_ENGAGEMENT || '示例科技有限公司'
const t = new Date().toISOString()

const P = (port, service, product, version, extra = {}) => ({
  port, proto: 'tcp', state: 'open', service, product, version,
  fingerprints: extra.fingerprints || [], provenance: extra.provenance || 'active',
  tool: extra.tool || 'nmap', banner: extra.banner,
})

const SEGMENTS = [
  { cidr: '203.0.113.0/24', ip_start: '203.0.113.0', ip_end: '203.0.113.255', org: '示例科技有限公司-办公网', asn: 'AS64500', country: 'CN', city: '北京', source: 'passive' },
  { cidr: '192.0.2.0/24', ip_start: '192.0.2.0', ip_end: '192.0.2.255', org: '示例科技有限公司-生产网', asn: 'AS64500', country: 'CN', city: '北京', source: 'passive' },
  { cidr: '198.51.100.0/24', ip_start: '198.51.100.0', ip_end: '198.51.100.255', org: '示例科技有限公司-DMZ', asn: 'AS64501', country: 'CN', city: '上海', source: 'active' },
]

const ASSETS = [
  {
    ip: '203.0.113.10', state: 'live', primary_name: 'www.example-corp.cn', provenance: 'passive', tool: 'crt.sh',
    names: [{ name: 'www.example-corp.cn', kind: 'domain', provenance: 'passive' }, { name: 'example-corp.cn', kind: 'domain', provenance: 'passive' }],
    ports: [P(80, 'http', 'nginx', '1.24.0', { provenance: 'passive', tool: 'crt.sh', fingerprints: [{ category: 'Web服务器', vendor: 'nginx', product: 'nginx', version: '1.24.0', evidence: 'Server: nginx/1.24.0' }] })],
  },
  {
    ip: '203.0.113.11', state: 'live', primary_name: 'mail.example-corp.cn', provenance: 'passive', tool: 'dns',
    names: [{ name: 'mail.example-corp.cn', kind: 'domain', provenance: 'passive' }],
    ports: [
      P(25, 'smtp', 'Postfix', '3.7.4', { provenance: 'passive', tool: 'shodan' }),
      P(443, 'https', 'nginx', '1.22.1', { provenance: 'active', tool: 'nmap' }),
      P(993, 'imaps', 'Dovecot', '2.3.19', { provenance: 'passive', tool: 'shodan' }),
    ],
  },
  {
    ip: '203.0.113.20', state: 'live', primary_name: 'vpn.example-corp.cn', provenance: 'active', tool: 'nmap',
    names: [{ name: 'vpn.example-corp.cn', kind: 'domain', provenance: 'passive' }],
    ports: [P(443, 'https', 'Fortinet', 'FortiGate 7.0.0', {
      provenance: 'active', tool: 'nmap',
      fingerprints: [
        { category: 'VPN网关', vendor: 'Fortinet', product: 'FortiGate', version: '7.0.0', evidence: 'SSL VPN 登录页特征', confidence: 0.9 },
      ],
    })],
  },
  {
    ip: '203.0.113.21', state: 'live', primary_name: null, provenance: 'active', tool: 'masscan',
    names: [], ports: [
      P(445, 'microsoft-ds', 'Windows SMB', '10.0', { provenance: 'active', tool: 'nmap' }),
      P(3389, 'rdp', 'Microsoft Terminal Services', '10.0', { provenance: 'active', tool: 'nmap' }),
      P(135, 'msrpc', 'Microsoft Windows RPC', null, { provenance: 'active', tool: 'masscan' }),
    ],
  },
  {
    ip: '203.0.113.30', state: 'live', primary_name: 'oa.example-corp.cn', provenance: 'passive', tool: 'crt.sh',
    names: [{ name: 'oa.example-corp.cn', kind: 'domain', provenance: 'passive' }],
    ports: [P(8080, 'http', 'Apache Tomcat', '9.0.65', {
      fingerprints: [
        { category: '中间件', vendor: 'Apache', product: 'Tomcat', version: '9.0.65', evidence: 'Tomcat 默认错误页', confidence: 0.95 },
        { category: '框架', vendor: 'Spring', product: 'Spring Boot', version: '2.7.x', evidence: '/actuator 探针响应', confidence: 0.7 },
      ],
    })],
  },
  {
    ip: '203.0.113.31', state: 'live', primary_name: 'erp.example-corp.cn', provenance: 'passive', tool: 'cert',
    names: [{ name: 'erp.example-corp.cn', kind: 'domain', provenance: 'passive' }],
    ports: [P(443, 'https', 'nginx', '1.20.2', {
      fingerprints: [
        { category: 'CMS', vendor: 'Seeyon', product: '致远OA', version: 'A8', evidence: '/seeyon/ 路径特征', confidence: 0.85 },
        { category: 'Web服务器', vendor: 'nginx', product: 'nginx', version: '1.20.2', evidence: 'Server 头', confidence: 0.99 },
      ],
    })],
  },
  {
    ip: '192.0.2.10', state: 'live', primary_name: 'db.example-corp.cn', provenance: 'active', tool: 'nmap',
    names: [{ name: 'db.example-corp.cn', kind: 'domain', provenance: 'passive' }],
    ports: [
      P(3306, 'mysql', 'MySQL', '5.7.40', { fingerprints: [{ category: '数据库', vendor: 'Oracle', product: 'MySQL', version: '5.7.40', evidence: '握手包版本串', confidence: 0.98 }] }),
      P(6379, 'redis', 'Redis', '5.0.14', { fingerprints: [{ category: '缓存', vendor: 'Redis', product: 'Redis', version: '5.0.14', evidence: 'INFO 响应', confidence: 0.9 }] }),
    ],
  },
  {
    ip: '192.0.2.20', state: 'live', primary_name: 'app.example-corp.cn', provenance: 'active', tool: 'nmap',
    names: [{ name: 'app.example-corp.cn', kind: 'domain', provenance: 'passive' }],
    ports: [
      P(22, 'ssh', 'OpenSSH', '8.2p1', { fingerprints: [{ category: '远程管理', vendor: 'OpenBSD', product: 'OpenSSH', version: '8.2p1', evidence: 'SSH banner', confidence: 0.99 }] }),
      P(8080, 'http', 'Jetty', '9.4.31', { fingerprints: [{ category: '中间件', vendor: 'Eclipse', product: 'Jetty', version: '9.4.31', evidence: 'Server 头', confidence: 0.95 }] }),
    ],
  },
  { ip: '192.0.2.21', state: 'dead', primary_name: null, provenance: 'active', tool: 'nmap', names: [], ports: [] },
  { ip: '192.0.2.30', state: 'live', primary_name: null, provenance: 'active', tool: 'masscan', names: [], ports: [P(9100, 'jetdirect', 'HP Printer', null, { provenance: 'active', tool: 'masscan' })] },
  {
    ip: '198.51.100.5', state: 'live', primary_name: 'gw.example-corp.cn', provenance: 'active', tool: 'nmap',
    names: [{ name: 'gw.example-corp.cn', kind: 'domain', provenance: 'passive' }],
    ports: [
      P(443, 'https', 'Pulse Secure', '9.1R11', { fingerprints: [{ category: 'VPN网关', vendor: 'Ivanti', product: 'Pulse Secure', version: '9.1R11', evidence: '/dana-na/ 路径', confidence: 0.88 }] }),
      P(8443, 'https', 'Apache', '2.4.41', { fingerprints: [{ category: 'Web服务器', vendor: 'Apache', product: 'httpd', version: '2.4.41', evidence: 'Server 头', confidence: 0.95 }] }),
    ],
  },
  {
    ip: '198.51.100.10', state: 'live', primary_name: 'web.example-corp.cn', provenance: 'active', tool: 'nmap',
    names: [{ name: 'web.example-corp.cn', kind: 'domain', provenance: 'passive' }],
    ports: [
      P(80, 'http', 'nginx', '1.18.0', { provenance: 'passive', tool: 'crt.sh' }),
      P(443, 'https', 'nginx', '1.18.0', { fingerprints: [{ category: 'Web服务器', vendor: 'nginx', product: 'nginx', version: '1.18.0', evidence: 'Server 头', confidence: 0.99 }] }),
    ],
  },
  {
    ip: '198.51.100.20', state: 'live', primary_name: null, provenance: 'active', tool: 'masscan', names: [],
    ports: [
      P(1433, 'ms-sql-s', 'Microsoft SQL Server', '2016', { fingerprints: [{ category: '数据库', vendor: 'Microsoft', product: 'SQL Server', version: '2016', evidence: 'TDS 预登录响应', confidence: 0.85 }] }),
      P(5900, 'vnc', 'RealVNC', '5.3.2', { fingerprints: [{ category: '远程管理', vendor: 'RealVNC', product: 'VNC', version: '5.3.2', evidence: 'RFB 版本串', confidence: 0.9 }] }),
    ],
  },
  { ip: '198.51.100.30', state: 'live', primary_name: null, provenance: 'active', tool: 'nmap', names: [], ports: [P(21, 'ftp', 'vsftpd', '3.0.3', { fingerprints: [{ category: '文件服务', vendor: 'vsftpd', product: 'vsftpd', version: '3.0.3', evidence: 'FTP banner', confidence: 0.97 }] })] },
]

const EDGES = [
  { src_kind: 'segment', src_id: '203.0.113.0/24', dst_kind: 'segment', dst_id: '192.0.2.0/24', relation: 'trusts' },
  { src_kind: 'segment', src_id: '198.51.100.0/24', dst_kind: 'segment', dst_id: '192.0.2.0/24', relation: 'reaches' },
]

const req = { op: 'import', engagement: ENGAGEMENT, scan: { tool: 'demo-seed', argv: ['seed-demo.mjs'], agent_session_id: 'proto' }, segments: SEGMENTS, assets: ASSETS, edges: EDGES }
process.stdout.write(JSON.stringify(req))
