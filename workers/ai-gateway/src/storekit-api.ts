import type { StoreKitEnvironment } from './storekit-jws';

export interface StoreKitApiEnv {
  APP_STORE_SERVER_API_PRIVATE_KEY?: string;
  APP_STORE_SERVER_API_ISSUER_ID?: string;
  APP_STORE_SERVER_API_KEY_ID?: string;
}

export interface StoreKitApiConfig {
  privateKeyPem: string;
  issuerId: string;
  keyId: string;
}

export interface CreateAppStoreApiJwtOptions {
  nowSeconds?: () => number;
  bundleId?: string;
  ttlSeconds?: number;
}

export interface FetchSubscriptionStatusesOptions {
  fetch?: typeof fetch;
  nowSeconds?: () => number;
  bundleId?: string;
}

export interface SubscriptionStatusItem {
  originalTransactionId: string;
  /** Apple SubscriptionStatus: 1=Active, 2=Expired, 3=InBillingRetry, 4=InGracePeriod, 5=Revoked */
  appleStatus: number;
  signedTransactionInfo: string;
  signedRenewalInfo: string | null;
}

export interface SubscriptionStatusesResult {
  found: boolean;
  environment: StoreKitEnvironment;
  items: SubscriptionStatusItem[];
}

export class StoreKitApiError extends Error {
  readonly status: number;
  readonly errorCode: number | null;

  constructor(status: number, errorCode: number | null = null) {
    super(`storekit_api_error_${status}`);
    this.name = 'StoreKitApiError';
    this.status = status;
    this.errorCode = errorCode;
  }
}

const DEFAULT_BUNDLE_ID = 'jp.kakeimatch.ios';
const DEFAULT_JWT_TTL_SECONDS = 300;
const MAX_JWT_TTL_SECONDS = 3600;
const APP_STORE_API_AUDIENCE = 'appstoreconnect-v1';

const API_BASE_URLS: Record<StoreKitEnvironment, string> = {
  Production: 'https://api.storekit.itunes.apple.com',
  Sandbox: 'https://api.storekit-sandbox.itunes.apple.com',
};

const utf8Encoder = new TextEncoder();

function encodeBase64(bytes: Uint8Array): string {
  let binary = '';
  for (let offset = 0; offset < bytes.length; offset += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
  }
  return btoa(binary);
}

function encodeBase64Url(bytes: Uint8Array): string {
  return encodeBase64(bytes).replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
}

function decodeBase64(value: string): Uint8Array {
  return Uint8Array.from(atob(value), char => char.charCodeAt(0));
}

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.slice().buffer as ArrayBuffer;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function pemToPkcs8Der(pem: string): Uint8Array {
  const normalized = pem.replace(/\\n/g, '\n').trim();
  const match = normalized.match(/^-----BEGIN PRIVATE KEY-----([\s\S]+?)-----END PRIVATE KEY-----$/);
  if (!match) {
    throw new Error('invalid_private_key_pem');
  }
  const base64Body = match[1].replace(/\s+/g, '');
  if (!base64Body.length) {
    throw new Error('invalid_private_key_pem');
  }
  return decodeBase64(base64Body);
}

/**
 * Parses App Store Server API credentials from Worker bindings.
 * Fail-closed: returns null if any required secret binding is missing or empty.
 */
export function parseStoreKitApiConfig(env?: StoreKitApiEnv): StoreKitApiConfig | null {
  const privateKeyPem = env?.APP_STORE_SERVER_API_PRIVATE_KEY?.trim();
  const issuerId = env?.APP_STORE_SERVER_API_ISSUER_ID?.trim();
  const keyId = env?.APP_STORE_SERVER_API_KEY_ID?.trim();
  if (!privateKeyPem || !issuerId || !keyId) {
    return null;
  }
  return { privateKeyPem, issuerId, keyId };
}

/**
 * Generates an ES256 JWT for authenticating calls to the App Store Server API.
 */
