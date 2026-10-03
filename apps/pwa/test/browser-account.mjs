import {readFileSync} from 'node:fs';
import {chromium} from 'playwright-core';
const url=process.env.PWA_E2E_URL;
if (!url || !process.env.PWA_ACCOUNT_SECRET_FILE) throw new Error('Set PWA_E2E_URL to an isolated preview and PWA_ACCOUNT_SECRET_FILE to its private bootstrap secret JSON.');
// The preview uses Cloudflare's always-pass Turnstile testing keys; never run this against production.
const secret=JSON.parse(readFileSync(process.env.PWA_ACCOUNT_SECRET_FILE,'utf8')).ACCOUNT_BOOTSTRAP_SECRET;
const email=`synthetic144-${Date.now()}@example.test`;
const response=await fetch(`${url}/api/account/family-invites`,{method:'POST',headers:{authorization:`Bearer ${secret}`,'content-type':'application/json'},body:JSON.stringify({email})});
if(!response.ok)throw new Error(`Preview Family invite failed ${response.status}`);
const {inviteUrl}=await response.json();
const browser=await chromium.launch({headless:true,...(process.env.PWA_BROWSER_PATH ? { executablePath: process.env.PWA_BROWSER_PATH } : {}),args:['--no-sandbox']});
try{
const context=await browser.newContext();const page=await context.newPage();const cdp=await context.newCDPSession(page);
await cdp.send('WebAuthn.enable');await cdp.send('WebAuthn.addVirtualAuthenticator',{options:{protocol:'ctap2',transport:'internal',hasResidentKey:true,hasUserVerification:true,isUserVerified:true,automaticPresenceSimulation:true}});
await page.goto(inviteUrl);await page.getByText('家族プランの招待',{exact:true}).waitFor();
await page.getByRole('button',{name:'新規登録',exact:true}).click();
await page.getByLabel('表示名',{exact:true}).fill('Synthetic Preview Account');await page.getByLabel('メールアドレス',{exact:true}).fill(email);
await page.waitForFunction(()=>!document.querySelector('#signup-submit')?.disabled,undefined,{timeout:30000});
await page.getByRole('button',{name:'Passkeyを作成して登録',exact:true}).click();
await page.getByText('AI利用の認証を確認しました。',{exact:true}).waitFor({timeout:20000});
await page.getByText('· Free',{exact:false}).waitFor();
await page.getByRole('button',{name:'家族プランを受け取る',exact:true}).click();await page.getByText('今月の読み取り 0回 · Family · 上限なし',{exact:true}).waitFor();
await page.getByRole('button',{name:'ログアウト',exact:true}).click();await page.getByText('ログアウトしました。端末の家計簿データは保持されています。',{exact:true}).waitFor();
await page.getByRole('button',{name:'Passkeyで続ける',exact:true}).click();await page.getByText('AI利用の認証を確認しました。',{exact:true}).waitFor({timeout:20000});
console.log('PASS: isolated preview D1 open signup, virtual Passkey registration/login, Family invite acceptance, session-based AI JWT, logout. No live provider call.');
}finally{await browser.close();}
