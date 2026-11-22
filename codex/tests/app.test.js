// @ts-check
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { initialState, reduce, sanitize } from '../src/cli/ui/app.js';
import { listHeight, scrollTop, visibleModels } from '../src/cli/ui/render.js';

// ───────────────────────────── 夹具 ─────────────────────────────

/** @param {string} k */
const K = (k) => ({ type: 'key', key: k });
/** @param {string} t */
const T = (t) => ({ type: 'text', text: t });
/** @param {string} k */
const C = (k) => ({ type: 'ctrl', key: k });
/** @param {string} t @param {boolean} [truncated] */
const P = (t, truncated = false) => ({ type: 'paste', text: t, truncated });
/** @param {string} raw */
const U = (raw) => ({ type: 'unknown', raw });

/**
 * 把一串事件喂进去，返回终态 + **全部** effects（不是最后一个）。
 * 中间步骤的 effect 同样是契约的一部分——`n` 的 `list-dirs` 与
 * 第 2 步的 `fetch-models` 都要看得见。
 *
 * @param {any} state @param {any[]} evs
 */
function run(state, evs) {
  let s = state;
  /** @type {any[]} */
  const effects = [];
  for (const e of evs) {
    const r = reduce(s, e);
    s = r.state;
    effects.push(...r.effects);
  }
  return { state: s, effects };
}

/** @param {any[]} effects */
const types = (effects) => effects.map((e) => e.type);

/** 只喂一个事件。@param {any} state @param {any} ev */
const one = (state, ev) => run(state, [ev]);

/**
 * 左栏四行，**四种 kind 各一行**。第 3 行是**悬空绑定**：配置里 `/p/c` 指着一个
 * 已经不存在的 token 文件——`path` 有、`token` 没有。这不是编出来的怪状态，
 * 而是"token 文件被删了、binding 还在"的真实产物，而它同时是唯一一个
 * **既没有身份、又确实是路径绑定**的行（两个不同的提示语各要它一半）。
 */
const ITEMS = [
  { kind: 'cwd', label: '当前目录', token: 'relay-cxt', path: '/p/a', layer: 'binding', detail: { models: ['m1'] } },
  { kind: 'binding', label: 'proj', token: 'relay-a', path: '/p/b', layer: 'project', detail: { models: [] } },
  { kind: 'binding', label: '没身份的', path: '/p/c', layer: 'none' },
  { kind: 'new', label: '+ 新建…' },
];

// ★ `baseUrl` 是**给人看的**那串（没配时渲染成「(未设置)」），`url` 是**原始值**。
//   联动认的是 `url`——拿显示串去比会把两个"都没配"的 token 判成同一个地址。
//   ⚠️ 别往这个夹具里加第三个 token：有测试按"2/4 最后一行是 + 新建"来走光标。
const TOKENS = [
  { name: 'relay-cxt', masked: 'sk-****abcd', baseUrl: 'https://x', url: 'https://x' },
  { name: 'relay-a', masked: 'sk-****0011', baseUrl: 'https://y', url: 'https://y' },
];

const MODEL_IDS = ['gpt-5.6-sol', 'gpt-6.1-sol', 'deepseek-flash'];

/** @param {any} [over] */
function mkData(over = {}) {
  return {
    cwd: '/p/agent_multi_token',
    items: ITEMS,
    tokens: TOKENS,
    // ★ 标题栏与第 4 步落点里那两处**工具名**从 `data` 进来，不写死在 render.js 里
    //   —— 这样 `ui/` 四个内核文件在两个项目里能逐字一致（契约 §面板）。
    appName: 'cxt',
    projectFile: '.cxt.json',
    ...over,
  };
}

/** @param {any} [over] */
const mk = (over = {}) => initialState(mkData(over));

/** 走到向导第 2 步（选身份）。第 1 步的 Enter 就是"下一步"。 */
const atStep2 = (state = mk()) => run(state, [T('n'), K('enter')]).state;

/**
 * 第 2 步的**新建**态（`+ 新建 token…` 之后）。
 *
 * ★ 与 `atStep2()` 是**两个不同的第 2 步**：那三个"选身份 / 填地址 / 下一步"
 * 的 op 只在**已有身份**那一态有意义——新建表单里没有"第 N 个 token"可选。
 */
const atStep2New = (state = atStep2()) => one(state, PN('new-token')).state;

/**
 * 走到向导第 3 步（模型），并且**模型列表已经拉回来了**——
 * 只走到第 3 步的话 `ids` 是空的，什么都勾不上。
 * @param {string[]} [ids]
 */
function atStep3(ids = MODEL_IDS) {
  const s = run(mk(), [T('n'), K('enter'), K('enter')]).state;
  return one(s, { type: 'models', token: s.wizard.token.chosen, ok: true, ids, error: '' }).state;
}

/** 走到向导第 4 步，并勾上第一个模型。 */
const atStep4 = () => run(atStep3(), [K('space'), K('enter')]).state;

// ═══════════════ ★★ 主屏 ═══════════════

describe('★★ app —— 主屏：Enter 只产生"启动"这一个 effect', () => {
  test('★★ 面板不自己 spawn：`Enter` 交出一个 `launch` effect 就完事', () => {
    const { state, effects } = one(mk(), K('enter'));
    assert.deepEqual(types(effects), ['launch'], '★ 有且只有一个 effect');
    assert.equal(effects[0].item.kind, 'cwd');
    assert.equal(effects[0].item.path, '/p/a');
    assert.equal(effects[0].item.token, 'relay-cxt');
    assert.equal(state.pending, true, '★ 启动中要说出来，不能按了没反应');
  });

  test('★ effect 是**数据**：没有函数、能 JSON 化（thunk 会把失败路径赶出测试）', () => {
    const { effects } = one(mk(), K('enter'));
    assert.equal(JSON.stringify(effects), JSON.stringify(JSON.parse(JSON.stringify(effects))));
    for (const e of effects) {
      for (const v of Object.values(e)) assert.notEqual(typeof v, 'function');
    }
  });

  test('★ `Enter` 落在「+ 新建…」上 → 开向导，不是启动', () => {
    const { state, effects } = run(mk(), [K('end'), K('enter')]);
    assert.equal(state.screen, 'wizard');
    assert.equal(state.wizard.step, 1);
    assert.deepEqual(types(effects), ['list-dirs']);
  });

  test('★ 没绑身份的那一项：**说出来**，而不是"按了没反应"', () => {
    const { state, effects } = run(mk(), [K('down'), K('down'), K('enter')]);
    assert.equal(state.data.items[state.cursor].label, '没身份的');
    assert.deepEqual(effects, []);
    assert.match(state.notice, /没有绑定身份/);
    assert.match(state.notice, /n/, '★ 提示里得带上出路');
  });

  test('★ `q` / `Esc` / `Ctrl+C` 都是退出，各产生一个 `quit`', () => {
    for (const ev of [T('q'), K('escape'), C('c')]) {
      const { effects } = one(mk(), ev);
      assert.deepEqual(types(effects), ['quit'], `★ ${JSON.stringify(ev)} 没退出`);
    }
  });

  test('★ `r` 重新读配置；`n` 开向导（并且带上 cwd 作为路径初值）', () => {
    assert.deepEqual(types(one(mk(), T('r')).effects), ['reload']);
    // ★ 用户按的这一下要**擦掉**它自己写的那句「读取配置…」（进行中 → 读完就没了）。
    //   向导写入后的重读**不许**带这个标记，见下面"写成功"那条。
    assert.equal(one(mk(), T('r')).effects[0].clearNotice, true);

    const { state, effects } = one(mk(), T('n'));
    assert.equal(state.wizard.step, 1);
    assert.equal(state.wizard.path.text, '/p/agent_multi_token', '★ 路径预填 cwd');
    assert.deepEqual(effects, [{ type: 'list-dirs', path: '/p/agent_multi_token' }]);
  });

  test('★ 主屏上粘贴**必须说出来**（静默丢掉会让用户一直粘）', () => {
    const { state, effects } = one(mk(), P('sk-abc'));
    assert.deepEqual(effects, []);
    assert.match(state.notice, /粘贴/);
    assert.match(state.notice, /向导/);
  });

  test('★ 认不出的按键显示在标题行，不静默', () => {
    assert.match(one(mk(), U('ESC [ 99~')).state.notice, /99/);
  });

  test('★ 导航：↑↓/Home/End 走光标，PgDn 显式滚 `top`', () => {
    assert.equal(one(mk(), K('down')).state.cursor, 1);
    assert.equal(one(mk(), K('up')).state.cursor, 0, '★ 顶端不越界');
    assert.equal(one(mk(), K('end')).state.cursor, ITEMS.length - 1);
    assert.equal(one(mk(), K('home')).state.cursor, 0);

    // PgDn：窗口装不下时 top 必须整页滚（只靠 scrollTop 会"按了没反应"）
    const many = Array.from({ length: 60 }, (_, i) => ({ kind: 'token', label: `身份-${i}`, token: `t${i}` }));
    const st = mk({ items: many });
    const h = listHeight(st, st.view);
    const r = one(st, K('pgdn')).state;
    assert.equal(r.top, h, '★ 整页滚');
    assert.equal(r.cursor, h);
    assert.equal(r.top, scrollTop({ top: r.top, len: many.length, h, cursor: r.cursor }));
  });

  test('★ `ctrl+a` 之类的别的组合键什么都不做（也不炸）', () => {
    const { state, effects } = one(mk(), C('a'));
    assert.deepEqual(effects, []);
    assert.equal(state.notice, '');
  });

  test('★ `e` 改模型：直接进第 3 步并**立刻拉模型**', () => {
    const { state, effects } = one(mk(), T('e'));
    assert.equal(state.screen, 'wizard');
    assert.equal(state.wizard.step, 3);
    assert.equal(state.wizard.edit, true, '★ edit 标记决定第 3 步 Enter 走哪条落点');
    assert.deepEqual(state.wizard.models.checked, ['m1'], '★ 带上当前生效的模型');
    assert.deepEqual(effects, [{ type: 'fetch-models', token: 'relay-cxt' }]);
  });

  test('★ `e` 在没有可写层 / 没有身份 / 是「新建」时都明说原因', () => {
    assert.match(run(mk(), [K('down'), K('down'), T('e')]).state.notice, /没有绑定身份/);
    assert.match(run(mk(), [K('end'), T('e')]).state.notice, /不能改模型/);

    const noLayer = mk({ items: [{ kind: 'token', label: 'relay-a', token: 'relay-a', layer: 'none' }] });
    assert.match(one(noLayer, T('e')).state.notice, /改不了/);
  });
});

