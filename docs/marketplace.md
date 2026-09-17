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

市场里的插件列表**不是** npm 搜索，而是精选列表仓库生成的一份目录：
`https://awesome-dsh-plugin.com/plugins.json` ← `github.com/awesome-dsh-plugin/awesome-dsh-plugin`
（`data/plugins/*.yml` 为数据源，两个 README 由脚本生成，**不要手工编辑 README**）。所以
"包发到 npm 了但市场搜不到"几乎总是同一个原因：**投稿 PR 还没被合并**。校验一下：

```sh
curl -sL https://awesome-dsh-plugin.com/plugins.json | grep -c "Jueze-2019"   # 0 = 还没收录
```

投稿方式（v0.9.0 时的规则，见对方 `contributing.md`）：新增**一个文件**
`data/plugins/<owner>__<repo>.yml`（monorepo 子包用 `owner/repo#subname` + `url` 指子目录）：

```yaml
url: https://github.com/Jueze-2019/dsh-redteam-mode/tree/main/packages/redteam-bundle
name: Jueze-2019/dsh-redteam-mode#packages/redteam-bundle
category: security
description:
  en: "Red-team engagement mode: ... ships 13 native skills, 53 redteam_* tools and one-command self-update."
  zh: "红队作战模式：... 随包 13 个原生技能、53 个 redteam_* 工具与一键自更新。"
```

> 描述里**含 `: `（冒号+空格）必须整体加引号**，否则 YAML 会当成嵌套键。

**当前 PR**：[#5034](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin/pull/5034)
（fork 分支 `Jueze-2019:add-dsh-redteam-mode`）。对方规则的两条要点：

* **CI 通过只是前置条件**：`Submission gate` / `check` 绿了不代表会合，维护者会**实际读仓库**，
  而且是**对着描述里的数字逐个核对**（"53 个工具"会被数一遍）。
* 所以**每次改版都要回头更新这个条目**：角色数、工具数、技能数、页签数、关键能力点变了就要改，
  否则评审第 1 条（代码是否与条目声明一致）就会被打回。更新只改自己那一个文件，别碰 README。

更新条目（稀疏检出很快，别整仓 clone：仓库很大）：

```sh
git clone --depth 1 --filter=blob:none --sparse -b add-dsh-redteam-mode \
  git@github.com:Jueze-2019/awesome-dsh-plugin.git /tmp/awesome
cd /tmp/awesome && git sparse-checkout set data/plugins
$EDITOR data/plugins/Jueze-2019__dsh-redteam-mode--packages-redteam-bundle.yml
git add -A && git commit -m "data: update dsh-redteam-mode entry for vX.Y.Z" && git push
```

**发布前自检清单**（v0.9.0 起）：

- [ ] `packages/redteam-bundle/package.json` 版本号 = 本次要发的版本
- [ ] `node tools/build.mjs --check` 通过（生成物与源码同步）
- [ ] `npm publish --access public` 成功（`npm view dsh-redteam-mode version` 能看到新版本）
- [ ] `git tag vX.Y.Z && git push origin main --tags`
- [ ] **GitHub Release 已建**：`bash scripts/release-notes.sh vX.Y.Z`
      （说明写在 `docs/releases/vX.Y.Z.md`；**只推 tag 不建 Release 的话 Releases 页面不会更新**，
      v0.9.0/0.9.1/0.9.2 就这样漏过一次 —— `bash scripts/release-notes.sh --check` 可以查出哪些 tag 还没有 Release）
- [ ] **市场条目里的数字与文案已同步到本版**（角色数 / 工具数 / 技能数 / 关键能力）
- [ ] PR 评论里说明"上一版描述哪里过时、现在是什么"，方便维护者复核

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
