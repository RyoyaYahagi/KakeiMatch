import { CATEGORY_IDS, CATEGORY_LABELS, isCategoryId, normalizeMerchant, type CategoryId } from "../../../src/lib/category";
import { ReceiptExtractionError, validateReceiptExtraction, type ReceiptExtractionResult } from "../../../src/lib/receipt-extraction";
import { LocalDataStorageError, type LocalDataRepository } from "../../../src/lib/local-data";
import { ReceiptValidationError, validateReceiptImage, type ReceiptContentType } from "../../../src/lib/receipt-validation";
import { getAiAccessToken } from "./ai-auth";
import { ActualMasterValidationError, type createActualBrowserLedger } from "../../../src/lib/actual-browser-ledger";

const RECEIPT_KIND = "receipt-metadata" as const;
const EXTRACTION_KIND = "receipt-extraction" as const;
const MAPPING_KIND = "merchant-mapping" as const;
const MAX_GATEWAY_IMAGE_BYTES = 6 * 1024 * 1024;
const MAX_ITEMS_FOR_JEV = 30;
const MAX_TEXT_FOR_JEV = 200;

export type ReceiptItem = { id: string; name: string; amountYen: number | null; quantity?: number | null; unitPriceYen?: number | null; categoryId: string | null };
export type ReceiptAdjustment = { id: string; label: string; amountYen: number; targetItemId?: string | null };

export type ConfirmedReceiptValue = {
  merchant: string;
  purchasedDate: string;
  purchasedTime: string | null;
  totalAmountYen: number;
  /** Actual category ID after the user chooses; AI suggestions use CategoryId keys. */
  categoryId: string;
  accountId: string;
  taxAmountYen?: number | null;
  items?: ReceiptItem[];
  adjustments?: ReceiptAdjustment[];
};

export type LocalReceipt = {
  id: string;
  createdAt: string;
  updatedAt: string;
  image: { blobId: string; contentType: ReceiptContentType; sizeBytes: number } | null;
  extraction: ReceiptExtractionResult | null;
  /** Usage flow for the latest successful extraction; older receipts may lack it. */
  aiFlowId?: string;
  itemCategories?: Array<string | null>;
  aiSuggestion: { categoryId: string | null; source: "merchant_mapping" | "jev" | "unclassified"; probabilities: Record<CategoryId, number> | null; model: string | null; attemptedAt: string | null; flowId?: string };
  confirmedValue: ConfirmedReceiptValue | null;
  registration: { status: "pending" | "processing" | "applied" | "failed"; actualTransactionId: string | null; lastError: string | null };
};

export class LocalReceiptServiceError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = "LocalReceiptServiceError";
  }
}

type Ledger = ReturnType<typeof createActualBrowserLedger>;
export type LocalReceiptServiceOptions = {
  fetchImpl?: typeof fetch;
  getToken?: typeof getAiAccessToken;
  now?: () => Date;
  makeId?: () => string;
  geminiUrl?: string;
  jevUrl?: string;
  /** Tests can provide a lock; production uses Web Locks when available. */
  withRegistrationLock?: <T>(id: string, operation: () => Promise<T>) => Promise<T>;
};

