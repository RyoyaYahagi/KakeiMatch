type ProviderCosts = {
  requests: number;
  inputTokens: number;
  outputTokens: number;
  costUsdMicros: number;
  unknownRequests: number;
};

type CostsResponse = {
  month: string;
  currency: 'USD';
  totalUsdMicros: number;
  unknownRequests: number;
  providers: { gemini: ProviderCosts; jev: ProviderCosts };
};

type DeveloperCostsElements = {
  toggle: HTMLInputElement;
  section: HTMLElement;
  status: HTMLElement;
  month: HTMLElement;
  total: HTMLElement;
  unknown: HTMLElement;
  providers: HTMLUListElement;
  previous: HTMLButtonElement;
  next: HTMLButtonElement;
};

const DEVELOPER_OPTIONS_KEY = 'kakeimatch:developer-options';

function currentTokyoMonth(date = new Date()) {
  const parts = new Intl.DateTimeFormat('en', {
    timeZone: 'Asia/Tokyo', year: 'numeric', month: '2-digit',
  }).formatToParts(date);
  const year = parts.find(part => part.type === 'year')?.value;
  const month = parts.find(part => part.type === 'month')?.value;
  if (!year || !month) throw new Error('Could not determine current month in Asia/Tokyo');
  return `${year}-${month}`;
}

function shiftMonth(month: string, amount: number) {
  const [year, index] = month.split('-').map(Number);
  return currentTokyoMonth(new Date(Date.UTC(year, index - 1 + amount, 1, 12)));
}

function isNonnegativeSafeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

function isProviderCosts(value: unknown): value is ProviderCosts {
  if (!value || typeof value !== 'object') return false;
  const data = value as Record<string, unknown>;
  return isNonnegativeSafeInteger(data.requests)
    && isNonnegativeSafeInteger(data.inputTokens)
    && isNonnegativeSafeInteger(data.outputTokens)
    && isNonnegativeSafeInteger(data.costUsdMicros)
    && isNonnegativeSafeInteger(data.unknownRequests);
}

function isCostsResponse(value: unknown, expectedMonth: string): value is CostsResponse {
  if (!value || typeof value !== 'object') return false;
  const result = value as Record<string, unknown>;
  if (result.month !== expectedMonth || result.currency !== 'USD'
    || !isNonnegativeSafeInteger(result.totalUsdMicros)
    || !isNonnegativeSafeInteger(result.unknownRequests)
    || !result.providers || typeof result.providers !== 'object') return false;
  const providers = result.providers as Record<string, unknown>;
  return isProviderCosts(providers.gemini) && isProviderCosts(providers.jev);
}

function formatUsd(micros: number) {
  const [whole, fraction = ''] = (micros / 1_000_000).toFixed(6).split('.');
  return `US$${whole}.${fraction.replace(/0+$/, '').padEnd(2, '0')}`;
}

function monthLabel(month: string) {
  return `${month.slice(0, 4)}年${Number(month.slice(5, 7))}月`;
}

export function initializeDeveloperCostsUi(elements: DeveloperCostsElements) {
  let selectedMonth = currentTokyoMonth();
  let signedIn = false;
  let requestId = 0;
  try {
    elements.toggle.checked = localStorage.getItem(DEVELOPER_OPTIONS_KEY) === 'true';
  } catch {
    elements.toggle.checked = false;
    elements.status.textContent = '端末設定を読み取れません。この画面を開いている間は初期設定で動作します。';
  }

  function updateVisibility() {
    const visible = signedIn && elements.toggle.checked;
    elements.section.hidden = !visible;
    if (visible) void loadCosts();
  }

  function render(result: CostsResponse) {
    elements.month.textContent = monthLabel(result.month);
    elements.total.textContent = `合計 ${formatUsd(result.totalUsdMicros)}`;
    elements.unknown.hidden = result.unknownRequests === 0;
    elements.unknown.textContent = result.unknownRequests > 0
      ? `料金を確定できない要求が${result.unknownRequests}件あります。合計には計測できた料金だけを含みます。`
      : '';
    elements.providers.replaceChildren();
    for (const [provider, label] of [['gemini', 'Gemini'], ['jev', 'Jev']] as const) {
      const data = result.providers[provider];
      const row = document.createElement('li');
      row.className = 'developer-cost-row';
      const heading = document.createElement('strong');
      heading.textContent = label;
      const detail = document.createElement('span');
      detail.textContent = `${data.requests}件 · 入力 ${data.inputTokens.toLocaleString('ja-JP')} / 出力 ${data.outputTokens.toLocaleString('ja-JP')} トークン · ${formatUsd(data.costUsdMicros)}`;
      row.append(heading, detail);
      if (data.unknownRequests > 0) {
        const unknown = document.createElement('span');
        unknown.className = 'muted';
        unknown.textContent = `料金未確定 ${data.unknownRequests}件`;
        row.append(unknown);
      }
      elements.providers.append(row);
    }
  }

  async function loadCosts() {
    const thisRequest = ++requestId;
    elements.month.textContent = monthLabel(selectedMonth);
    elements.total.textContent = '利用料金を読み込んでいます…';
    elements.unknown.hidden = true;
    elements.unknown.textContent = '';
    elements.providers.replaceChildren();
    try {
      const response = await fetch(`/api/ai/costs?month=${encodeURIComponent(selectedMonth)}`, { credentials: 'same-origin' });
      if (!response.ok) throw new Error(`API request failed (${response.status})`);
      const result: unknown = await response.json();
      if (thisRequest !== requestId || elements.section.hidden) return;
      if (!isCostsResponse(result, selectedMonth)) throw new Error('invalid_costs_response');
      render(result);
    } catch (error) {
      if (thisRequest !== requestId || elements.section.hidden) return;
      elements.total.textContent = error instanceof Error && error.message.includes('(401)')
        ? 'ログイン状態を確認できません。AIアカウントへ再度ログインしてください。'
        : '利用料金を取得できません。オンラインで再度お試しください。';
      elements.providers.replaceChildren();
    }
  }

  elements.toggle.addEventListener('change', () => {
    try {
      localStorage.setItem(DEVELOPER_OPTIONS_KEY, String(elements.toggle.checked));
      elements.status.textContent = '';
    } catch {
      elements.status.textContent = '設定を保存できませんでした。この画面を開いている間だけ有効です。';
    }
    updateVisibility();
  });
  elements.previous.addEventListener('click', () => { selectedMonth = shiftMonth(selectedMonth, -1); void loadCosts(); });
  elements.next.addEventListener('click', () => { selectedMonth = shiftMonth(selectedMonth, 1); void loadCosts(); });

  return {
    setSignedIn(value: boolean) {
      signedIn = value;
      updateVisibility();
    },
  };
}
