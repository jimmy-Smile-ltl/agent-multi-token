// @ts-check
/**
 * 表格读取：CSV 与 xlsx。**两者都只产出 `string[][]`**，别的什么都不做。
 *
 * ─────────────────────────────────────────────────────────────
 * ★★ **零依赖**。xlsx 就是一堆 XML 装进 zip 里：自己从中央目录取成员、
 * 用 `node:zlib` 的 `inflateRawSync` 解压、正则读单元格。没有 npm 包，
 * 也不碰 fs——给什么字节就解什么字节。
 *
 * ★ **只做"读成网格"一件事**：表头判定、列映射、密钥形状校验全在别处
 * （见 `core/pool.js` 的 `mapImportRows`）。分开的好处是这张网格可以被
 * 直接断言，不用先造一把假密钥。
 *
 * ★ 这是**给导入用的窄解析器**，不是通用 xlsx 实现：不读样式、不读公式、
 * 不读多工作表的关系表（直接按文件名序号取第一个）。够用即可，写多了也没人验。
 * ─────────────────────────────────────────────────────────────
 */

import { inflateRawSync } from 'node:zlib';

/* ── zip 常量 ─────────────────────────────────────────────── */

/** 中央目录末尾标记（EOCD，"End Of Central Directory"） */
const EOCD_SIG = 0x06054b50;
/** 中央目录文件头 */
const CD_SIG = 0x02014b50;
/** 本地文件头 */
const LFH_SIG = 0x04034b50;

/** EOCD 定长部分 */
const EOCD_SIZE = 22;
/** zip 注释最长 65535 字节，倒扫的窗口就开这么大 */
const MAX_COMMENT = 0xffff;

/** zip64 的哨兵值：真压缩尺寸/偏移写不进去时填它，真实值在扩展字段里 */
const ZIP64_SENTINEL = 0xffffffff;

/* ── CSV ──────────────────────────────────────────────────── */

/**
 * 读 CSV。**宽容**：BOM、CRLF、裸 CR、引号里的逗号与换行、`""` 转义，都认。
 *
 * 引号规则（比 RFC 4180 松一点，因为手写表格从来不守 RFC）：
 * - 字段**开头**的 `"` 进入引用态；中途出现的 `"` 当普通字符；
 * - 引用态里的 `""` 是一个字面引号，单个 `"` 关闭引用；
 * - 引用**没闭合**就撞到文件尾——不报错，把已经读到的当作这个字段的内容。
 *   （报错只会让人对着一个看不见的引号发呆，不如把内容交出去。）
 *
 * @param {string} input
 * @returns {string[][]}
 */
export function parseCsv(input) {
  let text = typeof input === 'string' ? input : '';
  // BOM：Windows 上的 Excel「另存为 CSV」默认会加，不去掉第一列表头就永远匹配不上
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);

  /** @type {string[][]} */
  const rows = [];
  /** @type {string[]} */
  let row = [];
  let field = '';
  let quoted = false;
  let i = 0;

  while (i < text.length) {
    const ch = text[i];

    if (quoted) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i += 2;
          continue;
        }
        quoted = false;
        i += 1;
        continue;
      }
      field += ch;
      i += 1;
      continue;
    }

    if (ch === '"' && field === '') {
      quoted = true;
      i += 1;
      continue;
    }

    if (ch === ',') {
      row.push(field);
      field = '';
      i += 1;
      continue;
    }

    if (ch === '\r' || ch === '\n') {
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
      // CRLF 算一个换行，别把 \n 再算一遍
      i += ch === '\r' && text[i + 1] === '\n' ? 2 : 1;
      continue;
    }

    field += ch;
    i += 1;
  }

  // 最后一行没有换行结尾（绝大多数文件的真实情况）
  if (field !== '' || row.length > 0) {
    row.push(field);
    rows.push(row);
  }

  // 末尾的空行是排版残留，不是数据；中间的空行要留着（导入时要按"空行"计数）
  while (rows.length > 0 && rows[rows.length - 1].every((cell) => cell === '')) {
    rows.pop();
  }

  return rows;
}

/* ── xlsx ─────────────────────────────────────────────────── */