describe('★ app —— 删除确认框是**独占**的', () => {
  test('★ `d` 落在绑定上 → 开确认框；落在别处 → 明说', () => {
    const on = run(mk(), [K('down'), T('d')]).state; // 第 1 项是路径绑定
    assert.equal(on.confirm?.kind, 'delete-binding');
    assert.equal(on.confirm.path, '/p/b');

    // ★ "别处" = **当前目录那一行**。它虽然也解析出一个路径，但它不是一条
    //   "路径绑定"条目，删它没有意义——所以是明说，不是开框。
    assert.match(run(mk(), [T('d')]).state.notice, /只有路径绑定能删/);
    assert.equal(run(mk(), [K('end'), T('d')]).state.confirm, null);

    // ★★ 悬空绑定（第 3 行）反过来**必须**能删：它是真绑定，只是身份没了。
    //   不给删的话，用户就永远清不掉这条烂绑定——"没有出口"正是要避免的。
    const dangling = run(mk(), [K('down'), K('down'), T('d')]).state;
    assert.equal(dangling.confirm?.path, '/p/c');
  });

  test('★★ 确认框开着时，别的按键一律不通（否则"手滑按了 n，绑定没了还开了个向导"）', () => {
    const { state, effects } = run(mk(), [K('down'), T('d'), T('n')]);
    assert.equal(state.confirm, null, '★ 非 y 一律当取消');
    assert.equal(state.screen, 'list');
    assert.equal(state.wizard, null, '★ 不许顺手开向导');
    assert.deepEqual(effects, [], '★ 尤其不许产生 delete-binding');
    assert.equal(state.notice, '已取消');
  });

  test('★★ 只有明确的 `y` 才删——`Enter` 是**取消**（标题写着 `[y/N]`）', () => {
    // 这条曾经是反的：`Enter` 也当"是"，而标题行一直写着 `[y/N]`。
    // 破坏性操作的默认值必须是否（`pick.js` 的 `promptConfirm()` 同一条纪律）——
    // 何况 `Enter` 在面板上还是"启动"键，肌肉记忆早就在那儿了。
    for (const ev of [K('enter'), T('q'), T('n'), K('escape')]) {
      const { state, effects } = run(mk(), [K('down'), T('d'), ev]);
      assert.deepEqual(types(effects), [], `★ ${JSON.stringify(ev)} 不该删`);
      assert.equal(state.notice, '已取消');
    }
  });

  test('★ `y`（大小写都认）才删，且**只有**一个 delete-binding', () => {
    for (const ev of [T('y'), T('Y')]) {
      const { state, effects } = run(mk(), [K('down'), T('d'), ev]);
      assert.deepEqual(types(effects), ['delete-binding'], `★ ${JSON.stringify(ev)} 没删`);
      assert.equal(effects[0].path, '/p/b');
      assert.equal(state.confirm, null);
      assert.equal(state.pending, true);
    }
  });

  test('★ `Esc` 也算取消（不是退出面板）', () => {
    const { state, effects } = run(mk(), [K('down'), T('d'), K('escape')]);
    assert.deepEqual(effects, []);
    assert.equal(state.notice, '已取消');
    assert.equal(state.screen, 'list', '★ 面板还开着');
  });

  test('★ 删除结果回来了才收尾', () => {
    const ok = run(mk(), [K('down'), T('d'), T('y'), { type: 'deleted', ok: true }]).state;
    assert.match(ok.notice, /已删除/);
    assert.equal(ok.pending, false);

    const bad = run(mk(), [K('down'), T('d'), T('y'), { type: 'deleted', ok: false, error: 'EACCES' }]).state;
    assert.match(bad.notice, /EACCES/);
  });
});

// ═══════════════ ★★ 输入模式独占键盘 ═══════════════

describe('★★ app —— 输入框聚焦时 `q`/`n`/`r` 都是**文本**，不是命令', () => {
  test('★★ 第 1 步输路径时打得进字母 `q`（否则路径里带 q 的目录就没法输）', () => {
    const { state, effects } = run(mk(), [T('n'), T('q')]);
    assert.equal(state.screen, 'wizard', '★ 不许退出面板');
    assert.equal(state.wizard.path.text, '/p/agent_multi_tokenq');
    assert.deepEqual(types(effects), ['list-dirs', 'list-dirs'], '★ 两次都只是重列子目录');
  });

  test('★ 第 2 步新建 token 时 `q`/`n` 进的是名字', () => {
    const { state } = run(mk(), [T('n'), K('enter'), T('n'), T('qn')]);
    assert.equal(state.wizard.token.mode, 'new');
    assert.equal(state.wizard.token.name, 'qn');
  });

  test('★★ 只有 `Esc` 与 `Ctrl+C` 能穿过输入模式', () => {
    const esc = run(mk(), [T('n'), K('escape')]).state;
    assert.equal(esc.screen, 'list', '★ Esc 回上一层');
    assert.equal(esc.wizard, null);

    const ctrl = run(mk(), [T('n'), C('c')]).state;
    assert.match(ctrl.notice, /退出/);
  });

  test('★ 第 3 步过滤态里打字进的是过滤串，`Esc` 退出过滤态而**不是**退一步', () => {
    const filtering = one(atStep3(), T('/')).state;
    assert.equal(filtering.wizard.models.filtering, true);

    const typed = run(filtering, [T('sol')]).state;
    assert.equal(typed.wizard.models.filter, 'sol');

    const out = one(typed, K('escape')).state;
    assert.equal(out.wizard.models.filtering, false);
    assert.equal(out.wizard.models.filter, '', '★ 退出过滤态顺手清空');
    assert.equal(out.wizard.step, 3, '★ 还在第 3 步，没退到第 2 步');
  });
});

// ═══════════════ ★★ 向导：每步的 Enter / Esc 去向 ═══════════════

describe('★★ app —— 向导每步的 Enter/Esc 去向', () => {
  test('★★ 1/4 Enter → 2/4；Esc → 回主屏（**不是**退出面板）', () => {
    const s1 = one(mk(), T('n')).state;
    assert.equal(s1.wizard.step, 1);

    assert.equal(one(s1, K('enter')).state.wizard.step, 2);

    const back = one(s1, K('escape')).state;
    assert.equal(back.screen, 'list');
    assert.equal(back.wizard, null, '★ 退回主屏，面板还开着');
  });

  test('★★ Esc 是**逐层退**：3/4 → 2/4 → 1/4 → 主屏（连按三下才出去）', () => {
    let s = atStep3();
    assert.equal(s.wizard.step, 3);
    s = one(s, K('escape')).state;
    assert.equal(s.wizard.step, 2);
    s = one(s, K('escape')).state;
    assert.equal(s.wizard.step, 1);
    s = one(s, K('escape')).state;
    assert.equal(s.screen, 'list');
  });

  test('★ 1/4 路径为空 → 拦下来并说明', () => {
    const s1 = one(mk(), T('n')).state;
    const blank = { ...s1, wizard: { ...s1.wizard, path: { ...s1.wizard.path, text: '   ' } } };
    const { state, effects } = one(blank, K('enter'));
    assert.equal(state.wizard.step, 1, '★ 不许带着空路径往下走');
    assert.match(state.wizard.notice, /不能为空/);
    assert.deepEqual(effects, []);
  });

  test('★★ 2/4 Enter 选中身份 → 3/4 并**立刻拉模型**', () => {
    const s2 = atStep2();
    assert.equal(s2.wizard.step, 2);

    const { state, effects } = one(s2, K('enter'));
    assert.equal(state.wizard.step, 3);
    assert.equal(state.wizard.token.chosen, 'relay-cxt');
    assert.deepEqual(effects, [{ type: 'fetch-models', token: 'relay-cxt' }]);
    assert.equal(state.wizard.models.phase, 'loading', '★ 进第 3 步就是拉取中');
  });

  test('★ 2/4 最后一行是「+ 新建 token…」，Enter 进新建态', () => {
    const { state, effects } = run(atStep2(), [K('down'), K('down'), K('enter')]);
    assert.equal(state.wizard.token.mode, 'new');
    assert.deepEqual(effects, [], '★ 还没保存，不许发 save-token');
  });

  test('★★ 3/4 Enter → 4/4；4/4 Enter → 两个都写（一个 apply-wizard effect）', () => {
    const s3 = atStep3();
    assert.equal(one(s3, K('enter')).state.wizard.step, 4);

    const { state, effects } = one(atStep4(), K('enter'));
    assert.deepEqual(types(effects), ['apply-wizard']);
    assert.equal(effects[0].path, '/p/agent_multi_token');
    assert.equal(effects[0].token, 'relay-cxt');
    assert.deepEqual(effects[0].models, ['gpt-5.6-sol']);
    assert.equal(state.pending, true);
  });

  test('★ 4/4 的 `q` 是**返回**（不是退出面板）——那一屏刚敲完，别一键清空', () => {
    const { state, effects } = one(atStep4(), T('q'));
    assert.deepEqual(effects, []);
    assert.equal(state.wizard.step, 3);
  });

  test('★ 4/4 没选身份就 Enter → 拦下来（否则写出一个没有 token 的绑定）', () => {
    const s4 = atStep4();
    const broken = { ...s4, wizard: { ...s4.wizard, token: { ...s4.wizard.token, chosen: '' } } };
    const { state, effects } = one(broken, K('enter'));
    assert.deepEqual(effects, []);
    assert.match(state.wizard.notice, /没有选定身份/);
  });
});

