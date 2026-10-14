#!/usr/bin/env node
/**
 * 敏感内容闸门（零依赖）—— **禁止把演练战绩 / 战果规模 / 内网段清单 / 凭据真值写进仓库**。
 *
 * 跑法：
 *   node scripts/check-no-confidential.mjs            # 扫仓库里所有被 git 跟踪的文件
 *   node scripts/check-no-confidential.mjs --staged   # 只扫暂存区（pre-commit 钩子用）
 *   node scripts/check-no-confidential.mjs --all      # 连未跟踪文件一起扫（提交前自查）
 *   node scripts/check-no-confidential.mjs --selftest # 用内置样例证明规则没被改瞎
 *
 * 为什么单独一个脚本：① 提交前要能拦（`.githooks/pre-commit` 调它）；
 * ② 回归测试要能验它本身有效；③ CI / 人工自查用同一条命令，避免三套口径各说各话。
 *
 * ## 背景（真实事故，2026-10-12）
 * 仓库根 README 里一度写进一份战绩统计（N 家靶标单位、资产/端口/漏洞总数、
 * 私网段数、逐单位一行），另有一份 `docs/<战绩>.md`。单位名虽然换成了「行业-编号」，
 * 但**成果规模 + 内网段 + 逐单位明细**组合起来就是演练实盘底账 —— 脱敏只挡住了
 * "是谁"，没挡住"打成什么样"。修复只能改写 git 历史（公开仓库推送即发布，无法撤回）。
 * 所以把它变成硬约束：**这类内容一律不入库**；要留档放仓库外（见 README「数据与隐私」）。
 *
 * ## 判定口径（宁少勿滥，只认"记录形态"而不是单个词）
 * 只扫描**非代码文件**（.md/.yml/.yaml/.json/.txt/.csv/.tsv）—— 源码里的示例 IP、
 * `secret_value = COALESCE(...)` 这类 SQL 不该误报；且 `skills/` 下的技能文档是
 * **面向使用者的操作手册**，必须能写 `<你的VPS>`、示例网段与命令，故整体豁免。
 *
 *   A 战果口径词 + 记录形态：战绩/战果 + 统计/汇总/总览/清单/明细；
 *     以及「本次/本期/累计 战绩」这类总结口吻。
 *   B 战果规模数字：N 家（靶标）单位 / N 条漏洞 / N 个内网段 /
 *     N 组凭据 / N 次得分命中 / 资产 · 端口 · 漏洞 同表出现（成果表）。
 *   C 逐单位表：markdown 表头里同时出现 单位 与 资产/端口/漏洞/得分 这类列。
 *   D 内网段清单：同一文件 ≥5 个不同私网 C 段（说明是清单，不是举例）。
 *   E 凭据真值：YAML/front-matter 里 password/pass_key/secret_value 的值
 *     看起来像真值（≥8 位且非占位符）。
 *
 * **允许**（不拦）：单个私网段举例、`<靶标单位>` 这类占位符、示例域名
 * （example.com / 192.0.2.0/24 等保留段）、本机 VPS 公网 IP、字段名与 SQL。
 */
