import { build } from 'esbuild';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

const dir = await mkdtemp(join(tmpdir(), 'precision-price-tests-'));
try {
  for (const name of ['precision-price-charts', 'precision-price-details']) {
    await build({
      entryPoints: [`tests/${name}.test.ts`],
      bundle: true,
      platform: 'node',
      format: 'esm',
      outfile: join(dir, `${name}.mjs`),
      logLevel: 'warning',
      tsconfig: 'tsconfig.json',
    });
    const result = spawnSync(process.execPath, [join(dir, `${name}.mjs`)], { stdio: 'inherit' });
    if ((result.status ?? 1) !== 0) {
      process.exitCode = result.status ?? 1;
      break;
    }
  }
} finally {
  await rm(dir, { recursive: true, force: true });
}
