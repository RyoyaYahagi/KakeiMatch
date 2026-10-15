import { z } from 'zod';
import type { LocalDataRepository } from '../../../src/lib/local-data';
import type { LocalReceipt } from './local-receipts';

export const FOOD_SCOPE = 'food-purchases:read' as const;
const KEY = 'kakeimatch.food-connections.v1';
const category = z.object({ id: z.string().min(1), name: z.string().min(1) });
const connectionSchema = z.object({
  id: z.string().uuid(), profileId: z.string(), name: z.string().min(1).max(80), origin: z.string(),
  tokenHash: z.string().regex(/^[a-f0-9]{64}$/), scope: z.literal(FOOD_SCOPE),
  categories: z.array(category).min(1), createdAt: z.iso.datetime(),
});
export type FoodConnection = z.infer<typeof connectionSchema>;
export type FoodPurchase = {
  id: string; purchasedDate: string; merchant: string; name: string; normalizedFoodName: null;
  quantity: number | null; unit: null; amountYen: number | null; currency: 'JPY';
  category: { id: string; name: string }; receiptId: string; transactionId: string | null; updatedAt: string;
};
export class FoodApiError extends Error {
  constructor(readonly status: number, readonly code: string) { super(code); }
}
export async function foodHash(value: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, '0')).join('');
}
export function foodOrigin(value: string): string {
  const url = new URL(value);
  if (url.username || url.password || url.search || url.hash || url.pathname !== '/' ||
      !(url.protocol === 'https:' || (url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)))) {
    throw new Error('接続先はhttpsのサイトURLを入力してください。開発時はlocalhostも使えます。');
  }
  return url.origin;
}
export function foodConnections(storage: Pick<Storage, 'getItem'> = localStorage): FoodConnection[] {
  return z.array(connectionSchema).parse(JSON.parse(storage.getItem(KEY) ?? '[]'));
}
export async function grantFoodConnection(input: Pick<FoodConnection, 'profileId' | 'name' | 'categories'> & { origin: string }, storage: Storage = localStorage) {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  const token = [...bytes].map(byte => byte.toString(16).padStart(2, '0')).join('');
  const connection = connectionSchema.parse({ ...input, origin: foodOrigin(input.origin), name: input.name.trim(),
    id: crypto.randomUUID(), scope: FOOD_SCOPE, tokenHash: await foodHash(token), createdAt: new Date().toISOString() });
  storage.setItem(KEY, JSON.stringify([...foodConnections(storage), connection]));
  return { connection, token };
}
export function revokeFoodConnection(id: string, storage: Storage = localStorage) {
  // Remove permission first. A failed feed cleanup cannot keep a token authorized.
  storage.setItem(KEY, JSON.stringify(foodConnections(storage).filter(row => row.id !== id)));
  storage.removeItem(`${KEY}.feed.${id}`);
}
export async function authorizeFoodConnection(token: string, origin: string, profileId: string, storage: Storage = localStorage): Promise<FoodConnection> {
  if (!/^[a-f0-9]{64}$/.test(token)) throw new FoodApiError(401, 'invalid_token');
  const hash = await foodHash(token);
  const connection = foodConnections(storage).find(row => row.profileId === profileId && row.origin === origin && row.tokenHash === hash);
  if (!connection) throw new FoodApiError(401, 'invalid_token');
  return connection;
}

/** Only user-confirmed, registered items in explicitly selected food categories leave the device. */
export function projectFoodPurchases(receipts: LocalReceipt[], connection: FoodConnection): FoodPurchase[] {
  const categories = new Map(connection.categories.map(row => [row.id, row]));
  return receipts.flatMap(receipt => {
    const value = receipt.confirmedValue;
    if (receipt.registration.status !== 'applied' || !value) return [];
    return (value.items ?? []).flatMap(item => {
      const selected = categories.get(item.categoryId ?? value.categoryId);
      if (!selected) return [];
      return [{ id: `${encodeURIComponent(receipt.id)}/${encodeURIComponent(item.id)}`, purchasedDate: value.purchasedDate,
        merchant: value.merchant, name: item.name, normalizedFoodName: null, quantity: item.quantity ?? null, unit: null,
        amountYen: item.amountYen, currency: 'JPY' as const, category: selected, receiptId: receipt.id,
        transactionId: receipt.registration.actualTransactionId, updatedAt: receipt.updatedAt }];
    });
  });
}
const entrySchema = z.object({ hash: z.string(), revision: z.number().int().nonnegative(), deletedAt: z.string().nullable() });
const feedSchema = z.object({ revision: z.number().int().nonnegative(), entries: z.record(z.string(), entrySchema) });
const date = z.iso.date();
const querySchema = z.object({
  cursor: z.string().optional(), limit: z.coerce.number().int().min(1).max(200).default(100),
  from: date.optional(), to: date.optional(), updatedSince: z.iso.datetime({ offset: true }).optional(),
}).strict();
export type FoodApiRequest = { method: string; path: string; token: string };

