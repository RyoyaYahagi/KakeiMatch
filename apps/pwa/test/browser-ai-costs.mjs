import assert from 'node:assert/strict';
import { chromium } from 'playwright-core';

if (!process.env.PWA_E2E_URL) throw new Error('Set PWA_E2E_URL to an isolated synthetic preview.');
const browser = await chromium.launch({ headless: true, ...(process.env.PWA_BROWSER_PATH ? { executablePath: process.env.PWA_BROWSER_PATH } : {}), args: ['--no-sandbox'] });
const context = await browser.newContext({ viewport: { width: 375, height: 812 }, timezoneId: 'America/Los_Angeles' });
const calls = [];
let feedbackStatus = 'new';
let feedbackSummary = null;
let feedbackIssue = false;
await context.route('**/admin.html', route => route.fulfill({ path: new URL('../admin.html', import.meta.url).pathname }));
await context.route('**/api/admin/**', async route => {
  const request = route.request();
  const url = new URL(request.url());
  calls.push({ method: request.method(), path: url.pathname, search: url.search, body: request.postDataJSON() });
  if (url.pathname.endsWith('/overview')) return route.fulfill({ json: {
    accounts: { registered: 12, activeToday: 3, activeLast30Days: 8, usedAiToday: 5, usedAiLast30Days: 90 },
    ai: { requestsToday: 5, requestsLast30Days: 90, monthUsdMicros: 1234567, unknownRequests: 2, last30DaysErrors: 4, last30DaysRateLimits: 1 },
    feedback: { open: 1 }, recentErrors: [{ code: 'provider_timeout', requests: 4, lastSeen: 1791417600 }],
  } });
  if (url.pathname.endsWith('/ai/costs')) return route.fulfill({ json: {
    month: url.searchParams.get('month'), currency: 'USD', totalUsdMicros: 1234567, unknownRequests: 2,
    providers: {
      gemini: { requests: 3, inputTokens: 1200, outputTokens: 300, costUsdMicros: 1000000, unknownRequests: 1 },
      jev: { requests: 2, inputTokens: 600, outputTokens: 150, costUsdMicros: 234567, unknownRequests: 1 },
    },
  } });
  if (url.pathname.endsWith('/errors')) return route.fulfill({ json: { errors: [{ code: 'provider_timeout', requests: 4, lastSeen: 1791417600 }] } });
  if (url.pathname.endsWith('/users')) return route.fulfill({ json: { users: [{ id: 'synthetic-user', plan: 'family', createdAt: 1790000000, lastAiUseAt: 1791417600, aiRequests: 12, kind: 'registered', enabled: true }] } });
  if (url.pathname.endsWith('/feedback')) return route.fulfill({ json: { items: [{ id: 'feedback-1', createdAt: 1791417600, updatedAt: 1791417600, kind: 'bug', status: feedbackStatus, message: '支出一覧を開くと閉じます。', aiSummary: feedbackSummary, diagnostics: { version: 1, code: 'ui_error' }, githubIssueNumber: feedbackIssue ? 235 : null, githubIssueUrl: feedbackIssue ? 'https://github.com/example/repo/issues/235' : null }] } });
  if (url.pathname.endsWith('/feedback/feedback-1/original')) return route.fulfill({ json: { message: '支出一覧を開くと閉じます。 original@example.com' } });
  if (url.pathname.endsWith('/feedback/feedback-1/analyze')) { feedbackSummary = '支出一覧で画面が閉じる不具合。'; return route.fulfill({ json: { aiSummary: feedbackSummary } }); }
  if (url.pathname.endsWith('/feedback/feedback-1/status')) { feedbackStatus = request.postDataJSON().status; return route.fulfill({ json: { status: feedbackStatus } }); }
  if (url.pathname.endsWith('/feedback/feedback-1/issue')) {
    const body = request.postDataJSON();
    assert.equal(typeof body.title, 'string'); assert.equal(body.title.length > 0, true);
    assert.equal(body.body.includes('## 再現手順'), true);
    assert.equal(body.body.includes('original@example.com'), false, 'original feedback text is never copied into the public issue draft');
    feedbackIssue = true; return route.fulfill({ json: { issueNumber: 235, issueUrl: 'https://github.com/example/repo/issues/235' } });
  }
  if (url.pathname.endsWith('/feedback/feedback-1') && request.method() === 'DELETE') return route.fulfill({ json: { deleted: true } });
  if (url.pathname.endsWith('/feedback/feedback-1')) return route.fulfill({ json: { item: { id: 'feedback-1', createdAt: 1791417600, kind: 'bug', status: feedbackStatus, message: '支出一覧を開くと閉じます。', aiSummary: feedbackSummary, diagnostics: { version: 1, code: 'ui_error' }, githubIssueNumber: feedbackIssue ? 235 : null, githubIssueUrl: feedbackIssue ? 'https://github.com/example/repo/issues/235' : null } } });
  return route.fulfill({ status: 404, json: { error: 'not_found' } });
});

