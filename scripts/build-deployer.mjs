// Bundle the audited local MAXIMUS TWP core as an immutable deployment payload.
// This script intentionally does not download or execute remote Worker code.
import {build} from 'esbuild';
import {mkdir,writeFile} from 'node:fs/promises';

const core=await build({entryPoints:['worker.js'],write:false,bundle:true,format:'esm',platform:'browser',target:'es2022',external:['cloudflare:sockets'],logLevel:'warning'});
const js=core.outputFiles[0].text;
if(!js.includes('export'))throw new Error('Expected MAXIMUS core ES module export');
await mkdir('deployer/generated',{recursive:true});
await writeFile('deployer/generated/core.js',`// Auto-generated: do not edit or commit.\nexport const CORE_BUNDLE = ${JSON.stringify(js)};\n`);
await mkdir('deployer/dist',{recursive:true});
await build({entryPoints:['deployer/src/index.js'],outfile:'deployer/dist/index.mjs',write:true,bundle:true,format:'esm',platform:'browser',target:'es2022',logLevel:'warning'});
console.log('MAXIMUS Deployer bundled from local worker.js');
