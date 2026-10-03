import assert from 'node:assert/strict';
import { chromium } from 'playwright-core';

if (!process.env.PWA_E2E_URL) throw new Error('Set PWA_E2E_URL to an isolated synthetic preview.');
const browser = await chromium.launch({ headless: true, ...(process.env.PWA_BROWSER_PATH ? { executablePath: process.env.PWA_BROWSER_PATH } : {}), args: ['--no-sandbox'] });
const context = await browser.newContext({ viewport: { width: 375, height: 812 } });
await context.addInitScript(() => {
  navigator.serviceWorker.register = async () => ({});
  const controls = { permissionPending: false, resolvePermission: null, failRecording: false, stoppedTracks: 0, stoppedRecorders: 0 };
  Object.defineProperty(window, '__contactMedia', { value: controls });
  Object.defineProperty(navigator, 'mediaDevices', { configurable: true, value: {
    getUserMedia: async () => {
      if (controls.permissionPending) await new Promise(resolve => { controls.resolvePermission = resolve; });
      const track = { stop: () => { controls.stoppedTracks++; }, addEventListener() {}, removeEventListener() {} };
      return { getTracks: () => [track] };
    },
  } });
  class SyntheticMediaRecorder extends EventTarget {
    static isTypeSupported(type) { return type === 'audio/webm'; }
    constructor(stream, options = {}) { super(); this.stream = stream; this.mimeType = options.mimeType || 'audio/webm'; this.state = 'inactive'; }
    start() {
      this.state = 'recording';
      if (controls.failRecording) queueMicrotask(() => this.onerror?.({ error: new Error('synthetic recorder failure') }));
    }
    stop() {
      if (this.state === 'inactive') return;
      controls.stoppedRecorders++;
      this.state = 'inactive';
      this.ondataavailable?.({ data: new Blob([new Uint8Array([0x1a, 0x45, 0xdf, 0xa3])], { type: this.mimeType }), timecode: 1 });
      this.onstop?.();
    }
  }
  Object.defineProperty(window, 'MediaRecorder', { configurable: true, value: SyntheticMediaRecorder });
});

const contactRequests = [];
const transcribeRequests = [];
const interviewRequests = [];
let contactFailure = null;
let transcribeFailure = null;
let interviewStep = 0;
await context.route('**/api/**', async route => {
  const url = new URL(route.request().url());
  if (url.pathname.endsWith('/api/auth/get-session')) return route.fulfill({ json: null });
  if (url.pathname.endsWith('/api/ai/token')) return route.fulfill({ json: { token: 'synthetic-contact-token', expiresAt: Math.floor(Date.now() / 1000) + 600 } });
  if (url.pathname.endsWith('/api/contact/transcribe')) {
    const body = route.request().postDataJSON();
    transcribeRequests.push({ body, authorization: route.request().headers().authorization });
    if (transcribeFailure) {
      const error = transcribeFailure;
      transcribeFailure = null;
      return route.fulfill({ status: 502, json: { error } });
    }
    return route.fulfill({ json: { text: '録音からの合成テキスト' } });
  }
  if (url.pathname.endsWith('/api/contact/interview')) {
    const body = route.request().postDataJSON();
    interviewRequests.push({ body, authorization: route.request().headers().authorization });
    interviewStep++;
    if (body.finish || body.history.length >= 1) {
      return route.fulfill({ json: { status: 'ready', kind: 'improvement', question: '', recommendation: '', summary: '改善の要望です。\n困っていること: 品目入力までの操作が多い。\n期待すること: 少ない操作で入力したい。\n再現条件: 未確認。' } });
    }
    return route.fulfill({ json: { status: 'ask', kind: 'improvement', question: 'どの場面で一番手間に感じますか？', recommendation: '品目を入力するために何度も操作する場面です。', summary: '' } });
  }
  if (url.pathname.endsWith('/api/contact')) {
    const body = route.request().postDataJSON();
    contactRequests.push({ body, authorization: route.request().headers().authorization });
    if (contactFailure) {
      const error = contactFailure;
      contactFailure = null;
      return route.fulfill({ status: 503, json: { error } });
    }
    if (body.message.includes('改善')) return route.fulfill({ json: { kind: 'improvement', reply: '改善のご要望を受け付けました。', issueUrl: 'https://github.com/example/project/issues/123' } });
    if (body.message.includes('不具合')) return route.fulfill({ json: { kind: 'bug', reply: '不具合の報告を受け付けました。', issueUrl: 'https://github.com/example/project/issues/124' } });
    return route.fulfill({ json: { kind: 'question', reply: 'お問い合わせありがとうございます。', issueUrl: null } });
  }
  return route.fulfill({ json: {} });
});

