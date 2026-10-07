import { iconMarkup } from './ui-icons';
import { getAiAccessToken } from './ai-auth';
import { getSanitizedDiagnosticContext, recordDiagnosticAction, recordDiagnosticFailure, type SanitizedDiagnosticContext } from './contact-diagnostics';

type ContactResult = { kind: 'bug' | 'improvement' | 'question'; reply: string; issueUrl: string | null };
type ContactInterviewResult = { status: 'ask' | 'ready'; kind: 'bug' | 'improvement' | 'question'; question: string; recommendation: string; summary: string };
type InterviewTurn = { question: string; answer: string };
type ContactOptions = { onBackToSettings: (focusLogin?: boolean) => void };

const MAX_MESSAGE_LENGTH = 4000;
const MAX_AUDIO_BYTES = 2 * 1024 * 1024;
const MAX_RECORDING_MS = 60_000;

export function initializeContactUi(container: HTMLElement, options: ContactOptions) {
  container.innerHTML = `
    <div class="page-header contact-header">
      <button class="text-button contact-back" type="button">‹ 設定へ戻る</button>
      <h2>お問い合わせ</h2>
    </div>
    <section class="surface-section contact-panel">
      <p class="contact-consent">音声と文章はGoogleに送信されます。不具合や改善のご要望は、送信した文章がGitHubで公開される場合があります。氏名や家計情報は入力しないでください。</p>
      <label for="contact-message">お問い合わせ内容</label>
      <textarea id="contact-message" maxlength="4000" aria-describedby="contact-count contact-status" placeholder="お困りのことや改善のご希望を入力してください"></textarea>
      <div class="contact-meta"><span id="contact-count">0 / 4000文字</span><span id="contact-recording-time" aria-live="polite"></span></div>
      <div class="contact-actions">
        <button id="contact-record" class="secondary" type="button">音声を録音</button>
        <button id="contact-discard-audio" class="secondary" type="button" hidden>${iconMarkup('repeat')}録音を破棄して録り直す</button>
        <button id="contact-retry-transcription" class="secondary" type="button" hidden>${iconMarkup('repeat')}録音を再試行する</button>
      </div>
      <p id="contact-audio-status" class="muted" role="status"></p>
      <label class="contact-interview-consent">
        <input id="contact-interview-optin" type="checkbox">
        <span><strong>送信前にAIに詳しく聞いてもらう（推奨）</strong><small>1問ずつ、わかりやすく確認します。おすすめ回答はそのまま使うか、書き直せます。</small></span>
      </label>
      <label class="contact-interview-consent contact-diagnostic-consent">
        <input id="contact-diagnostics-optin" type="checkbox">
        <span><strong>直前のアプリ動作情報を添付する（推奨）</strong><small>画面名・操作種別・安全なエラーコード・オンライン状態だけを使います。入力内容、金額、店名、レシートや明細の内容は含みません。</small></span>
      </label>
      <section id="contact-interview" class="contact-interview" hidden>
        <h3>もう少し詳しく教えてください</h3>
        <p id="contact-interview-question" class="contact-interview-question"></p>
        <div class="contact-recommendation">
          <span>おすすめ回答</span>
          <p id="contact-interview-recommendation"></p>
          <button id="contact-use-recommendation" class="secondary" type="button">おすすめを使う</button>
        </div>
        <label for="contact-interview-answer">あなたの回答</label>
        <textarea id="contact-interview-answer" maxlength="1200" placeholder="わかる範囲で大丈夫です"></textarea>
        <div class="contact-interview-actions">
          <button id="contact-interview-next" class="primary" type="button">回答して続ける</button>
          <button id="contact-interview-finish" class="secondary" type="button">ここまででまとめる</button>
        </div>
      </section>
      <section id="contact-review" class="contact-review" hidden>
        <h3>送信内容を確認</h3>
        <p class="muted">AIは原因や修正方法を決めず、あなたが伝えた内容だけを整理します。違うところがあれば直してから送信してください。</p>
        <label for="contact-review-message">GitHubへ送る内容</label>
        <textarea id="contact-review-message" maxlength="4000"></textarea>
        <div class="contact-interview-actions">
          <button id="contact-confirm-send" class="primary" type="button">この内容で送信する</button>
          <button id="contact-review-edit" class="secondary" type="button">${iconMarkup('pencil')}元の内容を直す</button>
        </div>
      </section>
      <p id="contact-status" class="status" role="status" aria-live="polite"></p>
      <a id="contact-issues-link" class="contact-issues-link" href="https://github.com/RyoyaYahagi/KakeiMatch/issues" target="_blank" rel="noreferrer" hidden>GitHubの課題一覧を確認する</a>
      <div class="form-actions contact-send-bar"><button id="contact-send" class="primary" type="button" disabled>送信する</button></div>
      <button id="contact-login-path" class="text-button" type="button" hidden>設定でログインする</button>
      <section id="contact-result" class="contact-result" aria-live="polite" hidden>
        <h3 id="contact-result-title"></h3>
        <p id="contact-result-reply"></p>
        <h4>送信した内容</h4>
        <p id="contact-result-message"></p>
        <a id="contact-issue-link" target="_blank" rel="noreferrer" hidden>GitHubで内容を見る</a>
        <button id="contact-edit-result" class="secondary" type="button">${iconMarkup('pencil')}内容を編集する</button>
      </section>
    </section>`;

  const message = container.querySelector<HTMLTextAreaElement>('#contact-message')!;
  const count = container.querySelector<HTMLElement>('#contact-count')!;
  const recordButton = container.querySelector<HTMLButtonElement>('#contact-record')!;
  const discardAudioButton = container.querySelector<HTMLButtonElement>('#contact-discard-audio')!;
  const retryTranscriptionButton = container.querySelector<HTMLButtonElement>('#contact-retry-transcription')!;
  const sendButton = container.querySelector<HTMLButtonElement>('#contact-send')!;
  const interviewOptIn = container.querySelector<HTMLInputElement>('#contact-interview-optin')!;
  const diagnosticsOptIn = container.querySelector<HTMLInputElement>('#contact-diagnostics-optin')!;
  const interviewPanel = container.querySelector<HTMLElement>('#contact-interview')!;
  const interviewQuestion = container.querySelector<HTMLElement>('#contact-interview-question')!;
  const interviewRecommendation = container.querySelector<HTMLElement>('#contact-interview-recommendation')!;
  const interviewAnswer = container.querySelector<HTMLTextAreaElement>('#contact-interview-answer')!;
  const interviewNext = container.querySelector<HTMLButtonElement>('#contact-interview-next')!;
  const interviewFinish = container.querySelector<HTMLButtonElement>('#contact-interview-finish')!;
  const useRecommendation = container.querySelector<HTMLButtonElement>('#contact-use-recommendation')!;
  const reviewPanel = container.querySelector<HTMLElement>('#contact-review')!;
  const reviewMessage = container.querySelector<HTMLTextAreaElement>('#contact-review-message')!;
  const confirmSend = container.querySelector<HTMLButtonElement>('#contact-confirm-send')!;
  const reviewEdit = container.querySelector<HTMLButtonElement>('#contact-review-edit')!;
  const status = container.querySelector<HTMLElement>('#contact-status')!;
  const audioStatus = container.querySelector<HTMLElement>('#contact-audio-status')!;
  const recordingTime = container.querySelector<HTMLElement>('#contact-recording-time')!;
  const result = container.querySelector<HTMLElement>('#contact-result')!;
  const loginPathButton = container.querySelector<HTMLButtonElement>('#contact-login-path')!;

  let active = false;
  let flowId: string | null = null;
  let audioFlowId: string | null = null;
  let flowMessage = '';
  let unknownFlowId: string | null = null;
  let audioBlob: Blob | null = null;
  let mediaStream: MediaStream | null = null;
  let recorder: MediaRecorder | null = null;
  let chunks: BlobPart[] = [];
  let recordingBytes = 0;
  let recordingTooLarge = false;
  let timer: number | null = null;
  let startedAt = 0;
  let requestingPermission = false;
  let stoppingRecording = false;
  let permissionGeneration = 0;
  let requestController: AbortController | null = null;
  let busy = false;
  let interviewOriginalMessage = '';
  let interviewHistory: InterviewTurn[] = [];
  let interviewFlowId: string | null = null;
  let currentInterviewQuestion = '';
  let diagnosticContext: SanitizedDiagnosticContext | null = null;

  const uuid = () => crypto.randomUUID();
  const submissionKey = (value: string, originalMessage?: string) => JSON.stringify({ message: value, originalMessage: originalMessage ?? null });
  const cleanRecordingResources = (stopRecorder: boolean) => {
    if (timer !== null) window.clearInterval(timer);
    timer = null;
    recordingTime.textContent = '';
    if (stopRecorder && recorder) {
      recorder.ondataavailable = null;
      recorder.onstop = null;
      recorder.onerror = null;
      if (recorder.state !== 'inactive') recorder.stop();
    }
    recorder = null;
    recordButton.textContent = '音声を録音';
    chunks = [];
    recordingBytes = 0;
    mediaStream?.getTracks().forEach(track => track.stop());
    mediaStream = null;
  };
  const update = () => {
    count.textContent = `${message.value.length} / ${MAX_MESSAGE_LENGTH}文字`;
    const interviewing = !interviewPanel.hidden || !reviewPanel.hidden;
    message.disabled = busy || interviewing;
    interviewOptIn.disabled = busy || interviewing;
    diagnosticsOptIn.disabled = busy || interviewing;
    const directBlocked = unknownFlowId !== null && unknownFlowId === flowId && flowMessage === submissionKey(message.value);
    sendButton.disabled = busy || interviewing || requestingPermission || stoppingRecording || recorder?.state === 'recording' || !message.value.trim() || message.value.length > MAX_MESSAGE_LENGTH || directBlocked;
    sendButton.textContent = interviewOptIn.checked ? '詳しくしてから送信' : '送信する';
    recordButton.disabled = busy || interviewing || requestingPermission || stoppingRecording || audioBlob !== null;
    discardAudioButton.hidden = audioBlob === null;
    discardAudioButton.disabled = busy || interviewing;
    retryTranscriptionButton.hidden = audioBlob === null;
    retryTranscriptionButton.disabled = busy || interviewing || requestingPermission || stoppingRecording || recorder?.state === 'recording';
    interviewAnswer.disabled = busy;
    interviewNext.disabled = busy || !interviewAnswer.value.trim();
    interviewFinish.disabled = busy;
    useRecommendation.disabled = busy;
    reviewMessage.disabled = busy;
    const reviewBlocked = unknownFlowId !== null && unknownFlowId === flowId && flowMessage === submissionKey(reviewMessage.value, interviewOriginalMessage);
    confirmSend.disabled = busy || !reviewMessage.value.trim() || reviewMessage.value.length > MAX_MESSAGE_LENGTH || reviewBlocked;
    reviewEdit.disabled = busy;
  };
  const resetInterview = () => {
    interviewOriginalMessage = '';
    interviewHistory = [];
    interviewFlowId = null;
    currentInterviewQuestion = '';
    diagnosticContext = null;
    interviewPanel.hidden = true;
    reviewPanel.hidden = true;
    interviewAnswer.value = '';
    reviewMessage.value = '';
  };
  const startFlowForEditedMessage = () => {
    const key = submissionKey(message.value);
    if (unknownFlowId && flowMessage !== key) {
      unknownFlowId = null;
      container.querySelector<HTMLAnchorElement>('#contact-issues-link')!.hidden = true;
    }
    if (flowId && flowMessage !== key) {
      flowId = null;
      flowMessage = key;
    }
    resetInterview();
    result.hidden = true;
    loginPathButton.hidden = true;
    update();
  };
  const setBusy = (value: boolean) => { busy = value; update(); };
  const bearerHeaders = async () => ({ authorization: `Bearer ${await getAiAccessToken()}` });
  const errorMessage = (code: string, transcribing: boolean) => {
    if (code === 'bot_check_cancelled' || code === 'bot_check_failed') return '確認ができなかったため、送れませんでした。文章と録音はこの画面内に残っています。もう一度お試しください。';
    if (code === 'guest_limit_reached') return 'この接続からの登録なしの利用が多いため、今日は送れません。文章と録音はこの画面内に残っています。設定からログインすると送れます。';
    if (code === 'account_session_required' || code === 'unauthorized' || code === 'guest_unavailable') return '送信にはログインが必要です。設定からログインしてください。';
    if (code === 'invalid_flow' || code === 'invalid_request') return '送信内容を確認できませんでした。文章を編集して再度お試しください。';
    if (code === 'issue_submission_unknown') return '登録結果を確認できませんでした。重複を避けるため再登録を止めています。GitHubの課題一覧をご確認ください。';
    if (code === 'issue_submission_failed') return 'お問い合わせを登録できませんでした。文章はこの画面内に残っています。時間をおいて再度お試しください。';
    if (code === 'invalid_provider_response') return transcribing ? '音声を文字にできませんでした。録音はこの画面内に残っています。再試行するか、破棄して録り直してください。' : '回答を確認できませんでした。文章はこの画面内に残っています。時間をおいて再度お試しください。';
    if (code === 'offline' || !navigator.onLine) return 'オフラインです。文章と録音はこの画面内に残っています。接続後に再度お試しください。';
    // Contact AI is not counted against a plan; this is the daily cap on submissions from one connection.
    if (code === 'ai_quota_exceeded') return '今日はこの接続からの送信が多いため、これ以上送れません。文章と録音はこの画面内に残っています。明日もう一度お試しください。';
    if (code === 'rate_limited') return '短時間に利用が続いています。文章はこの画面内に残っています。少し待ってから再度お試しください。';
    if (code === 'ai_temporarily_paused' || code === 'provider_timeout' || code === 'provider_unavailable' || code === 'temporarily_unavailable') return transcribing ? '音声を文字にできませんでした。録音はこの画面内に残っています。時間をおいて再度お試しください。' : '現在送信できません。文章はこの画面内に残っています。時間をおいて再度お試しください。';
    if (code === 'not_configured') return 'お問い合わせを現在利用できません。文章はこの画面内に下書きとして残っています。';
    return transcribing ? '音声を文字にできませんでした。録音はこの画面内に残っています。接続を確認して再度お試しください。' : '送信できませんでした。文章はこの画面内に残っています。接続を確認して再度お試しください。';
  };
  const requestJson = async <T>(path: string, body: unknown, signal: AbortSignal): Promise<T> => {
    const headers = await bearerHeaders();
    const response = await fetch(path, {
      method: 'POST', credentials: 'same-origin', signal,
      headers: { ...headers, 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify(body),
    });
    const payload = await response.json() as T | { error?: string };
    if (!response.ok) throw new Error(typeof payload === 'object' && payload && 'error' in payload && typeof payload.error === 'string' ? payload.error : `http_${response.status}`);
    return payload as T;
  };

  const beginRecording = async () => {
    if (busy || audioBlob || requestingPermission) return;
    if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === 'undefined') {
      audioStatus.textContent = 'このブラウザーでは音声を録音できません。文章を入力してください。';
      return;
    }
    const generation = ++permissionGeneration;
    requestingPermission = true;
    update();
    audioStatus.textContent = 'マイクの使用を確認しています…';
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      if (!active || generation !== permissionGeneration) {
        stream.getTracks().forEach(track => track.stop());
        return;
      }
      requestingPermission = false;
      mediaStream = stream;
      const candidates = /Safari/.test(navigator.userAgent) && !/Chrome|Chromium|CriOS/.test(navigator.userAgent)
        ? ['audio/mp4', 'audio/webm']
        : ['audio/webm', 'audio/mp4'];
      const mimeType = candidates.find(type => MediaRecorder.isTypeSupported(type));
      if (!mimeType) {
        cleanRecordingResources(false);
        audioStatus.textContent = 'このブラウザーでは対応する音声形式で録音できません。文章を入力してください。';
        update();
        return;
      }
      const activeRecorder = new MediaRecorder(stream, { mimeType });
      recorder = activeRecorder;
      chunks = [];
      recordingBytes = 0;
      recordingTooLarge = false;
      audioFlowId = uuid();
      activeRecorder.ondataavailable = event => {
        if (!event.data.size || recordingTooLarge) return;
        if (recordingBytes + event.data.size > MAX_AUDIO_BYTES) {
          recordingTooLarge = true;
          chunks = [];
          stoppingRecording = true;
          update();
          activeRecorder.stop();
          return;
        }
        chunks.push(event.data);
        recordingBytes += event.data.size;
      };
      activeRecorder.onerror = () => {
        stoppingRecording = false;
        cleanRecordingResources(true);
        chunks = [];
        audioStatus.textContent = '録音を完了できませんでした。入力した文章はこの画面内に残っています。';
        update();
      };
      activeRecorder.onstop = () => {
        stoppingRecording = false;
        const type = activeRecorder.mimeType.split(';', 1)[0].trim().toLowerCase();
        const blob = new Blob(chunks, { type });
        chunks = [];
        recordingBytes = 0;
        if (recordingTooLarge || blob.size > MAX_AUDIO_BYTES) {
          audioBlob = null;
          audioStatus.textContent = '録音が2 MiBを超えました。短く録音し直してください。入力した文章はこの画面内に残っています。';
        } else if (blob.size === 0) {
          audioBlob = null;
          audioStatus.textContent = '録音データがありません。もう一度お試しください。入力した文章はこの画面内に残っています。';
        } else {
          audioBlob = blob;
          audioStatus.textContent = '録音を終了しました。音声を文字にしています…';
        }
        recordButton.textContent = '音声を録音';
        cleanRecordingResources(false);
        update();
        if (audioBlob) {
          recordDiagnosticAction('contact_recording_finished', 'contact');
          void transcribe();
        }
      };
      activeRecorder.start(1000);
      startedAt = Date.now();
      recordDiagnosticAction('contact_recording_started', 'contact');
      audioStatus.textContent = '録音中です。最大60秒で自動停止します。';
      timer = window.setInterval(() => {
        const seconds = Math.min(MAX_RECORDING_MS / 1000, Math.floor((Date.now() - startedAt) / 1000));
        recordingTime.textContent = `${seconds} / 60秒`;
        if (seconds * 1000 >= MAX_RECORDING_MS && recorder?.state === 'recording') {
          stoppingRecording = true;
          update();
          recorder.stop();
        }
      }, 250);
      recordButton.textContent = '録音を終了';
      recordButton.disabled = false;
      update();
    } catch {
      if (generation !== permissionGeneration || !active) return;
      requestingPermission = false;
      cleanRecordingResources(true);
      audioStatus.textContent = 'マイクを使えませんでした。許可を確認するか、文章を入力してください。';
      update();
    }
  };

  const transcribe = async () => {
    if (!audioBlob || busy) return;
    const blob = audioBlob;
    const contentType = (blob.type || '').split(';', 1)[0].trim().toLowerCase();
    const activeFlow = audioFlowId ?? (audioFlowId = uuid());
    setBusy(true);
    audioStatus.textContent = '音声を文字にしています…';
    requestController = new AbortController();
    try {
      const audioBase64 = await blobToBase64(blob);
      const response = await requestJson<{ text: string }>('/api/contact/transcribe', { flowId: activeFlow, audioBase64, contentType }, requestController.signal);
      if (typeof response.text !== 'string' || !response.text.trim()) throw new Error('invalid_provider_response');
      const next = [message.value.trim(), response.text.trim()].filter(Boolean).join('\n');
      if (next.length > MAX_MESSAGE_LENGTH) {
        audioStatus.textContent = '文字起こし結果を加えると4,000文字を超えます。文章を短くしてから再度お試しください。録音はこの画面内に残っています。';
      } else {
        message.value = next;
        audioBlob = null;
        audioFlowId = null;
        audioStatus.textContent = '音声を文字にしました。送信前に内容を確認してください。';
        startFlowForEditedMessage();
      }
    } catch (error) {
      if (!(error instanceof DOMException && error.name === 'AbortError')) {
        audioStatus.textContent = errorMessage(error instanceof Error ? error.message : '', true);
        if (audioStatus.textContent.includes('ログインが必要')) loginPathButton.hidden = false;
      }
    } finally {
      requestController = null;
      setBusy(false);
    }
  };

  const submit = async (submittedMessage = message.value, originalMessage?: string) => {
    if (busy || !submittedMessage.trim() || submittedMessage.length > MAX_MESSAGE_LENGTH) return;
    if (diagnosticsOptIn.checked && !diagnosticContext) diagnosticContext = getSanitizedDiagnosticContext();
    const key = submissionKey(submittedMessage, originalMessage);
    if (!flowId || flowMessage !== key) {
      flowId = uuid();
      flowMessage = key;
    }
    recordDiagnosticAction('contact_submit_started', 'contact');
    setBusy(true);
    status.textContent = 'お問い合わせを送信しています…';
    requestController = new AbortController();
    try {
      const response = await requestJson<ContactResult>('/api/contact', {
        flowId, message: submittedMessage,
        ...(originalMessage ? { originalMessage } : {}),
        ...(diagnosticsOptIn.checked && diagnosticContext ? { diagnostic: diagnosticContext } : {}),
      }, requestController.signal);
      if (!['bug', 'improvement', 'question'].includes(response.kind) || typeof response.reply !== 'string' || !(response.issueUrl === null || typeof response.issueUrl === 'string')) throw new Error('invalid_provider_response');
      const heading = container.querySelector<HTMLElement>('#contact-result-title')!;
      const reply = container.querySelector<HTMLElement>('#contact-result-reply')!;
      const submittedContent = container.querySelector<HTMLElement>('#contact-result-message')!;
      const link = container.querySelector<HTMLAnchorElement>('#contact-issue-link')!;
      heading.textContent = response.kind === 'bug' ? '不具合のご連絡' : response.kind === 'improvement' ? '改善のご要望' : 'お問い合わせ';
      reply.textContent = response.reply;
      submittedContent.textContent = submittedMessage;
      if (response.issueUrl && (response.kind === 'bug' || response.kind === 'improvement')) {
        const url = new URL(response.issueUrl);
        if (url.protocol === 'https:' && url.hostname === 'github.com') {
          link.href = url.toString();
          link.hidden = false;
        } else link.hidden = true;
      } else link.hidden = true;
      result.hidden = false;
      if (originalMessage) resetInterview();
      status.textContent = '送信しました。送信した文章はこの画面内に残しています。';
    } catch (error) {
      if (!(error instanceof DOMException && error.name === 'AbortError')) {
        const code = error instanceof Error ? error.message : '';
        recordDiagnosticFailure(Object.assign(new Error('contact_submit_failed'), { code }), 'contact');
        status.textContent = errorMessage(code, false);
        if (code === 'issue_submission_unknown') {
          unknownFlowId = flowId;
          container.querySelector<HTMLAnchorElement>('#contact-issues-link')!.hidden = false;
        }
        if (status.textContent.includes('ログインが必要')) loginPathButton.hidden = false;
      }
    } finally {
      requestController = null;
      setBusy(false);
    }
  };

  const runInterview = async (finish: boolean) => {
    if (busy) return;
    if (!interviewOriginalMessage) interviewOriginalMessage = message.value.trim();
    if (diagnosticsOptIn.checked && !diagnosticContext) diagnosticContext = getSanitizedDiagnosticContext();
    if (!interviewOriginalMessage) return;
    const activeFlow = interviewFlowId ?? (interviewFlowId = uuid());
    recordDiagnosticAction('contact_interview_started', 'contact');
    setBusy(true);
    status.textContent = finish ? 'ここまでの内容を整理しています…' : '確認したいことを考えています…';
    requestController = new AbortController();
    try {
      const response = await requestJson<ContactInterviewResult>('/api/contact/interview', {
        flowId: activeFlow, message: interviewOriginalMessage, history: interviewHistory, finish,
        ...(diagnosticsOptIn.checked && diagnosticContext ? { diagnostic: diagnosticContext } : {}),
      }, requestController.signal);
      if (!['ask', 'ready'].includes(response.status) || !['bug', 'improvement', 'question'].includes(response.kind) ||
          typeof response.question !== 'string' || typeof response.recommendation !== 'string' || typeof response.summary !== 'string') throw new Error('invalid_provider_response');
      interviewFlowId = null;
      if (response.status === 'ask') {
        currentInterviewQuestion = response.question;
        interviewQuestion.textContent = response.question;
        interviewRecommendation.textContent = response.recommendation;
        interviewAnswer.value = '';
        reviewPanel.hidden = true;
        interviewPanel.hidden = false;
        status.textContent = 'わかる範囲で1つだけ答えてください。';
        interviewPanel.scrollIntoView({ block: 'start' });
      } else {
        currentInterviewQuestion = '';
        interviewPanel.hidden = true;
        reviewMessage.value = response.summary;
        reviewPanel.hidden = false;
        status.textContent = '送信内容を確認してください。違うところは編集できます。';
        reviewPanel.scrollIntoView({ block: 'start' });
      }
    } catch (error) {
      if (!(error instanceof DOMException && error.name === 'AbortError')) {
        const code = error instanceof Error ? error.message : '';
        recordDiagnosticFailure(Object.assign(new Error('contact_interview_failed'), { code }), 'contact');
        status.textContent = errorMessage(code, false);
        if (status.textContent.includes('ログインが必要')) loginPathButton.hidden = false;
      }
    } finally {
      requestController = null;
      setBusy(false);
    }
  };

  const answerInterview = (finish: boolean) => {
    const answer = interviewAnswer.value.trim();
    if (currentInterviewQuestion && answer) {
      interviewHistory.push({ question: currentInterviewQuestion, answer });
      currentInterviewQuestion = '';
      interviewFlowId = null;
    }
    void runInterview(finish);
  };

  const back = () => {
    close();
    options.onBackToSettings();
  };
  container.querySelector<HTMLButtonElement>('.contact-back')!.addEventListener('click', back);
  recordButton.addEventListener('click', () => {
    if (recorder?.state === 'recording') {
      stoppingRecording = true;
      update();
      recordButton.textContent = '録音を終了';
      recorder.stop();
    } else void beginRecording();
  });
  discardAudioButton.addEventListener('click', () => {
    audioBlob = null;
    audioFlowId = null;
    audioStatus.textContent = '録音を破棄しました。必要であれば録り直せます。';
    update();
  });
  retryTranscriptionButton.addEventListener('click', () => { void transcribe(); });
  sendButton.addEventListener('click', () => {
    if (interviewOptIn.checked) void runInterview(false);
    else void submit();
  });
  interviewOptIn.addEventListener('change', () => { resetInterview(); update(); });
  diagnosticsOptIn.addEventListener('change', () => { diagnosticContext = null; update(); });
  useRecommendation.addEventListener('click', () => { interviewAnswer.value = interviewRecommendation.textContent ?? ''; update(); interviewAnswer.focus(); });
  interviewAnswer.addEventListener('input', update);
  interviewNext.addEventListener('click', () => answerInterview(false));
  interviewFinish.addEventListener('click', () => answerInterview(true));
  reviewMessage.addEventListener('input', () => {
    if (flowId && flowMessage !== submissionKey(reviewMessage.value, interviewOriginalMessage)) flowId = null;
    update();
  });
  confirmSend.addEventListener('click', () => { void submit(reviewMessage.value, interviewOriginalMessage); });
  reviewEdit.addEventListener('click', () => { resetInterview(); message.disabled = false; message.focus(); update(); });
  message.addEventListener('input', startFlowForEditedMessage);
  loginPathButton.addEventListener('click', () => {
    close();
    options.onBackToSettings(true);
  });
  container.querySelector<HTMLButtonElement>('#contact-edit-result')!.addEventListener('click', () => {
    result.hidden = true;
    message.focus();
  });

  function open() {
    active = true;
    container.hidden = false;
    message.focus();
  }
  function close() {
    active = false;
    permissionGeneration++;
    requestingPermission = false;
    stoppingRecording = false;
    requestController?.abort();
    requestController = null;
    cleanRecordingResources(true);
    recordButton.textContent = '音声を録音';
    update();
    container.hidden = true;
  }
  window.addEventListener('pagehide', () => {
    if (!active) return;
    permissionGeneration++;
    requestController?.abort();
    requestController = null;
    requestingPermission = false;
    stoppingRecording = false;
    cleanRecordingResources(true);
    recordButton.textContent = '音声を録音';
    audioStatus.textContent = 'ページを閉じるため録音を終了しました。録音データはこの画面内に保存していません。';
    update();
  });
  function isOpen() { return active; }

  update();
  return { open, close, isOpen };
}

async function blobToBase64(blob: Blob): Promise<string> {
  const dataUrl = await new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error('audio_read_failed'));
    reader.onload = () => typeof reader.result === 'string' ? resolve(reader.result) : reject(new Error('audio_read_failed'));
    reader.readAsDataURL(blob);
  });
  return dataUrl.slice(dataUrl.indexOf(',') + 1);
}