export async function createAppStoreServerApiJwt(
  config: StoreKitApiConfig,
  options: CreateAppStoreApiJwtOptions = {},
): Promise<string> {
  const now = options.nowSeconds ? options.nowSeconds() : Math.floor(Date.now() / 1000);
  const ttl = options.ttlSeconds ?? DEFAULT_JWT_TTL_SECONDS;
  if (!Number.isSafeInteger(ttl) || ttl <= 0 || ttl > MAX_JWT_TTL_SECONDS) {
    throw new Error('invalid_jwt_ttl');
  }

  const keyDer = pemToPkcs8Der(config.privateKeyPem);
  const privateKey = await crypto.subtle.importKey(
    'pkcs8',
    toArrayBuffer(keyDer),
    { name: 'ECDSA', namedCurve: 'P-256' },
    false,
    ['sign'],
  );

  const header = {
    alg: 'ES256',
    kid: config.keyId,
    typ: 'JWT',
  };
  const payload = {
    iss: config.issuerId,
    iat: now,
    exp: now + ttl,
    aud: APP_STORE_API_AUDIENCE,
    bid: options.bundleId ?? DEFAULT_BUNDLE_ID,
  };

  const encodedHeader = encodeBase64Url(utf8Encoder.encode(JSON.stringify(header)));
  const encodedPayload = encodeBase64Url(utf8Encoder.encode(JSON.stringify(payload)));
  const signingInput = utf8Encoder.encode(`${encodedHeader}.${encodedPayload}`);

  const signature = new Uint8Array(
    await crypto.subtle.sign(
      { name: 'ECDSA', hash: 'SHA-256' },
      privateKey,
      toArrayBuffer(signingInput),
    ),
  );
  if (signature.length !== 64) {
    throw new Error('invalid_signature_length');
  }

  return `${encodedHeader}.${encodedPayload}.${encodeBase64Url(signature)}`;
}

/**
 * Calls Apple's App Store Server API "Get All Subscription Statuses" endpoint
 * (`GET /inApps/v1/subscriptions/{transactionId}`) for the given originalTransactionId.
 */
export async function fetchAllSubscriptionStatuses(
  config: StoreKitApiConfig,
  originalTransactionId: string,
  environment: StoreKitEnvironment,
  options: FetchSubscriptionStatusesOptions = {},
): Promise<SubscriptionStatusesResult> {
  const expectedBundleId = options.bundleId ?? DEFAULT_BUNDLE_ID;
  const jwt = await createAppStoreServerApiJwt(config, {
    nowSeconds: options.nowSeconds,
    bundleId: expectedBundleId,
  });

  const baseUrl = API_BASE_URLS[environment];
  const url = `${baseUrl}/inApps/v1/subscriptions/${encodeURIComponent(originalTransactionId)}`;
  const fetchImpl = options.fetch ?? fetch;

  const response = await fetchImpl(url, {
    method: 'GET',
    headers: {
      authorization: `Bearer ${jwt}`,
      accept: 'application/json',
    },
  });

  if (response.status === 404) {
    return { found: false, environment, items: [] };
  }

  if (!response.ok) {
    let errorCode: number | null = null;
    try {
      const errorBody = await response.json();
      if (isPlainObject(errorBody) && typeof errorBody.errorCode === 'number' && Number.isSafeInteger(errorBody.errorCode)) {
        errorCode = errorBody.errorCode;
      }
    } catch {
      // Ignore non-JSON error bodies from upstream.
    }
    throw new StoreKitApiError(response.status, errorCode);
  }

  let body: unknown;
  try {
    body = await response.json();
  } catch {
    throw new Error('invalid_api_response');
  }
  if (!isPlainObject(body)) {
    throw new Error('invalid_api_response');
  }
  if (body.environment !== environment) {
    throw new Error('api_environment_mismatch');
  }
  if (body.bundleId !== expectedBundleId) {
    throw new Error('api_bundle_id_mismatch');
  }
  if (!Array.isArray(body.data)) {
    throw new Error('invalid_api_response');
  }

  const items: SubscriptionStatusItem[] = [];
  for (const group of body.data) {
    if (!isPlainObject(group) || !Array.isArray(group.lastTransactions)) continue;
    for (const tx of group.lastTransactions) {
      if (!isPlainObject(tx)) continue;
      if (
        typeof tx.originalTransactionId !== 'string' ||
        typeof tx.status !== 'number' ||
        !Number.isSafeInteger(tx.status) ||
        typeof tx.signedTransactionInfo !== 'string' ||
        tx.signedTransactionInfo.length === 0
      ) {
        continue;
      }
      const signedRenewalInfo =
        typeof tx.signedRenewalInfo === 'string' && tx.signedRenewalInfo.length > 0
          ? tx.signedRenewalInfo
          : null;
      items.push({
        originalTransactionId: tx.originalTransactionId,
        appleStatus: tx.status,
        signedTransactionInfo: tx.signedTransactionInfo,
        signedRenewalInfo,
      });
    }
  }

  return { found: true, environment, items };
}
