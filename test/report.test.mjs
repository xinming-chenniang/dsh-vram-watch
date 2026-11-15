import test from 'node:test';
import assert from 'node:assert/strict';
import { buildReport } from '../lib/report.js';
import { normalizeSample, formatTime } from '../lib/buffer.js';

function series(count, fn) {
  return Array.from({ length: count }, (_, i) => {
    const d = new Date(2026, 10, 15, 20, 0, 0 + i * 2);
    return normalizeSample({ t: formatTime(d), pdh: true, ...fn(i) });
  });
}

test('空窗口返回 ok:false，不抛异常', () => {
  const r = buildReport({ samples: [] });
  assert.equal(r.ok, false);
  assert.match(r.error, /没有采样/);
});

test('接近打满 + 共享溢出 + 进程增长，三条判断都出现', () => {
  const samples = series(10, (i) => ({
    ded: 1500 + i * 700,
    sha: 160 + i * 120,
    smi: 1400 + i * 600,
    util: 95,
    temp: 72,
    power: 190,
    procs: { python: 100 + i * 700, chrome: 300 },
  }));
  const r = buildReport({ samples, totalMiB: 8192, top: 5, source: 'test' });
  assert.equal(r.ok, true);
  const text = r.text;
  assert.match(text, /显存峰值 7,800 MiB/);
  assert.match(text, /接近打满/);
  assert.match(text, /共享显存比基线涨了 1,080 MiB/);
  assert.match(text, /增长最多的是 python/);
  assert.match(text, /仍在运行/);
  assert.match(text, /python\s+100 → 6,400 MiB/);
});

test('进程已退出时给「已退出」措辞，不误报泄漏判断', () => {
  const samples = series(6, (i) => ({
    ded: 1500 + i * 300,
    sha: 160,
    util: 40,
    procs: i < 4 ? { python: 500 + i * 500 } : { chrome: 200 },
  }));
  const r = buildReport({ samples, totalMiB: 8192 });
  assert.match(r.text, /增长最多的是 python（\+1,500 MiB，已退出）/);
  assert.match(r.text, /常规|OOM 崩溃/);
});

test('无异常时给「未发现明显异常」', () => {
  const samples = series(5, () => ({ ded: 900, sha: 100, util: 5, procs: { chrome: 200 } }));
  const r = buildReport({ samples, totalMiB: 8192 });
  assert.deepEqual(r.issues, ['未发现明显异常（峰值未打满、无溢出、结束后回落）']);
});

test('没有 PDH 数据时显式说明，而不是给假数字', () => {
  const samples = series(3, () => ({ ded: null, sha: null, util: 10, smi: 800 }));
  const r = buildReport({ samples, totalMiB: 8192 });
  assert.match(r.text, /无 PDH 数据/);
});