import { readFileSync, existsSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { dirname, join, extname } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const repo = join(here, '..')
const args = process.argv.slice(2)
const stagedOnly = args.includes('--staged')
const includeUntracked = args.includes('--all')
const selfTest = args.includes('--selftest')

/** 只扫非代码文件：这类内容以文档/清单形态出现，源码里的示例不该误报。 */
const EXTS = new Set(['.md', '.yml', '.yaml', '.json', '.txt', '.csv', '.tsv'])
/** 永不扫描：依赖/生成物/自指豁免（规则正文必须能写出模式词）。 */
const SKIP = [
  /(^|\/)\.git\//, /(^|\/)node_modules\//, /(^|\/)\.playwright-cli\//,
  /(^|\/)skills\//,                                  /* 面向使用者的操作手册，含示例网段与占位符 */
  /^scripts\/check-no-confidential\.mjs$/,
]

/**
 * 规则说明文档白名单：**只豁免"关键词 / 表格形态"这两类**（A 类与 C 类）。
 *
 * 为什么必须留这个口子：讲清"什么不得入库"就得能写出那些词本身（README 的约束表、
 * 详细文档 5.1 节）。但豁免范围严格受限 —— **B 类（战果规模数字）、D 类（内网段清单）、
 * E 类（凭据真值）对白名单文件照样全量检查**，所以"把战绩数据塞进 README"依然会被拦
 * （回归测试 no-confidential.test.mjs 里专门有这条：README.md 里写「本次演练共 22 家
 * 靶标单位」必须命中）。
 */
const RULE_DOCS = new Set(['README.md', 'docs/详细文档.md'])

/** A 类：战果口径词（要求"总结形态"，不拦"漏洞战果"这类功能名）。 */
const HEADLINE = [
  { re: /战\s*绩/, why: '「战绩」类成果口径' },
  { re: /战果(统计|汇总|总览|清单|报表|明细)/, why: '战果统计口径' },
  { re: /(本次|本期|累计|历史)\s*战果/, why: '战果总结口吻' },
  { re: /逐单位(战绩|明细|统计)/, why: '逐单位成果明细' },
]
/**
 * B 类：战果规模数字。
 * 写法上刻意**不用**带 `*` 的字符类与 `(?:...)?段` 这种组合 —— 实测在长模式里
 * 与中国字混排时匹配行为不可预期；改成"数字 + 简单量词 + 明确列举"，可读也可验。
 */
const NUMBERS = [
  { re: /\d+\s*\**\s*家\s*\**\s*(?:靶标)?\s*单位/, why: '战果规模：N 家（靶标）单位' },
  { re: /发现漏洞\s*\d+\s*条|\d+\s*条\s*漏洞[（(]/, why: '战果规模：漏洞条数' },
  { re: /\d+\s*\**\s*个\s*\**\s*(?:私网|内网)(?:\s*C\s*段|\s*网段)/, why: '战果规模：内网段数' },
  /* 两种语序都要认：「306 组凭据」与「拿下凭据 306 组」 */
  { re: /\d+\s*\**\s*[组个]\s*\**\s*凭据|凭据\s*\**\s*\d+|\d+\s*\**\s*次\s*\**\s*得分命中|\d+\s*\**\s*个\s*\**\s*可控会话/, why: '战果规模：凭据/命中/会话数' },
  { re: /发现资产[^\n]{0,8}\d+\s*\**\s*个|\d+\s*\**\s*个\s*\**\s*资产[（(]/, why: '战果规模：资产数' },
]
/** C 类：逐单位成果表（markdown 表头）。 */
const PER_UNIT_TABLE = /\|\s*(靶标)?\s*单位\s*\|[^\n]*\|\s*(资产|端口|漏洞|得分|凭据|内网段)\s*\|/
/** D 类：内网段清单（≥5 个不同私网 C 段）。 */
const PRIVATE_CIDR = /\b(?:10|192\.168|172\.(?:1[6-9]|2\d|3[01]))\.\d{1,3}\.\d{1,3}\b/g
/** 保留给文档的示例段（RFC5737 等），不算真实资产。 */
const DOC_RANGES = /^(?:192\.0\.2|198\.51\.100|203\.0\.113|10\.0\.0|192\.168\.1|172\.16\.0)\./
/** E 类：凭据真值（只在 yml/yaml/json 与 front-matter 里判，避免 SQL/字段名误报）。 */
const SECRET_LINE = /^\s*(?:secret_value|pass_key|password|passwd|pass|token|apikey|api_key)\s*:\s*['"]?([^\s'"]{8,})/i
const PLACEHOLDER = /^(?:x+|\*+|-+|foo|bar|baz|test|demo|example|sample|changeme|placeholder|your.*|<.*>|\{\{.*\}\}|\.\.\.|…|null|none|undefined|true|false|password|passwd|toor|root)$/i

/** 读要扫的文件列表。 */
function filesToScan() {
  const env = { ...process.env, GIT_OPTIONAL_LOCKS: '0' }
  const run = (a) => execFileSync('git', a, { cwd: repo, encoding: 'utf8', env }).split('\n').filter(Boolean)
  let list = stagedOnly
    ? run(['diff', '--cached', '--name-only', '--diff-filter=ACMR'])
    : run(['ls-files'])
  if (!stagedOnly && includeUntracked) list = list.concat(run(['ls-files', '--others', '--exclude-standard']))
  return Array.from(new Set(list))
    .filter((f) => EXTS.has(extname(f)))
    .filter((f) => !SKIP.some((re) => re.test(f)))
}

/**
 * 扫一段文本，返回问题列表（纯函数：单测与 --selftest 都用它）。
 * @param rel - 相对路径（仅用于报告与扩展名判断）。
 * @param text - 文本内容。
 */
export function scanText(rel, text) {
  const out = []
  const ext = extname(rel)
  const lines = text.split('\n')
  const cidrs = new Set()
  /* 规则说明文档只豁免 A/C 两类（见 RULE_DOCS 注释）；数字/内网段/凭据照查 */
  const ruleDoc = RULE_DOCS.has(rel)
  lines.forEach((line, i) => {
    const at = `${rel}:${i + 1}`
    const snippet = line.trim().slice(0, 120)
    if (!ruleDoc) {
      for (const { re, why } of HEADLINE) if (re.test(line)) out.push({ at, why, snippet })
      if (PER_UNIT_TABLE.test(line)) out.push({ at, why: '逐单位成果表（表头含"单位 + 资产/漏洞/得分"）', snippet })
    }
    for (const { re, why } of NUMBERS) if (re.test(line)) out.push({ at, why, snippet })
    PRIVATE_CIDR.lastIndex = 0
    let m
    while ((m = PRIVATE_CIDR.exec(line)) !== null) {
      const cidr = m[0]
      if (!DOC_RANGES.test(cidr) && !/示例|例如|比如|举例|for example|e\.g\./i.test(line)) cidrs.add(cidr)
    }
    if (/\.(?:ya?ml|json)$/.test(ext)) {
      const s = SECRET_LINE.exec(line)
      if (s !== null && !PLACEHOLDER.test(s[1])) out.push({ at, why: '疑似凭据真值（键值对里像真口令）', snippet })
    }
  })
  if (cidrs.size >= 5) {
    out.push({ at: rel, why: `同一文件出现 ${cidrs.size} 个不同私网 C 段（疑似内网段清单）`, snippet: Array.from(cidrs).slice(0, 6).join('、') })
  }
  return out
}

/* --selftest：证明规则能拦下真实事故里的形态（回归测试也调它，防止规则被改瞎） */
if (selfTest) {
  const mustCatch = [
    ['A 战绩标题', 'docs/战绩总览.md', '## 一、总体战绩\n| 指标 | 数量 |\n'],
    ['A 战果统计', 'docs/x.md', '## 战果统计\n本次演练共……'],
    ['B 家单位', 'README.md', '本次演练共 **22** 家靶标单位'],
    ['B 家单位（裸写）', 'a.md', '打完 22 家单位'],
    ['B 漏洞条数', 'a.md', '发现漏洞 1069 条（高危 501 条）'],
    ['B 内网段数', 'a.md', '命中内网 **118** 个私网 C 段'],
    ['B 内网网段', 'a.md', '挖出 118 个内网网段'],
    ['B 凭据数', 'a.md', '拿下凭据 306 组'],
    ['B 得分命中', 'a.md', '本次演练共 386 次得分命中'],
    ['C 逐单位表', 'a.md', '| 单位 | 资产 | 端口 | 漏洞 | 得分 |'],
    ['D 内网段清单', 'a.md', '10.18.44.0、10.18.46.0、10.26.7.0、10.30.199.0、10.21.242.0、192.168.111.0'],
    ['E 凭据真值', 'preset/x.yml', 'pass_key: Nj@Gd2026#neo7'],
    /* 白名单文件只豁免关键词/表格：数字与凭据照样拦（防止"往 README 里塞数据"绕过闸门） */
    ['白名单文件里的战果数字', 'README.md', '本次演练共 22 家靶标单位'],
    /* 凭据真值只对 yml/json/front-matter 判（文档里没法区分"举例"与"真值"） */
    ['白名单目录下的凭据真值', 'docs/example.yml', 'password: Xjnt@2023-abc'],
  ]
  const mustPass = [
    ['功能名不拦', 'docs/详细文档.md', '| 漏洞战果 | 按严重级排序 |'],
    ['单个私网段举例', 'docs/详细文档.md', '内网段示例：10.0.0.0/24'],
    ['保留段', 'a.md', '示例资产 192.0.2.10、198.51.100.7'],
    ['占位符', 'preset/x.yml', 'password: <你的口令>'],
    ['源码 SQL（非文档扩展名，本不扫）', 'src.js', 'secret_value = COALESCE(excluded.secret_value, credential.secret_value)'],
  ]
  let bad = 0
  for (const [label, rel, text] of mustCatch) {
    const hit = scanText(rel, text)
    if (hit.length === 0) { bad += 1; console.error(`  ✗ 该拦没拦：${label}`) } else console.log(`  ✓ 拦下：${label}（${hit[0].why}）`)
  }
  for (const [label, rel, text] of mustPass) {
    const hit = scanText(rel, text)
    if (hit.length > 0) { bad += 1; console.error(`  ✗ 误报：${label} → ${hit[0].why}`) } else console.log(`  ✓ 放行：${label}`)
  }
  console.log(bad === 0 ? '\n✓ 自检通过（14 拦 5 放）' : `\n✗ 自检失败 ${bad} 项`)
  process.exit(bad === 0 ? 0 : 1)
}

const files = filesToScan()
const problems = []
for (const rel of files) {
  const abs = join(repo, rel)
  if (!existsSync(abs)) continue
  let text
  try { text = readFileSync(abs, 'utf8') } catch { continue }
  problems.push(...scanText(rel, text))
}

const label = stagedOnly ? '暂存区' : (includeUntracked ? '工作区（含未跟踪）' : '已跟踪文件')
if (problems.length === 0) {
  console.log(`✓ 敏感内容闸门通过（${label}，扫描 ${files.length} 个文件）`)
  process.exit(0)
}
console.error(`\n✗ 敏感内容闸门未通过：发现 ${problems.length} 处疑似演练战绩/敏感信息（${label}）\n`)
for (const p of problems) console.error(`  · ${p.at}\n      ${p.why}\n      ${p.snippet}`)
console.error(`
演练战绩、战果规模数字、内网段清单、凭据真值**一律不入库** —— 仓库是公开的，推送即发布。
要留档请放仓库外（例如 ~/redteam-战绩.md）并确认不在本仓库目录内。
必须在本仓库讨论这类内容时，用"占位符 + 结构说明"写法：
  单位：<靶标单位>   规模：<N> 家   内网段：<私网 C 段>（示例：10.0.0.0/24）
规则与背景见 README「数据与隐私」；自查跑 node scripts/check-no-confidential.mjs --all
`)
process.exit(1)
