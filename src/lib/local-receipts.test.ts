import "fake-indexeddb/auto";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { LocalDataRepository } from "./local-data";
import { createPortableBackup } from "./local-backup-format";
import { LocalReceiptService, receiptAllocations, type ConfirmedReceiptValue } from "../../apps/pwa/src/local-receipts";

const extraction = {
  documentKind: "receipt", merchant: "Synthetic Shop", purchasedDate: "2026-09-30", purchasedTime: "12:30",
  totalAmountYen: 3284, taxAmountYen: null, items: [{ name: "Synthetic Item", amountYen: 3284 }], warnings: [],
};
const probabilities = { "actual-food": 0.92, "actual-medical": 0.04, "actual-household": 0.04 };

function pngBlob() {
  return new Blob([new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1])], { type: "image/png" });
}
async function setup(fetchImpl = vi.fn(), ledgerOverrides: Record<string, unknown> = {}, serviceOptions: Record<string, unknown> = {}) {
  const repository = await LocalDataRepository.open(crypto.randomUUID());
  const ledger = {
    listOpenAccounts: vi.fn(async () => [{ id: "cash", name: "現金" }]),
    listExpenseCategories: vi.fn(async () => [{ id: "actual-food", name: "食費" }, { id: "actual-medical", name: "医療" }, { id: "actual-household", name: "日用品" }]),
    importReceipt: vi.fn(async () => ({ id: "actual-tx" })),
    ...ledgerOverrides,
  };
  const service = new LocalReceiptService(repository, ledger as never, {
    fetchImpl: fetchImpl as typeof fetch,
    getToken: vi.fn(async () => "synthetic-token"),
    makeId: () => "00000000-0000-4000-8000-000000000001",
    now: () => new Date("2026-09-30T00:00:00.000Z"),
    withRegistrationLock: async (_id, operation) => operation(),
    ...serviceOptions,
  });
  return { repository, ledger, service };
}

beforeEach(() => {
  indexedDB.deleteDatabase("kakeimatch-local-data");
});

