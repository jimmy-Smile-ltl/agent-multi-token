// @ts-check
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import { displayWidth } from '../src/cli/format.js';
import {
  FOOTER_HINT,
  FOOTER_HINTS,
  FOOTER_MARGIN,
  LEFT_MAX,
  LEFT_MIN,
  MIN_COLS,
  MIN_ROWS,
  TWO_PANE_MIN_COLS,
  fitLine,
  footerWidth,
  frameWidth,
  layout,
  listHeight,
  padEndFrame,
  pageMove,
  render,
  renderLines,
  scrollTop,
  splitFooter,
  tooSmallHint,
} from '../src/cli/ui/render.js';

// ───────────────────────────── 夹具 ─────────────────────────────

/** 契约要求扫的尺寸。**必须扫尺寸**——退化分支才是 bug 的藏身处（§面板 五）。 */
const SIZES = /** @type {[number, number][]} */ ([
  [40, 8],
  [45, 9],
  [71, 24],
  [72, 24],
  [120, 40],
  [200, 60],
]);

/**
 * 一帧里可能出现的最坏内容：CJK 标签、长路径、`▸`/`✓`/`…` 这些 Ambiguous 符号。
 * 用它拼出来的行才是"能不能放下"的真考验——纯 ASCII 的内容随便什么宽度函数都过。
 */
const NASTY = [
  '项目本地配置：/Users/某人/文档/非常长的中文路径/agent_multi_token',
  '▸ gpt-5.6-sol … deepseek-flash ✓ 已启动',
  'authToken: sk-****abcd    baseUrl: https://oneapi-relay.example.com/v1',
];

/**
 * 按 `layout()` 的结果拼一帧——**只用来验几何，不是 `render()` 的替身**。
 *
 * 每行都从 `fitLine()` 过，正是 `render()`（任务 #36）必须遵守的那条规矩。
 * 行数必须**正好**是 `rows`：少了会在终端上留下上一帧的尾巴。
 *
 * @param {ReturnType<typeof layout>} l
 * @returns {string[]}
 */
function fakeFrame(l) {
  if (l.tier === 'too-small') {
    return [fitLine(tooSmallHint({ cols: l.cols, rows: l.rows }), l.cols)];
  }

  const lines = [];
  // 1 标题
  lines.push(fitLine(' 当前目录 —— 中文标题也放得下', l.cols));
  // 2 空行
  lines.push('');
  // 3..2+bodyH 正文
  for (let i = 0; i < l.bodyH; i++) {
    const raw = NASTY[i % NASTY.length];
    lines.push(l.tier === 'two'
      ? fitLine(`${padEndFrame(raw, l.left)}|${raw}`, l.cols)
      : fitLine(` ${raw}`, l.cols));
  }
  // 页脚：**行数由 layout 说了算**（`footerLines.length === ftr`），别自己再算一遍
  for (const f of l.footerLines) lines.push(fitLine(' '.repeat(FOOTER_MARGIN) + f, l.cols));

  return lines;
}

// ═══════════════ ★★ 尺寸不变量（扫尺寸） ═══════════════

describe('★★ render —— 尺寸不变量：行数恒等于 rows、每行 frameWidth ≤ cols', () => {
  for (const [cols, rows] of SIZES) {
    test(`★ ${cols}×${rows}：几何自洽 + 每一行都放得下`, () => {
      const l = layout({ cols, rows });

      assert.notEqual(l.tier, 'too-small', `${cols}×${rows} 不该退化`);
      assert.equal(l.cols, cols);
      assert.equal(l.rows, rows);

      // 行号守恒式
      assert.equal(2 + l.bodyH + l.ftr, rows, '★ 2 + bodyH + ftr 必须 === rows');
      assert.equal(l.bodyTop, 3);
      assert.equal(l.footerTop, 3 + l.bodyH);
      assert.equal(l.footerTop + l.ftr - 1, rows, '★ 页脚最后一行必须正好是最后一行');

      // 列宽守恒
      assert.equal(l.left + l.sep + l.right, cols, '★ 栏宽之和必须 === cols');

      // 帧本身
      const frame = fakeFrame(l);
      assert.equal(frame.length, rows, '★ 行数恒等于 rows');
      for (const [i, line] of frame.entries()) {
        assert.ok(
          frameWidth(line) <= cols,
          `★ 第 ${i + 1} 行超宽：${frameWidth(line)} > ${cols}（${JSON.stringify(line)}）`,
        );
      }
    });
  }

  test('★ 两栏时左栏宽受 clamp 约束（极端尺寸下不失控）', () => {
    assert.equal(layout({ cols: 72, rows: 24 }).left, Math.round(72 * 0.34));
    assert.equal(layout({ cols: 200, rows: 60 }).left, LEFT_MAX, '★ 极宽时封顶');
    // 下限：cols 刚过 72 时按比例算出来是 24+，够不到 20；直接验 clamp 的常量语义
    assert.ok(LEFT_MIN < LEFT_MAX);
  });

  test('★ 每行都 ≤ cols 这件事**不靠运气**：故意塞一个超宽内容，fitLine 也得挡住', () => {
    const l = layout({ cols: 72, rows: 24 });
    const huge = '中'.repeat(500);
    assert.ok(frameWidth(huge) > l.cols);
    assert.ok(frameWidth(fitLine(huge, l.cols)) <= l.cols);
  });
});

