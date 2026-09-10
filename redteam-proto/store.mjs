#!/usr/bin/env node
/**
 * 原型期 CLI 壳（保留兼容）：
 * 动态 Cordis Host 半侧无法 import/require，只能经 ctx.shell 调用本文件；
 * 实现已上移到正式包 packages/redteam-store，这里只做转发，保证
 * 「界面 / 智能体 / 命令行」共用同一份数据核心。
 */
import '../packages/redteam-store/bin/cli.mjs'
