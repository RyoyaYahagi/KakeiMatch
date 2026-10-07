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
let contactFailure = null;
let transcribeFailure = null;
let transcribeText = '録音からの合成テキスト';
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
    return route.fulfill({ json: { text: transcribeText } });
  }
  if (url.pathname.endsWith('/api/contact')) {
    const body = route.request().postDataJSON();
    contactRequests.push({ body, authorization: route.request().headers().authorization });
    if (contactFailure) {
      const error = contactFailure;
      contactFailure = null;
      return route.fulfill({ status: 503, json: { error } });
    }
    const kind = body.kind;
    const reply = kind === 'improvement' ? '改善のご要望を受け付けました。' : kind === 'bug' ? '不具合の報告を受け付けました。' : 'お問い合わせありがとうございます。';
    return route.fulfill({ json: { feedbackId: 'synthetic-feedback-id', kind, reply, issueUrl: null } });
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
  await page.getByText(/内部Inboxに保存され、GitHubへ公開されません/).waitFor();

  // Question submissions stay in the contact flow and carry only the typed message.
  await page.locator('#contact-kind').selectOption('question');
  await page.locator('#contact-message').fill('使い方について質問です');
  if (process.env.PWA_CONTACT_SCREENSHOT_PATH) await page.screenshot({ path: process.env.PWA_CONTACT_SCREENSHOT_PATH, fullPage: true });
  if (process.env.PWA_CONTACT_DARK_SCREENSHOT_PATH) {
    await page.emulateMedia({ colorScheme: 'dark' });
    await page.screenshot({ path: process.env.PWA_CONTACT_DARK_SCREENSHOT_PATH, fullPage: true });
    await page.emulateMedia({ colorScheme: 'light' });
  }
  await send();
  await page.getByText('お問い合わせありがとうございます。', { exact: true }).waitFor();
  const questionId = contactRequests.at(-1).body.flowId;
  assert.match(questionId, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
  assert.deepEqual(Object.keys(contactRequests.at(-1).body).sort(), ['flowId', 'kind', 'message']);
  assert.equal(contactRequests.at(-1).body.kind, 'question');
  assert.equal(contactRequests.at(-1).authorization, 'Bearer synthetic-contact-token');
  await send();
  assert.equal(contactRequests.at(-1).body.flowId, questionId, 'unchanged resubmission keeps its flow ID');

  // The selected kind is submitted to an internal inbox; no GitHub link is returned.
  await page.locator('#contact-kind').selectOption('improvement');
  await page.locator('#contact-message').fill('改善の要望です');
  await send();
  await page.getByText('改善のご要望を受け付けました。', { exact: true }).waitFor();
  assert.notEqual(contactRequests.at(-1).body.flowId, questionId);
  assert.equal(await page.locator('#contact-inbox-note').isVisible(), true);
  assert.equal(await page.locator('#contact-result-message').innerText(), '改善の要望です');
  assert.equal(await page.locator('#contact-feedback-id').innerText(), '受付番号: synthetic-feedback-id');
  assert.equal(await page.locator('#contact-issue-link').count(), 0);
  if (process.env.PWA_CONTACT_RESULT_SCREENSHOT_PATH) {
    await page.screenshot({ path: process.env.PWA_CONTACT_RESULT_SCREENSHOT_PATH, fullPage: true });
  }
  await page.locator('#contact-diagnostics-optin').check();

  // Definite failures preserve the text and flow ID for a retry.
  await page.locator('#contact-kind').selectOption('bug');
  await page.locator('#contact-message').fill('不具合の報告です');
  contactFailure = 'temporarily_unavailable';
  await send();
  await page.getByText('現在送信できません。文章はこの画面内に残っています。時間をおいて再度お試しください。', { exact: true }).waitFor();
  const retryId = contactRequests.at(-1).body.flowId;
  assert.equal(await page.locator('#contact-message').inputValue(), '不具合の報告です');
  await send();
  assert.equal(contactRequests.at(-1).body.flowId, retryId);
  await page.getByText('不具合の報告を受け付けました。', { exact: true }).waitFor();

  // Navigation keeps the draft. Stopping a recording automatically transcribes it; a failed transcription can retry the retained audio.
  await page.locator('#contact-message').fill('下書きは移動後も残ります');
  await page.locator('#home-tab').click();
  await openContact();
  assert.equal(await page.locator('#contact-message').inputValue(), '下書きは移動後も残ります');
  assert.equal(await button('音声を文字にする').count(), 0);
  transcribeFailure = 'invalid_provider_response';
  await button('音声を録音').click();
  await button('録音を終了').click();
  await page.getByText('音声を文字にできませんでした。録音はこの画面内に残っています。再試行するか、破棄して録り直してください。', { exact: true }).waitFor();
  assert.equal(await page.evaluate(() => window.__contactMedia.stoppedTracks), 1, 'stopping a recording releases its microphone track');
  assert.equal(await button('録音を再試行する').isVisible(), true, 'failed automatic transcription exposes retry for retained audio');
  const failedAudioFlowId = transcribeRequests.at(-1).body.flowId;
  await button('録音を再試行する').click();
  await page.getByText('音声を文字にしました。送信前に内容を確認してください。', { exact: true }).waitFor();
  assert.equal(transcribeRequests.at(-1).body.flowId, failedAudioFlowId, 'transcription retry reuses the retained audio flow ID');
  assert.equal(await page.locator('#contact-message').inputValue(), '下書きは移動後も残ります\n録音からの合成テキスト');
  const audioRequest = transcribeRequests.at(-1);
  assert.deepEqual(Object.keys(audioRequest.body).sort(), ['audioBase64', 'contentType', 'flowId']);
  assert.equal(audioRequest.body.audioBase64, 'GkXfow==');
  assert.equal(audioRequest.body.contentType, 'audio/webm');
  assert.equal(audioRequest.authorization, 'Bearer synthetic-contact-token');
  await page.locator('#contact-kind').selectOption('question');
  await send();
  await page.getByText('お問い合わせありがとうございます。', { exact: true }).waitFor();
  assert.notEqual(contactRequests.at(-1).body.flowId, audioRequest.body.flowId, 'transcription and message submission use separate flow IDs');

  // An overlong transcription keeps the audio and its ID until the user shortens the draft and retries.
  await page.locator('#contact-message').fill('a'.repeat(3999));
  transcribeText = 'b';
  await button('音声を録音').click();
  await button('録音を終了').click();
  await page.getByText('文字起こし結果を加えると4,000文字を超えます。文章を短くしてから再度お試しください。録音はこの画面内に残っています。', { exact: true }).waitFor();
  const overlongAudioFlowId = transcribeRequests.at(-1).body.flowId;
  assert.equal(await button('録音を再試行する').isVisible(), true, 'overlong result keeps retry available');
  await page.locator('#contact-message').fill('短くした下書き');
  transcribeText = '追加した音声の内容';
  await button('録音を再試行する').click();
  await page.getByText('音声を文字にしました。送信前に内容を確認してください。', { exact: true }).waitFor();
  assert.equal(transcribeRequests.at(-1).body.flowId, overlongAudioFlowId, 'retry after shortening keeps the same audio flow ID');
  assert.equal(await page.locator('#contact-message').inputValue(), '短くした下書き\n追加した音声の内容');
  transcribeText = '録音からの合成テキスト';

  // A recorder failure does not erase text. Closing during pending permission stops the late stream.
  await page.evaluate(() => { window.__contactMedia.failRecording = true; });
  await button('音声を録音').click();
  await page.getByText('録音を完了できませんでした。入力した文章はこの画面内に残っています。', { exact: true }).waitFor();
  assert.equal(await page.locator('#contact-message').inputValue(), '短くした下書き\n追加した音声の内容');
  await page.evaluate(() => { window.__contactMedia.failRecording = false; window.__contactMedia.permissionPending = true; });
  await button('音声を録音').click();
  await page.locator('#settings-tab').click();
  await page.evaluate(() => { window.__contactMedia.resolvePermission?.(); });
  await page.waitForTimeout(50);
  assert.equal(await page.evaluate(() => window.__contactMedia.stoppedTracks), 4, 'a late permission result is stopped after navigation');
  await openContact();
  assert.equal(await page.locator('#contact-message').inputValue(), '短くした下書き\n追加した音声の内容');
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
  console.log('PASS: internal inbox consent, selected kind, stable retry IDs, automatic transcription retries, overlong-result recovery, draft retention, recorder errors, and microphone cleanup on navigation.');
} catch (error) {
  console.log(await page.locator('body').innerText());
  console.log('Synthetic requests:', { contact: contactRequests, transcribe: transcribeRequests });
  throw error;
} finally { await browser.close(); }
