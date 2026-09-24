import { spawnSync } from 'node:child_process';

if (!process.env.DATABASE_URL) {
  console.error('DATABASE_URL is required');
  process.exit(1);
}

for (const file of ['schema.sql', 'test_detection.sql']) {
  const result = spawnSync(
    'psql',
    [process.env.DATABASE_URL, '-v', 'ON_ERROR_STOP=1', '-f', file],
    { stdio: 'inherit', shell: process.platform === 'win32' },
  );
  if (result.error) {
    console.error(result.error.message);
    process.exit(1);
  }
  if (result.status !== 0) process.exit(result.status ?? 1);
}
