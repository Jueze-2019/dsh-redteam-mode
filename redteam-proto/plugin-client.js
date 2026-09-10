const h = React.createElement

/*
 * RedTeam 常驻面板（Client 半侧）
 *
 * 落点：shell.overlay（frame 内 position:absolute;inset:0 的浮动层，带稳定属性
 * data-shell-overlay）。面板本身是绝对定位的右侧栏；当它打开且详情栏关闭时，
 * 用 :has() 给 frame 加 padding-right，让中栏（1fr）主动收窄，因此面板常驻但
 * 不遮挡对话。详情栏打开时（frame 失去 data-details-collapsed）面板滑出隐藏，
 * 把宽度让回工具详情。
 */
const CSS = `
:root{--rt-dock-w:620px}
div:has(> [data-shell-overlay] .rt-dock[data-open="1"])[data-details-collapsed]{padding-right:var(--rt-dock-w)}
.rt-dock{position:absolute;top:0;right:0;bottom:0;z-index:20;display:flex;flex-direction:column;
  background:var(--dsw-alias-bg-layer-1);border-left:1px solid var(--dsw-alias-border-l1);
  box-shadow:-12px 0 32px rgba(0,0,0,.14);pointer-events:auto;color:var(--dsw-alias-label-primary);
  font-size:13px;line-height:1.5;transition:transform .18s ease,opacity .18s ease}
div:has(> [data-shell-overlay] .rt-dock[data-open="1"]):not([data-details-collapsed]) .rt-dock{
  transform:translateX(100%);opacity:0;pointer-events:none}
.rt-grip{position:absolute;left:-3px;top:0;bottom:0;width:6px;cursor:col-resize;background:transparent;z-index:2}
.rt-head{display:flex;align-items:center;gap:8px;padding:10px 12px;border-bottom:1px solid var(--dsw-alias-border-l1)}
.rt-title{font-weight:600;font-size:14px;display:flex;align-items:center;gap:6px;white-space:nowrap}
.rt-dot{width:8px;height:8px;border-radius:50%;background:var(--dsw-alias-brand-primary)}
.rt-spacer{flex:1}
.rt-btn{border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-2);color:inherit;
  border-radius:6px;padding:3px 9px;font-size:12px;cursor:pointer;font-family:inherit;white-space:nowrap}
.rt-btn:hover{border-color:var(--dsw-alias-border-l2)}
.rt-btn-primary{background:var(--dsw-alias-brand-primary);border-color:var(--dsw-alias-brand-primary);color:#fff}
.rt-btn-primary:hover{opacity:.9}
.rt-btn:disabled{opacity:.5;cursor:default}
.rt-tabs{display:flex;gap:4px;padding:8px 12px 0;border-bottom:1px solid var(--dsw-alias-border-l1)}
.rt-tab{padding:6px 12px;border-radius:6px 6px 0 0;cursor:pointer;font-size:12.5px;color:var(--dsw-alias-label-secondary)}
.rt-tab.on{color:var(--dsw-alias-label-primary);background:var(--dsw-alias-bg-layer-2);font-weight:600}
.rt-body{flex:1;min-height:0;display:flex;flex-direction:column}
.rt-split{flex:1;min-height:0;display:flex}
.rt-side{width:200px;flex:none;border-right:1px solid var(--dsw-alias-border-l1);overflow:auto;padding:8px}
.rt-main{flex:1;min-width:0;display:flex;flex-direction:column;overflow:hidden}
.rt-seg{padding:7px 8px;border-radius:6px;cursor:pointer;margin-bottom:4px;border:1px solid transparent}
.rt-seg:hover{background:var(--dsw-alias-bg-layer-2)}
.rt-seg.on{background:var(--dsw-alias-bg-layer-2);border-color:var(--dsw-alias-brand-primary)}
.rt-seg-cidr{font-family:ui-monospace,Menlo,monospace;font-size:12.5px}
.rt-seg-meta{font-size:11px;color:var(--dsw-alias-label-secondary);margin-top:2px}
.rt-toolbar{display:flex;gap:6px;padding:8px 10px;border-bottom:1px solid var(--dsw-alias-border-l1);flex-wrap:wrap;align-items:center}
.rt-input{background:var(--dsw-alias-bg-layer-2);border:1px solid var(--dsw-alias-border-l1);color:inherit;
  border-radius:6px;padding:4px 8px;font-size:12px;font-family:inherit;outline:none;min-width:0}
.rt-input:focus{border-color:var(--dsw-alias-brand-primary)}
.rt-table{flex:1;overflow:auto}
.rt-row{display:grid;grid-template-columns:120px 58px 92px 1fr 1fr 88px;gap:8px;padding:6px 10px;
  border-bottom:1px solid var(--dsw-alias-border-l1);align-items:center;cursor:pointer;font-size:12.5px}
.rt-row:hover{background:var(--dsw-alias-bg-layer-2)}
.rt-row.head{cursor:default;color:var(--dsw-alias-label-secondary);font-size:11.5px;font-weight:600;position:sticky;top:0;
  background:var(--dsw-alias-bg-layer-1);z-index:1}
.rt-row.head:hover{background:var(--dsw-alias-bg-layer-1)}
.rt-mono{font-family:ui-monospace,Menlo,monospace}
.rt-tag{display:inline-block;padding:0 5px;border-radius:4px;font-size:11px;margin-right:4px;
  border:1px solid var(--dsw-alias-border-l1);color:var(--dsw-alias-label-secondary);white-space:nowrap}
.rt-tag-passive{color:#8b5cf6;border-color:#8b5cf655;background:#8b5cf61a}
.rt-tag-active{color:#f59e0b;border-color:#f59e0b55;background:#f59e0b1a}
.rt-tag-live{color:#10b981;border-color:#10b98155;background:#10b9811a}
.rt-tag-dead{color:var(--dsw-alias-label-secondary)}
.rt-expand{grid-column:1/-1;padding:8px 4px 10px;font-size:12px;color:var(--dsw-alias-label-secondary)}
.rt-kv{display:flex;gap:8px;margin-bottom:3px;align-items:baseline}
.rt-kv b{color:var(--dsw-alias-label-primary);font-weight:600;min-width:64px;flex:none}
.rt-graphwrap{flex:1;position:relative;overflow:hidden}
.rt-graph{width:100%;height:100%;display:block}
.rt-legend{position:absolute;left:10px;bottom:10px;display:flex;gap:10px;font-size:11px;
  background:var(--dsw-alias-bg-overlay);border:1px solid var(--dsw-alias-border-l1);border-radius:6px;padding:5px 8px}
.rt-legend i{display:inline-block;width:8px;height:8px;border-radius:50%;margin-right:4px}
.rt-pane{flex:1;overflow:auto;padding:12px}
.rt-card{border:1px solid var(--dsw-alias-border-l1);border-radius:8px;padding:10px;margin-bottom:10px;background:var(--dsw-alias-bg-layer-2)}
.rt-card h4{margin:0 0 6px;font-size:13px}
.rt-textarea{width:100%;min-height:260px;background:var(--dsw-alias-bg-base);border:1px solid var(--dsw-alias-border-l1);
  color:inherit;border-radius:6px;padding:8px;font-size:12.5px;font-family:ui-monospace,Menlo,monospace;
  line-height:1.6;resize:vertical;outline:none;box-sizing:border-box}
.rt-textarea:focus{border-color:var(--dsw-alias-brand-primary)}
.rt-list{width:210px;flex:none;border-right:1px solid var(--dsw-alias-border-l1);overflow:auto;padding:8px}
.rt-item{padding:7px 8px;border-radius:6px;cursor:pointer;margin-bottom:4px;border:1px solid transparent}
.rt-item:hover{background:var(--dsw-alias-bg-layer-2)}
.rt-item.on{background:var(--dsw-alias-bg-layer-2);border-color:var(--dsw-alias-brand-primary)}
.rt-item-name{font-weight:600;font-size:12.5px}
.rt-item-desc{font-size:11px;color:var(--dsw-alias-label-secondary);margin-top:2px;
  display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}
.rt-empty{padding:24px;text-align:center;color:var(--dsw-alias-label-secondary);font-size:12.5px}
.rt-err{color:var(--dsw-alias-state-error-primary);font-size:12px;padding:6px 10px}
.rt-foot{padding:8px 12px;border-top:1px solid var(--dsw-alias-border-l1);font-size:11px;
  color:var(--dsw-alias-label-secondary);display:flex;gap:12px;flex-wrap:wrap;align-items:center}
.rt-icon-btn{display:flex;align-items:center;justify-content:center;gap:6px;width:100%;border:1px solid var(--dsw-alias-border-l1);
  background:transparent;color:inherit;border-radius:6px;padding:6px 8px;cursor:pointer;font-family:inherit;font-size:12.5px}
.rt-icon-btn:hover{background:var(--dsw-alias-bg-layer-2)}
.rt-icon-btn.on{border-color:var(--dsw-alias-brand-primary);color:var(--dsw-alias-brand-primary)}
.rt-hbtn{border:1px solid var(--dsw-alias-border-l1);background:transparent;color:inherit;border-radius:6px;
  padding:2px 8px;font-size:12px;cursor:pointer;font-family:inherit;display:flex;align-items:center;gap:5px}
.rt-hbtn:hover{background:var(--dsw-alias-bg-layer-2)}
.rt-hbtn.on{border-color:var(--dsw-alias-brand-primary);color:var(--dsw-alias-brand-primary)}
`

