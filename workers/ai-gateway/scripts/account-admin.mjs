// Operator-only Cloud account commands. The bootstrap secret is read from the
// environment and sent only in the Authorization header, never in a URL.
const operation = process.argv[2];
const email = process.argv[3];
const baseUrl = process.env.ACCOUNT_ADMIN_URL;
const secret = process.env.ACCOUNT_BOOTSTRAP_SECRET;

const usage = [
  'Usage: ACCOUNT_ADMIN_URL=https://... ACCOUNT_BOOTSTRAP_SECRET=... node scripts/account-admin.mjs family-invite [email]',
  '   or: ACCOUNT_ADMIN_URL=https://... ACCOUNT_BOOTSTRAP_SECRET=... node scripts/account-admin.mjs recover <email>',
];

if (!['family-invite', 'recover'].includes(operation) || (operation === 'recover' && !email)) {
  for (const line of usage) console.error(line);
  process.exitCode = 2;
} else if (!baseUrl || !secret) {
  console.error('ACCOUNT_ADMIN_URL and ACCOUNT_BOOTSTRAP_SECRET are required.');
  process.exitCode = 2;
} else {
  const origin = new URL(baseUrl);
  if (!['https:', 'http:'].includes(origin.protocol) || origin.username || origin.password) {
    console.error('ACCOUNT_ADMIN_URL must be an http(s) URL without embedded credentials.');
    process.exitCode = 2;
  } else {
    const endpoint = new URL(operation === 'recover' ? '/api/account/recovery' : '/api/account/family-invites', origin);
    const response = await fetch(endpoint, {
      method: 'POST',
      headers: { authorization: `Bearer ${secret}`, 'content-type': 'application/json' },
      body: JSON.stringify(email ? { email } : {}),
    });
    const result = await response.json().catch(() => null);
    if (!response.ok) {
      console.error(`Account operation failed with HTTP ${response.status}: ${result?.error ?? 'unknown_error'}`);
      process.exitCode = 1;
    } else {
      console.log(JSON.stringify(result, null, 2));
    }
  }
}
