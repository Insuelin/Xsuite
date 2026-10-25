// 轨迹语料一键下载。数据不进仓库，谁要跑谁自己拉。
//
// 用法：
//   node scripts/fetch-data.ts            下载全部
//   node scripts/fetch-data.ts guidaeta   只下这一个
//   node scripts/fetch-data.ts --force    忽略缓存重新下
//   node scripts/fetch-data.ts --list     看看有哪些
//
// 下完会校验 md5，解压到 data/trajectories/<id>/raw/，写一份 meta.json。
// 注意 SapiMouse 和 Balabit 都没有 license，只能本地用，别提交到公开仓库。

import { createHash } from 'node:crypto';
import { createWriteStream, existsSync, mkdirSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { dirname, join } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

interface Dataset {
  /** 人看的名字 */
  name: string;
  /** 缓存里的文件名 */
  file: string;
  url: string;
  /** 官方给的 md5，没有就不校验 */
  md5?: string;
  /** 官方给的字节数，用来发现半截下载 */
  bytes?: number;
  /** null 表示没有协议，不能公开分发 */
  license: string | null;
  homepage: string;
  citation: string;
  /** 只解压这些条目；不给就全解 */
  extract?: string[];
  note?: string;
}

const DATASETS: Record<string, Dataset> = {
  guidaeta: {
    name: 'GUIDÆTA',
    file: 'guidaeta-v1.3.zip',
    url: 'https://zenodo.org/api/records/23314867/files/guidaeta-v1.3.zip/content',
    md5: '39a6854f5778cd0f01d0501442bd7b10',
    bytes: 401_601_541,
    license: 'CC BY-NC 4.0',
    homepage: 'https://zenodo.org/records/23314867',
    citation:
      'Lengauer, Götz, Hoesch, Steinwidder, Tytarenko, Bedek, Schreck. GUIDÆTA — A Versatile Interactions Dataset with extensive Context Information and Metadata. STAG 2025. DOI 10.2312/stag.20251335',
    // db-dump 里是同一批数据的 postgres/sqlite 导出，跟 CSV 重复，不要
    extract: [
      'mouse_events',
      'keyboard_events',
      'sessions.csv',
      'users.csv',
      'task_answers.csv',
      'sentences.csv',
      'images.csv',
      'answers_only_20250701.csv',
      'README.md',
    ],
    note: '论文写 CC BY，Zenodo 记录写 CC BY-NC 4.0，以 Zenodo 为准。',
  },

  sapimouse: {
    name: 'SapiMouse',
    file: 'sapimouse.zip',
    url: 'https://www.ms.sapientia.ro/~manyi/sapimouse/sapimouse.zip',
    bytes: 8_056_327,
    license: null,
    homepage: 'https://www.ms.sapientia.ro/~manyi/sapimouse/sapimouse.html',
    citation:
      'Antal, Egyed-Zsigmond. SapiMouse / Intrusion detection using mouse dynamics. IET Biometrics 2019; SACI 2021. DOI 10.1109/SACI51354.2021.9465583',
    note: '无协议，只能本地研究用。',
  },

  balabit: {
    name: 'Balabit Mouse Dynamics Challenge',
    file: 'balabit-master.zip',
    url: 'https://github.com/balabit/Mouse-Dynamics-Challenge/archive/refs/heads/master.zip',
    license: null,
    homepage: 'https://github.com/balabit/Mouse-Dynamics-Challenge',
    citation: 'Balabit Mouse Dynamics Challenge, 2016. github.com/balabit/Mouse-Dynamics-Challenge',
    note: '无协议（GitHub API 返回 null），2018 年后停更。方向分布最均匀，当补充源。',
  },
};

const ROOT = join('data', 'trajectories');
const CACHE = join(ROOT, '_cache');

function human(bytes: number): string {
  if (bytes >= 1 << 30) return `${(bytes / (1 << 30)).toFixed(2)} GB`;
  if (bytes >= 1 << 20) return `${(bytes / (1 << 20)).toFixed(1)} MB`;
  if (bytes >= 1 << 10) return `${(bytes / (1 << 10)).toFixed(0)} KB`;
  return `${bytes} B`;
}

async function md5File(path: string): Promise<string> {
  const hash = createHash('md5');
  const { createReadStream } = await import('node:fs');
  await pipeline(createReadStream(path), hash);
  return hash.digest('hex');
}

async function download(meta: Dataset, dest: string): Promise<void> {
  const res = await fetch(meta.url, { redirect: 'follow' });
  if (!res.ok || !res.body) throw new Error(`下载失败 ${res.status} ${res.statusText}`);

  const total = Number(res.headers.get('content-length') ?? meta.bytes ?? 0);
  mkdirSync(dirname(dest), { recursive: true });

  let got = 0;
  let last = 0;
  const hash = createHash('md5');

  const source = Readable.fromWeb(res.body as Parameters<typeof Readable.fromWeb>[0]);
  source.on('data', (chunk: Buffer) => {
    hash.update(chunk);
    got += chunk.length;
    // 每 10% 报一次，别刷屏
    const pct = total ? Math.floor((got / total) * 100) : 0;
    if (pct >= last + 10 || got === total) {
      last = pct;
      const tail = total ? ` / ${human(total)}` : '';
      process.stdout.write(`\r  下载 ${pct}%  ${human(got)}${tail}   `);
    }
  });

  await pipeline(source, createWriteStream(dest));
  process.stdout.write('\n');

  const digest = hash.digest('hex');
  if (meta.md5 && digest !== meta.md5) {
    rmSync(dest, { force: true });
    throw new Error(`md5 不对：拿到 ${digest}，期望 ${meta.md5}，文件已删`);
  }
  if (meta.bytes && got !== meta.bytes) {
    rmSync(dest, { force: true });
    throw new Error(`大小不对：拿到 ${got}，期望 ${meta.bytes}，文件已删`);
  }
}

/** Windows 自带的 bsdtar 能解 zip，Git Bash 里那个 GNU tar 不行，写死路径。 */
function tarBin(): string {
  if (process.platform === 'win32') {
    return join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'tar.exe');
  }
  return 'tar';
}