return {
  apply(ctx) {
    const slots = ctx.get('slots')
    if (slots === undefined) return
    ctx.effect(() => styles.insert(CSS))

    /* ---------------------------------------------------------- 共享 UI 状态 */
    let ui = { open: true, tab: 'assets' }
    const subs = new Set()
    const setUI = (patch) => {
      ui = Object.assign({}, ui, patch)
      for (const f of Array.from(subs)) f()
    }
    const useUI = () => {
      const [, force] = React.useReducer((x) => x + 1, 0)
      React.useEffect(() => {
        const f = () => force()
        subs.add(f)
        return () => { subs.delete(f) }
      }, [])
      return ui
    }

    const call = (req) => host.call('redteam/request', req)
    const fmt = (s) => (s ? String(s).replace('T', ' ').slice(0, 16) : '—')
    const provLabel = (p) => (p === 'passive' ? '被动' : p === 'active' ? '主动' : '未知')

    function ProvTag(props) {
      if (!props.p) return h('span', { className: 'rt-tag' }, '未知')
      return h('span', { className: 'rt-tag rt-tag-' + props.p }, provLabel(props.p))
    }

    /* ---------------------------------------------------------- 资产测绘 */
    function AssetsTab(props) {
      const eng = props.engagement
      const snapshot = props.snapshot
      const [view, setView] = React.useState('list')
      const [cidr, setCidr] = React.useState(null)
      const [q, setQ] = React.useState('')
      const [qApplied, setQApplied] = React.useState('')
      const [service, setService] = React.useState('')
      const [port, setPort] = React.useState('')
      const [prov, setProv] = React.useState('')
      const [state, setState] = React.useState({ loading: false, error: null, total: 0, items: [] })
      const [graphState, setGraphState] = React.useState({ loading: false, data: null, error: null })
      const [openId, setOpenId] = React.useState(null)
      const [detail, setDetail] = React.useState(null)
      const seq = React.useRef(0)

      React.useEffect(() => {
        if (!eng) return
        const my = ++seq.current
        setState((s) => Object.assign({}, s, { loading: true, error: null }))
        call({
          op: 'assets', engagement: eng, cidr: cidr || undefined, q: qApplied || undefined,
          service: service || undefined, port: port || undefined,
          provenance: prov || undefined, limit: 400,
        }).then((r) => {
          if (my !== seq.current) return
          if (!r || r.ok === false) {
            setState({ loading: false, error: (r && r.error) || '查询失败', total: 0, items: [] })
            return
          }
          setState({ loading: false, error: null, total: r.total, items: r.items || [] })
        }, (e) => {
          if (my === seq.current) setState({ loading: false, error: String((e && e.message) || e), total: 0, items: [] })
        })
      }, [eng, cidr, qApplied, service, port, prov])

      React.useEffect(() => {
        if (!eng || view !== 'graph') return
        setGraphState((s) => Object.assign({}, s, { loading: true, error: null }))
        call({ op: 'graph', engagement: eng, cidr: cidr || undefined }).then((r) => {
          if (!r || r.ok === false) {
            setGraphState({ loading: false, data: null, error: (r && r.error) || '图谱加载失败' })
            return
          }
          setGraphState({ loading: false, data: { nodes: r.nodes || [], edges: r.edges || [] }, error: null })
        }, (e) => setGraphState({ loading: false, data: null, error: String((e && e.message) || e) }))
      }, [eng, view, cidr])

      const toggleRow = (id) => {
        if (openId === id) { setOpenId(null); setDetail(null); return }
        setOpenId(id)
        setDetail(null)
        call({ op: 'asset', engagement: eng, id: id }).then((r) => {
          if (r && r.ok && r.asset) setDetail(r.asset)
        }, () => {})
      }

      const segs = (snapshot && snapshot.segments) || []

      const sideChildren = []
      sideChildren.push(h('div', {
        key: 'all', className: 'rt-seg' + (cidr ? '' : ' on'), onClick: () => setCidr(null),
      },
        h('div', { className: 'rt-seg-cidr' }, '全部 C 段'),
        h('div', { className: 'rt-seg-meta' }, segs.length + ' 个网段')))
      for (const s of segs) {
        sideChildren.push(h('div', {
          key: s.cidr, className: 'rt-seg' + (cidr === s.cidr ? ' on' : ''),
          onClick: () => setCidr(s.cidr),
        },
          h('div', { className: 'rt-seg-cidr' }, s.cidr),
          h('div', { className: 'rt-seg-meta' }, (s.org || '未知归属') + ' · ' + s.assets + ' 资产 · ' + s.open_ports + ' 端口'),
          h('div', { className: 'rt-seg-meta' },
            h('span', { className: 'rt-tag rt-tag-passive' }, '被动 ' + s.passive_ports),
            h('span', { className: 'rt-tag rt-tag-active' }, '主动 ' + s.active_ports))))
      }
      const side = h('div', { className: 'rt-side' }, sideChildren)

      const toolbar = h('div', { className: 'rt-toolbar' },
        h('input', {
          className: 'rt-input', style: { flex: '1 1 150px' }, placeholder: '搜索 IP / 域名 / 指纹（回车）',
          value: q, onChange: (e) => setQ(e.target.value),
          onKeyDown: (e) => { if (e.key === 'Enter') setQApplied(q) },
        }),
        h('button', { className: 'rt-btn', onClick: () => setQApplied(q) }, '搜索'),
        h('input', {
          className: 'rt-input', style: { width: '78px' }, placeholder: '服务',
          value: service, onChange: (e) => setService(e.target.value),
        }),
        h('input', {
          className: 'rt-input', style: { width: '60px' }, placeholder: '端口',
          value: port, onChange: (e) => setPort(e.target.value),
        }),
        h('select', { className: 'rt-input', value: prov, onChange: (e) => setProv(e.target.value) },
          h('option', { value: '' }, '来源不限'),
          h('option', { value: 'passive' }, '仅被动'),
          h('option', { value: 'active' }, '仅主动')),
        h('div', { className: 'rt-spacer' }),
        h('button', { className: 'rt-btn' + (view === 'list' ? ' rt-btn-primary' : ''), onClick: () => setView('list') }, '列表'),
        h('button', { className: 'rt-btn' + (view === 'graph' ? ' rt-btn-primary' : ''), onClick: () => setView('graph') }, '图谱'))

      const head = h('div', { className: 'rt-row head' },
        h('span', null, 'IP'), h('span', null, '状态'), h('span', null, '来源'),
        h('span', null, '开放端口 / 服务'), h('span', null, '指纹'), h('span', null, '首见'))

      const rowNodes = []
      for (const it of state.items) {
        const openPorts = it.ports.filter((p) => p.state === 'open')
        const portText = openPorts.map((p) => p.port + (p.service ? '/' + p.service : '')).join(', ') || '—'
        const fpText = it.fingerprints.map((f) => [f.vendor, f.product, f.version].filter(Boolean).join(' ')).join(' / ') || '—'
        rowNodes.push(h('div', {
          key: 'r' + it.id, className: 'rt-row', onClick: () => toggleRow(it.id),
        },
          h('span', { className: 'rt-mono' }, it.ip),
          h('span', null, h('span', {
            className: 'rt-tag rt-tag-' + (it.state === 'live' ? 'live' : 'dead'),
          }, it.state === 'live' ? '存活' : it.state)),
          h('span', null,
            it.passive ? h('span', { className: 'rt-tag rt-tag-passive' }, '被动 ' + it.passive) : null,
            it.active ? h('span', { className: 'rt-tag rt-tag-active' }, '主动 ' + it.active) : null),
          h('span', { title: portText }, portText.length > 40 ? portText.slice(0, 40) + '…' : portText),
          h('span', { title: fpText }, fpText.length > 34 ? fpText.slice(0, 34) + '…' : fpText),
          h('span', null, fmt(it.first_seen))))

        if (openId !== it.id) continue
        const d = detail && detail.id === it.id ? detail : null
        const portRows = []
        const fpRows = []
        const obsRows = []
        if (d) {
          for (const p of (d.ports || [])) {
            if (p.state !== 'open') continue
            portRows.push(h('div', { key: 'p' + p.port, className: 'rt-kv' },
              h('b', { className: 'rt-mono' }, p.port + '/' + p.proto),
              h('span', null, [p.service, p.product, p.version].filter(Boolean).join(' ') || '未知服务'),
              h(ProvTag, { p: p.provenance })))
          }
          for (const f of (d.fingerprints || [])) {
            fpRows.push(h('div', { key: 'f' + (f.product || '') + (f.version || '') + (f.evidence || ''), className: 'rt-kv' },
              h('b', null, f.category || '—'),
              h('span', null, [f.vendor, f.product, f.version].filter(Boolean).join(' ') + (f.evidence ? '（' + f.evidence + '）' : '')),
              h(ProvTag, { p: f.provenance })))
          }
          for (const o of (d.observations || []).slice(0, 8)) {
            obsRows.push(h('div', { key: 'o' + (o.attr || '') + (o.value || '') + (o.collected_at || ''), className: 'rt-kv' },
              h('b', null, o.attr || '—'),
              h('span', null, (o.value || '') + ' · ' + (o.tool || '未知工具') + ' · ' + fmt(o.collected_at)),
              h(ProvTag, { p: o.provenance })))
          }
        }
        const inner = d
          ? h('div', null,
              h('div', { className: 'rt-kv' }, h('b', null, '主机名'), h('span', null, (d.names || []).map((n) => n.name).join(', ') || '—')),
              h('div', { className: 'rt-kv' }, h('b', null, 'C 段'), h('span', null, d.segment_cidr)),
              h('div', { className: 'rt-kv' }, h('b', null, '时间'), h('span', null, '首见 ' + fmt(d.first_seen) + ' · 末见 ' + fmt(d.last_seen))),
              h('div', { style: { margin: '6px 0 3px', fontWeight: 600 } }, '开放端口 / 服务'),
              h('div', null, portRows.length ? portRows : '—'),
              h('div', { style: { margin: '6px 0 3px', fontWeight: 600 } }, '指纹'),
              h('div', null, fpRows.length ? fpRows : '—'),
              h('div', { style: { margin: '6px 0 3px', fontWeight: 600 } }, '采集溯源（最近 8 条）'),
              h('div', null, obsRows.length ? obsRows : '—'))
          : h('div', null, '加载中…')
        rowNodes.push(h('div', {
          key: 'd' + it.id, className: 'rt-row',
          style: { cursor: 'default', gridTemplateColumns: '1fr' },
        }, h('div', { className: 'rt-expand' }, inner)))
      }

      const listPane = h('div', { className: 'rt-table' }, head, rowNodes,
        !state.loading && !state.items.length ? h('div', { className: 'rt-empty' }, '没有匹配的资产') : null)

      const graphPane = h('div', { className: 'rt-graphwrap' },
        graphState.data
          ? h(GraphCanvas, { data: graphState.data })
          : h('div', { className: 'rt-empty' }, graphState.loading ? '图谱加载中…' : (graphState.error || '暂无数据')),
        h('div', { className: 'rt-legend' },
          h('span', null, h('i', { style: { background: '#6366f1' } }), 'C 段'),
          h('span', null, h('i', { style: { background: '#10b981' } }), '存活资产'),
          h('span', null, h('i', { style: { background: '#9ca3af' } }), '离线资产'),
          h('span', null, h('i', { style: { background: '#f59e0b' } }), '开放端口')))

      return h('div', { className: 'rt-split' }, side,
        h('div', { className: 'rt-main' }, toolbar,
          state.error ? h('div', { className: 'rt-err' }, state.error) : null,
          view === 'list' ? listPane : graphPane))
    }

    /* ---------------------------------------------------------- 图谱画布 */
    function GraphCanvas(props) {
      const ref = React.useRef(null)
      React.useEffect(() => {
        const canvas = ref.current
        if (!canvas || !props.data) return
        const rect = canvas.getBoundingClientRect()
        const W = Math.max(320, rect.width)
        const H = Math.max(240, rect.height)
        const dpr = window.devicePixelRatio || 1
        canvas.width = Math.floor(W * dpr)
        canvas.height = Math.floor(H * dpr)
        const g = canvas.getContext('2d')
        g.setTransform(dpr, 0, 0, dpr, 0, 0)

        const kindColor = { segment: '#6366f1', asset: '#10b981', port: '#f59e0b', domain: '#8b5cf6' }
        const nodes = props.data.nodes.map((n, i) => {
          const a = (i / Math.max(1, props.data.nodes.length)) * Math.PI * 2
          return Object.assign({}, n, {
            x: W / 2 + Math.cos(a) * Math.min(W, H) * 0.32,
            y: H / 2 + Math.sin(a) * Math.min(W, H) * 0.32,
            vx: 0, vy: 0,
            r: n.kind === 'segment' ? 13 : n.kind === 'asset' ? 7 : 4.5,
          })
        })
        const byId = new Map(nodes.map((n) => [n.id, n]))
        const links = props.data.edges
          .map((e) => ({ s: byId.get(e.source), t: byId.get(e.target), r: e.relation }))
          .filter((l) => l.s && l.t)

        let raf = null
        let ticks = 0
        const tick = () => {
          ticks++
          for (let i = 0; i < nodes.length; i++) {
            const a = nodes[i]
            for (let j = i + 1; j < nodes.length; j++) {
              const b = nodes[j]
              let dx = b.x - a.x
              let dy = b.y - a.y
              let d2 = dx * dx + dy * dy
              if (d2 < 1) { d2 = 1; dx = Math.random() - 0.5; dy = Math.random() - 0.5 }
              const d = Math.sqrt(d2)
              const rep = 1400 / d2
              const fx = (dx / d) * rep
              const fy = (dy / d) * rep
              a.vx -= fx; a.vy -= fy; b.vx += fx; b.vy += fy
            }
          }
          for (const l of links) {
            const dx = l.t.x - l.s.x
            const dy = l.t.y - l.s.y
            const d = Math.max(1, Math.sqrt(dx * dx + dy * dy))
            const target = l.s.kind === 'segment' ? 110 : 62
            const f = (d - target) * 0.035
            const fx = (dx / d) * f
            const fy = (dy / d) * f
            l.s.vx += fx; l.s.vy += fy; l.t.vx -= fx; l.t.vy -= fy
          }
          for (const n of nodes) {
            n.vx += (W / 2 - n.x) * 0.004
            n.vy += (H / 2 - n.y) * 0.004
            n.vx *= 0.82; n.vy *= 0.82
            n.x = Math.max(24, Math.min(W - 24, n.x + n.vx))
            n.y = Math.max(24, Math.min(H - 24, n.y + n.vy))
          }
          g.clearRect(0, 0, W, H)
          g.lineWidth = 1
          for (const l of links) {
            g.strokeStyle = l.r === 'contains' ? 'rgba(99,102,241,.30)' : 'rgba(148,163,184,.35)'
            g.beginPath()
            g.moveTo(l.s.x, l.s.y)
            g.lineTo(l.t.x, l.t.y)
            g.stroke()
          }
          for (const n of nodes) {
            g.beginPath()
            g.arc(n.x, n.y, n.r, 0, Math.PI * 2)
            g.fillStyle = n.kind === 'asset' && n.meta && n.meta.state !== 'live'
              ? '#9ca3af'
              : (kindColor[n.kind] || '#94a3b8')
            g.fill()
            if (n.kind === 'segment' || n.kind === 'asset' || n.kind === 'domain') {
              g.fillStyle = 'rgba(148,163,184,.95)'
              g.font = (n.kind === 'segment' ? '600 11px ' : '11px ') + 'ui-monospace,Menlo,monospace'
              g.textAlign = 'center'
              g.fillText(String(n.label), n.x, n.y - n.r - 5)
            }
          }
          if (ticks < 260) raf = window.requestAnimationFrame(tick)
        }
        tick()
        return () => { if (raf) window.cancelAnimationFrame(raf) }
      }, [props.data])
      return h('canvas', { ref: ref, className: 'rt-graph' })
    }

    /* ---------------------------------------------------------- 智能体提示词 */
    function PromptsTab(props) {
      const eng = props.engagement
      const [roles, setRoles] = React.useState([])
      const [active, setActive] = React.useState(null)
      const [draft, setDraft] = React.useState('')
      const [msg, setMsg] = React.useState(null)
      const [busy, setBusy] = React.useState(false)

      React.useEffect(() => {
        if (!eng) return
        call({ op: 'prompts', engagement: eng }).then((r) => {
          if (!r || r.ok === false) { setMsg({ err: (r && r.error) || '读取失败' }); return }
          setRoles(r.roles || [])
          if (r.roles && r.roles.length) setActive((cur) => cur || r.roles[0].role)
        }, (e) => setMsg({ err: String((e && e.message) || e) }))
      }, [eng])

      React.useEffect(() => {
        const r = roles.find((x) => x.role === active)
        if (r) setDraft(r.content || '')
      }, [active, roles])

      const save = () => {
        setBusy(true)
        setMsg(null)
        call({ op: 'savePrompt', engagement: eng, role: active, content: draft }).then((r) => {
          setBusy(false)
          if (!r || r.ok === false) { setMsg({ err: (r && r.error) || '保存失败' }); return }
          setRoles((list) => list.map((x) => (x.role === active
            ? Object.assign({}, x, { content: draft, updated_at: new Date().toISOString() })
            : x)))
          setMsg({ ok: '已保存' })
        }, (e) => { setBusy(false); setMsg({ err: String((e && e.message) || e) }) })
      }

      const cur = roles.find((x) => x.role === active)
      const items = roles.map((r) => h('div', {
        key: r.role, className: 'rt-item' + (active === r.role ? ' on' : ''),
        onClick: () => { setActive(r.role); setMsg(null) },
      },
        h('div', { className: 'rt-item-name' }, r.title),
        h('div', { className: 'rt-item-desc' }, (r.content || '').replace(/[#*`]/g, '').slice(0, 60) || '（空）')))

      return h('div', { className: 'rt-split' },
        h('div', { className: 'rt-list' }, items),
        h('div', { className: 'rt-main' },
          h('div', { className: 'rt-toolbar' },
            h('span', { style: { fontWeight: 600 } }, cur ? cur.title : '提示词'),
            h('span', { className: 'rt-tag' }, '更新 ' + fmt(cur && cur.updated_at)),
            h('div', { className: 'rt-spacer' }),
            h('button', { className: 'rt-btn rt-btn-primary', disabled: busy || !active, onClick: save }, busy ? '保存中…' : '保存')),
          msg ? h('div', { className: msg.err ? 'rt-err' : 'rt-foot' }, msg.err || msg.ok) : null,
          h('div', { className: 'rt-pane' },
            h('textarea', {
              className: 'rt-textarea', value: draft, spellCheck: false,
              onChange: (e) => setDraft(e.target.value),
              placeholder: '该角色的系统提示词（Markdown）',
            }),
            h('div', { style: { fontSize: 11, color: 'var(--dsw-alias-label-secondary)', marginTop: 6 } },
              '保存后写入 agents/' + (active || 'role') + '.md，并在该角色会话的每次模型请求前注入。'))))
    }

    /* ---------------------------------------------------------- 技能库 */
    function SkillsTab(props) {
      const eng = props.engagement
      const [items, setItems] = React.useState([])
      const [active, setActive] = React.useState(null)
      const [form, setForm] = React.useState(null)
      const [msg, setMsg] = React.useState(null)
      const [busy, setBusy] = React.useState(false)

      const load = () => {
        if (!eng) return
        call({ op: 'skills', engagement: eng }).then((r) => {
          if (!r || r.ok === false) { setMsg({ err: (r && r.error) || '读取失败' }); return }
          setItems(r.items || [])
        }, (e) => setMsg({ err: String((e && e.message) || e) }))
      }
      React.useEffect(load, [eng])

      React.useEffect(() => {
        if (!active) { setForm(null); return }
        const it = items.find((x) => x.name === active)
        if (it) setForm(Object.assign({}, it))
      }, [active, items])

      const setField = (k, v) => setForm((f) => Object.assign({}, f, { [k]: v }))

      const save = () => {
        if (!form || !form.name) { setMsg({ err: '技能名称不能为空' }); return }
        setBusy(true)
        setMsg(null)
        call({ op: 'saveSkill', engagement: eng, skill: form }).then((r) => {
          setBusy(false)
          if (!r || r.ok === false) { setMsg({ err: (r && r.error) || '保存失败' }); return }
          setMsg({ ok: '已保存 ' + form.name })
          setActive(form.name)
          load()
        }, (e) => { setBusy(false); setMsg({ err: String((e && e.message) || e) }) })
      }

      const remove = () => {
        if (!active) return
        const name = active
        setBusy(true)
        setMsg(null)
        call({ op: 'deleteSkill', engagement: eng, name: name }).then((r) => {
          setBusy(false)
          if (!r || r.ok === false) { setMsg({ err: (r && r.error) || '删除失败' }); return }
          setActive(null)
          setForm(null)
          setMsg({ ok: '已删除 ' + name })
          load()
        }, (e) => { setBusy(false); setMsg({ err: String((e && e.message) || e) }) })
      }

      const create = () => {
        setActive(null)
        setForm({ name: '', description: '', whenToUse: '', role: 'recon', enabled: true, body: '## 步骤\n\n1. ', isNew: true })
        setMsg(null)
      }

      const listItems = items.map((it) => h('div', {
        key: it.name, className: 'rt-item' + (active === it.name ? ' on' : ''),
        onClick: () => { setActive(it.name); setMsg(null) },
      },
        h('div', { className: 'rt-item-name' }, it.name,
          it.enabled === false ? h('span', { className: 'rt-tag', style: { marginLeft: 6 } }, '停用') : null),
        h('div', { className: 'rt-item-desc' }, it.description || '（无描述）')))

      const editor = form
        ? h('div', { className: 'rt-pane' },
            h('div', { style: { display: 'flex', gap: 8, marginBottom: 8 } },
              h('input', {
                className: 'rt-input', style: { flex: 1 }, placeholder: '技能名称（英文短名）',
                value: form.name, onChange: (e) => setField('name', e.target.value),
              }),
              h('select', {
                className: 'rt-input', value: form.role || '', onChange: (e) => setField('role', e.target.value),
              },
                h('option', { value: '' }, '不限角色'),
                h('option', { value: 'recon' }, '信息收集'),
                h('option', { value: 'vuln-scan' }, '漏洞检测'),
                h('option', { value: 'exploit' }, '漏洞利用'),
                h('option', { value: 'internal' }, '内网渗透')),
              h('label', { style: { display: 'flex', alignItems: 'center', gap: 4, fontSize: 12, whiteSpace: 'nowrap' } },
                h('input', {
                  type: 'checkbox', checked: form.enabled !== false,
                  onChange: (e) => setField('enabled', e.target.checked),
                }), '启用')),
            h('input', {
              className: 'rt-input', style: { width: '100%', marginBottom: 8, boxSizing: 'border-box' },
              placeholder: '一句话描述', value: form.description || '',
              onChange: (e) => setField('description', e.target.value),
            }),
            h('input', {
              className: 'rt-input', style: { width: '100%', marginBottom: 8, boxSizing: 'border-box' },
              placeholder: '何时使用（whenToUse）', value: form.whenToUse || '',
              onChange: (e) => setField('whenToUse', e.target.value),
            }),
            h('textarea', {
              className: 'rt-textarea', value: form.body || '', spellCheck: false,
              onChange: (e) => setField('body', e.target.value),
            }),
            h('div', { style: { fontSize: 11, color: 'var(--dsw-alias-label-secondary)', marginTop: 6 } },
              '保存为 skills/' + (form.name || '<name>') + '.md，智能体通过原生 skill 工具调用。'))
        : h('div', { className: 'rt-empty' }, '左侧选择一个技能，或新建')

      return h('div', { className: 'rt-split' },
        h('div', { className: 'rt-list' },
          h('button', { className: 'rt-icon-btn', style: { marginBottom: 8 }, onClick: create }, '+ 新建技能'),
          listItems),
        h('div', { className: 'rt-main' },
          h('div', { className: 'rt-toolbar' },
            h('span', { style: { fontWeight: 600 } }, form ? (form.isNew ? '新建技能' : form.name) : '技能库'),
            h('div', { className: 'rt-spacer' }),
            form ? h('button', { className: 'rt-btn', disabled: busy, onClick: remove }, '删除') : null,
            h('button', { className: 'rt-btn rt-btn-primary', disabled: busy || !form, onClick: save }, busy ? '保存中…' : '保存')),
          msg ? h('div', { className: msg.err ? 'rt-err' : 'rt-foot' }, msg.err || msg.ok) : null,
          editor))
    }

    /* ---------------------------------------------------------- 常驻面板主体 */
    function Panel() {
      const st = useUI()
      const [engagements, setEngagements] = React.useState([])
      const [eng, setEng] = React.useState(null)
      const [snapshot, setSnapshot] = React.useState(null)
      const [err, setErr] = React.useState(null)
      const [newName, setNewName] = React.useState('')
      const [width, setWidth] = React.useState(620)
      const [creating, setCreating] = React.useState(false)

      /* 面板宽度写进 :root 的自定义属性，frame 的 padding-right 依赖它 */
      React.useEffect(() => styles.insert(':root{--rt-dock-w:' + width + 'px}'), [width])

      const loadSnapshot = (id) => {
        if (!id) { setSnapshot(null); return }
        call({ op: 'snapshot', engagement: id }).then((r) => {
          if (!r || r.ok === false) { setErr((r && r.error) || '加载失败'); return }
          setErr(null)
          setSnapshot(r)
        }, (e) => setErr(String((e && e.message) || e)))
      }

      const refreshList = (selectId) => {
        call({ op: 'bootstrap' }).then((b) => {
          setEngagements((b && b.engagements) || [])
          if (selectId) { setEng(selectId); loadSnapshot(selectId) }
        }, () => {})
      }

      React.useEffect(() => {
        call({ op: 'bootstrap' }).then((r) => {
          if (!r || r.ok === false) { setErr((r && r.error) || '无法连接资产库'); return }
          setEngagements(r.engagements || [])
          const id = r.current || (r.engagements && r.engagements[0] && r.engagements[0].id) || null
          if (id) { setEng(id); loadSnapshot(id) }
        }, (e) => setErr(String((e && e.message) || e)))
      }, [])

      const openEngagement = (nameArg) => {
        const name = String(nameArg || newName).trim()
        if (!name) return
        setCreating(true)
        call({ op: 'openEngagement', name: name }).then((r) => {
          setCreating(false)
          if (!r || r.ok === false) { setErr((r && r.error) || '创建失败'); return }
          setNewName('')
          refreshList(r.engagement && r.engagement.id)
        }, (e) => { setCreating(false); setErr(String((e && e.message) || e)) })
      }

      const startResize = (e) => {
        e.preventDefault()
        const startX = e.clientX
        const startW = width
        const move = (ev) => setWidth(Math.max(380, Math.min(900, startW + (startX - ev.clientX))))
        const up = () => {
          window.removeEventListener('mousemove', move)
          window.removeEventListener('mouseup', up)
        }
        window.addEventListener('mousemove', move)
        window.addEventListener('mouseup', up)
      }

      const stats = (snapshot && snapshot.stats) || {}
      const tabs = [['assets', '资产测绘'], ['prompts', '智能体提示词'], ['skills', '技能库']]

      let body
      if (err) body = h('div', { className: 'rt-err' }, err)
      else if (!eng) {
        body = h('div', { className: 'rt-pane' },
          h('div', { className: 'rt-card' },
            h('h4', null, '还没有靶标'),
            h('div', { style: { fontSize: 12, color: 'var(--dsw-alias-label-secondary)', marginBottom: 8 } },
              '输入攻防演练靶标单位名称，创建演练并开始资产测绘。'),
            h('div', { style: { display: 'flex', gap: 8 } },
              h('input', {
                className: 'rt-input', style: { flex: 1 }, placeholder: '例如：示例科技有限公司',
                value: newName, onChange: (e) => setNewName(e.target.value),
                onKeyDown: (e) => { if (e.key === 'Enter') openEngagement() },
              }),
              h('button', { className: 'rt-btn rt-btn-primary', disabled: creating, onClick: () => openEngagement() },
                creating ? '创建中…' : '创建靶标'))))
      } else if (st.tab === 'assets') body = h(AssetsTab, { engagement: eng, snapshot: snapshot })
      else if (st.tab === 'prompts') body = h(PromptsTab, { engagement: eng })
      else body = h(SkillsTab, { engagement: eng })

      return h('div', {
        className: 'rt-dock',
        'data-open': st.open ? '1' : '0',
        style: { width: width + 'px', display: st.open ? 'flex' : 'none' },
      },
        h('div', { className: 'rt-grip', onMouseDown: startResize }),
        h('div', { className: 'rt-head' },
          h('div', { className: 'rt-title' }, h('span', { className: 'rt-dot' }), 'RedTeam 控制台'),
          h('select', {
            className: 'rt-input', style: { maxWidth: '170px' }, value: eng || '',
            onChange: (e) => { setEng(e.target.value); loadSnapshot(e.target.value) },
          }, engagements.map((x) => h('option', { key: x.id, value: x.id }, x.name))),
          h('div', { className: 'rt-spacer' }),
          h('button', { className: 'rt-btn', title: '收起面板（对话列恢复全宽）', onClick: () => setUI({ open: false }) }, '收起')),
        h('div', { className: 'rt-tabs' }, tabs.map((t) => h('div', {
          key: t[0], className: 'rt-tab' + (st.tab === t[0] ? ' on' : ''),
          onClick: () => setUI({ tab: t[0] }),
        }, t[1]))),
        h('div', { className: 'rt-body' }, body),
        h('div', { className: 'rt-foot' },
          h('span', null, 'C 段 ' + (stats.segments || 0)),
          h('span', null, '资产 ' + (stats.assets || 0) + '（存活 ' + (stats.liveAssets || 0) + '）'),
          h('span', null, '端口 ' + (stats.openPorts || 0)),
          h('span', null, '指纹 ' + (stats.fingerprints || 0)),
          h('span', null, '被动/主动 ' + (stats.passiveSignals || 0) + '/' + (stats.activeSignals || 0)),
          h('div', { className: 'rt-spacer' }),
          h('span', null, 'SQLite · ' + (snapshot && snapshot.engagement ? snapshot.engagement.name : ''))))
    }

    /* ---------------------------------------------------------- 入口按钮 */
    function SidebarButton(props) {
      const st = useUI()
      return h('button', {
        className: 'rt-icon-btn' + (st.open ? ' on' : ''),
        title: 'RedTeam 控制台（常驻右侧栏）',
        onClick: () => setUI({ open: !st.open }),
      }, h('span', { style: { fontSize: 14 } }, '⛨'), props.wide ? h('span', null, 'RedTeam') : null)
    }

    function HeaderButton() {
      const st = useUI()
      return h('button', {
        className: 'rt-hbtn' + (st.open ? ' on' : ''),
        title: 'RedTeam 控制台（常驻右侧栏）',
        onClick: () => setUI({ open: !st.open }),
      }, '⛨ RedTeam')
    }

    slots.inject('shell.overlay', () => slots.register(
      { name: 'shell.overlay', id: 'redteam-console', order: 50 },
      () => h(Panel),
    ))
    slots.inject('sidebar.footer.action', () => slots.register(
      { name: 'sidebar.footer.action', id: 'redteam-toggle', order: 50, label: 'RedTeam' },
      (props) => h(SidebarButton, props),
    ))
    slots.inject('conversation.session.header.utilities', () => slots.register(
      { name: 'conversation.session.header.utilities', id: 'redteam-header-toggle', order: 50, label: 'RedTeam' },
      () => h(HeaderButton),
    ))
  },
}
