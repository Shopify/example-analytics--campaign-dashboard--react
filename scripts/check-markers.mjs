import {readdirSync, readFileSync, statSync} from 'node:fs';
import {join} from 'node:path';

// Each start/end pair below names an excerpt the tutorial pulls out of this repo. Moving
// one half out of its pair breaks that excerpt on shopify.dev, with nothing there to
// catch it. Skip this file, because the pattern matches itself.
const SKIP = new Set([
  'node_modules',
  '.git',
  'build',
  'dist',
  '.cache',
  '.shopify',
  'check-markers.mjs',
]);
const TAG = /\[(START|END) ([^\]]+)\]/g;

function walk(dir) {
  return readdirSync(dir).flatMap((name) => {
    if (SKIP.has(name)) return [];
    const path = join(dir, name);
    return statSync(path).isDirectory() ? walk(path) : [path];
  });
}

const counts = new Map();
for (const path of walk('.')) {
  let text;
  try {
    text = readFileSync(path, 'utf8');
  } catch {
    continue;
  }
  for (const [, kind, tag] of text.matchAll(TAG)) {
    const seen = counts.get(tag) ?? {START: 0, END: 0};
    seen[kind] += 1;
    counts.set(tag, seen);
  }
}

const broken = [...counts.entries()].filter(
  ([, seen]) => seen.START !== 1 || seen.END !== 1,
);

for (const [tag, seen] of broken) {
  console.error(`${tag}: ${seen.START} START, ${seen.END} END`);
}

console.log(`${counts.size} tags, ${broken.length} broken`);
process.exit(broken.length ? 1 : 0);