// ═══════════════ ★★ 第 3 步：勾选顺序 = 优先级 ═══════════════

describe('★★ app —— 勾选顺序 = 优先级（`checked` 是数组，不是集合）', () => {
  test('★★ 按勾选先后排：先勾 c、再勾 a、再勾 b → [c, a, b]', () => {
    let s = atStep3(['a', 'b', 'c']);
    assert.deepEqual(visibleModels(s.wizard.models), ['a', 'b', 'c'], '★ 初始是服务端原序');

    s = run(s, [K('down'), K('down'), K('space')]).state; // 勾 c
    assert.deepEqual(s.wizard.models.checked, ['c']);
    assert.deepEqual(visibleModels(s.wizard.models), ['c', 'a', 'b'], '★ 已勾选的排前面');

    s = run(s, [K('up'), K('space')]).state; // 勾 a
    s = run(s, [K('down'), K('space')]).state; // 勾 b
    assert.deepEqual(s.wizard.models.checked, ['c', 'a', 'b'], '★ 勾选顺序即优先级');
  });

  test('★★ 取消再勾上会**排到末尾**——这不是 bug，是"最后勾的优先级最低"', () => {
    let s = atStep3(['a', 'b', 'c']);
    s = run(s, [K('home'), K('space')]).state; // 勾 a
    s = run(s, [K('down'), K('space')]).state; // 勾 b
    assert.deepEqual(s.wizard.models.checked, ['a', 'b']);

    s = run(s, [K('home'), K('space')]).state; // 取消 a
    assert.deepEqual(s.wizard.models.checked, ['b']);
    assert.deepEqual(visibleModels(s.wizard.models), ['b', 'a', 'c']);

    s = run(s, [K('down'), K('space')]).state; // 再勾 a
    assert.deepEqual(s.wizard.models.checked, ['b', 'a'], '★ 排到末尾');
  });

  test('★ 勾选不改变 `ids` 的顺序（不许替服务端排序）', () => {
    const s = run(atStep3(['a', 'b', 'c']), [K('down'), K('space')]).state;
    assert.deepEqual(s.wizard.models.ids, ['a', 'b', 'c']);
  });

  test('★★ `s` 跳过 → **清空勾选**再走（留着半个列表走人 = 用户以为跳过了）', () => {
    let s = run(atStep3(), [K('space')]).state;
    assert.deepEqual(s.wizard.models.checked, ['gpt-5.6-sol']);

    s = one(s, T('s')).state;
    assert.equal(s.wizard.step, 4);
    assert.deepEqual(s.wizard.models.checked, [], '★ 跳过得真的跳干净');
    assert.match(s.wizard.models.notice, /跳过/);
  });

  test('★ `m` 手敲 id：Enter 加入勾选，Esc 取消', () => {
    const s3 = atStep3(['a', 'b']);
    let s = one(s3, T('m')).state;
    assert.equal(s.wizard.models.manual, true);

    s = run(s, [T('my-model'), K('enter')]).state;
    assert.equal(s.wizard.models.manual, false);
    assert.deepEqual(s.wizard.models.checked, ['my-model']);
    assert.match(s.wizard.models.notice, /my-model/);

    const cancelled = run(one(s3, T('m')).state, [T('xx'), K('escape')]).state;
    assert.equal(cancelled.wizard.models.manual, false);
    assert.deepEqual(cancelled.wizard.models.checked, [], '★ Esc 不该把手敲的东西加进去');
    assert.equal(cancelled.wizard.step, 3, '★ 还在第 3 步');
  });

  test('★ 手敲空 id 被拦下', () => {
    const s = run(atStep3([]), [T('m'), K('enter')]).state;
    assert.equal(s.wizard.models.manual, true);
    assert.match(s.wizard.models.notice, /不能为空/);
  });

  test('★ `r` 重试拉取', () => {
    assert.deepEqual(types(one(atStep3([]), T('r')).effects), ['fetch-models']);
  });

  test('★ 拉取失败：三条出路都在，且**不卡死**', () => {
    const s3 = run(mk(), [T('n'), K('enter'), K('enter')]).state;
    const failed = one(s3, { type: 'models', token: 'relay-cxt', ok: false, ids: [], error: 'HTTP 502' }).state;
    assert.equal(failed.wizard.models.phase, 'fail');
    assert.equal(failed.wizard.models.error, 'HTTP 502');

    // ① 重试 ② 手敲 ③ 跳过 —— 三条都得通
    assert.deepEqual(types(one(failed, T('r')).effects), ['fetch-models']);
    assert.equal(one(failed, T('m')).state.wizard.models.manual, true);
    assert.equal(one(failed, T('s')).state.wizard.step, 4);
  });

  test('★ 拉取失败但没给原因 → 给一句能读的话，不是空字符串', () => {
    const s3 = run(mk(), [T('n'), K('enter'), K('enter')]).state;
    const failed = one(s3, { type: 'models', token: 'relay-cxt', ok: false, ids: [], error: '' }).state;
    assert.ok(failed.wizard.models.error.length > 0);
  });
});

// ═══════════════ ★★ 陈旧响应守卫 ═══════════════

describe('★★ app —— 异步结果是**陈旧**的就不认（否则列表会跳回上一个目录）', () => {
  test('★★ 路径已经改了，晚到的旧 `dirs` 不许覆盖新列表', () => {
    // 快速敲路径时每个字符都发一个 list-dirs；晚到的旧结果会把列表跳回
    // 上一个目录的内容，看起来像"输错了"。
    const s = run(mk(), [T('n'), T('x')]).state;
    assert.equal(s.wizard.path.text, '/p/agent_multi_tokenx');

    const stale = one(s, { type: 'dirs', path: '/p/agent_multi_token', names: ['旧的', '陈旧的'] }).state;
    assert.deepEqual(stale.wizard.path.dirs, [], '★ 旧结果被丢掉');
    assert.equal(stale.wizard.path.pending, true, '★ 还在等新结果');

    const fresh = one(s, { type: 'dirs', path: '/p/agent_multi_tokenx', names: ['新的'] }).state;
    assert.deepEqual(fresh.wizard.path.dirs, ['新的']);
    assert.equal(fresh.wizard.path.pending, false);
  });

  test('★ 人已经不在第 1 步了，`dirs` 回来也不认', () => {
    const r = one(atStep2(), { type: 'dirs', path: '/p/agent_multi_token', names: ['x'] }).state;
    assert.equal(r.wizard.step, 2);
    assert.equal(r.wizard.path.dirs.length, 0);
  });

  test('★★ 身份已经换了，晚到的旧 `models` 不许覆盖新列表', () => {
    const s3 = run(mk(), [T('n'), K('enter'), K('enter')]).state;
    assert.equal(s3.wizard.token.chosen, 'relay-cxt');

    const stale = one(s3, { type: 'models', token: 'relay-a', ok: true, ids: ['别人的模型'], error: '' }).state;
    assert.equal(stale.wizard.models.phase, 'loading', '★ 旧结果被丢掉，还在等');
    assert.deepEqual(stale.wizard.models.ids, []);
  });

  test('★ 人已经退出向导了，`models` 回来不炸也不复活向导', () => {
    // ★ `Esc` 是**逐层退**（3 → 2 → 1 → 主屏），所以从第 3 步回主屏要三下。
    //   这里正好把这条也钉住：少按一下，下面断言的就是"还在向导里"。
    const back = run(atStep3(), [K('escape'), K('escape'), K('escape')]).state;
    assert.equal(back.screen, 'list');
    assert.equal(back.wizard, null);
    const r = one(back, { type: 'models', token: 'relay-cxt', ok: true, ids: ['x'], error: '' }).state;
    assert.equal(r.wizard, null);
    assert.equal(r.screen, 'list');
  });
});