describe("LocalReceiptService", () => {
  it("stores the image and metadata locally before AI, then saves validated extraction separately from confirmation", async () => {
    const fetchImpl = vi.fn(async () => Response.json(extraction));
    const { repository, service } = await setup(fetchImpl);
    const receipt = await service.saveImage(pngBlob());
    expect(receipt.id).toBe("receipt:00000000-0000-4000-8000-000000000001");
    expect((await repository.getBlob(receipt.image!.blobId))?.ownerId).toBe(receipt.id);
    const analyzed = await service.analyze(receipt.id);
    expect(analyzed.extraction).toEqual(extraction);
    expect(analyzed.confirmedValue).toBeNull();
    expect(await repository.get(`receipt-extraction:${receipt.id}`)).toMatchObject({ kind: "receipt-extraction", value: { receiptId: receipt.id, extraction } });
    expect(fetchImpl).toHaveBeenCalledWith("/api/ai/gemini", expect.objectContaining({
      method: "POST", headers: expect.objectContaining({ authorization: "Bearer synthetic-token" }),
    }));
  });

  it("has the local image and receipt row persisted before starting the Gemini request", async () => {
    const fetchImpl = vi.fn(async () => {
      const rows = await setupResult.repository.list("receipt-metadata");
      expect(rows).toHaveLength(1);
      const receipt = rows[0].value as { image: { blobId: string } };
      expect(await setupResult.repository.getBlob(receipt.image.blobId)).not.toBeNull();
      return Response.json(extraction);
    });
    const setupResult = await setup(fetchImpl);
    const receipt = await setupResult.service.saveImage(pngBlob());
    await setupResult.service.analyze(receipt.id);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("remembers checked read warnings until the receipt is read again", async () => {
    const warned = { ...extraction, warnings: [
      { field: "purchasedDate", code: "missing", message: "購入日が印字されていません。" },
      { field: "totalAmountYen", code: "check", message: "合計金額を確認してください。" },
    ] };
    const fetchImpl = vi.fn(async () => Response.json(warned));
    const { service } = await setup(fetchImpl);
    const receipt = await service.saveImage(pngBlob());
    await service.analyze(receipt.id);
    await service.markWarningsReviewed(receipt.id, [1, 1, 7, -1]);
    expect((await service.get(receipt.id))?.reviewedWarnings).toEqual([1]);
    await service.markWarningsReviewed(receipt.id, [0]);
    expect((await service.get(receipt.id))?.reviewedWarnings).toEqual([0, 1]);
    await service.analyze(receipt.id);
    expect((await service.get(receipt.id))?.reviewedWarnings).toBeUndefined();
  });

  it("registers a receipt paid entirely with points as one 0 yen expense in the overall category", async () => {
    const fetchImpl = vi.fn(async () => Response.json(extraction));
    const { ledger, service } = await setup(fetchImpl);
    const receipt = await service.saveImage(pngBlob());
    await service.confirm(receipt.id, { merchant: "Synthetic Net Market", purchasedDate: "2026-09-30", purchasedTime: null, totalAmountYen: 0,
      categoryId: "actual-food", accountId: "cash",
      items: [{ id: "item-1", name: "Synthetic Rice", amountYen: 400, categoryId: "actual-food" }, { id: "item-2", name: "Synthetic Soap", amountYen: 300, categoryId: "actual-household" }],
      adjustments: [{ id: "adjustment-1", label: "ポイント利用", amountYen: -700, targetItemId: null }] });
    await service.register(receipt.id);
    expect(ledger.importReceipt).toHaveBeenCalledWith(expect.objectContaining({ amountYen: 0, categoryId: "actual-food" }));
    expect((ledger.importReceipt.mock.calls[0] as unknown[])[0]).not.toHaveProperty("splits");
  });

  it("keeps a valid image larger than the AI gateway limit locally for manual entry", async () => {
    const fetchImpl = vi.fn();
    const { repository, service } = await setup(fetchImpl);
    const bytes = new Uint8Array(7 * 1024 * 1024);
    bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    const receipt = await service.saveImage(new Blob([bytes], { type: "image/png" }));
    expect(receipt.image?.sizeBytes).toBe(bytes.byteLength);
    await expect(service.analyze(receipt.id)).rejects.toMatchObject({ code: "image_too_large" });
    expect(await repository.getBlob(receipt.image!.blobId)).not.toBeNull();
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("sends the minimum Jev payload and validates its category choice before storing it", async () => {
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(Response.json(extraction))
      .mockResolvedValueOnce(Response.json({ model: "jev-latest", answers: { item_0: { type: "choice", choice: "actual-food", probabilities, confidence: 0.92 } } }));
    const { service } = await setup(fetchImpl);
    const receipt = await service.saveImage(pngBlob());
    await service.analyze(receipt.id);
    expect(await service.suggestCategory(receipt.id)).toBe("actual-food");
    const body = JSON.parse(String(fetchImpl.mock.calls[1][0] && (fetchImpl.mock.calls[1][1] as RequestInit).body));
    expect(body).toEqual({ flowId: (await service.get(receipt.id))?.aiFlowId, itemIndexes: [0], categories: [
      { id: "actual-food", name: "食費" }, { id: "actual-medical", name: "医療" }, { id: "actual-household", name: "日用品" },
    ], receipt: { merchant: "Synthetic Shop", totalAmountYen: 3284, items: [{ name: "Synthetic Item", amountYen: 3284 }] } });
    expect((await service.get(receipt.id))?.confirmedValue).toBeNull();
    const imageBody = JSON.parse(String((fetchImpl.mock.calls[0][1] as RequestInit).body));
    expect(body.flowId).toBe(imageBody.flowId);
  });

  it.each(["current", "legacy"])("reuses a %s saved category suggestion after reopening without requesting the spent flow", async (format) => {
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(Response.json(extraction))
      .mockResolvedValueOnce(Response.json({ model: "jev-latest", answers: { item_0: { type: "choice", choice: "actual-food", probabilities, confidence: 0.92 } } }))
      .mockResolvedValueOnce(Response.json({ error: "invalid_flow" }, { status: 409 }));
    const { repository, ledger, service } = await setup(fetchImpl);
    const receipt = await service.saveImage(pngBlob());
    await service.analyze(receipt.id);
    expect(await service.suggestCategory(receipt.id)).toBe("actual-food");
    if (format === "legacy") {
      const saved = (await service.get(receipt.id))!;
      delete saved.aiSuggestion.flowId;
      await repository.put({ id: saved.id, kind: "receipt-metadata", value: saved, updatedAt: saved.updatedAt });
    }
    const reopened = new LocalReceiptService(repository, ledger as never, {
      fetchImpl, getToken: async () => "synthetic-token",
      withRegistrationLock: async (_id, operation) => operation(),
    });
    expect(await reopened.suggestCategory(receipt.id)).toBe("actual-food");
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("prioritizes current learned item rules over a cached Jev answer", async () => {
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(Response.json(extraction))
      .mockResolvedValueOnce(Response.json({ model: "jev-latest", answers: { item_0: { type: "choice", choice: "actual-food", probabilities, confidence: 0.92 } } }));
    let nextId = 1;
    const { service } = await setup(fetchImpl, {}, { makeId: () => `00000000-0000-4000-8000-${String(nextId++).padStart(12, "0")}` });
    const receipt = await service.saveImage(pngBlob());
    await service.analyze(receipt.id);
    expect(await service.suggestCategory(receipt.id)).toBe("actual-food");
    for (let index = 0; index < 3; index++) {
      const confirmed = await service.createManual();
      await service.confirm(confirmed.id, {
        merchant: "Synthetic Shop", purchasedDate: "2026-09-30", purchasedTime: null,
        totalAmountYen: 3284, categoryId: "actual-medical", accountId: "cash",
        items: [{ id: `item-${index}`, name: "Synthetic Item", amountYen: 3284, categoryId: "actual-medical" }],
      });
    }
    expect(await service.suggestCategory(receipt.id)).toBe("actual-medical");
    expect((await service.get(receipt.id))?.classificationAttempt?.itemCategories).toEqual(["actual-food"]);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("sends only unresolved original item indexes and merges Jev answers with learned item categories", async () => {
    const multiItemExtraction = { ...extraction, items: [{ name: "Known apple", amountYen: 2000 }, { name: "Unknown soap", amountYen: 1284 }] };
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(Response.json(multiItemExtraction))
      .mockResolvedValueOnce(Response.json({ model: "jev-latest", answers: { item_1: { type: "choice", choice: "actual-food", probabilities, confidence: 0.92 } } }));
    let nextId = 10;
    const { service } = await setup(fetchImpl, {}, { makeId: () => `00000000-0000-4000-8000-${String(nextId++).padStart(12, "0")}` });
    for (let index = 0; index < 3; index++) {
      const confirmed = await service.createManual();
      await service.confirm(confirmed.id, {
        merchant: `Synthetic Shop ${index}`, purchasedDate: "2026-09-30", purchasedTime: null,
        totalAmountYen: 2000, categoryId: "actual-medical", accountId: "cash",
        items: [{ id: `known-${index}`, name: "Known apple", amountYen: 2000, categoryId: "actual-medical" }],
      });
    }
    const receipt = await service.saveImage(pngBlob());
    await service.analyze(receipt.id);
    expect(await service.suggestCategory(receipt.id)).toBe("actual-medical");
    expect((await service.get(receipt.id))?.itemCategories).toEqual(["actual-medical", "actual-food"]);
    const body = JSON.parse(String((fetchImpl.mock.calls[1][1] as RequestInit).body));
    expect(body.itemIndexes).toEqual([1]);
    expect(body.receipt.items).toEqual(multiItemExtraction.items);
  });

  it("prefers a saved merchant mapping without calling Jev", async () => {
    const fetchImpl = vi.fn(async () => Response.json({ ...extraction, items: [] }));
    const { repository, service } = await setup(fetchImpl);
    await repository.put({ id: "mapping:shop", kind: "merchant-mapping", value: { normalizedMerchant: "synthetic shop", categoryId: "food" }, updatedAt: "2026-09-30T00:00:00.000Z" });
    const receipt = await service.saveImage(pngBlob());
    await service.analyze(receipt.id);
    expect(await service.suggestCategory(receipt.id)).toBe("actual-food");
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect((await service.get(receipt.id))?.aiSuggestion.source).toBe("merchant_mapping");
  });

  it("uses a manual receipt's confirmed merchant mapping without requiring an extraction", async () => {
    const fetchImpl = vi.fn();
    const { service } = await setup(fetchImpl, { listExpenseCategories: vi.fn(async () => [{ id: "actual-custom", name: "自由カテゴリ" }]) });
    const receipt = await service.createManual();
    await service.confirm(receipt.id, { merchant: "Synthetic Shop", purchasedDate: "2026-09-30", purchasedTime: null, totalAmountYen: 200, categoryId: "actual-custom", accountId: "cash" });
    expect(await service.suggestCategory(receipt.id)).toBe("actual-custom");
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("rejects unexpected merchant-level answer keys without saving the response", async () => {
    const answer = { type: "choice", choice: "actual-food", probabilities, confidence: 0.92 };
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(Response.json({ ...extraction, items: [] }))
      .mockResolvedValueOnce(Response.json({ model: "jev-latest", answers: { category: answer, item_0: answer } }));
    const { service } = await setup(fetchImpl);
    const receipt = await service.saveImage(pngBlob());
    await service.analyze(receipt.id);
    await expect(service.suggestCategory(receipt.id)).rejects.toMatchObject({ code: "invalid_ai_response" });
    expect((await service.get(receipt.id))?.classificationAttempt).toBeUndefined();
    expect((await service.get(receipt.id))?.aiSuggestion.categoryId).toBeNull();
  });

  it("invalidates a merchant mapping to a deleted custom category and asks Jev without item indexes", async () => {
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(Response.json({ ...extraction, items: [] }))
      .mockResolvedValueOnce(Response.json({ model: "jev-latest", answers: { category: { type: "choice", choice: "actual-food", probabilities, confidence: 0.92 } } }));
    const { repository, service } = await setup(fetchImpl);
    await repository.put({ id: "mapping:removed", kind: "merchant-mapping", value: { normalizedMerchant: "synthetic shop", actualCategoryId: "removed-category" }, updatedAt: "2026-09-30T00:00:00.000Z" });
    const receipt = await service.saveImage(pngBlob());
    await service.analyze(receipt.id);
    expect(await service.suggestCategory(receipt.id)).toBe("actual-food");
    expect(await repository.get("mapping:removed")).toBeNull();
    expect((await service.get(receipt.id))?.aiSuggestion.categoryId).toBe("actual-food");
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    const request = JSON.parse(String((fetchImpl.mock.calls[1][1] as RequestInit).body));
    expect(request).not.toHaveProperty("itemIndexes");
  });

  it("requires reselection when a confirmed custom category is no longer available", async () => {
    const { service } = await setup();
    const receipt = await service.createManual();
    await service.confirm(receipt.id, { merchant: "Synthetic Shop", purchasedDate: "2026-09-30", purchasedTime: null, totalAmountYen: 200, categoryId: "removed-category", accountId: "cash" });
    expect(await service.suggestCategory(receipt.id)).toBeNull();
    await expect(service.register(receipt.id)).rejects.toMatchObject({ code: "category_unavailable" });
    expect((await service.get(receipt.id))?.registration.status).toBe("pending");
    await service.confirm(receipt.id, { merchant: "Synthetic Shop", purchasedDate: "2026-09-30", purchasedTime: null, totalAmountYen: 200, categoryId: "actual-food", accountId: "cash" });
    await expect(service.register(receipt.id)).resolves.toMatchObject({ registration: { status: "applied" } });
  });

  it("falls back to Jev when no merchant mapping exists, and reports no category when Jev is uncertain", async () => {
    const lowProbabilities = { "actual-food": 0.4, "actual-medical": 0.35, "actual-household": 0.25 };
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(Response.json(extraction))
      .mockResolvedValueOnce(Response.json({ model: "jev-latest", answers: { item_0: { type: "choice", choice: "actual-food", probabilities: lowProbabilities, confidence: 0.4 } } }));
    const { service } = await setup(fetchImpl);
    const receipt = await service.saveImage(pngBlob());
    await service.analyze(receipt.id);
    expect(await service.suggestCategory(receipt.id)).toBeNull();
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect((await service.get(receipt.id))?.aiSuggestion).toMatchObject({ categoryId: null, source: "unclassified" });
    expect(await service.suggestCategory(receipt.id)).toBeNull();
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("discards a previous suggestion when new receipt facts are extracted", async () => {
    const answer = (choice: string) => ({ model: "jev-latest", answers: { item_0: { type: "choice", choice, probabilities: Object.fromEntries(["actual-food", "actual-medical", "actual-household"].map(id => [id, id === choice ? 0.92 : 0.04])), confidence: 0.92 } } });
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(Response.json(extraction))
      .mockResolvedValueOnce(Response.json(answer("actual-food")))
      .mockResolvedValueOnce(Response.json({ ...extraction, merchant: "Synthetic Pharmacy" }))
      .mockResolvedValueOnce(Response.json(answer("actual-medical")));
    const { service } = await setup(fetchImpl);
    const receipt = await service.saveImage(pngBlob());
    await service.analyze(receipt.id);
    expect(await service.suggestCategory(receipt.id)).toBe("actual-food");
    await service.confirm(receipt.id, { merchant: "Synthetic Shop", purchasedDate: "2026-09-30", purchasedTime: null, totalAmountYen: 3284, categoryId: "food", accountId: "cash" });
    await service.analyze(receipt.id);
    expect(await service.suggestCategory(receipt.id)).toBe("actual-medical");
    expect(fetchImpl).toHaveBeenCalledTimes(4);
  });

  it("retains confirmed values after a later analysis pass", async () => {
    const fetchImpl = vi.fn(async () => Response.json(extraction));
    const { service } = await setup(fetchImpl);
    const receipt = await service.saveImage(pngBlob());
    await service.analyze(receipt.id);
    const confirmed = await service.confirm(receipt.id, { merchant: "Corrected Shop", purchasedDate: "2026-09-29", purchasedTime: null, totalAmountYen: 100, categoryId: "food", accountId: "cash" });
    const reanalyzed = await service.analyze(receipt.id);
    expect(reanalyzed.confirmedValue).toEqual(confirmed.confirmedValue);
    expect(reanalyzed.aiFlowId).not.toBe(confirmed.aiFlowId);
  });

  it("rejects impossible dates and empty Actual category/account IDs without persisting a confirmation", async () => {
    const { service } = await setup();
    const receipt = await service.createManual();
    for (const patch of [
      { purchasedDate: "2026-02-30" },
      { purchasedDate: "2026-13-01" },
      { categoryId: "" },
      { accountId: "" },
      { totalAmountYen: 0 },
    ]) {
      await expect(service.confirm(receipt.id, {
        merchant: "Synthetic Shop", purchasedDate: "2026-09-30", purchasedTime: null,
        totalAmountYen: 100, categoryId: "actual-food", accountId: "cash", ...patch,
      })).rejects.toMatchObject({ code: "invalid_confirmation" });
    }
    expect((await service.get(receipt.id))?.confirmedValue).toBeNull();
  });

  it("uses a stable imported ID and updates registration state across retries", async () => {
    const { service, ledger } = await setup(vi.fn(), { importReceipt: vi.fn(async () => ({ id: "actual-tx" })) });
    const receipt = await service.createManual();
    await service.confirm(receipt.id, { merchant: "Synthetic Shop", purchasedDate: "2026-09-30", purchasedTime: null, totalAmountYen: 3284, categoryId: "food", accountId: "cash" });
    const registered = await service.register(receipt.id);
    expect(registered.registration).toEqual({ status: "applied", actualTransactionId: "actual-tx", lastError: null });
    expect(ledger.importReceipt).toHaveBeenCalledWith(expect.objectContaining({ importedId: `kakeimatch:${receipt.id}`, amountYen: -3284, categoryId: "actual-food" }));
    expect(await service.register(receipt.id)).toEqual(registered);
    expect(ledger.importReceipt).toHaveBeenCalledTimes(1);
    await expect(service.confirm(receipt.id, { merchant: "Changed", purchasedDate: "2026-09-30", purchasedTime: null, totalAmountYen: 10, categoryId: "food", accountId: "cash" })).rejects.toMatchObject({ code: "registration_locked" });
  });

  it("marks a failed Actual write and retries with the same idempotency ID", async () => {
    const importReceipt = vi.fn()
      .mockRejectedValueOnce(new Error("private Actual details"))
      .mockResolvedValueOnce({ id: "actual-recovered" });
    const { service } = await setup(vi.fn(), { importReceipt });
    const receipt = await service.createManual();
    const confirmed = { merchant: "Synthetic Shop", purchasedDate: "2026-09-30", purchasedTime: null, totalAmountYen: 3284, categoryId: "food", accountId: "cash" };
    await service.confirm(receipt.id, confirmed);
    await expect(service.register(receipt.id)).rejects.toMatchObject({ code: "unavailable" });
    expect((await service.get(receipt.id))?.registration).toMatchObject({ status: "failed", actualTransactionId: null });
    await expect(service.confirm(receipt.id, { ...confirmed, totalAmountYen: 111 })).rejects.toMatchObject({ code: "registration_locked" });
    const retried = await service.register(receipt.id);
    expect(retried.registration).toMatchObject({ status: "applied", actualTransactionId: "actual-recovered" });
    const importedIds = importReceipt.mock.calls.map(([input]) => input.importedId);
    expect(importedIds).toEqual([`kakeimatch:${receipt.id}`, `kakeimatch:${receipt.id}`]);
  });

  it("serializes concurrent registrations for the same receipt", async () => {
    let inLock: Promise<unknown> = Promise.resolve();
    let lockCalls = 0;
    const withRegistrationLock = async <T>(_id: string, operation: () => Promise<T>): Promise<T> => {
      lockCalls += 1;
      const prior = inLock;
      let release!: () => void;
      inLock = new Promise<void>((resolve) => { release = resolve; });
      await prior;
      try { return await operation(); } finally { release(); }
    };
    const importReceipt = vi.fn(async () => ({ id: "actual-once" }));
    const repository = await LocalDataRepository.open(crypto.randomUUID());
    const ledger = { listOpenAccounts: vi.fn(async () => [{ id: "cash", name: "現金" }]), listExpenseCategories: vi.fn(async () => [{ id: "actual-food", name: "食費" }]), importReceipt };
    const service = new LocalReceiptService(repository, ledger as never, {
      withRegistrationLock,
      now: () => new Date("2026-09-30T00:00:00.000Z"),
      makeId: () => "00000000-0000-4000-8000-000000000002",
    });
    const receipt = await service.createManual();
    await service.confirm(receipt.id, { merchant: "Synthetic Shop", purchasedDate: "2026-09-30", purchasedTime: null, totalAmountYen: 10, categoryId: "food", accountId: "cash" });
    const results = await Promise.all([service.register(receipt.id), service.register(receipt.id)]);
    expect(results.map(({ registration }) => registration.status)).toEqual(["applied", "applied"]);
    expect(importReceipt).toHaveBeenCalledTimes(1);
    expect(lockCalls).toBe(3);
  });

  it("maps quota and malformed AI responses to safe errors", async () => {
    const quotaFetch = vi.fn(async () => Response.json({ error: "ai_quota_exceeded" }, { status: 429 }));
    const { service, repository } = await setup(quotaFetch);
    const receipt = await service.saveImage(pngBlob());
    await expect(service.analyze(receipt.id)).rejects.toMatchObject({ code: "quota" });
    expect((await service.get(receipt.id))?.extraction).toBeNull();
    expect(await repository.getBlob(receipt.image!.blobId)).not.toBeNull();

    const badFetch = vi.fn(async () => Response.json({ unexpected: true }));
    const bad = await setup(badFetch);
    const badReceipt = await bad.service.saveImage(pngBlob());
    await expect(bad.service.analyze(badReceipt.id)).rejects.toMatchObject({ code: "invalid_ai_response" });
  });

  it.each([
    ["offline", async () => { throw new TypeError("network down"); }, "offline_or_unavailable"],
    ["provider unavailable", async () => Response.json({ error: "provider_unavailable" }, { status: 503 }), "offline_or_unavailable"],
    ["authentication required", async () => Response.json({ error: "unauthorized" }, { status: 401 }), "auth_required"],
    ["schema invalid", async () => Response.json({ ...extraction, totalAmountYen: 1.5 }), "invalid_ai_response"],
  ])("keeps the image available after %s", async (_name, respond, code) => {
    const fetchImpl = vi.fn(respond as () => Promise<Response>);
    const { service, repository } = await setup(fetchImpl);
    const receipt = await service.saveImage(pngBlob());
    await expect(service.analyze(receipt.id)).rejects.toMatchObject({ code });
    const saved = await service.get(receipt.id);
    expect(saved).not.toBeNull();
    expect(saved?.extraction).toBeNull();
    expect(saved?.registration.status).toBe("pending");
    expect(new Uint8Array(await (await repository.getBlob(receipt.image!.blobId))!.blob.arrayBuffer())).toEqual(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1]));
  });

  it.each([
    ["a paused AI", { error: "ai_temporarily_paused" }, true],
    ["an unavailable provider", { error: "provider_unavailable" }, false],
  ])("tells whether trying again at once can help after %s", async (_name, body, retryAfterWait) => {
    const { service } = await setup(vi.fn(async () => Response.json(body, { status: 503 })));
    const receipt = await service.saveImage(pngBlob());
    await expect(service.analyze(receipt.id)).rejects.toMatchObject({ code: "offline_or_unavailable", retryAfterWait });
  });

  it("offers manual registration after an expired category flow", async () => {
    const fetchImpl = vi.fn().mockResolvedValueOnce(Response.json(extraction)).mockResolvedValueOnce(Response.json({ error: "invalid_flow" }, { status: 409 }));
    const { service, ledger } = await setup(fetchImpl);
    const receipt = await service.saveImage(pngBlob());
    await service.analyze(receipt.id);
    await expect(service.suggestCategory(receipt.id)).rejects.toMatchObject({ code: "invalid_flow" });
    await service.confirm(receipt.id, { merchant: "Manual Shop", purchasedDate: "2026-09-30", purchasedTime: null, totalAmountYen: 500, categoryId: "food", accountId: "cash" });
    expect((await service.register(receipt.id)).registration.status).toBe("applied");
    expect(ledger.importReceipt).toHaveBeenCalledOnce();
  });

  it("rejects a category response with missing confidence without storing a suggestion", async () => {
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(Response.json(extraction))
      .mockResolvedValueOnce(Response.json({ model: "jev-latest", answers: { item_0: { type: "choice", choice: "actual-food", probabilities } } }));
    const { service } = await setup(fetchImpl);
    const receipt = await service.saveImage(pngBlob());
    await service.analyze(receipt.id);
    await expect(service.suggestCategory(receipt.id)).rejects.toMatchObject({ code: "invalid_ai_response" });
    expect((await service.get(receipt.id))?.aiSuggestion).toMatchObject({ categoryId: null, source: "unclassified" });
  });
});


describe("receipt category allocations", () => {
  const value: ConfirmedReceiptValue = { merchant: "Synthetic", purchasedDate: "2026-09-30", purchasedTime: null, totalAmountYen: 1400, categoryId: "food", accountId: "cash", items: [
    { id: "a", name: "Synthetic apple", amountYen: 1000, categoryId: "food" },
    { id: "b", name: "Synthetic soap", amountYen: 500, categoryId: "household" },
  ], adjustments: [{ id: "discount", label: "値引き", amountYen: -100, targetItemId: "a" }] };
  it("aggregates a targeted discount into its category and keeps the printed total", () => {
    expect(receiptAllocations(value)).toEqual([{ categoryId: "food", amountYen: 900 }, { categoryId: "household", amountYen: 500 }]);
  });
  it("registers multiple categories when items plus external tax match the total", async () => {
    const { service, ledger } = await setup();
    const receipt = await service.saveImage(pngBlob());
    await service.confirm(receipt.id, { ...value, totalAmountYen: 1540, taxAmountYen: 140 });
    await service.register(receipt.id);
    expect(ledger.importReceipt).toHaveBeenCalledWith(expect.objectContaining({
      amountYen: -1540,
      splits: [{ categoryId: "actual-food", amountYen: -990 }, { categoryId: "actual-household", amountYen: -550 }],
    }));
  });
  it("does not add inclusive tax a second time", () => {
    expect(receiptAllocations({ ...value, taxAmountYen: 140 })).toEqual([
      { categoryId: "food", amountYen: 900 }, { categoryId: "household", amountYen: 500 },
    ]);
  });
  it("distributes tax rounding by largest remainder with stable ties", () => {
    const items = [
      { id: "a", name: "Synthetic A", amountYen: 1, categoryId: "food" },
      { id: "b", name: "Synthetic B", amountYen: 2, categoryId: "household" },
    ];
    expect(receiptAllocations({ ...value, items, adjustments: [], totalAmountYen: 4, taxAmountYen: 1 })).toEqual([
      { categoryId: "food", amountYen: 1 }, { categoryId: "household", amountYen: 3 },
    ]);
    expect(receiptAllocations({ ...value, items: items.map(item => ({ ...item, amountYen: 1 })), adjustments: [], totalAmountYen: 3, taxAmountYen: 1 })).toEqual([
      { categoryId: "food", amountYen: 2 }, { categoryId: "household", amountYen: 1 },
    ]);
  });
  it("keeps large yen products exact and excludes a fully discounted category", () => {
    const largeValue = { ...value, items: [
      { id: "a", name: "Synthetic A", amountYen: 4_000_000_000, categoryId: "food" },
      { id: "b", name: "Synthetic B", amountYen: 2_000_000_000, categoryId: "household" },
    ], adjustments: [], totalAmountYen: 6_600_000_000, taxAmountYen: 600_000_000 };
    expect(receiptAllocations(largeValue)).toEqual([
      { categoryId: "food", amountYen: 4_400_000_000 }, { categoryId: "household", amountYen: 2_200_000_000 },
    ]);
    expect(receiptAllocations({ ...value, adjustments: [{ id: "d", label: "値引き", amountYen: -1000, targetItemId: "a" }], totalAmountYen: 550, taxAmountYen: 50 })).toEqual([
      { categoryId: "household", amountYen: 550 },
    ]);
  });
  it("rejects a gap that tax cannot explain and a discount without a target", () => {
    expect(() => receiptAllocations({ ...value, totalAmountYen: 1541, taxAmountYen: 140 })).toThrow(/カテゴリ配分/);
    expect(() => receiptAllocations({ ...value, totalAmountYen: 1540, taxAmountYen: 140, adjustments: [{ id: "d", label: "値引き", amountYen: -100 }] })).toThrow(/カテゴリ配分/);
  });
  it("requires confirmation for an unattributed discount or a total mismatch", () => {
    expect(() => receiptAllocations({ ...value, adjustments: [{ id: "d", label: "クーポン", amountYen: -100 }] })).toThrow(/カテゴリ配分/);
    expect(() => receiptAllocations({ ...value, totalAmountYen: 1500 })).toThrow(/カテゴリ配分/);
    expect(() => receiptAllocations({ ...value, items: value.items!.map(item => ({ ...item, amountYen: null })) })).toThrow(/カテゴリ配分/);
  });
  it("uses the printed total for a single category despite line uncertainty", () => {
    expect(receiptAllocations({ ...value, items: [{ id: "a", name: "Synthetic", amountYen: null, categoryId: null }] })).toEqual([{ categoryId: "food", amountYen: 1400 }]);
  });
  it("saves confirmed detail and sends one split per category", async () => {
    const { service, ledger } = await setup(vi.fn(), { listExpenseCategories: async () => [{ id: "actual-food", name: "食費" }, { id: "actual-household", name: "日用品" }] });
    const receipt = await service.createManual();
    await service.confirm(receipt.id, value);
    await service.register(receipt.id);
    expect((await service.get(receipt.id))?.confirmedValue?.items).toEqual(value.items);
    expect(ledger.importReceipt).toHaveBeenCalledWith(expect.objectContaining({ amountYen: -1400, splits: [{ categoryId: "actual-food", amountYen: -900 }, { categoryId: "actual-household", amountYen: -500 }] }));
  });
  it("registers image-free expense details and edits the same linked transaction with a memo", async () => {
    const editReceipt = vi.fn(async () => ({ id: "actual-tx" }));
    const { service, ledger } = await setup(vi.fn(), { editReceipt });
    const receipt = await service.createManual();
    await service.confirm(receipt.id, { ...value, memo: "Synthetic memo" });
    const registered = await service.register(receipt.id);
    expect(registered.image).toBeNull();
    expect(ledger.importReceipt).toHaveBeenCalledWith(expect.objectContaining({ memo: "Synthetic memo", importedId: `kakeimatch:${receipt.id}` }));
    const edited = await service.edit(receipt.id, { ...value, memo: "Synthetic edited memo" }, registered.updatedAt);
    expect(edited.registration.actualTransactionId).toBe("actual-tx");
    expect(editReceipt).toHaveBeenCalledWith("actual-tx", expect.objectContaining({ memo: "Synthetic edited memo", importedId: `kakeimatch:${receipt.id}` }));
    expect(edited.confirmedValue?.adjustments?.[0].amountYen).toBe(-100);
  });
  it("keeps an unsafe allocation pending and editable without writing to Actual", async () => {
    const { service, ledger } = await setup();
    const receipt = await service.createManual();
    await service.confirm(receipt.id, { ...value, totalAmountYen: 1500 });
    await expect(service.register(receipt.id)).rejects.toMatchObject({ code: "allocation_required" });
    expect(ledger.importReceipt).not.toHaveBeenCalled();
    expect((await service.get(receipt.id))?.registration.status).toBe("pending");
  });
  it("does not re-register a locally deleted receipt", async () => {
    const { repository, service, ledger } = await setup();
    const receipt = await service.createManual();
    await service.confirm(receipt.id, { merchant: "Synthetic", purchasedDate: "2026-09-30", purchasedTime: null, totalAmountYen: 1000, categoryId: "actual-food", accountId: "cash" });
    const deleted = { ...(await service.get(receipt.id))!, registration: { status: "deleted" as const, actualTransactionId: "actual-old", lastError: null } };
    await repository.put({ id: receipt.id, kind: "receipt-metadata", value: deleted, updatedAt: deleted.updatedAt });
    await expect(service.register(receipt.id)).rejects.toMatchObject({ code: "registration_locked" });
    expect(ledger.importReceipt).not.toHaveBeenCalled();
  });
  it("rejects duplicate detail IDs and dangling discount targets", async () => {
    const { service } = await setup();
    const receipt = await service.createManual();
    await expect(service.confirm(receipt.id, { ...value, adjustments: [{ id: "d", label: "値引き", amountYen: -100, targetItemId: "missing" }] })).rejects.toMatchObject({ code: "invalid_confirmation" });
    await expect(service.confirm(receipt.id, { ...value, items: [value.items![0], value.items![0]] })).rejects.toMatchObject({ code: "invalid_confirmation" });
  });
});

describe("registered receipt edits", () => {
  const original: ConfirmedReceiptValue = { merchant: "Synthetic Shop", purchasedDate: "2026-09-30", purchasedTime: null, totalAmountYen: 3284, categoryId: "actual-food", accountId: "cash" };
  const changed: ConfirmedReceiptValue = { ...original, merchant: "Synthetic Shop Updated", totalAmountYen: 3400 };
  type EditInput = { accountId: string; date: string; amountYen: number; merchant: string; categoryId: string; importedId: string; splits?: Array<{ categoryId: string; amountYen: number }> };

  async function registeredReceipt(overrides: Record<string, unknown> = {}) {
    const { repository, ledger, service } = await setup(vi.fn(), overrides);
    const receipt = await service.createManual();
    await service.confirm(receipt.id, original);
    await service.register(receipt.id);
    return { repository, ledger, service, receipt: (await service.get(receipt.id))! };
  }

  it("validates edit values and stale editor timestamps before writing an intent or Actual", async () => {
    const editReceipt = vi.fn<(id: string, input: EditInput) => Promise<{ id: string }>>(async () => ({ id: "actual-tx" }));
    const { repository, service, receipt } = await registeredReceipt({ editReceipt });
    await expect(service.edit(receipt.id, { ...changed, totalAmountYen: 0 }, receipt.updatedAt)).rejects.toMatchObject({ code: "invalid_confirmation" });
    await expect(service.edit(receipt.id, changed, "stale" )).rejects.toMatchObject({ code: "receipt_changed" });
    expect(editReceipt).not.toHaveBeenCalled();
    expect(await repository.get(`receipt-correction:${receipt.id}`)).toBeNull();
  });

  it("keeps the original confirmed value and pending audit when Actual readback fails, then retries the same intent", async () => {
    const editReceipt = vi.fn<(id: string, input: EditInput) => Promise<{ id: string }>>(async () => ({ id: "actual-tx" }));
    editReceipt.mockResolvedValueOnce({ id: "wrong-transaction" }).mockResolvedValueOnce({ id: "actual-tx" });
    const { repository, ledger, service, receipt } = await registeredReceipt({ editReceipt });
    await expect(service.edit(receipt.id, changed, receipt.updatedAt)).rejects.toMatchObject({ code: "edit_readback_failed" });
    expect((await service.get(receipt.id))?.confirmedValue).toEqual(original);
    const pending = await service.getPendingEdit(receipt.id);
    expect(pending).toMatchObject({ before: original, after: changed, status: "pending" });
    const recoveredService = new LocalReceiptService(repository, ledger as never, { withRegistrationLock: async (_id, operation) => operation() });
    await recoveredService.edit(receipt.id, original, "stale");
    expect(editReceipt).toHaveBeenCalledTimes(2);
    expect(editReceipt.mock.calls[0][0]).toBe("actual-tx");
    expect(editReceipt.mock.calls[0][1]).toEqual(editReceipt.mock.calls[1][1]);
    expect((await recoveredService.get(receipt.id))?.confirmedValue).toEqual(changed);
    expect(await recoveredService.getPendingEdit(receipt.id)).toBeNull();
    expect(await repository.get(`receipt-correction:${receipt.id}:${pending!.operationId}`)).toMatchObject({ value: { status: "applied", after: changed } });
  });

  it("atomically commits receipt metadata and applied audit, and retries idempotently after local commit failure", async () => {
    const editReceipt = vi.fn<(id: string, input: EditInput) => Promise<{ id: string }>>(async () => ({ id: "actual-tx" }));
    const { repository, ledger, service, receipt } = await registeredReceipt({ editReceipt });
    const putRecords = repository.putRecords.bind(repository);
    let fail = true;
    vi.spyOn(repository, "putRecords").mockImplementation(async records => {
      if (fail) { fail = false; throw new Error("synthetic commit failure"); }
      return putRecords(records);
    });
    await expect(service.edit(receipt.id, changed, receipt.updatedAt)).rejects.toBeDefined();
    expect((await service.get(receipt.id))?.confirmedValue).toEqual(original);
    expect(await service.getPendingEdit(receipt.id)).toMatchObject({ status: "pending", after: changed });
    const recoveredService = new LocalReceiptService(repository, ledger as never, { withRegistrationLock: async (_id, operation) => operation() });
    await recoveredService.edit(receipt.id, changed, receipt.updatedAt);
    expect(editReceipt).toHaveBeenCalledTimes(2);
    expect(editReceipt.mock.calls[0][1]).toEqual(editReceipt.mock.calls[1][1]);
    expect((await recoveredService.get(receipt.id))?.confirmedValue).toEqual(changed);
    const audit = await repository.get<{ status: string; before: ConfirmedReceiptValue; after: ConfirmedReceiptValue }>(`receipt-correction:${receipt.id}:${(await repository.get<{ operationId: string }>(`receipt-correction:${receipt.id}`))!.value.operationId}`);
    expect(audit?.value).toMatchObject({ status: "applied", before: original, after: changed });
  });
});

it("classifies each item in one request and leaves uncertain items for manual selection", async () => {
  const strong = { type: "choice", choice: "actual-food", probabilities, confidence: 0.92 };
  const weak = { type: "choice", choice: "actual-food", probabilities: { "actual-food": 0.4, "actual-medical": 0.35, "actual-household": 0.25 }, confidence: 0.4 };
  const fetchImpl = vi.fn().mockResolvedValueOnce(Response.json({ ...extraction, items: [{ name: "Synthetic apple", amountYen: 2000 }, { name: "Synthetic soap", amountYen: 1284 }] })).mockResolvedValueOnce(Response.json({ model: "synthetic-model", answers: { item_0: strong, item_1: weak } }));
  const { service } = await setup(fetchImpl);
  const receipt = await service.saveImage(pngBlob());
  await service.analyze(receipt.id);
  await service.suggestCategory(receipt.id);
  expect((await service.get(receipt.id))?.itemCategories).toEqual(["actual-food", null]);
  await service.suggestCategory(receipt.id);
  expect(fetchImpl).toHaveBeenCalledTimes(2);
});

it("retains raw extraction when item classification fails", async () => {
  const fetchImpl = vi.fn().mockResolvedValueOnce(Response.json(extraction)).mockResolvedValueOnce(Response.json({ error: "rate_limited" }, { status: 429 }));
  const { service, repository } = await setup(fetchImpl);
  const receipt = await service.saveImage(pngBlob());
  await service.analyze(receipt.id);
  await expect(service.suggestCategory(receipt.id)).rejects.toMatchObject({ code: "rate_limited" });
  expect((await service.get(receipt.id))?.extraction).toEqual(extraction);
  expect(await repository.get(`receipt-extraction:${receipt.id}`)).not.toBeNull();
  expect((await service.get(receipt.id))?.registration.status).toBe("pending");
});

describe("pending receipt deletion", () => {
  it("atomically removes only the receipt, extraction, draft, and its unshared image", async () => {
    const { repository, service } = await setup();
    const receipt = await service.saveImage(pngBlob());
    await repository.put({ id: `receipt-extraction:${receipt.id}`, kind: "receipt-extraction", value: { receiptId: receipt.id, extraction }, updatedAt: receipt.updatedAt });
    await repository.put({ id: `receipt-draft:${receipt.id}`, kind: "category-state", value: { merchant: "Synthetic draft" }, updatedAt: receipt.updatedAt });
    await repository.put({ id: `category-learning:${receipt.id}`, kind: "correction-audit", value: { targetType: "category-learning", receiptId: receipt.id }, updatedAt: receipt.updatedAt });
    await repository.put({ id: "merchant-mapping:synthetic-global", kind: "merchant-mapping", value: { normalizedMerchant: "shared history" }, updatedAt: receipt.updatedAt });
    const sibling = { ...receipt, id: "receipt:sibling", image: null, extraction: null };
    await repository.put({ id: sibling.id, kind: "receipt-metadata", value: sibling, updatedAt: sibling.updatedAt });
    await service.deletePending(receipt.id);
    expect(await service.get(receipt.id)).toBeNull();
    expect(await repository.get(`receipt-extraction:${receipt.id}`)).toBeNull();
    expect(await repository.get(`receipt-draft:${receipt.id}`)).toBeNull();
    expect(await repository.get(`category-learning:${receipt.id}`)).toBeNull();
    expect(await repository.get("merchant-mapping:synthetic-global")).not.toBeNull();
    expect(await repository.getBlob(receipt.image!.blobId)).toBeNull();
    expect(await service.get(sibling.id)).not.toBeNull();
  });

  it("transfers a shared image to its remaining receipt and keeps the backup valid", async () => {
    const { repository, service } = await setup();
    const receipt = await service.saveImage(pngBlob());
    const sibling = { ...receipt, id: "receipt:sibling" };
    await repository.put({ id: sibling.id, kind: "receipt-metadata", value: sibling, updatedAt: sibling.updatedAt });
    await service.deletePending(receipt.id);
    expect(await service.get(receipt.id)).toBeNull();
    expect((await repository.getBlob(receipt.image!.blobId))?.ownerId).toBe(sibling.id);
    await expect(createPortableBackup({ actualBackup: new Uint8Array([0x50, 0x4b, 0x03, 0x04]), localData: await repository.serialize() })).resolves.toBeInstanceOf(Blob);
  });

  it("refuses deletion when a non-receipt record refers to an owned image", async () => {
    const { repository, service } = await setup();
    const receipt = await service.saveImage(pngBlob());
    await repository.put({ id: "synthetic-other-reference", kind: "category-state", value: { nested: { blobId: receipt.image!.blobId } }, updatedAt: receipt.updatedAt });
    await expect(service.deletePending(receipt.id)).rejects.toBeDefined();
    expect(await service.get(receipt.id)).not.toBeNull();
    expect((await repository.getBlob(receipt.image!.blobId))?.ownerId).toBe(receipt.id);
  });

  it.each(["processing", "failed", "applied"] as const)("refuses to delete a receipt in %s state", async status => {
    const { repository, service } = await setup();
    const receipt = await service.saveImage(pngBlob());
    const value = { ...receipt, registration: { status, actualTransactionId: status === "applied" ? "actual-synthetic" : null, lastError: null } };
    await repository.put({ id: receipt.id, kind: "receipt-metadata", value, updatedAt: receipt.updatedAt });
    await expect(service.deletePending(receipt.id)).rejects.toMatchObject({ code: "receipt_not_deletable" });
    expect(await service.get(receipt.id)).not.toBeNull();
    expect(await repository.getBlob(receipt.image!.blobId)).not.toBeNull();
  });

  it("refuses deletion when Actual already contains the receipt import ID", async () => {
    const { repository, service } = await setup(vi.fn(), { getTransactions: vi.fn(async () => [{ importedId: "kakeimatch:receipt:00000000-0000-4000-8000-000000000001" }]) });
    const receipt = await service.saveImage(pngBlob());
    await service.confirm(receipt.id, { merchant: "Synthetic Shop", purchasedDate: "2026-09-30", purchasedTime: null, totalAmountYen: 100, categoryId: "actual-food", accountId: "cash" });
    await expect(service.deletePending(receipt.id)).rejects.toMatchObject({ code: "receipt_actual_data_exists" });
    expect(await service.get(receipt.id)).not.toBeNull();
    expect(await repository.getBlob(receipt.image!.blobId)).not.toBeNull();
  });

  it("keeps every item when the atomic local deletion fails", async () => {
    const { repository, service } = await setup();
    const receipt = await service.saveImage(pngBlob());
    await repository.put({ id: `receipt-extraction:${receipt.id}`, kind: "receipt-extraction", value: { receiptId: receipt.id, extraction }, updatedAt: receipt.updatedAt });
    await repository.put({ id: `receipt-draft:${receipt.id}`, kind: "category-state", value: { merchant: "Synthetic draft" }, updatedAt: receipt.updatedAt });
    await repository.put({ id: `category-learning:${receipt.id}`, kind: "correction-audit", value: { targetType: "category-learning", receiptId: receipt.id }, updatedAt: receipt.updatedAt });
    vi.spyOn(repository, "deleteReceiptData").mockRejectedValue(new Error("synthetic storage failure"));
    await expect(service.deletePending(receipt.id)).rejects.toMatchObject({ code: "unavailable" });
    expect(await service.get(receipt.id)).not.toBeNull();
    expect(await repository.get(`receipt-extraction:${receipt.id}`)).not.toBeNull();
    expect(await repository.get(`receipt-draft:${receipt.id}`)).not.toBeNull();
    expect(await repository.get(`category-learning:${receipt.id}`)).not.toBeNull();
    expect(await repository.getBlob(receipt.image!.blobId)).not.toBeNull();
  });

  it("waits for in-flight AI analysis and cannot recreate the deleted receipt", async () => {
    let releaseResponse!: (response: Response) => void;
    let requestStarted!: () => void;
    const started = new Promise<void>(resolve => { requestStarted = resolve; });
    const fetchImpl = vi.fn(() => { requestStarted(); return new Promise<Response>(resolve => { releaseResponse = resolve; }); });
    const tails = new Map<string, Promise<void>>();
    const withRegistrationLock = async <T>(id: string, operation: () => Promise<T>): Promise<T> => {
      const prior = tails.get(id) ?? Promise.resolve();
      let release!: () => void;
      const tail = new Promise<void>(resolve => { release = resolve; });
      tails.set(id, tail);
      await prior;
      try { return await operation(); } finally { release(); }
    };
    const { repository, service } = await setup(fetchImpl, {}, { withRegistrationLock });
    const receipt = await service.saveImage(pngBlob());
    const analysis = service.analyze(receipt.id);
    await started;
    const deletion = service.deletePending(receipt.id);
    releaseResponse(Response.json(extraction));
    await analysis;
    await deletion;
    expect(await service.get(receipt.id)).toBeNull();
    expect(await repository.get(`receipt-extraction:${receipt.id}`)).toBeNull();
    expect(await repository.getBlob(receipt.image!.blobId)).toBeNull();
  });
});
