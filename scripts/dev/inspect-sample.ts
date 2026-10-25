// 分析 GraphQL 样本结构，为 parsers.ts 提供依据。
// 用法：node scripts/dev/inspect-sample.ts <样本文件>

import fs from 'node:fs';

const file = process.argv[2];
if (!file) {
  console.error('用法: node scripts/dev/inspect-sample.ts <json 文件>');
  process.exit(1);
}

const j = JSON.parse(fs.readFileSync(file, 'utf8'));

console.log('顶层 keys:', Object.keys(j));

function findInstructions(node: any, path = 'data'): any[] | null {
  if (!node || typeof node !== 'object') return null;
  if (Array.isArray(node.instructions)) return node.instructions;
  for (const [k, v] of Object.entries(node)) {
    if (v && typeof v === 'object') {
      const r = findInstructions(v, `${path}.${k}`);
      if (r) {
        console.log('instructions 位置:', path + '.' + k);
        return r;
      }
    }
  }
  return null;
}

const instructions = findInstructions(j);
if (!instructions) {
  console.log('没找到 instructions');
  process.exit(0);
}

console.log('指令类型:', instructions.map((i) => i.type));

for (const ins of instructions) {
  if (ins.type !== 'TimelineAddEntries') continue;
  const entries = ins.entries || [];
  console.log(`\nentries 数量: ${entries.length}`);
  console.log('entry 类型分布:', entries.reduce((acc: Record<string, number>, e: any) => {
    const t = e.content?.__typename || e.content?.entryType || 'unknown';
    acc[t] = (acc[t] ?? 0) + 1;
    return acc;
  }, {}));

  // 第一个用户条目
  const userEntry = entries.find((e: any) => e.content?.itemContent?.user_results);
  if (userEntry) {
    console.log('\n=== 第一个用户条目 ===');
    console.log('entryId:', userEntry.entryId);
    const u = userEntry.content.itemContent.user_results.result;
    console.log('user keys:', Object.keys(u));
    console.log('rest_id:', u.rest_id);
    console.log('__typename:', u.__typename);

    console.log('\n=== 新结构字段 ===');
    for (const key of ['core', 'avatar', 'relationship_counts', 'tweet_counts', 'verification', 'privacy', 'profile_bio', 'location', 'id', 'is_blue_verified', 'profile_metadata']) {
      console.log(key + ':', JSON.stringify(u[key]).slice(0, 500));
    }

    if (u.legacy) {
      const l = u.legacy;
      console.log('legacy keys:', Object.keys(l).join(', '));      console.log({
        screen_name: l.screen_name,
        name: l.name,
        followers_count: l.followers_count,
        friends_count: l.friends_count,
        statuses_count: l.statuses_count,
        created_at: l.created_at,
        verified: l.verified,
        protected: l.protected,
        location: l.location,
        description: (l.description || '').slice(0, 60),
        profile_image_url_https: l.profile_image_url_https,
      });
    }
    if (u.core) console.log('core:', JSON.stringify(u.core).slice(0, 300));
  }

  // cursor 条目
  const cursors = entries.filter((e: any) => e.content?.cursorType);
  for (const c of cursors) {
    console.log(`\ncursor: type=${c.content.cursorType} value=${String(c.content.value).slice(0, 60)}`);
  }
}

// 找 timeline 里其他指令
for (const ins of instructions) {
  if (ins.type !== 'TimelineAddEntries') {
    console.log(`\n指令 ${ins.type}:`, JSON.stringify(ins).slice(0, 300));
  }
}
