/**
 * 证据截图（shot）回归测试。
 *
 * 这块的交付承诺有三条，任何一条破了都会让"证明材料"这件事失真：
 *   ① **每个得分点最多 3 张代表图** —— 终端权限一次 60 台，逐台贴图会把面板与报告撑爆；
 *   ② **现场截图（screenshot）与生成的证据摘录（card）必须能分辨** ——
 *      把生成的卡当现场证据交出去是本功能最不能出的事，报告里要带标注；
 *   ③ **图片不进 SQLite**（库里只存文件名），且读图要走同一条受校验的桥（base64）。
 */
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { RedteamStore, dispatch } from '../lib/core.js'

let pass = 0
let fail = 0
const ok = (cond, msg) => {
  if (cond) { pass += 1; console.log('  ✓ ' + msg) } else { fail += 1; console.log('  ✗ ' + msg) }
}

/* 1×1 PNG：用来当"截图"内容，避免测试依赖外部图片文件 */
const PNG_1x1 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='

const root = mkdtempSync(join(tmpdir(), 'rt-shots-'))
const store = new RedteamStore(root)
try {
  const id = store.openEngagement('截图测试靶标', 'external').id
  store.importBundle(id, { assets: [{ ip: '10.0.0.9', scope: 'internal' }] })
  const asset = store.listAssets(id, {}).items[0]

  console.log('— 登记截图')
  const hits = []
  for (let i = 0; i < 6; i += 1) {
    const hit = store.addScoreHit(id, {
      code: 'terminal-access', points: 10, asset_id: asset.id,
      target: '10.0.0.' + (10 + i), evidence: '终端 10.0.0.' + (10 + i) + ' 取得 nt authority\\system',
    })
    hits.push(hit.hit ? hit.hit.id : hit.id)
  }
  const add = (i, kind) => store.addShot(id, {
    data_base64: PNG_1x1, kind: kind, point_code: 'terminal-access',
    hit_id: hits[i], label: '第 ' + (i + 1) + ' 台取证回显', target: '10.0.0.' + (10 + i),
    captured_at: '2026-10-07T09:1' + i + ':00.000Z', source_ref: 'runs/demo/' + i + '.png',
  })
  const s1 = add(0, 'screenshot')
  const s2 = add(1, 'screenshot')
  const s3 = add(2, 'card')
  for (let i = 3; i < 6; i += 1) add(i, 'card')
  ok(s1.ok && s1.bytes > 0, '截图登记成功（' + s1.bytes + ' 字节，sha256 ' + String(s1.sha256).slice(0, 8) + '…）')
  ok(existsSync(join(root, 'engagements', id, 'shots', s1.file)), '图片落在 <靶标>/shots/ 下（库里只存文件名）')
  ok(store.listShots(id, {}).total === 6, '六张图都进了库')
  const one = store.readShot(id, s1.id)
  ok(one.mime === 'image/png' && one.base64.length > 0, 'readShot 返回可直接显示的 data URL 内容（mime=' + one.mime + '）')

  console.log('— 每个得分点最多 3 张代表图')
  const board = store.listScorePoints(id, {})
  const point = board.items.find((x) => x.code === 'terminal-access')
  ok(point.shots.length === 3, '面板只给 3 张代表图（实际 ' + point.shots.length + '）')
  ok(point.shot_total === 6, '同时报出该得分点共有 6 张（' + point.shot_total + '）')
  ok(point.shots.filter((x) => x.kind !== 'card').length === 2,
    '代表图优先取现场截图（2 张现场 + 1 张生成）')
  ok(point.hits.some((x) => x.shot_count === 1), '命中行带上该条的截图张数')

  console.log('— 报告里嵌入截图，并标注"生成的"')
  const rep = store.scoreReport(id, {})
  ok(/!\[[^\]]*\]\([^)]+\.png\)/.test(rep.markdown), 'markdown 里有图片引用')
  ok(rep.markdown.includes('非现场截图'), '生成的证据卡在报告里被标注为"非现场截图"')
  ok(rep.summary.points > 0 && rep.markdown.includes('证据截图'), '报告摘要与正文都提到证据截图')
  const rel = store.scoreReport(id, { shotRef: 'relative' })
  ok(rel.markdown.includes('](shots/'), 'shotRef=relative 时图片走相对路径（整包拷贝可移动）')
  ok(rep.items.every((x) => (x.shots || []).length <= 3), '报告条目最多挂 3 张')
  const totalImgs = rep.items.reduce((n, x) => n + (x.shots || []).length, 0)
  const uniqImgs = new Set(rep.items.flatMap((x) => (x.shots || []).map((sh) => sh.id))).size
  ok(totalImgs <= 3, '同一个得分点在报告正文里最多出现 3 张图（实际 ' + totalImgs + '）')
  ok(uniqImgs === totalImgs, '同一张图不会在多个条目里重复贴（去重后 ' + uniqImgs + ' 张）')
  ok(rep.items.some((x) => x.shot_total === 6), '条目上带"该得分点共 6 张"的总数（面板/报告用来提示取的是代表图）')

  console.log('— 走面板那条 HTTP 桥（dispatch op）')
  const ops = [
    dispatch(store, { op: 'shots', engagement: id }),
    dispatch(store, { op: 'shotData', engagement: id, id: s2.id }),
  ]
  ok(ops[0].ok === true && ops[0].items.length === 6, 'op=shots 列出 6 张')
  ok(ops[1].ok === true && typeof ops[1].base64 === 'string' && ops[1].base64.length > 0, 'op=shotData 返回 base64（面板据此显示）')

  console.log('— 删除')
  store.deleteShot(id, s1.id)
  ok(store.listShots(id, {}).total === 5, '删掉后剩 5 张')
  ok(!existsSync(join(root, 'engagements', id, 'shots', s1.file)), '磁盘文件同时删除')

  console.log('— 兜底：图片内容不落库')
  const sizeRow = store.db(id).prepare("SELECT SUM(LENGTH(CAST(file AS BLOB))) AS n FROM shot").get()
  const dbBytes = readFileSync(store.dbPathOf(id)).length
  ok(Number(sizeRow.n) < 500 && dbBytes < 2 * 1024 * 1024,
    '库里只有文件名（名字合计 ' + sizeRow.n + ' 字节，整库 ' + dbBytes + ' 字节）')
} finally {
  try { store.close() } catch { /* 忽略 */ }
  rmSync(root, { recursive: true, force: true })
}

console.log('\n通过 ' + pass + '/' + (pass + fail))
if (fail > 0) process.exit(1)
