# dsh-redteam-mode

DeepSeek Harness 的**红队作战模式**插件：给一个靶标单位名称，就拉起一支红队智能体
（信息收集 → 漏洞检测 → 漏洞利用 → 内网渗透），所有发现落进本机 SQLite 事实库，
右侧常驻控制台实时看资产、攻击链、得分与报告。

## 安装

```sh
dsh plugin --profile web add dsh-redteam-mode
```

装完重启一次 `dsh web`，然后在**设置 → 插件市场**里就能看到它（也可以直接在上面搜
`redteam`）。首次启动会把自带的 `红队模式` 预设装到 `$DSH_HOME/.agent-presets/redteam/`，
并注册 23 个原生技能——不需要手动拷任何文件。

使用：新建会话 → 选预设 **红队模式** → 直接发靶标单位名称。

## 从预发布期的「开发版」升级过来

如果你在 **0.7.0 之前**用过开发版（在 `~/.dsh/profiles/web/cordis.patch.yml` 里手写过
`redteam-store` / `redteam-ui` 两行，指向 `dsh-redteam-store` / `dsh-redteam-ui`），
装完本插件后启动会报服务/条目冲突，先跑一次迁移把旧行清掉：

```sh
node "$(npm root -g 2>/dev/null)/dsh-redteam-mode/lib/migrate-legacy-rows.mjs" --dry-run   # 预演
node node_modules/dsh-redteam-mode/lib/migrate-legacy-rows.mjs                              # 在 profile 目录里执行
```

它会只删那两条（连子行），其它内容与注释原样保留，写回前自动备份；已经在用 0.7.0+ 或者新装的机器不需要跑。

## 它给你什么

| 能力 | 说明 |
| --- | --- |
| 四个角色 | 信息收集 / 漏洞检测 / 漏洞利用 / 内网渗透，主会话只做调度与指挥 |
| 资产测绘 | C 段按内外网分组、端口/服务/指纹/域名/Web 标题、易打性评估、测试状态 |
| 攻击链 | 五阶段（信息收集 → 互联网资产权限 → 边界突破 → 内网资产权限 → 靶标权限），带累计得分 |
| 得分目标 | 得分点可编辑、命中记录一行一条；自建账号不计分；**账号权限与数据库权限按「同一资产 + 同一端口」封顶**（拿到最高权限账号即该服务拿满，同服务再刷账号标「服务已拿满 · 不计分」），其余得分点仍不设数量上限 |
| 会话隧道 | WebShell 与隧道状态、连通性实测、**是否跨越靶标边界**的判定 |
| 报告 | 按攻击链顺序、按阶段可折叠，每条得分附可直接粘进 Yakit 的原始请求；自建账号与同服务重复命中整条剔除（抬头给出剔除条数） |
| POC 知识库 | 全局共享（跨靶标）：先查库再联网/手搓，验证有效的回填；同时检索本机 nuclei 模板库 |
| 技能 | 23 个原生技能随包分发（FOFA 测绘、fscan/gogo 内网、suo5 隧道、冰蝎/哥斯拉马、VPS 反弹…） |

## 数据放在哪

- 全部落在**本机** `$DSH_HOME/redteam/`：`engagements/<靶标>/`（SQLite 事实库 + `runs/` 证据 +
  按目标分目录的攻击文件）、`knowledge.db` + `pocs/`（跨靶标共享的 POC/EXP 知识库）。
- 不含任何遥测、上报或云端同步；凭据明文只在本机库里，面板直显便于复用。

## 工具（48 个 `redteam_*`）

资产/端口/服务/指纹/漏洞/凭据/会话/攻击链/得分/报告/知识库全覆盖。典型入口：

```
redteam_engagement_open     绑定本次演练靶标
redteam_asset_add           落库一个资产（端口带 service/product/version/url/title）
redteam_vuln_add            落库一个漏洞（带 severity/status/gained）
redteam_score_hit           记一次得分（自建账号传 self_created=true 不计分；账号/数据库权限同资产同端口只算一次，被顶掉的重复命中回 warning）
redteam_chain_add           写攻击链步骤（带 point_code 时同时记分）
redteam_score_report        生成「攻击得分链路复现报告」
redteam_sessions            一屏看 WebShell / 隧道 / 凭据 / 会话
redteam_poc_search          打 Nday/1day 前先查知识库 + 本机 nuclei 模板库
redteam_poc_add             把验证有效的通用 POC/EXP 回填知识库（脱敏）
```

## 从源码构建

本包是**自包含**的：`lib/` 由 `tools/build.mjs` 从同仓库的三个源码包生成
（`redteam-store` / `redteam-tools` / `redteam-ui`），预设与技能也一并拷进来。

```sh
node packages/redteam-bundle/tools/build.mjs          # 生成
node packages/redteam-bundle/tools/build.mjs --check  # 只校验是否漂移（CI 用）
node packages/redteam-bundle/test/bundle.test.mjs     # 打包契约 + 泄露 + 自举自检
```

## 授权与合规

**仅在获得明确书面授权的范围内使用**。本插件是作战工具：它本身不替你做授权判断，
请自行确认目标范围、时间窗与允许手段，并遵守所在司法辖区法律。
