// @ts-check
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { deflateRawSync } from 'node:zlib';

import { parseCsv, parseXlsx } from '../src/core/sheet.js';

/** BOM：Excel「另存为 CSV」默认会加的那个字符 */
const BOM = String.fromCharCode(0xfeff);

// ───────────────────────────── zip 造件器 ─────────────────────────────

/**
 * 造一个最小可读的 zip。**不写 CRC**（读取侧校验的是目录与长度，不校验 CRC，
 * 而写入侧要算它就得引入一段 CRC 表——测试里没必要）。
 *
 * @param {{ name: string, data: string | Buffer, store?: boolean }[]} entries
 * @param {string | Buffer} [comment] zip 注释（用来造"注释里藏了一个假目录尾"的坏情况）
 * @returns {Buffer}
 */
function makeZip(entries, comment) {
  /** @type {Buffer[]} */
  const parts = [];
  /** @type {Buffer[]} */
  const central = [];
  let offset = 0;

  for (const entry of entries) {
    const name = Buffer.from(entry.name, 'utf8');
    const raw = Buffer.isBuffer(entry.data) ? entry.data : Buffer.from(entry.data, 'utf8');
    const body = entry.store === true ? raw : deflateRawSync(raw);
    const method = entry.store === true ? 0 : 8;

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0); // 本地文件头
    local.writeUInt16LE(20, 4); // 解压所需版本
    local.writeUInt16LE(0x0800, 6); // 标志位：名字是 UTF-8
    local.writeUInt16LE(method, 8);
    local.writeUInt16LE(0, 10); // 修改时间
    local.writeUInt16LE(0, 12); // 修改日期
    local.writeUInt32LE(0, 14); // CRC（读取侧不看）
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(raw.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28); // 扩展字段长度

    const cd = Buffer.alloc(46);
    cd.writeUInt32LE(0x02014b50, 0); // 中央目录文件头
    cd.writeUInt16LE(20, 4);
    cd.writeUInt16LE(20, 6);
    cd.writeUInt16LE(0x0800, 8);
    cd.writeUInt16LE(method, 10);
    cd.writeUInt16LE(0, 12);
    cd.writeUInt16LE(0, 14);
    cd.writeUInt32LE(0, 16);
    cd.writeUInt32LE(body.length, 20);
    cd.writeUInt32LE(raw.length, 24);
    cd.writeUInt16LE(name.length, 28);
    cd.writeUInt16LE(0, 30); // 扩展
    cd.writeUInt16LE(0, 32); // 注释
    cd.writeUInt16LE(0, 34); // 起始盘
    cd.writeUInt16LE(0, 36); // 内部属性
    cd.writeUInt32LE(0, 38); // 外部属性
    cd.writeUInt32LE(offset, 42);

    parts.push(local, name, body);
    central.push(cd, name);
    offset += 30 + name.length + body.length;
  }

  const directory = Buffer.concat(central);
  const tail =
    comment === undefined
      ? Buffer.alloc(0)
      : Buffer.isBuffer(comment)
        ? comment
        : Buffer.from(comment, 'latin1');

  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0); // 目录尾
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(directory.length, 12);
  eocd.writeUInt32LE(offset, 16);
  eocd.writeUInt16LE(tail.length, 20);

  return Buffer.concat([...parts, directory, eocd, tail]);
}

/**
 * 造一本只有一张表的 xlsx。
 * @param {{ sheet: string, shared?: string, extra?: { name: string, data: string }[] }} spec
 * @returns {Buffer}
 */
function makeXlsx(spec) {
  /** @type {{ name: string, data: string }[]} */
  const entries = [{ name: 'xl/worksheets/sheet1.xml', data: spec.sheet }];
  if (spec.shared !== undefined) {
    entries.push({ name: 'xl/sharedStrings.xml', data: spec.shared });
  }
  if (spec.extra !== undefined) entries.push(...spec.extra);
  return makeZip(entries);
}

/** @param {string} body `<sheetData>` 里面的内容 */
function sheetXml(body) {
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://x"><sheetData>${body}</sheetData></worksheet>`;
}

