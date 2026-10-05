import { homedir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdir, open, rm } from 'node:fs/promises';
import { dirname } from 'node:path';
import { EncryptedFileTokenStore } from '../packages/chatgpt-plan/token-store';
import { ChatGptPlanAuth } from '../packages/chatgpt-plan/auth';
import { ChatGptPlanClient } from '../packages/chatgpt-plan/client';
import { startChatGptPlanServer } from '../packages/chatgpt-plan/server';

async function start() {
  const root = fileURLToPath(new URL('../', import.meta.url));
  const port = Number(process.env.CHATGPT_PLAN_PORT ?? 1455);
  if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('Invalid loopback port');
  const store = new EncryptedFileTokenStore(process.env.CHATGPT_PLAN_STORE_PATH ?? join(homedir(), '.config/kakeimatch/chatgpt.enc'), process.env.CHATGPT_PLAN_STORE_KEY ?? '', root);
  await mkdir(dirname(store.path), { recursive: true, mode: 0o700 });
  const lockPath = `${store.path}.lock`;
  const lock = await open(lockPath, 'wx', 0o600);
  await lock.writeFile(String(process.pid));
  let released = false;
  const release = async () => { if (released) return; released = true; await lock.close(); await rm(lockPath, { force: true }); };
  const auth = new ChatGptPlanAuth(store);
  let running: Awaited<ReturnType<typeof startChatGptPlanServer>>;
  try { running = await startChatGptPlanServer({ auth, client: new ChatGptPlanClient(auth), port,
    assetsDirectory: join(root, 'apps/pwa/.cloudflare/output/v0/workers/default/assets') }); }
  catch (error) { await release(); throw error; }
  const { origin, server } = running;
  server.once('close', () => { void release(); });
  for (const signal of ['SIGINT', 'SIGTERM'] as const) process.once(signal, () => { server.close(); });
  console.log(`KakeiMatch self-hosted preview: ${origin}`);
}
void start().catch(() => { console.error('セルフホスト設定を確認してください。暗号化保管用の秘密鍵と専用buildが必要です。'); process.exitCode = 1; });
