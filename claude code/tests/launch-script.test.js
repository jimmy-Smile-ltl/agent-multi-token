// @ts-check
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import {
  buildLaunchScript,
  cmdQuote,
  hasNonAscii,
  shQuote,
  urlCarriesCredential,
} from '../src/core/launch-script.js';

/** 一份基准入参，各测试按需覆盖字段 */
const base = {
  platform: /** @type {NodeJS.Platform} */ ('linux'),
  home: '/home/t',
  tokenName: 'relay-a',
  nodePath: '/usr/local/bin/node',
  cmtPath: '/opt/cmt/bin/cmt.js',
  model: 'deepseek-flash[1m]',
  cwd: '/home/t/work/client-a',
};

describe('转义', () => {
  test('cmdQuote：引号包裹，并把 % 写成 %%（cmd 里 % 在引号内也会展开）', () => {
    assert.equal(cmdQuote('C:\\a b\\c'), '"C:\\a b\\c"');
    assert.equal(cmdQuote('C:\\100%\\proj'), '"C:\\100%%\\proj"');
  });

  test('shQuote：单引号包裹，内部的 \' 用 \'\\\'\' 收尾重开', () => {
    assert.equal(shQuote('/home/a b'), "'/home/a b'");
    assert.equal(shQuote("/home/o'brien"), `'/home/o'\\''brien'`);
  });

  test('hasNonAscii', () => {
    assert.equal(hasNonAscii('C:\\work\\client-a'), false);
    assert.equal(hasNonAscii('C:\\工作\\项目'), true);
  });
});

describe('buildLaunchScript —— 路径', () => {
  test('.sh 落在 profiles/<token>/launch.sh', () => {
    const s = buildLaunchScript(base);
    assert.equal(s.path, '/home/t/.claude-multi-token/profiles/relay-a/launch.sh');
    assert.equal(s.mode, 0o755);
  });

  test('.cmd 落在 profiles/<token>/launch.cmd', () => {
    const s = buildLaunchScript({ ...base, platform: 'win32', home: 'C:\\Users\\t' });
    assert.equal(s.path, 'C:\\Users\\t\\.claude-multi-token\\profiles\\relay-a\\launch.cmd');
    assert.equal(s.mode, 0o644);
  });

  test('无 token（纯 defaults 模式）→ profile 用 _default，且不传 token 位置参数', () => {
    const s = buildLaunchScript({ ...base, tokenName: null });
    assert.equal(s.path, '/home/t/.claude-multi-token/profiles/_default/launch.sh');
    // 子命令 exec 之后直接跟 --model，中间没有 token 名
    assert.match(s.content, /cmt\.js' exec --model '/);
  });

  test('平台决定扩展名，而不是宿主——Windows 规格在 Linux 上也能算出来（§6.3）', () => {
    const win = buildLaunchScript({ ...base, platform: 'win32', home: 'C:\\Users\\t' });
    assert.match(win.path, /launch\.cmd$/);
    const mac = buildLaunchScript({ ...base, platform: 'darwin', home: '/Users/t' });
    assert.match(mac.path, /launch\.sh$/);
  });
});