/** @param {string} body `<sst>` 里面的内容 */
function sharedXml(body) {
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<sst xmlns="http://x">${body}</sst>`;
}

// ───────────────────────────── CSV ─────────────────────────────

describe('parseCsv', () => {
  test('最普通的两行', () => {
    assert.deepEqual(parseCsv('a,b\nc,d'), [
      ['a', 'b'],
      ['c', 'd'],
    ]);
  });

  test('BOM 被吃掉（不然第一列表头永远匹配不上）', () => {
    assert.deepEqual(parseCsv(`${BOM}名字,密钥\n甲,bbb`), [
      ['名字', '密钥'],
      ['甲', 'bbb'],
    ]);
  });

  test('CRLF 与裸 CR 都算换行', () => {
    assert.deepEqual(parseCsv('a,b\r\nc,d'), [
      ['a', 'b'],
      ['c', 'd'],
    ]);
    assert.deepEqual(parseCsv('a,b\rc,d'), [
      ['a', 'b'],
      ['c', 'd'],
    ]);
  });

  test('引号里的逗号不是分隔符', () => {
    assert.deepEqual(parseCsv('"a,b",c'), [['a,b', 'c']]);
  });

  test('引号里的换行不是换行', () => {
    assert.deepEqual(parseCsv('"a\nb",c\nd,e'), [
      ['a\nb', 'c'],
      ['d', 'e'],
    ]);
  });

  test('"" 是一个字面引号', () => {
    assert.deepEqual(parseCsv('"他说""你好""",b'), [['他说"你好"', 'b']]);
  });

  test('空字段与中间的空行都保留', () => {
    assert.deepEqual(parseCsv('a,,c\n\n,d,'), [
      ['a', '', 'c'],
      [''],
      ['', 'd', ''],
    ]);
  });

  test('末尾的空行去掉（排版残留不是数据）', () => {
    assert.deepEqual(parseCsv('a,b\n\n\n'), [['a', 'b']]);
  });

  test('空输入 → 空表', () => {
    assert.deepEqual(parseCsv(''), []);
    assert.deepEqual(parseCsv('\n'), []);
    assert.deepEqual(parseCsv(BOM), []);
  });

  test('引号没闭合不报错，把读到的交出去', () => {
    assert.deepEqual(parseCsv('a,"bcd'), [['a', 'bcd']]);
  });

  test('引号在字段中间当普通字符', () => {
    assert.deepEqual(parseCsv('a"b,c'), [['a"b', 'c']]);
  });

  test('非字符串输入 → 空表，不抛', () => {
    // @ts-expect-error 故意传错类型
    assert.deepEqual(parseCsv(null), []);
  });
});

// ───────────────────────────── xlsx ─────────────────────────────

describe('parseXlsx', () => {
  test('共享字符串 + 稀疏列 + 空行（真实文件的形状）', () => {
    const buf = makeXlsx({
      sheet: sheetXml(
        '<row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c></row>' +
          '<row r="2"><c r="A2" t="s"><v>2</v></c><c r="B2" t="s"><v>5</v></c></row>' +
          '<row r="3" ht="15" customHeight="1"/>' + // 只有格式、没有单元格
          '<row r="4"><c r="B4" t="s"><v>3</v></c></row>', // A 列空着
      ),
      shared: sharedXml(
        '<si><t>名字</t></si>' +
          '<si><t>密钥</t></si>' +
          '<si><r><t>甲</t></r><r><t>乙</t></r></si>' + // 富文本分段
          '<si><t>只有B列</t></si>' +
          '<si><t>没用到的</t></si>' +
          '<si><t>第二行</t></si>',
      ),
    });

    assert.deepEqual(parseXlsx(buf), [
      ['名字', '密钥'],
      ['甲乙', '第二行'],
      ['', '只有B列'],
    ]);
  });

  test('★ 按 r 属性定位列，不按出现顺序数', () => {
    const buf = makeXlsx({
      sheet: sheetXml('<row r="1"><c r="C1"><v>3</v></c></row>'),
    });
    assert.deepEqual(parseXlsx(buf), [['', '', '3']]);
  });

  test('两位列号（AA = 26）', () => {
    const buf = makeXlsx({
      sheet: sheetXml('<row r="1"><c r="AA1"><v>1</v></c></row>'),
    });
    const rows = parseXlsx(buf);
    assert.equal(rows[0].length, 27);
    assert.equal(rows[0][26], '1');
  });

  test('数字单元格没有 t 属性', () => {
    const buf = makeXlsx({ sheet: sheetXml('<row r="1"><c r="A1"><v>42</v></c></row>') });
    assert.deepEqual(parseXlsx(buf), [['42']]);
  });

  test('inlineStr 直接内联文本', () => {
    const buf = makeXlsx({
      sheet: sheetXml('<row r="1"><c r="A1" t="inlineStr"><is><t>内联</t></is></c></row>'),
    });
    assert.deepEqual(parseXlsx(buf), [['内联']]);
  });

  test('★ 注音 <rPh> 要剥掉，不然中文会读出「名字乙个」这种串', () => {
    const buf = makeXlsx({
      sheet: sheetXml('<row r="1"><c r="A1" t="s"><v>0</v></c></row>'),
      shared: sharedXml('<si><t>汉字</t><rPh sb="0" eb="2"><t>かんじ</t></rPh></si>'),
    });
    assert.deepEqual(parseXlsx(buf), [['汉字']]);
  });

  test('实体解码：命名实体与十进制/十六进制数字实体，一趟替换', () => {
    const buf = makeXlsx({
      sheet: sheetXml('<row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c></row>'),
      shared: sharedXml(
        '<si><t>a &amp; b &lt;c&gt; &quot;d&quot; &apos;e&apos;</t></si>' +
          '<si><t>&#20320;&#x4f60;</t></si>',
      ),
    });
    assert.deepEqual(parseXlsx(buf), [["a & b <c> \"d\" 'e'", '你你']]);
  });

  test('★ &amp;lt; 只解一层（不是文本转义炸弹）', () => {
    const buf = makeXlsx({
      sheet: sheetXml('<row r="1"><c r="A1" t="s"><v>0</v></c></row>'),
      shared: sharedXml('<si><t>&amp;lt;</t></si>'),
    });
    assert.deepEqual(parseXlsx(buf), [['&lt;']]);
  });

  test('没有 sharedStrings.xml 也能读（全是内联/数字的表）', () => {
    const buf = makeXlsx({
      sheet: sheetXml('<row r="1"><c r="A1" t="inlineStr"><is><t>x</t></is></c></row>'),
    });
    assert.deepEqual(parseXlsx(buf), [['x']]);
  });

  test('共享字符串下标越界 → 空串，不是 undefined', () => {
    const buf = makeXlsx({
      sheet: sheetXml('<row r="1"><c r="A1" t="s"><v>9</v></c></row>'),
      shared: sharedXml('<si><t>只有一个</t></si>'),
    });
    assert.deepEqual(parseXlsx(buf), [['']]);
  });

  test('"存储"（method 0）与 deflate（method 8）都读得出', () => {
    const stored = makeZip(
      [{ name: 'xl/worksheets/sheet1.xml', data: sheetXml('<row r="1"><c r="A1"><v>7</v></c></row>'), store: true }],
    );
    assert.deepEqual(parseXlsx(stored), [['7']]);

    const deflated = makeXlsx({ sheet: sheetXml('<row r="1"><c r="A1"><v>7</v></c></row>') });
    assert.deepEqual(parseXlsx(deflated), [['7']]);
  });

  test('取编号最小的工作表（sheet2 优先于 sheet10）', () => {
    const buf = makeZip([
      { name: 'xl/worksheets/sheet2.xml', data: sheetXml('<row r="1"><c r="A1"><v>2</v></c></row>') },
      { name: 'xl/worksheets/sheet10.xml', data: sheetXml('<row r="1"><c r="A1"><v>10</v></c></row>') },
    ]);
    assert.deepEqual(parseXlsx(buf), [['2']]);
  });

  test('★ 注释里藏了一个同签名的假目录尾，仍然找得到真的', () => {
    const sheet = sheetXml('<row r="1"><c r="A1"><v>5</v></c></row>');
    const decoy = Buffer.concat([
      Buffer.from([0x50, 0x4b, 0x05, 0x06]), // 伪造的目录尾签名
      Buffer.from('x'.repeat(96), 'latin1'),
    ]);
    const buf = makeZip([{ name: 'xl/worksheets/sheet1.xml', data: sheet }], decoy);
    assert.deepEqual(parseXlsx(buf), [['5']]);
  });

  test('Uint8Array 也收', () => {
    const buf = makeXlsx({ sheet: sheetXml('<row r="1"><c r="A1"><v>9</v></c></row>') });
    assert.deepEqual(parseXlsx(new Uint8Array(buf)), [['9']]);
  });

  test('不是 zip → 抛清晰错误', () => {
    assert.throws(() => parseXlsx(Buffer.from('这不是 xlsx', 'utf8')), /xlsx/);
  });

  test('是 zip 但没有工作表 → 抛清晰错误（.xls 的典型形状）', () => {
    const buf = makeZip([{ name: 'xl/sharedStrings.xml', data: sharedXml('') }]);
    assert.throws(() => parseXlsx(buf), /工作表/);
  });

  test('不是 Buffer / Uint8Array → 抛', () => {
    // @ts-expect-error 故意传错类型
    assert.throws(() => parseXlsx('xl/worksheets/sheet1.xml'), /Buffer/);
  });
});