// ═══════════════ ★ 新建 token ═══════════════

describe('★ app —— 新建 token（第 2 步的新建态）', () => {
  /** 进到"新建 token"的两个输入框 */
  const atNewToken = () => run(mk(), [T('n'), K('enter'), T('n')]).state;

  test('★ 名字为空不许往下走；填好自动跳到密钥框', () => {
    let s = atNewToken();
    assert.equal(s.wizard.token.field, 'name');

    assert.match(one(s, K('enter')).state.wizard.token.notice, /名字不能为空/);

    s = run(s, [T('我的身份'), K('enter')]).state;
    assert.equal(s.wizard.token.field, 'secret', '★ 名字填好自动跳密钥');
  });

  test('★ `Tab` 手动切两个框', () => {
    assert.equal(one(atNewToken(), K('tab')).state.wizard.token.field, 'secret');
    assert.equal(run(atNewToken(), [K('tab'), K('tab')]).state.wizard.token.field, 'name');
  });

  test('★★ 密钥不能为空；填好后**只有一个** `save-token`，且是 trim 过的', () => {
    const s = run(atNewToken(), [T('我的身份'), K('enter')]).state;
    const empty = one(s, K('enter'));
    assert.deepEqual(empty.effects, []);
    assert.match(empty.state.wizard.token.notice, /密钥不能为空/);

    const filled = run(s, [T('  sk-abc  ')]).state;
    const { state, effects } = one(filled, K('enter'));
    assert.deepEqual(effects, [{ type: 'save-token', name: '我的身份', secret: 'sk-abc' }]);
    assert.equal(state.pending, true);
  });

  test('★ 名字里能打空格；密钥里**不能**（空格是粘贴事故的常见残留）', () => {
    let s = run(atNewToken(), [T('a'), K('space'), T('b')]).state;
    assert.equal(s.wizard.token.name, 'a b');

    s = run(s, [K('enter'), T('sk'), K('space'), T('x')]).state;
    assert.equal(s.wizard.token.secret, 'skx');
  });

  test('★★ 粘贴进密钥框：控制字符被剥掉（复制来的 key 十有八九带个尾换行）', () => {
    // ★ 得先填名字才进得了密钥框（`atNewToken()` 停在名字框上）——
    //   少了这一步，粘贴会落进**名字**框，测试就变成"测了个寂寞"。
    const s = run(atNewToken(), [T('relay-b'), K('enter'), P('sk-abc\r\n')]).state;
    assert.equal(s.wizard.token.name, 'relay-b');
    assert.equal(s.wizard.token.secret, 'sk-abc', '★ 尾换行绝不能进 token 文件');
  });

  test('★ 粘贴被截断要说出来', () => {
    const s = run(atNewToken(), [T('relay-b'), K('enter'), P('sk-a', true)]).state;
    assert.match(s.wizard.token.notice, /截断/);
    assert.equal(s.wizard.token.secret, 'sk-a', '★ 截断的那截照样得进去');
  });

  test('★ `Esc` 从新建态退回选身份，**不丢**已经走到的那一步', () => {
    const s = run(atNewToken(), [T('x'), K('escape')]).state;
    assert.equal(s.wizard.token.mode, 'pick');
    assert.equal(s.wizard.step, 2, '★ 还在第 2 步');
    assert.equal(s.wizard.token.name, '', '★ 半截名字清掉，免得下次进来以为已经填了');
  });

  test('★★ 存好了：拿这个名字当选中身份进第 3 步，并且**重读配置**（新 token 要出现在主屏）', () => {
    const s = run(atNewToken(), [T('新身份'), K('enter'), T('sk-abc')]).state;
    const { state, effects } = one(s, { type: 'token-saved', ok: true, name: '新身份' });
    assert.deepEqual(types(effects), ['fetch-models', 'reload']);
    assert.equal(state.wizard.step, 3);
    assert.equal(state.wizard.token.chosen, '新身份');
    assert.equal(state.pending, false);
  });

  test('★ 存失败：留在原地，把原因说出来', () => {
    const s = run(atNewToken(), [T('新身份'), K('enter'), T('sk-abc'), K('enter')]).state;
    const r = one(s, { type: 'token-saved', ok: false, name: '新身份', error: 'EACCES' }).state;
    assert.equal(r.wizard.step, 2);
    assert.match(r.wizard.token.notice, /EACCES/);
    assert.equal(r.pending, false);
  });
});

// ═══════════════ ★ 改模型（edit）与写入结果 ═══════════════

describe('★ app —— `e` 改模型走的是另一条落点', () => {
  test('★★ edit：第 3 步 Enter 直接写（不经过第 4 步），且发的是 `apply-models`', () => {
    const s = one(mk(), T('e')).state;
    const { state, effects } = one(s, K('enter'));
    assert.deepEqual(types(effects), ['apply-models']);
    assert.equal(effects[0].target.layer, 'binding', '★ 只改当前生效那一层');
    assert.equal(effects[0].target.path, '/p/a');
    assert.equal(state.wizard.step, 3, '★ 不往下走了');
  });

  test('★★ edit：`Esc` 直接回主屏（改模型没有"逐层退"的意义）', () => {
    const back = one(one(mk(), T('e')).state, K('escape')).state;
    assert.equal(back.screen, 'list');
    assert.equal(back.wizard, null);
    assert.equal(back.notice, '已取消');
  });

  test('★★ 写成功：回主屏 + **重读配置**（否则主屏还是旧的，用户以为没生效）', () => {
    const { state, effects } = one(atStep4(), { type: 'applied', ok: true, wrote: ['全局 config.json', '.cxt.json'] });
    assert.equal(state.screen, 'list');
    assert.equal(state.wizard, null);
    assert.equal(state.cursor, 0, '★ 光标归位');
    assert.deepEqual(types(effects), ['reload']);
    // ★ 这一次重读**不许**带 `clearNotice`：它要留住「已写入 ✓」——那是**回执**，
    //   不是"还在读"。擦掉它，用户就看不见"到底写成功了没有"。
    assert.equal(effects[0].clearNotice, undefined, '★ 回执不许被重读擦掉');
    assert.match(state.notice, /已写入/);
    assert.match(state.notice, /\.cxt\.json/, '★ 写了哪两个要说出来');
  });

  test('★ 写失败：留在第 4 步，把原因说出来', () => {
    const r = one(atStep4(), { type: 'applied', ok: false, error: 'EROFS' }).state;
    assert.equal(r.wizard.step, 4, '★ 不许假装写成功了');
    assert.match(r.wizard.notice, /EROFS/);
    assert.equal(r.pending, false);
  });

  test('★ 启动结果回来了：`pending` 收尾，成功/失败都要说', () => {
    const ok = run(mk(), [K('enter'), { type: 'launched', ok: true }]).state;
    assert.match(ok.notice, /已启动/);
    assert.equal(ok.pending, false);

    const bad = run(mk(), [K('enter'), { type: 'launched', ok: false, error: 'ENOENT' }]).state;
    assert.match(bad.notice, /ENOENT/);
  });
});

// ═══════════════ ★★ 文本按字符折开 ═══════════════

describe('★★ app —— 多字符文本**逐字符**走完整条分发', () => {
  test('★★ `nr` 一个 chunk 进来：`n` 开向导，`r` 进的是**向导第 1 步的路径**，不是主屏的刷新', () => {
    const { state, effects } = one(mk(), T('nr'));
    assert.equal(state.screen, 'wizard');
    assert.equal(state.wizard.path.text, '/p/agent_multi_tokenr', '★ 第二个字符归向导');
    assert.deepEqual(types(effects), ['list-dirs', 'list-dirs'], '★ 不许出现 reload');
  });

  test('★★ `nq`：`q` 是路径里的字，**不许**把面板关掉', () => {
    const { state, effects } = one(mk(), T('nq'));
    assert.equal(state.screen, 'wizard');
    assert.equal(state.wizard.path.text, '/p/agent_multi_tokenq');
    assert.deepEqual(effects.filter((e) => e.type === 'quit'), [], '★ 一键退出是最不能出的错');
  });

  test('★ `qq` 在主屏上：只出一个 quit', () => {
    assert.deepEqual(types(one(mk(), T('qq')).effects), ['quit']);
  });

  test('★★ 决定退出之后，**什么都推不动它了**', () => {
    // 退出是终态。这里把"退出后再来一串按键"整个走一遍：
    // 不许改状态、不许再发 effect——尤其不许因为某个键又开出一个向导，
    // 那样驱动侧会一边收尾一边被要求画新屏。
    const out = run(mk(), [T('q'), T('n'), K('enter'), T('r'), T('d'), K('down'), C('c')]);
    assert.deepEqual(types(out.effects), ['quit'], '★ 只有最初那一个 quit');
    assert.equal(out.state.screen, 'list');
    assert.equal(out.state.wizard, null);
    assert.equal(out.state.cursor, 0, '★ 连光标都不许动');
    assert.equal(out.state.quitting, true);
  });

  test('★ 单字符分两次喂与一次喂结果一致', () => {
    assert.deepEqual(one(mk(), T('nr')).state, run(mk(), [T('n'), T('r')]).state);
  });

  test('★ 空文本不炸', () => {
    const { state, effects } = one(mk(), T(''));
    assert.deepEqual(effects, []);
    assert.equal(state.screen, 'list');
  });
});

