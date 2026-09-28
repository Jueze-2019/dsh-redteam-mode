# 把 npm 的验证器换成"云同步 passkey"（iCloud 钥匙串 / Google 密码管理器）

> 背景：本机（QEMU VM）没有任何 WebAuthn 认证器，npm 又只认 WebAuthn（没有 TOTP、没有短信），
> 所以"发版要按的那个东西"必须云同步，或者永远放在手边。
> 本文记录两条已核实的路径与全部前提。2026-09-28 实测整理。

## 0. 先纠正一个前提：认证器**不能搬**，只能**新增**

WebAuthn 的私钥是在认证器内部生成的、**永远不出设备**。所以 npm 上那个叫
`15728875568` 的安全密钥**无法"放进"钥匙串**——你要做的是：

> **再注册一个新认证器（passkey），让钥匙串成为其中之一。**

好消息：npm 支持**多个安全密钥**（账号页显示的是"1 security key"，可以继续 Add），
新加的不会让旧的失效，可以留着当备份。

## 1. iCloud 钥匙串（Apple 设备）

### 前提
- 一台 Apple 设备：iPhone / iPad / Mac（**iCloud 钥匙串必须开启**，设置 → Apple ID → iCloud → 密码与钥匙串）；
- 建议直接用 **iPhone 上的 Safari** 操作：注册时只需要 Face ID / Touch ID / 设备密码，
  不依赖任何硬件密钥。

### 步骤
1. iPhone 上 Safari 打开 <https://www.npmjs.com> 并登录（登录本身要过现有安全密钥，
   如果那台手机就是密钥所在设备，正好一次办完）。
2. 进 **Account → Two-Factor Authentication → Modify 2FA**，页面是
   <https://www.npmjs.com/settings/<你的用户名>/tfa/list>
   （注：这个页面自身会先要求验证一次）。
3. 点 **Add Security Key** → 给新密钥起个名，例如 `iCloud-Keychain`（名字以后改不了，起清楚）。
4. **浏览器弹 WebAuthn 提示时选 iCloud 钥匙串**（iOS 上通常直接给"保存到 iCloud 钥匙串"选项；
   macOS Safari 会弹系统对话框让你选保存位置）。
5. Face ID / Touch ID / 设备密码验证 → 完成。
6. 验证是否生效：在那台设备上重新走一次 npm 验证，应能直接选到 `iCloud-Keychain`。

### 之后怎么发布
| 场景 | 做法 |
| --- | --- |
| 在 Mac 上 | `npm publish` → 浏览器弹出 → 选 `iCloud-Keychain` → Touch ID → 完成 |
| 在 Linux / Windows 上（比如本 VM） | 走 `scripts/otp-flow.mjs`：我这边起流程并给出链接，你在 iPhone 上打开链接完成 Face ID，我这边领取凭据继续发布 |

> ⚠️ **iCloud 钥匙串的 passkey 只在 Apple 设备上可用**：Chrome on Linux/Windows 里选不到它。
> 所以"在这台 VM 里直接发版"仍然不成立——只是把"验证动作"简化成手机上点一下。

## 2. Google 密码管理器（跨平台，若你想在 Linux/Windows 上直接发）

Chrome 在 Linux/Windows/macOS 上都能调起 **Google 密码管理器**的 passkey（需 Chrome 登录同一 Google 账号）。

1. 在**能过现有 2FA** 的设备上登录 npm，进同一个 `Modify 2FA → Add Security Key`；
2. 起名 `Google-PWM`，弹提示时选 **"使用 Google 密码管理器" / "在此设备上保存"**；
   注意 Linux 上若没有平台认证器，Chrome 会用 **Google 账号密码/手机确认**来保护这条 passkey；
3. 完成后，任何登录同一 Google 账号的 Chrome 都能选到它 —— 包括这台 VM。

这是**唯一能让本 VM 自己完成 npm 发布**的形态（只要 Chrome 在线并登录 Google 账号）。

## 3. 别忘了恢复码

`Modify 2FA → Manage Recovery Codes`：生成一份，存进密码管理器。
它是设备全丢时唯一的救命稻草。**但注意**：官方明确写了，用恢复码登录会触发
**72 小时安全冻结**，期间**不能发布、不能建 token**，且不能提前解除。

## 4. 本机（这台 VM）的现实结论

- 无平台认证器、无 USB 安全密钥、无蓝牙 → **任何"本机按一下"的方案在这里都不成立**；
- 可行的两种：
  1. **手机/另一台电脑完成验证 + 本机 CLI 领取凭据**（`scripts/otp-flow.mjs`，已验证链路通）；
  2. **注册 Google 密码管理器 passkey**，让本机 Chrome 自己就能验证；
- 长期最省心的仍是 **一个 USB 安全密钥插在本机**：既解决验证，也不用依赖别的设备在线。
