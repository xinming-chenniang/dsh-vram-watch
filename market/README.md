# market —— 上架物料

> **出处**：2026-11-18 会话，从 `D:\dsh\tmp\20261118-plugin-market-entries\` 移入（tmp 是临时区，收尾要清）。
> **是什么**：`awesome-dsh-plugin` 的市场条目（一个插件一个 YAML，提交方式见 `D:\dsh\plugins\RELEASING.md` §5）。
> **状态**：条目已过 YAML 解析；**npm / GitHub 远端 / PR 三步都未做**（本机 npm 未登录，仓库无 origin，动作等用户点头）。
> **处置**：保留到 PR 合并；合并后本目录只剩「条目快照 + 下次改版怎么改」才有价值。
> **关联**：`D:\dsh\plugins\RELEASING.md`（发布规则）· `D:\dsh\plugins\README.md`（版本基线）· `D:\dsh\tmp\20261115-market\`（图标批次脚本，`make_icons*.py` 可复用）

## 顺序（不能反）

1. **npm 首发** —— 新包名。本机 npm 11.17 直接 publish 报 `E_STAGE_REQUIRED`，且 11.17 的 staged publish
   不能创建尚不存在的包名（2026-11-10 发 `dsh-longshot` 实测）：
   `npx -y npm@12.2.2 stage publish --access public --registry=https://registry.npmjs.org`，
   然后浏览器 `stage approve` 过 2FA（非交互终端里链接会被打成 `***`）。本机默认 registry 是 npmmirror，
   **每条命令都要显式 `--registry`**。
2. **GitHub 建仓 + Release** —— 仓名 `dsh-vram-watch`、公开、topic `dsh-plugin` / `deepseek-harness`；
   Release 资产必须是同一份 `npm pack` 产物（不是重新打包）。
3. **开市场 PR** —— 条目里的 `npm` / `tarball` 那时才查得到。一个 PR 最多 3 条，本插件单独一个 PR。

## 条目里还差什么

- `npm:` / `icon:` 两行现在是注释：npm 未发；`assets/icon-180.png` 还没做（只有 `icon.svg`）。
  两者都可后补，但「市场页能一键装」依赖 npm 那一行。

## 实测（2026-11-18，当场跑的）

`npm test` **19/19**；`npm pack --dry-run` = 12 文件 / 17.4 kB 包体（解包 44.2 kB）。