// ═══════════════ ★ 退化分级边界 ═══════════════

describe('★ render —— 退化分级的边界（39/40、71/72、7/8）', () => {
  test('★ cols：39 退化、40 单栏', () => {
    assert.equal(layout({ cols: MIN_COLS - 1, rows: 24 }).tier, 'too-small');
    assert.equal(layout({ cols: MIN_COLS, rows: 24 }).tier, 'single');
  });

  test('★ cols：71 单栏、72 两栏', () => {
    assert.equal(layout({ cols: TWO_PANE_MIN_COLS - 1, rows: 24 }).tier, 'single');
    assert.equal(layout({ cols: TWO_PANE_MIN_COLS, rows: 24 }).tier, 'two');
  });

  test('★ rows：7 退化、8 正常', () => {
    assert.equal(layout({ cols: 120, rows: MIN_ROWS - 1 }).tier, 'too-small');
    assert.equal(layout({ cols: 120, rows: MIN_ROWS }).tier, 'two');
  });

  test('★★ 页脚行数由内容定，正文让位——写死行数会让帧少画一行', () => {
    // 71 列下提示串一行就装得下 ⇒ ftr=1；40 列下装不下 ⇒ ftr=2。
    // 帧必须**正好** rows 行：少一行 = 上一帧的尾巴留在屏幕上（全量重绘不自愈）。
    const wide = layout({ cols: 71, rows: 24 });
    const narrow = layout({ cols: 40, rows: 24 });
    assert.equal(wide.ftr, 1);
    assert.equal(narrow.ftr, 2);

    for (const l of [wide, narrow]) {
      assert.equal(l.ftr, l.footerLines.length, '★ ftr 必须就是 footerLines 的行数');
      assert.equal(2 + l.bodyH + l.ftr, 24);
      assert.equal(fakeFrame(l).length, 24);
    }
    assert.ok(narrow.bodyH < wide.bodyH, '★ 页脚多占一行，正文就该少一行');
  });

  test('★ too-small 档不遵守守恒式——整屏只有一行提示', () => {
    const l = layout({ cols: 30, rows: 6 });
    assert.equal(l.tier, 'too-small');
    assert.equal(l.bodyH, 0);
    assert.equal(l.ftr, 0);
    assert.equal(fakeFrame(l).length, 1);
  });

  test('★ 尺寸乱给（0 / undefined / 负数）不炸，一律退化', () => {
    for (const bad of [{}, { cols: 0, rows: 0 }, { cols: -5, rows: -5 }, { cols: 1e9, rows: 1e9 }]) {
      const l = layout(bad);
      assert.ok(['too-small', 'single', 'two'].includes(l.tier));
      assert.ok(Number.isFinite(l.bodyH));
    }
  });

  test('★ 提示串里必须带上**当前尺寸与下限**（"太小了"三个字帮不上忙）', () => {
    const s = tooSmallHint({ cols: 30, rows: 6 });
    assert.match(s, /30×6/);
    assert.match(s, new RegExp(`${MIN_COLS}×${MIN_ROWS}`));
  });
});

// ═══════════════ ★ 页脚与 TWO_PANE_MIN_COLS 的耦合 ═══════════════

describe('★ render —— 页脚宽度钉住 TWO_PANE_MIN_COLS（改了提示串没改常量 → 立刻红）', () => {
  test('★★ 两栏模式下页脚必须一行放得下', () => {
    assert.ok(
      footerWidth() <= TWO_PANE_MIN_COLS,
      `★ 页脚宽 ${footerWidth()} 超过 TWO_PANE_MIN_COLS=${TWO_PANE_MIN_COLS}：`
        + '要么缩短 FOOTER_HINT，要么调大 TWO_PANE_MIN_COLS（§面板 五）',
    );
  });

  test('★ 两栏档的页脚确实只有一行，且没被截断', () => {
    const l = layout({ cols: TWO_PANE_MIN_COLS, rows: 24 });
    assert.equal(l.footerLines.length, 1);
    assert.equal(l.footerLines[0], FOOTER_HINT, '★ 两栏档不许截断页脚');
  });

  test('★ 页脚里的退出提示不许被吃掉（用户找不到 `q 退出` 是最糟的退化）', () => {
    for (const cols of [40, 50, 60, 71, 72, 120]) {
      const lines = splitFooter(cols);
      const joined = lines.join(' ');
      assert.match(joined, /退出/, `★ ${cols} 列下退出提示不见了`);
      for (const line of lines) {
        assert.ok(frameWidth(line) <= cols - FOOTER_MARGIN, `★ ${cols} 列下页脚行超宽`);
      }
    }
  });

  test('★ 单栏档页脚最多两行（正文行是稀缺资源）', () => {
    for (const cols of [MIN_COLS, 50, 60, 71]) {
      assert.ok(splitFooter(cols).length <= 2, `★ ${cols} 列下页脚占了 3 行`);
    }
  });
});

// ═══════════════ ★ 光标必落在窗口内 ═══════════════

