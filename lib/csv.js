/**
 * CSV 编解码。列格式与 vram-watch 技能的 vram-monitor.ps1 完全一致，
 * 这样老脚本 vram-report.ps1 / vram-chart.ps1 仍然能读本插件产出的 CSV：
 *   time,dedicated_MiB,shared_MiB,smi_used_MiB,gpu_util_pct,temp_C,power_W,proc,MiB
 * 每次采样写一行 __TOTAL__ + 每进程一行。
 */
import { formatTime, parseTime } from './buffer.js';

export const CSV_HEADER = 'time,dedicated_MiB,shared_MiB,smi_used_MiB,gpu_util_pct,temp_C,power_W,proc,MiB';

const cell = (v) => (v === null || v === undefined ? '' : String(v));

export function toCsv(samples) {
  const lines = [CSV_HEADER];
  for (const s of samples) {
    const t = formatTime(s.t);
    const base = [t, s.ded, s.sha, s.smi, s.util, s.temp, s.power];
    lines.push([...base, '__TOTAL__', s.ded].map(cell).join(','));
    for (const [name, mib] of Object.entries(s.procs || {})) {
      lines.push([...base, name, mib].map(cell).join(','));
    }
  }
  return `${lines.join('\n')}\n`;
}

/**
 * 解析本插件或 vram-monitor.ps1 的 CSV。返回 {samples, totalMiBHint}。
 * 同一时刻的 __TOTAL__ 行提供整卡字段，其余行按进程名聚合。
 */
export function parseCsv(text) {
  const rows = text.split(/\r?\n/).filter((line) => line.trim() !== '');
  if (!rows.length) throw new Error('CSV 是空的');
  const header = rows[0].split(',').map((h) => h.trim());
  const idx = {};
  header.forEach((h, i) => { idx[h] = i; });
  for (const need of ['time', 'proc', 'MiB']) {
    if (idx[need] === undefined) throw new Error(`CSV 缺列 ${need}，不是 vram-watch 的日志`);
  }

  const byTime = new Map();
  for (const line of rows.slice(1)) {
    const cells = line.split(',');
    const time = cells[idx.time]?.trim();
    const proc = cells[idx.proc]?.trim();
    const t = parseTime(time);
    if (!t || !proc) continue;
    const key = t.getTime();
    let entry = byTime.get(key);
    if (!entry) {
      entry = {
        t,
        ded: null, sha: null, smi: null, util: null, temp: null, power: null,
        procs: {}, pdh: false,
      };
      byTime.set(key, entry);
    }
    const num = (i) => {
      if (i === undefined) return null;
      const v = Number(cells[i]);
      return Number.isFinite(v) ? v : null;
    };
    if (proc === '__TOTAL__') {
      entry.ded = num(idx.dedicated_MiB);
      entry.sha = num(idx.shared_MiB);
      entry.smi = num(idx.smi_used_MiB);
      entry.util = num(idx.gpu_util_pct);
      entry.temp = num(idx.temp_C);
      entry.power = num(idx.power_W);
      entry.pdh = true;
    } else {
      const mib = num(idx.MiB);
      if (mib !== null) entry.procs[proc] = (entry.procs[proc] || 0) + mib;
    }
  }

  const samples = [...byTime.values()].sort((a, b) => a.t - b.t);
  if (!samples.length) throw new Error('CSV 里没有可用的采样行');
  const totalMiBHint = Math.max(0, ...[...byTime.values()].map((s) => s.smi || 0));
  return { samples, totalMiBHint };
}