function nowIso(options: LocalReceiptServiceOptions): string { return (options.now ?? (() => new Date()))().toISOString(); }
function newId(options: LocalReceiptServiceOptions): string { return `receipt:${(options.makeId ?? crypto.randomUUID.bind(crypto))()}`; }
function isSafeYen(value: unknown): value is number { return typeof value === "number" && Number.isSafeInteger(value) && value >= 0; }
function validConfirmed(value: ConfirmedReceiptValue): boolean {
  const items = value.items ?? [], adjustments = value.adjustments ?? [];
  if (items.length > 100 || adjustments.length > 100 ||
      new Set([...items, ...adjustments].map(row => row.id)).size !== items.length + adjustments.length ||
      items.some(row => typeof row.id !== "string" || !row.id || typeof row.name !== "string" || !row.name.trim() ||
        (row.amountYen !== null && !isSafeYen(row.amountYen)) || (row.categoryId !== null && (typeof row.categoryId !== "string" || !row.categoryId)) ||
        (row.quantity != null && (!Number.isFinite(row.quantity) || row.quantity <= 0)) || (row.unitPriceYen != null && !isSafeYen(row.unitPriceYen))) ||
      adjustments.some(row => !row.id || typeof row.label !== "string" || !row.label.trim() || !Number.isSafeInteger(row.amountYen) ||
        (row.targetItemId != null && !items.some(item => item.id === row.targetItemId))) ||
      (value.taxAmountYen != null && !isSafeYen(value.taxAmountYen))) return false;
  const date = /^\d{4}-\d{2}-\d{2}$/.test(value.purchasedDate) ? new Date(`${value.purchasedDate}T00:00:00.000Z`) : null;
  return typeof value.merchant === "string" && value.merchant.trim().length > 0 &&
    date !== null && !Number.isNaN(date.valueOf()) && date.toISOString().slice(0, 10) === value.purchasedDate &&
    (value.purchasedTime === null || /^(?:[01]\d|2[0-3]):[0-5]\d$/.test(value.purchasedTime)) &&
    isSafeYen(value.totalAmountYen) && value.totalAmountYen > 0 && typeof value.categoryId === "string" && value.categoryId.length > 0 &&
    typeof value.accountId === "string" && value.accountId.length > 0;
}
function safeError(error: unknown): LocalReceiptServiceError {
  if (error instanceof LocalReceiptServiceError) return error;
  if (error instanceof ReceiptValidationError) return new LocalReceiptServiceError("invalid_image", error.message);
  if (error instanceof ReceiptExtractionError) return new LocalReceiptServiceError("invalid_ai_response", "読み取り結果を確認できませんでした。もう一度お試しください。");
  if (error instanceof ActualMasterValidationError) return new LocalReceiptServiceError("invalid_confirmation", error.message);
  if (error instanceof LocalDataStorageError) return new LocalReceiptServiceError("storage", error.message);
  if (error instanceof TypeError) return new LocalReceiptServiceError("offline_or_unavailable", "通信できないか、一時的に処理できませんでした。接続を確認して再試行してください。");
  if (error instanceof Error && ["account_session_required", "ai_token_unavailable"].includes(error.message)) {
    return new LocalReceiptServiceError("auth_required", "AI機能を使うにはアカウントへのサインインが必要です。レシートは端末に保存されています。");
  }
  return new LocalReceiptServiceError("unavailable", "処理できませんでした。通信状態と端末の空き容量を確認して再試行してください。");
}
function safeCategoryResponse(value: unknown): { choice: CategoryId | null; probabilities: Record<CategoryId, number>; model: string } | null {
  if (!value || typeof value !== "object") return null;
  const body = value as Record<string, unknown>;
  const answers = body.answers as Record<string, unknown> | undefined;
  const answer = answers?.category as Record<string, unknown> | undefined;
  const probabilities = answer?.probabilities as Record<string, unknown> | undefined;
  if (!answer || answer.type !== "choice" || !isCategoryId(answer.choice) || typeof body.model !== "string" || !body.model.trim() || !probabilities ||
    typeof answer.confidence !== "number" || !Number.isFinite(answer.confidence) || answer.confidence < 0 || answer.confidence > 1) return null;
  if (Object.keys(probabilities).length !== CATEGORY_IDS.length || !CATEGORY_IDS.every((id) => typeof probabilities[id] === "number" && Number.isFinite(probabilities[id]) && (probabilities[id] as number) >= 0 && (probabilities[id] as number) <= 1)) return null;
  const parsed = Object.fromEntries(CATEGORY_IDS.map((id) => [id, probabilities[id]])) as Record<CategoryId, number>;
  if (Math.abs(CATEGORY_IDS.reduce((sum, id) => sum + parsed[id], 0) - 1) > 0.02) return null;
  const sorted = CATEGORY_IDS.map((id) => parsed[id]).sort((a, b) => b - a);
  if (parsed[answer.choice] !== sorted[0]) return null;
  const confident = sorted[0] >= 0.75 && sorted[0] - sorted[1] >= 0.15;
  return { choice: confident ? answer.choice : null, probabilities: parsed, model: body.model };
}

