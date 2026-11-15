/**
 * 报告生成：把采样窗口变成「四段结论」，判读规则沿用 vram-watch 技能
 * （阈值见 docs 与 README，改这里要同步 CHANGELOG）。
 * 输出是给人看的文本，也是 agent 读的结论；不返回原始行。
 */
import { formatTime } from './buffer.js';

const fmt = (n) => (n === null || n === undefined ? '-' : Math.round(n).toLocaleString('en-US'));
const pct = (n, total) => (total > 0 ? ` (${Math.round((n / total) * 100)}%)` : '');
const signed = (n) => {
  const v = Math.round(n);
  const body = Math.abs(v).toLocaleString('en-US');
  return v >= 0 ? `+${body}` : `-${body}`;
};

function maxOf(values) {
  let best = -Infinity;
  for (const v of values) if (typeof v === 'number' && v > best) best = v;
  return Number.isFinite(best) ? best : null;
}

export function buildReport({ samples, totalMiB = 0, top = 5, source = '' } = {}) {
  if (!Array.isArray(samples) || samples.length === 0) {
    return { ok: false, text: '', issues: [], error: '窗口内没有采样' };
  }
  const first = samples[0];
  const last = samples[samples.length - 1];
  const ded = samples.map((s) => s.ded).filter((v) => typeof v === 'number');
  const sha = samples.map((s) => s.sha).filter((v) => typeof v === 'number');
  const util = samples.map((s) => s.util).filter((v) => typeof v === 'number');
  const temp = samples.map((s) => s.temp).filter((v) => typeof v === 'number');
  const power = samples.map((s) => s.power).filter((v) => typeof v === 'number');

  const baseline = ded.length ? ded[0] : null;
  const lastDed = ded.length ? ded[ded.length - 1] : null;
  const peak = ded.length ? Math.max(...ded) : null;
  const peakSample = peak === null ? null : samples.find((s) => s.ded === peak);
  const sharedBase = sha.length ? sha[0] : null;
  const sharedPeak = sha.length ? Math.max(...sha) : null;
  const sharedDelta = sharedBase === null || sharedPeak === null ? 0 : sharedPeak - sharedBase;

  const procStats = new Map();
  for (const s of samples) {
    for (const [name, mib] of Object.entries(s.procs || {})) {
      const st = procStats.get(name) || { name, first: mib, last: mib, max: mib, lastSeen: s.t, count: 0 };
      st.last = mib;
      st.max = Math.max(st.max, mib);
      st.lastSeen = s.t;
      st.count += 1;
      procStats.set(name, st);
    }
  }
  const procList = [...procStats.values()]
    .map((st) => ({ ...st, delta: st.last - st.first, running: st.lastSeen.getTime() === last.t.getTime() }))
    // 先按增量排（谁在涨），增量相同再按峰值排（谁本来就大），否则全 +0 时列表会随机。
    .sort((a, b) => (b.delta - a.delta) || (b.max - a.max));
  const topGrow = procList[0] || null;
  const topUse = [...procList].sort((a, b) => b.max - a.max)[0] || null;

  const issues = [];
  if (totalMiB > 0 && peak !== null && peak > 0.95 * totalMiB) {
    issues.push(`显存峰值 ${fmt(peak)} MiB，已占 ${Math.round((peak / totalMiB) * 100)}%，接近打满`);
  }
  if (sharedDelta > 300) {
    issues.push(`共享显存比基线涨了 ${fmt(sharedDelta)} MiB：WDDM 已往系统内存溢出，随后可能卡顿/OOM`);
  }
  if (baseline !== null && lastDed !== null && lastDed - baseline > 300) {
    issues.push(`窗口结束时专用显存仍比基线高 ${fmt(lastDed - baseline)} MiB：进程没完全释放（仍开着或缓存驻留）`);
  }
  if (topGrow && topGrow.delta > 500) {
    issues.push(topGrow.running
      ? `增长最多的是 ${topGrow.name}（${signed(topGrow.delta)} MiB，仍在运行）：若持续单调上涨，考虑显存泄漏`
      : `增长最多的是 ${topGrow.name}（${signed(topGrow.delta)} MiB，已退出）：峰值后正常结束或 OOM 崩溃，末次观测的显存已由系统回收`);
  }
  if (issues.length === 0) issues.push('未发现明显异常（峰值未打满、无溢出、结束后回落）');

  const lines = [];
  lines.push('==== 显存诊断报告 ====');
  if (source) lines.push(`来源  : ${source}`);
  lines.push(`采样  : ${samples.length} 次 / ${Math.round((last.t - first.t) / 1000)} 秒（${formatTime(first.t).slice(11)} - ${formatTime(last.t).slice(11)}）`);
  if (ded.length) {
    lines.push(`显存  : 基线 ${fmt(baseline)} MiB → 峰值 ${fmt(peak)} MiB${pct(peak, totalMiB)}${peakSample ? ` @ ${formatTime(peakSample.t).slice(11)}` : ''} → 末值 ${fmt(lastDed)} MiB`);
  } else {
    lines.push('显存  : 无 PDH 数据（采样器拿不到 GPU 性能计数器）');
  }
  if (sha.length) lines.push(`共享  : 基线 ${fmt(sharedBase)} MiB → 峰值 ${fmt(sharedPeak)} MiB（${signed(sharedDelta)} MiB）`);
  if (util.length) lines.push(`GPU   : 峰值 ${fmt(maxOf(util))}% · 均值 ${fmt(util.reduce((a, b) => a + b, 0) / util.length)}%`);
  if (temp.length) lines.push(`温度  : 峰值 ${fmt(maxOf(temp))}°C`);
  if (power.length) lines.push(`功耗  : 峰值 ${fmt(maxOf(power))} W`);

  if (procList.length) {
    lines.push('');
    lines.push('进程显存（首次 → 末次，峰值）:');
    for (const st of procList.slice(0, Math.max(1, top))) {
      const status = st.running ? '仍在' : '已退出';
      lines.push(`  ${st.name.padEnd(24).slice(0, 24)} ${fmt(st.first)} → ${fmt(st.last)} MiB（${signed(st.delta)}，峰 ${fmt(st.max)}）  ${status}`);
    }
  }

  lines.push('');
  lines.push('判断:');
  for (const issue of issues) lines.push(`  - ${issue}`);

  return { ok: true, text: lines.join('\n'), issues };
}