describe('buildLaunchScript —— §2.10 四条内容契约', () => {
  test('契约 1：node 与 cmt 入口都用绝对路径，不出现裸 node', () => {
    const s = buildLaunchScript(base);
    assert.match(s.content, /^#!\/bin\/sh\n/);
    assert.match(s.content, /exec '\/usr\/local\/bin\/node' '\/opt\/cmt\/bin\/cmt\.js' exec 'relay-a'/);
  });

  test('契约 2：默认不写 cd（cwd 由终端参数传入）', () => {
    const s = buildLaunchScript(base);
    assert.doesNotMatch(s.content, /\bcd\b/);
  });

  test('契约 2 例外：needCd（终端没有 cwd 选项）才写 cd', () => {
    const sh = buildLaunchScript({ ...base, needCd: true });
    assert.match(sh.content, /cd '\/home\/t\/work\/client-a'/);
    const cmd = buildLaunchScript({
      ...base,
      platform: 'win32',
      home: 'C:\\Users\\t',
      cwd: 'C:\\Users\\t\\work\\client-a',
      needCd: true,
    });
    assert.match(cmd.content, /cd \/d "C:\\Users\\t\\work\\client-a"/);
  });

  test('契约 3：参数透传——cmd 用 %*，sh 用 "$@"，且都在 `--` 之后', () => {
    const sh = buildLaunchScript(base);
    assert.match(sh.content, / -- "\$@"\n$/);
    const cmd = buildLaunchScript({ ...base, platform: 'win32', home: 'C:\\Users\\t' });
    assert.match(cmd.content, / -- %\*\r\n$/);
    // %* 不能被 cmdQuote 转义成 %%*（那会变成字面量）
    assert.doesNotMatch(cmd.content, /%%\*/);
  });

  test('★ 透传区前必须有 `--`：否则 cmt exec 会拒收陌生选项', () => {
    // 少了它，`launch.cmd --verbose` 会死在 "未知选项 --verbose" 上——
    // 因为 cmt 自己的解析器先看到它，而它根本不是 cmt 的选项。
    for (const platform of /** @type {NodeJS.Platform[]} */ (['win32', 'linux'])) {
      const s = buildLaunchScript({
        ...base,
        cont: true,
        platform,
        home: platform === 'win32' ? 'C:\\Users\\t' : '/home/t',
      });
      assert.match(s.content, / -c -- /, `${platform}: -c 与透传区之间应有 --`);
    }
    // 不带 -c 时也要有——透传区永远隔着 `--`，与前面的选项无关
    const sh = buildLaunchScript(base);
    assert.match(sh.content, / -- "\$@"\n$/);
  });

  test('契约 4：脚本里不出现任何密钥', () => {
    const sh = buildLaunchScript(base);
    const cmd = buildLaunchScript({ ...base, platform: 'win32', home: 'C:\\Users\\t' });
    for (const s of [sh, cmd]) {
      assert.doesNotMatch(s.content, /ANTHROPIC_(AUTH_TOKEN|API_KEY)/);
      assert.doesNotMatch(s.content, /sk-/);
      assert.doesNotMatch(s.content, /DEEPSEEK_API_KEY/);
    }
    // 结构保证：入参里根本没有放密钥的字段
    assert.deepEqual(
      Object.keys(base).filter((k) => /token|key|secret/i.test(k)),
      ['tokenName'], // 只有名字，没有值
    );
  });
});

describe('buildLaunchScript —— 换行符（§2.10）', () => {
  test('.sh 必须 LF，一个 \\r 都不许有', () => {
    const s = buildLaunchScript(base);
    assert.ok(!s.content.includes('\r'), 'sh 里出现了 CR');
    assert.ok(s.content.endsWith('\n'));
  });

  test('.cmd 必须 CRLF——每一行都以 \\r\\n 结尾', () => {
    const s = buildLaunchScript({ ...base, platform: 'win32', home: 'C:\\Users\\t' });
    const lines = s.content.split('\r\n');
    assert.equal(lines.at(-1), ''); // 以 CRLF 收尾
    assert.ok(!/\n/.test(lines.join('')), '有裸 LF 没配对 CR');
  });

  test('.cmd 整个文件都是纯 ASCII（含注释）', () => {
    const s = buildLaunchScript({
      ...base,
      platform: 'win32',
      home: 'C:\\Users\\t',
      cwd: 'C:\\Users\\t\\work\\client-a',
      nodePath: 'C:\\Program Files\\nodejs\\node.exe',
      cmtPath: 'C:\\cmt\\bin\\cmt.js',
      needCd: true,
    });
    assert.equal(hasNonAscii(s.content), false, `混进了非 ASCII：${s.content}`);
  });

  test('首行是 shebang（sh）/ @echo off（cmd）', () => {
    assert.match(buildLaunchScript(base).content, /^#!\/bin\/sh\n/);
    assert.match(
      buildLaunchScript({ ...base, platform: 'win32', home: 'C:\\Users\\t' }).content,
      /^@echo off\r\n/,
    );
  });
});

describe('buildLaunchScript —— argv 与「直接拉起」一致', () => {
  test('带 token + model + -c 时，命令行形状与 §2.10 逐字对得上', () => {
    const s = buildLaunchScript({ ...base, cont: true });
    assert.match(
      s.content,
      /exec '\/usr\/local\/bin\/node' '\/opt\/cmt\/bin\/cmt\.js' exec 'relay-a' --model 'deepseek-flash\[1m\]' -c -- "\$@"/,
    );
  });

  test('没有 model 时不传 --model（§2.5 规则 3：models 为空 = 用 Claude Code 自身默认）', () => {
    const s = buildLaunchScript({ ...base, model: null });
    assert.doesNotMatch(s.content, /--model/);
  });

  test('没有 -c 时不传 -c', () => {
    assert.doesNotMatch(buildLaunchScript(base).content, / -c /);
  });
});

describe('buildLaunchScript —— --url / --auth-mode 也要进脚本（§2.10 逐字一致）', () => {
  // 回归背景：`cmt run --url X` 曾经**显示的和实际启动的不一致**——`run.js` 只把
  // `--model` / `-c` 转发给了内层 `cmt exec`，`--url` / `--auth-mode` 被丢掉，
  // 于是"窗口里跑的是配置里的端点，而回执/--print 说的是你给的那个"。
  // 这里锁死脚本这一侧：命令行上给了，就必须出现在脚本里，位置与 `run.js` 的 argv 一致。

  test('sh：--url / --auth-mode 出现在 --model 之后、-c 之前，且被引号包裹', () => {
    const s = buildLaunchScript({ ...base, url: '${RELAY_URL}', authMode: 'key', cont: true });
    assert.match(
      s.content,
      /exec '\/usr\/local\/bin\/node' '\/opt\/cmt\/bin\/cmt\.js' exec 'relay-a' --model 'deepseek-flash\[1m\]' --url '\$\{RELAY_URL\}' --auth-mode 'key' -c -- "\$@"/,
    );
  });

  test('cmd：同样的位置，值走 cmdQuote', () => {
    const s = buildLaunchScript({
      ...base,
      platform: 'win32',
      home: 'C:\\Users\\t',
      url: '${RELAY_URL}',
      authMode: 'token',
    });
    assert.match(
      s.content,
      /exec "relay-a" --model "deepseek-flash\[1m\]" --url "\$\{RELAY_URL\}" --auth-mode "token" -- %\*/,
    );
  });

  test('★ 引用串原样进脚本，**不求值**——引用跨得过进程边界，密钥跨不过（§2.4）', () => {
    const s = buildLaunchScript({ ...base, url: '${RELAY_URL}' });
    assert.match(s.content, /\$\{RELAY_URL\}/, '给的是引用就写引用');
    // 求值发生在新窗口里的 `cmt exec`：那里才有用户当下的环境
    assert.doesNotMatch(s.content, /https:\/\//);
  });

  test('cmd 的 % 转义对 --url 同样生效（值一律过 cmdQuote）', () => {
    const s = buildLaunchScript({
      ...base,
      platform: 'win32',
      home: 'C:\\Users\\t',
      url: 'https://relay.example.com/100%25',
    });
    assert.match(s.content, /--url "https:\/\/relay\.example\.com\/100%%25"/);
  });

  test('没给就不出现（别凭空造出选项）', () => {
    const s = buildLaunchScript(base);
    assert.doesNotMatch(s.content, /--url/);
    assert.doesNotMatch(s.content, /--auth-mode/);
  });

  test('★ §2.7 铁律的结构性守卫：脚本里永远不许出现 --token-value', () => {
    // 本模块**根本没有** token 值这个入参，所以这条在结构上恒成立；
    // 写成断言是为了拦住"以后顺手加一个参数"——那会把凭证钉进 launch.cmd。
    for (const platform of /** @type {NodeJS.Platform[]} */ (['win32', 'linux'])) {
      const s = buildLaunchScript({
        ...base,
        platform,
        home: platform === 'win32' ? 'C:\\Users\\t' : '/home/t',
        url: 'https://relay.example.com',
        authMode: 'token',
        cont: true,
      });
      assert.doesNotMatch(s.content, /token-value/, platform);
      assert.doesNotMatch(s.content, /sk-/, `${platform}: 脚本里不该有任何像密钥的东西`);
    }
  });

  test('Windows 上非 ASCII 的 --url 也算编码风险（它同样被写进 .cmd）', () => {
    const s = buildLaunchScript({
      ...base,
      platform: 'win32',
      home: 'C:\\Users\\t',
      url: 'https://中转.example.com',
    });
    assert.ok(s.warnings.some((w) => w.includes('API 端点')), s.warnings.join('\n'));
  });
});

describe('urlCarriesCredential —— userinfo 就是凭证（§2.7）', () => {
  test('★ user:pass@ 判为带凭证', () => {
    assert.equal(urlCarriesCredential('https://user:hunter2@relay.example.com/v1'), true);
    assert.equal(urlCarriesCredential('http://a:b@h'), true);
  });

  test('只有用户名也算（userinfo 不要求有冒号）', () => {
    assert.equal(urlCarriesCredential('https://user@relay.example.com'), true);
  });

  test('★ 整串 ${VAR} 引用不算——否则我们推荐的写法反而会被拒', () => {
    assert.equal(urlCarriesCredential('${RELAY_BASE_URL}'), false);
  });

  test('★ @ 在路径/查询里不算 userinfo（只在 authority 段找）', () => {
    assert.equal(urlCarriesCredential('https://relay.example.com/path@2x.png'), false);
    assert.equal(urlCarriesCredential('https://relay.example.com/v1?to=a@b.com'), false);
    assert.equal(urlCarriesCredential('https://relay.example.com/v1#a@b'), false);
  });

  test('普通端点、端口、空值都不算', () => {
    assert.equal(urlCarriesCredential('https://relay.example.com/anthropic'), false);
    assert.equal(urlCarriesCredential('http://127.0.0.1:8080/v1'), false);
    assert.equal(urlCarriesCredential(''), false);
    assert.equal(urlCarriesCredential(undefined), false);
  });

  test('没有 scheme:// 的值不猜（形状不对是 validate 的事）', () => {
    assert.equal(urlCarriesCredential('user:pass@relay.example.com'), false);
    assert.equal(urlCarriesCredential('relay.example.com'), false);
  });

  test('部分引用仍按字面量看：拼接里的 @ 照判', () => {
    // 部分引用本来就会被第二道闸门拦（§2.4），这里只保证不误判成"安全"
    assert.equal(urlCarriesCredential('https://u:p@${HOST}/v1'), true);
  });
});

describe('buildLaunchScript —— 编码风险', () => {
  test('Windows + 非 ASCII 路径 → 报警并指向「直接拉起」', () => {
    const s = buildLaunchScript({
      ...base,
      platform: 'win32',
      home: 'C:\\Users\\t',
      cmtPath: 'C:\\开源 整理\\agent_multi_token\\claude code\\bin\\cmt.js',
    });
    assert.equal(s.warnings.length, 1);
    assert.match(s.warnings[0], /非 ASCII/);
    assert.match(s.warnings[0], /直接拉起/);
  });

  test('纯 ASCII → 无警告', () => {
    const s = buildLaunchScript({ ...base, platform: 'win32', home: 'C:\\Users\\t' });
    assert.deepEqual(s.warnings, []);
  });

  test('POSIX 上非 ASCII 路径不报警（sh 原生 UTF-8）', () => {
    const s = buildLaunchScript({ ...base, cmtPath: '/home/t/开源/cmt.js' });
    assert.deepEqual(s.warnings, []);
  });

  test('needCd 的 cwd 含非 ASCII 也算风险', () => {
    const s = buildLaunchScript({
      ...base,
      platform: 'win32',
      home: 'C:\\Users\\t',
      cwd: 'C:\\工作\\client-a',
      needCd: true,
    });
    assert.ok(s.warnings.some((w) => w.includes('工作目录')));
  });
});

describe('buildLaunchScript —— 缺入参要指名报错', () => {
  test('没有 nodePath / cmtPath 报「内部错误」', () => {
    for (const [key, re] of [
      ['nodePath', /node 的绝对路径/],
      ['cmtPath', /cmt 入口的绝对路径/],
    ]) {
      assert.throws(
        () => buildLaunchScript({ ...base, [key]: '' }),
        (/** @type {any} */ e) => re.test(e.message) && /内部错误/.test(e.hint),
      );
    }
  });

  test('没有 cwd 报错，并指向四要素里的「本地路径」', () => {
    assert.throws(
      () => buildLaunchScript({ ...base, cwd: '' }),
      (/** @type {any} */ e) => /工作目录/.test(e.message) && /本地路径/.test(e.hint),
    );
  });
});
