# market —— 上架物料

> **出处**：2026-11-18 会话，从 `D:\dsh\tmp\20261118-plugin-market-entries\` 移入（tmp 是临时区，收尾要清）。
> **是什么**：`awesome-dsh-plugin` 的市场条目（一个插件一个 YAML，提交方式见 `D:\dsh\plugins\RELEASING.md` §5）。
> **状态**：npm `0.1.0` 已发（2026-11-18）、GitHub 仓与 Release `v0.1.0` 已建；**PR 待仓库满 1 天**（2026-11-19）后开。
> **处置**：保留到 PR 合并；合并后本目录只剩「条目快照 + 下次改版怎么改」才有价值。
> **关联**：`D:\dsh\plugins\RELEASING.md`（发布规则）· `D:\dsh\plugins\README.md`（版本基线）· `D:\dsh\tmp\20261115-market\`（图标批次脚本，`make_icons*.py` 可复用）

## 顺序（不能反）

1. **npm 首发** —— 本机 npm 11.17 直接 `publish` 报 `E_STAGE_REQUIRED`，走 `npm stage publish` 再
   `npm stage approve`（浏览器 2FA）。**2026-11-18 实测：11.17 的 staged publish 能创建新包名**
   （`dsh-quiet-update` 与 scope 新包 `@xinming-chenniang/dsh-vram-watch` 都是一次成功），
   2026-11-10 那条「不能建新名」的结论已不成立。`stage approve` 的授权链接只在终端里可见（非 TTY 会被打码），
   且短时有效。本机默认 registry 是 npmmirror，**每条命令都要显式 `--registry`**。
2. **GitHub 建仓 + Release** —— 仓名 `dsh-vram-watch`、公开、topic `dsh-plugin` / `deepseek-harness`；
   Release 资产必须是同一份 `npm pack` 产物（不是重新打包）。
3. **开市场 PR** —— 条目本身不写 `npm:`（市场从 `package.json` 推版本）；仓库创建满 1 天后才能提。
   一个 PR 最多 3 条，本插件单独一个 PR。

## 条目里还差什么

- 无。npm 已发、`assets/icon-180.png` 已生成并在条目里启用；`npm:` 行已删（条目 schema 里没有这个字段，
  版本由市场从 `package.json` 推导）。只剩「仓库满 1 天 → 开 PR」。

## 实测（2026-11-18，当场跑的）

`npm test` **19/19**；`npm pack --dry-run` = 12 文件 / 17.4 kB 包体（解包 44.2 kB）。
