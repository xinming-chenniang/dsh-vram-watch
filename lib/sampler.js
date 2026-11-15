/**
 * 采样器管理：长驻一个 powershell 进程，逐行收 JSON 样本，进环形缓冲。
 *
 * 为什么是长驻进程而不是每次 spawn：PDH 查询（Get-Counter）每次约 1 秒，
 * 每次 spawn powershell 还要再加 0.3~1 秒；长驻后开着就只付采样本身的成本。
 * 实测见 lib/sampler.ps1 顶部注释。
 */
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { RingBuffer, normalizeSample } from './buffer.js';
import { toCsv } from './csv.js';

const SCRIPT = fileURLToPath(new URL('./sampler.ps1', import.meta.url));

function powershellPath(preferred) {
  if (preferred) return preferred;
  if (process.platform !== 'win32') return 'pwsh';
  const systemRoot = process.env.SystemRoot || 'C:\\Windows';
  const winPs = path.join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  return fs.existsSync(winPs) ? winPs : 'powershell.exe';
}

export class Sampler extends EventEmitter {
  constructor({
    intervalSec = 2,
    pdhEverySec = 20,
    bufferMinutes = 60,
    powershell = '',
    logger = null,
  } = {}) {
    super();
    this.intervalSec = clamp(intervalSec, 1, 60, 2);
    this.pdhEverySec = clamp(pdhEverySec, 5, 600, 20);
    this.powershell = powershellPath(powershell);
    this.buffer = new RingBuffer({ maxMinutes: bufferMinutes });
    this.logger = logger;
    this.child = null;
    this.reader = null;
    this.stopping = false;
    this.restarts = 0;
    this.totalMiB = 0;
    this.meta = null;
    this.error = '';
    this.startedAt = null;
    this.stderrTail = [];
  }

  get running() {
    return Boolean(this.child);
  }

  start() {
    if (this.child) return this.status();
    if (process.platform !== 'win32') {
      this.error = '仅支持 Windows（GPU 性能计数器走 WDDM/PDH）';
      this.emit('state');
      return this.status();
    }
    this.stopping = false;
    this.error = '';
    this.stderrTail = [];
    let child;
    try {
      child = spawn(this.powershell, [
        '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
        '-File', SCRIPT,
        '-Interval', String(this.intervalSec),
        '-PdhEvery', String(this.pdhEverySec),
      ], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (error) {
      this.error = `启动采样器失败：${error?.message || error}`;
      this.emit('state');
      return this.status();
    }

    this.child = child;
    this.startedAt = new Date();
    this.reader = createInterface({ input: child.stdout });
    this.reader.on('line', (line) => this.#handleLine(line));
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk) => {
      const text = String(chunk).trim();
      if (!text) return;
      this.stderrTail.push(text);
      if (this.stderrTail.length > 20) this.stderrTail.shift();
    });
    child.on('error', (error) => {
      this.error = `采样器进程错误：${error?.message || error}`;
    });
    child.on('exit', (code) => {
      this.#cleanupChild();
      if (this.stopping) {
        this.emit('state');
        return;
      }
      if (this.restarts < 2) {
        this.restarts += 1;
        this.error = `采样器退出（code=${code}），正在重启（${this.restarts}/2）`;
        setTimeout(() => { if (!this.stopping) this.start(); }, 2000);
      } else {
        this.error = `采样器反复退出（code=${code}），已停止。stderr: ${this.stderrTail.slice(-2).join(' | ')}`;
      }
      this.emit('state');
    });

    this.emit('state');
    return this.status();
  }

  #handleLine(line) {
    const text = line.trim();
    if (!text.startsWith('{')) return;
    let payload;
    try {
      payload = JSON.parse(text);
    } catch {
      return; // 坏行（半截写入/编码问题）不影响后续采样
    }
    if (payload?.type === 'meta') {
      this.meta = payload;
      this.totalMiB = Number(payload.total) || 0;
      this.emit('state');
      return;
    }
    if (payload?.type !== 's') return;
    const sample = normalizeSample(payload);
    if (sample && this.buffer.push(sample)) this.emit('sample', sample);
  }

  #cleanupChild() {
    try { this.reader?.close(); } catch { /* 已经关了 */ }
    this.reader = null;
    this.child = null;
  }

  stop() {
    this.stopping = true;
    const child = this.child;
    this.#cleanupChild();
    if (child) {
      try { child.kill(); } catch { /* 已经退出 */ }
    }
    this.emit('state');
    return this.status();
  }

  window(minutes = 0) {
    return this.buffer.window(minutes);
  }

  writeCsv(file, minutes = 0) {
    const samples = this.window(minutes);
    if (!samples.length) throw new Error('窗口内没有采样，无法写 CSV');
    fs.mkdirSync(path.dirname(path.resolve(file)), { recursive: true });
    fs.writeFileSync(file, toCsv(samples), 'utf8');
    return { file, samples: samples.length };
  }

  status() {
    const last = this.buffer.last;
    return {
      running: this.running,
      startedAt: this.startedAt ? this.startedAt.toISOString() : null,
      samples: this.buffer.size,
      spanSeconds: this.buffer.spanSeconds,
      totalMiB: this.totalMiB,
      intervalSec: this.intervalSec,
      pdhEverySec: this.pdhEverySec,
      lastSampleAt: last ? last.t.toISOString() : null,
      last: last
        ? { ded: last.ded, shared: last.sha, util: last.util, temp: last.temp, power: last.power, top: topProc(last) }
        : null,
      error: this.error,
      host: this.meta?.host || '',
    };
  }
}

function topProc(sample) {
  const entries = Object.entries(sample.procs || {}).sort((a, b) => b[1] - a[1]);
  return entries.length ? { name: entries[0][0], MiB: entries[0][1] } : null;
}

function clamp(value, min, max, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}