/**
 * 读 xlsx 的**第一张工作表**。
 *
 * ⚠️ 「第一张」按文件名里的数字取（`sheet1.xml` 优先），不去解
 * `workbook.xml` 与关系表。理由：关系表解析要多读两个 XML 才能得到
 * **同一个答案**，而这次导入只关心"表里有什么"。
 *
 * @param {Buffer | Uint8Array} input
 * @returns {string[][]}
 */
export function parseXlsx(input) {
  const buf = toBuffer(input);
  const zip = readZip(buf);

  const sheetPath = pickSheetPath(zip);
  if (sheetPath === null) throw new Error('没有找到工作表（可能是 .xls 而不是 .xlsx）');

  const sheetXml = readZipText(zip, sheetPath);
  const sharedXml = zip.has('xl/sharedStrings.xml')
    ? readZipText(zip, 'xl/sharedStrings.xml')
    : '';

  const shared = sharedXml === '' ? [] : parseSharedStrings(sharedXml);
  return parseSheetXml(sheetXml, shared);
}

/**
 * @param {Buffer | Uint8Array} input
 * @returns {Buffer}
 */
function toBuffer(input) {
  if (Buffer.isBuffer(input)) return input;
  if (input instanceof Uint8Array) {
    return Buffer.from(input.buffer, input.byteOffset, input.byteLength);
  }
  throw new Error('需要 Buffer 或 Uint8Array');
}

/**
 * 把 zip 里的成员读成 `Map<名字, 解压后的字节>`。
 *
 * ★ **大小与偏移都以中央目录为准**，不用本地文件头里的——本地头允许填 0
 * （"流式写入"时的合法做法），照着它读会切出一段空数据。
 *
 * @param {Buffer} buf
 * @returns {Map<string, Buffer>}
 */
function readZip(buf) {
  const eocd = findEocd(buf);
  if (eocd < 0) throw new Error('不是有效的 xlsx（找不到 zip 目录尾）');

  const count = buf.readUInt16LE(eocd + 10);
  const size = buf.readUInt32LE(eocd + 12);
  const offset = buf.readUInt32LE(eocd + 16);

  if (offset + size > buf.length || offset === ZIP64_SENTINEL) {
    throw new Error('xlsx 的目录越界或用了 zip64（不支持）');
  }

  /** @type {Map<string, Buffer>} */
  const out = new Map();
  let p = offset;

  for (let n = 0; n < count; n += 1) {
    if (p + 46 > buf.length) throw new Error('xlsx 的中央目录被截断');
    if (buf.readUInt32LE(p) !== CD_SIG) throw new Error('xlsx 的中央目录损坏');

    const method = buf.readUInt16LE(p + 10);
    const compressed = buf.readUInt32LE(p + 20);
    const rawSize = buf.readUInt32LE(p + 24);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const localOffset = buf.readUInt32LE(p + 42);
    const name = buf.toString('utf8', p + 46, p + 46 + nameLen);

    p += 46 + nameLen + extraLen + commentLen;

    // 目录项（名字以 / 结尾）没有内容，跳过
    if (name.endsWith('/')) continue;
    if (compressed === ZIP64_SENTINEL || rawSize === ZIP64_SENTINEL) {
      throw new Error('xlsx 成员用了 zip64（不支持）');
    }

    const dataStart = localDataStart(buf, localOffset);
    if (dataStart + compressed > buf.length) throw new Error('xlsx 成员被截断');

    if (method === 0) {
      out.set(name, Buffer.from(buf.subarray(dataStart, dataStart + compressed)));
    } else if (method === 8) {
      out.set(name, inflateRawSync(buf.subarray(dataStart, dataStart + compressed)));
    }
    // 其它压缩方法（bzip2 / lzma）：这个版本里不会出现，静默略过，
    // 真需要时下面的"找不到工作表"会报出来，比在这里抛一个费解的错误强
  }

  return out;
}

/**
 * 本地文件头之后真正的数据起点。
 * 名字长度与扩展长度**要重读本地头**——它和中央目录记的可以不一样。
 * @param {Buffer} buf
 * @param {number} localOffset
 * @returns {number}
 */
