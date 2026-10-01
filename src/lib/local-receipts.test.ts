import "fake-indexeddb/auto";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { LocalDataRepository } from "./local-data";
import { CATEGORY_IDS } from "./category";
import { LocalReceiptService, receiptAllocations, type ConfirmedReceiptValue } from "../../apps/pwa/src/local-receipts";

const extraction = {
  documentKind: "receipt", merchant: "Synthetic Shop", purchasedDate: "2026-09-30", purchasedTime: "12:30",
  totalAmountYen: 3284, taxAmountYen: null, items: [{ name: "Synthetic Item", amountYen: 3284 }], warnings: [],
};
const probabilities = Object.fromEntries(CATEGORY_IDS.map((id) => [id, id === "food" ? 0.92 : 0.01]));

function pngBlob() {
  return new Blob([new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1])], { type: "image/png" });
}
async function setup(fetchImpl = vi.fn(), ledgerOverrides: Record<string, unknown> = {}) {
  const repository = await LocalDataRepository.open(crypto.randomUUID());
  const ledger = {
    listOpenAccounts: vi.fn(async () => [{ id: "cash", name: "現金" }]),
    listExpenseCategories: vi.fn(async () => [{ id: "actual-food", name: "食費" }]),
    importReceipt: vi.fn(async () => ({ id: "actual-tx" })),
    ...ledgerOverrides,
  };
  const service = new LocalReceiptService(repository, ledger as never, {
    fetchImpl: fetchImpl as typeof fetch,
    getToken: vi.fn(async () => "synthetic-token"),
    makeId: () => "00000000-0000-4000-8000-000000000001",
    now: () => new Date("2026-09-30T00:00:00.000Z"),
    withRegistrationLock: async (_id, operation) => operation(),
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
      .mockResolvedValueOnce(Response.json({ model: "jev-latest", answers: { item_0: { type: "choice", choice: "food", probabilities, confidence: 0.92 } } }));
    const { service } = await setup(fetchImpl);
    const receipt = await service.saveImage(pngBlob());
    await service.analyze(receipt.id);
    expect(await service.suggestCategory(receipt.id)).toBe("food");
    const body = JSON.parse(String(fetchImpl.mock.calls[1][0] && (fetchImpl.mock.calls[1][1] as RequestInit).body));
    expect(body).toEqual({ flowId: (await service.get(receipt.id))?.aiFlowId, receipt: { merchant: "Synthetic Shop", totalAmountYen: 3284, items: [{ name: "Synthetic Item", amountYen: 3284 }] } });
    expect((await service.get(receipt.id))?.confirmedValue).toBeNull();
    const imageBody = JSON.parse(String((fetchImpl.mock.calls[0][1] as RequestInit).body));
    expect(body.flowId).toBe(imageBody.flowId);
  });

  it.each(["current", "legacy"])("reuses a %s saved category suggestion after reopening without requesting the spent flow", async (format) => {
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(Response.json(extraction))
      .mockResolvedValueOnce(Response.json({ model: "jev-latest", answers: { item_0: { type: "choice", choice: "food", probabilities, confidence: 0.92 } } }))
      .mockResolvedValueOnce(Response.json({ error: "invalid_flow" }, { status: 409 }));
    const { repository, ledger, service } = await setup(fetchImpl);
    const receipt = await service.saveImage(pngBlob());
    await service.analyze(receipt.id);
    expect(await service.suggestCategory(receipt.id)).toBe("food");
    if (format === "legacy") {
      const saved = (await service.get(receipt.id))!;
      delete saved.aiSuggestion.flowId;
      await repository.put({ id: saved.id, kind: "receipt-metadata", value: saved, updatedAt: saved.updatedAt });
    }
    const reopened = new LocalReceiptService(repository, ledger as never, {
      fetchImpl, getToken: async () => "synthetic-token",
      withRegistrationLock: async (_id, operation) => operation(),
    });
    expect(await reopened.suggestCategory(receipt.id)).toBe("food");
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("prefers a saved merchant mapping without calling Jev", async () => {
    const fetchImpl = vi.fn(async () => Response.json({ ...extraction, items: [] }));
    const { repository, service } = await setup(fetchImpl);
    await repository.put({ id: "mapping:shop", kind: "merchant-mapping", value: { normalizedMerchant: "synthetic shop", categoryId: "food" }, updatedAt: "2026-09-30T00:00:00.000Z" });
    const receipt = await service.saveImage(pngBlob());
    await service.analyze(receipt.id);
    expect(await service.suggestCategory(receipt.id)).toBe("food");
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

  it("invalidates a merchant mapping to a deleted or hidden custom category without sending another AI request", async () => {
    const fetchImpl = vi.fn(async () => Response.json({ ...extraction, items: [] }));
    const { repository, service } = await setup(fetchImpl);
    await repository.put({ id: "mapping:removed", kind: "merchant-mapping", value: { normalizedMerchant: "synthetic shop", actualCategoryId: "removed-category" }, updatedAt: "2026-09-30T00:00:00.000Z" });
    const receipt = await service.saveImage(pngBlob());
    await service.analyze(receipt.id);
    expect(await service.suggestCategory(receipt.id)).toBeNull();
    expect(await repository.get("mapping:removed")).toBeNull();
    expect((await service.get(receipt.id))?.aiSuggestion.categoryId).toBeNull();
    expect(fetchImpl).toHaveBeenCalledTimes(1);
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
    const lowProbabilities = Object.fromEntries(CATEGORY_IDS.map((id) => [id, id === "food" ? 0.4 : 0.075]));
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(Response.json(extraction))
      .mockResolvedValueOnce(Response.json({ model: "jev-latest", answers: { item_0: { type: "choice", choice: "food", probabilities: lowProbabilities, confidence: 0.4 } } }));
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
    const answer = (choice: string) => ({ model: "jev-latest", answers: { item_0: { type: "choice", choice, probabilities: Object.fromEntries(CATEGORY_IDS.map(id => [id, id === choice ? 0.92 : 0.01])), confidence: 0.92 } } });
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(Response.json(extraction))
      .mockResolvedValueOnce(Response.json(answer("food")))
      .mockResolvedValueOnce(Response.json({ ...extraction, merchant: "Synthetic Pharmacy" }))
      .mockResolvedValueOnce(Response.json(answer("medical")));
    const { service } = await setup(fetchImpl);
    const receipt = await service.saveImage(pngBlob());
    await service.analyze(receipt.id);
    expect(await service.suggestCategory(receipt.id)).toBe("food");
    await service.confirm(receipt.id, { merchant: "Synthetic Shop", purchasedDate: "2026-09-30", purchasedTime: null, totalAmountYen: 3284, categoryId: "food", accountId: "cash" });
    await service.analyze(receipt.id);
    expect(await service.suggestCategory(receipt.id)).toBe("medical");
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
      .mockResolvedValueOnce(Response.json({ model: "jev-latest", answers: { item_0: { type: "choice", choice: "food", probabilities } } }));
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
  it("keeps an unsafe allocation pending and editable without writing to Actual", async () => {
    const { service, ledger } = await setup();
    const receipt = await service.createManual();
    await service.confirm(receipt.id, { ...value, totalAmountYen: 1500 });
    await expect(service.register(receipt.id)).rejects.toMatchObject({ code: "allocation_required" });
    expect(ledger.importReceipt).not.toHaveBeenCalled();
    expect((await service.get(receipt.id))?.registration.status).toBe("pending");
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
  const strong = { type: "choice", choice: "food", probabilities, confidence: 0.92 };
  const weak = { type: "choice", choice: "food", probabilities: Object.fromEntries(CATEGORY_IDS.map(id => [id, id === "food" ? 0.4 : 0.075])), confidence: 0.4 };
  const fetchImpl = vi.fn().mockResolvedValueOnce(Response.json({ ...extraction, items: [{ name: "Synthetic apple", amountYen: 2000 }, { name: "Synthetic soap", amountYen: 1284 }] })).mockResolvedValueOnce(Response.json({ model: "synthetic-model", answers: { item_0: strong, item_1: weak } }));
  const { service } = await setup(fetchImpl);
  const receipt = await service.saveImage(pngBlob());
  await service.analyze(receipt.id);
  await service.suggestCategory(receipt.id);
  expect((await service.get(receipt.id))?.itemCategories).toEqual(["food", null]);
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
