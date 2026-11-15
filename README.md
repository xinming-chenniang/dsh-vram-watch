# 显存诊断（dsh-vram-watch）

**不是又一个显存仪表盘，而是爆显存之后给结论的那个。**

市场里的显存插件都在画实时读数。问题是：OOM 一崩，显存立刻释放，你盯着面板只能看到"现在没事"。这个插件默认常驻轻采样，把最近一小时留在内存里；你回头问 agent「刚才为什么爆」，它读缓冲，给你四段结论：

- **谁吃掉的**：每个进程的首次 → 末次 → 峰值，还在不在
- **是不是溢出到系统内存**：共享显存涨了多少（"没爆但慢十倍"的真正原因）
- **有没有泄漏**：谁在单调上涨
- **结束后释放了没有**：任务退出后专用显存还比基线高多少

## 安装

```powershell
dsh plugin --profile desktop add @xinming-chenniang/dsh-vram-watch
```

或在桌面端「设置 → 插件」里搜索「显存诊断」。安装后重启 DSH，采样器自动开始。

## 用法

直接对 agent 说人话：

- 「刚跑 SD 报了 CUDA out of memory，查一下为什么」
- 「显存一直涨，是不是泄漏」
- 「跑图没爆但特别慢，是不是溢出到系统内存了」

agent 会调 `vram_report`（默认最近 30 分钟窗口）并读结论。两个工具：

| 工具 | 作用 |
|---|---|
| `vram_report` | 出诊断报告；`csv` 参数可直接分析历史 CSV，`write_csv` 把窗口落盘 |
| `vram_watch` | `status` / `start` / `stop` 采样器（默认已自动运行） |

报告长这样（本机实测）：

```
==== 显存诊断报告 ====
来源  : 内存缓冲（最近 30 分钟）
采样  : 892 次 / 1,784 秒（15:20:10 - 15:49:54）
显存  : 基线 1,503 MiB → 峰值 8,002 MiB (98%) @ 15:21:14 → 末值 2,674 MiB
共享  : 基线 162 MiB → 峰值 2,140 MiB（+1,978 MiB）
GPU   : 峰值 100% · 均值 29%
温度  : 峰值 72°C
功耗  : 峰值 190 W

进程显存（首次 → 末次，峰值）:
  python                   141 → 1,835 MiB（+1,694，峰 7,771）  仍在
  chrome                    85 → 153 MiB（+68，峰 328）  仍在
  ...

判断:
  - 显存峰值 8,002 MiB，已占 98%，接近打满
  - 共享显存比基线涨了 1,978 MiB：WDDM 已往系统内存溢出，随后可能卡顿/OOM
  - 增长最多的是 python（+1,694 MiB，仍在运行）：若持续单调上涨，考虑显存泄漏
```

## 判读规则

| 现象 | 结论 |
| --- | --- |
| 峰值 > 总显存 95% | 接近打满，下一次再加就是 OOM |
| 共享显存比基线涨 > 300 MiB | 已溢出到系统内存，接着就是卡顿 / OOM |
| 结束值比基线高 > 300 MiB | 进程没完全释放（仍开着或缓存驻留） |
| 单进程末值 − 首值 > 500 MiB | 疑似泄漏；已退出的则提示"崩溃或正常结束" |
| 温度峰值 > 80°C | 提醒散热（桌面卡约 83°C 开始降频） |

## 数据口径

- **专用 / 共享显存**走 WDDM 性能计数器（与任务管理器同源）；**GPU 利用率 / 温度 / 功耗 / 整卡已用**走 `nvidia-smi`。
- 采样节奏：GPU 指标 **2 秒**一次（空闲超过 2 分钟自动降到 10 秒）；共享显存与全进程表 **20 秒**一次——PDH 单次查询实测约 1 秒，高频划不来。
- 进程表同时汇总 PDH（覆盖 Chrome、桌面等图形进程）与 `nvidia-smi` 的算力进程（Python、训练进程），同名取较大值。
- CSV 列格式与 `vram-watch` 技能完全一致：技能里的 `vram-report.ps1` / `vram-chart.ps1` 可以直接读本插件写出的 CSV。

## 限制（写清楚，免得装完失望）

- **仅 Windows + NVIDIA**。PDH 的 GPU 计数器与 `nvidia-smi` 都是 Windows/NVIDIA 专有；AMD / Intel 用不了。
- **没有界面**。v0.1 刻意不做看板——同类插件已经够多，预算花在结论上；需要曲线就用技能的 `vram-chart.ps1` 读 CSV。
- **缓冲只在内存**，插件停止或 DSH 退出即丢。要留证，调 `vram_report` 加 `write_csv`。
- 不注入游戏、不挂钩子、不装服务；只读性能计数器 + `nvidia-smi`，反作弊友好。
- 开销（按实测单次成本折算，未逐进程采 CPU）：每 20 秒约 1 秒 PDH + 每 2 秒两次 `nvidia-smi`（各约 50 ms），约 **10% 单核 / 1% 整机**（12 线程）；空闲降频后减半。

## 配置

默认值就能用；要改在 profile 的 `cordis.patch.yml` 覆盖：

```yaml
- id: dsh-vram-watch
  name: '@xinming-chenniang/dsh-vram-watch'
  config:
    autoStart: false     # 不常驻，需要时让 agent 调 vram_watch start
    intervalSec: 3
    pdhEverySec: 30
    bufferMinutes: 120
    csvDir: D:/dsh/tmp
```

| 字段 | 默认 | 说明 |
| --- | --- | --- |
| `autoStart` | `true` | 装载即开始采样（不先开就接不到 OOM 现场） |
| `intervalSec` | `2` | `nvidia-smi` 采样间隔 |
| `pdhEverySec` | `20` | 共享显存 / 全进程表的采样间隔 |
| `bufferMinutes` | `60` | 内存缓冲保留时长 |
| `csvDir` | `%TEMP%\dsh-vram-watch` | CSV 输出目录 |
| `powershell` | 自动 | 指定 powershell 路径（默认 Windows PowerShell 5.1） |

## 隐私

不联网、不读你的文件（只有你显式传 `csv` 路径时读那个文件）、不写注册表；CSV 落在 `%TEMP%\dsh-vram-watch\`，随系统临时目录清理。

## 兼容性

| 项 | 实测 |
| --- | --- |
| DSH | 0.2.2-rc.3（`engines.dsh >= 0.2.2-rc.3`） |
| 系统 | Windows 11 26220（WDDM 计数器需要 Win10 1809+） |
| PowerShell | Windows PowerShell 5.1 与 pwsh 7 均实测可用 |
| Node | >= 20 |

## 卸载

```powershell
dsh plugin --profile desktop remove @xinming-chenniang/dsh-vram-watch
```

采样进程是宿主的子进程，随插件卸载 / DSH 退出一起结束，不留后台服务。
