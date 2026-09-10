---
name: web-fingerprint
description: Web 服务指纹识别：框架、中间件、CMS、组件版本
whenToUse: 已发现 HTTP/HTTPS 服务，需要识别技术栈时
role: recon
enabled: true
---

## 方法
1. 响应头：`Server`、`X-Powered-By`、`Set-Cookie` 特征。
2. 页面特征：favicon 哈希、静态资源路径、报错页、robots.txt。
3. 主动探测：nuclei 技术识别模板 `nuclei -u <url> -tags tech`。
4. 版本比对：从指纹推断产品与版本，为漏洞检测做准备。

## 落库要求
写入 fingerprint 表：category（框架/中间件/CMS/组件）、vendor、product、version、evidence。
