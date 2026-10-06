import { build } from 'esbuild';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
const dir=await mkdtemp(join(tmpdir(),'comparison-tests-'));
try {
 await build({entryPoints:['tests/comparison-selection.test.ts'],bundle:true,platform:'node',format:'esm',outfile:join(dir,'test.mjs'),logLevel:'warning',tsconfig:'tsconfig.json'});
 const result=spawnSync(process.execPath,[join(dir,'test.mjs')],{stdio:'inherit'});
 process.exitCode=result.status ?? 1;
} finally { await rm(dir,{recursive:true,force:true}); }
