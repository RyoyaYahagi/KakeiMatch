const operation = process.argv[2];
const email = process.argv[3];
const name = process.argv[4];
const baseUrl = process.env.ACCOUNT_ADMIN_URL;
const secret = process.env.ACCOUNT_BOOTSTRAP_SECRET;

if (!['invite', 'recover'].includes(operation) || !email || (operation === 'invite' && !name)) {
  console.error('Usage: ACCOUNT_ADMIN_URL=https://... ACCOUNT_BOOTSTRAP_SECRET=... node scripts/account-invite.mjs invite <email> <name>');
  console.error('   or: ACCOUNT_ADMIN_URL=https://... ACCOUNT_BOOTSTRAP_SECRET=... node scripts/account-invite.mjs recover <email>');
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
    const endpoint = new URL(operation === 'recover' ? '/api/account/recovery' : '/api/account/invites', origin);
    const response = await fetch(endpoint, {
      method: 'POST',
      headers: { authorization: `Bearer ${secret}`, 'content-type': 'application/json' },
      body: JSON.stringify({ email, ...(name ? { name } : {}) }),
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