const page = await context.newPage();
const errors = [];
const resources = [];
page.on('pageerror', error => errors.push(error.message));
page.on('dialog', dialog => dialog.accept());
page.on('request', request => resources.push(new URL(request.url()).pathname));
const click = name => page.getByRole('button', { name, exact: true }).click();
try {
  await page.clock.setFixedTime(new Date('2026-10-01T01:00:00Z'));
  await page.goto(new URL('/admin.html', process.env.PWA_E2E_URL).toString());
  await page.getByRole('heading', { name: '管理画面', exact: true }).waitFor();
  await page.getByText('登録アカウント', { exact: true }).waitFor();
  assert.equal(await page.locator('#app-shell').count(), 0, 'admin entry does not initialize the PWA/Actual app shell');
  assert.equal(resources.some(path => /actual|wasm/i.test(path)), false, 'admin entry does not request Actual assets');
  assert.equal(await page.locator('body').innerText().then(text => text.includes('¥0')), false, 'admin view does not show household transaction data');
  assert.equal(await page.locator('.admin-metric-value').first().innerText(), '12');
  if (process.env.PWA_ADMIN_SCREENSHOT_PATH) await page.screenshot({ path: process.env.PWA_ADMIN_SCREENSHOT_PATH, fullPage: true });

  await page.getByRole('tab', { name: 'AI利用', exact: true }).click();
  await page.locator('#admin-panel-ai').getByText('US$1.2346', { exact: true }).waitFor();
  await page.getByText('Gemini', { exact: true }).waitFor();
  await page.getByText('Jev', { exact: true }).waitFor();
  assert.equal(new URLSearchParams(calls.find(call => call.path.endsWith('/ai/costs'))?.search).get('month'), '2026-10');

  await page.getByRole('tab', { name: 'お問い合わせ', exact: true }).click();
  assert.equal(new URL(page.url()).pathname, '/admin/feedback', 'each admin section has a stable deep link');
  await page.getByText('支出一覧を開くと閉じます。', { exact: true }).first().waitFor();
  await page.locator('.admin-feedback-select').click();
  assert.equal(await page.getByText('original@example.com', { exact: true }).count(), 0, 'the original message stays hidden until explicitly requested');
  await click('原文を表示');
  await page.getByText(/original@example.com/).waitFor();
  await click('AIで分析');
  await page.getByText('支出一覧で画面が閉じる不具合。', { exact: true }).waitFor();
  await page.locator('.admin-issue-draft input').fill('一覧画面の表示エラー');
  await page.locator('.admin-issue-draft textarea').fill('## 概要\n一覧を開くと閉じる。\n\n## 再現手順\n1. 一覧を開く');
  if (process.env.PWA_ADMIN_FEEDBACK_SCREENSHOT_PATH) {
    await page.setViewportSize({ width: 1024, height: 900 });
    await page.screenshot({ path: process.env.PWA_ADMIN_FEEDBACK_SCREENSHOT_PATH, fullPage: true });
    await page.setViewportSize({ width: 375, height: 812 });
  }
  await click('内容を確認してIssueを作成');
  await page.getByText('GitHub Issue #235', { exact: true }).waitFor();
  assert.equal(calls.some(call => call.path.endsWith('/analyze')), true, 'AI analysis happens only after an explicit admin action');
  assert.equal(calls.some(call => call.path.endsWith('/issue')), true, 'Issue creation happens only after an explicit admin action');
  await page.getByRole('tab', { name: 'エラー', exact: true }).click();
  await page.locator('#admin-panel-errors').getByText('provider_timeout', { exact: true }).waitFor();
  await page.getByRole('tab', { name: 'ユーザー', exact: true }).click();
  await page.getByText('synthetic-user', { exact: true }).waitFor();
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), '390px admin layout has no horizontal overflow');
  assert.deepEqual(errors, []);
  console.log('PASS: separate admin entry, overview, explicit feedback actions, AI costs, errors/users, and mobile layout');
} catch (error) {
  console.log(await page.locator('body').innerText());
  throw error;
} finally { await browser.close(); }
