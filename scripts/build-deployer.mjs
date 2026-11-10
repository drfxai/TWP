// Bundle the audited local MAXIMUS cores (TWP + VLESS) as immutable deployment payloads.
// This script intentionally does not download or execute remote Worker code.
import {build} from 'esbuild';
import {mkdir,writeFile} from 'node:fs/promises';

const bundle=async entry=>{
  const out=await build({entryPoints:[entry],write:false,bundle:true,format:'esm',platform:'browser',target:'es2022',external:['cloudflare:sockets'],logLevel:'warning'});
  const js=out.outputFiles[0].text;
  if(!js.includes('export'))throw new Error('Expected ES module export in '+entry);
  return js;
};
const core=await bundle('worker.js');
const vless=await bundle('vless/worker.js');
await mkdir('deployer/generated',{recursive:true});
await writeFile('deployer/generated/core.js',`// Auto-generated: do not edit or commit.\nexport const CORE_BUNDLE = ${JSON.stringify(core)};\nexport const VLESS_BUNDLE = ${JSON.stringify(vless)};\n`);
await mkdir('deployer/dist',{recursive:true});
await build({entryPoints:['deployer/src/index.js'],outfile:'deployer/dist/index.mjs',write:true,bundle:true,format:'esm',platform:'browser',target:'es2022',logLevel:'warning'});
console.log('MAXIMUS Deployer bundled from local worker.js and vless/worker.js');
