import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { apply, name, VERSION } from '../lib/index.js';

function fakeCtx() {
  const registered = [];
  let dispose = null;
  const ctx = {
    logger: { info() {} },
    get: (key) => (key === 'tools' ? { register: (desc) => { registered.push(desc); return () => {}; } } : undefined),
    effect: (fn) => { dispose = fn(); return () => dispose?.(); },
  };
  return { ctx, registered, dispose: () => dispose?.() };
}

test('插件名与版本', () => {
  assert.equal(name, 'dsh-vram-watch');
  assert.match(VERSION, /^\d+\.\d+\.\d+$/);
});

test('apply 注册 vram_watch 与 vram_report 两个工具', () => {
  const { ctx, registered, dispose } = fakeCtx();
  apply(ctx, { autoStart: false });
  assert.deepEqual(registered.map((t) => t.name).sort(), ['vram_report', 'vram_watch']);
  for (const tool of registered) {
    assert.equal(typeof tool.execute, 'function');
    assert.equal(tool.parameters.type, 'object');
    assert.equal(typeof tool.output.render, 'function');
  }
  dispose();
});

test('vram_watch status 在未启动时说明未运行', async () => {
  const { ctx, registered, dispose } = fakeCtx();
  apply(ctx, { autoStart: false });
  const watch = registered.find((t) => t.name === 'vram_watch');
  const res = await watch.execute({ action: 'status' });
  assert.equal(res.ok, true);
  assert.equal(res.running, false);
  assert.match(res.text, /未运行/);
  dispose();
});

test('vram_report 能直接读 CSV 给出结论', async () => {
  const file = path.join(os.tmpdir(), `vram-watch-test-${process.pid}.csv`);
  fs.writeFileSync(file, [
    'time,dedicated_MiB,shared_MiB,smi_used_MiB,gpu_util_pct,temp_C,power_W,proc,MiB',
    '2026-11-15 20:00:00,1500,160,1400,20,40,60,__TOTAL__,1500',
    '2026-11-15 20:00:00,1500,160,1400,20,40,60,python,1200',
    '2026-11-15 20:01:00,8000,900,7900,99,78,190,__TOTAL__,8000',
    '2026-11-15 20:01:00,8000,900,7900,99,78,190,python,7600',
  ].join('\n'), 'utf8');
  try {
    const { ctx, registered, dispose } = fakeCtx();
    apply(ctx, { autoStart: false });
    const report = registered.find((t) => t.name === 'vram_report');
    const res = await report.execute({ csv: file, top: 3 });
    assert.equal(res.ok, true);
    assert.match(res.text, /显存峰值 8,000 MiB/);
    assert.match(res.text, /接近打满/);
    assert.match(res.text, /python/);
  } finally {
    fs.rmSync(file, { force: true });
  }
});

test('vram_report 在空缓冲时报错而不是编数字', async () => {
  const { ctx, registered, dispose } = fakeCtx();
  apply(ctx, { autoStart: false });
  const report = registered.find((t) => t.name === 'vram_report');
  const res = await report.execute({});
  assert.equal(res.ok, false);
  assert.match(res.error, /没有采样/);
  dispose();
});

test('非 Windows 上启动采样器返回明确错误', async () => {
  if (process.platform === 'win32') return;
  const { ctx, registered, dispose } = fakeCtx();
  apply(ctx, { autoStart: false });
  const watch = registered.find((t) => t.name === 'vram_watch');
  const res = await watch.execute({ action: 'start' });
  assert.equal(res.running, false);
  assert.match(res.error, /仅支持 Windows/);
  dispose();
});
