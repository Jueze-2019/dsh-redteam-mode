# Kimi WebBridge 环境配置（Linux 桌面机）

> 目的：让红队智能体可以驱动**真实浏览器**（复用真实登录态）访问目标站点。
> 本文件记录系统级改动，便于重装/回滚。

## 1. 组件与版本（实测 2026-09）

| 组件 | 版本 | 位置 |
| --- | --- | --- |
| 守护进程 | v2.0.8 | `~/.kimi-webbridge/bin/kimi-webbridge`，监听 `127.0.0.1:10086` |
| systemd 服务 | — | `/etc/systemd/system/kimi-webbridge.service`（enabled + active） |
| 浏览器扩展 | Kimi 2.0.8 | 由企业策略从 Chrome 应用商店强制安装，ID `fldmhceldgbpfpkbgopacenieobmligc` |
| 策略文件 | — | `/etc/opt/chrome/policies/managed/kimi-webbridge.json`、`/etc/chromium/policies/managed/kimi-webbridge.json` |
| 启动器 | — | `~/.local/bin/kimi-chrome` + `~/.local/share/applications/kimi-chrome.desktop` |
| 技能说明 | — | `~/.dsh/skills/kimi-webbridge.md` |

## 2. 开机自启

```ini
# /etc/systemd/system/kimi-webbridge.service
[Service]
Type=simple
User=<你的用户名>
Environment=HOME=/home/<你的用户名>
ExecStart=/home/<你的用户名>/.kimi-webbridge/bin/kimi-webbridge start --foreground
Restart=on-failure
[Install]
WantedBy=multi-user.target
```

```bash
systemctl is-active kimi-webbridge   # active
systemctl is-enabled kimi-webbridge  # enabled
```

**注意**：不要在服务外手敲 `kimi-webbridge start` / `upgrade`，那会起游离进程、systemd 单元变 inactive。
升级流程：

```bash
sudo systemctl stop kimi-webbridge
~/.kimi-webbridge/bin/kimi-webbridge upgrade
sudo systemctl start kimi-webbridge
```

## 3. 浏览器扩展：为什么用企业策略而不是 `--load-extension`

- Chrome 137+ **忽略** `--load-extension`（`--disable-features=DisableLoadExtensionCommandLineSwitch` 逃生口已失效），
  实测 Chrome 153 + 该开关启动后 profile 的 `Preferences` 里根本没有扩展条目。
- 守护进程二进制内置接受 5 个扩展 ID，其中包含**商店正式版 ID** `fldmhceldgbpfpkbgopacenieobmligc`。
- 因此改为**企业策略强制安装**（`ExtensionSettings.force_installed` + `ExtensionInstallForcelist`）：
  任何 Chrome / Chromium profile 启动后 ~10 秒内自动从应用商店安装并常驻启用，且自动更新。

验证（新 profile 也能自动装上）：

```bash
chromium --user-data-dir=/tmp/ctest --no-first-run about:blank &
sleep 12
python3 -c "import json;d=json.load(open('/tmp/ctest/Default/Preferences'));print([ (k,(v.get('manifest') or {}).get('version')) for k,v in d['extensions']['settings'].items() if k.startswith('fldmh')])"
# [('fldmhceldgbpfpkbgopacenieobmligc', '2.0.8')]
```

### 回滚
```bash
sudo rm /etc/opt/chrome/policies/managed/kimi-webbridge.json \
        /etc/chromium/policies/managed/kimi-webbridge.json
# 之后扩展会在下一次启动时被卸载
```

## 4. 启动桥接浏览器

```bash
kimi-chrome                        # Chrome，默认 profile（带真实登录态）
KIMI_BROWSER=chromium kimi-chrome  # 改用 Chromium
KIMI_PROFILE=~/.config/kimi-chrome kimi-chrome   # 独立 profile（干净、无登录态）
```

桌面菜单里是「Kimi 桥接浏览器（Chrome）」。

> 旧方案（专用 profile + `--load-extension` 加载解压版 2.0.5）已废弃：
> 解压版条目已从 `~/.config/chromium/Default/Preferences` 移除
> （备份：`~/.config/chromium/Default/Preferences.bak-kimi`），
> 解压目录 `~/下载/kimi-webbridge-extension` 仍保留，但不再被加载。

## 5. 调用与自检

```bash
curl -s http://127.0.0.1:10086/status | python3 -m json.tool   # extension_connected 必须为 true

WB=http://127.0.0.1:10086/command
call() { printf '%s' "$2" > /tmp/wb.json; curl -s -X POST $WB -H 'Content-Type: application/json' --data-binary @/tmp/wb.json; }
call navigate '{"action":"navigate","args":{"url":"https://example.com","newTab":true},"session":"t1"}'
call evaluate '{"action":"evaluate","args":{"code":"document.title"},"session":"t1"}'
call close_session '{"action":"close_session","args":{},"session":"t1"}'
```

`extension_connected: false` 时 99% 只是**没有浏览器在运行**——打开任一浏览器后 5 秒内自动连上。

## 6. 已知限制

- 无 headless，必须有图形会话（本机 `DISPLAY=:10.0`）。
- 只支持 Chrome/Edge；跨域 iframe、验证码/银行控件不可用。
- Linux 不在官方支持矩阵（实测可用）。