describe('★★ render —— 光标必落在窗口内（len × h × cursor × top 四重循环）', () => {
  test('★★ 穷举：scrollTop 的结果永远让光标可见', () => {
    let cases = 0;
    for (const len of [0, 1, 2, 3, 7, 20]) {
      for (const h of [1, 2, 3, 5, 10]) {
        for (let cursor = 0; cursor < Math.max(1, len); cursor++) {
          for (let top = 0; top <= len; top++) {
            cases++;
            const t = scrollTop({ top, len, h, cursor });

            assert.ok(Number.isInteger(t), `top 必须是整数：len=${len} h=${h} c=${cursor} → ${t}`);
            assert.ok(t >= 0, `★ top 不能是负的：len=${len} h=${h} c=${cursor} → ${t}`);
            assert.ok(t <= Math.max(0, len - h), `★ top 越界：len=${len} h=${h} c=${cursor} → ${t}`);

            if (len <= h) {
              assert.equal(t, 0, '★ 装得下就该停在顶部');
            } else {
              assert.ok(
                cursor >= t && cursor < t + h,
                `★ 光标跑出窗口：len=${len} h=${h} cursor=${cursor} top=${top} → top=${t}`,
              );
            }
          }
        }
      }
    }
    assert.ok(cases > 500, `扫的用例太少（${cases}），这条断言就没意义了`);
  });

  test('★ 边缘滚动：光标还在窗口里时 top **不动**', () => {
    assert.equal(scrollTop({ top: 0, len: 20, h: 5, cursor: 3 }), 0);
    assert.equal(scrollTop({ top: 5, len: 20, h: 5, cursor: 7 }), 5);
  });

  test('★ 光标撞下边缘：只滚一格，不做居中', () => {
    assert.equal(scrollTop({ top: 0, len: 20, h: 5, cursor: 5 }), 1);
  });

  test('★ 光标撞上边缘', () => {
    assert.equal(scrollTop({ top: 5, len: 20, h: 5, cursor: 4 }), 4);
  });

  test('★ 光标越界（负数 / 超过 len）被夹回来，不产生越界的 top', () => {
    assert.equal(scrollTop({ top: 0, len: 3, h: 2, cursor: 99 }), 1);
    assert.equal(scrollTop({ top: 5, len: 3, h: 2, cursor: -1 }), 0);
  });
});

// ═══════════════ ★ PgUp / PgDn 必须显式滚 top ═══════════════

describe('★ render —— PgDn/PgUp 显式滚 top（只靠 scrollTop 会"按了没反应"）', () => {
  test('★★ 光标在窗口顶部时按 PgDn：top 必须整页滚，不是滚一格', () => {
    // 这正是"只靠 scrollTop"会挂掉的形态：光标 5 在窗口 [5,9] 里，
    // scrollTop 会认为"不用滚"——用户按了翻页却只看见光标下移。
    const r = pageMove({ top: 5, len: 100, h: 5, cursor: 5, dir: 1 });
    assert.equal(r.top, 10, '★ 必须整整滚一页');
    assert.equal(r.cursor, 10);
  });

  test('★ 连按 PgDn 到底：停在最后一页，不越界', () => {
    let s = { top: 0, cursor: 0 };
    const len = 12;
    const h = 5;
    for (let i = 0; i < 10; i++) {
      s = pageMove({ ...s, len, h, dir: 1 });
      assert.ok(s.top <= len - h, `★ top 越界：${s.top}`);
      assert.ok(s.cursor >= s.top && s.cursor < s.top + h, '★ 光标必须可见');
    }
    assert.equal(s.top, len - h);
  });

  test('★ 连按 PgUp 到顶', () => {
    let s = { top: 7, cursor: 11 };
    for (let i = 0; i < 10; i++) {
      s = pageMove({ ...s, len: 12, h: 5, dir: -1 });
      assert.ok(s.top >= 0 && s.cursor >= 0);
    }
    assert.equal(s.top, 0);
    assert.equal(s.cursor, 0);
  });

  test('★ 列表比窗口短时怎么按都不动', () => {
    const r = pageMove({ top: 0, len: 3, h: 5, cursor: 1, dir: 1 });
    assert.equal(r.top, 0);
    assert.equal(r.cursor, 2, '光标还是能走到末尾');
  });
});

// ═══════════════ ★★ frameWidth：保守，永远不低估 ═══════════════

