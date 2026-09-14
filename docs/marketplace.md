# 上架插件市场（dshmarket）

市场里的插件列表来自精选列表 [awesome-dsh-plugin](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin)：
**把包发到 npm，再往那个仓库提一个 PR 加一条**，市场和目录站当天自动收录。
本文记录这个包已经准备好的东西、还差哪两步人工操作，以及验收口径。

## 已经就绪

| 项 | 状态 |
| --- | --- |
| 包名 | `dsh-redteam-mode`（在 `packages/redteam-bundle/`） |
| 打包契约 | `dsh.bundle.patch: ./cordis.patch.yml` + `dsh.client.platform: web` + `exports: . / ./store / ./ui / ./tools / ./client` |
| 自包含 | 零运行时依赖；`lib/` 由 `tools/build.mjs` 从三个源码包生成 |
| 预设 | `presets/redteam/`（首次启动落地到 `$DSH_HOME/.agent-presets/redteam/`，不覆盖用户改动） |
| 技能 | `skills/` 13 个，随包分发 |
| 发布守卫 | `prepublishOnly` = `build --check` + `bundle.test.mjs`（漂移或泄露会直接拦住 publish） |
| 真机验收 | 干净 `DSH_HOME` + `npm pack` 出的 tarball + `dsh plugin add` → 预设可用、13 个技能可见、`POST /redteam/api` 正常 |

## 还差两步（需要你的账号）

### 1) 发到 npm

```sh
cd packages/redteam-bundle
npm version patch               # 改版本号并打本地 tag（0.7.x 已发到 0.7.6）
npm publish --access public     # prepublishOnly 会先跑自检（build --check + bundle.test），失败不会发出去
git push origin main --tags
```

本机 `~/.npmrc` 里已有 token（`npm whoami` 应返回 `jueze`），一般不需要重新 `npm login`。
也可以只打包给自己或他人手动安装：

```sh
npm pack                        # 产出 dsh-redteam-mode-<版本>.tgz
dsh plugin --profile web add ./dsh-redteam-mode-<版本>.tgz
```

### 2) 往 awesome-dsh-plugin 提 PR

在那个仓库的 `README.md`（以及中文 `README.zh.md`）**Security & Permissions** 分类下加一条，
然后开 PR。条目文案（中英各一份，描述里的数字都是实测过的：48 个工具 / 13 个技能）：

```markdown
- [Jueze-2019/dsh-redteam-mode#packages/redteam-bundle](https://github.com/Jueze-2019/dsh-redteam-mode/tree/main/packages/redteam-bundle) - Red-team engagement mode: send one target organization name and a four-role agent team (recon, vulnerability detection, exploitation, internal pivot) runs the engagement, landing every finding in a local SQLite fact base with a persistent right-side console (asset mapping, five-stage attack chain, scoring targets, evidence report, cross-engagement POC/EXP knowledge base); ships 13 native skills and 48 `redteam_*` tools.
```

中文 README 对应条目：

```markdown
- [Jueze-2019/dsh-redteam-mode#packages/redteam-bundle](https://github.com/Jueze-2019/dsh-redteam-mode/tree/main/packages/redteam-bundle) - 红队作战模式：只发一个靶标单位名称，四个角色（信息收集/漏洞检测/漏洞利用/内网渗透）的智能体团队自动推进演练，所有发现落进本机 SQLite 事实库，右侧常驻控制台看资产测绘、五阶段攻击链、得分目标、复现报告与跨靶标 POC/EXP 知识库；随包分发 13 个原生技能与 48 个 `redteam_*` 模型工具。
```

> 评审会对着源码逐条核对（例如"48 个工具"会被数一遍）：改动工具数量或技能数量时，
> 记得同步这里的文案与 `packages/redteam-tools/`、`packages/redteam-bundle/skills/`。

## 升级迁移（预发布期用户）

0.7.0 之前用开发版装的机器，profile 补丁里有 `redteam-store` / `redteam-ui` 两行，
与本插件的行冲突（0.7.0 报 `duplicate loader entry id`，0.7.1 起带前缀后变成
`service "redteam" has been registered`）。迁移脚本：

```sh
node node_modules/dsh-redteam-mode/lib/migrate-legacy-rows.mjs [--profile web] [--dry-run]
```

只删那两条 + 自己的子行，写回前备份，幂等；补丁整份被删空时写回 `[]`。

## 验收口径（每次发版前自己跑一遍）

```sh
node packages/redteam-bundle/tools/build.mjs --check   # 生成物是否与源码一致
node packages/redteam-bundle/test/bundle.test.mjs      # 打包契约 / 泄露 / 自举
node packages/redteam-tools/test/tool-schema.test.mjs  # 工具 schema（预设挂载能否成功）
```

## 合规提醒

本包是作战工具，不替使用者做授权判断。README 与预设里都写明了「仅限已获书面授权的范围」；
上架时保持这段声明，不要把"授权前提"从人设里删掉。
