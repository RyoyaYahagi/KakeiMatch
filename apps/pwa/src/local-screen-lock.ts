import {
  isBiometricUnlockAvailable,
  parseLocalScreenLockBiometric,
  registerBiometricUnlock,
  verifyBiometricUnlock,
  type LocalScreenLockBiometric,
} from './local-screen-lock-biometric';

const CONFIG_KEY = 'kakeimatch.screen-lock.v1';
const ATTEMPT_KEY = `${CONFIG_KEY}.attempts`;
const CHANNEL_NAME = 'kakeimatch.screen-lock';
const BACKGROUND_LOCK_MS = 60_000;
const ITERATIONS = 120_000;
const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

export type LocalScreenLockConfig = {
  version: 1;
  pinSalt: string;
  pinHash: string;
  recoverySalt: string;
  recoveryHash: string;
  biometric?: LocalScreenLockBiometric;
};

function toBase64(value: Uint8Array): string {
  let binary = '';
  for (const byte of value) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function fromBase64(value: string): Uint8Array {
  const binary = atob(value);
  return Uint8Array.from(binary, character => character.charCodeAt(0));
}

async function hashSecret(secret: string, salt: Uint8Array): Promise<string> {
  const material = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), 'PBKDF2', false, ['deriveBits']);
  const saltBuffer = new ArrayBuffer(salt.length);
  new Uint8Array(saltBuffer).set(salt);
  const bits = await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt: saltBuffer, iterations: ITERATIONS }, material, 256);
  return toBase64(new Uint8Array(bits));
}

function equalHash(left: string, right: string): boolean {
  if (left.length !== right.length) return false;
  let difference = 0;
  for (let index = 0; index < left.length; index++) difference |= left.charCodeAt(index) ^ right.charCodeAt(index);
  return difference === 0;
}

export function readLocalScreenLock(): LocalScreenLockConfig | null {
  const serialized = localStorage.getItem(CONFIG_KEY);
  if (!serialized) return null;
  try {
    const value: unknown = JSON.parse(serialized);
    if (typeof value !== 'object' || value === null) return null;
    const row = value as Partial<LocalScreenLockConfig>;
    if (row.version !== 1 || typeof row.pinSalt !== 'string' || typeof row.pinHash !== 'string'
      || typeof row.recoverySalt !== 'string' || typeof row.recoveryHash !== 'string') return null;
    // A malformed biometric entry is dropped; the PIN still guards the screen.
    const biometric = parseLocalScreenLockBiometric(row.biometric);
    return {
      version: 1,
      pinSalt: row.pinSalt,
      pinHash: row.pinHash,
      recoverySalt: row.recoverySalt,
      recoveryHash: row.recoveryHash,
      ...(biometric ? { biometric } : {}),
    };
  } catch {
    return null;
  }
}

export async function createLocalScreenLock(pin: string, recoveryCode: string): Promise<LocalScreenLockConfig> {
  if (!/^\d{6}$/.test(pin)) throw new Error('PINは数字6桁で入力してください。');
  const pinSalt = crypto.getRandomValues(new Uint8Array(16));
  const recoverySalt = crypto.getRandomValues(new Uint8Array(16));
  return {
    version: 1,
    pinSalt: toBase64(pinSalt),
    pinHash: await hashSecret(pin, pinSalt),
    recoverySalt: toBase64(recoverySalt),
    recoveryHash: await hashSecret(recoveryCode.replaceAll('-', '').toUpperCase(), recoverySalt),
  };
}

export async function verifyLocalScreenLockPin(config: LocalScreenLockConfig, pin: string): Promise<boolean> {
  return equalHash(config.pinHash, await hashSecret(pin, fromBase64(config.pinSalt)));
}

export async function verifyLocalScreenLockRecovery(config: LocalScreenLockConfig, recoveryCode: string): Promise<boolean> {
  return equalHash(config.recoveryHash, await hashSecret(recoveryCode.replaceAll('-', '').toUpperCase(), fromBase64(config.recoverySalt)));
}

function recoveryCode(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(20));
  const code = [...bytes].map(value => alphabet[value & 31]).join('');
  return `${code.slice(0, 5)}-${code.slice(5, 10)}-${code.slice(10, 15)}-${code.slice(15)}`;
}

