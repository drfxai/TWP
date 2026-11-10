// MAXIMUS Deployer — Cloudflare API orchestration.
// The user's Cloudflare API token is used only for the duration of one deployment
// and is never written to storage, logs or Telegram messages.
const API = 'https://api.cloudflare.com/client/v4';
const COMPAT_DATE = '2024-09-23';
const COMPAT_FLAGS = ['nodejs_compat', 'no_websocket_standard_binary_type'];

export function validateToken(apiToken) {
  if (typeof apiToken !== 'string' || !/^[A-Za-z0-9_-]{30,200}$/.test(apiToken)) {
    throw new Error('INVALID_TOKEN');
  }
}

export function randomHex(bytes) {
  const array = crypto.getRandomValues(new Uint8Array(bytes));
  return Array.from(array, v => v.toString(16).padStart(2, '0')).join('');
}

/** Random lowercase worker / password names such as "dpkm9sb6dt". */
export function randomName(length = 10, alphabet = 'abcdefghijklmnopqrstuvwxyz0123456789') {
  const array = crypto.getRandomValues(new Uint8Array(length));
  let out = alphabet[array[0] % 26]; // always start with a letter
  for (let i = 1; i < length; i++) out += alphabet[array[i] % alphabet.length];
  return out;
}

export function randomPassword(length = 12) {
  return randomName(length, 'abcdefghijkmnopqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789');
}

export function randomUuid() {
  return crypto.randomUUID();
}

export class CloudflareError extends Error {
  constructor(step, status) {
    super(`Cloudflare request failed at "${step}" (HTTP ${status}). Check the token permissions.`);
    this.step = step;
    this.status = status;
  }
}

async function cf({fetcher, token, endpoint, method = 'GET', body, headers = {}, step}) {
  const response = await fetcher(`${API}${endpoint}`, {
    method,
    headers: {Authorization: `Bearer ${token}`, ...headers},
    body,
    redirect: 'error',
  });
  let data = {};
  try { data = await response.json(); } catch { /* never surface raw bodies */ }
  if (!response.ok || data.success === false) {
    // Provider errors are never echoed: they may contain the submitted token.
    throw new CloudflareError(step || endpoint.split('/').slice(-1)[0], response.status);
  }
  return data.result;
}

/** Finds the account the token can manage and its workers.dev subdomain (creating one when missing). */
export async function resolveAccount({apiToken, fetcher = fetch}) {
  validateToken(apiToken);
  const accounts = await cf({fetcher, token: apiToken, endpoint: '/accounts?per_page=5', step: 'accounts'});
  if (!Array.isArray(accounts) || !accounts.length || !/^[a-f0-9]{32}$/.test(accounts[0].id || '')) {
    throw new Error('NO_ACCOUNT');
  }
  const accountId = accounts[0].id;
  let subdomain = '';
  try {
    const current = await cf({fetcher, token: apiToken, endpoint: `/accounts/${accountId}/workers/subdomain`, step: 'subdomain'});
    subdomain = current?.subdomain || '';
  } catch (error) {
    if (!(error instanceof CloudflareError) || error.status !== 404) throw error;
  }
  if (!subdomain) {
    const wanted = 'mx-' + randomName(8);
    const created = await cf({
      fetcher, token: apiToken, endpoint: `/accounts/${accountId}/workers/subdomain`, method: 'PUT',
      headers: {'content-type': 'application/json'}, body: JSON.stringify({subdomain: wanted}), step: 'create-subdomain',
    });
    subdomain = created?.subdomain || wanted;
  }
  if (!/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(subdomain)) throw new Error('BAD_SUBDOMAIN');
  return {accountId, subdomain};
}

