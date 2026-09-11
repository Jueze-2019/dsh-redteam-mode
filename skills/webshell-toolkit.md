---
name: webshell-toolkit
description: 冰蝎 / 哥斯拉 / 中国蚁剑 的启动与用法，用于上传并管理 WebShell、维持访问、操作目标服务器
whenToUse: 已获得上传点/文件写入/命令执行，需要落地并操作 WebShell 时
role: exploit
enabled: true
---

# WebShell 工具包（已就位）

目录 `$DSH_HOME/redteam/toolkit/`，Java 25 已安装。

| 工具 | 启动命令 | 说明 |
|---|---|---|
| 冰蝎 Behinder v4.1 | `java -jar $DSH_HOME/redteam/toolkit/Behinder/Behinder.jar` | AES 加密流量，JSP/PHP/ASPX |
| 哥斯拉 Godzilla v4.0.1 | `java -jar $DSH_HOME/redteam/toolkit/Godzilla/godzilla.jar` | 支持 JSP/PHP/ASPX 全加密 payload |
| 中国蚁剑 AntSword | `$DSH_HOME/redteam/toolkit/AntSword/AntSword-Loader-v4.0.3-linux-x64/AntSword` | 首次启动选择源码目录 `antSword-2.1.16` |
| suo5 隧道 | `./suo5-linux-amd64` | 见技能 `suo5-tunnel` |

## 典型流程（授权演练）
1. **确定写入点**：上传漏洞 / 任意文件写 / 后台插件上传 / 模板写入 / 数据库写文件（`INTO OUTFILE`）。
2. **生成 payload**：用工具 GUI 的「生成」功能，按目标语言选 JSP/JSPX/PHP/ASPX，密码与密钥随机生成并记到 `runs/`。
3. **上传并访问**：`curl -s "https://target.example.com/upload/x.jsp"` 确认返回 200；不要把 shell 放在显眼路径（如 `/shell.jsp`）。
4. **连接管理**：在工具里新增 URL + 密码，测试连接；成功后用「虚拟终端」执行命令。
5. **维持与利用**：
   - 收集 `id/whoami/hostname/uname -a`、系统账号、内网 IP、路由。
   - 用 suo5 起隧道进内网（技能 `suo5-tunnel`）。
   - 抓取敏感文件：`/etc/passwd`、配置、`.env`、源码、数据库连接串 → 存 `runs/`。
6. **落库**：
   - `redteam_access_add`（host/账号/方式 webshell/权限/会话引用）
   - `redteam_vuln_update` 把入口漏洞置为 `exploited`
   - `redteam_http_evidence_add` 保存上传请求与 shell 访问请求
   - `redteam_chain_add`（stage=exploit/access）

## 命令执行（无 GUI 时的替代）
如果只需要命令执行，优先直接用已有 RCE 或隧道，不必启动 GUI：
```bash
# 例：通过 webshell 传参执行（按目标 shell 类型调整）
curl -s "https://target.example.com/upload/x.jsp?cmd=id"
# 或用冰蝎/哥斯拉的 CLI 无（GUI only）→ 用 suo5 隧道 + 常规工具
```

## 注意事项
- 生成的 shell 只能上传到**本次授权演练的目标**；用完按需清理（删除文件、恢复原状）。
- 工具 GUI 需要图形会话（`DISPLAY=:10.0` 可用）。
- 凭据用 `redteam_credential_add` 落库：**明文写 `secret_value`**（面板直接显示，便于复用），同时把证据文件写 `runs/` 并在 `secret_ref` 里引用。资产库只在本机，别把库或导出内容带走。
- 目标可能有 EDR/查杀：先测试 shell 是否存活，避免反复落地触发告警。
