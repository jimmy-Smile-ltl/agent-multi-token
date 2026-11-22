#!/usr/bin/env node
// @ts-check
/**
 * cmt 入口——只做转发，不放任何业务逻辑。
 * 业务全在 src/cli/main.js。
 */
import { main } from '../src/cli/main.js';

main(process.argv.slice(2))
  .then((code) => {
    process.exitCode = code;
  })
  .catch((err) => {
    // main 内部已负责把 CmtError 渲染成人话；走到这里说明是意料之外的崩溃
    console.error(err?.stack ?? String(err));
    process.exitCode = 2;
  });
