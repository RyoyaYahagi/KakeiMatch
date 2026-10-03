import { CATEGORY_IDS, CATEGORY_LABELS, isCategoryId, normalizeMerchant, type CategoryId } from "../../../src/lib/category";
import { ReceiptExtractionError, validateReceiptExtraction, type ReceiptExtractionResult } from "../../../src/lib/receipt-extraction";
import { LocalDataStorageError, type LocalDataRepository } from "../../../src/lib/local-data";
import { ReceiptValidationError, validateReceiptImage, type ReceiptContentType } from "../../../src/lib/receipt-validation";
import { getAiAccessToken } from "./ai-auth";
import { ActualMasterValidationError, type createActualBrowserLedger } from "../../../src/lib/actual-browser-ledger";
import { LocalCategoryLearning, type AppliedCategoryRule } from "./local-category-learning";

const RECEIPT_KIND = "receipt-metadata" as const;
const EXTRACTION_KIND = "receipt-extraction" as const;
const MAPPING_KIND = "merchant-mapping" as const;
const MAX_GATEWAY_IMAGE_BYTES = 6 * 1024 * 1024;
const MAX_ITEMS_FOR_JEV = 30;
const MAX_TEXT_FOR_JEV = 200;
function receiptEditAuditId(id: string): string { return `receipt-correction:${id}`; }

export type ReceiptItem = { id: string; name: string; amountYen: number | null; quantity?: number | null; unitPriceYen?: number | null; categoryId: string | null };
export type ReceiptAdjustment = { id: string; label: string; amountYen: number; targetItemId?: string | null };

export type ConfirmedReceiptValue = {
  merchant: string;
  purchasedDate: string;
  purchasedTime: string | null;
  totalAmountYen: number;
  /** Current Actual category ID; older receipts may contain a base CategoryId key. */
  categoryId: string;
  accountId: string;
  memo?: string | null;
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
  classificationAttempt?: { flowId?: string; model: string; attemptedAt: string; itemCategories?: Array<string | null>; categoryId: string | null };
  aiSuggestion: { categoryId: string | null; source: "merchant_mapping" | "learned_rule" | "jev" | "unclassified"; probabilities: Record<CategoryId, number> | null; model: string | null; attemptedAt: string | null; flowId?: string; categoryRules?: AppliedCategoryRule[] };
  confirmedValue: ConfirmedReceiptValue | null;
  registration: { status: "pending" | "processing" | "applied" | "failed" | "deleted"; actualTransactionId: string | null; lastError: string | null };
};

