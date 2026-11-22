// @ts-check
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { join, basename } from 'node:path';

import {
  APP_DIR_NAME,
  claudeFallbackPaths,
  configBackupPath,
  configPath,
  DEFAULT_PROFILE_NAME,
  expandTilde,
  launchScriptPath,
  profileDir,
  profileNameFor,
  profilesDir,
  rootDir,
  sessionDir,
  sessionInboxDir,
  sessionMetaPath,
  sessionReadDir,
  sessionsDir,
  tokenPath,
  tokensDir,
} from '../src/core/paths.js';
import { validateTokenName } from '../src/core/schema.js';

const HOME = process.platform === 'win32' ? 'C:\\Users\\tester' : '/home/tester';

describe('paths 布局（§2.8）', () => {
  test('根目录挂在 home 下', () => {
    assert.equal(basename(rootDir(HOME)), APP_DIR_NAME);
  });

  test('config.json 在根目录', () => {
    assert.equal(configPath(HOME), join(rootDir(HOME), 'config.json'));
  });

  test('版本备份名带旧版本号（§3.5）', () => {
    assert.equal(basename(configBackupPath(HOME, 1)), 'config.json.v1.bak');
  });

  test('token 文件名 = token 名 + .json', () => {
    assert.equal(tokenPath(HOME, 'relay-a'), join(tokensDir(HOME), 'relay-a.json'));
  });

  test('profile 目录只按 token 命名——不带 cwd（§2.8 铁律）', () => {
    const p = profileDir(HOME, 'relay-a');
    assert.equal(p, join(profilesDir(HOME), 'relay-a'));
    assert.equal(basename(p), 'relay-a');
  });
});

describe('launchScriptPath', () => {
  test('Windows 用 .cmd，其余用 .sh（§2.10）', () => {
    assert.equal(basename(launchScriptPath(HOME, 't', 'win32')), 'launch.cmd');
    assert.equal(basename(launchScriptPath(HOME, 't', 'darwin')), 'launch.sh');
    assert.equal(basename(launchScriptPath(HOME, 't', 'linux')), 'launch.sh');
  });

  test('整条路径按**目标平台**拼，不只是扩展名（§6.3）', () => {
    // Linux 目标：正斜杠 + /home/tester 前缀，哪怕宿主是 Windows
    assert.equal(
      launchScriptPath('/home/tester', 't', 'linux'),
      '/home/tester/.claude-multi-token/profiles/t/launch.sh',
    );
    // Windows 目标：反斜杠 + 盘符前缀，哪怕宿主是 Linux
    assert.equal(
      launchScriptPath('C:\\Users\\tester', 't', 'win32'),
      'C:\\Users\\tester\\.claude-multi-token\\profiles\\t\\launch.cmd',
    );
  });

  test('与本机 profileDir 落在同一处（真实运行时 host === target）', () => {
    // 本机平台下两者必须一致——否则脚本会被写到 profile 外面去
    const p = launchScriptPath(HOME, 't', process.platform);
    assert.ok(
      p.startsWith(profileDir(HOME, 't')),
      `${p} 应落在 ${profileDir(HOME, 't')} 内`,
    );
  });
});

describe('claudeFallbackPaths —— 按目标平台算（§6.3 单机全平台可测）', () => {
  test('Windows 分支在任意宿主上都产出 Windows 形状', () => {
    const win = claudeFallbackPaths('C:\\Users\\t', 'win32');
    assert.ok(win.some((p) => p.endsWith('claude.exe')));
    assert.ok(win.some((p) => p.includes('AppData')));
    // 关键：分隔符是 `\`，且没有把 home 的盘符吃掉
    for (const p of win) {
      assert.ok(p.startsWith('C:\\Users\\t'), `应保留 Windows home 前缀：${p}`);
      assert.ok(!p.includes('/'), `Windows 分支不该出现正斜杠：${p}`);
    }
  });

  test('POSIX 分支在 Windows 宿主上依然产出 POSIX 形状', () => {
    const posix = claudeFallbackPaths('/home/t', 'linux');
    assert.ok(posix.includes('/home/t/.local/bin/claude'));
    assert.ok(posix.includes('/usr/local/bin/claude'));
    for (const p of posix) {
      assert.ok(!p.includes('\\'), `POSIX 分支不该出现反斜杠：${p}`);
    }
  });

  test('macOS 分支与 Linux 同形（都走 POSIX 规则）', () => {
    assert.deepEqual(
      claudeFallbackPaths('/Users/t', 'darwin'),
      claudeFallbackPaths('/Users/t', 'linux'),
    );
  });
});

describe('expandTilde —— 按目标平台拼（规则 2）', () => {
  test('只展开开头的 ~', () => {
    assert.equal(expandTilde('~', HOME, 'win32'), HOME);
    assert.equal(expandTilde('~/work', HOME, 'win32'), join(HOME, 'work'));
    assert.equal(expandTilde('~\\work', HOME, 'win32'), join(HOME, 'work'));
  });

  test('中间的 ~ 是普通字符', () => {
    assert.equal(expandTilde('D:/a~b/c', HOME, 'win32'), 'D:/a~b/c');
    assert.equal(expandTilde('~user/work', HOME, 'win32'), '~user/work');
  });

  test('绝对路径原样返回', () => {
    assert.equal(expandTilde('D:/work', HOME, 'win32'), 'D:/work');
    assert.equal(expandTilde('/srv/x', HOME, 'linux'), '/srv/x');
  });

  test('★ 目标平台说了算，不借宿主的 join', () => {
    // 这条是回归护栏：曾经用宿主 join，Linux 路径在 Windows 上被拼成 `\home\t\proj`
    assert.equal(expandTilde('~/proj', '/home/t', 'linux'), '/home/t/proj');
    assert.equal(expandTilde('~/proj', 'C:\\Users\\t', 'win32'), 'C:\\Users\\t\\proj');
  });
});

describe('profileNameFor —— 纯 defaults 模式的落点（§2.3）', () => {
  test('有 token 就用 token 名', () => {
    assert.equal(profileNameFor('relay-a'), 'relay-a');
  });

  test('没有 token → _default', () => {
    assert.equal(profileNameFor(null), DEFAULT_PROFILE_NAME);
    assert.equal(profileNameFor(undefined), DEFAULT_PROFILE_NAME);
  });

  test('★ _default 不可能是合法 token 名——否则会撞车', () => {
    // 跨模块不变量：paths 挑的名字必须落在 schema 的合法集**之外**
    assert.throws(() => validateTokenName(DEFAULT_PROFILE_NAME), /token 名不合法/);
  });
});

describe('sessions 目录布局（§2.14）', () => {
  test('★ sessions/ 挂在根目录下，与 profiles/<t>/sessions/ 是两条不同的路', () => {
    // 回归护栏：同名不同物——一个是本工具的在场层，一个是 Claude Code 的会话历史。
    assert.equal(sessionsDir(HOME), join(rootDir(HOME), 'sessions'));
    assert.notEqual(sessionsDir(HOME), join(profilesDir(HOME), 'relay-a', 'sessions'));
  });

  test('会话目录与三个文件路径', () => {
    assert.equal(sessionDir(HOME, 'relay-a-m1-1'), join(sessionsDir(HOME), 'relay-a-m1-1'));
    assert.equal(sessionMetaPath(HOME, 'relay-a-m1-1'), join(sessionDir(HOME, 'relay-a-m1-1'), 'meta.json'));
    assert.equal(basename(sessionInboxDir(HOME, 'relay-a-m1-1')), 'inbox');
    assert.equal(basename(sessionReadDir(HOME, 'relay-a-m1-1')), 'read');
  });
});
