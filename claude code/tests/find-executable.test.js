// @ts-check
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import {
  DEFAULT_PATHEXT,
  executableCandidates,
  findExecutable,
} from '../src/platform/find-executable.js';

/** 造一个"哪些路径存在"的假探针 */
const probeOf = (...existing) => {
  const set = new Set(existing);
  return (/** @type {string} */ p) => set.has(p);
};

const winEnv = { PATH: 'C:\\Windows\\system32;C:\\Program Files\\nodejs' };
const posixEnv = { PATH: '/usr/local/bin:/usr/bin:/bin' };

describe('executableCandidates —— POSIX', () => {
  test('PATH 拆 : ，每个目录一个候选，顺序即优先级', () => {
    assert.deepEqual(executableCandidates('claude', { platform: 'linux', env: posixEnv }), [
      '/usr/local/bin/claude',
      '/usr/bin/claude',
      '/bin/claude',
    ]);
  });

  test('macOS 同样规则（不是 Windows）', () => {
    assert.deepEqual(
      executableCandidates('claude', { platform: 'darwin', env: { PATH: '/opt/homebrew/bin' } }),
      ['/opt/homebrew/bin/claude'],
    );
  });

  test('空段（规范上表示当前目录）被跳过——不在 cwd 里找可执行文件', () => {
    const c = executableCandidates('claude', { platform: 'linux', env: { PATH: ':/usr/bin::/bin' } });
    assert.deepEqual(c, ['/usr/bin/claude', '/bin/claude']);
    assert.ok(!c.some((p) => p.startsWith('./') || p.startsWith('claude')));
  });

  test('PATH 没设 → 没有候选（不抛）', () => {
    assert.deepEqual(executableCandidates('claude', { platform: 'linux', env: {} }), []);
  });
});

describe('executableCandidates —— Windows', () => {
  test('PATH 拆 ; ，每个目录 × PATHEXT 各扩展名', () => {
    const c = executableCandidates('claude', { platform: 'win32', env: winEnv });
    assert.deepEqual(c.slice(0, 4), [
      'C:\\Windows\\system32\\claude.com',
      'C:\\Windows\\system32\\claude.exe',
      'C:\\Windows\\system32\\claude.bat',
      'C:\\Windows\\system32\\claude.cmd',
    ]);
    assert.equal(c.length, 8); // 2 个目录 × 4 个扩展名
  });

  test('PATHEXT 来自环境，没配才用兜底', () => {
    const c = executableCandidates('claude', {
      platform: 'win32',
      env: { ...winEnv, PATHEXT: '.EXE;.CMD' },
    });
    assert.deepEqual(c, [
      'C:\\Windows\\system32\\claude.exe',
      'C:\\Windows\\system32\\claude.cmd',
      'C:\\Program Files\\nodejs\\claude.exe',
      'C:\\Program Files\\nodejs\\claude.cmd',
    ]);
    assert.equal(DEFAULT_PATHEXT, '.COM;.EXE;.BAT;.CMD');
  });

  test('名字自带扩展名 → 不再叠加（别拼出 claude.exe.exe）', () => {
    assert.deepEqual(executableCandidates('claude.exe', { platform: 'win32', env: winEnv }), [
      'C:\\Windows\\system32\\claude.exe',
      'C:\\Program Files\\nodejs\\claude.exe',
    ]);
  });

  test('PATH 里带引号的整段会被剥掉引号（Windows 上很常见）', () => {
    const c = executableCandidates('claude', {
      platform: 'win32',
      env: { PATH: '"C:\\Program Files\\nodejs";C:\\bin' },
    });
    assert.ok(c.includes('C:\\Program Files\\nodejs\\claude.exe'));
    assert.ok(!c.some((p) => p.includes('"')));
  });
});

describe('executableCandidates —— 已经是路径就不翻 PATH', () => {
  test('含 / 或 \\ → 原样返回', () => {
    assert.deepEqual(executableCandidates('./node', { platform: 'linux', env: posixEnv }), ['./node']);
    assert.deepEqual(
      executableCandidates('/opt/x/node', { platform: 'linux', env: posixEnv }),
      ['/opt/x/node'],
    );
    assert.deepEqual(
      executableCandidates('C:\\nodejs\\node.exe', { platform: 'win32', env: winEnv }),
      ['C:\\nodejs\\node.exe'],
    );
    // POSIX 上反斜杠是合法文件名字符，不该被当路径分隔符
    assert.deepEqual(executableCandidates('a\\b', { platform: 'linux', env: posixEnv }), [
      '/usr/local/bin/a\\b',
      '/usr/bin/a\\b',
      '/bin/a\\b',
    ]);
  });
});

describe('findExecutable', () => {
  test('返回第一个命中的绝对路径（PATH 靠前的赢）', () => {
    const p = findExecutable('claude', {
      platform: 'linux',
      env: posixEnv,
      probe: probeOf('/usr/bin/claude', '/bin/claude'),
    });
    assert.equal(p, '/usr/bin/claude');
  });

  test('都找不到 → null', () => {
    assert.equal(
      findExecutable('claude', { platform: 'linux', env: posixEnv, probe: () => false }),
      null,
    );
  });

  test('Windows 命中 .cmd 也能找到（这就是 claude 的常见装法）', () => {
    const p = findExecutable('claude', {
      platform: 'win32',
      env: winEnv,
      probe: probeOf('C:\\Program Files\\nodejs\\claude.cmd'),
    });
    assert.equal(p, 'C:\\Program Files\\nodejs\\claude.cmd');
  });

  test('★ 三平台规则在任意宿主机上都能跑（§6.3）', () => {
    // 同一个假探针 + 三份不同的 platform/env → 三份不同形状的答案，
    // 全程不依赖宿主是 Windows 还是 Linux
    const exists = probeOf('/usr/local/bin/node', 'C:\\nodejs\\node.exe');
    assert.equal(
      findExecutable('node', { platform: 'linux', env: posixEnv, probe: exists }),
      '/usr/local/bin/node',
    );
    assert.equal(
      findExecutable('node', { platform: 'win32', env: { PATH: 'C:\\nodejs' }, probe: exists }),
      'C:\\nodejs\\node.exe',
    );
    assert.equal(
      findExecutable('node', { platform: 'darwin', env: { PATH: '/nope' }, probe: exists }),
      null,
    );
  });
});