export class LocalReceiptService {
  private readonly fetchImpl: typeof fetch;
  constructor(private readonly repository: LocalDataRepository, private readonly ledger: Ledger, private readonly options: LocalReceiptServiceOptions = {}) {
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch.bind(globalThis);
  }

  async saveImage(file: Blob): Promise<LocalReceipt> {
    try {
      const bytes = new Uint8Array(await file.arrayBuffer());
      const { contentType, sizeBytes } = validateReceiptImage({ bytes, declaredContentType: file.type });
      const id = newId(this.options);
      const timestamp = nowIso(this.options);
      const blobId = `receipt-image:${id.slice("receipt:".length)}`;
      const receipt: LocalReceipt = {
        id, createdAt: timestamp, updatedAt: timestamp,
        image: { blobId, contentType, sizeBytes }, extraction: null,
        aiSuggestion: { categoryId: null, source: "unclassified", probabilities: null, model: null, attemptedAt: null },
        confirmedValue: null, registration: { status: "pending", actualTransactionId: null, lastError: null },
      };
      await this.repository.putBlob({ id: blobId, ownerKind: "receipt", ownerId: id, blob: new Blob([bytes], { type: contentType }), contentType, createdAt: timestamp });
      await this.save(receipt);
      return receipt;
    } catch (error) { throw safeError(error); }
  }

  async createManual(): Promise<LocalReceipt> {
    const timestamp = nowIso(this.options);
    const receipt: LocalReceipt = {
      id: newId(this.options), createdAt: timestamp, updatedAt: timestamp, image: null, extraction: null,
      aiSuggestion: { categoryId: null, source: "unclassified", probabilities: null, model: null, attemptedAt: null },
      confirmedValue: null, registration: { status: "pending", actualTransactionId: null, lastError: null },
    };
    await this.save(receipt);
    return receipt;
  }