// ═══════════════ ★★ sanitize ═══════════════

describe('★★ app —— sanitize：控制字符在**输入框那一层**剥掉', () => {
  test('★★ C0 与 DEL 全剥，可见字符一个不动', () => {
    assert.equal(sanitize('a\u0000b\u001bcd\u0001e'), 'abcde');
    assert.equal(sanitize('sk-abc\r\n'), 'sk-abc');
    assert.equal(sanitize('a\tb'), 'ab', '★ Tab 也不能留（它是"切换输入框"的键）');
    assert.equal(sanitize('中文/路径 with spaces'), '中文/路径 with spaces');
  });

  test('★ 空值安全', () => {
    assert.equal(sanitize(null), '');
    assert.equal(sanitize(undefined), '');
    assert.equal(sanitize(123), '123');
  });

  test('★ 剥在输入框这一层：手敲的与粘贴的走同一条路', () => {
    // 只在 paste 事件上剥的话，会得到"粘进去的干净、敲进去的不干净"这种一半对一半错的状态
    const typed = run(mk(), [T('n'), T('a\u0007b')]).state;
    const pasted = run(mk(), [T('n'), P('a\u0007b')]).state;
    assert.equal(typed.wizard.path.text, pasted.wizard.path.text);
    assert.equal(typed.wizard.path.text, '/p/agent_multi_tokenab');
  });
});

// ═══════════ ★★ 第二条输入通道：网页控制台的 `panel` 事件 ═══════════

/** @param {string} op @param {object} [extra] */
const PN = (op, extra = {}) => ({ type: 'panel', op, ...extra });

describe('★★ app —— `panel` 事件：与按键**走同一条分发**', () => {
  test('★★ 按屏分流：同一个 op 名在主屏与向导里是两件事', () => {
    // `activate` 只在主屏有意义——向导里收到它必须是 no-op，
    // 而不是"顺手拿主屏的光标去启动了一个会话"。
    const w = atStep2();
    const r = one(w, PN('activate', { index: 0 }));
    assert.deepEqual(r.effects, []);
    assert.equal(r.state.screen, 'wizard', '★ 面板的 op 不许把人从向导里踢出去');
  });

  test('★ `quit` 两屏通用（页头那个「退出」按钮在两屏都在）', () => {
    assert.deepEqual(types(one(mk(), PN('quit')).effects), ['quit']);
    assert.deepEqual(types(one(atStep2(), PN('quit')).effects), ['quit']);
  });

  test('★ 向导没开时收到向导 op → no-op（不许凭空造一个向导出来）', () => {
    const r = one(mk(), PN('next'));
    assert.equal(r.state.screen, 'list');
    assert.equal(r.state.wizard, null);
    assert.deepEqual(r.effects, []);
  });

  test('★ 认不出的 op 是 no-op——**不报错**（与"认不出的按键"不同）', () => {
    // 按键报出来是因为人正坐在那儿敲，他要知道自己敲的东西没被理解；
    // 页面上的 op 是代码发的，多出来的只会是**版本不一致**（旧页面 + 新服务器），
    // 弹一句"认不出的操作"给用户看，他既看不懂也做不了什么。
    const r = one(mk(), PN('未来才有的操作'));
    assert.deepEqual(r.effects, []);
    assert.equal(r.state.notice, '');
  });

  test('★★ 退出闸门对面板一样管用（决定退出之后任何 op 都不许改状态）', () => {
    const q = one(mk(), PN('quit')).state;
    assert.equal(q.quitting, true);
    const after = one(q, PN('new'));
    assert.equal(after.state.screen, 'list');
    assert.equal(after.state.wizard, null, '★ 退出途中被 op 开了向导');
  });
});

describe('★★ app —— 主屏的 panel op：**按 index 走，不按光标走**', () => {
  test('★★ `activate{index}` 启动的是**第 index 行**，不是光标所在那一行', () => {
    // 这是整件事的核心：页面上点的是「第 3 行的启动按钮」，
    // 而光标（键盘那边的东西）此刻还在第 1 行。按光标走就会启动错的那一项。
    const s = mk();
    assert.equal(s.cursor, 0, '夹具前提：光标在第 0 行');
    const r = one(s, PN('activate', { index: 1 }));

    assert.deepEqual(types(r.effects), ['launch']);
    assert.equal(r.effects[0].item.label, 'proj', '★ 启动的是被点的那一行');
    assert.equal(r.state.cursor, 1, '★ 光标也跟着过去了（下次用键盘还在这条上）');
  });

  test('★ `activate` 落在「+ 新建…」上 → 开向导（与 Enter 同一条路）', () => {
    const r = one(mk(), PN('activate', { index: 3 }));
    assert.equal(r.state.screen, 'wizard');
    assert.deepEqual(types(r.effects), ['list-dirs']);
  });

  test('★★ 越界 = no-op，**不是**夹到边界上', () => {
    // 越界只可能是"页面拿的是旧状态"（列表刚 reload 过、或另一个标签页刚删了一条）。
    // 夹到边界会变成"点了第 9 行却启动了第 4 行"——那比没反应坏得多。
    for (const index of [-1, 4, 999]) {
      const r = one(mk(), PN('activate', { index }));
      assert.deepEqual(r.effects, [], `★ index=${index} 居然发了 effect`);
      assert.equal(r.state.cursor, 0, `★ index=${index} 把光标挪走了`);
    }
  });

  test('★ index 不是整数 / 不是数字 → no-op（不炸）', () => {
    for (const index of [undefined, null, '1', 1.5, NaN, {}]) {
      const r = one(mk(), PN('activate', { index }));
      assert.deepEqual(r.effects, [], `★ index=${JSON.stringify(index)} 居然发了 effect`);
    }
  });

  test('★ `edit{index}` / `delete{index}` 同样按 index 走', () => {
    const e = one(mk(), PN('edit', { index: 1 }));
    assert.equal(e.state.wizard.step, 3);
    assert.equal(e.state.wizard.edit, true);
    assert.equal(e.state.wizard.token.chosen, 'relay-a', '★ 是第 1 行的身份');

    const d = one(mk(), PN('delete', { index: 1 }));
    assert.equal(d.state.confirm.path, '/p/b', '★ 是第 1 行的路径');
  });

  test('★ `reload` / `new` 回放成按键——语义只有一处定义', () => {
    assert.deepEqual(types(one(mk(), PN('reload')).effects), ['reload']);
    assert.equal(one(mk(), PN('reload')).state.pending, true);

    const n = one(mk(), PN('new'));
    assert.equal(n.state.screen, 'wizard');
    assert.equal(n.state.wizard.step, 1);
  });
});

describe('★★ app —— 确认框对面板也是**独占**的', () => {
  test('★★ 面板的 `confirm-yes` 才删；`confirm-no` 是取消', () => {
    const asking = one(mk(), PN('delete', { index: 1 })).state;

    const no = one(asking, PN('confirm-no'));
    assert.equal(no.state.confirm, null);
    assert.deepEqual(no.effects, []);
    assert.equal(no.state.notice, '已取消');

    const yes = one(asking, PN('confirm-yes'));
    assert.deepEqual(types(yes.effects), ['delete-binding']);
    assert.equal(yes.effects[0].path, '/p/b');
  });

  test('★★ 确认框开着时，面板的别的 op 一律不通', () => {
    // 与按键同一条闸门：`confirmKey` 对**任何**非 yes 的输入都是取消。
    // 页面拿旧状态点出来的「新建」，会变成一次取消——那是安全的那个方向。
    const asking = one(mk(), PN('delete', { index: 1 })).state;
    const r = one(asking, PN('new'));
    assert.equal(r.state.screen, 'list', '★ 确认框开着却被 op 开了向导');
    assert.equal(r.state.confirm, null);
    assert.deepEqual(r.effects, []);
  });

  test('★ 面板上的 `confirm-yes` 与 `y` **完全等价**', () => {
    const asking = one(mk(), PN('delete', { index: 1 })).state;
    assert.equal(
      JSON.stringify(one(asking, PN('confirm-yes'))),
      JSON.stringify(one(asking, T('y'))),
    );
  });
});

