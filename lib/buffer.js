/** 采样环形缓冲：按分钟裁剪，报告只取窗口内的样本。纯函数，便于测试。 */

const TIME_RE = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})$/;

/** 解析采样器输出的本地时间串（yyyy-MM-dd HH:mm:ss），失败返回 null。 */
export function parseTime(value) {
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value;
  if (typeof value !== 'string') return null;
  const m = TIME_RE.exec(value.trim());
  if (!m) {
    const d = new Date(value);
    return Number.isNaN(d.getTime()) ? null : d;
  }
  return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4]), Number(m[5]), Number(m[6]));
}

export function formatTime(date) {
  const p = (n) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${p(date.getMonth() + 1)}-${p(date.getDate())} ${p(date.getHours())}:${p(date.getMinutes())}:${p(date.getSeconds())}`;
}

/** 把一行采样规整成内部结构；缺字段用 null，procs 统一成 {name: MiB}。 */
export function normalizeSample(raw) {
  const t = parseTime(raw?.t);
  if (!t) return null;
  const procs = {};
  if (raw?.procs && typeof raw.procs === 'object') {
    for (const [name, mib] of Object.entries(raw.procs)) {
      const n = Number(mib);
      if (!name || !Number.isFinite(n)) continue;
      procs[String(name)] = Math.round(n);
    }
  }
  const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
  return {
    t,
    ded: num(raw.ded),
    sha: num(raw.sha),
    smi: num(raw.smi),
    util: num(raw.util),
    temp: num(raw.temp),
    power: num(raw.power),
    procs,
    pdh: raw.pdh === true,
  };
}

export class RingBuffer {
  constructor({ maxMinutes = 60 } = {}) {
    this.maxMinutes = Math.max(1, Number(maxMinutes) || 60);
    this.items = [];
  }

  push(sample) {
    if (!sample || !(sample.t instanceof Date)) return false;
    this.items.push(sample);
    this.prune();
    return true;
  }

  /** 默认以「最新样本的时间」为现在：缓冲自洽，不依赖墙钟（测试与回放也一致）。 */
  prune(now = this.last?.t || new Date()) {
    const cutoff = now.getTime() - this.maxMinutes * 60_000;
    let i = 0;
    while (i < this.items.length && this.items[i].t.getTime() < cutoff) i += 1;
    if (i > 0) this.items.splice(0, i);
  }

  /** 最近 minutes 分钟的样本；minutes<=0 或未给时返回全部。 */
  window(minutes = 0, now = this.last?.t || new Date()) {
    if (!minutes || minutes <= 0) return this.items.slice();
    const cutoff = now.getTime() - minutes * 60_000;
    return this.items.filter((s) => s.t.getTime() >= cutoff);
  }

  clear() {
    this.items = [];
  }

  get size() {
    return this.items.length;
  }

  get spanSeconds() {
    if (this.items.length < 2) return 0;
    return Math.round((this.items[this.items.length - 1].t - this.items[0].t) / 1000);
  }

  get last() {
    return this.items.length ? this.items[this.items.length - 1] : null;
  }
}