async function uploadModule({fetcher, apiToken, accountId, workerName, source, fileName, bindings}) {
  const metadata = {main_module: fileName, compatibility_date: COMPAT_DATE, compatibility_flags: COMPAT_FLAGS, bindings};
  const form = new FormData();
  form.append('metadata', JSON.stringify(metadata));
  form.append(fileName, new Blob([source], {type: 'application/javascript+module'}), fileName);
  await cf({fetcher, token: apiToken, endpoint: `/accounts/${accountId}/workers/scripts/${workerName}`, method: 'PUT', body: form, step: 'upload'});
  await cf({
    fetcher, token: apiToken, endpoint: `/accounts/${accountId}/workers/scripts/${workerName}/subdomain`, method: 'POST',
    headers: {'content-type': 'application/json'}, body: JSON.stringify({enabled: true, previews_enabled: false}), step: 'enable-workers-dev',
  });
}

function assertBundle(source) {
  if (typeof source !== 'string' || source.length < 300 || !source.includes('export')) {
    throw new Error('BUNDLE_MISSING');
  }
}

/** Section 1: MAXIMUS TWP — official Telegram WEB proxy. */
export async function deployTwp({apiToken, coreSource, fetcher = fetch, onProgress = async () => {}}) {
  assertBundle(coreSource);
  await onProgress(15, 'account');
  const {accountId, subdomain} = await resolveAccount({apiToken, fetcher});
  const workerName = randomName(10);
  const proxySecret = randomHex(16);
  await onProgress(45, 'secret');
  await uploadModule({
    fetcher, apiToken, accountId, workerName, source: coreSource, fileName: 'maximus-twp.mjs',
    bindings: [
      {type: 'secret_text', name: 'PROXY_SECRET', text: proxySecret},
      {type: 'plain_text', name: 'MAX_DIALS', text: '45'},
    ],
  });
  await onProgress(85, 'publish');
  const host = `${workerName}.${subdomain}.workers.dev`;
  const args = `server=${encodeURIComponent(host)}&secret=${encodeURIComponent(proxySecret)}`;
  return {
    kind: 'twp', workerName, host,
    dashboard: `https://${host}/`,
    deepLink: `tg://webproxy?${args}`,
    webLink: `https://t.me/webproxy?${args}`,
  };
}

/** Section 2: MAXIMUS VLESS server with its admin panel and KV settings store. */
export async function deployVless({apiToken, vlessSource, fetcher = fetch, onProgress = async () => {}}) {
  assertBundle(vlessSource);
  await onProgress(15, 'account');
  const {accountId, subdomain} = await resolveAccount({apiToken, fetcher});
  const workerName = randomName(10);
  await onProgress(35, 'kv');
  const kv = await cf({
    fetcher, token: apiToken, endpoint: `/accounts/${accountId}/storage/kv/namespaces`, method: 'POST',
    headers: {'content-type': 'application/json'}, body: JSON.stringify({title: `${workerName}-${randomName(6)}`}), step: 'kv',
  });
  if (!kv?.id) throw new Error('KV_FAILED');
  const uuid = randomUuid();
  const password = randomPassword(12);
  await onProgress(60, 'secret');
  await uploadModule({
    fetcher, apiToken, accountId, workerName, source: vlessSource, fileName: 'maximus-vless.mjs',
    bindings: [
      {type: 'kv_namespace', name: 'KV', namespace_id: kv.id},
      {type: 'secret_text', name: 'UUID', text: uuid},
      {type: 'secret_text', name: 'ADMIN_PASSWORD', text: password},
    ],
  });
  await onProgress(85, 'publish');
  const host = `${workerName}.${subdomain}.workers.dev`;
  const path = '/?ed=2560';
  const vlessLink = `vless://${uuid}@${host}:443?encryption=none&security=tls&sni=${host}&fp=randomized&type=ws&host=${host}&path=${encodeURIComponent(path)}#${workerName}`;
  return {
    kind: 'vless', workerName, host, uuid, password,
    kvTitle: kv.title || workerName, kvId: kv.id,
    panel: `https://${host}/admin`,
    subscription: `https://${host}/sub/${uuid}`,
    vlessLink,
  };
}
