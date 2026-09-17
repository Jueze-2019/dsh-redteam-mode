# 市场投稿 PR #5034 的支撑材料

`docs/marketplace.md` §2 的附件，放这里是为了**跟仓库一起版本化**（下次改版要同步更新时，
直接改这两个文件再推到 fork 分支即可）。

| 文件 | 用途 |
| --- | --- |
| `entry-file.yml` | 投稿条目本体，对应市场仓库的 `data/plugins/Jueze-2019__dsh-redteam-mode--packages-redteam-bundle.yml` |
| `pr-5034-comment.md` | 可直接粘贴到 PR #5034 的评论：说明"上一版描述哪里过时、现在是什么"，方便维护者复核 |

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
