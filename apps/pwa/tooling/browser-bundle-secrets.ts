import type { Plugin } from 'vite';

export const browserBundleSecrets: Plugin = {
  name: 'browser-bundle-secret-material-boundary',
  generateBundle(_options, bundle) {
    if (this.environment.name !== 'client') return;
    // AI_EMERGENCY_STOP is a flag, not secret material; values like false occur in normal code.
    const secretBindingNames = [
      'BETTER_AUTH_SECRET', 'ACCOUNT_BOOTSTRAP_SECRET', 'AI_GATEWAY_AUTH_SECRET',
      'GEMINI_API_KEY', 'TYPESAFE_API_KEY', 'GITHUB_ISSUES_TOKEN', 'TURNSTILE_SECRET_KEY',
    ];
    const buildSecrets = secretBindingNames.flatMap(name => {
      const value = process.env[name];
      return value ? [{ name, value }] : [];
    });
    for (const [fileName, item] of Object.entries(bundle)) {
      if (item.type !== 'chunk') continue;
      const match = buildSecrets.find(secret => item.code.includes(secret.value));
      if (match) this.error(`Build secret ${match.name} reached browser chunk ${fileName}`);
      if (/AIza[0-9A-Za-z_-]{30,}/.test(item.code)) this.error(`A Google API key-shaped value reached browser chunk ${fileName}`);
    }
  },
};