function localDataStart(buf, localOffset) {
  if (localOffset + 30 > buf.length) throw new Error('xlsx 的本地文件头越界');
  if (buf.readUInt32LE(localOffset) !== LFH_SIG) throw new Error('xlsx 的本地文件头损坏');
  const nameLen = buf.readUInt16LE(localOffset + 26);
  const extraLen = buf.readUInt16LE(localOffset + 28);
  return localOffset + 30 + nameLen + extraLen;
}

/**
 * 倒扫 EOCD。**只认"注释长度正好补到文件尾"的那一个**——
 * 压缩注释里完全可能出现同样的四字节，不校验就会读到假的目录偏移。
 * @param {Buffer} buf
 * @returns {number} 位置；`-1` = 没找到
 */
function findEocd(buf) {
  const oldest = Math.max(0, buf.length - EOCD_SIZE - MAX_COMMENT);
  for (let i = buf.length - EOCD_SIZE; i >= oldest; i -= 1) {
    if (buf.readUInt32LE(i) !== EOCD_SIG) continue;
    const commentLen = buf.readUInt16LE(i + 20);
    if (i + EOCD_SIZE + commentLen === buf.length) return i;
  }
  return -1;
}

/**
 * @param {Map<string, Buffer>} zip
 * @returns {string | null}
 */
function pickSheetPath(zip) {
  /** @type {string[]} */
  const names = [];
  for (const name of zip.keys()) {
    if (/^xl\/worksheets\/sheet\d+\.xml$/.test(name)) names.push(name);
  }
  if (names.length === 0) return null;
  names.sort((a, b) => sheetNumber(a) - sheetNumber(b));
  return names[0];
}

/**
 * @param {string} name
 * @returns {number}
 */
function sheetNumber(name) {
  const m = /sheet(\d+)\.xml$/.exec(name);
  return m ? Number(m[1]) : 0;
}

/**
 * @param {Map<string, Buffer>} zip
 * @param {string} name
 * @returns {string}
 */
function readZipText(zip, name) {
  const data = zip.get(name);
  if (data === undefined) throw new Error(`xlsx 里没有 ${name}`);
  return data.toString('utf8');
}

/* ── XML ──────────────────────────────────────────────────── */

/**
 * 读共享字符串表。单元格里只会存一个整数下标，正文全在这里。
 *
 * ★ 两处必须处理，否则中文表格会读错：
 * - `<rPh>`（注音）要**先整段剥掉**，它里面的 `<t>` 也长这个样子，
 *   混进来会得到「名字乙个」这种串；
 * - 一个 `<si>` 可能是多个 `<r>` 富文本段拼的，**所有 `<t>` 要连起来**。
 *
 * @param {string} xml
 * @returns {string[]}
 */
function parseSharedStrings(xml) {
  /** @type {string[]} */
  const out = [];
  const re = /<si\b([^>]*?)(?:\/>|>([\s\S]*?)<\/si>)/g;
  let m;

  while ((m = re.exec(xml)) !== null) {
    out.push(m[2] === undefined ? '' : collectText(m[2]));
  }

  return out;
}

/**
 * 一段 XML 里所有文本节点拼起来（剥掉注音）。
 * @param {string} fragment
 * @returns {string}
 */
function collectText(fragment) {
  const clean = fragment.replace(/<rPh\b[^>]*>[\s\S]*?<\/rPh>/g, '');
  let out = '';
  // `<t/>` 自闭合走第一个分支（内容为空），别让它去后面找别人的 `</t>`
  const re = /<t\b([^>]*?)(?:\/>|>([\s\S]*?)<\/t>)/g;
  let m;

  while ((m = re.exec(clean)) !== null) {
    if (m[2] !== undefined) out += decodeXml(m[2]);
  }

  return out;
}

/**
 * 读工作表。
 *
 * ★★ **按 `r` 属性定位列，不按出现顺序数**。这是实测逼出来的：
 * 真实文件里 200 个 `<row>` 只有 38 个 `<c>`，中间全是空的格式行；
 * 而且一行里可以只有 B 列有值（A 列空着）。按顺序数会整体错位一列，
 * 把密钥读成名字、把备注读成密钥。
 *
 * ★ 没有 `<c>` 的行**整行丢掉**。它们只是 Excel 留下的行高/样式残骸，
 * 留成空行会让"空行计数"失真。
 *
 * @param {string} xml
 * @param {string[]} shared
 * @returns {string[][]}
 */
