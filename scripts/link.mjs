// Offline link generator; nothing is uploaded or saved.
import {decodeSecret} from '../src/security.js';
import {linkOf} from '../src/config.js';
const hostname=process.argv[2]?.toLowerCase();
const secret=process.env.PROXY_SECRET;
const path=process.env.BASE_PATH||'';
if(!hostname||!/^([a-z0-9-]+\.)+[a-z0-9-]+$/.test(hostname)||!secret){
  console.error('Usage: PROXY_SECRET=<32 or 34 hex chars> [BASE_PATH=slug] npm run link -- your-worker.your-subdomain.workers.dev');
  process.exitCode=1;
}else{
  const link=linkOf(hostname,{secret:decodeSecret(secret),path});
  process.stdout.write(`${link.deepLink}\n${link.webLink}\n`);
}