describe('★★ render —— frameWidth 是保守宽度（低估=折行=烂整屏，高估=零代价）', () => {
  test('★ ASCII 一列一个', () => {
    assert.equal(frameWidth('abc'), 3);
    assert.equal(frameWidth(''), 0);
  });

  test('★ CJK 两列一个（与 displayWidth 一致）', () => {
    assert.equal(frameWidth('中文'), 4);
    assert.equal(frameWidth('中文'), displayWidth('中文'));
  });

  test('★★ Ambiguous 算 2——**这就是与 displayWidth 故意不一致的地方**', () => {
    for (const ch of ['…', '↑', '↓', '·', '─', '│', '▸', '✓', '×']) {
      assert.equal(frameWidth(ch), 2, `★ ${ch} 在 frameWidth 里必须算 2 列`);
      assert.equal(displayWidth(ch), 1, `${ch} 在 displayWidth 里算 1 列`);
    }
  });

  test('★★ 两张表的不一致是**有意**的，不是漂移：面板的守门宽度必须 ≥ 对齐宽度', () => {
    for (const s of ['…', '↑↓ 选择', '─│┌┐└┘', 'a·b']) {
      assert.ok(
        frameWidth(s) >= displayWidth(s),
        `★ frameWidth 少算了：${JSON.stringify(s)} ${frameWidth(s)} < ${displayWidth(s)}`,
      );
    }
  });

  test('★ ANSI 序列不占列', () => {
    assert.equal(frameWidth('\u001b[7m中文\u001b[0m'), 4);
    assert.equal(frameWidth('\u001b[38;5;196mabc\u001b[0m'), 3);
  });

  test('★ OSC 也不占列（终端应答被吃干净）', () => {
    assert.equal(frameWidth('\u001b]0;标题\u0007abc'), 3);
    assert.equal(frameWidth('\u001b]0;标题\u001b\\abc'), 3);
  });

  test('★ 半截 ANSI 序列按 1 列算（保守方向，不许当 0）', () => {
    // ⚠️ `ESC [ 7 m` **是完整的**（`m` 就是终结字节），别拿它当反例。
    //    真正半截的是收不到终结字节的那些——`ESC [` / `ESC [ 38;5`。
    assert.equal(frameWidth('\u001b['), 2);
    assert.equal(frameWidth('\u001b[38;5'), 6);
  });

  test('★ 组合记号算 1（**故意的**：算 0 就可能低估）', () => {
    assert.equal(frameWidth('é'), 2, 'e + 组合尖音符');
  });

  test('★ 代理对（emoji）按一个码点算，且算 2 列', () => {
    assert.equal(frameWidth('😀'), 2);
    assert.equal([...'😀'].length, 1, '前提：它是一个码点');
  });

  test('★ 空值安全', () => {
    assert.equal(frameWidth(null), 0);
    assert.equal(frameWidth(undefined), 0);
    assert.equal(frameWidth(123), 3);
  });
});

// ═══════════════ ★★ fitLine：唯一的出口 ═══════════════

