/**
 * dsh-vram-watch —— 显存诊断插件（宿主半部）：
 *   常驻轻采样（默认自动开始，环形缓冲保留最近 1 小时），agent 用两个工具读：
 *     vram_watch  —— 看采样器状态 / 开始 / 停止
 *     vram_report —— 把窗口（或指定 CSV）变成四段结论，可选落盘 CSV
 *
 * 与市场上的「显存看板」类插件的差别：不画仪表盘，回答「为什么爆、谁吃的、
 * 有没有溢出到系统内存、结束后释放了没有」。数据口径与 vram-watch 技能一致
 * （WDDM 专用显存 + 共享显存 + nvidia-smi 的 GPU 指标），CSV 格式也兼容技能的
 * vram-report.ps1 / vram-chart.ps1。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Sampler } from './sampler.js';
import { buildReport } from './report.js';
import { parseCsv } from './csv.js';

export const name = 'dsh-vram-watch';
export const inject = ['tools'];
export const VERSION = '0.1.0';

const DEFAULTS = {
  autoStart: true,
  intervalSec: 2,
  pdhEverySec: 20,
  bufferMinutes: 60,
  csvDir: '',
  powershell: '',
};

function stamp() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

function csvDirOf(config) {
  return config.csvDir || path.join(os.tmpdir(), 'dsh-vram-watch');
}

function summaryLine(status) {
  if (!status.running) {
    return `采样器未运行${status.error ? `（${status.error}）` : ''}`;
  }
  const last = status.last;
  const parts = [`采样器运行中 · 已采 ${status.samples} 次 · 跨度 ${status.spanSeconds} 秒 · 整卡 ${status.totalMiB || '?'} MiB`];
  if (last) {
    const bits = [];
    if (last.ded !== null) bits.push(`专用 ${Math.round(last.ded)} MiB`);
    if (last.shared !== null) bits.push(`共享 ${Math.round(last.shared)} MiB`);
    if (last.util !== null) bits.push(`GPU ${Math.round(last.util)}%`);
    if (last.temp !== null) bits.push(`${Math.round(last.temp)}°C`);
    if (last.top) bits.push(`最大占用 ${last.top.name} ${Math.round(last.top.MiB)} MiB`);
    if (bits.length) parts.push(`最新：${bits.join(' · ')}`);
  }
  return parts.join('\n');
}

export function apply(ctx, rawConfig = {}) {
  const config = { ...DEFAULTS, ...(rawConfig && typeof rawConfig === 'object' ? rawConfig : {}) };
  const log = (message) => {
    try { ctx?.logger?.info?.(`dsh-vram-watch: ${message}`); } catch { /* 日志失败不影响功能 */ }
  };
  const tools = typeof ctx.get === 'function' ? ctx.get('tools') : ctx.tools;
  if (!tools || typeof tools.register !== 'function' || typeof ctx.effect !== 'function') {
    log('tools service unavailable; entry stays idle');
    return;
  }

  const sampler = new Sampler({
    intervalSec: config.intervalSec,
    pdhEverySec: config.pdhEverySec,
    bufferMinutes: config.bufferMinutes,
    powershell: config.powershell,
    logger: ctx.logger,
  });

  return ctx.effect(() => {
    if (config.autoStart !== false) {
      sampler.start();
      log(`auto-started (interval ${sampler.intervalSec}s, buffer ${config.bufferMinutes}min)`);
    }

    const reportOf = ({ minutes = 30, csv = '', top = 5 }) => {
      if (csv) {
        const text = fs.readFileSync(path.resolve(csv), 'utf8');
        const { samples, totalMiBHint } = parseCsv(text);
        const window = minutes > 0
          ? samples.filter((s) => s.t.getTime() >= samples[samples.length - 1].t.getTime() - minutes * 60_000)
          : samples;
        return { samples: window, totalMiB: totalMiBHint, source: path.resolve(csv) };
      }
      const window = sampler.window(minutes);
      return { samples: window, totalMiB: sampler.totalMiB, source: `内存缓冲（最近 ${minutes || '全部'} 分钟）` };
    };

    const disposeWatch = tools.register({
      name: 'vram_watch',
      description:
        'Inspect, start or stop the VRAM sampler that runs inside this DSH host. '
        + 'It samples GPU memory (WDDM dedicated + shared), utilization, temperature and per-process usage every few seconds and keeps the last hour in memory. '
        + 'Use action=status to see whether sampling is running and what the latest numbers are; '
        + 'action=start after the user says no monitor is running; action=stop to release it. '
        + 'For an actual diagnosis (peak, shared-memory spill, leak, what to change) call vram_report instead.',
      parameters: {
        type: 'object',
        properties: {
          action: { type: 'string', enum: ['status', 'start', 'stop'], description: 'status (default) | start | stop' },
        },
        required: [],
        additionalProperties: false,
      },
      output: {
        schema: { type: 'object' },
        render: (_args, value) => [{ type: 'text', text: value.text || value.error || '' }],
      },
      async execute(args) {
        const action = String(args?.action || 'status');
        if (action === 'start') {
          sampler.start();
          log('started by tool');
        } else if (action === 'stop') {
          sampler.stop();
          log('stopped by tool');
        }
        const status = sampler.status();
        return { ok: true, action, ...status, text: summaryLine(status) };
      },
      presentCall: () => ({ card: 'generic', title: 'VRAM sampler', kind: 'read' }),
    });

    const disposeReport = tools.register({
      name: 'vram_report',
      description:
        'Diagnose why a task ran out of GPU memory. Turns the sampler window (or a saved vram-watch CSV) into a four-part report: '
        + 'baseline/peak/final dedicated VRAM, shared-memory spill (WDDM spill into system RAM — the usual cause of "no OOM but 10x slower"), '
        + 'per-process first→last→peak (who grew, whether it is still running), and concrete judgements (near-full, spill, leak, not released). '
        + 'Use after an OOM, a CUDA error, or when the user asks 显存/爆显存/为什么这么慢. '
        + 'Pass csv to analyze a file recorded earlier; otherwise it uses the in-memory buffer. '
        + 'write_csv saves the window to a CSV that the older vram-watch skill scripts can also read.',
      parameters: {
        type: 'object',
        properties: {
          minutes: { type: 'number', description: 'Window size in minutes (default 30; 0 = everything buffered)' },
          csv: { type: 'string', description: 'Absolute path of a vram-watch CSV to analyze instead of the live buffer' },
          top: { type: 'number', description: 'How many processes to list, default 5' },
          write_csv: { type: 'boolean', description: 'Save the analyzed window to a CSV file (default true when analyzing the live buffer)' },
        },
        required: [],
        additionalProperties: false,
      },
      output: {
        schema: { type: 'object' },
        render: (_args, value) => [{
          type: 'text',
          text: value.ok === false
            ? `vram_report failed: ${value.error}`
            : `${value.text}${value.csv ? `\n\nCSV: ${value.csv}` : ''}`,
        }],
      },
      async execute(args) {
        try {
          const minutes = Number.isFinite(Number(args?.minutes)) ? Number(args.minutes) : 30;
          const { samples, totalMiB, source } = reportOf({
            minutes,
            csv: typeof args?.csv === 'string' ? args.csv : '',
            top: Number(args?.top) || 5,
          });
          const report = buildReport({ samples, totalMiB, top: Number(args?.top) || 5, source });
          if (report.ok === false) return { ok: false, error: report.error || '窗口内没有采样' };

          let csvPath = '';
          const shouldWrite = args?.write_csv !== false && !args?.csv;
          if (shouldWrite) {
            try {
              csvPath = path.join(csvDirOf(config), `vram-${stamp()}.csv`);
              sampler.writeCsv(csvPath, minutes);
            } catch (error) {
              csvPath = '';
              log(`write csv failed: ${error?.message}`);
            }
          }
          log(`report ${samples.length} samples${csvPath ? ` -> ${csvPath}` : ''}`);
          return { ok: true, text: report.text, issues: report.issues, samples: samples.length, csv: csvPath };
        } catch (error) {
          log(`report failed: ${error?.message}`);
          return { ok: false, error: String(error?.message || error) };
        }
      },
      presentCall: () => ({ card: 'generic', title: 'VRAM diagnosis', kind: 'read' }),
    });

    return () => {
      try { disposeWatch?.(); } catch { /* 卸载失败不影响其它工具 */ }
      try { disposeReport?.(); } catch { /* 同上 */ }
      sampler.stop();
    };
  }, 'dsh-vram-watch');
}
