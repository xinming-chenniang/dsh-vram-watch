import test from 'node:test';
import assert from 'node:assert/strict';
import { RingBuffer, normalizeSample, parseTime, formatTime } from '../lib/buffer.js';

const at = (hhmmss) => {
  const [h, m, s] = hhmmss.split(':').map(Number);
  return new Date(2026, 10, 15, h, m, s);
};
const sample = (time, extra = {}) => normalizeSample({ t: formatTime(at(time)), ded: 1000, sha: 100, smi: 900, util: 10, temp: 40, power: 50, procs: { python: 500 }, pdh: true, ...extra });

test('parseTime 解析本地时间串，拒绝垃圾输入', () => {
  const d = parseTime('2026-11-15 14:20:30');
  assert.equal(d.getFullYear(), 2026);
  assert.equal(d.getMonth(), 10);
  assert.equal(d.getHours(), 14);
  assert.equal(parseTime('not a time'), null);
  assert.equal(parseTime(''), null);
});

test('normalizeSample 丢掉没有时间的行，procs 数值化', () => {
  assert.equal(normalizeSample({}), null);
  const s = normalizeSample({ t: '2026-11-15 10:00:00', procs: { python: '512', bad: 'x' } });
  assert.deepEqual(s.procs, { python: 512 });
  assert.equal(s.ded, null);
});

test('window 只返回窗口内的样本', () => {
  const buf = new RingBuffer({ maxMinutes: 60 });
  for (let i = 0; i < 10; i += 1) buf.push(sample(`10:0${i}:00`));
  const w = buf.window(3, at('10:09:30'));
  assert.equal(w.length, 3);
  assert.deepEqual(w.map((s) => formatTime(s.t).slice(-8)), ['10:07:00', '10:08:00', '10:09:00']);
  assert.equal(buf.window(0, at('10:09:30')).length, 10);
});

test('prune 按 maxMinutes 丢掉过期样本，spanSeconds 不为负', () => {
  const buf = new RingBuffer({ maxMinutes: 5 });
  buf.push(sample('10:00:00'));
  buf.push(sample('10:10:00'));
  // push 的 prune 用真实时间，所以这里显式按 10:10 裁一次
  buf.prune(at('10:10:00'));
  assert.equal(buf.size, 1);
  assert.equal(buf.spanSeconds, 0);
  assert.equal(buf.last.t.getHours(), 10);
});