function parseSheetXml(xml, shared) {
  /** @type {string[][]} */
  const rows = [];
  const rowRe = /<row\b([^>]*?)(?:\/>|>([\s\S]*?)<\/row>)/g;
  let m;

  while ((m = rowRe.exec(xml)) !== null) {
    const inner = m[2];
    if (inner === undefined) continue;

    /** @type {string[]} */
    const cells = [];
    let next = 0;
    const cellRe = /<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g;
    let c;

    while ((c = cellRe.exec(inner)) !== null) {
      const attrs = c[1] === undefined ? '' : c[1];
      const col = columnIndex(attrs);
      const at = col === null ? next : col;
      next = at + 1;
      cells[at] = cellValue(attrs, c[2] === undefined ? '' : c[2], shared);
    }

    if (cells.length === 0) continue;

    // 稀疏处补空串，保证 `row[0]` 永远是 A 列
    const row = [];
    for (let i = 0; i < cells.length; i += 1) {
      row.push(cells[i] === undefined ? '' : cells[i]);
    }
    rows.push(row);
  }

  return rows;
}

/**
 * `r="AB12"` → 27（从 0 数）。没有 `r` 属性返回 `null`。
 * @param {string} attrs
 * @returns {number | null}
 */
function columnIndex(attrs) {
  const m = /\br="([A-Za-z]+)\d+"/.exec(attrs);
  if (!m) return null;
  const letters = m[1].toUpperCase();
  let n = 0;
  for (let i = 0; i < letters.length; i += 1) {
    n = n * 26 + (letters.charCodeAt(i) - 64);
  }
  return n - 1;
}

/**
 * 一个单元格的文本。
 *
 * | `t` | 值的来源 |
 * |---|---|
 * | `s` | `<v>下标</v>` → 共享字符串表 |
 * | `inlineStr` | `<is>` 里的文本 |
 * | `str` / 数字 / 其它 | `<v>` 原样（转义解码后） |
 *
 * @param {string} attrs
 * @param {string} inner
 * @param {string[]} shared
 * @returns {string}
 */
function cellValue(attrs, inner, shared) {
  const type = /\bt="([^"]*)"/.exec(attrs);
  const t = type === null ? '' : type[1];

  if (t === 'inlineStr') {
    const is = /<is\b[^>]*>([\s\S]*?)<\/is>/.exec(inner);
    return is === null ? '' : collectText(is[1]);
  }

  const v = /<v\b[^>]*>([\s\S]*?)<\/v>/.exec(inner);
  if (v === null) return '';
  const raw = v[1];

  if (t === 's') {
    const idx = Number(raw);
    return Number.isInteger(idx) && idx >= 0 && idx < shared.length ? shared[idx] : '';
  }

  return decodeXml(raw);
}

/**
 * XML 实体解码。**一趟替换**——分多趟会把 `&amp;lt;` 解成 `<`（本该是 `&lt;`）。
 * @param {string} text
 * @returns {string}
 */
function decodeXml(text) {
  if (!text.includes('&')) return text;

  return text.replace(/&(#[0-9]+|#[xX][0-9a-fA-F]+|[a-zA-Z]+);/g, (whole, body) => {
    if (body.charCodeAt(0) === 35 /* # */) {
      const hex = body[1] === 'x' || body[1] === 'X';
      const code = Number.parseInt(hex ? body.slice(2) : body.slice(1), hex ? 16 : 10);
      if (!Number.isFinite(code) || code < 0 || code > 0x10ffff) return whole;
      try {
        return String.fromCodePoint(code);
      } catch {
        return whole;
      }
    }

    switch (body) {
      case 'amp':
        return '&';
      case 'lt':
        return '<';
      case 'gt':
        return '>';
      case 'quot':
        return '"';
      case 'apos':
        return "'";
      case 'nbsp':
        // 写成构造式而不是直接放一个不换行空格：那个字符在编辑器里看不见，
        // 下一个人改这一行时手上会多出一个"空格"，diff 里却什么都不显示
        return String.fromCharCode(0xa0);
      default:
        return whole;
    }
  });
}