describe('★★ app —— 向导的 panel op：**前提不成立就是 no-op**', () => {
  test('★★ 每一步的 op 落在别的步上都是 no-op（不是"夹到最近的一步"）', () => {
    // 页面拿的是旧状态时，宁可"没反应"，也不要"在错误的步骤上执行了正确的动作"——
    // 后者会**静默写错文件**，而用户看到的是一次成功。
    const cases = [
      [atStep2(), PN('set-path', { value: '/tmp' }), '第 2 步收到第 1 步的 set-path'],
      [atStep2(), PN('enter-dir', { index: 0 }), '第 2 步收到第 1 步的 enter-dir'],
      [atStep2(), PN('toggle-model', { id: 'm' }), '第 2 步收到第 3 步的 toggle-model'],
      [atStep2(), PN('move-model', { id: 'm', dir: 1 }), '第 2 步收到第 3 步的 move-model'],
      [atStep2(), PN('skip'), '第 2 步收到第 3 步的 skip'],
      [atStep3(), PN('pick-token', { index: 0 }), '第 3 步收到第 2 步的 pick-token'],
      [atStep3(), PN('save-token'), '第 3 步收到第 2 步的 save-token'],
      [atStep4(), PN('pick-token', { index: 0 }), '第 4 步收到第 2 步的 pick-token'],
      [atStep4(), PN('toggle-model', { id: 'm' }), '第 4 步收到第 3 步的 toggle-model'],
      // ── 第 2 步的"选身份 / 填地址 / 下一步"三件（Web 控制台专用）──
      [atStep2New(), PN('select-token', { index: 1 }), '第 2 步，但还在**新建**表单里就 select-token'],
      [atStep2New(), PN('confirm-token'), '第 2 步，但还在**新建**表单里就 confirm-token'],
      [atStep3(), PN('select-token', { index: 1 }), '第 3 步收到 select-token'],
      [atStep4(), PN('select-token', { index: 1 }), '第 4 步收到 select-token'],
      [atStep3(), PN('set-base-url', { value: 'https://z' }), '第 3 步收到 set-base-url'],
      [atStep4(), PN('set-base-url', { value: 'https://z' }), '第 4 步收到 set-base-url'],
      [atStep3(), PN('confirm-token'), '第 3 步收到 confirm-token'],
      [atStep4(), PN('confirm-token'), '第 4 步收到 confirm-token'],
    ];
    for (const [before, ev, why] of cases) {
      const r = one(before, ev);
      assert.equal(JSON.stringify(r.state), JSON.stringify(before), `★ ${why}：状态被改了`);
      assert.deepEqual(r.effects, [], `★ ${why}：发了 effect`);
    }
  });

  test('★★ `apply` 只在第 4 步（或 edit 的第 3 步）生效', () => {
    // 那个按钮写着「写入」。它不该有"其实只是翻了一页"的可能——
    // 所以 `apply` **不回放 Enter**，直接调 `applyNow`，并且先验步骤。
    assert.deepEqual(types(one(atStep4(), PN('apply')).effects), ['apply-wizard']);

    const edit = one(mk(), PN('edit', { index: 1 })).state;
    assert.equal(edit.wizard.step, 3);
    assert.deepEqual(types(one(edit, PN('apply')).effects), ['apply-models']);

    for (const s of [mk(), atStep2(), atStep3()]) {
      assert.deepEqual(one(s, PN('apply')).effects, [], '★ 不该在这一步写入');
    }
  });

  test('★★ `next` 回放 Enter：与按键**逐字一致**', () => {
    // 「下一步」按钮的含义完全由既有的 handler 定义——这正是 `replay()` 存在的理由。
    // ⚠️ 只在**向导**里比：主屏上的 Enter 是"启动"，而 `next` 是向导的 op，
    //    两者本来就该不一样（`next` 在主屏是 no-op，有另一条测试钉着）。
    for (const before of [atStep2(), atStep3(), atStep4()]) {
      assert.equal(
        JSON.stringify(one(before, PN('next'))),
        JSON.stringify(one(before, K('enter'))),
        '★ `next` 与 Enter 走岔了',
      );
    }
  });

  test('★ `back` 回放 Esc 的**逐层退**（不是一步回主屏）', () => {
    assert.equal(one(atStep3(), PN('back')).state.wizard.step, 2);
    assert.equal(one(atStep2(), PN('back')).state.wizard.step, 1);
    // 第 1 步再退才回主屏——连退两次，不是一次
    assert.equal(run(atStep2(), [PN('back'), PN('back')]).state.screen, 'list');
    assert.equal(run(atStep2(), [PN('back')]).state.screen, 'wizard', '★ 一步就回主屏了');
  });
});

