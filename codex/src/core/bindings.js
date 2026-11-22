// @ts-check
/**
 * ★ 路径绑定：归一化 + **最长前缀匹配**（§2.3）。
 *
 * 绑定回答的是"**这个目录**用哪个 token"：
 * `bindings: [{ path: 'D:/work/client-a', token: 'relay-a' }]` 表示
 * "在 `D:/work/client-a` 及其子目录下启动的 cxt，走 relay-a 的身份"。
 *
 * ─────────────────────────────────────────────────────────────
 * ★★ **本模块的核心是"按目标平台归一，而不是按宿主平台归一"**（§4.2）。
 *
 * 单测要在**任意一台机器**上验三套路径规则（§6.3），所以 `platform` 是**参数**，
 * 绝不读 `process.platform`。在 Windows 上跑测试时照样能验 Linux 的
 * 大小写敏感规则——这正是 `core/` 纯函数化的意义。
 *
 * 三套规则（都来自**该平台文件系统的真实行为**，不是"防呆"）：

 * | 平台 | 大小写 | `\` 是分隔符 | Unicode 归一 |
 * |------|:---:|:---:|:---:|
 * | Windows | 不敏感 | ✅ 是 | ❌ 不归一 |
 * | macOS | 不敏感（APFS 默认） | ❌ 不是（`\` 是合法文件名字符） | ✅ **NFC** |
 * | Linux | **敏感** | ❌ 不是 | ❌ 不归一 |
 *
 * ⚠️ **每一条都只在该平台生效**，别"统一处理"：
 * - 在 Linux 上把 `\` 当分隔符 → 把 `a\b`（一个合法文件名）误判成 `a/b`
 * - 在 Linux 上做 NFC 归一 → 把两个**确实不同**的文件名判成同一个
 *   （Linux 允许 NFC 与 NFD 两种形态作为两个独立文件名共存）
 *
 * ★ **NFC 这条是 macOS 专有的真坑**：APFS/HFS+ 把文件名以 **NFD** 存盘，
 * 而用户从 Finder / 剪贴板拿到的字符串往往是 **NFC**。两者字节不同、肉眼相同，
 * 直接 `===` 比较会**静默失配**——绑定不生效，且没有任何提示。
 * 归一之后两边才可比。
 * ─────────────────────────────────────────────────────────────
 *
 * ⚠️ **不做 `path.resolve()` / `realpath`**（§7.3 铁律 4 的同一原则）：
 * 解析会跟随符号链接、把 `.`/`..` 展开，于是"用户写的路径"与"实际匹配的路径"
 * 就不再是同一个东西了。匹配用的 `cwd` 来自 `process.cwd()`，本来就是规范形态。
 */

/**
 * 某个平台的路径比较规则。
 * @typedef {object} PathRules
 * @property {boolean} caseInsensitive     比较时是否折叠大小写
 * @property {boolean} backslashIsSeparator `\` 在该平台上是不是路径分隔符
 * @property {boolean} nfcNormalize        比较前是否做 NFC 归一
 */

/** @type {Record<string, PathRules>} */
const RULES = {
  win32: { caseInsensitive: true, backslashIsSeparator: true, nfcNormalize: false },
  darwin: { caseInsensitive: true, backslashIsSeparator: false, nfcNormalize: true },
  // Linux 及一切其它 POSIX：严格按字节比
  linux: { caseInsensitive: false, backslashIsSeparator: false, nfcNormalize: false },
};

/** 未知平台按最保守的一套（大小写敏感、不归一）——宁可漏匹配，不可错匹配 */
const DEFAULT_RULES = /** @type {PathRules} */ (RULES.linux);

/**
 * @param {NodeJS.Platform | string} platform
 * @returns {PathRules}
 */
export function rulesFor(platform) {
  return RULES[platform] ?? DEFAULT_RULES;
}

/**
 * 把一条路径归一成**用于比较**的形态。**只用于比较**——
 * 写盘/传给 Codex 的永远是用户给的字面路径（§7.3 铁律 4）。
 *
 * 处理顺序是有讲究的：
 * 1. 分隔符（先转，后续步骤才好处理尾部斜杠）
 * 2. 去尾部斜杠（`D:/work/` 与 `D:/work` 必须等价）
 * 3. 折叠大小写 → 再做 NFC。**这个顺序不能反**：
 *    某些字符小写化之后会脱离 NFC（如 `'İ'.toLowerCase()` 产出 `i` + 组合点），
 *    把 NFC 放在最后才能保证输出一定是规范形态。
 *
 * @param {string} p
 * @param {NodeJS.Platform | string} platform
 * @returns {string}
 */
export function normalizeForCompare(p, platform) {
  const rules = rulesFor(platform);
  let s = String(p ?? '');

  if (rules.backslashIsSeparator) s = s.replace(/\\/g, '/');

  s = stripTrailingSeparators(s);

  if (rules.caseInsensitive) s = s.toLowerCase();
  if (rules.nfcNormalize) s = s.normalize('NFC');

  return s;
}

/**
 * 去掉尾部斜杠，但**保留"根"的形态**。
 *
 * `D:/work/` → `D:/work`，但 `D:/` 不能变成 `D:`（那就不是路径了），
 * `/` 也不能变成空串（空串会匹配一切）。
 * @param {string} s
 */