export type ReceiptEditAudit = {
  targetType: "receipt";
  receiptId: string;
  operationId: string;
  before: ConfirmedReceiptValue;
  after: ConfirmedReceiptValue;
  status: "pending" | "applied";
  createdAt: string;
  appliedAt: string | null;
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
  if ((value.memo != null && (typeof value.memo !== "string" || value.memo.length > 2000)) || items.length > 100 || adjustments.length > 100 ||
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
function safeCategoryResponse(value: unknown, categories: Array<{ id: string; name: string }>): { choice: string | null; probabilities: Record<CategoryId, number> | null; model: string } | null {
  if (!value || typeof value !== "object") return null;
  const body = value as Record<string, unknown>;
  const answers = body.answers as Record<string, unknown> | undefined;
  const answer = answers?.category as Record<string, unknown> | undefined;
  const probabilities = answer?.probabilities as Record<string, unknown> | undefined;
  const available = new Set(categories.map(category => category.id));
  if (!answer || answer.type !== "choice" || typeof answer.choice !== "string" || !available.has(answer.choice) || typeof body.model !== "string" || !body.model.trim() || !probabilities ||
    typeof answer.confidence !== "number" || !Number.isFinite(answer.confidence) || answer.confidence < 0 || answer.confidence > 1) return null;
  const keys = Object.keys(probabilities);
  if (keys.length !== categories.length || categories.some(category => typeof probabilities[category.id] !== "number" || !Number.isFinite(probabilities[category.id]) || (probabilities[category.id] as number) < 0 || (probabilities[category.id] as number) > 1)) return null;
  const values = categories.map(category => probabilities[category.id] as number);
  if (keys.some(key => !available.has(key)) || Math.abs(values.reduce((sum, probability) => sum + probability, 0) - 1) > 0.02) return null;
  const ranked = [...values].sort((a, b) => b - a);
  const chosen = probabilities[answer.choice] as number;
  if (chosen !== ranked[0]) return null;
  const confident = chosen >= 0.75 && chosen - (ranked[1] ?? 0) >= 0.15;
  const baseProbabilities = keys.length === CATEGORY_IDS.length && CATEGORY_IDS.every(id => typeof probabilities[id] === "number")
    ? Object.fromEntries(CATEGORY_IDS.map(id => [id, probabilities[id]])) as Record<CategoryId, number> : null;
  return { choice: confident ? answer.choice : null, probabilities: baseProbabilities, model: body.model };
}

export class LocalReceiptService {
  private readonly fetchImpl: typeof fetch;
  private readonly categoryLearning: LocalCategoryLearning;
  constructor(private readonly repository: LocalDataRepository, private readonly ledger: Ledger, private readonly options: LocalReceiptServiceOptions = {}) {
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch.bind(globalThis);
    this.categoryLearning = new LocalCategoryLearning(repository);
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

  async deletePending(id: string): Promise<void> {
    await this.withLock(id, async () => {
      try {
        const receipt = await this.requireReceipt(id);
        if (receipt.registration.status !== "pending" || receipt.registration.actualTransactionId !== null) {
          throw new LocalReceiptServiceError("receipt_not_deletable", "登録処理中、登録済み、または結果の確認が必要なレシートは削除できません。登録結果を確認してください。");
        }
        if (receipt.confirmedValue) {
          const importedId = `kakeimatch:${receipt.id}`;
          const transactions = await this.ledger.getTransactions({ startDate: "0001-01-01", endDate: "9999-12-31" });
          if (transactions.some(transaction => transaction.importedId === importedId)) {
            throw new LocalReceiptServiceError("receipt_actual_data_exists", "このレシートに対応する家計簿データが見つかりました。家計簿の記録を確認してから操作してください。");
          }
        }
        await this.repository.deleteReceiptData(receipt.id, `receipt-extraction:${receipt.id}`, `receipt-draft:${receipt.id}`);
      } catch (error) { throw safeError(error); }
    });
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
      if (!response.ok) throw gatewayError(await readGatewayCode(response), response.status);
      const extraction = validateReceiptExtraction(await response.json());
      const timestamp = nowIso(this.options);
      // Store the raw, schema-validated AI output before updating any suggestion state.
      await this.repository.put({ id: `receipt-extraction:${id}`, kind: EXTRACTION_KIND, value: { receiptId: id, extraction, analyzedAt: timestamp }, updatedAt: timestamp });
      const updated: LocalReceipt = { ...receipt, extraction, aiFlowId: flowId, updatedAt: timestamp,
        itemCategories: undefined, classificationAttempt: undefined, aiSuggestion: { categoryId: null, source: "unclassified", probabilities: null, model: null, attemptedAt: null } };
      await this.save(updated);
      return updated;
    } catch (error) { throw safeError(error); }
    });
  }

  async suggestCategory(id: string): Promise<string | null> {
    return this.withLock(id, async () => {
      const receipt = await this.requireReceipt(id);
      if (receipt.confirmedValue && (!receipt.extraction || receipt.registration.status !== "pending")) {
        const confirmedId = receipt.confirmedValue.categoryId;
        return isCategoryId(confirmedId) || (await this.ledger.listExpenseCategories()).some(category => category.id === confirmedId) ? confirmedId : null;
      }
      if (!receipt.extraction) return null;
      try {
        const extraction = receipt.extraction;
        const categories = await this.ledger.listExpenseCategories();
        const available = new Set(categories.map(category => category.id));
        const resolveCurrent = (candidate: unknown): string | null => {
          if (typeof candidate !== "string" || !candidate) return null;
          if (available.has(candidate)) return candidate;
          return isCategoryId(candidate) ? categories.find(category => category.name === CATEGORY_LABELS[candidate])?.id ?? null : null;
        };
        const rules = await this.categoryLearning.suggest({
          merchant: extraction.merchant,
          items: extraction.items.map(item => ({ name: item.name })),
          categories,
        });
        const merchantRule = resolveCurrent(rules.merchantCategoryId);
        let legacyMerchantCategory: string | null = null;
        if (extraction.items.length === 0 && extraction.merchant && !rules.hasMerchantHistory) {
          const mappings = await this.repository.list<{ normalizedMerchant?: string; categoryId?: unknown; actualCategoryId?: unknown }>(MAPPING_KIND);
          const mapping = mappings.find(({ value }) => value.normalizedMerchant === normalizeMerchant(extraction.merchant!));
          if (mapping) {
            legacyMerchantCategory = resolveCurrent(mapping.value.actualCategoryId ?? mapping.value.categoryId);
            if (!legacyMerchantCategory) await this.repository.delete(mapping.id);
          }
        }
        const merchantCategory = merchantRule ?? legacyMerchantCategory;
        const learnedItems = extraction.items.map((_, index) => resolveCurrent(rules.itemCategories[index]));
        const itemCategories = extraction.items.map((_, index) => learnedItems[index] ?? merchantRule ?? null);
        const usedLearningRule = !!merchantRule || learnedItems.some(Boolean);
        const categoryRules: AppliedCategoryRule[] = [];
        const addAppliedRule = (rule: AppliedCategoryRule | null, categoryId: string | null) => {
          if (!rule || rule.categoryId !== categoryId || categoryRules.some(existing => existing.targetType === rule.targetType && existing.normalizedName === rule.normalizedName)) return;
          categoryRules.push(rule);
        };
        if (extraction.items.length) itemCategories.forEach((categoryId, index) => addAppliedRule(learnedItems[index] ? rules.itemRules[index] ?? null : rules.merchantRule, categoryId));
        else addAppliedRule(rules.merchantRule, merchantCategory);
        const usedLegacyMapping = !merchantRule && !!legacyMerchantCategory;
        const legacyJevAttempt = (receipt.aiSuggestion.source === "jev" || receipt.aiSuggestion.source === "unclassified") &&
          !!receipt.aiSuggestion.attemptedAt && !!receipt.aiSuggestion.model
          ? { flowId: receipt.aiSuggestion.flowId, model: receipt.aiSuggestion.model, attemptedAt: receipt.aiSuggestion.attemptedAt,
            itemCategories: receipt.itemCategories, categoryId: receipt.aiSuggestion.categoryId }
          : null;
        const attempted = receipt.classificationAttempt ?? legacyJevAttempt;
        let mayReuseJev = false;
        if (attempted) {
          if (attempted.flowId === receipt.aiFlowId && !!receipt.aiFlowId) mayReuseJev = true;
          else if (!attempted.flowId) {
            const savedExtraction = await this.repository.get<{ analyzedAt: string }>(`receipt-extraction:${id}`);
            mayReuseJev = !!savedExtraction && attempted.attemptedAt >= savedExtraction.value.analyzedAt;
          }
        }
        const sourceWithoutJev = usedLearningRule ? "learned_rule" as const : usedLegacyMapping ? "merchant_mapping" as const : "unclassified" as const;
        const saveRulesOrMapping = async () => {
          const categoryId = extraction.items.length ? itemCategories[0] ?? null : merchantCategory ?? resolveCurrent(receipt.aiSuggestion.categoryId);
          const updated = { ...receipt, classificationAttempt: attempted ? (receipt.classificationAttempt ?? attempted) : receipt.classificationAttempt,
            itemCategories: extraction.items.length ? itemCategories : receipt.itemCategories,
            aiSuggestion: { categoryId, source: sourceWithoutJev, probabilities: null, model: null, attemptedAt: nowIso(this.options), ...(receipt.aiFlowId ? { flowId: receipt.aiFlowId } : {}), ...(categoryRules.length ? { categoryRules } : {}) },
            updatedAt: nowIso(this.options) };
          await this.save(updated);
          return categoryId;
        };
        const saveCurrentItems = async () => {
          const categoryId = itemCategories[0] ?? null;
          await this.save({ ...receipt, classificationAttempt: attempted ? (receipt.classificationAttempt ?? attempted) : receipt.classificationAttempt,
            itemCategories, aiSuggestion: { categoryId, source: itemCategories.some(Boolean) ? "jev" : "unclassified",
              probabilities: null, model: attempted?.model ?? null, attemptedAt: attempted?.attemptedAt ?? null,
              ...(attempted?.flowId ? { flowId: attempted.flowId } : {}), ...(categoryRules.length ? { categoryRules } : {}) }, updatedAt: nowIso(this.options) });
          return categoryId;
        };

        if (extraction.items.length) {
          if (mayReuseJev && attempted) {
            const cached = attempted.itemCategories ?? [];
            for (let index = 0; index < Math.min(itemCategories.length, MAX_ITEMS_FOR_JEV); index++) {
              if (itemCategories[index] === null) itemCategories[index] = resolveCurrent(cached[index]) ?? null;
            }
          }
          const unresolved = itemCategories.map((categoryId, index) => categoryId === null ? index : -1).filter(index => index >= 0);
          const unresolvedForJev = unresolved.filter(index => index < MAX_ITEMS_FOR_JEV);
          if (unresolvedForJev.length === 0) {
            if (usedLearningRule || usedLegacyMapping) return await saveRulesOrMapping();
            if (mayReuseJev) return await saveCurrentItems();
            return null;
          }
          if (usedLearningRule || usedLegacyMapping) await saveRulesOrMapping();
          if (mayReuseJev) {
            if (usedLearningRule) return await saveRulesOrMapping();
            return await saveCurrentItems();
          }
          if (!categories.length || categories.length > 100) return itemCategories[0] ?? null;
          if (!receipt.aiFlowId) throw gatewayError("invalid_flow");
          if (typeof navigator !== "undefined" && navigator.onLine === false) throw new LocalReceiptServiceError("offline_or_unavailable", "オフラインのためカテゴリを提案できません。保存済みの内容は端末にあります。");
          const token = await (this.options.getToken ?? getAiAccessToken)();
          const items = extraction.items.slice(0, MAX_ITEMS_FOR_JEV).map(({ name, amountYen }) => ({ name: name.trim().slice(0, MAX_TEXT_FOR_JEV), amountYen }));
          const bodyState = { flowId: receipt.aiFlowId, itemIndexes: unresolvedForJev, categories: categories.map(({ id: categoryId, name }) => ({ id: categoryId, name })),
            receipt: { merchant: extraction.merchant?.trim().slice(0, MAX_TEXT_FOR_JEV) || null, totalAmountYen: extraction.totalAmountYen, items } };
          if (!bodyState.receipt.merchant && items.length === 0) return itemCategories[0] ?? null;
          const response = await this.fetchImpl(this.options.jevUrl ?? "/api/ai/jev", { method: "POST", credentials: "same-origin", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify(bodyState) });
          if (!response.ok) throw gatewayError(await readGatewayCode(response), response.status);
          const body = await response.json() as { model?: unknown; answers?: Record<string, unknown> };
          if (typeof body.model !== "string" || !body.model.trim() || !body.answers) throw new LocalReceiptServiceError("invalid_ai_response", "品目のカテゴリ候補を確認できませんでした。手動で選んでください。");
          const expectedKeys = new Set(unresolvedForJev.map(index => `item_${index}`));
          if (Object.keys(body.answers).some(key => !expectedKeys.has(key)) || [...expectedKeys].some(key => !(key in body.answers!))) {
            throw new LocalReceiptServiceError("invalid_ai_response", "品目のカテゴリ候補を確認できませんでした。手動で選んでください。");
          }
          const jevItems: Array<string | null> = extraction.items.map(() => null);
          for (const itemIndex of unresolvedForJev) {
            const parsed = safeCategoryResponse({ model: body.model, answers: { category: body.answers[`item_${itemIndex}`] } }, categories);
            if (!parsed) throw new LocalReceiptServiceError("invalid_ai_response", "品目のカテゴリ候補を確認できませんでした。手動で選んでください。");
            itemCategories[itemIndex] = parsed.choice;
            jevItems[itemIndex] = parsed.choice;
          }
          const timestamp = nowIso(this.options);
          const categoryId = itemCategories[0] ?? null;
          await this.save({ ...receipt, itemCategories,
            classificationAttempt: { flowId: receipt.aiFlowId, model: body.model, attemptedAt: timestamp, itemCategories: jevItems, categoryId: null },
            aiSuggestion: { categoryId, source: itemCategories.some(Boolean) ? "jev" : "unclassified", probabilities: null, model: body.model, attemptedAt: timestamp, flowId: receipt.aiFlowId, ...(categoryRules.length ? { categoryRules } : {}) }, updatedAt: timestamp });
          return categoryId;
        }

        if (merchantCategory) return await saveRulesOrMapping();
        if (mayReuseJev && attempted) {
          const categoryId = resolveCurrent(attempted.categoryId);
          await this.save({ ...receipt, classificationAttempt: receipt.classificationAttempt ?? attempted,
            aiSuggestion: { categoryId, source: categoryId ? "jev" : "unclassified", probabilities: null, model: attempted.model,
              attemptedAt: attempted.attemptedAt, ...(attempted.flowId ? { flowId: attempted.flowId } : {}) }, updatedAt: nowIso(this.options) });
          return categoryId;
        }
        if (!extraction.merchant && extraction.items.length === 0) return null;
        if (!categories.length || categories.length > 100) return null;
        if (!receipt.aiFlowId) throw gatewayError("invalid_flow");
        if (typeof navigator !== "undefined" && navigator.onLine === false) throw new LocalReceiptServiceError("offline_or_unavailable", "オフラインのためカテゴリを提案できません。保存済みの内容は端末にあります。");
        const token = await (this.options.getToken ?? getAiAccessToken)();
        const bodyState = { flowId: receipt.aiFlowId, categories: categories.map(({ id: categoryId, name }) => ({ id: categoryId, name })),
          receipt: { merchant: extraction.merchant?.trim().slice(0, MAX_TEXT_FOR_JEV) || null, totalAmountYen: extraction.totalAmountYen, items: [] } };
        const response = await this.fetchImpl(this.options.jevUrl ?? "/api/ai/jev", { method: "POST", credentials: "same-origin", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify(bodyState) });
        if (!response.ok) throw gatewayError(await readGatewayCode(response), response.status);
        const body = await response.json() as { model?: unknown; answers?: Record<string, unknown> };
        if (!body.answers || Object.keys(body.answers).length !== 1 || !Object.hasOwn(body.answers, "category")) {
          throw new LocalReceiptServiceError("invalid_ai_response", "カテゴリ候補を確認できませんでした。手動で選んでください。");
        }
        const parsed = safeCategoryResponse({ model: body.model, answers: { category: body.answers?.category } }, categories);
        if (!parsed) throw new LocalReceiptServiceError("invalid_ai_response", "カテゴリ候補を確認できませんでした。手動で選んでください。");
        const timestamp = nowIso(this.options);
        await this.save({ ...receipt, classificationAttempt: { flowId: receipt.aiFlowId, model: parsed.model, attemptedAt: timestamp, categoryId: parsed.choice },
          aiSuggestion: { categoryId: parsed.choice, source: parsed.choice ? "jev" : "unclassified", probabilities: parsed.probabilities, model: parsed.model, attemptedAt: timestamp, flowId: receipt.aiFlowId }, updatedAt: timestamp });
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
    const categories = await this.ledger.listExpenseCategories();
    const learningRecords = this.categoryLearning.recordsForConfirmation(id, updated.confirmedValue!, categories, timestamp);
    await this.repository.putRecords([
      { id: updated.id, kind: RECEIPT_KIND, value: updated, updatedAt: timestamp },
      ...learningRecords,
    ]);
    return updated;
    });
  }

  async getPendingEdit(id: string): Promise<ReceiptEditAudit | null> {
    const record = await this.repository.get<ReceiptEditAudit>(receiptEditAuditId(id));
    if (record?.kind !== "correction-audit" || record.value?.targetType !== "receipt" || record.value.status !== "pending") return null;
    return record.value;
  }

  /** Updates the existing Actual transaction and records a durable, retryable audit intent. */
  async edit(id: string, input: ConfirmedReceiptValue, expectedUpdatedAt?: string): Promise<LocalReceipt> {
    return this.withLock(id, async () => {
      const receipt = await this.requireReceipt(id);
      const pending = await this.getPendingEdit(id);
      if (pending) {
        if (!receipt.confirmedValue || !receipt.registration.actualTransactionId) {
          throw new LocalReceiptServiceError("edit_state_invalid", "変更の確認情報を開けませんでした。保存データを確認してください。");
        }
        return this.applyEdit(receipt, pending);
      }
      if (!validConfirmed(input)) throw new LocalReceiptServiceError("invalid_confirmation", "店舗、日付、金額、カテゴリ、口座を確認してください。");
      if (expectedUpdatedAt !== undefined && expectedUpdatedAt !== receipt.updatedAt) {
        throw new LocalReceiptServiceError("receipt_changed", "別の画面で内容が変更されています。最新の内容を開き直してください。");
      }
      if (receipt.registration.status !== "applied" || !receipt.registration.actualTransactionId || !receipt.confirmedValue) {
        throw new LocalReceiptServiceError("edit_unavailable", "登録済みの支出だけ編集できます。");
      }
      const categories = await this.ledger.listExpenseCategories();
      const accounts = await this.ledger.listOpenAccounts();
      const normalized = { ...input, merchant: input.merchant.trim() };
      const available = (categoryId: string) => {
        const base = isCategoryId(categoryId) ? categoryId : null;
        return categories.some(category => category.id === categoryId || (base !== null && category.name === CATEGORY_LABELS[base]));
      };
      if (!accounts.some(account => account.id === normalized.accountId)) throw new LocalReceiptServiceError("account_unavailable", "支払元を選び直してください。");
      if (!available(normalized.categoryId) || (normalized.items ?? []).some(item => item.categoryId !== null && !available(item.categoryId))) {
        throw new LocalReceiptServiceError("category_unavailable", "カテゴリを選び直してください。");
      }
      const allocations = receiptAllocations(normalized);
      const resolved = allocations.map(row => {
        const base = isCategoryId(row.categoryId) ? row.categoryId : null;
        const category = categories.find(candidate => candidate.id === row.categoryId || (base !== null && candidate.name === CATEGORY_LABELS[base]));
        if (!category) throw new LocalReceiptServiceError("category_unavailable", "品目のカテゴリを選び直してください。");
        return { categoryId: category.id, amountYen: -row.amountYen };
      });
      const combined = new Map<string, number>();
      for (const row of resolved) combined.set(row.categoryId, (combined.get(row.categoryId) ?? 0) + row.amountYen);
      const splits = [...combined].map(([categoryId, amountYen]) => ({ categoryId, amountYen }));
      const timestamp = nowIso(this.options);
      const audit: ReceiptEditAudit = {
        targetType: "receipt", receiptId: id, operationId: crypto.randomUUID(), before: receipt.confirmedValue,
        after: normalized, status: "pending", createdAt: timestamp, appliedAt: null,
      };
      await this.repository.put({ id: receiptEditAuditId(id), kind: "correction-audit", value: audit, updatedAt: timestamp });
      // Continue from the durable intent. If Actual succeeds but the local commit fails,
      // retry repeats this same importedId and target transaction with the saved payload.
      return this.applyEdit(receipt, audit, splits);
    });
  }

  private async applyEdit(receipt: LocalReceipt, audit: ReceiptEditAudit, precomputedSplits?: Array<{ categoryId: string; amountYen: number }>): Promise<LocalReceipt> {
    const categories = await this.ledger.listExpenseCategories();
    const allocations = receiptAllocations(audit.after);
    const resolved = allocations.map(row => {
      const base = isCategoryId(row.categoryId) ? row.categoryId : null;
      const category = categories.find(candidate => candidate.id === row.categoryId || (base !== null && candidate.name === CATEGORY_LABELS[base]));
      if (!category) throw new LocalReceiptServiceError("category_unavailable", "カテゴリを選び直してください。");
      return { categoryId: category.id, amountYen: -row.amountYen };
    });
    const combined = new Map<string, number>();
    for (const row of (precomputedSplits ?? resolved)) combined.set(row.categoryId, (combined.get(row.categoryId) ?? 0) + row.amountYen);
    const splits = [...combined].map(([categoryId, amountYen]) => ({ categoryId, amountYen }));
    const categoryId = splits[0]?.categoryId;
    if (!categoryId || !receipt.registration.actualTransactionId) throw new LocalReceiptServiceError("edit_state_invalid", "登録済み取引を確認できませんでした。");
    try {
      const transaction = await this.ledger.editReceipt(receipt.registration.actualTransactionId, {
        accountId: audit.after.accountId, date: audit.after.purchasedDate, amountYen: -audit.after.totalAmountYen,
        merchant: audit.after.merchant, ...(audit.after.memo !== undefined ? { memo: audit.after.memo } : {}), categoryId, importedId: `kakeimatch:${receipt.id}`,
        ...(splits.length > 1 ? { splits } : {}),
      });
      if (transaction.id !== receipt.registration.actualTransactionId) throw new LocalReceiptServiceError("edit_readback_failed", "変更後の内容を家計簿で確認できませんでした。再試行してください。");
      const appliedAt = nowIso(this.options);
      const updated: LocalReceipt = { ...receipt, confirmedValue: audit.after, updatedAt: appliedAt };
      const appliedAudit: ReceiptEditAudit = { ...audit, status: "applied", appliedAt };
      const learningRecords = this.categoryLearning.recordsForConfirmation(receipt.id, audit.after, categories, appliedAt);
      await this.repository.putRecords([
        { id: receipt.id, kind: RECEIPT_KIND, value: updated, updatedAt: appliedAt },
        { id: receiptEditAuditId(receipt.id), kind: "correction-audit", value: appliedAudit, updatedAt: appliedAt },
        { id: `${receiptEditAuditId(receipt.id)}:${audit.operationId}`, kind: "correction-audit", value: appliedAudit, updatedAt: appliedAt },
        ...learningRecords,
      ]);
      return updated;
    } catch (error) { throw safeError(error); }
  }

  async register(id: string): Promise<LocalReceipt> {
    return this.withLock(id, async () => {
      const receipt = await this.requireReceipt(id);
      if (receipt.registration.status === "applied") return receipt;
      if (receipt.registration.status === "deleted") throw new LocalReceiptServiceError("registration_locked", "削除済みの支出は再登録できません。元に戻してから再試行してください。");
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
          ...(receipt.confirmedValue.memo !== undefined ? { memo: receipt.confirmedValue.memo } : {}), categoryId: splits[0]?.categoryId ?? category.id, ...(splits.length > 1 ? { splits } : {}), importedId: `kakeimatch:${id}`,
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
  const fail = (): never => { throw new LocalReceiptServiceError("allocation_required", "カテゴリ配分を確認してください。品目と値引きの合計を入力した合計金額に合わせてください。"); };
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
function gatewayError(code: string, status?: number): LocalReceiptServiceError {
  if (code === "invalid_flow") return new LocalReceiptServiceError("invalid_flow", "この読み取りのカテゴリ提案は終了しました。手動で選ぶか、AIで読み取り直してください。");
  if (code === "unauthorized") return new LocalReceiptServiceError("auth_required", "AI機能を使うにはアカウントへのサインインが必要です。レシートは端末に保存されています。");
  if (code === "ai_quota_exceeded") return new LocalReceiptServiceError("quota", "AI利用上限に達しました。手動で入力できます。");
  if (code === "rate_limited") return new LocalReceiptServiceError("rate_limited", "AIへの要求が集中しています。しばらく待つか、手動で入力してください。");
  if (code === "invalid_provider_response") return new LocalReceiptServiceError("invalid_ai_response", "AIの応答を確認できませんでした。もう一度お試しください。");
  if (code === "not_configured") return new LocalReceiptServiceError("not_configured", "AI機能を現在利用できません。後でもう一度お試しください。");
  if (code === "ai_temporarily_paused" || status === 503) return new LocalReceiptServiceError("offline_or_unavailable", "AI機能は一時的に利用できません。レシート画像と入力内容は端末に残っています。手入力で登録できます。時間をおいて再度お試しください。");
  return new LocalReceiptServiceError("offline_or_unavailable", "通信できないか、一時的に処理できませんでした。接続を確認して再試行してください。");
}