function text(tag: string, value: string, className = ''): HTMLElement {
  const node = document.createElement(tag);
  node.textContent = value;
  node.className = className;
  return node;
}

function field(labelText: string, id: string, autocomplete: HTMLInputElement['autocomplete']): HTMLInputElement {
  const label = document.createElement('label');
  label.htmlFor = id;
  label.textContent = labelText;
  const input = document.createElement('input');
  input.id = id;
  input.type = 'password';
  input.inputMode = 'numeric';
  input.autocomplete = autocomplete;
  input.pattern = '[0-9]*';
  input.maxLength = 64;
  input.required = true;
  label.append(input);
  return input;
}

function action(label: string, handler: () => void | Promise<void>, secondary = false): HTMLButtonElement {
  const button = document.createElement('button');
  button.type = 'button';
  button.textContent = label;
  button.className = secondary ? 'secondary' : 'primary';
  button.addEventListener('click', () => { void handler(); });
  return button;
}

export function initializeLocalScreenLock(application: HTMLElement, settingsContent: HTMLElement): void {
  let config = readLocalScreenLock();
  let locked = config !== null;
  let backgroundedAt: number | null = null;
  let biometricAvailable = false;
  const attemptState = (() => {
    try {
      const value = JSON.parse(localStorage.getItem(ATTEMPT_KEY) ?? '{}') as { failedAttempts?: unknown; cooldownUntil?: unknown };
      return {
        failedAttempts: typeof value.failedAttempts === 'number' && value.failedAttempts >= 0 ? value.failedAttempts : 0,
        cooldownUntil: typeof value.cooldownUntil === 'number' ? value.cooldownUntil : 0,
      };
    } catch { return { failedAttempts: 0, cooldownUntil: 0 }; }
  })();
  const channel = typeof BroadcastChannel === 'undefined' ? null : new BroadcastChannel(CHANNEL_NAME);
  const overlay = document.createElement('section');
  overlay.id = 'screen-lock-overlay';
  overlay.className = 'screen-lock-overlay';
  overlay.hidden = true;
  overlay.setAttribute('aria-labelledby', 'screen-lock-title');
  document.body.append(overlay);

  function closeOpenDialogs() {
    document.querySelectorAll<HTMLDialogElement>('dialog[open]').forEach(dialog => dialog.close());
  }
  // Async UI work can finish after relocking. Remove its modal from the top layer before paint.
  new MutationObserver(() => { if (locked) closeOpenDialogs(); })
    .observe(document.body, { subtree: true, childList: true, attributes: true, attributeFilter: ['open'] });

  function renderLock(message = '') {
    overlay.replaceChildren();
    const content = document.createElement('div');
    content.className = 'screen-lock-content';
    content.append(text('h1', '画面をロックしています', 'page-title'));
    content.querySelector('h1')!.id = 'screen-lock-title';
    const biometric = config?.biometric;
    content.append(text('p', biometric
      ? '続けるには、生体認証かこの端末で設定したPINで解除してください。'
      : '続けるには、この端末で設定したPINを入力してください。', 'muted'));
    if (biometric) {
      const biometricStatus = text('p', '', 'screen-lock-status');
      biometricStatus.setAttribute('role', 'status');
      const biometricButton = action('生体認証で解除', async () => {
        biometricButton.disabled = true;
        try {
          if (await verifyBiometricUnlock(biometric)) { setLocked(false, true); return; }
          biometricStatus.textContent = '生体認証を確認できませんでした。PINで解除できます。';
        } catch {
          biometricStatus.textContent = '生体認証を完了できませんでした。もう一度試すか、PINで解除してください。';
        } finally {
          biometricButton.disabled = false;
        }
      });
      biometricButton.classList.add('screen-lock-biometric');
      content.append(biometricButton, biometricStatus);
    }
    const form = document.createElement('form');
    form.className = 'screen-lock-form';
    const pin = field('6桁のPIN', 'screen-lock-pin', 'current-password');
    pin.maxLength = 6;
    pin.required = true;
    pin.autofocus = !config?.biometric;
    const status = text('p', message, 'screen-lock-status');
    status.setAttribute('role', 'status');
    form.append(pin.parentElement!, action('ロックを解除', async () => {
      if (!config) return;
      if (Date.now() < attemptState.cooldownUntil) { status.textContent = 'しばらく待ってから、もう一度お試しください。'; return; }
      if (await verifyLocalScreenLockPin(config, pin.value)) {
        attemptState.failedAttempts = 0;
        attemptState.cooldownUntil = 0;
        localStorage.removeItem(ATTEMPT_KEY);
        setLocked(false, true);
        return;
      }
      attemptState.failedAttempts++;
      if (attemptState.failedAttempts >= 5) { attemptState.cooldownUntil = Date.now() + 30_000; attemptState.failedAttempts = 0; }
      localStorage.setItem(ATTEMPT_KEY, JSON.stringify(attemptState));
      pin.value = '';
      status.textContent = Date.now() < attemptState.cooldownUntil ? 'PINが違います。30秒後にお試しください。' : 'PINが違います。もう一度入力してください。';
    }, Boolean(biometric)));
    form.addEventListener('submit', event => { event.preventDefault(); form.querySelector('button')?.click(); });
    content.append(form);
    if (message) status.textContent = message;
    content.append(status);
    content.append(text('p', '解除できない場合は復旧コードを使えます。復旧すると画面ロックは無効になります。家計データは削除されません。', 'muted'));
    const recoveryDetails = document.createElement('details');
    recoveryDetails.className = 'screen-lock-recovery';
    recoveryDetails.append(text('summary', '復旧コードを使う'));
    const recoveryForm = document.createElement('form');
    recoveryForm.className = 'screen-lock-form';
    const recovery = field('復旧コード', 'screen-lock-recovery-code', 'one-time-code');
    recovery.inputMode = 'text';
    recovery.autocomplete = 'off';
    recovery.pattern = '[A-Za-z2-7-]+';
    const recoveryStatus = text('p', '', 'screen-lock-status');
    recoveryStatus.setAttribute('role', 'status');
    recoveryForm.append(recovery.parentElement!, action('ロックを解除して無効にする', async () => {
      if (!config) return;
      if (await verifyLocalScreenLockRecovery(config, recovery.value)) {
        localStorage.removeItem(CONFIG_KEY);
        localStorage.removeItem(ATTEMPT_KEY);
        config = null;
        buildSettings();
        announce('configuration');
        setLocked(false, false);
      } else {
        recovery.value = '';
        recoveryStatus.textContent = '復旧コードが違います。';
      }
    }, true));
    recoveryForm.addEventListener('submit', event => { event.preventDefault(); recoveryForm.querySelector('button')?.click(); });
    recoveryForm.append(recoveryStatus);
    recoveryDetails.append(recoveryForm);
    content.append(recoveryDetails);
    overlay.append(content);
    // With biometric unlock the primary action is a tap; do not raise the keyboard first.
    if (!biometric) window.setTimeout(() => pin.focus(), 0);
  }

  function setLocked(value: boolean, broadcast = false) {
    locked = value;
    application.hidden = value;
    application.inert = value;
    overlay.hidden = !value;
    document.body.classList.toggle('screen-locked', value);
    if (value) { closeOpenDialogs(); renderLock(); }
    else overlay.replaceChildren();
    if (broadcast) announce(value ? 'lock' : 'unlock');
  }

  function announce(type: 'lock' | 'unlock' | 'configuration') {
    const event = { type, at: Date.now() };
    channel?.postMessage(event);
    localStorage.setItem(`${CONFIG_KEY}.event`, JSON.stringify(event));
  }

  function notifyLocked() { if (config) setLocked(true); }
  channel?.addEventListener('message', event => {
      if (event.data?.type === 'lock' || event.data?.type === 'configuration') {
      config = readLocalScreenLock();
      buildSettings();
      if (config) setLocked(true);
    } else if (event.data?.type === 'unlock') {
      // Each tab unlocks independently; another tab cannot grant access here.
    }
  });
  window.addEventListener('storage', event => {
    if (event.key === `${CONFIG_KEY}.event` && event.newValue) {
      const value = JSON.parse(event.newValue) as { type?: string };
      if (value.type === 'lock' || value.type === 'configuration') {
        config = readLocalScreenLock();
        buildSettings();
        if (config) setLocked(true);
      }
    }
    if (event.key === CONFIG_KEY) {
      config = readLocalScreenLock();
      buildSettings();
      if (config) setLocked(true);
      else setLocked(false);
    }
  });
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) backgroundedAt = Date.now();
    else if (backgroundedAt !== null) {
      if (Date.now() - backgroundedAt >= BACKGROUND_LOCK_MS) notifyLocked();
      backgroundedAt = null;
    }
  });
  window.addEventListener('pagehide', () => { backgroundedAt = Date.now(); });
  window.addEventListener('pageshow', event => {
    if (event.persisted && backgroundedAt !== null) {
      if (Date.now() - backgroundedAt >= BACKGROUND_LOCK_MS) notifyLocked();
      backgroundedAt = null;
    }
  });
  for (const eventName of ['click', 'submit', 'input', 'change', 'keydown'] as const) {
    document.addEventListener(eventName, event => {
      if (!locked || overlay.contains(event.target as Node)) return;
      event.preventDefault();
      event.stopImmediatePropagation();
    }, true);
  }

  function enabledStatus(): string {
    return config?.biometric
      ? '有効です。生体認証またはPINで解除します。設定はこの端末だけに保存されています。'
      : '有効です。PINはこの端末だけに保存されています。';
  }

  function saveConfiguration(nextConfig: LocalScreenLockConfig) {
    localStorage.setItem(CONFIG_KEY, JSON.stringify(nextConfig));
    config = nextConfig;
    announce('configuration');
  }

  function settingsMessage(value: string) {
    const node = settingsContent.querySelector('.screen-lock-settings-message');
    if (node) node.textContent = value;
  }

  function buildSettings() {
    settingsContent.querySelector('.screen-lock-settings')?.remove();
    const section = document.createElement('section');
    section.className = 'surface-section screen-lock-settings';
    section.setAttribute('aria-labelledby', 'screen-lock-settings-title');
    section.append(text('h3', '端末内の画面ロック'));
    section.querySelector('h3')!.id = 'screen-lock-settings-title';
    section.append(text('p', '起動時と、1分以上アプリを離れた後に解除を求めます。オフラインで使えます。この機能は通常画面へのアクセスを防ぐもので、家計データの暗号化ではありません。', 'muted'));
    const status = text('p', config ? enabledStatus() : '無効です。設定や復旧で家計データは削除されません。', 'screen-lock-settings-status');
    status.setAttribute('role', 'status');
    section.append(status);
    const message = text('p', '', 'screen-lock-settings-message');
    message.setAttribute('role', 'status');

    function showEnrollment(mode: 'enable' | 'change') {
      const area = document.createElement('div');
      area.className = 'screen-lock-enrollment';
      const first = field('新しいPIN（数字6桁）', 'screen-lock-new-pin', 'new-password');
      first.minLength = 6;
      first.maxLength = 6;
      first.required = true;
      first.pattern = '[0-9]{6}';
      const second = field('新しいPIN（確認）', 'screen-lock-confirm-pin', 'new-password');
      second.minLength = 6;
      second.maxLength = 6;
      second.required = true;
      second.pattern = '[0-9]{6}';
      area.append(first.parentElement!, second.parentElement!);
      const recovery = recoveryCode();
      const disclosure = document.createElement('div');
      disclosure.className = 'screen-lock-recovery-display';
      disclosure.append(text('p', 'この復旧コードを紙など安全な場所に控えてください。画面を閉じると再表示できません。', 'muted'));
      const code = text('strong', recovery, 'screen-lock-code');
      code.setAttribute('aria-label', '復旧コード');
      disclosure.append(code);
      const acknowledged = document.createElement('label');
      acknowledged.className = 'screen-lock-acknowledge';
      const checkbox = document.createElement('input');
      checkbox.type = 'checkbox';
      acknowledged.append(checkbox, document.createTextNode('復旧コードを控えました'));
      const save = action(mode === 'enable' ? '画面ロックを有効にする' : 'PINを変更する', async () => {
        if (first.value !== second.value) { message.textContent = 'PINが一致しません。'; return; }
        if (!checkbox.checked) { message.textContent = '復旧コードを控えたことを確認してください。'; return; }
        try {
          const created = await createLocalScreenLock(first.value, recovery);
          // Changing the PIN keeps the biometric enrollment already confirmed on this device.
          const nextConfig = mode === 'change' && config?.biometric ? { ...created, biometric: config.biometric } : created;
          localStorage.setItem(CONFIG_KEY, JSON.stringify(nextConfig));
          localStorage.removeItem(ATTEMPT_KEY);
          attemptState.failedAttempts = 0;
          attemptState.cooldownUntil = 0;
          config = nextConfig;
          status.textContent = enabledStatus();
          message.textContent = mode === 'enable' ? '画面ロックを有効にしました。' : 'PINを変更しました。';
          enrollment.remove();
          buildSettings();
          announce('configuration');
          if (mode === 'enable') setLocked(true);
        } catch (error) {
          message.textContent = error instanceof Error ? error.message : '設定を保存できませんでした。';
        }
      });
      save.disabled = true;
      checkbox.addEventListener('change', () => { save.disabled = !checkbox.checked; });
      area.append(disclosure, acknowledged, save);
      const cancel = action('キャンセル', () => { area.remove(); message.textContent = ''; }, true);
      area.append(cancel);
      const enrollment = area;
      section.append(area);
    }

    if (config) {
      const currentPin = field('現在のPIN', 'screen-lock-current-pin', 'current-password');
      currentPin.maxLength = 6;
      currentPin.inputMode = 'numeric';
      const change = action('PINを変更する', async () => {
        if (!config || !await verifyLocalScreenLockPin(config, currentPin.value)) { message.textContent = '現在のPINが違います。'; currentPin.value = ''; return; }
        showEnrollment('change');
      }, true);
      const disable = action('画面ロックを無効にする', async () => {
        if (!config || !await verifyLocalScreenLockPin(config, currentPin.value)) { message.textContent = '現在のPINが違います。'; currentPin.value = ''; return; }
        localStorage.removeItem(CONFIG_KEY);
        localStorage.removeItem(ATTEMPT_KEY);
        config = null;
        status.textContent = '無効です。';
        message.textContent = '画面ロックを無効にしました。家計データは保持されています。';
        currentPin.value = '';
        buildSettings();
        announce('configuration');
      });
      const manual = action('今すぐロック', () => { setLocked(true, true); }, true);
      const enable = action('画面ロックを有効にする', () => showEnrollment('enable'));
      enable.hidden = true;
      section.append(currentPin.parentElement!);
      if (config.biometric) {
        section.append(action('生体認証をやめる', async () => {
          if (!config || !await verifyLocalScreenLockPin(config, currentPin.value)) { message.textContent = '現在のPINが違います。'; currentPin.value = ''; return; }
          const withoutBiometric: LocalScreenLockConfig = { ...config };
          delete withoutBiometric.biometric;
          saveConfiguration(withoutBiometric);
          buildSettings();
          settingsMessage('生体認証での解除をやめました。PINで解除できます。');
        }, true));
      } else if (biometricAvailable) {
        section.append(action('生体認証も使う', async () => {
          if (!config || !await verifyLocalScreenLockPin(config, currentPin.value)) { message.textContent = '現在のPINが違います。'; currentPin.value = ''; return; }
          try {
            const biometric = await registerBiometricUnlock();
            saveConfiguration({ ...config, biometric });
            buildSettings();
            settingsMessage('生体認証で解除できるようにしました。PINも引き続き使えます。');
          } catch (error) {
            // Cancellation and other platform errors arrive as DOMException; their text is not user-facing.
            message.textContent = error instanceof Error && !(error instanceof DOMException)
              ? error.message
              : '生体認証の登録を完了できませんでした。もう一度お試しください。';
          }
        }, true));
      } else {
        section.append(text('p', 'この端末やブラウザーでは、生体認証での解除を使えません。', 'muted'));
      }
      section.append(change, disable, manual, enable);
    } else {
      const enable = action('画面ロックを有効にする', () => showEnrollment('enable'));
      section.append(enable);
    }
    section.append(message);
    settingsContent.querySelector('#screen-lock-host')?.append(section);
    const rowValue = settingsContent.querySelector('#screen-lock-row-value');
    if (rowValue) rowValue.textContent = config ? 'オン' : 'オフ';
  }

  setLocked(locked);
  buildSettings();
  void isBiometricUnlockAvailable().then(available => {
    biometricAvailable = available;
    if (available) buildSettings();
  });
}