describe('★ app —— 向导各步的 panel op', () => {
  test('★ `set-path{value}` 设文本并立刻列目录；控制字符被剥掉', () => {
    const r = one(atStep2(), PN('back')).state;
    assert.equal(r.wizard.step, 1);

    // ⚠️ 下面那个串里两个控制字符都是**转义写法**，不是裸字节：中间的是 U+0000
    //    （`\uXXXX` 里最低的那个），末尾是换行——粘贴来的路径十有八九带个尾换行。
    //    写成裸字节的话 `source-hygiene.test.js` 会当场把它列出来，而人眼看这两行
    //    **一模一样**（那条规则自己就踩过五次，原因正在这儿）。

    const p = one(r, PN('set-path', { value: '/tmp\u0000x\n' }));
    assert.equal(p.state.wizard.path.text, '/tmpx');
    assert.deepEqual(types(p.effects), ['list-dirs']);
    assert.equal(p.effects[0].path, '/tmpx');
  });

  test('★ `enter-dir{index}` 把 `path.dirs[index]` 拼进路径（不是光标那一行）', () => {
    let s = one(atStep2(), PN('back')).state;
    s = one(s, { type: 'dirs', path: s.wizard.path.text, names: ['aa', 'bb', 'cc'] }).state;
    s = one(s, PN('set-path', { value: '/p' })).state;
    s = one(s, { type: 'dirs', path: '/p', names: ['aa', 'bb', 'cc'] }).state;

    const r = one(s, PN('enter-dir', { index: 2 }));
    assert.equal(r.state.wizard.path.text, '/p/cc', '★ 拼的是被点的那一个目录');

    // 越界 → no-op（页面拿的是旧目录列表）
    const oob = one(s, PN('enter-dir', { index: 9 }));
    assert.equal(oob.state.wizard.path.text, '/p');
    assert.deepEqual(oob.effects, []);
  });

  test('★ `pick-token{index}` 选中第 index 个身份并进第 3 步', () => {
    const r = one(atStep2(), PN('pick-token', { index: 1 }));
    assert.equal(r.state.wizard.token.chosen, 'relay-a');
    assert.equal(r.state.wizard.step, 3);
    assert.deepEqual(types(r.effects), ['fetch-models']);

    const oob = one(atStep2(), PN('pick-token', { index: 9 }));
    assert.equal(oob.state.wizard.step, 2, '★ 越界不许往下走');
    assert.deepEqual(oob.effects, []);
  });

  test('★ `new-token` / `set-token-name` / `set-secret` 只在新建态生效', () => {
    const fresh = one(atStep2(), PN('new-token')).state;
    assert.equal(fresh.wizard.token.mode, 'new');

    const named = one(fresh, PN('set-token-name', { value: 'relay-z' }));
    assert.equal(named.state.wizard.token.name, 'relay-z');

    const secret = one(named.state, PN('set-secret', { value: 'sk-aaaa11112222' }));
    assert.equal(secret.state.wizard.token.secret, 'sk-aaaa11112222');

    // 不在新建态时，这三个都不许动
    const picking = atStep2();
    assert.equal(picking.wizard.token.mode, 'pick');
    for (const ev of [PN('set-token-name', { value: 'x' }), PN('set-secret', { value: 'x' })]) {
      assert.equal(one(picking, ev).state.wizard.token.mode, 'pick');
      assert.equal(one(picking, ev).state.wizard.token.name, '');
    }
  });

  test('★★ `save-token`：名字为空被**面板这条补的坎**拦下', () => {
    // 表单里名字与密钥同时可见，所以面板这条路上名字那道坎得在这儿补——
    // TUI 那条是 Enter 落在名字框上时先挡的。
    const fresh = one(atStep2(), PN('new-token')).state;
    const filled = one(fresh, PN('set-secret', { value: 'sk-aaaa11112222' })).state;

    const r = one(filled, PN('save-token'));
    assert.deepEqual(r.effects, [], '★ 没有名字却发了 save-token');
    assert.match(r.state.wizard.token.notice, /名字不能为空/);
  });

  test('★★ `save-token` 与 TUI 的 Enter **同一个落点**（都 trim、都只发一个 effect）', () => {
    const fresh = one(atStep2(), PN('new-token')).state;
    const viaPanel = run(fresh, [PN('set-token-name', { value: ' relay-z ' }), PN('set-secret', { value: ' sk-aaaa11112222 ' }), PN('save-token')]);
    const viaKeys = run(fresh, [T(' relay-z '), K('enter'), T(' sk-aaaa11112222 '), K('enter')]);

    assert.deepEqual(viaPanel.effects, viaKeys.effects);
    assert.deepEqual(viaPanel.effects, [{ type: 'save-token', name: 'relay-z', secret: 'sk-aaaa11112222' }]);
  });

  test('★ `retry` / `skip` 回放 `r` / `s`', () => {
    assert.deepEqual(types(one(atStep3(), PN('retry')).effects), ['fetch-models']);
    const skipped = one(atStep3(), PN('skip')).state;
    assert.equal(skipped.wizard.step, 4);
    assert.deepEqual(skipped.wizard.models.checked, [], '★ 跳过要清空勾选');
  });

  // ── 第 2 步：地址 ↔ 身份 的联动（Web 控制台专用）──
  //
  // 这一段全是给网页准备的：键盘那边"选身份"就是 Enter（选中即进第 3 步），
  // 网页上得能**只看不选**（选一下就要联网拉模型，会让人不敢试）。
  // 三个 op 一律不写盘——真正写回 token 文件发生在第 4 步的 `apply-wizard`。

  test('★ `select-token{index}` 换选中项与地址，**不换步、不联网**', () => {
    const s = atStep2();
    assert.equal(s.wizard.token.chosen, '', '夹具前提：还没选');
    assert.equal(s.wizard.token.baseUrl, '');

    const r = one(s, PN('select-token', { index: 1 }));
    assert.equal(r.state.wizard.token.chosen, 'relay-a');
    assert.equal(r.state.wizard.token.baseUrl, 'https://y', '★ 地址跟着身份走');
    assert.equal(r.state.wizard.token.urlEdited, false, '★ 从文件里读出来的地址没什么要写回');
    assert.equal(r.state.wizard.step, 2, '★ 选一下就把人带进第 3 步 = 每点一次都联网');
    assert.deepEqual(r.effects, []);
  });

  test('★ `select-token` 的 index 越界 / 不是整数 → no-op（页面拿的是旧列表）', () => {
    const s = atStep2();
    for (const ev of [
      PN('select-token', { index: 9 }),
      PN('select-token', { index: -1 }),
      PN('select-token', { index: 1.5 }),
      PN('select-token', {}),
      PN('select-token', { index: '0' }),
    ]) {
      const r = one(s, ev);
      assert.equal(JSON.stringify(r.state), JSON.stringify(s), `★ ${JSON.stringify(ev)} 改了状态`);
      assert.deepEqual(r.effects, []);
    }
  });

  test('★★ 改地址：属于**另一个 token** 就跟着换选中（双向联动）', () => {
    const s = one(atStep2(), PN('select-token', { index: 0 })).state;

    const r = one(s, PN('set-base-url', { value: 'https://y' }));
    assert.equal(r.state.wizard.token.chosen, 'relay-a', '★ 改了地址，身份也得跟上');
    assert.equal(r.state.wizard.token.baseUrl, 'https://y');
    assert.equal(r.state.wizard.token.urlEdited, false, '★ 那个地址本来就是它的，没什么要写回');
    assert.equal(r.state.wizard.step, 2);
    assert.deepEqual(r.effects, []);
  });

  test('★ 改地址：重新选回**自己那个**地址 → 选中项不动、也不用写回', () => {
    const s = one(atStep2(), PN('select-token', { index: 1 })).state;
    const r = one(s, PN('set-base-url', { value: 'https://y' }));
    assert.equal(r.state.wizard.token.chosen, 'relay-a');
    assert.equal(r.state.wizard.token.urlEdited, false);
  });

  test('★★ 自己敲的地址：选中项不动，记下"第 4 步要写回"', () => {
    const s = one(atStep2(), PN('select-token', { index: 0 })).state;

    const r = one(s, PN('set-base-url', { value: ' https://custom/v1 ' }));
    assert.equal(r.state.wizard.token.chosen, 'relay-cxt');
    assert.equal(r.state.wizard.token.baseUrl, 'https://custom/v1', '★ 两头空格要 trim');
    assert.equal(r.state.wizard.token.urlEdited, true, '★ 敲进去的地址不写回就丢了');
  });

  test('★ 清空地址 = 也要写回（那是"把这个 token 的地址去掉"），且不许把身份也清了', () => {
    const s = one(atStep2(), PN('select-token', { index: 0 })).state;
    const r = one(s, PN('set-base-url', { value: '   ' }));
    assert.equal(r.state.wizard.token.baseUrl, '');
    assert.equal(r.state.wizard.token.urlEdited, true);
    assert.equal(r.state.wizard.token.chosen, 'relay-cxt');
  });

  test('★★ 两个 token 都**没配地址** ≠ 同一个地址（比的是原始值，不是显示串）', () => {
    // 显示串里两者都是「(未设置)」——拿它去比，选一下地址就会把选中项
    // 切到另一个 token 身上，而用户什么都没改。
    const tokens = [
      { name: 'a', masked: 'sk-****0001', baseUrl: '(未设置)', url: '' },
      { name: 'b', masked: 'sk-****0002', baseUrl: '(未设置)', url: '' },
    ];
    const s = atStep2(mk({ tokens }));

    const sel = one(s, PN('select-token', { index: 1 }));
    assert.equal(sel.state.wizard.token.chosen, 'b');
    assert.equal(sel.state.wizard.token.baseUrl, '');

    const cleared = one(one(sel.state, PN('select-token', { index: 0 })).state, PN('set-base-url', { value: '' }));
    assert.equal(cleared.state.wizard.token.chosen, 'a', '★ 空地址把选中项切到别人身上了');
    assert.equal(cleared.state.wizard.token.urlEdited, true);
  });

  test('★ `confirm-token` 没选身份 → 提示，不给第 3 步', () => {
    const s = atStep2();
    const r = one(s, PN('confirm-token'));
    assert.equal(r.state.wizard.step, 2);
    assert.deepEqual(r.effects, []);
    assert.match(r.state.wizard.token.notice, /先选一个身份/);
  });

  test('★★ `confirm-token` 进第 3 步并拉模型，**地址编辑原样带着**', () => {
    const s = run(atStep2(), [PN('select-token', { index: 1 }), PN('set-base-url', { value: 'https://custom' })]).state;

    const r = one(s, PN('confirm-token'));
    assert.equal(r.state.wizard.step, 3);
    assert.equal(r.state.wizard.token.chosen, 'relay-a');
    assert.equal(r.state.wizard.token.baseUrl, 'https://custom', '★ 进第 3 步时把刚敲的地址丢了');
    assert.equal(r.state.wizard.token.urlEdited, true, '★ 写回的记号也丢了');
    assert.deepEqual(types(r.effects), ['fetch-models']);
    assert.equal(r.effects[0].token, 'relay-a');
  });

  test('★★ `apply-wizard` 只在**用户动过地址**时才带 `baseUrl`', () => {
    // 没动过就别带那个键：多一个恒等于现值的字段，写回那边就得分清
    // "用户把它改成了 X"与"它本来就是 X"，而这两件事在 effect 里长得一样。
    const untouched = one(atStep4(), PN('apply'));
    assert.equal(Object.hasOwn(untouched.effects[0], 'baseUrl'), false, '★ 没动过地址却带了那个键');

    const edited = run(atStep2(), [
      PN('select-token', { index: 1 }),
      PN('set-base-url', { value: 'https://custom' }),
      PN('confirm-token'),
      PN('next'),            // 第 3 步 → 第 4 步
    ]);
    const applied = one(edited.state, PN('apply'));
    assert.deepEqual(types(applied.effects), ['apply-wizard']);
    assert.equal(applied.effects[0].baseUrl, 'https://custom');
    assert.equal(applied.effects[0].token, 'relay-a', '★ 写回的是新选的那个 token');
  });

  test('★★ `save-token` 把新建表单里的地址一起交出去（空就不交）', () => {
    const fresh = atStep2New();
    const filled = run(fresh, [
      PN('set-token-name', { value: 'relay-z' }),
      PN('set-secret', { value: 'sk-aaaa11112222' }),
      PN('set-base-url', { value: ' https://new/v1 ' }),
    ]);

    const r = one(filled.state, PN('save-token'));
    assert.deepEqual(r.effects, [{
      type: 'save-token', name: 'relay-z', secret: 'sk-aaaa11112222', baseUrl: 'https://new/v1',
    }]);

    // 地址空着 → 不写那个键（与 TUI 那条完全同形，有另一条测试钉着）
    const bare = run(fresh, [
      PN('set-token-name', { value: 'relay-z' }),
      PN('set-secret', { value: 'sk-aaaa11112222' }),
    ]);
    assert.deepEqual(one(bare.state, PN('save-token')).effects, [
      { type: 'save-token', name: 'relay-z', secret: 'sk-aaaa11112222' },
    ]);
  });

  test('★ 新建态里选地址：没有"另一个 token"可切，原样记下', () => {
    const fresh = atStep2New();
    const r = one(fresh, PN('set-base-url', { value: 'https://y' }));
    assert.equal(r.state.wizard.token.baseUrl, 'https://y');
    assert.equal(r.state.wizard.token.urlEdited, true);
    assert.equal(r.state.wizard.token.chosen, '', '★ 新建态不许凭空选中一个已有身份');
  });

  test('★ 放弃新建（Esc）→ 地址回到选中项自己的，写回记号清掉', () => {
    const fresh = atStep2New();
    const typed = run(fresh, [PN('set-base-url', { value: 'https://half-typed' })]).state;
    const back = one(typed, PN('back')).state;

    assert.equal(back.wizard.token.mode, 'pick');
    assert.equal(back.wizard.token.baseUrl, '', '★ 从没存在过的 token 的地址留下来了');
    assert.equal(back.wizard.token.urlEdited, false);
  });
});

