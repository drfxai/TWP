// MAXIMUS TWP Deployer — Cloudflare API orchestration.
// Cloudflare tokens are request-scoped, never written to storage or logs.
const API = 'https://api.cloudflare.com/client/v4';
const encoder = new TextEncoder();

export function validateTarget({accountId, subdomain, workerName, apiToken}) {
  if (!/^[a-fA-F0-9]{32}$/.test(accountId || '')) throw new Error('Invalid Cloudflare account ID (expected 32 hexadecimal characters).');
  if (!/^[a-z0-9](?:[a-z0-9-]{1,61}[a-z0-9])?$/.test(subdomain || '')) throw new Error('Invalid workers.dev account subdomain.');
  if (!/^maximus-twp-[a-z0-9](?:[a-z0-9-]{0,42}[a-z0-9])?$/.test(workerName || '')) throw new Error('Worker name must start with maximus-twp- and contain lowercase letters, numbers or hyphens.');
  if (typeof apiToken !== 'string' || !/^[\x21-\x7E]{20,512}$/.test(apiToken) || /["'\\<>]/.test(apiToken)) throw new Error('Invalid API token. Use a scoped Cloudflare API token.');
}

function randomHex(bytes) {
  const array = crypto.getRandomValues(new Uint8Array(bytes));
  return Array.from(array, v => v.toString(16).padStart(2, '0')).join('');
}

async function cloudflareRequest({fetcher, token, endpoint, method, body, headers = {}}) {
  const response = await fetcher(`${API}${endpoint}`, {
    method,
    headers: { Authorization: `Bearer ${token}`, ...headers },
    body,
    redirect: 'error',
  });
  let data = {};
  try { data = await response.json(); } catch { /* no credentials in diagnostics */ }
  if (!response.ok || data.success === false) {
    // Never reflect raw provider errors into client HTML: they may contain entered data.
    throw new Error(`Cloudflare request failed (${response.status}). Check account ID, token scope and subdomain.`);
  }
  return data.result;
}

export async function deployWorker({accountId, subdomain, workerName, apiToken, coreSource, fetcher = fetch}) {
  validateTarget({accountId, subdomain, workerName, apiToken});
  if (typeof coreSource !== 'string' || coreSource.length < 300 || !coreSource.includes('export')) {
    throw new Error('Deployer build is incomplete. Bundle the MAXIMUS core first.');
  }

  const proxySecret = randomHex(16);
  const adminToken = randomHex(32);
  const metadata = {
    main_module: 'maximus-core.mjs',
    compatibility_date: '2024-09-23',
    compatibility_flags: ['nodejs_compat', 'no_websocket_standard_binary_type'],
    bindings: [
      { type: 'secret_text', name: 'PROXY_SECRET', text: proxySecret },
      { type: 'secret_text', name: 'ADMIN_TOKEN', text: adminToken },
      { type: 'plain_text', name: 'MAX_DIALS', text: '45' },
    ],
  };
  const form = new FormData();
  form.append('metadata', JSON.stringify(metadata));
  form.append('maximus-core.mjs', new Blob([coreSource], {type:'application/javascript+module'}), 'maximus-core.mjs');

  await cloudflareRequest({
    fetcher, token: apiToken,
    endpoint: `/accounts/${accountId}/workers/scripts/${workerName}`,
    method:'PUT', body: form,
  });

  // Enabling the account's existing workers.dev subdomain is a separate operation.
  // No domain is created or account settings modified behind the user's back.
  await cloudflareRequest({
    fetcher, token: apiToken,
    endpoint: `/accounts/${accountId}/workers/scripts/${workerName}/subdomain`,
    method:'POST',
    headers:{'content-type':'application/json'},
    body: JSON.stringify({enabled:true,previews_enabled:false}),
  });

  const host = `${workerName}.${subdomain}.workers.dev`;
  const args = `server=${encodeURIComponent(host)}&secret=${encodeURIComponent(proxySecret)}`;
  return {
    host,
    dashboard: `https://${host}/`,
    deepLink: `tg://webproxy?${args}`,
    webLink: `https://t.me/webproxy?${args}`,
    adminToken,
    // Display the transport secret only as part of the connection URL.
    // This is *not* a connectivity test or a promise of Telegram compatibility.
  };
}
