import test from 'node:test';
import assert from 'node:assert/strict';
import { toCsv, parseCsv, CSV_HEADER } from '../lib/csv.js';
import { normalizeSample, formatTime } from '../lib/buffer.js';

const mk = ({ ded = 1000, sha = 100, smi = 950, util = 20, temp = 45, power = 80, procs = {} } = {}) => normalizeSample({
  t: formatTime(new Date(2026, 10, 15, 12, 0, 0)),
  ded, sha, smi, util, temp, power, procs, pdh: true,
});

test('toCsv 写技能兼容表头，每次采样一行 __TOTAL__ 加每进程一行', () => {
  const s = mk({ procs: { python: 500, chrome: 120 } });
  const text = toCsv([s]);
  const lines = text.trim().split('\n');
  assert.equal(lines[0], CSV_HEADER);
  assert.equal(lines.length, 4);
  assert.match(lines[1], /__TOTAL__/);
  assert.match(lines[2], /^(?:.*),python,500$/m);
  assert.match(lines[3], /^(?:.*),chrome,120$/m);
});

test('parseCsv 往返：整卡字段与进程名还原', () => {
  const s = mk({ procs: { python: 500, chrome: 120 } });
  const { samples } = parseCsv(toCsv([s]));
  assert.equal(samples.length, 1);
  assert.equal(samples[0].ded, 1000);
  assert.equal(samples[0].sha, 100);
  assert.equal(samples[0].util, 20);
  assert.deepEqual(samples[0].procs, { python: 500, chrome: 120 });
});

test('parseCsv 能读技能脚本产出的 CSV（同列名）', () => {
  const text = [
    'time,dedicated_MiB,shared_MiB,smi_used_MiB,gpu_util_pct,temp_C,power_W,proc,MiB',
    '2026-11-07 20:36:44,1503,162,1434,22,33,14.86,__TOTAL__,1503',
    '2026-11-07 20:36:44,1503,162,1434,22,33,14.86,python,7771',
    '2026-11-07 20:36:46,1600,200,1500,55,40,80,__TOTAL__,1600',
    '2026-11-07 20:36:46,1600,200,1500,55,40,80,python,1200',
  ].join('\n');
  const { samples } = parseCsv(text);
  assert.equal(samples.length, 2);
  assert.equal(samples[0].ded, 1503);
  assert.equal(samples[0].procs.python, 7771);
  assert.equal(samples[1].sha, 200);
});

test('parseCsv 拒绝非本工具的 CSV', () => {
  assert.throws(() => parseCsv('a,b\n1,2'), /缺列/);
  assert.throws(() => parseCsv('time,proc,MiB\n'), /没有可用的采样行/);
});
