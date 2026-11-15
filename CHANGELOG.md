# Changelog

## 0.1.0 — 2026-11-15

首个版本。定位：**诊断**，不是看板。

- 常驻采样器：一个长驻 Windows PowerShell 进程，逐行输出 JSON 样本；宿主侧环形缓冲默认保留 60 分钟。
  - GPU 利用率 / 温度 / 功耗 / 整卡已用：`nvidia-smi`，默认 2 秒一次，空闲 2 分钟后自动降到 10 秒。
  - 专用 / 共享显存 + 全进程显存：WDDM 性能计数器（PDH），默认 20 秒一次（单次约 1 秒，实测）。
- `vram_report`：四段结论报告（峰值与基线、共享显存溢出、进程增长与是否仍在、泄漏/未释放判断）；
  可直接读历史 CSV，可把窗口落盘为 CSV。
- `vram_watch`：采样器 `status` / `start` / `stop`。
- CSV 列格式与 `vram-watch` 技能兼容（`vram-report.ps1` / `vram-chart.ps1` 可直接读）。
- 测试 19 项（缓冲区 / CSV 往返 / 报告判读 / 插件注册 / 空窗口不编数字）。

实测环境：RTX 2060 SUPER 8 GB / Win11 26220 / DSH 0.2.2-rc.3 / PowerShell 5.1 与 7。
