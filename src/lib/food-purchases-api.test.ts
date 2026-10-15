import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { IDBFactory, IDBKeyRange } from 'fake-indexeddb';
import { LocalDataRepository } from './local-data';
import type { LocalReceipt } from '../../apps/pwa/src/local-receipts';
import { authorizeFoodConnection, foodConnections, foodOrigin, grantFoodConnection, readFoodApi, revokeFoodConnection } from '../../apps/pwa/src/food-purchases-api';

function memoryStorage(): Storage {
  const entries = new Map<string, string>();
  return { get length() { return entries.size; }, clear: () => entries.clear(), getItem: key => entries.get(key) ?? null,
    setItem: (key, value) => { entries.set(key, value); }, removeItem: key => { entries.delete(key); }, key: index => [...entries.keys()][index] ?? null };
}
function receipt(id = 'receipt:synthetic'): LocalReceipt {
  return { id, createdAt: '2026-10-15T00:00:00.000Z', updatedAt: '2026-10-15T00:00:00.000Z', image: null, extraction: null,
    aiSuggestion: { categoryId: null, source: 'unclassified', probabilities: null, model: null, attemptedAt: null },
    registration: { status: 'applied', actualTransactionId: 'transaction:synthetic', lastError: null },
    confirmedValue: { merchant: '合成店舗', purchasedDate: '2026-10-14', purchasedTime: null, totalAmountYen: 500, categoryId: 'food', accountId: 'private-account', memo: 'private memo',
      items: [{ id: 'apple', name: '合成りんご', amountYen: 300, quantity: 2, categoryId: 'food' }, { id: 'soap', name: 'private soap', amountYen: 200, categoryId: 'daily' }] } };
}
describe('food purchase read API', () => {
  let repository: LocalDataRepository;
  let other: LocalDataRepository;
  let storage: Storage;
  let token: string;
  let connectionId: string;
  let row: LocalReceipt;
  let available: boolean;
  const origin = 'https://recipe.example';
  beforeEach(async () => {
    vi.stubGlobal('IDBKeyRange', IDBKeyRange);
    const factory = new IDBFactory();
    repository = await LocalDataRepository.open('profile-a', factory);
    other = await LocalDataRepository.open('profile-b', factory);
    storage = memoryStorage(); available = true; row = receipt();
    const grant = await grantFoodConnection({ profileId: repository.profileId, name: '合成レシピ', origin, categories: [{ id: 'food', name: '食費' }] }, storage);
    token = grant.token; connectionId = grant.connection.id;
    await save();
    await other.put({ id: 'other', kind: 'receipt-metadata', value: receipt('other'), updatedAt: row.updatedAt });
  });
  afterEach(() => { repository.close(); other.close(); vi.unstubAllGlobals(); });
  async function save() { await repository.put({ id: row.id, kind: 'receipt-metadata', value: row, updatedAt: row.updatedAt }); }
  function request(path = '/api/v1/food-purchases', method = 'GET') {
    return readFoodApi({ request: { token, method, path }, origin, repository, storage, isAvailable: () => available });
  }
  async function list(path?: string) {
    return (await request(path)).body as { items: Array<{ id: string; name?: string; deleted: boolean; amountYen?: number }>; nextCursor: string; hasMore: boolean };
  }
  it('returns only confirmed food items in the current profile and an explicit whitelist of fields', async () => {
    const result = await list();
    expect(result.items).toHaveLength(1);
    expect(result.items[0]).toEqual({ id: 'receipt%3Asynthetic/apple', purchasedDate: '2026-10-14', merchant: '合成店舗', name: '合成りんご', normalizedFoodName: null,
      quantity: 2, unit: null, amountYen: 300, currency: 'JPY', category: { id: 'food', name: '食費' }, receiptId: row.id,
      transactionId: 'transaction:synthetic', updatedAt: row.updatedAt, deleted: false });
    expect(JSON.stringify(result)).not.toMatch(/private|other|extraction|image|accountId|memo/);
    const detail = await request(`/api/v1/food-purchases/${encodeURIComponent(result.items[0].id)}`);
    expect(detail.status).toBe(200);
    expect(await authorizeFoodConnection(token, origin, repository.profileId, storage)).toMatchObject({ scope: 'food-purchases:read' });
    expect(JSON.stringify(foodConnections(storage))).not.toContain(token);
  });
  it('rejects other sites, profiles, invalid keys, mutations and unrelated endpoints', async () => {
    await expect(authorizeFoodConnection(token, 'https://attacker.example', repository.profileId, storage)).rejects.toMatchObject({ status: 401 });
    await expect(authorizeFoodConnection(token, origin, other.profileId, storage)).rejects.toMatchObject({ status: 401 });
    await expect(authorizeFoodConnection('bad', origin, repository.profileId, storage)).rejects.toMatchObject({ status: 401 });
    await expect(request(undefined, 'POST')).rejects.toMatchObject({ status: 405 });
    await expect(request('/api/v1/transactions')).rejects.toMatchObject({ status: 404 });
    await expect(request('https://elsewhere.example/api/v1/food-purchases')).rejects.toMatchObject({ status: 404 });
    await expect(request('/api/v1/food-purchases?userId=other')).rejects.toMatchObject({ status: 400 });
  });
  it('rejects a revoked key immediately, including in-flight reads', async () => {
    const revokeOnRead = { profileId: repository.profileId, list: async <T,>() => { revokeFoodConnection(connectionId, storage); return repository.list<T>('receipt-metadata'); } };
    await expect(readFoodApi({ request: { token, method: 'GET', path: '/api/v1/food-purchases' }, origin, repository: revokeOnRead, storage, isAvailable: () => true })).rejects.toMatchObject({ status: 401 });
    await expect(request()).rejects.toMatchObject({ status: 401 });
  });
  it('blocks locked or switched profiles, including reads that finish after a lock', async () => {
    available = false; await expect(request()).rejects.toMatchObject({ status: 423 });
    available = true;
    const lockOnRead = { profileId: repository.profileId, list: async <T,>() => { available = false; return repository.list<T>('receipt-metadata'); } };
    await expect(readFoodApi({ request: { token, method: 'GET', path: '/api/v1/food-purchases' }, origin, repository: lockOnRead, storage, isAvailable: () => available })).rejects.toMatchObject({ status: 423 });
  });
  it('supports incremental updates, category removal, deletion and restoration', async () => {
    const first = await list();
    expect((await list(`/api/v1/food-purchases?cursor=${first.nextCursor}`)).items).toEqual([]);
    row.confirmedValue!.items![0].amountYen = 350; row.updatedAt = '2026-10-15T01:00:00.000Z'; await save();
    const changed = await list(`/api/v1/food-purchases?cursor=${first.nextCursor}`);
    expect(changed.items[0]).toMatchObject({ amountYen: 350, deleted: false });
    row.confirmedValue!.items![0].categoryId = 'daily'; await save();
    const removed = await list(`/api/v1/food-purchases?cursor=${changed.nextCursor}`);
    expect(removed.items).toEqual([{ id: first.items[0].id, deleted: true, updatedAt: expect.any(String) }]);
    row.confirmedValue!.items![0].categoryId = 'food'; await save();
    const restored = await list(`/api/v1/food-purchases?cursor=${removed.nextCursor}`); expect(restored.items[0].deleted).toBe(false);
    row.registration.status = 'deleted'; await save();
    expect((await list(`/api/v1/food-purchases?cursor=${restored.nextCursor}`)).items[0].deleted).toBe(true);
  });
  it('detects edits at the same timestamp and physical deletion without exposing other categories', async () => {
    const first = await list();
    row.confirmedValue!.items![0].name = '合成りんご（訂正）'; await save();
    const changed = await list(`/api/v1/food-purchases?cursor=${first.nextCursor}`);
    expect(changed.items[0].name).toBe('合成りんご（訂正）');
    await repository.delete(row.id);
    expect((await list(`/api/v1/food-purchases?cursor=${changed.nextCursor}`)).items[0].deleted).toBe(true);
  });
  it('paginates without losing changes and validates cursors and query ranges', async () => {
    row.confirmedValue!.items!.push({ id: 'pear', name: '合成なし', amountYen: null, categoryId: null }); await save();
    const first = await list('/api/v1/food-purchases?limit=1'); expect(first.hasMore).toBe(true);
    const next = await list(`/api/v1/food-purchases?limit=1&cursor=${first.nextCursor}`); expect(next.hasMore).toBe(false);
    expect(new Set([...first.items, ...next.items].map(item => item.id)).size).toBe(2);
    expect(next.items[0]).toMatchObject({ quantity: null, unit: null, amountYen: null });
    await expect(request('/api/v1/food-purchases?limit=201')).rejects.toMatchObject({ status: 400 });
    await expect(request('/api/v1/food-purchases?from=2026-02-30')).rejects.toMatchObject({ status: 400 });
    await expect(request('/api/v1/food-purchases?from=2026-11-01&to=2026-10-01')).rejects.toMatchObject({ status: 400 });
    await expect(request('/api/v1/food-purchases?cursor=wrong:1')).rejects.toMatchObject({ status: 409 });
    expect((await list('/api/v1/food-purchases?from=2026-10-15')).items).toEqual([]);
    expect((await list('/api/v1/food-purchases?updatedSince=2026-10-15T00:00:00Z')).items).toEqual([]);
  });
  it('omits pending receipts and receipts without confirmed items, and keeps unknown quantities null', async () => {
    row.registration.status = 'pending'; await save(); expect((await list()).items).toEqual([]);
    row.registration.status = 'applied'; row.confirmedValue!.items = undefined; await save(); expect((await list()).items).toEqual([]);
  });
  it('limits granted origins to explicit HTTPS sites and loopback development URLs', () => {
    expect(foodOrigin('https://recipe.example/')).toBe(origin);
    expect(foodOrigin('http://127.0.0.1:9999')).toBe('http://127.0.0.1:9999');
    for (const value of ['http://recipe.example', 'https://a.example/path', 'https://u:p@a.example', 'https://a.example?token=x', 'file:///tmp/a']) expect(() => foodOrigin(value)).toThrow();
  });
});
