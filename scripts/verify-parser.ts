// 用录制的样本验证解析器。不需要浏览器。
// 用法：node scripts/verify-parser.ts [样本目录]

import fs from 'node:fs';
import path from 'node:path';
import { config } from '../src/core/config.ts';
import { parseTimeline, dedupeUsers, parseTwitterDate } from '../src/core/cdp/parsers.ts';

const dir = process.argv[2] ?? (() => {
  const base = path.join(config.dataDir, 'samples');
  const dirs = fs.existsSync(base) ? fs.readdirSync(base).sort() : [];
  return dirs.length ? path.join(base, dirs[dirs.length - 1]) : '';
})();

if (!dir || !fs.existsSync(dir)) {
  console.error('找不到样本目录。先跑 node scripts/dev/record-graphql.ts');
  process.exit(1);
}

console.log('样本目录:', dir);
const files = fs.readdirSync(dir).filter((f) => f.endsWith('.json') && f !== 'index.json');
console.log(`样本数: ${files.length}\n`);

let total = 0;
for (const f of files) {
  const json = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
  const page = parseTimeline(json);
  const unique = dedupeUsers(page.users);
  total += unique.length;

  console.log(`--- ${f} ---`);
  console.log(`  用户 ${page.users.length} 条，去重后 ${unique.length}`);
  console.log(`  bottomCursor: ${page.bottomCursor?.slice(0, 40) ?? '无'}`);
  console.log(`  terminated: ${page.terminated}`);

  const sample = unique[0];
  if (sample) {
    console.log('  样例:', JSON.stringify(sample, null, 2).replace(/\n/g, '\n  '));
  }

  const incomplete = unique.filter((u) => !u.handle || !u.id);
  if (incomplete.length) console.log(`  ⚠ 缺字段 ${incomplete.length} 条`);
}

console.log(`\n合计解析出 ${total} 个用户`);

// 日期解析自检
console.log('\n日期解析:');
for (const d of ['Sat Sep 26 15:49:18 +0000 2015', 'Wed Oct 10 12:00:00 +0000 2018', 'bogus']) {
  console.log(`  ${JSON.stringify(d)} → ${parseTwitterDate(d)}`);
}
