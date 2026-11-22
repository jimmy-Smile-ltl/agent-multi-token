// @ts-check
/**
 * `session.js` 的纯函数部分——重点是 `unresolvedBlocker()`（§2.4 的第二道启动闸门）。
 *
 * 为什么值得单独一组用例：它守的是一个**静默失败**。`unresolved` 非空时若放行，
 * claude 会带着半个环境起来——少了 `ANTHROPIC_BASE_URL` 就悄悄退回一方端点、
 * 却仍拿着中转站的 token。这种故障不会报错，只会"说不清为什么不通"，
 * 正是 §2.4 点名要避免的那一类。所以这里逐条锁死"非空必须拦"。
 *
 * `prepareSession()` 本身不在这里测：它要真配置，`cli-resolve.test.js` /
 * `cli-commands.test.js` 的端到端夹具已经是它的更好归宿。
 */
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import { CmtError, EXIT } from '../src/core/errors.js';
import { claudePrintMode, cwdTail, unresolvedBlocker } from '../src/cli/session.js';

describe('unresolvedBlocker —— 空则放行（§2.4）', () => {
  test('unresolved 是空数组 → null', () => {
    assert.equal(unresolvedBlocker({ unresolved: [] }), null);
  });

  test('没有 unresolved 这个字段 → null（别对形状太挑剔）', () => {
    assert.equal(unresolvedBlocker({ env: {} }), null);
    assert.equal(unresolvedBlocker(undefined), null);
  });
});

describe('unresolvedBlocker —— 非空必须拦下（§2.4）', () => {
  test('★ 一条就够拦：消息里指名 envVar 与原因，退出码 1', () => {
    const err = unresolvedBlocker({
      unresolved: [{ envVar: 'ANTHROPIC_BASE_URL', reason: '不支持的 ${...} 写法："https://${H}/v1"' }],
    });

    assert.ok(err instanceof CmtError, '必须是 CmtError，CLI 层才认');
    assert.equal(err.code, EXIT.USER, '这是用户配置错，不是环境缺东西');
    assert.match(err.message, /ANTHROPIC_BASE_URL/);
    assert.match(err.message, /不支持的/);
  });

  test('★ hint 必须点破"只认整串引用"——这才是真正要改的地方', () => {
    const err = /** @type {CmtError} */ (
      unresolvedBlocker({ unresolved: [{ envVar: 'ANTHROPIC_AUTH_TOKEN', reason: 'x' }] })
    );
    assert.match(err.hint, /整串引用/);
    // 诊断入口要给出来：拦下之后用户总得知道去哪看全貌
    assert.match(err.hint, /cmt resolve/);
    assert.match(err.hint, /cmt run --print/);
  });

  test('多条时逐条列出，且条数对得上', () => {
    const err = /** @type {CmtError} */ (
      unresolvedBlocker({
        unresolved: [
          { envVar: 'ANTHROPIC_AUTH_TOKEN', reason: '不支持的 ${...} 写法："sk-${K}"' },
          { envVar: 'ANTHROPIC_BASE_URL', reason: '没有任何一层提供 baseUrl' },
        ],
      })
    );
    assert.match(err.message, /2 项/);
    assert.match(err.message, /ANTHROPIC_AUTH_TOKEN/);
    assert.match(err.message, /ANTHROPIC_BASE_URL/);
  });

  test('返回值是"可直接 throw"的错误，而不是布尔——调用方只写两行', () => {
    const err = unresolvedBlocker({ unresolved: [{ envVar: 'X', reason: 'y' }] });
    assert.throws(
      () => {
        if (err) throw err;
      },
      (e) => e instanceof CmtError && /X/.test(e.message),
    );
  });
});

describe('claudePrintMode —— 只看 claude 的 --print / -p（§2.5）', () => {
  test('--print / -p 都认', () => {
    assert.equal(claudePrintMode(['--print']), true);
    assert.equal(claudePrintMode(['-p']), true);
    assert.equal(claudePrintMode(['--verbose', '-p']), true);
  });

  test('没有就是 false；cmt 自己的 --print 不在 rest 里，不该被这里看见', () => {
    assert.equal(claudePrintMode([]), false);
    assert.equal(claudePrintMode(['--verbose']), false);
  });
});

describe('cwdTail —— 窗口标题用（§2.9）', () => {
  test('取最后一段，且能容忍两种分隔符与尾部分隔符', () => {
    assert.equal(cwdTail('/home/t/work/client-a'), 'client-a');
    assert.equal(cwdTail('C:\\Users\\t\\proj'), 'proj');
    assert.equal(cwdTail('/home/t/work/'), 'work');
  });

  test('拿不出末段时原样返回，不返回空串（标题里空一段很难看）', () => {
    assert.equal(cwdTail('/'), '/');
  });
});
