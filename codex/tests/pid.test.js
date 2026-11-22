// @ts-check
/**
 * `platform/pid.js` 的单测。
 *
 * 大部分用**注入的假 kill** 钉判据（ESRCH / EPERM / 其它错误），
 * 另有一条端到端用真 `process.kill` 验"死进程判死"。
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { describe, test } from 'node:test';

import { isPidAlive } from '../src/platform/pid.js';

describe('isPidAlive：判据（假 kill）', () => {
  test('kill 不抛 → 活', () => {
    assert.equal(isPidAlive(1234, { kill: () => true }), true);
  });

  test('ESRCH → 死', () => {
    const kill = () => {
      const err = new Error('no such process');
      // @ts-expect-error 测试构造
      err.code = 'ESRCH';
      throw err;
    };
    assert.equal(isPidAlive(1234, { kill }), false);
  });

  test('EPERM → 活（没权限不等于不存在）', () => {
    const kill = () => {
      const err = new Error('operation not permitted');
      // @ts-expect-error 测试构造
      err.code = 'EPERM';
      throw err;
    };
    assert.equal(isPidAlive(1234, { kill }), true);
  });

  test('其它错误码 → 死（说不清就当死）', () => {
    const kill = () => {
      const err = new Error('invalid');
      // @ts-expect-error 测试构造
      err.code = 'EINVAL';
      throw err;
    };
    assert.equal(isPidAlive(1234, { kill }), false);
  });

  test('非法 pid 一律死，且根本不调 kill', () => {
    let called = 0;
    const kill = () => {
      called += 1;
      return true;
    };
    for (const pid of [0, -1, 1.5, NaN, /** @type {any} */ ('123')]) {
      assert.equal(isPidAlive(pid, { kill }), false, String(pid));
    }
    assert.equal(called, 0);
  });
});

describe('isPidAlive：端到端（真 process.kill）', () => {
  test('本进程自己 → 活', () => {
    assert.equal(isPidAlive(process.pid), true);
  });

  test('已退出的子进程 → 死', () => {
    const child = spawnSync(process.execPath, ['-e', '']);
    assert.equal(typeof child.pid, 'number');
    assert.equal(isPidAlive(/** @type {number} */ (child.pid)), false);
  });
});