describe('★★ render —— fitLine 是唯一出口', () => {
  test('★ 放得下就原样（不补空格——行尾靠 `[K` 擦）', () => {
    assert.equal(fitLine('abc', 10), 'abc');
    assert.equal(fitLine('abc', 3), 'abc');
  });

  test('★ 行尾空格去掉', () => {
    assert.equal(fitLine('abc   ', 10), 'abc');
  });

  test('★★ 放不下就截断，且**结果恒 ≤ cols**（扫一遍 cols）', () => {
    const s = '项目本地配置：一个很长很长的中文标签 / very/long/ascii/path';
    for (let cols = 1; cols <= 80; cols++) {
      const out = fitLine(s, cols);
      assert.ok(frameWidth(out) <= cols, `★ cols=${cols} 时输出宽 ${frameWidth(out)}`);
    }
  });

  test('★★ 截断处必须补 `…`（静默截断用户看不出来）', () => {
    const out = fitLine('中'.repeat(50), 10);
    assert.ok(out.endsWith('…'));
    assert.equal(frameWidth(out), 10, '★ 省略号按 2 列占位，正好填满');
  });

  test('★★ 不切半个宽字符（切点永远落在码点边界上）', () => {
    const src = '中'.repeat(12);
    for (let cols = 2; cols <= 30; cols++) {
      const out = fitLine(src, cols);
      const body = out.endsWith('…') ? out.slice(0, -1) : out;

      // ① 切出来的必须是原文的**前缀**——不是"半个字"拼出来的怪东西
      assert.equal(src.startsWith(body), true, `★ cols=${cols} 切出的不是前缀：${JSON.stringify(out)}`);
      // ② 每个汉字都完整
      assert.equal([...body].every((c) => c === '中'), true, `★ cols=${cols} 切出了半个字：${JSON.stringify(out)}`);
      // ③ 停在半个宽字符上的话，宽度会是奇数
      assert.equal(frameWidth(body) % 2, 0, `★ cols=${cols} 停在半个宽字符上：${JSON.stringify(out)}`);
      assert.ok(frameWidth(out) <= cols);
    }
  });

  test('★ 极小的 cols 不炸（虽然实际到不了，但别留 undefined/NaN）', () => {
    assert.equal(fitLine('abc', 0), '');
    assert.equal(fitLine('abc', 1), '');
    assert.equal(fitLine('abc', 2), '…');
    assert.equal(fitLine('', 0), '');
  });

  test('★ ANSI 不会被切在中间（切了会漏一串裸字节到屏幕上）', () => {
    const s = `\u001b[7m${'中'.repeat(20)}\u001b[0m`;
    for (let cols = 2; cols <= 40; cols++) {
      const out = fitLine(s, cols);
      // 逐个 ESC 检查：每个都必须有终结字节
      let i = out.indexOf('\u001b');
      while (i >= 0) {
        const tail = out.slice(i);
        assert.match(tail, /^\u001b\[[0-9;]*[A-Za-z]/, `★ cols=${cols} 切出了半截序列`);
        i = out.indexOf('\u001b', i + 1);
      }
      assert.ok(frameWidth(out) <= cols);
    }
  });

  test('★ 截断后补了 RESET（内容带颜色时省略号不该继承它）', () => {
    const out = fitLine(`\u001b[7m${'中'.repeat(20)}`, 10);
    assert.ok(out.includes('\u001b[0m'), '★ 截断处要有复位');
  });

  test('★ 空值安全', () => {
    assert.equal(fitLine(null, 10), '');
    assert.equal(fitLine(undefined, 10), '');
  });
});

// ═══════════════ ★★ render()：完整一帧 ═══════════════

/**
 * ★★ **每一屏都要扫**，不是只测主屏。
 *
 * 面板有六种正文形态（主屏 / 确认框 / 向导四步，其中第 2、3 步各还有两个子形态），
 * 而**帧的行数守恒与宽度守恒对每一屏都成立**。只测主屏的话，带输入框的那几屏
 * （正是最容易多画一行、最容易溢出的）就没人守着。
 */
const ITEM_A = {
  kind: 'cwd',
  label: '当前目录',
  token: 'relay-cxt',
  path: '/Users/某人/文档/agent_multi_token',
  layer: 'binding',
  detail: {
    masked: 'sk-****abcd',
    baseUrl: 'https://oneapi-relay.example.com/v1',
    source: '路径绑定',
    profile: '已建',
    provider: 'openai',
    models: ['gpt-5.6-sol', 'gpt-6.1-sol', 'deepseek-flash'],
    active: 0,
    catalog: 12,
  },
};

const ITEMS = [
  ITEM_A,
  { kind: 'binding', label: 'agent_multi_token', token: 'relay-cxt', path: '/p', layer: 'project', detail: ITEM_A.detail },
  {
    kind: 'token',
    label: 'relay-a',
    token: 'relay-a',
    layer: 'token',
    detail: { masked: 'sk-****0011', baseUrl: 'https://x.example.com/v1', source: '默认', profile: '未建', provider: '', models: [], active: -1, catalog: 0 },
  },
  { kind: 'new', label: '+ 新建…' },
];

const TOKENS = [
  { name: 'relay-cxt', masked: 'sk-****abcd', baseUrl: 'https://oneapi…' },
  { name: 'relay-a', masked: 'sk-****0011', baseUrl: 'https://x…' },
];

/**
 * ★ 标题栏与第 4 步落点里那两处**工具名**从 `data` 进来，不写死在 `render.js` 里
 * —— 这样 `ui/` 四个内核文件在两个项目里能逐字一致（契约 §面板）。
 * 夹具少写一个字段，标题栏就会印出 `undefined 面板`。
 */
const BASE_DATA = {
  cwd: '/Users/某人/文档/agent_multi_token',
  items: ITEMS,
  tokens: TOKENS,
  appName: 'cxt',
  projectFile: '.cxt.json',
};

/** @param {any} [over] */
function mkState(over = {}) {
  return {
    screen: 'list',
    view: { cols: 120, rows: 40 },
    data: BASE_DATA,
    cursor: 0,
    top: 0,
    notice: '',
    pending: false,
    wizard: null,
    confirm: null,
    ...over,
  };
}

/** @param {1|2|3|4} step @param {any} [over] */
function mkWizard(step, over = {}) {
  return {
    step,
    edit: false,
    target: { path: '/p', token: '', layer: 'none' },
    path: {
      text: '/Users/某人/文档/agent_multi_token',
      dirs: ['src', 'tests', '一个很长的中文子目录名'],
      dirCursor: 1,
      dirTop: 0,
      pending: false,
    },
    token: { mode: 'pick', cursor: 0, top: 0, name: '', secret: '', field: 'name', chosen: '', notice: '' },
    models: {
      phase: 'ok',
      error: '',
      ids: ['gpt-5.6-sol', 'gpt-6.1-sol', 'deepseek-flash'],
      checked: ['gpt-5.6-sol'],
      cursor: 1,
      top: 0,
      filter: '',
      filtering: false,
      manual: false,
      manualText: '',
      notice: '',
    },
    notice: '',
    ...over,
  };
}

/** 密钥明文——**它绝不能出现在任何一帧里**（§面板 四）。 */
const SECRET = 'sk-PLAINTEXT-MUST-NOT-LEAK-0123456789';

const SCREENS = /** @type {[string, any][]} */ ([
  ['主屏', mkState()],
  ['主屏 · 确认框', mkState({ confirm: { kind: 'delete-binding', path: '/p', label: 'agent_multi_token' } })],
  ['主屏 · 长通知（中文）', mkState({ notice: '启动失败：spawn wt.exe 找不到可执行文件' })],
  ['主屏 · 选中最后一项（反显贴右栏）', mkState({ cursor: 3 })],
  ['向导 1/4 路径', mkState({ screen: 'wizard', wizard: mkWizard(1) })],
  ['向导 1/4 子目录读取中', mkState({ screen: 'wizard', wizard: mkWizard(1, { path: { ...mkWizard(1).path, dirs: [], pending: true } }) })],
  ['向导 2/4 选身份', mkState({ screen: 'wizard', wizard: mkWizard(2) })],
  ['向导 2/4 新建 token（密钥输入中）', mkState({
    screen: 'wizard',
    wizard: mkWizard(2, { token: { mode: 'new', cursor: 0, top: 0, name: '我的新身份', secret: SECRET, field: 'secret', chosen: '', notice: '' } }),
  })],
  ['向导 3/4 拉取中', mkState({ screen: 'wizard', wizard: mkWizard(3, { models: { ...mkWizard(3).models, phase: 'loading', ids: [] } }) })],
  ['向导 3/4 失败', mkState({
    screen: 'wizard',
    wizard: mkWizard(3, { models: { ...mkWizard(3).models, phase: 'fail', ids: [], error: '拉不到模型列表：HTTP 502 Bad Gateway（内网端点）' } }),
  })],
  ['向导 3/4 手敲 id', mkState({
    screen: 'wizard',
    wizard: mkWizard(3, { models: { ...mkWizard(3).models, manual: true, manualText: 'gpt-5.6-sol' } }),
  })],
  ['向导 3/4 过滤中', mkState({
    screen: 'wizard',
    wizard: mkWizard(3, { models: { ...mkWizard(3).models, filtering: true, filter: 'sol' } }),
  })],
  ['向导 3/4 空列表', mkState({
    screen: 'wizard',
    wizard: mkWizard(3, { models: { ...mkWizard(3).models, phase: 'ok', ids: [], checked: [] } }),
  })],
  ['向导 4/4 落点（新建）', mkState({ screen: 'wizard', wizard: mkWizard(4, { token: { ...mkWizard(4).token, chosen: 'relay-cxt' } }) })],
  ['向导 4/4 落点（改模型）', mkState({
    screen: 'wizard',
    wizard: mkWizard(4, { edit: true, target: { path: '/p', token: 'relay-cxt', layer: 'project' } }),
  })],
]);

describe('★★ render —— 每一屏 × 每一尺寸：帧恒好 rows 行、每行恒 ≤ cols、恒不发裸换行', () => {
  for (const [name, state] of SCREENS) {
    for (const [cols, rows] of SIZES) {
      test(`★ ${name} @ ${cols}×${rows}`, () => {
        const size = { cols, rows };
        const l = layout(size, FOOTER_HINTS[state.screen === 'list' ? 'list' : `wizard:${state.wizard.step}`]);
        const { frame } = render(state, size);
        const lines = renderLines(state, size);

        if (l.tier === 'too-small') {
          assert.equal(lines.length, 1, '★ too-small 档整屏只有一行');
          assert.ok(frame.startsWith('\u001b[2J'), '★ too-small 档是全项目唯一每帧 [2J 的地方');
          assert.equal(frameWidth(lines[0]), l.cols, '★ 那一行必须**撑满**——它是"屏幕正中一行"');
          return;
        }

        // ① 行数守恒：**正好** rows 行。少一行 = 上一帧的尾巴留在屏幕上（全量重绘不自愈）
        assert.equal(lines.length, rows, `★ 帧行数 ${lines.length} ≠ ${rows}`);
        // ② 宽度守恒：每一行都放得下
        for (const [i, line] of lines.entries()) {
          assert.ok(frameWidth(line) <= cols, `★ 第 ${i + 1} 行超宽：${frameWidth(line)} > ${cols}（${JSON.stringify(line)}）`);
        }
        // ③ 一帧是**一次 write**：里面有换行就等于让终端替我们排版，行号全乱
        assert.ok(!frame.includes('\n'), '★ 帧里不许有裸换行');
        assert.ok(!frame.includes('\r'), '★ 帧里不许有裸回车');
        // ④ 除 too-small 外**永不 [2J**——擦了就是整屏闪一下
        assert.ok(!frame.includes('\u001b[2J'), '★ 进屏之后不许再 [2J（防闪烁第一条）');
        // ⑤ 行尾一律 [K：不补空格，让终端自己擦
        assert.equal(frame.split('\u001b[K').length, lines.length + 1, '★ 每行都必须以 [K 收尾');
        // ⑥ CUP 行号正好是 1..rows，按序
        const cups = [...frame.matchAll(/\u001b\[(\d+);1H/g)].map((m) => Number(m[1]));
        assert.deepEqual(cups, lines.map((_, i) => i + 1), '★ CUP 必须是 1..rows 且按序');
      });
    }
  }

  test('★★ 密钥明文绝不出现在帧里（掩码只按长度画，渲染层拿不到明文）', () => {
    const state = mkState({
      screen: 'wizard',
      wizard: mkWizard(2, { token: { mode: 'new', cursor: 0, top: 0, name: 'n', secret: SECRET, field: 'secret', chosen: '', notice: '' } }),
    });
    for (const [cols, rows] of SIZES) {
      const all = renderLines(state, { cols, rows }).join('\n');
      assert.ok(!all.includes(SECRET), `★ ${cols}×${rows} 下明文漏进帧了`);
      assert.ok(!all.includes('PLAINTEXT'), `★ ${cols}×${rows} 下明文片段漏进帧了`);
      assert.ok(!all.includes('0123456789'), `★ ${cols}×${rows} 下明文片段漏进帧了`);
      // 但**长度**要看得见：掩码是唯一的反馈
      assert.ok(all.includes('•'), `★ ${cols}×${rows} 下连掩码都没有，用户不知道输了没输`);
    }
  });

  test('★ 掩码长度封顶 40 个点（一屏只有 40 行，不能被一串点顶穿）', () => {
    const state = mkState({
      screen: 'wizard',
      wizard: mkWizard(2, { token: { mode: 'new', cursor: 0, top: 0, name: 'n', secret: 'x'.repeat(200), field: 'secret', chosen: '', notice: '' } }),
    });
    const lines = renderLines(state, { cols: 200, rows: 40 });
    const box = lines.find((x) => x.includes('密钥'));
    assert.equal((box.match(/•/g) ?? []).length, 40);
  });

  test('★ 页脚提示串：**每一屏**都得在两栏档一行放得下（否则 `q 退出` 会被截掉）', () => {
    for (const [k, hint] of Object.entries(FOOTER_HINTS)) {
      assert.ok(
        footerWidth(hint) <= TWO_PANE_MIN_COLS,
        `★ ${k} 的页脚宽 ${footerWidth(hint)} > ${TWO_PANE_MIN_COLS}：要么缩短提示串，要么调大常量（§面板 五）`,
      );
    }
  });

  test('★ 页脚用**本屏的**提示串：向导里的 Enter 不是"启动"', () => {
    // 说错了比不说更糟：用户在第 1 步按 Enter 等启动，等来的是"下一步"
    for (const [name, state] of SCREENS) {
      const lines = renderLines(state, { cols: 120, rows: 40 });
      const foot = lines.slice(-2).join(' ');
      const isList = state.screen === 'list';
      assert.equal(foot.includes('Enter 启动'), isList, `★ ${name} 的页脚提示不对：${JSON.stringify(foot)}`);
    }
  });

  test('★ 71 列（单栏档）下帧仍是 rows 行——页脚少占一行，正文就多一行', () => {
    const state = mkState();
    const wide = renderLines(state, { cols: 72, rows: 24 });
    const narrow = renderLines(state, { cols: 71, rows: 24 });
    assert.equal(wide.length, 24);
    assert.equal(narrow.length, 24, '★ 少画一行 = 上一帧的尾巴留在屏幕上');
  });
});

describe('★ render —— 真光标的位置（输入法候选框锚在它上面，§TUI-Win）', () => {
  test('★ 没有输入框的屏 → cursor 为 null（驱动侧据此 `?25l`）', () => {
    for (const [name, state] of SCREENS) {
      const hasInput = state.screen === 'wizard'
        && (state.wizard.step === 1
          || (state.wizard.step === 2 && state.wizard.token.mode === 'new')
          || (state.wizard.step === 3 && state.wizard.models.manual));
      const { cursor } = render(state, { cols: 120, rows: 40 });
      assert.equal(cursor === null, !hasInput, `★ ${name} 的 cursor 判断反了：${JSON.stringify(cursor)}`);
    }
  });

  test('★★ 光标行列**恒在屏内**（扫尺寸：越界的话终端会把整屏滚一格）', () => {
    for (const [name, state] of SCREENS) {
      for (const [cols, rows] of SIZES) {
        const { cursor } = render(state, { cols, rows });
        if (cursor === null) continue;
        assert.ok(cursor.row >= 1 && cursor.row <= rows, `★ ${name} @ ${cols}×${rows} 行越界：${cursor.row}`);
        assert.ok(cursor.col >= 1 && cursor.col <= cols, `★ ${name} @ ${cols}×${rows} 列越界：${cursor.col}`);
      }
    }
  });

  test('★ 输入框那一行：光标在**末尾**（末尾必须在屏幕上，否则看不见刚敲的字）', () => {
    const long = '/Users/某人/文档/' + '很长的目录名/'.repeat(20);
    const state = mkState({ screen: 'wizard', wizard: mkWizard(1, { path: { ...mkWizard(1).path, text: long, dirs: [] } }) });
    for (const cols of [40, 60, 71, 72, 120]) {
      const { cursor } = render(state, { cols, rows: 24 });
      assert.ok(cursor !== null);
      assert.ok(cursor.col <= cols - 1, `★ ${cols} 列下光标贴到了最后一列，终端会折行`);
      const box = renderLines(state, { cols, rows: 24 })[2];
      assert.ok(frameWidth(box) <= cols);
      // 放不下时显示的是**尾巴**——开头被吃掉，末尾那个字符得在
      assert.ok(box.trimEnd().endsWith('名') || box.trimEnd().endsWith('/'), `★ 显示的不是尾巴：${JSON.stringify(box)}`);
    }
  });

  test('★ 光标行就是输入框那一行（行号由排版同一份算术给出）', () => {
    const state = mkState({ screen: 'wizard', wizard: mkWizard(1) });
    const l = layout({ cols: 120, rows: 40 });
    assert.equal(render(state, { cols: 120, rows: 40 }).cursor?.row, l.bodyTop);
  });
});

describe('★★ render —— 光标行必落在可见窗口里（与 app 的滚动算术同一份）', () => {
  test('★★ 光标滚到哪，反显的那一行就是哪一项', () => {
    const items = Array.from({ length: 30 }, (_, i) => ({ kind: 'token', label: `身份-${i}`, token: `t${i}` }));
    const size = { cols: 120, rows: 24 };
    const base = mkState({ data: { ...BASE_DATA, cwd: '/p', items, tokens: [] } });
    const h = listHeight(base, size);
    assert.ok(h < items.length, `夹具得让列表装不下（h=${h} len=${items.length}）`);

    for (const cursor of [0, 1, h - 1, h, h + 1, 20, 29]) {
      const state = { ...base, cursor, top: scrollTop({ top: 0, len: items.length, h, cursor }) };
      const lines = renderLines(state, size);
      const sel = lines.filter((x) => x.includes('\u001b[7m'));
      assert.equal(sel.length, 1, `★ cursor=${cursor} 时反显行不是恰好一行`);
      assert.ok(
        sel[0].startsWith(`\u001b[7m 身份-${cursor} `),
        `★ cursor=${cursor} 时光标在屏幕上不可见：${JSON.stringify(sel[0])}`,
      );
    }
  });

  test('★ 单栏档也守同一条', () => {
    const items = Array.from({ length: 30 }, (_, i) => ({ kind: 'token', label: `身份-${i}`, token: `t${i}` }));
    const size = { cols: 60, rows: 12 };
    const base = mkState({ data: { ...BASE_DATA, cwd: '/p', items, tokens: [] } });
    const h = listHeight(base, size);
    const state = { ...base, cursor: 25, top: scrollTop({ top: 0, len: items.length, h, cursor: 25 }) };
    const sel = renderLines(state, size).filter((x) => x.includes('\u001b[7m'));
    assert.equal(sel.length, 1);
    assert.ok(sel[0].startsWith('\u001b[7m 身份-25 '));
  });

  test('★★ 向导第 1 步的子目录列表：光标同样必可见（两处算术共用一个 `listHeight`）', () => {
    const dirs = Array.from({ length: 40 }, (_, i) => `子目录-${i}`);
    const size = { cols: 100, rows: 16 };
    const base = mkState({ screen: 'wizard', wizard: mkWizard(1, { path: { ...mkWizard(1).path, dirs } }) });
    const h = listHeight(base, size);
    for (const dirCursor of [0, h, h + 3, 39]) {
      const state = {
        ...base,
        wizard: { ...base.wizard, path: { ...base.wizard.path, dirCursor, dirTop: scrollTop({ top: 0, len: dirs.length, h, cursor: dirCursor }) } },
      };
      const sel = renderLines(state, size).filter((x) => x.includes('\u001b[7m'));
      assert.equal(sel.length, 1, `★ dirCursor=${dirCursor} 时反显行不是恰好一行`);
      assert.ok(sel[0].includes(`子目录-${dirCursor}`), `★ dirCursor=${dirCursor} 滚出屏幕了：${JSON.stringify(sel[0])}`);
    }
  });
});

describe('★ render —— 结构字符是纯 ASCII（Ambiguous 字形只在内容里，§面板 五）', () => {
  test('★ 分隔符是 `|`、反显是 `[7m`——不画 `│` 也不画 `─`', () => {
    const state = mkState();
    for (const cols of [72, 120, 200]) {
      const lines = renderLines(state, { cols, rows: 24 });
      for (const line of lines) {
        // 去掉 ANSI，剩下的可见字符里不许有制表符/框线
        const bare = line.replace(/\u001b\[[0-9;]*m/g, '');
        assert.ok(!/[─-╿]/.test(bare), `★ ${cols} 列下画了框线字符：${JSON.stringify(bare)}`);
      }
      assert.ok(lines[2].includes('|'), '★ 两栏档得有分隔符');
    }
  });
});

describe('render —— 纯函数', () => {
  test('★ 不改入参', () => {
    for (const [, state] of SCREENS) {
      const snap = JSON.stringify(state);
      render(state, { cols: 100, rows: 30 });
      renderLines(state, { cols: 71, rows: 12 });
      assert.equal(JSON.stringify(state), snap, '★ render 改了入参');
    }
  });

  test('★ 同输入同输出', () => {
    for (const [, state] of SCREENS) {
      assert.equal(render(state, { cols: 100, rows: 30 }).frame, render(state, { cols: 100, rows: 30 }).frame);
    }
  });
});

// ═══════════════ 装配小件 ═══════════════

describe('render —— padEndFrame（两栏拼装用）', () => {
  test('★ 按 frameWidth 补，中文标签也能对齐分隔符', () => {
    const a = padEndFrame('中文', 10);
    const b = padEndFrame('abcdef', 10);
    assert.equal(frameWidth(a), 10);
    assert.equal(frameWidth(b), 10);
  });

  test('★ 已经够宽就不动（不截断——截断是 fitLine 的活）', () => {
    assert.equal(padEndFrame('abcdefghij', 5), 'abcdefghij');
  });

  test('★ Ambiguous 也按保守宽度补', () => {
    assert.equal(frameWidth(padEndFrame('…', 5)), 5);
  });
});

// ═══════════════ 纯度 ═══════════════

describe('render —— 纯函数', () => {
  test('★ 不改入参', () => {
    const size = { cols: 120, rows: 40 };
    const snap = JSON.stringify(size);
    layout(size);
    assert.equal(JSON.stringify(size), snap);

    const a = { top: 3, len: 20, h: 5, cursor: 7 };
    const snap2 = JSON.stringify(a);
    scrollTop(a);
    pageMove({ ...a, dir: 1 });
    assert.equal(JSON.stringify(a), snap2);
  });

  test('★ 同输入同输出', () => {
    assert.equal(JSON.stringify(layout({ cols: 100, rows: 30 })), JSON.stringify(layout({ cols: 100, rows: 30 })));
    assert.equal(scrollTop({ top: 1, len: 9, h: 3, cursor: 5 }), scrollTop({ top: 1, len: 9, h: 3, cursor: 5 }));
  });
});
