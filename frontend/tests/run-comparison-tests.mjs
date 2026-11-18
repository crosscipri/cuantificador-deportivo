import { build } from 'esbuild';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
const files=['tests/comparison-selection.test.ts','tests/comparison-total-charts.test.ts'];
const dir=await mkdtemp(join(tmpdir(),'comparison-tests-'));
try {
  let failed=false;
  for (const entry of files) {
    const outfile=join(dir, entry.split('/').pop().replace(/\.ts$/, '.mjs'));
    await build({entryPoints:[entry],bundle:true,platform:'node',format:'esm',outfile,logLevel:'warning',tsconfig:'tsconfig.json'});
    const result=spawnSync(process.execPath,[outfile],{stdio:'inherit'});
    if ((result.status ?? 1) !== 0) failed=true;
  }
  process.exitCode=failed ? 1 : 0;
} finally { await rm(dir,{recursive:true,force:true}); }
