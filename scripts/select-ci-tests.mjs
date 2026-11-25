import { appendFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export function skipRootChecks(files) {
  return files.length > 0 && files.every(file =>
    file.startsWith('apps/ios/') ||
    file === '.github/workflows/ios.yml' ||
    file === 'scripts/testflight.test.mjs');
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  let files = [];
  if (process.env.GITHUB_EVENT_NAME === 'pull_request') {
    try {
      files = execFileSync('git', ['diff', '--no-renames', '--name-only', '-z',
        `${process.env.BASE_SHA}...${process.env.HEAD_SHA}`], { encoding: 'utf8' }).split('\0').filter(Boolean);
    } catch {
      console.warn('Could not compare PR commits; running all checks.');
    }
  }
  appendFileSync(process.env.GITHUB_OUTPUT, `skip_root=${skipRootChecks(files)}\n`);
}
