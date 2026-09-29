# 市场投稿 PR 的支撑材料

`docs/marketplace.md` §2 的附件，放这里是为了**跟仓库一起版本化**（下次改版要同步更新时，
直接改这几个文件再推到 fork 分支即可）。

| 文件 | 用途 |
| --- | --- |
| `entry-file.yml` | 投稿条目本体，对应市场仓库的 `data/plugins/Jueze-2019__dsh-redteam-mode--packages-redteam-bundle.yml` |
| `pr-6076-comment.md` | **当前生效**：PR [#6076](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin/pull/6076)（v0.12.x 条目，仍开着）上的复核评论，2026-09-29 随 0.12.1 发布贴出 |
| `pr-5034-comment.md` | 历史：首次收录 PR [#5034](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin/pull/5034) 的评论（已合并；里面的"23 个技能"是去武器化之前的旧口径，别再照抄） |

> 已合并的：**#5034**（首次收录）、**#5575**（v0.11.x 条目）。线上条目的 `version` 字段由 npm
> 自动取，发新版不必改它；只有"被描述的能力"（角色数 / 技能数 / 工具数 / 页签数）变了才要动条目。

## 更新流程（改版后必做）

```sh
# 1) 稀疏检出（别整仓 clone，仓库很大）
git clone --depth 1 --filter=blob:none --sparse -b add-dsh-redteam-mode \
  git@github.com:Jueze-2019/awesome-dsh-plugin.git /tmp/awesome
cd /tmp/awesome && git sparse-checkout set data/plugins
# 2) 若 fork 落后上游 main，先同步（否则 PR check 会因 README 与 base 不一致而失败）
git fetch --depth 1 --filter=blob:none https://github.com/awesome-dsh-plugin/awesome-dsh-plugin.git main
git reset --hard FETCH_HEAD          # 等价 GitHub 界面的 "Sync fork"
# 3) 放回条目文件并提交
cp /path/to/entry-file.yml data/plugins/Jueze-2019__dsh-redteam-mode--packages-redteam-bundle.yml
git add -A && git commit -m "data: update dsh-redteam-mode entry for vX.Y.Z"
git push --force-with-lease origin HEAD:add-dsh-redteam-mode
```

**坑（v0.9.0 实测）**：fork 落后 main 时，`base...HEAD` 的 README 差异会让 `PR check`
的 "READMEs match data/plugins" 步骤报错（报错文案会误导你去改 README，其实只需同步 fork）。