function stripTrailingSeparators(s) {
  if (s === '' || s === '/') return s;
  let out = s;
  while (out.length > 1 && out.endsWith('/')) {
    // `D:/` 这种"盘根"要留住斜杠
    if (/^[A-Za-z]:\/$/.test(out)) break;
    out = out.slice(0, -1);
  }
  return out;
}

/**
 * ★ 这条路径**看着像不像 8.3 短名**（§7.3 的"第二种拼写"）。
 *
 * Windows 上同一个目录可以有两个都合法的字符串拼写（`C:\Users\alice` 与
 * `C:\Users\ALICE~1`），而 §7.3 的信任匹配是**字符串比较** ⇒ 两条对不上就
 * **静默失配**（症状与"正斜杠写错"一模一样）。
 *
 * ⚠️ 这里只回答"像不像"，**不做归一化**——铁律 4 要求写用户的字面路径，
 * 归一化会破坏"cxt 与 Codex 读同一个 `process.cwd()`"这个自洽性。
 * 调用方拿这个布尔值去**出 warning**（`cxt trust` / `cxt bind` / `cxt doctor`）。
 *
 * ⚠️ **只在 Windows 上有意义**：8.3 是 FAT/NTFS 的短名机制，POSIX 没有。
 * 别的平台一律 `false`——避免把 `a~1` 这种**合法目录名**在 Linux 上误报。
 *
 * ⚠️ 会有误伤：真有人把目录命名成 `a~1` 就会命中。所以是 warning 不是 error。
 *
 * @param {string} p
 * @param {NodeJS.Platform | string} platform
 * @returns {boolean}
 */
export function looksLikeShortName(p, platform) {
  if (platform !== 'win32') return false;
  const s = String(p ?? '');
  if (s === '') return false;

  // 逐段看：`前缀~数字`（前缀 1–6 字符），可带 1–3 字符的扩展名
  const SHORT = /^[^\\/~]{1,6}~\d+(\.[^.]{1,3})?$/;
  return s.split(/[\\/]/).some((seg) => seg !== '' && SHORT.test(seg));
}

/**
 * `child` 是不是在 `parent` 之下（含相等）？两边都必须是**已归一**的字符串。
 *
 * ★ 必须按**路径边界**判断，不能用裸 `startsWith`：
 * 绑定 `D:/work/a` 绝不该匹配 `D:/work/ab`——那是另一个目录，
 * 却共享前缀。裸 `startsWith` 会让它悄悄套用错误的 token，
 * 而用户看到的只是"这个目录怎么用了别的凭证"。
 *
 * @param {string} childNorm
 * @param {string} parentNorm
 */
function isUnder(childNorm, parentNorm) {
  if (parentNorm === '') return true;                 // 空前缀匹配一切（不该出现，但别崩）
  if (childNorm === parentNorm) return true;

  // 根（`/` 或 `D:/`）已经带尾斜杠，直接接子路径即可
  if (parentNorm.endsWith('/')) return childNorm.startsWith(parentNorm);

  return childNorm.startsWith(`${parentNorm}/`);
}

/**
 * 在绑定表里找**最长前缀匹配**的那一条（§2.3）。
 *
 * 返回 `{ binding, index }`——`index` 是给"就地改写该绑定"用的
 * （`cxt model next --path <p>` 无匹配绑定时要新建一条，有则改那一条）。
 *
 * 并列时**取先出现的那条**（`>` 而非 `>=`）——配置文件的书写顺序即优先级，
 * 这样"谁赢"是可预测的、不用去猜实现细节。
 *
 * @param {any[]} bindings
 * @param {string} cwd
 * @param {NodeJS.Platform | string} platform
 * @returns {{ binding: any, index: number } | null}
 */
export function matchBinding(bindings, cwd, platform) {
  if (!Array.isArray(bindings) || bindings.length === 0) return null;

  const target = normalizeForCompare(cwd, platform);

  /** @type {{ binding: any, index: number, len: number } | null} */
  let best = null;

  for (let i = 0; i < bindings.length; i++) {
    const b = bindings[i];
    if (b == null || typeof b.path !== 'string') continue;

    const norm = normalizeForCompare(b.path, platform);
    if (!isUnder(target, norm)) continue;

    // 最长优先；并列取先出现的
    if (best === null || norm.length > best.len) {
      best = { binding: b, index: i, len: norm.length };
    }
  }

  return best === null ? null : { binding: best.binding, index: best.index };
}

/**
 * 该路径**是否已被某个绑定精确覆盖**（不是"落在其下"）。
 *
 * `cxt bind <p> --token t` 用它来判断"是新建还是改写"：
 * 已有**同路径**的绑定就改它，没有才追加——避免同一路径堆出好几条，
 * 那会让"哪条生效"取决于顺序，而用户看不出来。
 * @param {any[]} bindings
 * @param {string} p
 * @param {NodeJS.Platform | string} platform
 * @returns {number} 下标；没有则 -1
 */
export function findExactBinding(bindings, p, platform) {
  if (!Array.isArray(bindings)) return -1;
  const target = normalizeForCompare(p, platform);
  for (let i = 0; i < bindings.length; i++) {
    const b = bindings[i];
    if (b == null || typeof b.path !== 'string') continue;
    if (normalizeForCompare(b.path, platform) === target) return i;
  }
  return -1;
}