describe('★★ app —— `move-model`：整个控制台里唯一真新增的能力', () => {
  /** 走到第 3 步并勾上前三个模型（顺序 = 勾选顺序）。 */
  const threeChecked = () => run(atStep3(), [PN('toggle-model', { id: 'gpt-5.6-sol' }),
    PN('toggle-model', { id: 'gpt-6.1-sol' }), PN('toggle-model', { id: 'deepseek-flash' })]).state;

  test('★★ 上移 / 下移真的换了顺序', () => {
    const s = threeChecked();
    assert.deepEqual(s.wizard.models.checked, ['gpt-5.6-sol', 'gpt-6.1-sol', 'deepseek-flash']);

    const up = one(s, PN('move-model', { id: 'deepseek-flash', dir: -1 })).state;
    assert.deepEqual(up.wizard.models.checked, ['gpt-5.6-sol', 'deepseek-flash', 'gpt-6.1-sol']);

    const down = one(s, PN('move-model', { id: 'gpt-5.6-sol', dir: 1 })).state;
    assert.deepEqual(down.wizard.models.checked, ['gpt-6.1-sol', 'gpt-5.6-sol', 'deepseek-flash']);
  });

  test('★★ 两端越界 = no-op，**不是绕回**', () => {
    // 循环调序会让用户"点了一下 ↑，优先级却从第一掉到最末"——那种惊吓比没反应坏。
    const s = threeChecked();

    const first = one(s, PN('move-model', { id: 'gpt-5.6-sol', dir: -1 }));
    assert.deepEqual(first.state.wizard.models.checked, s.wizard.models.checked, '★ 第一项再往上不该动');
    assert.deepEqual(first.effects, []);

    const last = one(s, PN('move-model', { id: 'deepseek-flash', dir: 1 }));
    assert.deepEqual(last.state.wizard.models.checked, s.wizard.models.checked, '★ 最后一项再往下不该动');
  });

  test('★ 没勾上的 id / 怪 dir / 怪 id → no-op', () => {
    const s = threeChecked();
    const same = JSON.stringify(s.wizard.models.checked);

    for (const ev of [
      PN('move-model', { id: '从没勾过的', dir: 1 }),
      PN('move-model', { id: 'gpt-6.1-sol', dir: 0 }),
      PN('move-model', { id: 'gpt-6.1-sol', dir: 2 }),
      PN('move-model', { id: 'gpt-6.1-sol', dir: undefined }),
      PN('move-model', { id: undefined, dir: 1 }),
      PN('move-model', { dir: 1 }),
    ]) {
      const r = one(s, ev);
      assert.equal(JSON.stringify(r.state.wizard.models.checked), same, `★ ${JSON.stringify(ev)} 动了顺序`);
      assert.deepEqual(r.effects, []);
    }
  });

  test('★★ 调序**只动顺序**，不动 `ids`（不许替服务端排序）', () => {
    const s = threeChecked();
    const r = one(s, PN('move-model', { id: 'deepseek-flash', dir: -1 })).state;
    assert.deepEqual(r.wizard.models.ids, s.wizard.models.ids);
    assert.deepEqual(r.wizard.models.checked.slice().sort(), s.wizard.models.checked.slice().sort());
  });

  test('★★ 调过序之后写出去的就是调过的顺序（否则这个功能白做）', () => {
    const s = run(threeChecked(), [PN('move-model', { id: 'deepseek-flash', dir: -1 }), PN('next'), PN('next')]);
    assert.deepEqual(types(s.effects), ['apply-wizard']);
    assert.deepEqual(s.effects[0].models, ['gpt-5.6-sol', 'deepseek-flash', 'gpt-6.1-sol']);
  });

  test('★ `manual-model{value}` 加进已选；空值给提示（与 TUI 同一句）', () => {
    const s = atStep3();
    const r = one(s, PN('manual-model', { value: ' hand-written ' }));
    assert.deepEqual(r.state.wizard.models.checked, ['hand-written']);
    assert.match(r.state.wizard.models.notice, /已加入/);

    const empty = one(s, PN('manual-model', { value: '   ' }));
    assert.deepEqual(empty.state.wizard.models.checked, []);
    assert.match(empty.state.wizard.models.notice, /不能为空/);
  });

  test('★★ `toggle-model{id}` 认的是 **id**，不是光标——键盘做不到这件事', () => {
    // 键盘上"勾上 deepseek-flash"必须先把光标移过去；面板上直接说 id。
    // 把光标故意停在最后一行，看它会不会勾错成光标那一行。
    const s = run(atStep3(), [K('end')]).state;
    assert.equal(s.wizard.models.cursor, 2, '夹具前提：光标在最后一行');

    const r = one(s, PN('toggle-model', { id: 'gpt-5.6-sol' }));
    assert.deepEqual(r.state.wizard.models.checked, ['gpt-5.6-sol'], '★ 勾的是 id 指的那个');
    assert.equal(r.state.wizard.models.cursor, 2, '★ 连光标都不该动');
  });

  test('★ 取消再勾上会**排到末尾**（与键盘同一个语义，不是另一个）', () => {
    const s = run(atStep3(), [
      PN('toggle-model', { id: 'gpt-5.6-sol' }),
      PN('toggle-model', { id: 'gpt-6.1-sol' }),
      PN('toggle-model', { id: 'gpt-5.6-sol' }),
      PN('toggle-model', { id: 'gpt-5.6-sol' }),
    ]).state;
    assert.deepEqual(s.wizard.models.checked, ['gpt-6.1-sol', 'gpt-5.6-sol']);
  });
});

// ═══════════════ ★ 纯度与分层 ═══════════════

describe('★★ app —— 纯函数 + 分层（`ui/` 整层不碰 node 内置）', () => {
  test('★ 不改入参', () => {
    const s = mk();
    const snap = JSON.stringify(s);
    reduce(s, T('n'));
    reduce(s, K('enter'));
    reduce(s, T('q'));
    assert.equal(JSON.stringify(s), snap, '★ reduce 改了入参');
  });

  test('★ 同输入同输出', () => {
    const a = JSON.stringify(run(mk(), [T('n'), T('abc'), K('enter'), T('n')]));
    const b = JSON.stringify(run(mk(), [T('n'), T('abc'), K('enter'), T('n')]));
    assert.equal(a, b);
  });

  test('★ 状态**整棵树可 JSON 化**（"把状态 dump 出来看看"任何时候都可行）', () => {
    const s = run(mk(), [T('n'), T('x'), K('enter'), K('enter'), T('/')]).state;
    assert.equal(JSON.stringify(s), JSON.stringify(JSON.parse(JSON.stringify(s))));
  });

  test('★★ `ui/` 三个内核文件都不 import `node:`、不碰 `process`、不发请求（§4.2）', () => {
    for (const f of ['app.js', 'render.js', 'keys.js']) {
      const src = readFileSync(new URL(`../src/cli/ui/${f}`, import.meta.url), 'utf8');
      assert.ok(!/from\s+'node:/.test(src), `★ ${f} import 了 node 内置——副作用该在 platform/`);
      assert.ok(!/\bprocess\./.test(src), `★ ${f} 碰了 process`);
      assert.ok(!/\bfetch\s*\(/.test(src), `★ ${f} 发了请求`);
      assert.ok(!/\brequire\s*\(/.test(src), `★ ${f} 用了 require`);
    }
  });

  test('★★ `ui/app.js` 的依赖面只有一个纯模块（不许 import commands/platform）', () => {
    const src = readFileSync(new URL('../src/cli/ui/app.js', import.meta.url), 'utf8');
    const imports = [...src.matchAll(/^import .* from '([^']+)';$/gm)].map((m) => m[1]);
    assert.deepEqual(imports, ['./render.js']);
  });

  test('★ `initialState` 的 view 是保守默认值，驱动侧进屏后立刻 resize 纠正', () => {
    const s = initialState(mkData());
    assert.deepEqual(s.view, { cols: 80, rows: 24 });
    assert.deepEqual(one(s, { type: 'resize', cols: 200, rows: 50 }).state.view, { cols: 200, rows: 50 });
  });

  test('★ resize 给垃圾值不炸（拿到 0 会让 layout 退化，但不能是 NaN）', () => {
    const r = one(mk(), { type: 'resize', cols: undefined, rows: -5 }).state;
    assert.equal(r.view.cols, 0);
    assert.equal(r.view.rows, 0);
    assert.ok(Number.isFinite(r.view.cols) && Number.isFinite(r.view.rows));
  });

  test('★ `reloaded`：换 data 并把光标夹回范围内（配置里删了几项之后光标不能悬空）', () => {
    const atEnd = one(mk(), K('end')).state;
    assert.equal(atEnd.cursor, 3);

    const r = one(atEnd, { type: 'reloaded', data: mkData({ items: [ITEMS[0]] }) }).state;
    assert.equal(r.cursor, 0, '★ 夹回范围内');
    assert.equal(r.top, 0);
    assert.equal(r.pending, false);
  });

  test('★ `reloaded` 不动向导（所以中途重读配置是安全的）', () => {
    const r = one(atStep2(), { type: 'reloaded', data: mkData() }).state;
    assert.equal(r.screen, 'wizard');
    assert.equal(r.wizard.step, 2);
  });

  test('★ 事件表里没有的 `type` 一律当无事发生（驱动侧将来加了新事件也不会炸）', () => {
    const { state, effects } = one(mk(), { type: '未来才有的东西' });
    assert.deepEqual(effects, []);
    assert.equal(state.screen, 'list');
  });
});