  async list(): Promise<LocalReceipt[]> {
    return (await this.repository.list<LocalReceipt>(RECEIPT_KIND)).map(({ value }) => value).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  async get(id: string): Promise<LocalReceipt | null> {
    const record = await this.repository.get<LocalReceipt>(id);
    return record?.kind === RECEIPT_KIND ? record.value : null;
  }

  async analyze(id: string): Promise<LocalReceipt> {
    return this.withLock(id, async () => {
    const receipt = await this.requireReceipt(id);
    if (receipt.registration.status !== "pending") throw new LocalReceiptServiceError("registration_locked", "登録済みの内容は読み取り直せません。");
    if (!receipt.image) throw new LocalReceiptServiceError("image_required", "読み取るレシート画像がありません。");
    const blob = await this.repository.getBlob(receipt.image.blobId);
    if (!blob) throw new LocalReceiptServiceError("image_missing", "レシート画像を端末で見つけられませんでした。");
    try {
      const bytes = new Uint8Array(await blob.blob.arrayBuffer());
      if (bytes.byteLength > MAX_GATEWAY_IMAGE_BYTES) throw new LocalReceiptServiceError("image_too_large", "レシート画像は端末に保存しました。AIで読み取る場合は6 MiB以下の画像を選び直してください。");
      if (typeof navigator !== "undefined" && navigator.onLine === false) throw new LocalReceiptServiceError("offline_or_unavailable", "オフラインのため読み取れません。レシート画像は端末に保存されています。接続後に再試行してください。");
      const token = await (this.options.getToken ?? getAiAccessToken)();
      const flowId = crypto.randomUUID();
      const response = await this.fetchImpl(this.options.geminiUrl ?? "/api/ai/gemini", {
        method: "POST", credentials: "same-origin", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: JSON.stringify({ flowId, contentType: receipt.image.contentType, imageBase64: toBase64(bytes) }),
      });
      if (!response.ok) throw gatewayError(await readGatewayCode(response));
      const extraction = validateReceiptExtraction(await response.json());
      const timestamp = nowIso(this.options);
      // Store the raw, schema-validated AI output before updating any suggestion state.
      await this.repository.put({ id: `receipt-extraction:${id}`, kind: EXTRACTION_KIND, value: { receiptId: id, extraction, analyzedAt: timestamp }, updatedAt: timestamp });
      const updated: LocalReceipt = { ...receipt, extraction, aiFlowId: flowId, updatedAt: timestamp,
        itemCategories: undefined, aiSuggestion: { categoryId: null, source: "unclassified", probabilities: null, model: null, attemptedAt: null } };
      await this.save(updated);
      return updated;
    } catch (error) { throw safeError(error); }
    });
  }

  async suggestCategory(id: string): Promise<string | null> {
    return this.withLock(id, async () => {
    const receipt = await this.requireReceipt(id);
    if (receipt.confirmedValue && (!receipt.extraction || receipt.registration.status !== "pending")) {
      const id = receipt.confirmedValue.categoryId;
      return isCategoryId(id) || (await this.ledger.listExpenseCategories()).some(c => c.id === id) ? id : null;
    }
    const merchant = receipt.extraction?.merchant ?? null;
    try {
      const mapping = merchant ? (await this.repository.list<{ normalizedMerchant?: string; categoryId?: unknown; actualCategoryId?: unknown }>(MAPPING_KIND))
        .find(({ value }) => value.normalizedMerchant === normalizeMerchant(merchant) && (isCategoryId(value.categoryId) || (typeof value.actualCategoryId === "string" && value.actualCategoryId.length > 0))) : undefined;
      if (!receipt.extraction?.items.length && mapping && (isCategoryId(mapping.value.categoryId) || typeof mapping.value.actualCategoryId === "string")) {
        const categoryId = typeof mapping.value.actualCategoryId === "string" ? mapping.value.actualCategoryId : String(mapping.value.categoryId);
        if (typeof mapping.value.actualCategoryId === "string" && !(await this.ledger.listExpenseCategories()).some(c => c.id === categoryId)) {
          await this.repository.delete(mapping.id);
          await this.save({ ...receipt, aiSuggestion: { categoryId: null, source: "unclassified", probabilities: null, model: null, attemptedAt: null }, updatedAt: nowIso(this.options) });
          return null;
        }
        const suggestion = { categoryId, source: "merchant_mapping" as const, probabilities: null, model: null, attemptedAt: nowIso(this.options) };
        await this.save({ ...receipt, aiSuggestion: suggestion, updatedAt: suggestion.attemptedAt });
      return suggestion.categoryId;
      }
      if (!receipt.extraction) return null;
      // Reuse the validated local answer, including an uncertain result, rather
      // than spending another provider attempt for identical receipt facts.
      if (receipt.aiSuggestion.attemptedAt && (receipt.itemCategories || receipt.aiSuggestion.probabilities) && receipt.aiSuggestion.model) {
        if (receipt.aiSuggestion.flowId === receipt.aiFlowId) return receipt.aiSuggestion.categoryId;
        if (!receipt.aiSuggestion.flowId) {
          const extraction = await this.repository.get<{ analyzedAt: string }>(`receipt-extraction:${id}`);
          if (extraction && receipt.aiSuggestion.attemptedAt >= extraction.value.analyzedAt) return receipt.aiSuggestion.categoryId;
        }
      }
      if (!receipt.aiFlowId) throw gatewayError("invalid_flow");
      if (typeof navigator !== "undefined" && navigator.onLine === false) throw new LocalReceiptServiceError("offline_or_unavailable", "オフラインのためカテゴリを提案できません。保存済みの内容は端末にあります。");
      const items = receipt.extraction.items.slice(0, MAX_ITEMS_FOR_JEV).map(({ name, amountYen }) => ({ name: name.trim().slice(0, MAX_TEXT_FOR_JEV), amountYen }));
      const state = { receipt: { merchant: merchant?.trim().slice(0, MAX_TEXT_FOR_JEV) || null, totalAmountYen: receipt.extraction.totalAmountYen, items } };
      if (!state.receipt.merchant && items.length === 0) return null;
      const token = await (this.options.getToken ?? getAiAccessToken)();
      const response = await this.fetchImpl(this.options.jevUrl ?? "/api/ai/jev", { method: "POST", credentials: "same-origin", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify({ ...state, flowId: receipt.aiFlowId }) });
      if (!response.ok) throw gatewayError(await readGatewayCode(response));
      const body = await response.json() as { model?: unknown; answers?: Record<string, unknown> };
      if (items.length) {
        const parsedItems = items.map((_, index) => safeCategoryResponse({ model: body.model, answers: { category: body.answers?.[`item_${index}`] } }));
        if (parsedItems.some(result => !result)) throw new LocalReceiptServiceError("invalid_ai_response", "品目のカテゴリ候補を確認できませんでした。手動で選んでください。");
        const timestamp = nowIso(this.options);
        const itemCategories = parsedItems.map(result => result!.choice);
        // Items beyond the API limit remain unclassified for manual confirmation.
        while (itemCategories.length < receipt.extraction.items.length) itemCategories.push(null);
        await this.save({ ...receipt, itemCategories, aiSuggestion: { categoryId: itemCategories[0] ?? null, source: itemCategories.some(Boolean) ? "jev" : "unclassified", probabilities: null, model: String(body.model), attemptedAt: timestamp, flowId: receipt.aiFlowId }, updatedAt: timestamp });
        return itemCategories[0] ?? null;
      }
      const parsed = safeCategoryResponse(body);
      if (!parsed) throw new LocalReceiptServiceError("invalid_ai_response", "カテゴリ候補を確認できませんでした。手動で選んでください。");
      const suggestion = { categoryId: parsed.choice, source: parsed.choice ? "jev" as const : "unclassified" as const, probabilities: parsed.probabilities, model: parsed.model, attemptedAt: nowIso(this.options), flowId: receipt.aiFlowId };
      await this.save({ ...receipt, aiSuggestion: suggestion, updatedAt: suggestion.attemptedAt });
      return parsed.choice;
    } catch (error) { throw safeError(error); }
    });
  }

  async confirm(id: string, confirmedValue: ConfirmedReceiptValue): Promise<LocalReceipt> {
    return this.withLock(id, async () => {
    if (!validConfirmed(confirmedValue)) throw new LocalReceiptServiceError("invalid_confirmation", "店舗、日付、金額、カテゴリ、口座を確認してください。");
    const receipt = await this.requireReceipt(id);
    if (receipt.registration.status !== "pending") throw new LocalReceiptServiceError("registration_locked", "登録処理中、登録済み、または結果確認中の内容は変更できません。登録を再試行して状態を確認してください。");
    const timestamp = nowIso(this.options);
    const updated = { ...receipt, confirmedValue: { ...confirmedValue, merchant: confirmedValue.merchant.trim() }, updatedAt: timestamp, registration: { status: "pending" as const, actualTransactionId: null, lastError: null } };
    await this.save(updated);
    const normalizedMerchant = normalizeMerchant(updated.confirmedValue!.merchant);
    const effectiveCategories = new Set((confirmedValue.items ?? []).map(item => item.categoryId ?? confirmedValue.categoryId));
    const mappedCategory = effectiveCategories.size === 1 ? [...effectiveCategories][0] : confirmedValue.categoryId;
    if (normalizedMerchant && effectiveCategories.size <= 1) {
      const categoryMapping = isCategoryId(mappedCategory)
        ? { normalizedMerchant, categoryId: mappedCategory }
        : { normalizedMerchant, actualCategoryId: mappedCategory };
      await this.repository.put({ id: `merchant:${encodeURIComponent(normalizedMerchant)}`, kind: MAPPING_KIND, value: categoryMapping, updatedAt: timestamp });
    }
    return updated;
    });
  }

  async register(id: string): Promise<LocalReceipt> {
    return this.withLock(id, async () => {
      const receipt = await this.requireReceipt(id);
      if (receipt.registration.status === "applied") return receipt;
      if (!receipt.confirmedValue) throw new LocalReceiptServiceError("confirmation_required", "登録内容を確認して保存してください。");
      // Reject unavailable selections before locking a pending receipt for a write.
      const categories = await this.ledger.listExpenseCategories();
      const basicCategory = isCategoryId(receipt.confirmedValue.categoryId) ? receipt.confirmedValue.categoryId : null;
      const category = categories.find(({ id: actualId, name }) => actualId === receipt.confirmedValue!.categoryId || (basicCategory !== null && name === CATEGORY_LABELS[basicCategory]));
      if (!category) throw new LocalReceiptServiceError("category_unavailable", "カテゴリを選び直してください。登録結果の確認中の場合は、元のカテゴリを再表示して再試行してください。");
      if (!(await this.ledger.listOpenAccounts()).some(a => a.id === receipt.confirmedValue!.accountId)) {
        throw new LocalReceiptServiceError("account_unavailable", "支払元を選び直してください。登録結果の確認中の場合は、元の支払元を再開して再試行してください。");
      }
      const allocations = receiptAllocations(receipt.confirmedValue);
      const resolved = allocations.map(row => {
        const key = isCategoryId(row.categoryId) ? row.categoryId : null;
        const found = categories.find(c => c.id === row.categoryId || (key !== null && c.name === CATEGORY_LABELS[key]));
        if (!found) throw new LocalReceiptServiceError("category_unavailable", "品目のカテゴリを選び直してください。");
        return { categoryId: found.id, amountYen: -row.amountYen };
      });
      const combined = new Map<string, number>();
      for (const row of resolved) combined.set(row.categoryId, (combined.get(row.categoryId) ?? 0) + row.amountYen);
      const splits = [...combined].map(([categoryId, amountYen]) => ({ categoryId, amountYen }));
      const timestamp = nowIso(this.options);
      const processing = { ...receipt, registration: { ...receipt.registration, status: "processing" as const, lastError: null }, updatedAt: timestamp };
      await this.save(processing);
      try {
        const transaction = await this.ledger.importReceipt({
          accountId: receipt.confirmedValue.accountId, date: receipt.confirmedValue.purchasedDate,
          amountYen: -receipt.confirmedValue.totalAmountYen, merchant: receipt.confirmedValue.merchant,
          categoryId: splits[0]?.categoryId ?? category.id, ...(splits.length > 1 ? { splits } : {}), importedId: `kakeimatch:${id}`,
        });
        const applied = { ...processing, registration: { status: "applied" as const, actualTransactionId: transaction.id, lastError: null }, updatedAt: nowIso(this.options) };
        await this.save(applied);
        return applied;
      } catch (error) {
        const normalized = safeError(error);
        const failed = { ...processing, registration: { status: "failed" as const, actualTransactionId: null, lastError: normalized.message }, updatedAt: nowIso(this.options) };
        await this.save(failed);
        throw normalized;
      }
    });
  }

  private async requireReceipt(id: string): Promise<LocalReceipt> {
    const receipt = await this.get(id);
    if (!receipt) throw new LocalReceiptServiceError("receipt_not_found", "レシートが端末に見つかりませんでした。");
    return receipt;
  }
  private save(receipt: LocalReceipt): Promise<void> {
    return this.repository.put({ id: receipt.id, kind: RECEIPT_KIND, value: receipt, updatedAt: receipt.updatedAt });
  }
  private withLock<T>(id: string, operation: () => Promise<T>): Promise<T> {
    if (this.options.withRegistrationLock) return this.options.withRegistrationLock(id, operation);
    if (typeof navigator !== "undefined" && navigator.locks) {
      return navigator.locks.request<unknown>(`kakeimatch-register:${id}`, { mode: "exclusive" }, async () => operation()) as Promise<T>;
    }
    throw new LocalReceiptServiceError("registration_lock_unavailable", "この端末では安全な登録処理を開始できません。対応ブラウザーで再試行してください。");
  }
}

/** Printed total is authoritative. Multiple categories require a complete, exact allocation. */
export function receiptAllocations(value: ConfirmedReceiptValue): Array<{ categoryId: string; amountYen: number }> {
  const items = value.items ?? [];
  const categories = new Set(items.map(item => item.categoryId ?? value.categoryId));
  if (categories.size <= 1) return [{ categoryId: [...categories][0] ?? value.categoryId, amountYen: value.totalAmountYen }];
  const fail = (): never => { throw new LocalReceiptServiceError("allocation_required", "カテゴリ配分を確認してください。品目と値引きの合計をレシート総額に合わせてください。"); };
  const totals = new Map<string, number>();
  for (const item of items) {
    if (item.amountYen === null) fail();
    const key = item.categoryId ?? value.categoryId;
    const amount = (totals.get(key) ?? 0) + item.amountYen!;
    if (!Number.isSafeInteger(amount)) fail();
    totals.set(key, amount);
  }
  for (const adjustment of value.adjustments ?? []) {
    const item = items.find(item => item.id === adjustment.targetItemId);
    if (!item) fail();
    const key = item!.categoryId ?? value.categoryId;
    const amount = totals.get(key)! + adjustment.amountYen;
    if (!Number.isSafeInteger(amount) || amount < 0) fail();
    totals.set(key, amount);
  }
  const sum = [...totals.values()].reduce((sum, amount) => sum + amount, 0);
  if (!Number.isSafeInteger(sum) || sum !== value.totalAmountYen) fail();
  return [...totals].filter(([,amount]) => amount > 0).map(([categoryId, amountYen]) => ({ categoryId, amountYen }));
}

function toBase64(bytes: Uint8Array): string {
  let binary = "";
  const chunkSize = 0x8000;
  for (let index = 0; index < bytes.length; index += chunkSize) binary += String.fromCharCode(...bytes.subarray(index, index + chunkSize));
  return btoa(binary);
}
async function readGatewayCode(response: Response): Promise<string> {
  try { const body = await response.json() as { error?: unknown }; return typeof body.error === "string" ? body.error : "request_failed"; }
  catch { return "request_failed"; }
}
function gatewayError(code: string): LocalReceiptServiceError {
  if (code === "invalid_flow") return new LocalReceiptServiceError("invalid_flow", "この読み取りのカテゴリ提案は終了しました。手動で選ぶか、AIで読み取り直してください。");
  if (code === "unauthorized") return new LocalReceiptServiceError("auth_required", "AI機能を使うにはアカウントへのサインインが必要です。レシートは端末に保存されています。");
  if (code === "ai_quota_exceeded") return new LocalReceiptServiceError("quota", "AI利用上限に達しました。手動で入力できます。");
  if (code === "rate_limited") return new LocalReceiptServiceError("rate_limited", "AIへの要求が集中しています。しばらく待つか、手動で入力してください。");
  if (code === "invalid_provider_response") return new LocalReceiptServiceError("invalid_ai_response", "AIの応答を確認できませんでした。もう一度お試しください。");
  if (code === "not_configured") return new LocalReceiptServiceError("not_configured", "AI機能を現在利用できません。後でもう一度お試しください。");
  return new LocalReceiptServiceError("offline_or_unavailable", "通信できないか、一時的に処理できませんでした。接続を確認して再試行してください。");
}