/** GET-shaped browser API, deliberately independent of HTTP hosting and MCP. Call under a Web Lock. */
export async function readFoodApi(options: {
  request: FoodApiRequest; origin: string; repository: Pick<LocalDataRepository, 'profileId' | 'list'>;
  storage: Storage; isAvailable: () => boolean;
}): Promise<{ status: number; body: unknown }> {
  const { request, origin, repository, storage, isAvailable } = options;
  const ensureAvailable = () => { if (!isAvailable()) throw new FoodApiError(423, 'connection_unavailable'); };
  ensureAvailable();
  const connection = await authorizeFoodConnection(request.token, origin, repository.profileId, storage);
  if (request.method !== 'GET') throw new FoodApiError(405, 'read_only');
  const url = new URL(request.path, 'https://food.invalid');
  const base = '/api/v1/food-purchases';
  if (url.origin !== 'https://food.invalid' || (url.pathname !== base && !url.pathname.startsWith(`${base}/`)) || url.hash) throw new FoodApiError(404, 'not_found');
  const parsed = querySchema.safeParse(Object.fromEntries(url.searchParams));
  if (!parsed.success || (parsed.data.from && parsed.data.to && parsed.data.from > parsed.data.to)) throw new FoodApiError(400, 'invalid_query');
  const query = parsed.data;
  const rows = projectFoodPurchases((await repository.list<LocalReceipt>('receipt-metadata')).map(row => row.value), connection);
  // Recheck after every asynchronous read: revoke, profile switch, lock or pagehide wins over an in-flight request.
  await authorizeFoodConnection(request.token, origin, repository.profileId, storage);
  ensureAvailable();
  if (url.pathname !== base) {
    let id: string;
    try { id = decodeURIComponent(url.pathname.slice(base.length + 1)); }
    catch { throw new FoodApiError(400, 'invalid_path'); }
    const row = rows.find(row => row.id === id);
    if (!row) throw new FoodApiError(404, 'not_found');
    return { status: 200, body: row };
  }
  const key = `${KEY}.feed.${connection.id}`;
  const serialized = storage.getItem(key);
  const state = feedSchema.parse(JSON.parse(serialized ?? '{"revision":0,"entries":{}}'));
  const revisionText = query.cursor?.startsWith(`${connection.id}:`) ? query.cursor.slice(connection.id.length + 1) : undefined;
  const cursor = revisionText !== undefined && /^\d+$/.test(revisionText) ? Number(revisionText) : 0;
  if (query.cursor && (revisionText === undefined || !/^\d+$/.test(revisionText) || !Number.isSafeInteger(cursor) || cursor > state.revision)) throw new FoodApiError(409, 'reset_required');
  const now = new Date().toISOString();
  const current = new Map(rows.map(row => [row.id, row]));
  const hashes = await Promise.all(rows.map(async row => [row.id, await foodHash(JSON.stringify(row))] as const));
  await authorizeFoodConnection(request.token, origin, repository.profileId, storage);
  ensureAvailable();
  for (const [id, hash] of hashes) {
    if (state.entries[id]?.hash !== hash) state.entries[id] = { hash, revision: ++state.revision, deletedAt: null };
  }
  for (const [id, entry] of Object.entries(state.entries)) {
    if (!current.has(id) && entry.deletedAt === null) state.entries[id] = { hash: '', revision: ++state.revision, deletedAt: now };
  }
  storage.setItem(key, JSON.stringify(state));
  const changes = Object.entries(state.entries).filter(([, entry]) => entry.revision > cursor).sort((a, b) => a[1].revision - b[1].revision);
  const page = changes.slice(0, query.limit);
  const items: Array<(FoodPurchase & { deleted: false }) | { id: string; deleted: true; updatedAt: string }> = [];
  for (const [id, entry] of page) {
    const row = current.get(id);
    if (!row) { items.push({ id, deleted: true, updatedAt: entry.deletedAt! }); continue; }
    if ((query.from && row.purchasedDate < query.from) || (query.to && row.purchasedDate > query.to) || (query.updatedSince && Date.parse(row.updatedAt) <= Date.parse(query.updatedSince))) {
      if (query.cursor) items.push({ id, deleted: true, updatedAt: now });
      continue;
    }
    items.push({ ...row, deleted: false });
  }
  return { status: 200, body: { scope: FOOD_SCOPE, items, nextCursor: `${connection.id}:${page.at(-1)?.[1].revision ?? state.revision}`, hasMore: changes.length > page.length } };
}