async function extract(meta: Dataset, archive: string, outDir: string): Promise<void> {
  mkdirSync(outDir, { recursive: true });
  const members = meta.extract ?? [];
  const args = ['-xf', archive, '-C', outDir, ...members];
  await new Promise<void>((resolve, reject) => {
    const p = spawn(tarBin(), args, { stdio: 'inherit' });
    p.on('error', reject);
    p.on('close', (code) =>
      code === 0 ? resolve() : reject(new Error(`解压失败，tar 退出码 ${code}`)),
    );
  });
}

function dirSize(path: string): number {
  let total = 0;
  const walk = (p: string) => {
    const st = statSync(p);
    if (st.isDirectory()) for (const e of readdirSync(p)) walk(join(p, e));
    else total += st.size;
  };
  try {
    walk(path);
  } catch {
    /* 不存在就当 0 */
  }
  return total;
}

async function fetchOne(id: string, force: boolean): Promise<void> {
  const meta = DATASETS[id];
  if (!meta) throw new Error(`没有这个数据集：${id}`);

  const archive = join(CACHE, meta.file);
  const rawDir = join(ROOT, id, 'raw');
  const metaPath = join(ROOT, id, 'meta.json');

  console.log(`\n=== ${meta.name} (${id}) ===`);
  console.log(`  ${meta.url}`);
  console.log(`  协议：${meta.license ?? '无（只能本地用，禁止提交到公开仓库）'}`);

  const cached =
    !force &&
    existsSync(archive) &&
    (!meta.bytes || statSync(archive).size === meta.bytes);

  if (cached) {
    console.log(`  缓存命中 ${human(statSync(archive).size)}，跳过下载`);
    if (meta.md5) {
      const digest = await md5File(archive);
      if (digest !== meta.md5) {
        console.log(`  缓存 md5 不对（${digest}），重新下载`);
        await download(meta, archive);
      } else {
        console.log('  md5 校验通过');
      }
    }
  } else {
    await download(meta, archive);
    console.log(`  md5 校验通过（${meta.md5 ?? '官方未提供，跳过'}）`);
  }

  await extract(meta, archive, rawDir);
  console.log(`  解压到 ${rawDir}（${human(dirSize(rawDir))}）`);

  writeFileSync(
    metaPath,
    JSON.stringify(
      {
        id,
        name: meta.name,
        file: meta.file,
        url: meta.url,
        md5: meta.md5 ?? null,
        bytes: meta.bytes ?? null,
        license: meta.license,
        homepage: meta.homepage,
        citation: meta.citation,
        note: meta.note ?? null,
        fetchedAt: new Date().toISOString(),
      },
      null,
      2,
    ),
  );
  console.log(`  记录写到 ${metaPath}`);
}

async function main() {
  const args = process.argv.slice(2);

  if (args.includes('--list')) {
    for (const [id, d] of Object.entries(DATASETS)) {
      console.log(`${id.padEnd(12)} ${d.name.padEnd(32)} ${d.license ?? '无协议'}`);
    }
    return;
  }

  const force = args.includes('--force');
  const wanted = args.filter((a) => !a.startsWith('--'));
  const ids = wanted.length > 0 ? wanted : Object.keys(DATASETS);

  for (const id of ids) await fetchOne(id, force);

  const restricted = ids.filter((id) => DATASETS[id]?.license === null);
  if (restricted.length > 0) {
    console.log(
      `\n提醒：${restricted.join('、')} 没有 license，download 下来只能自己用，` +
        '不要提交进仓库、也不要塞进发布产物。',
    );
  }
  console.log('\n下一步：node scripts/traj-stats.ts guidaeta');
}

main().catch((err) => {
  console.error('\n失败：', (err as Error).message);
  process.exit(1);
});
