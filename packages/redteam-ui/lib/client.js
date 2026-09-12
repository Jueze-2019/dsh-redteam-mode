/**
 * RedTeam 控制台 —— 浏览器半侧（手写 bundle）
 *
 * 格式与外壳的模块加载器一致：window.__ModuleLoader__.load({ id, factory })。
 * id 必须等于包名（clientModules 以 manifest 包名作为浏览器模块身份）。
 * 基座外无依赖：只用平台 seed 里的 react 与 ctx.slots。
 */
window.__ModuleLoader__.load({
  id: 'dsh-redteam-ui',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })

    const React = require('react')
    const h = React.createElement

    /*
     * 布局接缝：AppFrame 是 display:grid（sidebar | 1fr | details），
     * shell.overlay 是它内部 position:absolute;inset:0 的浮动层，带稳定属性
     * data-shell-overlay。面板打开且详情栏关闭时，用 :has() 给 frame 加
     * padding-right，让中栏（1fr）主动收窄 —— 面板常驻但不遮挡对话。
     * 右侧栏打开时 frame 失去对应 collapsed 属性，面板滑出隐藏、宽度让回右侧栏。
     * 注意属性名随 DSH 版本变化，这里同时兼容旧 data-details-collapsed 与新 data-rightbar-collapsed。
     */
    const CSS = `
:root{--rt-dock-w:620px}
/* 右侧栏收起时给 frame 加内边距，中栏主动收窄。属性名跨 DSH 版本兼容：\n   旧版 details 栏 data-details-collapsed，新版 rightbar 栏 data-rightbar-collapsed。 */\ndiv:has(> [data-shell-overlay] .rt-dock[data-open="1"])[data-details-collapsed],\ndiv:has(> [data-shell-overlay] .rt-dock[data-open="1"])[data-rightbar-collapsed]{padding-right:var(--rt-dock-w)}
.rt-dock{position:absolute;top:0;right:0;bottom:0;z-index:20;display:flex;flex-direction:column;
  background:var(--dsw-alias-bg-layer-1);border-left:1px solid var(--dsw-alias-border-l1);
  box-shadow:-12px 0 32px rgba(0,0,0,.14);pointer-events:auto;color:var(--dsw-alias-label-primary);
  font-size:13px;line-height:1.5;transition:transform .18s ease,opacity .18s ease}
/* 右侧栏打开（或新版全屏）时让位：滑出隐藏。必须同时否定两个属性名——\n   旧写法只用 :not([data-details-collapsed])，在新 shell 里该属性不存在会导致条件恒真、面板永远打不开。 */\ndiv:has(> [data-shell-overlay] .rt-dock[data-open="1"]):not([data-details-collapsed]):not([data-rightbar-collapsed]) .rt-dock,\ndiv:has(> [data-shell-overlay] .rt-dock[data-open="1"])[data-rightbar-fullscreen] .rt-dock{
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
.rt-tabs{display:flex;flex-wrap:wrap;gap:4px;padding:8px 12px 0;border-bottom:1px solid var(--dsw-alias-border-l1)}
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
.rt-row{display:grid;grid-template-columns:150px 74px 104px 1.15fr 1fr;gap:8px;padding:6px 10px;
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
.rt-test{display:inline-block;padding:0 5px;border-radius:4px;font-size:11px;white-space:nowrap;
  border:1px solid var(--dsw-alias-border-l1);color:var(--dsw-alias-label-secondary)}
.rt-test-testing{color:#f59e0b;border-color:#f59e0b55;background:#f59e0b1a}
.rt-test-tested{color:#10b981;border-color:#10b98155;background:#10b9811a}
.rt-test-blocked{color:#fff;background:#ef4444;border-color:#ef4444}
.rt-test-abandoned{color:#94a3b8;border-color:#94a3b855;background:#94a3b81a}
.rt-test-no_surface{color:#6366f1;border-color:#6366f155;background:#6366f11a}
.rt-pri{display:inline-block;padding:0 6px;border-radius:4px;font-size:11px;font-weight:600;white-space:nowrap}
.rt-pri-high{color:#fff;background:#ef4444}
.rt-pri-medium{color:#fff;background:#f59e0b}
.rt-pri-low{color:#fff;background:#94a3b8}
.rt-score-row{display:grid;grid-template-columns:56px 1fr 90px 64px;gap:8px;padding:7px 10px;
  border-bottom:1px solid var(--dsw-alias-border-l1);align-items:center;font-size:12.5px;cursor:pointer}
.rt-score-row:hover{background:var(--dsw-alias-bg-layer-2)}
.rt-score-row.head{cursor:default;color:var(--dsw-alias-label-secondary);font-size:11.5px;font-weight:600;
  position:sticky;top:0;background:var(--dsw-alias-bg-layer-1);z-index:1}
.rt-score-detail{grid-column:1/-1;padding:8px 4px 10px;font-size:12px;color:var(--dsw-alias-label-secondary)}
.rt-score-form{display:grid;grid-template-columns:1fr 1fr;gap:6px;margin-bottom:6px}
.rt-score-form input,.rt-score-form select{width:100%;box-sizing:border-box}
.rt-vrow{display:grid;grid-template-columns:62px minmax(0,1fr) 132px 108px 74px 52px;gap:8px;padding:6px 10px;
  border-bottom:1px solid var(--dsw-alias-border-l1);align-items:center;font-size:12.5px;cursor:pointer}
.rt-vrow:hover{background:var(--dsw-alias-bg-layer-2)}
.rt-vrow.head{cursor:default;color:var(--dsw-alias-label-secondary);font-size:11.5px;font-weight:600;
  position:sticky;top:0;background:var(--dsw-alias-bg-layer-1);z-index:1}
.rt-vdetail{grid-column:1/-1;padding:8px 4px 10px;font-size:12px;color:var(--dsw-alias-label-secondary)}
.rt-vdetail .rt-kv{margin-bottom:4px}
.rt-actions{display:flex;gap:6px;margin-top:6px}
.rt-section{padding:8px 10px 2px;font-size:11.5px;font-weight:600;color:var(--dsw-alias-label-secondary)}
.rt-link{color:var(--dsw-alias-brand-primary);text-decoration:none;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.rt-link:hover{text-decoration:underline}
.rt-full{position:fixed;inset:0;z-index:60;display:flex;flex-direction:column;
  background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);font-size:13px;line-height:1.5;
  border-top:3px solid var(--dsw-alias-brand-primary)}
.rt-full .rt-head{padding:12px 18px}
.rt-full .rt-tabs{padding:10px 18px 0;gap:6px;flex-wrap:wrap}
.rt-full .rt-side{width:260px}
.rt-full .rt-list{width:280px}
.rt-full .rt-row{grid-template-columns:190px 90px 130px 1.4fr 1.2fr}
.rt-full .rt-vrow{grid-template-columns:80px minmax(0,1.6fr) 200px 150px 90px 64px}
.rt-full .rt-pane{padding:18px}
.rt-full .rt-textarea{min-height:60vh}
.rt-full .rt-foot{padding:10px 18px;font-size:12px}
.rt-full .rt-body{max-width:1400px;width:100%;margin:0 auto;flex:1;min-height:0;display:flex;flex-direction:column}
.rt-chain{flex:1;overflow:auto;padding:10px 12px}
.rt-step{display:flex;gap:10px;padding:8px 6px;border-left:2px solid var(--dsw-alias-border-l1);margin-left:6px}
.rt-step:last-child{border-left-color:transparent}
.rt-step-dot{width:22px;height:22px;flex:none;border-radius:50%;display:flex;align-items:center;justify-content:center;
  font-size:11px;font-weight:700;color:#fff;background:#64748b;margin-left:-13px}
.rt-step-body{min-width:0}
.rt-step-title{font-weight:600;font-size:13px}
.rt-step-meta{font-size:11.5px;color:var(--dsw-alias-label-secondary);margin-top:2px;word-break:break-word}
.rt-stage-recon{background:#6366f1}
.rt-stage-vuln{background:#f59e0b}
.rt-stage-exploit{background:#ef4444}
.rt-stage-access{background:#10b981}
.rt-stage-pivot{background:#8b5cf6}
.rt-stage-data{background:#0ea5e9}
.rt-stage-other{background:#64748b}
.rt-step-head{display:flex;align-items:baseline;gap:6px;flex-wrap:wrap}
.rt-step-time{font-size:11px;color:var(--dsw-alias-label-secondary);margin-left:auto;white-space:nowrap}
.rt-step-detail{font-size:12px;margin-top:5px;white-space:pre-wrap;word-break:break-word;
  border-left:2px solid var(--dsw-alias-border-l1);padding:2px 0 2px 9px;line-height:1.6}
.rt-chip{display:inline-flex;align-items:center;gap:5px;font-size:11.5px;padding:1px 7px;border-radius:5px;
  border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-2);margin:4px 5px 0 0;max-width:100%}
.rt-chip>i{font-style:normal;color:var(--dsw-alias-label-secondary);font-size:10.5px}
.rt-chip>span{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:420px}
.rt-stage-tag{display:inline-block;padding:0 6px;border-radius:4px;font-size:11px;color:#fff;font-weight:600}
.rt-st-recon{background:#6366f1}.rt-st-vuln{background:#f59e0b}.rt-st-exploit{background:#ef4444}
.rt-st-access{background:#10b981}.rt-st-pivot{background:#8b5cf6}.rt-st-data{background:#0ea5e9}.rt-st-other{background:#64748b}
.rt-sev{display:inline-block;padding:0 6px;border-radius:4px;font-size:11px;font-weight:600;border:1px solid transparent}
.rt-sev-critical{color:#fff;background:#b91c1c}.rt-sev-high{color:#fff;background:#ef4444}
.rt-sev-medium{color:#7c2d12;background:#fdba74}.rt-sev-low{color:#1e3a8a;background:#bfdbfe}
.rt-sev-info{color:var(--dsw-alias-label-secondary);background:var(--dsw-alias-bg-layer-2);border-color:var(--dsw-alias-border-l1)}
.rt-dot-on{display:inline-block;width:7px;height:7px;border-radius:50%;background:#10b981;box-shadow:0 0 0 3px #10b98133}
.rt-dot-off{display:inline-block;width:7px;height:7px;border-radius:50%;background:#ef4444;box-shadow:0 0 0 3px #ef444433}
.rt-dot-unk{display:inline-block;width:7px;height:7px;border-radius:50%;background:#94a3b8;box-shadow:0 0 0 3px #94a3b833}
.rt-sess-grid{display:grid;grid-template-columns:1fr;gap:8px;padding:10px 12px}
.rt-sess{border:1px solid var(--dsw-alias-border-l1);border-radius:8px;padding:9px 10px;background:var(--dsw-alias-bg-layer-2)}
.rt-sess-head{display:flex;align-items:center;gap:7px;flex-wrap:wrap}
.rt-sess-title{font-weight:600;font-size:12.5px;font-family:ui-monospace,Menlo,monospace;word-break:break-all}
.rt-sess-sub{font-size:11.5px;color:var(--dsw-alias-label-secondary);margin-top:3px;word-break:break-word}
.rt-code{font-family:ui-monospace,Menlo,monospace;font-size:11px;background:var(--dsw-alias-bg-base);
  border:1px solid var(--dsw-alias-border-l1);border-radius:4px;padding:1px 5px;cursor:pointer;word-break:break-all}
.rt-code:hover{border-color:var(--dsw-alias-brand-primary)}
.rt-evi{border:1px solid var(--dsw-alias-border-l1);border-radius:8px;overflow:hidden;margin-top:8px}
.rt-evi-head{display:flex;align-items:center;gap:8px;padding:5px 9px;background:var(--dsw-alias-bg-layer-2);
  font-size:11.5px;font-weight:600;border-bottom:1px solid var(--dsw-alias-border-l1)}
.rt-evi-body{margin:0;padding:9px 11px;font-family:ui-monospace,Menlo,monospace;font-size:11.5px;line-height:1.6;
  white-space:pre-wrap;word-break:break-word;max-height:340px;overflow:auto;background:var(--dsw-alias-bg-base)}
.rt-evi-body.req{max-height:220px}
.rt-hl-req{color:#10b981;font-weight:600}
.rt-hl-res{color:#0ea5e9;font-weight:600}
.rt-gain{display:inline-flex;align-items:center;gap:5px;font-size:11.5px;font-weight:600;padding:2px 8px;border-radius:12px;
  color:#065f46;background:#a7f3d0;border:1px solid #10b98155}
.rt-total{font-size:20px;font-weight:700;font-family:ui-monospace,Menlo,monospace}
.rt-sidehead{padding:7px 8px 2px;font-size:11px;font-weight:600;color:var(--dsw-alias-label-secondary);
  display:flex;align-items:center;gap:5px}
.rt-scope{display:inline-block;padding:0 4px;border-radius:3px;font-size:10px;font-weight:700;line-height:15px;flex:none}
.rt-scope-internal{color:#0e7490;background:#a5f3fc}
.rt-scope-external{color:#9a3412;background:#fed7aa}
.rt-hits{display:flex;flex-direction:column;gap:6px;margin-top:7px}
.rt-hit{border:1px solid var(--dsw-alias-border-l1);border-left:3px solid #10b981;border-radius:6px;
  padding:7px 9px;background:var(--dsw-alias-bg-layer-2)}
.rt-hit-head{display:flex;align-items:center;gap:7px;flex-wrap:wrap}
.rt-hit-idx{width:16px;height:16px;border-radius:50%;background:#10b981;color:#fff;font-size:10.5px;font-weight:700;
  display:inline-flex;align-items:center;justify-content:center;flex:none}
.rt-hit-target{font-family:ui-monospace,Menlo,monospace;font-weight:600;font-size:12px;word-break:break-all}
.rt-hit-time{margin-left:auto;font-size:11px;color:var(--dsw-alias-label-secondary);white-space:nowrap}
.rt-hit-evi{font-family:ui-monospace,Menlo,monospace;font-size:11.5px;line-height:1.65;white-space:pre-wrap;word-break:break-word;
  background:var(--dsw-alias-bg-base);border:1px solid var(--dsw-alias-border-l1);border-radius:5px;padding:6px 8px;margin-top:5px}
.rt-hit-note{font-size:11.5px;color:var(--dsw-alias-label-secondary);margin-top:4px}
.rt-cred{border:1px solid var(--dsw-alias-border-l1);border-left:3px solid #f59e0b;border-radius:6px;
  padding:8px 10px;background:var(--dsw-alias-bg-layer-2);margin-bottom:7px}
.rt-cred-head{display:flex;align-items:center;gap:7px;flex-wrap:wrap}
.rt-cred-host{font-family:ui-monospace,Menlo,monospace;font-weight:600;font-size:12.5px;word-break:break-all}
.rt-secret{font-family:ui-monospace,Menlo,monospace;font-size:12.5px;line-height:1.6;background:#fef3c7;color:#78350f;
  border:1px solid #f59e0b66;border-radius:5px;padding:6px 9px;margin-top:6px;white-space:pre-wrap;word-break:break-all;
  user-select:all;cursor:text}
.rt-secret-none{font-family:ui-monospace,Menlo,monospace;font-size:11.5px;color:var(--dsw-alias-state-error-primary);
  border:1px dashed var(--dsw-alias-state-error-primary);border-radius:5px;padding:5px 9px;margin-top:6px}
.rt-cred-meta{font-size:11.5px;color:var(--dsw-alias-label-secondary);margin-top:5px;word-break:break-word}
.rt-stage-score{background:#10b981}
.rt-scorepts{font-size:11.5px;font-weight:700;color:#065f46;background:#a7f3d0;border:1px solid #10b98155;
  border-radius:10px;padding:0 7px;white-space:nowrap}
.rt-livebar{display:flex;align-items:center;gap:7px;padding:7px 12px;border-bottom:1px solid var(--dsw-alias-border-l1);
  background:var(--dsw-alias-bg-layer-2);flex-wrap:wrap}
.rt-live-dot{width:8px;height:8px;border-radius:50%;background:#10b981;flex:none;animation:rt-pulse 1.6s ease-in-out infinite}
.rt-live-dot.idle{background:#94a3b8;animation:none}
@keyframes rt-pulse{0%,100%{opacity:1;box-shadow:0 0 0 0 #10b98166}50%{opacity:.5;box-shadow:0 0 0 5px #10b98100}}
.rt-live-body{padding:8px 12px 2px;border-bottom:1px solid var(--dsw-alias-border-l1);max-height:34vh;overflow:auto}
.rt-atest{border:1px solid var(--dsw-alias-border-l1);border-left:3px solid #10b981;border-radius:6px;
  padding:7px 10px;background:var(--dsw-alias-bg-layer-2);margin-bottom:6px}
.rt-atest.past{border-left-color:#94a3b8;opacity:.85}
.rt-atest-head{display:flex;align-items:center;gap:7px;flex-wrap:wrap}
.rt-atest-ip{font-family:ui-monospace,Menlo,monospace;font-weight:600;font-size:12.5px;word-break:break-all}
.rt-atest-meta{font-size:11.5px;color:var(--dsw-alias-label-secondary);margin-top:3px;word-break:break-word}
.rt-atest-notes{font-family:ui-monospace,Menlo,monospace;font-size:11px;line-height:1.6;white-space:pre-wrap;
  word-break:break-word;background:var(--dsw-alias-bg-base);border-radius:4px;padding:5px 7px;margin-top:4px;max-height:76px;overflow:auto}
.rt-concl{display:flex;align-items:center;gap:4px;padding:6px 12px;border-bottom:1px solid var(--dsw-alias-border-l1);
  background:var(--dsw-alias-bg-layer-2);flex-wrap:wrap}
.rt-concl-i{display:inline-flex;align-items:baseline;gap:4px;padding:2px 8px;border-radius:6px;cursor:pointer;
  border:1px solid transparent}
.rt-concl-i:hover{border-color:var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-1)}
.rt-concl-i.on{border-color:var(--dsw-alias-brand-primary);background:var(--dsw-alias-bg-layer-1)}
.rt-concl-i b{font-family:ui-monospace,Menlo,monospace;font-size:14px;font-weight:700}
.rt-concl-i>span{color:var(--dsw-alias-label-secondary);font-size:11.5px}
.rt-more{color:var(--dsw-alias-brand-primary);font-size:11.5px;cursor:pointer;user-select:none;margin-top:4px;display:inline-block}
.rt-more:hover{text-decoration:underline}
.rt-grp{display:flex;align-items:center;gap:8px;padding:7px 10px;cursor:pointer;border-bottom:1px solid var(--dsw-alias-border-l1);
  background:var(--dsw-alias-bg-layer-2)}
.rt-grp:hover{background:var(--dsw-alias-bg-layer-1)}
.rt-grp-t{font-family:ui-monospace,Menlo,monospace;font-weight:600;font-size:12.5px;word-break:break-all}
.rt-grp-n{font-size:11.5px;color:var(--dsw-alias-label-secondary);white-space:nowrap}
.rt-subtabs{display:flex;gap:4px;padding:6px 10px 0;border-bottom:1px solid var(--dsw-alias-border-l1);align-items:center}
.rt-subtab{padding:4px 10px;border-radius:6px 6px 0 0;cursor:pointer;font-size:12px;color:var(--dsw-alias-label-secondary)}
.rt-subtab.on{color:var(--dsw-alias-label-primary);background:var(--dsw-alias-bg-layer-2);font-weight:600}
.rt-sevbar{width:3px;border-radius:2px;align-self:stretch;flex:none;margin-right:2px}
.rt-stagegrp{display:flex;align-items:center;gap:8px;padding:6px 10px;margin-top:6px;cursor:pointer;border-radius:6px;
  background:var(--dsw-alias-bg-layer-2);border:1px solid var(--dsw-alias-border-l1)}
.rt-stagegrp:hover{border-color:var(--dsw-alias-border-l2)}
.rt-md{flex:1;overflow:auto;margin:0;padding:14px 16px;font-family:ui-monospace,Menlo,monospace;font-size:12.5px;
  line-height:1.65;white-space:pre-wrap;word-break:break-word;background:var(--dsw-alias-bg-base)}
.rt-weblink{display:block;font-size:11.5px;margin-top:1px;max-width:100%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
`

    /* ---------------------------------------------------------- 桥接与状态 */
    /** 是否在「全面浏览」独立窗口里（URL hash 标记，复用同一套界面代码）。 */
    const isFullWindow = () => {
      try { return String(window.location.hash || '') === '#redteam-full' } catch { return false }
    }

    const api = (req) => fetch('/redteam/api', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(req),
    }).then((res) => res.json())

    let ui = { open: true, tab: 'assets' }
    const subs = new Set()
    const setUI = (patch) => {
      ui = Object.assign({}, ui, patch)
      for (const f of Array.from(subs)) f()
    }
    /* 面板宽度 → :root 自定义属性（frame 的 padding-right 依赖它） */
    let dockWidthTag = null
    const setDockWidth = (px) => {
      if (dockWidthTag) dockWidthTag.textContent = ':root{--rt-dock-w:' + px + 'px}'
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

    const fmt = (s) => (s ? String(s).replace('T', ' ').slice(0, 16) : '—')
    const provLabel = (p) => (p === 'passive' ? '被动' : p === 'active' ? '主动' : '未知')

    function ProvTag(props) {
      if (!props.p) return h('span', { className: 'rt-tag' }, '未知')
      return h('span', { className: 'rt-tag rt-tag-' + props.p }, provLabel(props.p))
    }

    const TEST_LABEL = { untested: '未测试', testing: '测试中', tested: '已测试', blocked: '被封禁', abandoned: '已放弃', no_surface: '无攻击面' }
    const PRI_LABEL = { high: '高', medium: '中', low: '低' }

    /** 资产易打性徽章。 */
    function PriTag(props) {
      if (!props.p) return h('span', { className: 'rt-tag' }, '未评')
      return h('span', { className: 'rt-pri rt-pri-' + props.p, title: props.title || '' }, PRI_LABEL[props.p] || props.p)
    }

    /** 资产测试状态徽章。 */
    function TestTag(props) {
      const st = props.s || 'untested'
      return h('span', { className: 'rt-test rt-test-' + st }, TEST_LABEL[st] || st)
    }

    /* ---------------------------------------------------------- 资产测绘 */
    function AssetsTab(props) {
      const eng = props.engagement
      const snapshot = props.snapshot
      const refreshKey = props.refreshKey || 0
      const onRefresh = props.onRefresh
      const [view, setView] = React.useState('list')
      const [cidr, setCidr] = React.useState(null)
      const [q, setQ] = React.useState('')
      const [qApplied, setQApplied] = React.useState('')
      const [service, setService] = React.useState('')
      const [port, setPort] = React.useState('')
      const [prov, setProv] = React.useState('')
      const [testStatus, setTestStatus] = React.useState('')
      const [priority, setPriority] = React.useState('')
      const [scope, setScope] = React.useState('')
      const [assetState, setAssetState] = React.useState('')
      const [sort, setSort] = React.useState('priority')
      const [showAll, setShowAll] = React.useState(null)
      const [state, setState] = React.useState({ loading: false, error: null, total: 0, items: [] })
      const [graphState, setGraphState] = React.useState({ loading: false, data: null, error: null })
      const [domains, setDomains] = React.useState(null)
      const [web, setWeb] = React.useState(null)
      const [openId, setOpenId] = React.useState(null)
      const [detail, setDetail] = React.useState(null)
      const seq = React.useRef(0)
      const onData = props.onData

      React.useEffect(() => {
        if (!eng) return
        const my = ++seq.current
        setState((s) => Object.assign({}, s, { loading: true, error: null }))
        api({
          op: 'assets', engagement: eng, cidr: cidr || undefined, q: qApplied || undefined,
          service: service || undefined, port: port || undefined,
          provenance: prov || undefined, test_status: testStatus || undefined,
          priority: priority || undefined, scope: scope || undefined,
          state: assetState || undefined, sort: sort, limit: 400,
        }).then((r) => {
          if (my !== seq.current) return
          if (!r || r.ok === false) {
            setState({ loading: false, error: (r && r.error) || '查询失败', total: 0, items: [] })
            return
          }
          setState({ loading: false, error: null, total: r.total, items: r.items || [] })
          /* C 段/统计可能因本轮采集新增：让外层重新拉一次快照，左侧分类立即更新 */
          if (onData) onData()
        }, (e) => {
          if (my === seq.current) setState({ loading: false, error: String((e && e.message) || e), total: 0, items: [] })
        })
      }, [eng, cidr, qApplied, service, port, prov, testStatus, priority, scope, assetState, sort, refreshKey])

      React.useEffect(() => {
        if (!eng || view !== 'domain') return
        setDomains(null)
        api({ op: 'domains', engagement: eng, cidr: cidr || undefined })
          .then((r) => setDomains((r && r.items) || []), () => setDomains([]))
      }, [eng, view, cidr, refreshKey])

      React.useEffect(() => {
        if (!eng || view !== 'web') return
        setWeb(null)
        api({ op: 'web', engagement: eng, cidr: cidr || undefined })
          .then((r) => setWeb((r && r.items) || []), () => setWeb([]))
      }, [eng, view, cidr, refreshKey])

      React.useEffect(() => {
        if (!eng || view !== 'graph') return
        setGraphState((s) => Object.assign({}, s, { loading: true, error: null }))
        api({ op: 'attackGraph', engagement: eng, cidr: cidr || undefined }).then((r) => {
          if (!r || r.ok === false) {
            setGraphState({ loading: false, data: null, error: (r && r.error) || '图谱加载失败' })
            return
          }
          setGraphState({ loading: false, data: { nodes: r.nodes || [], edges: r.edges || [] }, error: null })
        }, (e) => setGraphState({ loading: false, data: null, error: String((e && e.message) || e) }))
      }, [eng, view, cidr, refreshKey])

      const toggleRow = (id) => {
        if (openId === id) { setOpenId(null); setDetail(null); return }
        setOpenId(id)
        setDetail(null)
        api({ op: 'asset', engagement: eng, id: id }).then((r) => {
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
      /* C 段按内外网分组：先外网（互联网可达，通常是入口）再内网（打进去之后才看得到） */
      const segBlock = (title, list, kind) => {
        const out = [h('div', { key: 'h' + kind, className: 'rt-sidehead' },
          h('span', { className: 'rt-scope rt-scope-' + kind }, kind === 'internal' ? '内网' : '外网'),
          h('span', null, title + ' · ' + list.length + ' 个 C 段'),
          h('span', { className: 'rt-spacer' }),
          h('span', { style: { fontWeight: 400 } }, list.reduce((n, x) => n + (x.assets || 0), 0) + ' 资产'))]
        for (const s of list) {
          /* 一段一行：C 段 + 资产数 + 端口数（归属与主被动拆分进 title，不再占位） */
          out.push(h('div', {
            key: s.cidr, className: 'rt-seg' + (cidr === s.cidr ? ' on' : ''),
            onClick: () => setCidr(s.cidr),
            title: (s.org || '未知归属') + ' · 被动端口 ' + s.passive_ports + ' / 主动端口 ' + s.active_ports,
          },
            h('div', { className: 'rt-seg-cidr', style: { display: 'flex', alignItems: 'baseline', gap: 5 } },
              h('span', { className: 'rt-scope rt-scope-' + kind }, kind === 'internal' ? '内' : '外'),
              h('span', { style: { flex: 1 } }, s.cidr),
              h('span', { className: 'rt-seg-meta', style: { margin: 0, whiteSpace: 'nowrap' } },
                s.assets + ' 台 · ' + s.open_ports + ' 端口'))))
        }
        return out
      }
      const segExternal = segs.filter((x) => x.scope !== 'internal')
      const segInternal = segs.filter((x) => x.scope === 'internal')
      if (segExternal.length) sideChildren.push(...segBlock('外网资产', segExternal, 'external'))
      if (segInternal.length) sideChildren.push(...segBlock('内网资产', segInternal, 'internal'))
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
        h('select', { className: 'rt-input', value: scope, onChange: (e) => setScope(e.target.value) },
          h('option', { value: '' }, '内外网不限'),
          h('option', { value: 'external' }, '仅外网资产'),
          h('option', { value: 'internal' }, '仅内网资产')),
        h('select', { className: 'rt-input', value: prov, onChange: (e) => setProv(e.target.value), title: '按端口来源过滤（列表已不再单列显示，详情里可见）' },
          h('option', { value: '' }, '来源不限'),
          h('option', { value: 'passive' }, '仅被动'),
          h('option', { value: 'active' }, '仅主动')),
        h('select', { className: 'rt-input', value: priority, onChange: (e) => setPriority(e.target.value) },
          h('option', { value: '' }, '易打性不限'),
          h('option', { value: 'high' }, '易打（高）'),
          h('option', { value: 'medium' }, '一般（中）'),
          h('option', { value: 'low' }, '难打（低）')),
        h('select', { className: 'rt-input', value: testStatus, onChange: (e) => setTestStatus(e.target.value) },
          h('option', { value: '' }, '测试状态不限'),
          h('option', { value: 'untested' }, '未测试'),
          h('option', { value: 'testing' }, '测试中'),
          h('option', { value: 'tested' }, '已测试'),
          h('option', { value: 'blocked' }, '被封禁'),
          h('option', { value: 'abandoned' }, '已放弃'),
          h('option', { value: 'no_surface' }, '无攻击面')),
        h('div', { className: 'rt-spacer' }),
        h('button', { className: 'rt-btn', title: '重新拉取快照与当前视图数据', onClick: () => { if (onRefresh) onRefresh() } }, '刷新'),
        h('button', { className: 'rt-btn' + (view === 'list' ? ' rt-btn-primary' : ''), onClick: () => setView('list') }, '列表'),
        h('button', { className: 'rt-btn' + (view === 'domain' ? ' rt-btn-primary' : ''), onClick: () => setView('domain') }, '域名'),
        h('button', { className: 'rt-btn' + (view === 'web' ? ' rt-btn-primary' : ''), onClick: () => setView('web') }, 'Web'),
        h('button', { className: 'rt-btn' + (view === 'graph' ? ' rt-btn-primary' : ''), onClick: () => setView('graph') }, '图谱'))

      /* ── 结论行：一屏看清家底，数字点一下就是筛选 ───────────────────── */
      const tests = (snapshot && snapshot.tests) || {}
      const snapStats = (snapshot && snapshot.stats) || {}
      const noFilter = !testStatus && !priority && !scope && !prov && !assetState && !cidr
      const conclItem = (key, label, value, active, onClick) => h('span', {
        key: key, className: 'rt-concl-i' + (active ? ' on' : ''), onClick: onClick, title: '点击筛选 / 再点取消',
      }, h('b', null, String(value || 0)), h('span', null, label))
      const toggleTest = (v) => { setTestStatus((cur) => (cur === v ? '' : v)); setAssetState('') }
      const conclusion = h('div', { className: 'rt-concl' },
        conclItem('all', '台资产', snapStats.assets, noFilter, () => {
          setTestStatus(''); setPriority(''); setScope(''); setProv(''); setAssetState(''); setCidr(null)
        }),
        conclItem('live', '存活', snapStats.liveAssets, assetState === 'live', () => { setAssetState((v) => (v === 'live' ? '' : 'live')); setTestStatus('') }),
        conclItem('untested', '待测', tests.untested, testStatus === 'untested', () => toggleTest('untested')),
        conclItem('testing', '测试中', tests.testing, testStatus === 'testing', () => toggleTest('testing')),
        conclItem('tested', '已测', tests.tested, testStatus === 'tested', () => toggleTest('tested')),
        conclItem('giveup', '放弃', (tests.abandoned || 0) + (tests.blocked || 0), testStatus === 'abandoned,blocked', () => toggleTest('abandoned,blocked')),
        h('div', { className: 'rt-spacer' }),
        h('select', {
          className: 'rt-input', value: sort, onChange: (e) => setSort(e.target.value),
          title: '列表排序方式',
        },
          h('option', { value: 'priority' }, '排序：易打性优先'),
          h('option', { value: 'todo' }, '排序：待测优先'),
          h('option', { value: 'ports' }, '排序：端口多优先'),
          h('option', { value: 'ip' }, '排序：按 IP')))

      const head = h('div', { className: 'rt-row head' },
        h('span', null, 'IP'), h('span', null, '易打'), h('span', null, '测试状态'),
        h('span', null, '开放端口 / 服务'), h('span', null, '指纹'))

      const rowNodes = []
      for (const it of state.items) {
        const openPorts = it.ports.filter((p) => p.state === 'open')
        const portText = openPorts.map((p) => p.port + (p.service ? '/' + p.service : '')).join(', ') || '—'
        const fpText = it.fingerprints.map((f) => [f.vendor, f.product, f.version].filter(Boolean).join(' ')).join(' / ') || '—'
        /* 端口最多列 3 个，其余用 +N；主被动来源不再占列，进详情 */
        const shownPorts = openPorts.slice(0, 3).map((p) => p.port + (p.service ? '/' + p.service : '')).join(', ')
        const morePorts = openPorts.length > 3 ? ' +' + (openPorts.length - 3) : ''
        rowNodes.push(h('div', {
          key: 'r' + it.id, className: 'rt-row', onClick: () => toggleRow(it.id),
        },
          h('span', { className: 'rt-mono', style: { display: 'flex', alignItems: 'baseline', gap: 4 } },
            h('span', {
              className: 'rt-scope rt-scope-' + (it.scope === 'internal' ? 'internal' : 'external'),
            }, it.scope === 'internal' ? '内' : '外'),
            h('span', {
              title: it.state === 'live' ? '存活' : String(it.state),
              style: {
                width: 7, height: 7, borderRadius: '50%', flex: 'none', marginTop: 4,
                background: it.state === 'live' ? '#10b981' : '#94a3b8',
              },
            }),
            h('span', { style: { overflow: 'hidden', textOverflow: 'ellipsis' } }, it.ip)),
          h('span', null, h(PriTag, { p: it.priority, title: it.potential || '' })),
          h('span', null, h(TestTag, { s: it.test_status }),
            it.blocked_count ? h('span', { className: 'rt-tag', style: { color: '#ef4444', borderColor: '#ef444455', marginLeft: 4 } }, '封' + it.blocked_count) : null),
          h('span', { title: portText }, (shownPorts || '—') + morePorts),
          h('span', { title: fpText }, fpText.length > 30 ? fpText.slice(0, 30) + '…' : fpText)))

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
              p.url ? h('a', { className: 'rt-link', href: p.url, target: '_blank', rel: 'noreferrer', title: p.url }, p.title ? p.title : p.url) : null,
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
        /* 详情分三层：3 行必读 → 「展开全部」后才是溯源、原始记录与备注全文 */
        const all = showAll === it.id
        const noteLines = d && d.test_notes ? d.test_notes.split('\n').filter(Boolean) : []
        const inner = d
          ? h('div', null,
              /* 必读三行 */
              h('div', { className: 'rt-kv' }, h('b', null, '测试'), h('span', null,
                h(TestTag, { s: d.test_status }),
                d.blocked_count ? h('span', { className: 'rt-tag', style: { marginLeft: 6, color: '#ef4444', borderColor: '#ef444455' } }, '被封 ' + d.blocked_count + ' 次') : null,
                h('span', { style: { marginLeft: 8, color: 'var(--dsw-alias-label-secondary)' } },
                  (d.test_updated_at ? fmt(d.test_updated_at) : '未测过') + (d.test_updated_by ? ' · ' + d.test_updated_by : '')))),
              h('div', { className: 'rt-kv' }, h('b', null, '易打性'), h('span', null,
                h(PriTag, { p: d.priority }),
                h('span', { style: { marginLeft: 8 } }, d.potential || '未评估'),
                d.assess_reason ? h('span', { style: { marginLeft: 8, color: 'var(--dsw-alias-label-secondary)' } }, d.assess_reason) : null)),
              h('div', { className: 'rt-kv' }, h('b', null, '攻击面'), h('span', null,
                d.test_surface || (portRows.length ? '未记录（开放端口见下）' : '无开放端口'),
                d.scope ? h('span', { className: 'rt-scope rt-scope-' + (d.scope === 'internal' ? 'internal' : 'external'), style: { marginLeft: 8 } },
                  d.scope === 'internal' ? '内网资产' : '外网资产') : null)),
              h('span', { className: 'rt-more', onClick: () => setShowAll(all ? null : it.id) },
                all ? '收起全部 ▲' : '展开全部（端口 · 指纹 · 采集溯源 · 测试记录）▼'),
              all ? h('div', null,
                h('div', { className: 'rt-kv' }, h('b', null, '主机名'), h('span', null, (d.names || []).map((n) => n.name).join(', ') || '—')),
                h('div', { className: 'rt-kv' }, h('b', null, 'C 段'), h('span', null, d.segment_cidr + ' · 首见 ' + fmt(d.first_seen) + ' · 末见 ' + fmt(d.last_seen))),
                h('div', { className: 'rt-kv' }, h('b', null, '来源'), h('span', null,
                  '被动端口 ' + (d.passive || 0) + ' · 主动端口 ' + (d.active || 0))),
                h('div', { style: { margin: '6px 0 3px', fontWeight: 600 } }, '开放端口 / 服务'),
                h('div', null, portRows.length ? portRows : '—'),
                h('div', { style: { margin: '6px 0 3px', fontWeight: 600 } }, '指纹'),
                h('div', null, fpRows.length ? fpRows : '—'),
                noteLines.length
                  ? h('div', null,
                      h('div', { style: { margin: '6px 0 3px', fontWeight: 600 } }, '测试记录（' + noteLines.length + ' 条）'),
                      h('div', { className: 'rt-atest-notes', style: { maxHeight: 220 } }, noteLines.join('\n')))
                  : null,
                h('div', { style: { margin: '6px 0 3px', fontWeight: 600 } }, '采集溯源（最近 8 条）'),
                h('div', null, obsRows.length ? obsRows : '—'))
                : null)
          : h('div', null, '加载中…')
        rowNodes.push(h('div', {
          key: 'd' + it.id, className: 'rt-row',
          style: { cursor: 'default', gridTemplateColumns: '1fr' },
        }, h('div', { className: 'rt-expand' }, inner)))
      }

      const listPane = h('div', { className: 'rt-table' }, head, rowNodes,
        !state.loading && !state.items.length ? h('div', { className: 'rt-empty' }, '没有匹配的资产') : null)

      /* 域名维度：域名 → 关联资产 */
      const domainPane = h('div', { className: 'rt-table' },
        domains === null ? h('div', { className: 'rt-empty' }, '加载中…')
          : domains.length
          ? domains.map((g) => h('div', { key: g.domain },
              h('div', { className: 'rt-section', style: { padding: '8px 10px 4px' } },
                h('a', { className: 'rt-link', href: 'http://' + g.domain, target: '_blank', rel: 'noreferrer' }, g.domain),
                h('span', { className: 'rt-tag', style: { marginLeft: 8 } }, g.count + ' 个资产')),
              g.assets.map((a) => h('div', {
                key: g.domain + a.id, className: 'rt-row',
                style: { gridTemplateColumns: '150px 130px 70px 1fr', cursor: 'pointer' },
                onClick: () => { setView('list'); setQ(''); setQApplied(a.ip) },
              },
                h('span', { className: 'rt-mono' }, a.ip),
                h('span', { className: 'rt-mono' }, a.segment),
                h('span', null, h('span', { className: 'rt-tag rt-tag-' + (a.state === 'live' ? 'live' : 'dead') }, a.state === 'live' ? '存活' : a.state)),
                h('span', { style: { fontSize: 11, color: 'var(--dsw-alias-label-secondary)' } }, (a.names || []).join(', '))))))
          : h('div', { className: 'rt-empty' }, cidr ? '该 C 段下暂无域名（切换到「全部 C 段」看全量）' : '暂无域名数据（信息收集阶段会写入域名）'))

      /* Web 资产：标题 + 可直接点击的 URL */
      const webPane = h('div', { className: 'rt-table' },
        h('div', { className: 'rt-row head', style: { gridTemplateColumns: '1.6fr 1.2fr 130px 110px' } },
          h('span', null, 'URL（可点击）'), h('span', null, '标题'), h('span', null, '资产'), h('span', null, '服务')),
        (web || []).map((w) => {
          const url = w.url || ('http' + (w.port === 443 || w.port === 8443 || w.port === 9443 ? 's' : '') + '://' + w.ip + (w.port === 80 || w.port === 443 ? '' : ':' + w.port))
          return h('div', {
            key: 'w' + w.port_id, className: 'rt-row',
            style: { gridTemplateColumns: '1.6fr 1.2fr 130px 110px', cursor: 'default' },
          },
            h('a', { className: 'rt-link rt-mono', href: url, target: '_blank', rel: 'noreferrer', title: url }, url),
            h('span', { title: w.title || '' }, w.title || '—'),
            h('span', { className: 'rt-mono' }, w.ip + ' · ' + w.segment_cidr),
            h('span', { style: { fontSize: 11 } }, [w.service, w.product, w.version].filter(Boolean).join(' ')))
        }),
        web === null ? h('div', { className: 'rt-empty' }, '加载中…')
          : (!web.length ? h('div', { className: 'rt-empty' }, cidr ? '该 C 段下暂无 Web 资产' : '暂无 Web 资产（HTTP 探测后会写入 URL 与标题）') : null))

      const graphPane = h('div', { className: 'rt-graphwrap' },
        graphState.data
          ? h(GraphCanvas, { data: graphState.data })
          : h('div', { className: 'rt-empty' }, graphState.loading ? '图谱加载中…' : (graphState.error || '暂无数据')),
        h('div', { className: 'rt-legend' },
          h('span', null, h('i', { style: { background: '#6366f1' } }), 'C 段'),
          h('span', null, h('i', { style: { background: '#10b981' } }), '存活资产'),
          h('span', null, h('i', { style: { background: '#9ca3af' } }), '离线资产'),
          h('span', null, h('i', { style: { background: '#f59e0b' } }), '开放端口'),
          h('span', null, h('i', { style: { background: '#ef4444' } }), '已确认漏洞'),
          h('span', null, h('i', { style: { background: '#fbbf24' } }), '已控制')))

      let pane = listPane
      if (view === 'domain') pane = domainPane
      else if (view === 'web') pane = webPane
      else if (view === 'graph') pane = graphPane

      return h('div', { className: 'rt-split' }, side,
        h('div', { className: 'rt-main' }, toolbar,
          conclusion,
          state.error ? h('div', { className: 'rt-err' }, state.error) : null,
          pane))
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

        const kindColor = { segment: '#6366f1', asset: '#10b981', port: '#f59e0b', domain: '#8b5cf6', vuln: '#ef4444' }
        const nodes = props.data.nodes.map((n, i) => {
          const a = (i / Math.max(1, props.data.nodes.length)) * Math.PI * 2
          const owned = n.kind === 'asset' && n.meta && n.meta.owned
          return Object.assign({}, n, {
            x: W / 2 + Math.cos(a) * Math.min(W, H) * 0.32,
            y: H / 2 + Math.sin(a) * Math.min(W, H) * 0.32,
            vx: 0, vy: 0,
            r: n.kind === 'segment' ? 13 : n.kind === 'vuln' ? 8 : n.kind === 'asset' ? 7 : 4.5,
            owned: owned,
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
            g.strokeStyle = l.r === 'contains' ? 'rgba(99,102,241,.30)'
              : l.r === 'has_vuln' ? 'rgba(239,68,68,.55)'
                : 'rgba(148,163,184,.35)'
            g.beginPath()
            g.moveTo(l.s.x, l.s.y)
            g.lineTo(l.t.x, l.t.y)
            g.stroke()
          }
          for (const n of nodes) {
            if (n.owned) {
              g.beginPath()
              g.arc(n.x, n.y, n.r + 4, 0, Math.PI * 2)
              g.strokeStyle = '#fbbf24'
              g.lineWidth = 2
              g.stroke()
              g.lineWidth = 1
            }
            g.beginPath()
            g.arc(n.x, n.y, n.r, 0, Math.PI * 2)
            g.fillStyle = n.kind === 'asset' && n.meta && n.meta.state !== 'live'
              ? '#9ca3af'
              : (kindColor[n.kind] || '#94a3b8')
            g.fill()
            if (n.kind === 'segment' || n.kind === 'asset' || n.kind === 'domain' || n.kind === 'vuln') {
              g.fillStyle = n.kind === 'vuln' ? 'rgba(248,113,113,.95)' : 'rgba(148,163,184,.95)'
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
      const refreshKey = props.refreshKey || 0
      const [roles, setRoles] = React.useState([])
      const [active, setActive] = React.useState(null)
      const [draft, setDraft] = React.useState('')
      const [msg, setMsg] = React.useState(null)
      const [busy, setBusy] = React.useState(false)

      React.useEffect(() => {
        if (!eng) return
        api({ op: 'prompts', engagement: eng }).then((r) => {
          if (!r || r.ok === false) { setMsg({ err: (r && r.error) || '读取失败' }); return }
          setRoles(r.roles || [])
          if (r.roles && r.roles.length) setActive((cur) => cur || r.roles[0].role)
        }, (e) => setMsg({ err: String((e && e.message) || e) }))
      }, [eng, refreshKey])

      React.useEffect(() => {
        const r = roles.find((x) => x.role === active)
        if (r) setDraft(r.content || '')
      }, [active, roles])

      const save = () => {
        setBusy(true)
        setMsg(null)
        api({ op: 'savePrompt', engagement: eng, role: active, content: draft }).then((r) => {
          setBusy(false)
          if (!r || r.ok === false) { setMsg({ err: (r && r.error) || '保存失败' }); return }
          setRoles((list) => list.map((x) => (x.role === active
            ? Object.assign({}, x, { content: draft, updated_at: new Date().toISOString() })
            : x)))
          setMsg({ ok: '已保存' })
        }, (e) => { setBusy(false); setMsg({ err: String((e && e.message) || e) }) })
      }

      /* 老靶标的提示词是旧版模板；这里可以把当前角色（或全部）恢复成内置最新版 */
      const reset = (all) => {
        setBusy(true); setMsg(null)
        api({ op: 'resetPrompts', engagement: eng, role: all ? undefined : active }).then((r) => {
          setBusy(false)
          if (!r || r.ok === false) { setMsg({ err: (r && r.error) || '恢复失败' }); return }
          setMsg({ ok: '已恢复内置默认：' + (r.reset || []).join('、') })
          api({ op: 'prompts', engagement: eng }).then((rr) => {
            if (rr && rr.ok) {
              setRoles(rr.roles || [])
              const cur2 = (rr.roles || []).find((x) => x.role === active)
              if (cur2) setDraft(cur2.content || '')
            }
          }, () => {})
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
            h('button', {
              className: 'rt-btn', disabled: busy || !active, title: '把当前角色恢复成内置最新版提示词',
              onClick: () => reset(false),
            }, '恢复默认为当前'),
            h('button', {
              className: 'rt-btn', disabled: busy, title: '四个角色全部恢复成内置最新版提示词',
              onClick: () => reset(true),
            }, '全部恢复默认'),
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

    /* ---------------------------------------------------------- 技能库（DSH 原生） */
    function SkillsTab(props) {
      const refreshKey = props.refreshKey || 0
      const [items, setItems] = React.useState([])
      const [roots, setRoots] = React.useState([])
      const [err, setErr] = React.useState(null)
      const [q, setQ] = React.useState('')
      const [active, setActive] = React.useState(null)
      const [detail, setDetail] = React.useState(null)
      const [busy, setBusy] = React.useState(false)

      const load = () => {
        setBusy(true)
        api({ op: 'skillCatalog' }).then((r) => {
          setBusy(false)
          if (!r || r.ok === false) { setErr((r && r.error) || '读取失败'); return }
          setErr(null)
          setRoots(r.roots || [])
          setItems(r.items || [])
        }, (e) => { setBusy(false); setErr(String((e && e.message) || e)) })
      }
      React.useEffect(load, [refreshKey])

      const open = (name) => {
        if (active === name) { setActive(null); setDetail(null); return }
        setActive(name)
        setDetail(null)
        api({ op: 'skillRead', name: name }).then((r) => {
          if (r && r.ok) setDetail(r)
          else setErr((r && r.error) || '读取失败')
        }, (e) => setErr(String((e && e.message) || e)))
      }

      const needle = q.trim().toLowerCase()
      const filtered = needle
        ? items.filter((s) => (s.name + ' ' + s.description + ' ' + s.whenToUse).toLowerCase().indexOf(needle) >= 0)
        : items
      const needRestart = err !== null && String(err).indexOf('unknown op') >= 0

      const listItems = filtered.map((s) => h('div', {
        key: s.name, className: 'rt-item' + (active === s.name ? ' on' : ''),
        onClick: () => open(s.name),
      },
        h('div', { className: 'rt-item-name' }, s.name,
          s.modelInvocable === false ? h('span', { className: 'rt-tag', style: { marginLeft: 6 } }, '仅人工') : null),
        h('div', { className: 'rt-item-desc' }, s.description || '（无描述）')))

      return h('div', { className: 'rt-split' },
        h('div', { className: 'rt-list' },
          h('input', {
            className: 'rt-input', style: { width: '100%', marginBottom: 8, boxSizing: 'border-box' },
            placeholder: '过滤技能', value: q, onChange: (e) => setQ(e.target.value),
          }),
          h('div', { style: { fontSize: 11, color: 'var(--dsw-alias-label-secondary)', marginBottom: 8 } },
            '共 ' + items.length + ' 个 · 由 DSH 管理'),
          listItems),
        h('div', { className: 'rt-main' },
          h('div', { className: 'rt-toolbar' },
            h('span', { style: { fontWeight: 600 } }, detail ? detail.name : '技能目录（DSH 原生）'),
            h('div', { className: 'rt-spacer' }),
            h('button', { className: 'rt-btn', disabled: busy, onClick: load }, busy ? '刷新中…' : '刷新')),
          err
            ? (needRestart
                ? h('div', { className: 'rt-empty' }, '该模块的宿主代码已更新，需重启一次 dsh web 后生效')
                : h('div', { className: 'rt-err' }, err))
            : null,
          detail
            ? h('div', { className: 'rt-pane' },
                h('div', { className: 'rt-kv' }, h('b', null, '描述'), h('span', null, detail.description || '—')),
                h('div', { className: 'rt-kv' }, h('b', null, '何时使用'), h('span', null, detail.whenToUse || '—')),
                h('div', { className: 'rt-kv' }, h('b', null, '来源'), h('span', null, (detail.provider || '—') + ' / ' + (detail.source || '—'))),
                detail.path ? h('div', { className: 'rt-kv' }, h('b', null, '文件'), h('span', { className: 'rt-mono', style: { wordBreak: 'break-all' } }, detail.path)) : null,
                h('pre', { className: 'rt-md', style: { border: '1px solid var(--dsw-alias-border-l1)', borderRadius: 6, maxHeight: '52vh' } }, detail.content || '（空）'))
            : h('div', { className: 'rt-pane' },
                h('div', { style: { fontSize: 12, color: 'var(--dsw-alias-label-secondary)', marginBottom: 8 } },
                  '技能由 harness 的 skill 体系管理，红队智能体通过原生 skill 工具调用。技能根：'),
                h('div', { style: { fontSize: 12, marginBottom: 12 } }, roots.map((r) => h('div', { key: r, className: 'rt-mono' }, '· ' + r))),
                h('div', { className: 'rt-empty' }, '左侧选择技能查看内容')))
      )
    }

    /* ---------------------------------------------------------- 漏洞战果 */
    const SEV_LABEL = { critical: '严重', high: '高危', medium: '中危', low: '低危', info: '信息' }
    const STATUS_LABEL = { candidate: '待验证', confirmed: '已确认', 'false-positive': '误报', exploited: '已利用', fixed: '已修复' }
    const sevClass = (s) => 'rt-sev rt-sev-' + (SEV_LABEL[s] ? s : 'info')


    /** 目标归并：按「scheme://host:port」聚合，避免带路径的 URL 把分组打散。 */
    function targetKeyOf(v) {
      const t = String(v.target || '').trim()
      if (t !== '') {
        const url = /^([a-z][a-z0-9+.-]*:\/\/[^/?#\s]+)/i.exec(t)
        if (url) return url[1]
        const head = /^([^\s/?#]+)/.exec(t)
        if (head) return head[1]
        return t
      }
      return v.asset_ip || '(未指定目标)'
    }

    /* ---------------------------------------------------------- 证据渲染 */
    /** 把一段原始 HTTP 报文按「请求行/状态行 + 头 + 体」着色，便于人眼扫读。 */
    function HttpBlock(props) {
      const text = String(props.text || '')
      if (!text) return null
      const lines = text.split(/\r?\n/)
      const nodes = lines.map((ln, i) => {
        let cls = null
        if (i === 0 && /^(GET|POST|PUT|DELETE|HEAD|OPTIONS|PATCH|TRACE)\s/.test(ln)) cls = 'rt-hl-req'
        else if (i === 0 && /^HTTP\//.test(ln)) cls = 'rt-hl-res'
        else if (/^[A-Za-z0-9-]+:/.test(ln)) {
          const name = ln.split(':')[0].toLowerCase()
          if (name === 'host' || name === 'cookie' || name === 'authorization' || name === 'content-type') cls = 'rt-hl-req'
        }
        return h('div', { key: 'l' + i, className: cls || undefined }, ln === '' ? '\u00a0' : ln)
      })
      return h('pre', { className: 'rt-evi-body' + (props.compact ? ' req' : '') }, nodes)
    }

    /** 漏洞详情里的证据区：结构化证据文本 + 该漏洞的原始 HTTP 请求/响应记录。 */
    function detailEvidence(v) {
      const evi = String(v.evidence || '').trim()
      const looksHttp = /^(GET|POST|PUT|DELETE|HEAD|OPTIONS|PATCH|HTTP\/)/m.test(evi) || /\n[A-Za-z-]+: /.test(evi)
      const blocks = []
      if (evi) {
        blocks.push(h('div', { key: 'ev', className: 'rt-evi' },
          h('div', { className: 'rt-evi-head' }, '证据摘要',
            h('span', { className: 'rt-tag' }, looksHttp ? '原始报文' : '文本'),
            h('div', { className: 'rt-spacer' }),
            h('button', {
              className: 'rt-btn', style: { padding: '0 6px', fontSize: 11 },
              onClick: (e) => { e.stopPropagation(); try { navigator.clipboard.writeText(evi) } catch (err) { /* ignore */ } },
            }, '复制')),
          looksHttp ? h(HttpBlock, { text: evi }) : h('pre', { className: 'rt-evi-body' }, evi)))
      }
      const http = v.http_evidence || []
      for (const e of http) {
        blocks.push(h('div', { key: 'h' + e.id, className: 'rt-evi' },
          h('div', { className: 'rt-evi-head' },
            e.label || 'HTTP 证据',
            h('span', { className: 'rt-tag' }, (e.method || '') + ' ' + (e.status === null || e.status === undefined ? '' : e.status)),
            h('div', { className: 'rt-spacer' }),
            h('span', { style: { fontWeight: 400, color: 'var(--dsw-alias-label-secondary)' } }, fmt(e.captured_at))),
          e.request ? h('div', null,
            h('div', { className: 'rt-evi-head', style: { borderTop: 'none' } }, '▸ 请求（可直接粘进 Burp Repeater）'),
            h(HttpBlock, { text: e.request, compact: true })) : null,
          e.response ? h('div', null,
            h('div', { className: 'rt-evi-head' }, '▸ 响应'),
            h(HttpBlock, { text: e.response })) : null,
          e.note ? h('pre', { className: 'rt-evi-body', style: { maxHeight: 80 } }, e.note) : null))
      }
      if (blocks.length === 0) {
        blocks.push(h('div', { key: 'none', className: 'rt-kv' }, h('b', null, '证据'),
          h('span', { style: { color: 'var(--dsw-alias-state-error-primary)' } }, '缺失 —— 未验证/无证据的漏洞不计入报告，请补 redteam_http_evidence_add')))
      }
      return h('div', { key: 'eviwrap' }, blocks)
    }

    function FindingsTab(props) {
      const eng = props.engagement
      const refreshKey = props.refreshKey || 0
      const [sev, setSev] = React.useState('')
      const [status, setStatus] = React.useState('')
      const [q, setQ] = React.useState('')
      const [qApplied, setQApplied] = React.useState('')
      const [state, setState] = React.useState({ loading: false, error: null, total: 0, items: [], stats: null })
      const [creds, setCreds] = React.useState([])
      const [accesses, setAccesses] = React.useState([])
      const [openId, setOpenId] = React.useState(null)
      const [msg, setMsg] = React.useState(null)
      /* 子页签：漏洞 / 凭据 / 访问会话（凭据不再铺在漏洞页底部） */
      const [subTab, setSubTab] = React.useState('vulns')
      /* 默认按目标聚合：322 条平铺没法读，先看"哪台被打下什么" */
      const [grouped, setGrouped] = React.useState(true)
      const [openTarget, setOpenTarget] = React.useState({})

      const load = () => {
        if (!eng) return
        api({
          op: 'vulns', engagement: eng, severity: sev || undefined,
          status: status || undefined, q: qApplied || undefined, limit: 200,
        }).then((r) => {
          if (!r || r.ok === false) {
            setState({ loading: false, error: (r && r.error) || '查询失败', total: 0, items: [], stats: null })
            return
          }
          setState({ loading: false, error: null, total: r.total, items: r.items || [], stats: r.stats || null })
        }, (e) => setState({ loading: false, error: String((e && e.message) || e), total: 0, items: [], stats: null }))
        api({ op: 'credentials', engagement: eng }).then((r) => setCreds((r && r.items) || []), () => {})
        api({ op: 'access', engagement: eng }).then((r) => setAccesses((r && r.items) || []), () => {})
      }
      React.useEffect(load, [eng, sev, status, qApplied, refreshKey])

      const setVulnStatus = (id, next) => {
        setMsg(null)
        api({ op: 'updateVuln', engagement: eng, id: id, patch: { status: next } }).then((r) => {
          if (!r || r.ok === false) { setMsg({ err: (r && r.error) || '更新失败' }); return }
          setMsg({ ok: '已更新为「' + (STATUS_LABEL[next] || next) + '」' })
          load()
        }, (e) => setMsg({ err: String((e && e.message) || e) }))
      }

      const stats = (state.stats && state.stats.bySeverity) ? state.stats : { bySeverity: {}, byStatus: {} }
      const needRestart = state.error !== null && String(state.error).indexOf('unknown op') >= 0

      /* ── 结论行：只给结论，数字点一下就是筛选 ─────────────────────── */
      const concl = (key, label, value, active, onClick) => h('span', {
        key: key, className: 'rt-concl-i' + (active ? ' on' : ''), onClick: onClick, title: '点击筛选 / 再点取消',
      }, h('b', null, String(value || 0)), h('span', null, label))
      const conclusion = h('div', { className: 'rt-concl' },
        concl('conf', '已确认', (stats.byStatus.confirmed || 0), status === 'confirmed', () => setStatus((v) => (v === 'confirmed' ? '' : 'confirmed'))),
        concl('exp', '已利用', (stats.byStatus.exploited || 0), status === 'exploited', () => setStatus((v) => (v === 'exploited' ? '' : 'exploited'))),
        concl('crit', '严重', (stats.bySeverity.critical || 0), sev === 'critical', () => setSev((v) => (v === 'critical' ? '' : 'critical'))),
        concl('high', '高危', (stats.bySeverity.high || 0), sev === 'high', () => setSev((v) => (v === 'high' ? '' : 'high'))),
        concl('med', '中危', (stats.bySeverity.medium || 0), sev === 'medium', () => setSev((v) => (v === 'medium' ? '' : 'medium'))),
        concl('gain', '拿到权限', (stats.withGained || 0), false, () => {}),
        h('div', { className: 'rt-spacer' }),
        h('span', { style: { fontSize: 11, color: 'var(--dsw-alias-label-secondary)' } },
          '默认按目标聚合 · 共 ' + (stats.targetGroups || 0) + ' 个目标'))

      const head = h('div', { className: 'rt-vrow head' },
        h('span', null, '等级'), h('span', null, '漏洞 / 编号'), h('span', null, '目标'),
        h('span', null, '拿到什么'), h('span', null, '状态'), h('span', null, '置信'))

      /* 单条漏洞（行 + 展开详情），聚合视图与平铺视图共用 */
      const vulnRows = (v) => {
        const out = []
        const gainedList = String(v.gained || '').split(/[、,;，；]/).map((x) => x.trim()).filter(Boolean)
        out.push(h('div', {
          key: 'v' + v.id, className: 'rt-vrow',
          style: { cursor: 'pointer' },
          onClick: () => setOpenId(openId === v.id ? null : v.id),
        },
          h('span', null, h('span', { className: sevClass(v.severity) }, SEV_LABEL[v.severity] || v.severity)),
          h('span', { title: v.title || '' }, (v.cve ? v.cve + ' ' : '') + (v.title || '')),
          h('span', { className: 'rt-mono', title: v.target || '' }, v.target || v.asset_ip || '—'),
          h('span', { title: v.gained || '' },
            gainedList.length
              ? h('span', { className: 'rt-gain', style: { maxWidth: '100%', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', display: 'inline-block' } }, gainedList[0] + (gainedList.length > 1 ? ' +' + (gainedList.length - 1) : ''))
              : h('span', { style: { color: 'var(--dsw-alias-label-secondary)' } }, '—')),
          h('span', null, h('span', { className: 'rt-tag' }, STATUS_LABEL[v.status] || v.status)),
          h('span', null, v.confidence === null || v.confidence === undefined ? '—' : Math.round(v.confidence * 100) + '%')))
        if (openId !== v.id) return out
        out.push(h('div', {
          key: 'vd' + v.id, className: 'rt-vrow',
          style: { cursor: 'default', gridTemplateColumns: '1fr' },
        }, h('div', { className: 'rt-vdetail' },
          h('div', { className: 'rt-kv' }, h('b', null, '拿到什么'),
            gainedList.length
              ? h('span', null, gainedList.map((g, gi) => h('span', { key: 'g' + gi, className: 'rt-gain', style: { marginRight: 6 } }, g)))
              : h('span', { style: { color: 'var(--dsw-alias-label-secondary)' } },
                  '未记录 —— 拿到权限/成果后请用 redteam_vuln_update 补 gained（例：服务器权限、内网隧道、后台管理员账号）')),
          h('div', { className: 'rt-kv' }, h('b', null, '资产'), h('span', null, (v.asset_ip || '—') + ' · ' + (v.segment_cidr || ''))),
          h('div', { className: 'rt-kv' }, h('b', null, '来源'), h('span', null, (v.source || '—') + ' · ' + (v.found_by_agent || '—') + ' · ' + fmt(v.found_at))),
          detailEvidence(v),
          h('div', { className: 'rt-actions' },
            h('button', { className: 'rt-btn', onClick: (e) => { e.stopPropagation(); setVulnStatus(v.id, 'confirmed') } }, '确认'),
            h('button', { className: 'rt-btn', onClick: (e) => { e.stopPropagation(); setVulnStatus(v.id, 'exploited') } }, '已利用'),
            h('button', { className: 'rt-btn', onClick: (e) => { e.stopPropagation(); setVulnStatus(v.id, 'false-positive') } }, '误报'),
            h('button', { className: 'rt-btn', onClick: (e) => { e.stopPropagation(); setVulnStatus(v.id, 'fixed') } }, '已修复')))))
        return out
      }

      const rows = []
      if (grouped) {
        /* 按目标聚合成组：先看"哪台被打下什么"，再点进去看具体漏洞 */
        const groups = new Map()
        for (const v of state.items) {
          const key = targetKeyOf(v)
          if (!groups.has(key)) groups.set(key, [])
          groups.get(key).push(v)
        }
        const SEV_RANK = { critical: 0, high: 1, medium: 2, low: 3, info: 4 }
        const list = Array.from(groups.entries()).map(([key, vs]) => ({
          key,
          vulns: vs,
          top: vs.slice().sort((a, b) => (SEV_RANK[a.severity] ?? 9) - (SEV_RANK[b.severity] ?? 9))[0],
          gained: Array.from(new Set(vs.flatMap((v) => String(v.gained || '').split(/[、,;，；]/).map((x) => x.trim()).filter(Boolean)))),
          exploited: vs.filter((v) => v.status === 'exploited').length,
        })).sort((a, b) => (SEV_RANK[a.top.severity] ?? 9) - (SEV_RANK[b.top.severity] ?? 9) || b.vulns.length - a.vulns.length)
        for (const g of list) {
          const isOpen = openTarget[g.key] === true
          rows.push(h('div', {
            key: 'g' + g.key, className: 'rt-grp',
            onClick: () => setOpenTarget((o) => Object.assign({}, o, { [g.key]: !o[g.key] })),
          },
            h('span', { style: { flex: 'none', color: 'var(--dsw-alias-label-secondary)' } }, isOpen ? '▾' : '▸'),
            h('span', { className: 'rt-sev rt-sev-' + g.top.severity }, SEV_LABEL[g.top.severity] || g.top.severity),
            h('span', { className: 'rt-grp-t' }, g.key),
            h('span', { className: 'rt-grp-n' }, g.vulns.length + ' 个漏洞'),
            g.exploited ? h('span', { className: 'rt-grp-n', style: { color: '#10b981' } }, '已利用 ' + g.exploited) : null,
            g.top.asset_ip && g.top.asset_ip !== g.key ? h('span', { className: 'rt-grp-n' }, '资产 ' + g.top.asset_ip) : null,
            h('div', { className: 'rt-spacer' }),
            g.gained.length
              ? h('span', null, g.gained.slice(0, 2).map((x, i) => h('span', { key: 'gg' + i, className: 'rt-gain', style: { marginLeft: 6 } }, x)),
                  g.gained.length > 2 ? h('span', { className: 'rt-grp-n', style: { marginLeft: 4 } }, '+' + (g.gained.length - 2)) : null)
              : h('span', { className: 'rt-grp-n' }, '未记录拿到的权限')))
          if (isOpen) for (const v of g.vulns) rows.push(...vulnRows(v))
        }
        if (!list.length && !state.loading && !state.error) {
          rows.push(h('div', { key: 'none', className: 'rt-empty' }, '暂无漏洞记录'))
        }
      } else {
        for (const v of state.items) rows.push(...vulnRows(v))
      }

      const toolbar = h('div', { className: 'rt-toolbar' },
        h('input', {
          className: 'rt-input', style: { flex: '1 1 140px' }, placeholder: '搜索标题 / CVE / 目标（回车）',
          value: q, onChange: (e) => setQ(e.target.value),
          onKeyDown: (e) => { if (e.key === 'Enter') setQApplied(q) },
        }),
        h('button', { className: 'rt-btn', onClick: () => setQApplied(q) }, '搜索'),
        h('select', { className: 'rt-input', value: sev, onChange: (e) => setSev(e.target.value) },
          h('option', { value: '' }, '全部等级'),
          h('option', { value: 'critical' }, '严重'),
          h('option', { value: 'high' }, '高危'),
          h('option', { value: 'medium' }, '中危'),
          h('option', { value: 'low' }, '低危'),
          h('option', { value: 'info' }, '信息')),
        h('select', { className: 'rt-input', value: status, onChange: (e) => setStatus(e.target.value) },
          h('option', { value: '' }, '全部状态'),
          h('option', { value: 'candidate' }, '待验证'),
          h('option', { value: 'confirmed' }, '已确认'),
          h('option', { value: 'exploited' }, '已利用'),
          h('option', { value: 'false-positive' }, '误报'),
          h('option', { value: 'fixed' }, '已修复')))

      const credSection = h('div', null,
        h('div', { className: 'rt-section' }, '凭据 · ' + creds.length + (creds.length ? '（明文直显，注意屏幕分享/录屏）' : '')),
        creds.length
          ? h('div', { style: { padding: '4px 10px 0' } }, creds.map((c) => h('div', { key: 'c' + c.id, className: 'rt-cred' },
              h('div', { className: 'rt-cred-head' },
                h('span', { className: 'rt-cred-host' }, c.host),
                c.username ? h('span', { className: 'rt-tag' }, c.username) : null,
                h('span', { className: 'rt-tag rt-tag-passive' }, c.secret_type || 'password'),
                c.privilege ? h('span', { className: 'rt-tag rt-tag-active' }, c.privilege) : null,
                h('div', { className: 'rt-spacer' }),
                h('button', {
                  className: 'rt-btn', style: { padding: '0 6px', fontSize: 11 },
                  onClick: (e) => {
                    e.stopPropagation()
                    try { navigator.clipboard.writeText(String(c.secret_value || '')) } catch (err) { /* ignore */ }
                  },
                }, '复制')),
              c.secret_value
                ? h('div', { className: 'rt-secret', title: '点击可全选' }, c.secret_value)
                : h('div', { className: 'rt-secret-none' }, '未记明文 —— 请用 redteam_credential_add 的 secret_value 补上，面板才能直显'),
              h('div', { className: 'rt-cred-meta' },
                [c.source ? '来源 ' + c.source : null,
                  c.tool ? '工具 ' + c.tool : null,
                  c.secret_ref ? '证据 ' + c.secret_ref : null,
                  c.found_by_agent ? 'by ' + c.found_by_agent : null,
                  c.found_at ? fmt(c.found_at) : null].filter(Boolean).join(' · ')),
              c.note ? h('div', { className: 'rt-cred-meta' }, '备注：' + c.note) : null)))
          : h('div', { className: 'rt-empty' }, '暂无凭据（拿到口令/密钥/Hash 后用 redteam_credential_add 落库，秒级可复用）'))

      const accessSection = h('div', null,
        h('div', { className: 'rt-section' }, '已获得访问会话 · ' + accesses.length),
        accesses.length
          ? accesses.map((a) => h('div', { key: 'a' + a.id, className: 'rt-vrow', style: { cursor: 'default', gridTemplateColumns: '1fr 110px 80px 80px 1fr' } },
              h('span', { className: 'rt-mono' }, a.host),
              h('span', null, a.username || '—'),
              h('span', null, h('span', { className: 'rt-tag rt-tag-active' }, a.method || '—')),
              h('span', null, a.privilege || '—'),
              h('span', { className: 'rt-mono', title: a.session_ref || '' }, a.session_ref || '—')))
          : h('div', { className: 'rt-empty' }, '暂无'))

      const subTabBtn = (key, label, n) => h('span', {
        className: 'rt-subtab' + (subTab === key ? ' on' : ''),
        onClick: () => setSubTab(key),
      }, label + ' ' + n)

      return h('div', { className: 'rt-main' }, toolbar, conclusion,
        h('div', { className: 'rt-subtabs' },
          subTabBtn('vulns', '漏洞', state.total || 0),
          subTabBtn('creds', '凭据', creds.length),
          subTabBtn('access', '访问会话', accesses.length),
          h('div', { className: 'rt-spacer' }),
          h('button', {
            className: 'rt-btn' + (grouped ? ' rt-btn-primary' : ''),
            title: grouped ? '当前：按目标聚合（先看哪台被打下什么）' : '当前：平铺每条漏洞',
            onClick: () => setGrouped((g) => !g),
          }, grouped ? '按目标聚合' : '平铺列表')),
        msg ? h('div', { className: msg.err ? 'rt-err' : 'rt-foot' }, msg.err || msg.ok) : null,
        needRestart ? h('div', { className: 'rt-empty' }, '该模块的宿主代码已更新，需重启一次 dsh web 后生效') : null,
        state.error && !needRestart ? h('div', { className: 'rt-err' }, state.error) : null,
        subTab === 'creds'
          ? h('div', { className: 'rt-body', style: { overflow: 'auto' } }, credSection)
          : subTab === 'access'
            ? h('div', { className: 'rt-body', style: { overflow: 'auto' } }, accessSection)
            : h('div', { className: 'rt-table' }, head, rows,
                !state.loading && !state.items.length && !state.error ? h('div', { className: 'rt-empty' }, '暂无漏洞记录') : null))
    }

    /* ---------------------------------------------------------- 攻击链 */
    const STAGE_LABEL = { recon: '信息收集', vuln: '漏洞发现', exploit: '漏洞利用', access: '获得权限', pivot: '内网突破', data: '敏感数据', other: '其他' }

    function ChainTab(props) {
      const eng = props.engagement
      const refreshKey = props.refreshKey || 0
      const [items, setItems] = React.useState([])
      const [score, setScore] = React.useState(null)
      const [err, setErr] = React.useState(null)
      const [loading, setLoading] = React.useState(false)
      /* 两种链路分开看：实际攻击链（攻击步骤） / 得分链路（只含得分） */
      const [mode, setMode] = React.useState('attack')
      /* 展示顺序：默认倒序（最新的一步在最上面），可切换为正序 */
      const [desc, setDesc] = React.useState(true)
      /* 阶段分组折叠：undefined=默认只展开最近活跃阶段，null=全折叠，字符串=展开该阶段 */
      const [openStage, setOpenStage] = React.useState(undefined)
      /* 单步展开（默认只占一行） */
      const [openStep, setOpenStep] = React.useState(null)

      const load = () => {
        if (!eng) return
        setLoading(true)
        api({ op: 'chain', engagement: eng }).then((r) => {
          setLoading(false)
          if (!r || r.ok === false) { setErr((r && r.error) || '读取失败'); return }
          setErr(null)
          setItems(r.items || [])
        }, (e) => { setLoading(false); setErr(String((e && e.message) || e)) })
      }
      React.useEffect(load, [eng, refreshKey])

      React.useEffect(() => {
        if (!eng || mode !== 'score') return
        api({ op: 'scoreChain', engagement: eng }).then((r) => {
          if (!r || r.ok === false) { setErr((r && r.error) || '得分链路读取失败'); return }
          setErr(null)
          setScore(r)
        }, (e) => setErr(String((e && e.message) || e)))
      }, [eng, mode, refreshKey])

      const ordered = desc ? items.slice().reverse() : items
      /* 一步默认只占一行（序号 + 标题 + 阶段 + 时间），点开才看详情与结构化 chip */
      const stepNode = (s, i) => {
        const stageKey = STAGE_LABEL[s.stage] ? s.stage : 'other'
        const expanded = openStep === s.id
        const chips = []
        if (s.asset_ip) chips.push(h('span', { key: 'ip', className: 'rt-chip' }, h('i', null, '资产'), h('span', { className: 'rt-mono' }, s.asset_ip)))
        if (s.vuln_cve || s.vuln_title) {
          chips.push(h('span', { key: 'vuln', className: 'rt-chip' },
            h('i', null, '漏洞'),
            h('span', null, [s.vuln_cve, s.vuln_title].filter(Boolean).join(' '))))
        }
        if (s.evidence_ref) chips.push(h('span', { key: 'evi', className: 'rt-chip' }, h('i', null, '证据'), h('span', null, s.evidence_ref)))
        if (s.recorded_by) chips.push(h('span', { key: 'by', className: 'rt-chip' }, h('i', null, '记录'), h('span', null, s.recorded_by)))
        const preview = s.detail ? String(s.detail).split('\n')[0] : ''
        return h('div', { key: 's' + s.id, className: 'rt-step', style: { cursor: 'pointer' },
          onClick: () => setOpenStep((cur) => (cur === s.id ? null : s.id)) },
          h('div', { className: 'rt-step-dot rt-stage-' + stageKey }, String(s.seq === null || s.seq === undefined ? i + 1 : s.seq)),
          h('div', { className: 'rt-step-body', style: { flex: 1 } },
            h('div', { className: 'rt-step-head' },
              h('span', { className: 'rt-step-title' }, (s.title || '（未命名步骤）').slice(0, 80)),
              s.vuln_severity ? h('span', { className: 'rt-sev rt-sev-' + s.vuln_severity }, s.vuln_severity) : null,
              h('span', { className: 'rt-step-time' }, fmt(s.recorded_at))),
            expanded
              ? h('div', null,
                  s.detail ? h('div', { className: 'rt-step-detail' }, s.detail) : null,
                  chips.length ? h('div', null, chips) : null)
              : (preview ? h('div', { className: 'rt-step-meta', style: { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, preview.slice(0, 110)) : null)))
      }

      /* 按阶段分组：默认只展开最近活跃的那个阶段，其余折叠成一行 */
      const groups = []
      const gIdx = new Map()
      for (const s of ordered) {
        const k = STAGE_LABEL[s.stage] ? s.stage : 'other'
        let g = gIdx.get(k)
        if (g === undefined) {
          g = { key: k, label: STAGE_LABEL[k] || k, list: [] }
          gIdx.set(k, g)
          groups.push(g)
        }
        g.list.push(s)
      }
      const currentStage = groups.length ? groups[0].key : null
      const activeStage = openStage === undefined ? currentStage : openStage
      const steps = []
      for (const g of groups) {
        const isOpen = activeStage === g.key
        steps.push(h('div', {
          key: 'g' + g.key, className: 'rt-stagegrp',
          onClick: () => setOpenStage((cur) => ((cur === undefined ? currentStage : cur) === g.key ? null : g.key)),
        },
          h('span', { className: 'rt-stage-tag rt-st-' + g.key }, g.label),
          h('span', { className: 'rt-grp-n' }, g.list.length + ' 步'),
          h('div', { className: 'rt-spacer' }),
          h('span', { className: 'rt-grp-n' }, fmt(g.list[0] && g.list[0].recorded_at)),
          h('span', { style: { color: 'var(--dsw-alias-label-secondary)' } }, isOpen ? '▾' : '▸')))
        if (isOpen) for (let i = 0; i < g.list.length; i++) steps.push(stepNode(g.list[i], i))
      }

      /* 得分链路：只呈现"得分"这条线，不含任何信息收集/未得分的过程 */
      const scoreItems = (score && score.items) || []
      const scoreOrdered = desc ? scoreItems.slice().reverse() : scoreItems
      const scoreSteps = scoreOrdered.map((x, i) => {
        const chips = []
        if (x.target) chips.push(h('span', { key: 't', className: 'rt-chip' }, h('i', null, '目标'), h('span', { className: 'rt-mono' }, x.target)))
        if (x.asset_ip && x.asset_ip !== x.target) chips.push(h('span', { key: 'ip', className: 'rt-chip' }, h('i', null, '资产'), h('span', { className: 'rt-mono' }, x.asset_ip)))
        if (x.recorded_by) chips.push(h('span', { key: 'by', className: 'rt-chip' }, h('i', null, '记录'), h('span', null, x.recorded_by)))
        return h('div', { key: 'sc' + x.id, className: 'rt-step' },
          h('div', { className: 'rt-step-dot rt-stage-score' }, String(x.points === null || x.points === undefined ? i + 1 : x.points)),
          h('div', { className: 'rt-step-body', style: { flex: 1 } },
            h('div', { className: 'rt-step-head' },
              h('span', { className: 'rt-step-title' }, x.point_name || x.code || '（已删除的得分点）'),
              x.category ? h('span', { className: 'rt-stage-tag rt-st-other' }, x.category) : null,
              h('span', { className: 'rt-scorepts' }, '+' + (x.points || 0) + ' 分'),
              h('span', { className: 'rt-step-time' }, fmt(x.recorded_at))),
            h('div', { className: 'rt-step-detail' }, x.evidence || '（未填证据）'),
            chips.length ? h('div', null, chips) : null))
      })

      const scoreSummary = (score && score.summary) || null
      const isScore = mode === 'score'

      return h('div', { className: 'rt-main' },
        h('div', { className: 'rt-toolbar' },
          h('span', { style: { fontWeight: 600 } }, '攻击链'),
          h('button', {
            className: 'rt-btn' + (isScore ? '' : ' rt-btn-primary'),
            title: '实际打过去的攻击步骤（信息收集 → 漏洞 → 权限 → 横向）',
            onClick: () => setMode('attack'),
          }, '实际攻击链'),
          h('button', {
            className: 'rt-btn' + (isScore ? ' rt-btn-primary' : ''),
            title: '只看拿到了哪些分数：每一条都是得分的成果，过程与未得分的工作不显示',
            onClick: () => setMode('score'),
          }, '得分链路'),
          isScore
            ? (scoreSummary
                ? h('span', { className: 'rt-tag rt-tag-live' }, '总分 ' + scoreSummary.points + ' 分 · 命中 ' + scoreSummary.hits + ' 次')
                : null)
            : h('span', { className: 'rt-tag' }, items.length + ' 步'),
          isScore && scoreSummary && scoreSummary.missingCount > 0
            ? h('span', { className: 'rt-tag' }, '未拿下 ' + scoreSummary.missingCount + ' 项 / ' + scoreSummary.missingPoints + ' 分')
            : null,
          h('div', { className: 'rt-spacer' }),
          h('button', {
            className: 'rt-btn',
            title: desc ? '当前：最新的一步在最上面（默认），点击切换为正序' : '当前：从第 1 步开始，点击切换为倒序',
            onClick: () => setDesc((d) => !d),
          }, desc ? '倒序 ↓' : '正序 ↑'),
          h('button', { className: 'rt-btn', disabled: loading, onClick: load }, loading ? '加载中…' : '刷新')),
        err ? h('div', { className: 'rt-err' }, err) : null,
        isScore
          ? h('div', { className: 'rt-chain' },
              scoreSteps.length
                ? scoreSteps
                : h('div', { className: 'rt-empty' },
                    '还没有得分记录。拿下成果后用 redteam_score_hit 记分（写明目标与证据），这条链路才会长出来。'))
          : h('div', { className: 'rt-chain' },
              steps.length
                ? steps
                : h('div', { className: 'rt-empty' }, '暂无攻击链记录（漏洞利用 / 内网突破阶段写入的步骤会按顺序出现在这里）')))
    }

    /* ---------------------------------------------------------- 报告（按目标折叠） */
    function ReportTab(props) {
      const eng = props.engagement
      const refreshKey = props.refreshKey || 0
      const [data, setData] = React.useState(null)
      const [err, setErr] = React.useState(null)
      const [busy, setBusy] = React.useState(false)
      const [openTarget, setOpenTarget] = React.useState({})
      const [closedGroup, setClosedGroup] = React.useState({})
      const [msg, setMsg] = React.useState(null)

      const load = () => {
        if (!eng) return
        setBusy(true)
        setMsg(null)
        api({ op: 'reportTargets', engagement: eng }).then((r) => {
          setBusy(false)
          if (!r || r.ok === false) { setErr((r && r.error) || '生成失败'); return }
          setErr(null)
          setData(r)
        }, (e) => { setBusy(false); setErr(String((e && e.message) || e)) })
      }
      React.useEffect(load, [eng, refreshKey])

      const copy = (markdown, label) => {
        if (navigator.clipboard && navigator.clipboard.writeText) {
          navigator.clipboard.writeText(markdown).then(() => setMsg({ ok: '已复制：' + label }), () => setMsg({ err: '复制失败，请手动选择' }))
        } else setMsg({ err: '浏览器不支持剪贴板' })
      }
      const download = (markdown, label) => {
        try {
          const blob = new Blob([markdown], { type: 'text/markdown;charset=utf-8' })
          const url = URL.createObjectURL(blob)
          const a = document.createElement('a')
          a.href = url
          a.download = 'report-' + String(label).replace(/[^\w.\-]/g, '_') + '.md'
          a.click()
          URL.revokeObjectURL(url)
          setMsg({ ok: '已下载：' + label })
        } catch (e) { setMsg({ err: '下载失败：' + ((e && e.message) || e) }) }
      }

      const totals = (data && data.totals) || { targets: 0, vulns: 0, accesses: 0, credentials: 0, files: 0, filteredOut: 0 }
      const groups = (data && data.groups) || []

      const groupNodes = groups.map((g) => {
        const closed = closedGroup[g.cidr] === true
        const vulnSum = g.targets.reduce((n, t) => n + t.stats.vulns, 0)
        const rows = []
        rows.push(h('div', {
          key: 'g' + g.cidr, className: 'rt-vrow', style: { gridTemplateColumns: '1fr auto auto', cursor: 'pointer', background: 'var(--dsw-alias-bg-layer-2)' },
          onClick: () => setClosedGroup((o) => Object.assign({}, o, { [g.cidr]: !o[g.cidr] })),
        },
          h('span', { className: 'rt-mono', style: { fontWeight: 600 } }, (closed ? '▸ ' : '▾ ') + g.cidr),
          h('span', { className: 'rt-tag' }, g.targets.length + ' 个目标'),
          h('span', { className: 'rt-tag rt-sev-high', style: { color: '#fff' } }, '漏洞 ' + vulnSum)))
        if (closed) return rows
        for (const t of g.targets) {
          const open = openTarget[t.key] === true
          rows.push(h('div', {
            key: 't' + t.key, className: 'rt-vrow', style: { gridTemplateColumns: '1fr auto auto auto' },
            onClick: () => setOpenTarget((o) => Object.assign({}, o, { [t.key]: !o[t.key] })),
          },
            h('span', { className: 'rt-mono' }, (open ? '▾ ' : '▸ ') + t.label),
            h('span', { className: 'rt-tag' }, '漏洞 ' + t.stats.vulns),
            t.stats.accesses ? h('span', { className: 'rt-tag rt-tag-active' }, '已控 ' + t.stats.accesses) : null,
            t.stats.files ? h('span', { className: 'rt-tag' }, '文件 ' + t.stats.files) : null))
          if (!open) continue
          rows.push(h('div', {
            key: 'td' + t.key, className: 'rt-vrow', style: { cursor: 'default', gridTemplateColumns: '1fr' },
          }, h('div', { className: 'rt-vdetail' },
            h('div', { className: 'rt-actions', style: { marginTop: 0, marginBottom: 6 } },
              h('button', { className: 'rt-btn', onClick: (e) => { e.stopPropagation(); copy(t.markdown, t.label) } }, '复制'),
              h('button', { className: 'rt-btn', onClick: (e) => { e.stopPropagation(); download(t.markdown, t.label) } }, '下载 .md')),
            h('pre', { className: 'rt-md', style: { border: '1px solid var(--dsw-alias-border-l1)', borderRadius: 6, maxHeight: '46vh', padding: '10px 12px' } }, t.markdown || '（无内容）'))))
        }
        return rows
      })

      return h('div', { className: 'rt-main' },
        h('div', { className: 'rt-toolbar' },
          h('span', { style: { fontWeight: 600 } }, '成果报告'),
          h('span', { className: 'rt-tag' }, totals.targets + ' 个目标'),
          h('span', { className: 'rt-tag' }, '漏洞 ' + totals.vulns),
          h('div', { className: 'rt-spacer' }),
          h('button', { className: 'rt-btn', disabled: busy, onClick: load }, busy ? '生成中…' : '重新生成'),
          h('button', {
            className: 'rt-btn rt-btn-primary',
            onClick: () => {
              const all = (data && data.targets) || []
              const head = '# 攻防演练成果报告 — ' + ((data && data.engagement && data.engagement.name) || eng) + '\n\n'
              download(head + all.map((t) => t.markdown).join('\n\n---\n\n'), '全部目标')
            },
          }, '下载全部')),
        msg ? h('div', { className: msg.err ? 'rt-err' : 'rt-foot' }, msg.err || msg.ok) : null,
        err ? h('div', { className: 'rt-err' }, err) : null,
        h('div', { className: 'rt-table' },
          groupNodes,
          data && !groups.length ? h('div', { className: 'rt-empty' }, '暂无可交付的成果（只收录已验证/已利用且中危以上的漏洞）') : null),
        h('div', { className: 'rt-foot' },
          h('span', null, '口径：已验证/已利用且中危以上'),
          h('span', null, '已控 ' + totals.accesses),
          h('span', null, '凭据 ' + totals.credentials),
          h('span', null, '攻击文件 ' + totals.files),
          h('span', null, '已过滤 ' + totals.filteredOut)))
    }

    /* ---------------------------------------------------------- 攻击文件 */
    const FILE_KIND = { poc: 'POC', exp: 'EXP', script: '脚本', wordlist: '字典', other: '其他' }

    function AttackFilesTab(props) {
      const eng = props.engagement
      const refreshKey = props.refreshKey || 0
      const [folders, setFolders] = React.useState([])
      const [err, setErr] = React.useState(null)
      const [busy, setBusy] = React.useState(false)
      const [closed, setClosed] = React.useState({})
      const [detail, setDetail] = React.useState(null)

      const load = () => {
        if (!eng) return
        setBusy(true)
        api({ op: 'attackFiles', engagement: eng }).then((r) => {
          setBusy(false)
          if (!r || r.ok === false) { setErr((r && r.error) || '读取失败'); return }
          setErr(null)
          setFolders(r.items || [])
        }, (e) => { setBusy(false); setErr(String((e && e.message) || e)) })
      }
      React.useEffect(load, [eng, refreshKey])

      const openFile = (f) => {
        if (detail && detail.id === f.id) { setDetail(null); return }
        setDetail(null)
        api({ op: 'readAttackFile', engagement: eng, id: f.id }).then((r) => {
          if (r && r.ok) setDetail(r)
          else setErr((r && r.error) || '读取失败')
        }, (e) => setErr(String((e && e.message) || e)))
      }

      const rows = []
      for (const folder of folders) {
        const isClosed = closed[folder.folder] === true
        rows.push(h('div', {
          key: 'f' + folder.folder, className: 'rt-vrow',
          style: { gridTemplateColumns: '1fr auto', cursor: 'pointer', background: 'var(--dsw-alias-bg-layer-2)' },
          onClick: () => setClosed((o) => Object.assign({}, o, { [folder.folder]: !o[folder.folder] })),
        },
          h('span', { className: 'rt-mono', style: { fontWeight: 600 } }, (isClosed ? '▸ ' : '▾ ') + folder.folder + '/'),
          h('span', { className: 'rt-tag' }, folder.count + ' 个文件')))
        if (isClosed) continue
        for (const f of folder.files) {
          rows.push(h('div', {
            key: 'a' + f.id, className: 'rt-vrow', style: { gridTemplateColumns: '1.2fr 60px 1.6fr' },
            onClick: () => openFile(f),
          },
            h('span', { className: 'rt-mono' }, (detail && detail.id === f.id ? '▾ ' : '▸ ') + f.name),
            h('span', null, h('span', { className: 'rt-tag rt-tag-active' }, FILE_KIND[f.kind] || f.kind || '—')),
            h('span', { style: { fontSize: 11.5, color: 'var(--dsw-alias-label-secondary)' }, title: f.description || '' }, f.description || '—')))
          if (!detail || detail.id !== f.id) continue
          rows.push(h('div', {
            key: 'ad' + f.id, className: 'rt-vrow', style: { cursor: 'default', gridTemplateColumns: '1fr' },
          }, h('div', { className: 'rt-vdetail' },
            h('div', { className: 'rt-kv' }, h('b', null, '效果'), h('span', null, detail.evidence || '—')),
            h('div', { className: 'rt-kv' }, h('b', null, '路径'), h('span', { className: 'rt-mono', style: { wordBreak: 'break-all' } }, detail.path)),
            h('div', { className: 'rt-kv' }, h('b', null, '记录'), h('span', null, fmt(detail.created_at) + (detail.created_by ? ' · ' + detail.created_by : ''))),
            h('pre', { className: 'rt-md', style: { border: '1px solid var(--dsw-alias-border-l1)', borderRadius: 6, maxHeight: '40vh', padding: '10px 12px' } }, detail.content || '（空）'))))
        }
      }

      const total = folders.reduce((n, f) => n + f.count, 0)
      return h('div', { className: 'rt-main' },
        h('div', { className: 'rt-toolbar' },
          h('span', { style: { fontWeight: 600 } }, '攻击文件'),
          h('span', { className: 'rt-tag' }, folders.length + ' 个目标 / ' + total + ' 个文件'),
          h('div', { className: 'rt-spacer' }),
          h('button', { className: 'rt-btn', disabled: busy, onClick: load }, busy ? '刷新中…' : '刷新')),
        err ? h('div', { className: 'rt-err' }, err) : null,
        h('div', { className: 'rt-table' },
          rows,
          !folders.length ? h('div', { className: 'rt-empty' }, '暂无攻击文件（打通的脚本/POC/EXP 会按目标文件夹出现在这里）') : null),
        h('div', { className: 'rt-foot' }, h('span', null, '目录：attack-files/<IP|URL主机|C段>/ ｜ 只收录实际生效的文件')))
    }

    /* ---------------------------------------------------------- 得分目标 */
    function ScoreTab(props) {
      const eng = props.engagement
      const refreshKey = props.refreshKey || 0
      const [data, setData] = React.useState(null)
      const [err, setErr] = React.useState(null)
      const [busy, setBusy] = React.useState(false)
      const [openId, setOpenId] = React.useState(null)
      const [form, setForm] = React.useState(null)
      const [msg, setMsg] = React.useState(null)

      const load = () => {
        if (!eng) return
        setBusy(true)
        api({ op: 'scores', engagement: eng }).then((r) => {
          setBusy(false)
          if (!r || r.ok === false) { setErr((r && r.error) || '读取失败'); return }
          setErr(null)
          setData(r)
        }, (e) => { setBusy(false); setErr(String((e && e.message) || e)) })
      }
      React.useEffect(load, [eng, refreshKey])

      const startEdit = (p) => setForm({ id: p.id, name: p.name, category: p.category || '', points: p.points, description: p.description || '', enabled: p.enabled })
      const startNew = () => { setForm({ name: '', category: '', points: 10, description: '', enabled: true }); setMsg(null) }
      const setField = (k, v) => setForm((f) => Object.assign({}, f, { [k]: v }))

      const save = () => {
        if (!form || !form.name) { setMsg({ err: '名称不能为空' }); return }
        setBusy(true)
        setMsg(null)
        api({ op: 'saveScorePoint', engagement: eng, point: form }).then((r) => {
          setBusy(false)
          if (!r || r.ok === false) { setMsg({ err: (r && r.error) || '保存失败' }); return }
          setMsg({ ok: '已保存' })
          setForm(null)
          load()
        }, (e) => { setBusy(false); setMsg({ err: String((e && e.message) || e) }) })
      }
      const remove = () => {
        if (!form || !form.id) { setForm(null); return }
        setBusy(true)
        setMsg(null)
        api({ op: 'deleteScorePoint', engagement: eng, id: form.id }).then((r) => {
          setBusy(false)
          if (!r || r.ok === false) { setMsg({ err: (r && r.error) || '删除失败' }); return }
          setMsg({ ok: '已删除' })
          setForm(null)
          setOpenId(null)
          load()
        }, (e) => { setBusy(false); setMsg({ err: String((e && e.message) || e) }) })
      }

      const summary = (data && data.summary) || { totalPoints: 0, achievedPoints: 0, achievedCount: 0, pointCount: 0, hitCount: 0 }
      const items = (data && data.items) || []

      const rows = []
      for (const p of items) {
        const achieved = p.hits.length > 0
        const open = openId === p.id
        rows.push(h('div', {
          key: 'sp' + p.id, className: 'rt-score-row',
          onClick: () => setOpenId(open ? null : p.id),
        },
          h('span', null, h('span', {
            className: achieved ? 'rt-pri rt-pri-high' : 'rt-pri rt-pri-low',
            style: achieved ? {} : { background: 'var(--dsw-alias-bg-layer-2)', color: 'var(--dsw-alias-label-secondary)' },
          }, p.points + '分')),
          h('span', { title: p.description || '' }, (open ? '▾ ' : '▸ ') + p.name + (p.category ? '（' + p.category + '）' : '')),
          h('span', null, achieved
            ? h('span', { className: 'rt-tag rt-tag-live' }, '已拿下')
            : h('span', { className: 'rt-tag' }, p.enabled ? '待争取' : '停用')),
          h('span', null, p.hits.length ? h('span', { className: 'rt-tag rt-tag-active' }, '命中 ' + p.hits.length) : null)))
        if (!open) continue
        /* 命中记录：每条一张卡片 —— 序号 / 目标 / 记录人 / 时间 / 证据正文 */
        const hitNodes = p.hits.map((hh, hi) => h('div', { key: 'h' + hh.id, className: 'rt-hit' },
          h('div', { className: 'rt-hit-head' },
            h('span', { className: 'rt-hit-idx' }, String(hi + 1)),
            h('span', { className: 'rt-hit-target' }, hh.target || '未指定目标'),
            hh.note ? h('span', { className: 'rt-tag' }, hh.note) : null,
            hh.recorded_by ? h('span', { className: 'rt-tag rt-tag-active' }, hh.recorded_by) : null,
            h('span', { className: 'rt-hit-time' }, fmt(hh.recorded_at))),
          hh.evidence
            ? h('div', { className: 'rt-hit-evi' }, hh.evidence)
            : h('div', { className: 'rt-hit-note', style: { color: 'var(--dsw-alias-state-error-primary)' } },
                '没有填证据 —— 记分必须写明可核对的证据（回显、命令、数据条数、路径）'),
          h('div', { style: { marginTop: 5 } },
            hh.asset_id ? h('span', { className: 'rt-chip' }, h('i', null, '资产'), h('span', { className: 'rt-mono' }, '#' + hh.asset_id)) : null,
            h('button', {
              className: 'rt-btn', style: { padding: '0 6px', fontSize: 11 },
              onClick: (e) => {
                e.stopPropagation()
                try { navigator.clipboard.writeText(String(hh.evidence || '')) } catch (err) { /* ignore */ }
              },
            }, '复制证据'))))
        rows.push(h('div', {
          key: 'spd' + p.id, className: 'rt-score-row',
          style: { cursor: 'default', gridTemplateColumns: '1fr' },
        }, h('div', { className: 'rt-score-detail' },
          p.description ? h('div', { className: 'rt-kv' }, h('b', null, '得分条件'), h('span', null, p.description)) : null,
          h('div', { className: 'rt-kv' }, h('b', null, '状态'),
            h('span', null, (p.enabled ? '启用' : '停用') + ' · ' + p.points + ' 分/次 · 命中 ' + p.hits.length + ' 次')),
          p.hits.length
            ? h('div', null,
                h('div', { className: 'rt-section', style: { padding: '6px 0 0' } }, '命中记录 · ' + p.hits.length),
                h('div', { className: 'rt-hits' }, hitNodes))
            : h('div', { className: 'rt-kv' }, h('b', null, '命中记录'),
                h('span', { style: { color: 'var(--dsw-alias-label-secondary)' } },
                  '还没有 —— 拿下成果后用 redteam_score_hit 记分（target + evidence 必填）')),
          h('div', { className: 'rt-actions' },
            h('button', { className: 'rt-btn', onClick: (e) => { e.stopPropagation(); startEdit(p) } }, '编辑')))))
      }

      return h('div', { className: 'rt-main' },
        h('div', { className: 'rt-toolbar' },
          h('span', { style: { fontWeight: 600 } }, '得分目标'),
          /* 只显示已拿下的总分，不显示目标分数、不显示进度条 */
          h('span', { style: { fontSize: 13, color: 'var(--dsw-alias-label-secondary)', marginLeft: 4 } }, '总分'),
          h('span', { className: 'rt-total' }, String(summary.achievedPoints)),
          h('span', { style: { fontSize: 13, color: 'var(--dsw-alias-label-secondary)' } }, '分'),
          h('span', { className: 'rt-tag' }, '已拿下 ' + summary.achievedCount + '/' + summary.pointCount + ' 项'),
          h('div', { className: 'rt-spacer' }),
          h('button', { className: 'rt-btn', onClick: startNew }, '+ 新增得分点'),
          h('button', { className: 'rt-btn', disabled: busy, onClick: load }, busy ? '刷新中…' : '刷新')),
        msg ? h('div', { className: msg.err ? 'rt-err' : 'rt-foot' }, msg.err || msg.ok) : null,
        err ? h('div', { className: 'rt-err' }, err) : null,
        form ? h('div', { className: 'rt-pane', style: { flex: 'none', borderBottom: '1px solid var(--dsw-alias-border-l1)' } },
          h('div', { className: 'rt-score-form' },
            h('input', { className: 'rt-input', placeholder: '名称（必填）', value: form.name, onChange: (e) => setField('name', e.target.value) }),
            h('input', { className: 'rt-input', placeholder: '分类，如 账号权限', value: form.category, onChange: (e) => setField('category', e.target.value) }),
            h('input', { className: 'rt-input', type: 'number', placeholder: '分值', value: form.points, onChange: (e) => setField('points', Number(e.target.value)) }),
            h('select', { className: 'rt-input', value: form.enabled ? '1' : '0', onChange: (e) => setField('enabled', e.target.value === '1') },
              h('option', { value: '1' }, '启用'),
              h('option', { value: '0' }, '停用'))),
          h('input', {
            className: 'rt-input', style: { width: '100%', marginBottom: 6, boxSizing: 'border-box' },
            placeholder: '得分条件说明', value: form.description, onChange: (e) => setField('description', e.target.value),
          }),
          h('div', { className: 'rt-actions' },
            h('button', { className: 'rt-btn rt-btn-primary', disabled: busy, onClick: save }, '保存'),
            form.id ? h('button', { className: 'rt-btn', disabled: busy, onClick: remove }, '删除') : null,
            h('button', { className: 'rt-btn', onClick: () => setForm(null) }, '取消'))) : null,
        h('div', { className: 'rt-table' },
          h('div', { className: 'rt-score-row head' },
            h('span', null, '分值'), h('span', null, '得分点'), h('span', null, '状态'), h('span', null, '命中')),
          rows,
          !items.length ? h('div', { className: 'rt-empty' }, '暂无得分点，点右上角「新增得分点」') : null),
        h('div', { className: 'rt-foot' }, h('span', null, '得分点可编辑；智能体按分值优先级推进，拿下成果用 redteam_score_hit 记分')))
    }

    /* ---------------------------------------------------------- 当前测试（实时） */
    const TEST_STATUS_LABEL = {
      untested: '未测试', testing: '测试中', tested: '已测试',
      blocked: '被封禁', abandoned: '已放弃', no_surface: '无攻击面',
    }

    /**
     * 当前测试页：agent 正在打哪台、打到哪一步、还有什么在排队。
     * 5 秒轮询自动刷新；三个区块可折叠，其中「正在测」始终完整展开。
     */
    function TestingTab(props) {
      const eng = props.engagement
      const refreshKey = props.refreshKey || 0
      const [data, setData] = React.useState(null)
      const [err, setErr] = React.useState(null)
      const [at, setAt] = React.useState(null)
      const [auto, setAuto] = React.useState(true)
      /* 折叠状态：正在测不参与折叠 */
      const [closed, setClosed] = React.useState({ recent: true, queue: true })

      const load = () => {
        if (!eng) return
        api({ op: 'activeTests', engagement: eng, limit: 20 }).then((r) => {
          if (!r || r.ok === false) { setErr((r && r.error) || '读取失败'); return }
          setErr(null); setData(r); setAt(new Date())
        }, (e) => setErr(String((e && e.message) || e)))
      }
      React.useEffect(load, [eng, refreshKey])
      React.useEffect(() => {
        if (!eng || !auto) return undefined
        const timer = setInterval(load, 5000)
        return () => clearInterval(timer)
      }, [eng, auto, refreshKey])

      const testing = (data && data.testing) || []
      const recent = (data && data.recent) || []
      const queue = (data && data.queue) || []
      const stats = (data && data.stats) || {}

      /* 一台资产一张卡：一眼看清"打的是谁、打到哪、拿到什么" */
      const card = (a, past) => {
        const chips = []
        chips.push(h('span', { key: 'sc', className: 'rt-scope rt-scope-' + (a.scope === 'internal' ? 'internal' : 'external') },
          a.scope === 'internal' ? '内网' : '外网'))
        if (a.segment_cidr) chips.push(h('span', { key: 'seg', className: 'rt-tag' }, a.segment_cidr))
        if (a.open_ports) chips.push(h('span', { key: 'p', className: 'rt-tag rt-tag-active' }, '开放 ' + a.open_ports + ' 端口'))
        if (a.vulns) chips.push(h('span', { key: 'v', className: 'rt-tag rt-tag-live' }, '已确认漏洞 ' + a.vulns))
        if (a.webshells) chips.push(h('span', { key: 'w', className: 'rt-tag rt-tag-passive' }, 'WebShell ' + a.webshells))
        if (a.tunnels) chips.push(h('span', { key: 't', className: 'rt-tag rt-tag-passive' }, '隧道 ' + a.tunnels))
        if (a.priority) chips.push(h('span', { key: 'pr', className: 'rt-tag' }, '易打 ' + a.priority))
        if (a.blocked_count) chips.push(h('span', { key: 'b', className: 'rt-tag', style: { color: '#ef4444', borderColor: '#ef444455' } }, '被封 ' + a.blocked_count + ' 次'))
        const noteLines = a.test_notes
          ? String(a.test_notes).split('\n').slice(-3).map((l) => (l.length > 240 ? l.slice(0, 240) + ' …' : l))
          : []
        return h('div', { key: 'at' + a.id, className: 'rt-atest' + (past ? ' past' : '') },
          h('div', { className: 'rt-atest-head' },
            past ? null : h('span', { className: 'rt-live-dot' }),
            h('span', { className: 'rt-atest-ip' }, a.ip),
            h('span', { className: 'rt-tag ' + (a.test_status === 'testing' ? 'rt-tag-live' : '') }, TEST_STATUS_LABEL[a.test_status] || a.test_status),
            h('div', { className: 'rt-spacer' }),
            h('span', { style: { fontSize: 11, color: 'var(--dsw-alias-label-secondary)' } },
              fmt(a.test_updated_at) + (a.test_updated_by ? ' · ' + a.test_updated_by : ''))),
          chips.length ? h('div', null, chips) : null,
          a.test_surface ? h('div', { className: 'rt-atest-meta' }, '测试面：' + a.test_surface) : null,
          a.potential ? h('div', { className: 'rt-atest-meta' }, '预期得分：' + a.potential) : null,
          noteLines.length ? h('div', { className: 'rt-atest-notes' }, noteLines.join('\n')) : null)
      }

      const section = (key, title, n, tone, hint) => {
        const isClosed = closed[key] === true
        return h('div', {
          key: 'sec' + key, className: 'rt-stagegrp',
          onClick: () => setClosed((o) => Object.assign({}, o, { [key]: !o[key] })),
        },
          h('span', { className: 'rt-stage-tag rt-st-' + tone }, title),
          h('span', { className: 'rt-grp-n' }, n + ' 台'),
          hint ? h('span', { className: 'rt-grp-n', style: { marginLeft: 10, fontWeight: 400 } }, hint) : null,
          h('div', { className: 'rt-spacer' }),
          h('span', { style: { color: 'var(--dsw-alias-label-secondary)' } }, isClosed ? '▸' : '▾'))
      }

      const concl = (label, value, tone) => h('span', { key: label, className: 'rt-concl-i', style: { cursor: 'default' } },
        h('b', null, String(value || 0)), h('span', null, label))
      const conclusion = h('div', { className: 'rt-concl' },
        concl('测试中', stats.testing, 'live'),
        concl('待测', stats.untested, ''),
        concl('已测', stats.tested, ''),
        concl('放弃', (stats.abandoned || 0) + (stats.blocked || 0), ''),
        concl('无攻击面', stats.no_surface, ''),
        h('div', { className: 'rt-spacer' }),
        at ? h('span', { style: { fontSize: 11, color: 'var(--dsw-alias-label-secondary)' } },
          '更新于 ' + at.toLocaleTimeString('zh-CN', { hour12: false })) : null,
        h('button', {
          className: 'rt-btn' + (auto ? ' rt-btn-primary' : ''), style: { padding: '0 7px', fontSize: 11 },
          title: '每 5 秒自动刷新', onClick: () => setAuto((x) => !x),
        }, auto ? '实时 · 5s' : '已暂停'),
        h('button', { className: 'rt-btn', style: { padding: '0 7px', fontSize: 11 }, onClick: load }, '刷新'))

      const body = []
      /* 正在测：不折叠，完整展开 */
      body.push(section('testing', '正在测', testing.length, 'access',
        testing.length ? null : '（agent 开始测某台资产后会实时出现在这里）'))
      if (testing.length) body.push(h('div', { key: 'testingList', className: 'rt-live-body', style: { borderBottom: 'none', paddingTop: 6 } }, testing.map((a) => card(a, false))))
      else body.push(h('div', { key: 'testingEmpty', className: 'rt-empty', style: { padding: 14 } },
        '当前没有资产处于「测试中」。下面是最近动过的与待测队列。'))

      /* 最近动过（默认折叠） */
      body.push(section('recent', '最近动过', recent.length, 'data'))
      if (closed.recent !== true && recent.length) {
        body.push(h('div', { key: 'recentList', className: 'rt-live-body', style: { borderBottom: 'none', paddingTop: 6 } }, recent.map((a) => card(a, true))))
      }

      /* 待测队列（默认折叠） */
      body.push(section('queue', '待测队列', data ? (data.untested || 0) : 0, 'other',
        queue.length ? '按易打性与端口数排出先打哪几台' : null))
      if (closed.queue !== true && queue.length) {
        body.push(h('div', { key: 'queueList', className: 'rt-live-body', style: { borderBottom: 'none', paddingTop: 6 } },
          queue.map((a) => card(a, true)),
          h('div', { key: 'queueHint', className: 'rt-atest-meta', style: { padding: '4px 2px 10px' } },
            '完整清单（含筛选与排序）见「资产测绘」页')))
      }

      return h('div', { className: 'rt-main' },
        conclusion,
        err ? h('div', { className: 'rt-err' }, err) : null,
        data === null && !err ? h('div', { className: 'rt-empty' }, '加载中…') : null,
        h('div', { className: 'rt-body', style: { overflow: 'auto' } },
          h('div', { style: { padding: '6px 12px 14px' } }, body)))
    }

    /* ---------------------------------------------------------- 会话与入口（WebShell / 隧道） */
    /**
     * 打内网最容易出的问题：拿到 WebShell 或隧道之后忘了登记，过一会儿就"忘了还有入口可用"。
     * 这个页签把事实库里的 WebShell 与隧道集中展示，带连通状态，并可一键让 host 侧实测。
     */
    function SessionTab(props) {
      const eng = props.engagement
      const refreshKey = props.refreshKey || 0
      const [data, setData] = React.useState(null)
      const [err, setErr] = React.useState(null)
      const [busy, setBusy] = React.useState(false)
      const [msg, setMsg] = React.useState(null)
      const [copied, setCopied] = React.useState(null)

      const load = () => {
        if (!eng) return
        api({ op: 'sessions', engagement: eng }).then((r) => {
          if (!r || r.ok === false) { setErr((r && r.error) || '读取失败'); return }
          setErr(null)
          setData(r)
        }, (e) => setErr(String((e && e.message) || e)))
      }
      React.useEffect(load, [eng, refreshKey])

      const probe = () => {
        setBusy(true); setMsg(null)
        api({ op: 'probeSessions', engagement: eng, timeoutMs: 6000 }).then((r) => {
          setBusy(false)
          if (!r || r.ok === false) { setMsg({ err: (r && r.error) || '检测失败' }); load(); return }
          const on = (r.webshells || []).filter((x) => x.status === 'online').length
          const act = (r.tunnels || []).filter((x) => x.status === 'active').length
          setMsg({ ok: '检测完成：WebShell 在线 ' + on + '/' + (r.webshells || []).length + '，隧道可用 ' + act + '/' + (r.tunnels || []).length })
          load()
        }, (e) => { setBusy(false); setMsg({ err: String((e && e.message) || e) }) })
      }

      const copy = (key, text) => {
        try {
          navigator.clipboard.writeText(text)
          setCopied(key)
          setTimeout(() => setCopied((c) => (c === key ? null : c)), 1500)
        } catch (e) { setMsg({ err: '复制失败，请手动选择' }) }
      }

      const markTunnel = (t, status) => {
        setMsg(null)
        api({ op: 'updateTunnel', engagement: eng, id: t.id, patch: { status: status, check_note: '界面手动标记' } })
          .then(() => load(), (e) => setMsg({ err: String((e && e.message) || e) }))
      }
      const markShell = (w, status) => {
        setMsg(null)
        api({ op: 'updateWebshell', engagement: eng, id: w.id, patch: { status: status, check_note: '界面手动标记' } })
          .then(() => load(), (e) => setMsg({ err: String((e && e.message) || e) }))
      }

      const totals = (data && data.totals) || {}
      const shells = (data && data.webshells) || []
      const tunnels = (data && data.tunnels) || []
      const statusDot = (s) => h('span', { className: s === 'online' || s === 'active' ? 'rt-dot-on' : (s === 'unknown' || !s ? 'rt-dot-unk' : 'rt-dot-off') })

      const shellCards = shells.map((w) => h('div', { key: 'w' + w.id, className: 'rt-sess' },
        h('div', { className: 'rt-sess-head' },
          statusDot(w.status),
          h('span', { className: 'rt-sess-title' }, w.url),
          h('span', { className: 'rt-tag rt-tag-active' }, w.shell_type || 'webshell'),
          w.privilege ? h('span', { className: 'rt-tag' }, w.privilege) : null,
          h('div', { className: 'rt-spacer' }),
          copied === 'cmd' + w.id
            ? h('span', { className: 'rt-tag', style: { color: '#10b981' } }, '已复制')
            : h('button', {
                className: 'rt-btn', style: { padding: '0 6px', fontSize: 11 },
                onClick: () => copy('cmd' + w.id, 'curl -s "' + w.url + '"'),
              }, '复制 URL'),
          h('button', {
            className: 'rt-btn', style: { padding: '0 6px', fontSize: 11 },
            onClick: () => markShell(w, 'offline'),
          }, '标记失效')),
        h('div', { className: 'rt-sess-sub' },
          [w.pass_key ? '密码 ' + w.pass_key : null,
            w.asset_ip ? '资产 ' + w.asset_ip : null,
            w.secret_ref ? '凭据引用 ' + w.secret_ref : null,
            '最后检测 ' + (w.last_check ? fmt(w.last_check) : '未检测'),
            w.latency_ms !== null && w.latency_ms !== undefined ? w.latency_ms + 'ms' : null,
            w.check_note || null].filter(Boolean).join(' · ')),
        w.note ? h('div', { className: 'rt-sess-sub' }, '备注：' + w.note) : null))

      const tunnelCards = tunnels.map((t) => {
        const proxy = t.listen ? 'socks5://' + t.listen : ''
        const gogoCmd = t.listen ? './gogo -i <内网CIDR> -m ss --ping -p top2,win,db --proxy ' + proxy : ''
        const fscanCmd = t.listen ? './fscan -h <内网CIDR> -np -nobr -nopoc -socks5 ' + t.listen + ' -o intranet.txt' : ''
        return h('div', { key: 't' + t.id, className: 'rt-sess' },
          h('div', { className: 'rt-sess-head' },
            statusDot(t.status),
            h('span', { className: 'rt-sess-title' }, t.listen || '(未填监听地址)'),
            h('span', { className: 'rt-tag rt-tag-passive' }, t.kind || 'tunnel'),
            t.reach ? h('span', { className: 'rt-tag' }, '可达 ' + t.reach) : null,
            h('div', { className: 'rt-spacer' }),
            h('button', {
              className: 'rt-btn', style: { padding: '0 6px', fontSize: 11 },
              onClick: () => copy('sock' + t.id, t.listen || ''),
            }, copied === 'sock' + t.id ? '已复制' : '复制地址'),
            t.status === 'active'
              ? h('button', { className: 'rt-btn', style: { padding: '0 6px', fontSize: 11 }, onClick: () => markTunnel(t, 'down') }, '标记失效')
              : h('button', { className: 'rt-btn', style: { padding: '0 6px', fontSize: 11 }, onClick: () => markTunnel(t, 'active') }, '标记可用')),
          h('div', { className: 'rt-sess-sub' },
            [t.entry ? '入口 ' + t.entry : null,
              t.asset_ip ? '资产 ' + t.asset_ip : null,
              '最后检测 ' + (t.last_check ? fmt(t.last_check) : '未检测'),
              t.latency_ms !== null && t.latency_ms !== undefined ? t.latency_ms + 'ms' : null,
              t.check_note || null].filter(Boolean).join(' · ')),
          t.status === 'active' && t.listen
            ? h('div', { style: { marginTop: 6 } },
                h('div', { className: 'rt-sess-sub' }, '走隧道扫描（技能 gogo-intranet / fscan-intranet）：'),
                h('div', { className: 'rt-code', title: '点击复制', onClick: () => copy('g' + t.id, gogoCmd) },
                  copied === 'g' + t.id ? '已复制' : gogoCmd),
                h('div', { className: 'rt-code', style: { display: 'block', marginTop: 3 }, title: '点击复制', onClick: () => copy('f' + t.id, fscanCmd) },
                  copied === 'f' + t.id ? '已复制' : fscanCmd))
            : null,
          t.command ? h('div', { className: 'rt-sess-sub' }, '建立命令：' + t.command) : null,
          t.note ? h('div', { className: 'rt-sess-sub' }, '备注：' + t.note) : null)
      })

      return h('div', { className: 'rt-main' },
        h('div', { className: 'rt-toolbar' },
          h('span', { style: { fontWeight: 600 } }, '会话与入口'),
          h('span', { className: 'rt-tag' }, 'WebShell ' + (totals.webshellsOnline || 0) + '/' + (totals.webshells || 0) + ' 在线'),
          h('span', { className: 'rt-tag' }, '隧道 ' + (totals.tunnelsActive || 0) + '/' + (totals.tunnels || 0) + ' 可用'),
          h('span', { className: 'rt-tag' }, '凭据 ' + (totals.credentials || 0)),
          h('span', { className: 'rt-tag' }, '访问会话 ' + (totals.access || 0)),
          h('div', { className: 'rt-spacer' }),
          h('button', { className: 'rt-btn rt-btn-primary', disabled: busy, onClick: probe }, busy ? '检测中…' : '检测连通性'),
          h('button', { className: 'rt-btn', onClick: load }, '刷新')),
        msg ? h('div', { className: msg.err ? 'rt-err' : 'rt-foot' }, msg.err || msg.ok) : null,
        err ? h('div', { className: 'rt-err' }, err) : null,
        h('div', { className: 'rt-body', style: { overflow: 'auto' } },
          !shells.length && !tunnels.length
            ? h('div', { className: 'rt-empty' },
                h('div', null, '还没有登记任何 WebShell 或隧道。'),
                h('div', { style: { marginTop: 6, fontSize: 12 } },
                  '拿到 WebShell 用 redteam_webshell_add；建好隧道用 redteam_tunnel_add（suo5 / socks5 / ssh -R）；之后智能体用 redteam_sessions 就能看到。'))
            : null,
          shells.length
            ? h('div', null,
                h('div', { className: 'rt-section' }, 'WebShell（已上线的可控入口）· ' + shells.length),
                h('div', { className: 'rt-sess-grid' }, shellCards))
            : null,
          tunnels.length
            ? h('div', null,
                h('div', { className: 'rt-section' }, '内网隧道（可直接给扫描器当代理用）· ' + tunnels.length),
                h('div', { className: 'rt-sess-grid' }, tunnelCards))
            : null))

    }

    /* ---------------------------------------------------------- 错误边界 */
    /**
     * 单个页签渲染出错时只降级该页签，不拖垮整个面板：面板与侧栏按钮保持可用，
     * 用户可一键回到资产测绘。（此前面板整块消失、按钮点不开就是缺了这层保护。）
     */
    class RtBoundary extends React.Component {
      constructor(props) {
        super(props)
        this.state = { error: null }
      }
      static getDerivedStateFromError(error) {
        return { error: error }
      }
      componentDidCatch(error) {
        try { console.error('[redteam-ui] 页面渲染出错:', error) } catch (e) { /* ignore */ }
      }
      render() {
        if (this.state.error) {
          const msg = this.state.error && this.state.error.message ? this.state.error.message : String(this.state.error)
          return h('div', { className: 'rt-pane' },
            h('div', { className: 'rt-err' }, '该页面渲染出错：' + msg),
            h('button', {
              className: 'rt-btn',
              onClick: () => { this.setState({ error: null }); setUI({ tab: 'assets' }) },
            }, '回到资产测绘'))
        }
        return this.props.children
      }
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
      const [refreshKey, setRefreshKey] = React.useState(0)

      /* 面板宽度 → :root 自定义属性（frame 的 padding-right 依赖它） */
      React.useEffect(() => { setDockWidth(width) }, [width])

      const loadSnapshot = (id) => {
        if (!id) { setSnapshot(null); return }
        api({ op: 'snapshot', engagement: id }).then((r) => {
          if (!r || r.ok === false) { setErr((r && r.error) || '加载失败'); return }
          setErr(null)
          setSnapshot(r)
        }, (e) => setErr(String((e && e.message) || e)))
      }

      const refreshList = (selectId) => {
        api({ op: 'bootstrap' }).then((b) => {
          setEngagements((b && b.engagements) || [])
          if (selectId) { setEng(selectId); loadSnapshot(selectId) }
        }, () => {})
      }

      React.useEffect(() => {
        api({ op: 'bootstrap' }).then((r) => {
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
        api({ op: 'openEngagement', name: name }).then((r) => {
          setCreating(false)
          if (!r || r.ok === false) { setErr((r && r.error) || '创建失败'); return }
          setNewName('')
          refreshList(r.engagement && r.engagement.id)
        }, (e) => { setCreating(false); setErr(String((e && e.message) || e)) })
      }

      /** 刷新：重新拉取名册/快照，并让当前页签重新取数。 */
      const refreshAll = () => {
        setRefreshKey((k) => k + 1)
        api({ op: 'bootstrap' }).then((b) => {
          setEngagements((b && b.engagements) || [])
          if (eng) loadSnapshot(eng)
        }, () => { if (eng) loadSnapshot(eng) })
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
      const tabs = [
        ['assets', '资产测绘'], ['testing', '当前测试'], ['sessions', '会话隧道'], ['findings', '漏洞战果'],
        ['chain', '攻击链'], ['scores', '得分目标'], ['report', '报告'],
        ['attackfiles', '攻击文件'], ['prompts', '智能体提示词'], ['skills', '技能库'],
      ]
      const full = isFullWindow()
      const openFull = () => {
        try { window.open(window.location.href.split('#')[0] + '#redteam-full', '_blank', 'noopener') } catch (e) { setErr('无法打开新窗口：' + ((e && e.message) || e)) }
      }
      const exitFull = () => {
        /* 优先关掉脚本打开的窗口；关不掉就退回带侧栏的普通界面 */
        try { window.close() } catch (e) { /* 非脚本打开的窗口无法关闭 */ }
        try {
          if (window.location.hash) {
            window.location.hash = ''
            window.location.reload()
          }
        } catch (e) { /* ignore */ }
      }
      React.useEffect(() => {
        if (!full) return undefined
        const onKey = (e) => { if (e.key === 'Escape') exitFull() }
        window.addEventListener('keydown', onKey)
        return () => window.removeEventListener('keydown', onKey)
      }, [full])

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
      } else if (st.tab === 'assets') body = h(AssetsTab, { engagement: eng, snapshot: snapshot, refreshKey: refreshKey, onRefresh: refreshAll, onData: () => loadSnapshot(eng) })
      else if (st.tab === 'testing') body = h(TestingTab, { engagement: eng, refreshKey: refreshKey })
      else if (st.tab === 'sessions') body = h(SessionTab, { engagement: eng, refreshKey: refreshKey })
      else if (st.tab === 'findings') body = h(FindingsTab, { engagement: eng, refreshKey: refreshKey })
      else if (st.tab === 'chain') body = h(ChainTab, { engagement: eng, refreshKey: refreshKey })
      else if (st.tab === 'report') body = h(ReportTab, { engagement: eng, refreshKey: refreshKey })
      else if (st.tab === 'attackfiles') body = h(AttackFilesTab, { engagement: eng, refreshKey: refreshKey })
      else if (st.tab === 'scores') body = h(ScoreTab, { engagement: eng, refreshKey: refreshKey })
      else if (st.tab === 'prompts') body = h(PromptsTab, { engagement: eng, refreshKey: refreshKey })
      else body = h(SkillsTab, { engagement: eng, refreshKey: refreshKey })

      const shellProps = full
        ? { className: 'rt-full', style: { display: 'flex' } }
        : { className: 'rt-dock', 'data-open': st.open ? '1' : '0', style: { width: width + 'px', display: st.open ? 'flex' : 'none' } }

      return h('div', shellProps,
        full ? null : h('div', { className: 'rt-grip', onMouseDown: startResize }),
        h('div', { className: 'rt-head' },
          h('div', { className: 'rt-title' }, h('span', { className: 'rt-dot' }),
            full ? 'RedTeam 全面浏览' : 'RedTeam 控制台',
            full ? h('span', { className: 'rt-tag', style: { marginLeft: 6 } }, '独立窗口') : null),
          h('select', {
            className: 'rt-input', style: { maxWidth: '170px' }, value: eng || '',
            onChange: (e) => {
              setEng(e.target.value)
              loadSnapshot(e.target.value)
              /* 同步「当前靶标」：原生 skill 目录按它解析技能根 */
              api({ op: 'activateEngagement', engagement: e.target.value }).catch(() => {})
            },
          }, engagements.map((x) => h('option', { key: x.id, value: x.id }, x.name))),
          h('div', { className: 'rt-spacer' }),
          full ? h('button', { className: 'rt-btn', title: '回到带侧栏的普通界面（或按 Esc）', onClick: exitFull }, '退出全面浏览') : null,
          h('button', { className: 'rt-btn', title: '刷新名册、快照与当前页面数据', onClick: refreshAll }, '刷新'),
          full ? null : h('button', { className: 'rt-btn', title: '在新浏览器窗口打开完整控制台', onClick: openFull }, '全面浏览'),
          full ? null : h('button', { className: 'rt-btn', title: '收起面板（对话列恢复全宽）', onClick: () => setUI({ open: false }) }, '收起')),
        h('div', { className: 'rt-tabs' }, tabs.map((t) => h('div', {
          key: t[0], className: 'rt-tab' + (st.tab === t[0] ? ' on' : ''),
          onClick: () => setUI({ tab: t[0] }),
        }, t[1]))),
        h('div', { className: 'rt-body' }, h(RtBoundary, { key: st.tab }, body)),
        h('div', { className: 'rt-foot' },
          h('span', null, 'C 段 ' + (stats.segments || 0)),
          h('span', null, '资产 ' + (stats.assets || 0) + '（存活 ' + (stats.liveAssets || 0) + '）'),
          h('span', null, '端口 ' + (stats.openPorts || 0)),
          h('span', null, '指纹 ' + (stats.fingerprints || 0)),
          h('span', null, '漏洞 ' + (stats.vulns || 0)),
          h('span', null, '被动/主动 ' + (stats.passiveSignals || 0) + '/' + (stats.activeSignals || 0)),
          h('div', { className: 'rt-spacer' }),
          full ? h('span', null, '按 Esc 或点右上角「退出全面浏览」回到带侧栏的界面') : null,
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

    /** 侧栏「全面浏览」：在新浏览器窗口打开完整控制台（当前窗口不受影响）。 */
    function FullButton(props) {
      const open = () => {
        try { window.open(window.location.href.split('#')[0] + '#redteam-full', '_blank', 'noopener') } catch { /* 被浏览器拦截 */ }
      }
      return h('button', {
        className: 'rt-icon-btn',
        title: '全面浏览：在新窗口打开完整控制台（当前窗口不受影响；新窗口内按 Esc 退出）',
        onClick: open,
      }, h('span', { style: { fontSize: 14 } }, '⛶'), props.wide ? h('span', null, '全面浏览') : null)
    }

    /* ---------------------------------------------------------- 插件入口 */
    /** 唯一硬依赖：槽位注册表。 */
    const inject = ['slots']

    /**
     * 注入样式 + 三处槽位。样式标签与宽度变量随 fiber 卸载一起移除。
     * @param ctx - 客户端根上下文。
     */
    function apply(ctx) {
      const styleTag = document.createElement('style')
      styleTag.setAttribute('data-redteam-ui', '1')
      styleTag.textContent = CSS
      document.head.append(styleTag)

      const widthTag = document.createElement('style')
      widthTag.setAttribute('data-redteam-ui-width', '1')
      widthTag.textContent = ':root{--rt-dock-w:620px}'
      document.head.append(widthTag)
      dockWidthTag = widthTag

      ctx.effect(() => () => {
        styleTag.remove()
        widthTag.remove()
        dockWidthTag = null
      })

      ctx.slots.inject('shell.overlay', () => ctx.slots.register(
        { name: 'shell.overlay', id: 'redteam-console', order: 50 },
        () => h(Panel),
      ))
      ctx.slots.inject('sidebar.footer.action', () => ctx.slots.register(
        { name: 'sidebar.footer.action', id: 'redteam-toggle', order: 50, label: 'RedTeam' },
        (props) => h(SidebarButton, props),
      ))
      ctx.slots.inject('sidebar.footer.action', () => ctx.slots.register(
        { name: 'sidebar.footer.action', id: 'redteam-full', order: 51, label: '全面浏览' },
        (props) => h(FullButton, props),
      ))
      ctx.slots.inject('conversation.session.header.utilities', () => ctx.slots.register(
        { name: 'conversation.session.header.utilities', id: 'redteam-header-toggle', order: 50, label: 'RedTeam' },
        () => h(HeaderButton),
      ))
    }

    exports.apply = apply
    exports.inject = inject
    return module.exports
  },
})
