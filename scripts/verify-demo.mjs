import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const dist = fileURLToPath(new URL('../dist/', import.meta.url));

async function filesUnder(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = await Promise.all(entries.map((entry) => {
    const path = join(directory, entry.name);
    return entry.isDirectory() ? filesUnder(path) : path;
  }));
  return files.flat();
}

const files = await filesUnder(dist);
if (!files.some((file) => file.endsWith('index.html'))) {
  throw new Error('Demo build did not emit index.html.');
}

const bundle = (await Promise.all(files.map((file) => readFile(file, 'utf8')))).join('\n');

for (const expected of ['Read-only demo', 'synthetic data', "Tony's Pizza Co."]) {
  if (!bundle.includes(expected)) throw new Error(`Demo bundle is missing: ${expected}`);
}

const forbidden = [
  'SUPABASE_SERVICE_KEY',
  'SUPABASE_URL',
  'ANTHROPIC_API_KEY',
  'sb_secret_',
  'sk-ant-',
];

for (const secret of forbidden) {
  if (bundle.includes(secret)) throw new Error(`Demo bundle contains forbidden value: ${secret}`);
}

console.log(`Verified ${files.length} static demo files: synthetic data present, no credential markers found.`);
