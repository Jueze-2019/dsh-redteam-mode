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

### ⚠️ 真正的拦路虎是「双用途内容政策」，不只是 2FA

两次踩坑（2026-09）合起来才看清全貌，顺序很重要：

**第一层：发布期恶意代码扫描。** npm 2026-07 起在每个包**发布时**自动扫描，扫完才可安装
（通常 5 分钟，峰值 15 分钟以上）。npm 网站 → Settings → Packages 里，版本状态会显示
`Validating`（校验中），此时 `npm unpublish` 与 `npm deprecate` 都不可用，只有 `dist-tag` 能用。
**`Validating` 卡十几分钟不散，不是网络问题，是被扣下人工复核了。**

**第二层：双用途（dual-use）内容申报。** 本包编排扫描器、会话工具与反弹 Shell 技能，
正落在政策定义的 dual-use 范围里。政策要求**两件事，缺一不可**：

1. `package.json` 里声明：`"contentPolicy": { "class": "dual-use" }`
2. 包根放一个 `DISCLOSURE` 文件（自由文本，说明双用途能力与合法用途；已加进 `files`）

未申报的包会被扣住不放行 —— 这正是 `0.11.0` / `0.11.1` / `0.11.2` 卡在 `Validating` 的原因。

**第三层：双用途包必须用强制 2FA 的方式发布。** 政策原文：声明了 dual-use 的包，
必须走受信发布（OIDC）、带验证码的交互式会话、或暂存后批准；**用绕过 2FA 的 token 直接发是不允许的**
（发到暂存则允许）。所以最终只有两条路：

| 方案 | 前提 | 命令 |
| --- | --- | --- |
| 受信发布（推荐长期） | 账号开 2FA + npm 包设置里绑定本仓库 GitHub Actions | CI 里 `npm publish`，走 OIDC，无需长期 token |
| 暂存后批准 | 账号开 2FA | `npx npm@12 stage publish` → `npx npm@12 stage approve <stage-id>` |

> **本账号目前 `npmjs.com → Profile` 里是 `Enable 2FA`（等于没开）**——
> 没有 2FA 就既批准不了暂存、也过不了双用途的强制 2FA 要求，这是当前唯一的卡点。

### 顺带记录：绕过 2FA 的 token 还有两个副作用

- 这类 token 调的 `npm publish` 可能被降级为**暂存**，命令照样打印 `+ pkg@x.y.z`；
  重发同版本报 `409 Cannot publish over previously staged version`；
- **不能 `npm unpublish`**（403 `Granular access tokens that bypass two-factor
  authentication may not perform this action`）——误发的版本只能去网站删（网站要 2FA）；
  但 `npm dist-tag add` 仍可用，误发版本若抢占了 `latest`，先把 `latest` 指回稳定版：
  `npm dist-tag add dsh-redteam-mode@<上一个稳定版> latest`。

> npm **没有**网页上传 tarball 的入口（`/package/new`、`/publish` 都是 404/403）——
> 发布只能走 CLI，别再去网页找上传按钮。

### ⚠️ 开 2FA 会触发 72 小时只读冻结（发布必被 403）

启用或修改 2FA、使用恢复码、修改邮箱这类**敏感账号变更**，会被 npm 放进**只读状态 72 小时**
（[npm 的预防性账号保护](https://github.blog/changelog/2026-09-09-npm-extends-recovery-code-security-holds-to-all-accounts/)）。
期间发布、管理 token、改包可见性等操作全部被拦，报错是：

```
npm notice Your account has been temporarily suspended due to a recent security-sensitive action.
npm error code E403 ... 403 Forbidden - PUT https://registry.npmjs.org/<pkg> - [object Object]
```

**不需要申诉、不需要任何确认**，满 72 小时自动恢复；期间安装/下载、看设置都正常，包对使用者始终可用。
紧急情况才走 <https://www.npmjs.com/support>。

> 所以**要开 2FA 就早点开**，别卡在发版当天。这次 v0.11.3 就是开完 2FA 立刻发布，撞上冻结。

### npm 的 2FA 只支持 WebAuthn 安全密钥（没有验证器 App）

npm 的 2FA 没有 TOTP（6 位验证码）、没有短信，**只有 WebAuthn 安全密钥**
（[官方文档](https://docs.npmjs.com/about-two-factor-authentication/)）。选项里写的
"physical security key over USB or NFC, fingerprint reader, facial recognition, or password/PIN"
指的是**同一套 WebAuthn**：既包括 YubiKey 这类硬件密钥，也包括**设备自带的指纹 / Windows Hello /
Face ID / Touch ID**（即"平台认证器"）。

判定某台机器能不能用来开 2FA，在浏览器里跑一句就知道：

```js
await PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable()   // false = 这台机器没有平台认证器
```

本机 Kali 是 QEMU 虚拟机：该值为 `false`，且无指纹硬件、无蓝牙（Chrome 的"用手机做安全密钥"
走蓝牙，用不上）——**所以在这台 VM 里开不了 2FA**，需要在有生物识别的宿主机上开，或插一个硬件密钥。

**开了之后不必每次按密钥**：配好受信发布（`.github/workflows/publish.yml`）后，
发版由 CI 用 OIDC 完成，既不用碰密钥、也不用长期 token。

**每次 `npm publish` 之后必须验证**（返回成功不算数）：

```sh
curl -s https://registry.npmjs.org/dsh-redteam-mode | grep -o '"latest":"[^"]*"'   # 应显示新版本
npm view dsh-redteam-mode version
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
