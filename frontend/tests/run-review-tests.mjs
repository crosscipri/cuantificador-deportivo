import { build } from 'esbuild';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
const dir=await mkdtemp(join(tmpdir(),'review-tests-'));
try {
 await build({entryPoints:['tests/review-editor.test.ts'],bundle:true,preserveSymlinks:true,platform:'node',format:'esm',outfile:join(dir,'test.mjs'),logLevel:'warning',tsconfig:'tsconfig.json',plugins:[{name:'no-browser-map-in-controller-tests',setup(b){b.onResolve({filter:/^leaflet$/},()=>({path:'leaflet',namespace:'test-stub'}));b.onLoad({filter:/.*/,namespace:'test-stub'},()=>({contents:'export const map=()=>{throw new Error("Map rendering is outside these controller tests")}; export const tileLayer=map,layerGroup=map,latLngBounds=map,latLng=map,circleMarker=map,polyline=map;'}));}}]});
 const result=spawnSync(process.execPath,[join(dir,'test.mjs')],{stdio:'inherit'});
 process.exitCode=result.status ?? 1;
} finally { await rm(dir,{recursive:true,force:true}); }