const page = await context.newPage();
const errors = [];
page.on('pageerror', error => errors.push(error.message));
const button = name => page.getByRole('button', { name, exact: true });
const openContact = async () => {
  await page.locator('#settings-tab').click();
  await button('お問い合わせ').click();
};
const send = async () => button('送信する').click();

try {
  await page.goto(process.env.PWA_E2E_URL);
  await page.getByText('今月の支出 ¥0', { exact: false }).waitFor();
  await openContact();
  await page.getByText(/音声と文章はGoogleに送信されます/).waitFor();

  // Question submissions stay in the contact flow and carry only the typed message.
  await page.locator('#contact-message').fill('使い方について質問です');
  if (process.env.PWA_CONTACT_SCREENSHOT_PATH) await page.screenshot({ path: process.env.PWA_CONTACT_SCREENSHOT_PATH, fullPage: true });
  if (process.env.PWA_CONTACT_DARK_SCREENSHOT_PATH) {
    await page.emulateMedia({ colorScheme: 'dark' });
    await page.screenshot({ path: process.env.PWA_CONTACT_DARK_SCREENSHOT_PATH, fullPage: true });
    await page.emulateMedia({ colorScheme: 'light' });
  }
  await send();
  await page.getByText('お問い合わせありがとうございます。', { exact: true }).waitFor();
  assert.equal(await page.locator('#contact-issue-link').isVisible(), false);
  const questionId = contactRequests.at(-1).body.flowId;
  assert.match(questionId, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
  assert.deepEqual(Object.keys(contactRequests.at(-1).body).sort(), ['flowId', 'message']);
  assert.equal(contactRequests.at(-1).authorization, 'Bearer synthetic-contact-token');
  await send();
  assert.equal(contactRequests.at(-1).body.flowId, questionId, 'unchanged resubmission keeps its flow ID');

  // Editing creates a new flow ID. Improvement reports can return a GitHub issue link.
  await page.locator('#contact-message').fill('改善の要望です');
  await send();
  await page.getByText('改善のご要望を受け付けました。', { exact: true }).waitFor();
  assert.notEqual(contactRequests.at(-1).body.flowId, questionId);
  assert.equal(await page.locator('#contact-issue-link').getAttribute('href'), 'https://github.com/example/project/issues/123');


  // Optional guided interview asks one plain-language question at a time and requires final user approval.
  await page.locator('#contact-message').fill('改善したいけれど、入力が面倒です');
  await page.locator('#contact-interview-optin').check();
  await page.locator('#contact-diagnostics-optin').check();
  assert.equal(await button('詳しくしてから送信').isEnabled(), true);
  await button('詳しくしてから送信').click();
  await page.getByText('どの場面で一番手間に感じますか？', { exact: true }).waitFor();
  assert.equal(await page.getByText('品目を入力するために何度も操作する場面です。', { exact: true }).count(), 1);
  assert.equal(interviewRequests.at(-1).body.history.length, 0);
  assert.equal(interviewRequests.at(-1).body.finish, false);
  const diagnostic = interviewRequests.at(-1).body.diagnostic;
  assert.equal(diagnostic.version, 1);
  assert.equal(diagnostic.currentScreen, 'settings');
  assert.equal(diagnostic.network, 'online');
  assert.equal(Array.isArray(diagnostic.events), true);
  assert.equal(diagnostic.events.some(event => event.screen === 'contact'), false, 'support-screen events are excluded from the attached pre-contact context');
  assert.equal(JSON.stringify(diagnostic).includes('改善したいけれど、入力が面倒です'), false, 'diagnostics never contain the user report text');
  await button('おすすめを使う').click();
  assert.equal(await page.locator('#contact-interview-answer').inputValue(), '品目を入力するために何度も操作する場面です。');
  await button('回答して続ける').click();
  await page.getByRole('heading', { name: '送信内容を確認', exact: true }).waitFor();
  assert.equal(interviewRequests.at(-1).body.history.length, 1);
  assert.deepEqual(interviewRequests.at(-1).body.history[0], {
    question: 'どの場面で一番手間に感じますか？',
    answer: '品目を入力するために何度も操作する場面です。',
  });
  assert.equal(await page.locator('#contact-review-message').inputValue(), '改善の要望です。\n困っていること: 品目入力までの操作が多い。\n期待すること: 少ない操作で入力したい。\n再現条件: 未確認。');
  const beforeApprove = contactRequests.length;
  assert.equal(contactRequests.length, beforeApprove, 'interview does not publish before explicit approval');
  await button('この内容で送信する').click();
  await page.getByText('改善のご要望を受け付けました。', { exact: true }).waitFor();
  const refined = contactRequests.at(-1).body;
  assert.equal(refined.originalMessage, '改善したいけれど、入力が面倒です');
  assert.match(refined.message, /再現条件: 未確認/);
  assert.deepEqual(Object.keys(refined).sort(), ['diagnostic', 'flowId', 'message', 'originalMessage']);
  assert.deepEqual(refined.diagnostic, diagnostic);
  assert.equal(JSON.stringify(refined.diagnostic).includes('品目を入力するために何度も操作する場面です。'), false);
  assert.equal(interviewRequests.every(value => value.authorization === 'Bearer synthetic-contact-token'), true);
  await page.locator('#contact-interview-optin').uncheck();
  await page.locator('#contact-diagnostics-optin').uncheck();

  // Definite failures preserve the text and flow ID for a retry.
  await page.locator('#contact-message').fill('不具合の報告です');
  contactFailure = 'issue_submission_failed';
  await send();
  await page.getByText('お問い合わせを登録できませんでした。文章はこの画面内に残っています。時間をおいて再度お試しください。', { exact: true }).waitFor();
  const retryId = contactRequests.at(-1).body.flowId;
  assert.equal(await page.locator('#contact-message').inputValue(), '不具合の報告です');
  await send();
  assert.equal(contactRequests.at(-1).body.flowId, retryId);
  await page.getByText('不具合の報告を受け付けました。', { exact: true }).waitFor();

  // Ambiguous GitHub results fail closed and require an edit to start a new flow.
  await page.locator('#contact-message').fill('GitHubの登録結果が不明です');
  contactFailure = 'issue_submission_unknown';
  await send();
  await page.getByText('登録結果を確認できませんでした。重複を避けるため再登録を止めています。GitHubの課題一覧をご確認ください。', { exact: true }).waitFor();
  assert.equal(await button('送信する').isDisabled(), true);
  assert.equal(await page.locator('#contact-issues-link').getAttribute('href'), 'https://github.com/RyoyaYahagi/KakeiMatch/issues');
  const blockedId = contactRequests.at(-1).body.flowId;
  await page.locator('#contact-message').fill('GitHubの登録結果が不明です。確認後に再送します');
  await send();
  assert.notEqual(contactRequests.at(-1).body.flowId, blockedId);

  // Navigation keeps the draft. Stopping a recording automatically transcribes it; there is no transcription button.
  await page.locator('#contact-message').fill('下書きは移動後も残ります');
  await page.locator('#home-tab').click();
  await openContact();
  assert.equal(await page.locator('#contact-message').inputValue(), '下書きは移動後も残ります');
  assert.equal(await button('音声を文字にする').count(), 0);
  transcribeFailure = 'invalid_provider_response';
  await button('音声を録音').click();
  await button('録音を終了').click();
  await page.getByText('音声を文字にできませんでした。録音を破棄して録り直してください。', { exact: true }).waitFor();
  assert.equal(await page.evaluate(() => window.__contactMedia.stoppedTracks), 1, 'stopping a recording releases its microphone track');
  assert.equal(await button('録音を破棄して録り直す').isVisible(), true, 'failed automatic transcription keeps audio until the user discards it');
  await button('録音を破棄して録り直す').click();
  await button('音声を録音').click();
  await button('録音を終了').click();
  await page.getByText('音声を文字にしました。送信前に内容を確認してください。', { exact: true }).waitFor();
  assert.equal(await page.locator('#contact-message').inputValue(), '下書きは移動後も残ります\n録音からの合成テキスト');
  const audioRequest = transcribeRequests.at(-1);
  assert.deepEqual(Object.keys(audioRequest.body).sort(), ['audioBase64', 'contentType', 'flowId']);
  assert.equal(audioRequest.body.audioBase64, 'GkXfow==');
  assert.equal(audioRequest.body.contentType, 'audio/webm');
  assert.equal(audioRequest.authorization, 'Bearer synthetic-contact-token');
  await send();
  await page.getByText('お問い合わせありがとうございます。', { exact: true }).waitFor();
  assert.notEqual(contactRequests.at(-1).body.flowId, audioRequest.body.flowId, 'transcription and message submission use separate flow IDs');

  // A recorder failure does not erase text. Closing during pending permission stops the late stream.
  await page.evaluate(() => { window.__contactMedia.failRecording = true; });
  await button('音声を録音').click();
  await page.getByText('録音を完了できませんでした。入力した文章はこの画面内に残っています。', { exact: true }).waitFor();
  assert.equal(await page.locator('#contact-message').inputValue(), '下書きは移動後も残ります\n録音からの合成テキスト');
  await page.evaluate(() => { window.__contactMedia.failRecording = false; window.__contactMedia.permissionPending = true; });
  await button('音声を録音').click();
  await page.locator('#settings-tab').click();
  await page.evaluate(() => { window.__contactMedia.resolvePermission?.(); });
  await page.waitForTimeout(50);
  assert.equal(await page.evaluate(() => window.__contactMedia.stoppedTracks), 4, 'a late permission result is stopped after navigation');
  await openContact();
  assert.equal(await page.locator('#contact-message').inputValue(), '下書きは移動後も残ります\n録音からの合成テキスト');
  await page.evaluate(() => { window.__contactMedia.permissionPending = false; });
  await button('音声を録音').click();
  assert.equal(await button('送信する').isDisabled(), true, 'sending is disabled while the microphone records');
  await page.locator('#home-tab').click();
  assert.equal(await page.evaluate(() => window.__contactMedia.stoppedTracks), 5, 'navigation stops an active recorder and microphone');
  await openContact();
  await page.clock.install();
  await button('音声を録音').click();
  await page.clock.fastForward(60_000);
  await page.getByText('音声を文字にしました。送信前に内容を確認してください。', { exact: true }).waitFor();
  assert.equal(await page.evaluate(() => window.__contactMedia.stoppedTracks), 6, 'recording stops automatically after 60 seconds');
  assert.deepEqual(errors, []);
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
  console.log('PASS: contact consent, guided interview approval, automatic audio transcription, stable retry IDs, draft retention, recorder errors, and microphone cleanup on navigation.');
} catch (error) {
  console.log(await page.locator('body').innerText());
  console.log('Synthetic requests:', { contact: contactRequests, transcribe: transcribeRequests, interview: interviewRequests });
  throw error;
} finally { await browser.close(); }
