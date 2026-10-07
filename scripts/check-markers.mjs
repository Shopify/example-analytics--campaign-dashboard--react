import {readdirSync, readFileSync, statSync} from 'node:fs';
import {join} from 'node:path';

// Each start/end pair below names an excerpt the tutorial pulls out of this repo. Moving
// one half out of its pair breaks that excerpt on shopify.dev, with nothing there to
// catch it. A tag can repeat in a file, and the excerpt joins the pairs. Skip this
// file, because the pattern matches itself.
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
const tags = new Set();
for (const path of walk('.')) {
  let text;
  try {
    text = readFileSync(path, 'utf8');
  } catch {
    continue;
  }
  for (const [, kind, tag] of text.matchAll(TAG)) {
    const key = `${path}: ${tag}`;
    const seen = counts.get(key) ?? {START: 0, END: 0};
    seen[kind] += 1;
    counts.set(key, seen);
    tags.add(tag);
  }
}

const broken = [...counts.entries()].filter(
  ([, seen]) => seen.START !== seen.END,
);

for (const [key, seen] of broken) {
  console.error(`${key}: ${seen.START} START, ${seen.END} END`);
}

console.log(`${tags.size} tags, ${broken.length} broken`);
process.exit(broken.length ? 1 : 0);
