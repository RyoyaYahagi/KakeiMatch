import { verifyChain } from './app-attest';
import {
  getAppleRootCaG3Der,
  STOREKIT_INTERMEDIATE_OID,
  STOREKIT_LEAF_OID,
} from './storekit-certs';

// NOTE (S9 -> S10):
// CRL / OCSP revocation checking is intentionally not implemented in S9.
// Adding 'Production' to STOREKIT_ALLOWED_ENVIRONMENTS requires an S10 decision
// on CRL / OCSP handling.

export type StoreKitEnvironment = 'Sandbox' | 'Production';
export type StoreKitOwnershipType = 'PURCHASED' | 'FAMILY_SHARED';

export interface VerifiedStoreKitTransaction {
  originalTransactionId: string;
  transactionId: string;
  bundleId: string;
  productId: string;
  environment: StoreKitEnvironment;
  inAppOwnershipType: StoreKitOwnershipType;
  signedDateMs: number;
  expiresAt: number | null;
  revokedAt: number | null;
  revocationReason: number | null;
  appAccountToken: string | null;
}

export interface VerifyStoreKitJwsOptions {
  now?: Date;
  expectedBundleId?: string;
  /** Trust-anchor injection is for synthetic unit tests only. No HTTP/binding can supply it. */
  testTrustAnchor?: Uint8Array;
}

const DEFAULT_BUNDLE_ID = 'jp.kakeimatch.ios';
const MAX_JWS_LENGTH = 48 * 1024;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const ALLOWED_JWS_ALGS: Record<string, { namedCurve: 'P-256' | 'P-384'; hash: 'SHA-256' | 'SHA-384'; signatureBytes: number }> = {
  ES256: { namedCurve: 'P-256', hash: 'SHA-256', signatureBytes: 64 },
  ES384: { namedCurve: 'P-384', hash: 'SHA-384', signatureBytes: 96 },
};

const utf8Encoder = new TextEncoder();
const utf8Decoder = new TextDecoder('utf-8', { fatal: true });

function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  return a.length === b.length && a.every((value, index) => value === b[index]);
}

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.slice().buffer as ArrayBuffer;
}

function encodeBase64(bytes: Uint8Array): string {
  let binary = '';
  for (let offset = 0; offset < bytes.length; offset += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
  }
  return btoa(binary);
}

function decodeBase64(value: unknown, maxLength = 16 * 1024): Uint8Array {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length > maxLength ||
    !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)
  ) {
    throw new Error('invalid_base64');
  }
  const decoded = Uint8Array.from(atob(value), char => char.charCodeAt(0));
  if (encodeBase64(decoded) !== value) {
    throw new Error('invalid_base64');
  }
  return decoded;
}

function encodeBase64Url(bytes: Uint8Array): string {
  return encodeBase64(bytes).replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
}

function decodeBase64Url(value: string): Uint8Array {
  if (!value.length || !/^[A-Za-z0-9_-]+$/.test(value) || value.length % 4 === 1) {
    throw new Error('invalid_base64url');
  }
  const padded = value.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (value.length % 4)) % 4);
  const decoded = Uint8Array.from(atob(padded), char => char.charCodeAt(0));
  if (encodeBase64Url(decoded) !== value) {
    throw new Error('invalid_base64url');
  }
  return decoded;
}

function parseJsonObject(bytes: Uint8Array): Record<string, unknown> {
  let decoded: unknown;
  try {
    decoded = JSON.parse(utf8Decoder.decode(bytes));
  } catch {
    throw new Error('invalid_json');
  }
  if (decoded === null || typeof decoded !== 'object' || Array.isArray(decoded)) {
    throw new Error('invalid_json');
  }
  return decoded as Record<string, unknown>;
}

function requireNonEmptyString(value: unknown, maxLength = 128): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > maxLength) {
    throw new Error('invalid_payload');
  }
  return value;
}

function requireTimestampMs(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw new Error('invalid_payload');
  }
  return value;
}

function optionalTimestampMs(value: unknown): number | null {
  if (value === undefined || value === null) return null;
  return requireTimestampMs(value);
}

/**
 * Verifies any StoreKit 2 / App Store Server Notifications V2 JWS signed by Apple's
 * StoreKit certificate chain (strict header allowlist, 3-cert x5c anchored to Apple Root CA - G3,
 * X.509 chain verification via app-attest.ts, StoreKit OIDs, and ECDSA signature verification).
 * Returns the decoded JSON payload object without assuming a specific payload schema.
 */
export async function verifyStoreKitJws(
  jws: string,
  options: VerifyStoreKitJwsOptions = {},
): Promise<Record<string, unknown>> {
  if (typeof jws !== 'string' || jws.length === 0 || jws.length > MAX_JWS_LENGTH) {
    throw new Error('invalid_jws');
  }
  const parts = jws.split('.');
  if (parts.length !== 3) {
    throw new Error('invalid_jws');
  }
  const [encodedHeader, encodedPayload, encodedSignature] = parts;
  const headerBytes = decodeBase64Url(encodedHeader);
  const payloadBytes = decodeBase64Url(encodedPayload);
  const signatureBytes = decodeBase64Url(encodedSignature);

  const header = parseJsonObject(headerBytes);
  const headerKeys = Object.keys(header);
  // Strict header allowlist: reject any unexpected key (especially 'crit').
  if (headerKeys.length !== 2 || !headerKeys.includes('alg') || !headerKeys.includes('x5c')) {
    throw new Error('invalid_jws_header');
  }

  const alg = header.alg;
  if (typeof alg !== 'string' || !Object.prototype.hasOwnProperty.call(ALLOWED_JWS_ALGS, alg)) {
    throw new Error('unsupported_algorithm');
  }
  const algSpec = ALLOWED_JWS_ALGS[alg];

  if (!Array.isArray(header.x5c) || header.x5c.length !== 3) {
    throw new Error('invalid_x5c');
  }
  const x5cDer = header.x5c.map(item => decodeBase64(item));
  const trustedRoot = options.testTrustAnchor ?? (await getAppleRootCaG3Der());
  if (!bytesEqual(x5cDer[2], trustedRoot)) {
    throw new Error('untrusted_root');
  }

  const now = options.now ?? new Date();
  if (!Number.isFinite(now.getTime())) {
    throw new Error('invalid_time');
  }

  const [leaf, intermediate] = await verifyChain([x5cDer[0], x5cDer[1]], trustedRoot, now);
  if (!intermediate.getExtension(STOREKIT_INTERMEDIATE_OID)) {
    throw new Error('missing_intermediate_oid');
  }
  if (!leaf.getExtension(STOREKIT_LEAF_OID)) {
    throw new Error('missing_leaf_oid');
  }

  // Derive verification parameters from the leaf key itself; reject any curve/algorithm mismatch.
  const leafKeyAlgorithm = leaf.publicKey.algorithm as { name?: string; namedCurve?: string };
  if (leafKeyAlgorithm.name !== 'ECDSA' || leafKeyAlgorithm.namedCurve !== algSpec.namedCurve) {
    throw new Error('algorithm_key_mismatch');
  }
  if (signatureBytes.length !== algSpec.signatureBytes) {
    throw new Error('invalid_signature');
  }

  const leafCryptoKey = await leaf.publicKey.export(
    { name: 'ECDSA', namedCurve: algSpec.namedCurve },
    ['verify'],
  );
  const signingInput = utf8Encoder.encode(`${encodedHeader}.${encodedPayload}`);
  const validSignature = await crypto.subtle.verify(
    { name: 'ECDSA', hash: algSpec.hash },
    leafCryptoKey,
    toArrayBuffer(signatureBytes),
    toArrayBuffer(signingInput),
  );
  if (!validSignature) {
    throw new Error('invalid_signature');
  }

  return parseJsonObject(payloadBytes);
}

/**
 * Verifies a StoreKit 2 JWS transaction payload signed by Apple's StoreKit certificate chain.
 * Uses verifyStoreKitJws for chain & signature verification, then validates transaction fields.
 */
export async function verifyStoreKitTransactionJws(
  jws: string,
  options: VerifyStoreKitJwsOptions = {},
): Promise<VerifiedStoreKitTransaction> {
  const now = options.now ?? new Date();
  const payload = await verifyStoreKitJws(jws, { ...options, now });
  const expectedBundleId = options.expectedBundleId ?? DEFAULT_BUNDLE_ID;
  const bundleId = requireNonEmptyString(payload.bundleId);
  if (bundleId !== expectedBundleId) {
    throw new Error('invalid_bundle_id');
  }
  if (payload.type !== 'Auto-Renewable Subscription') {
    throw new Error('unsupported_transaction_type');
  }
  if (payload.environment !== 'Sandbox' && payload.environment !== 'Production') {
    throw new Error('invalid_environment');
  }
  if (payload.inAppOwnershipType !== 'PURCHASED' && payload.inAppOwnershipType !== 'FAMILY_SHARED') {
    throw new Error('invalid_ownership_type');
  }

  const signedDateMs = requireTimestampMs(payload.signedDate);
  if (signedDateMs > now.getTime()) {
    throw new Error('future_signed_date');
  }

  const expiresDateMs = optionalTimestampMs(payload.expiresDate);
  const revocationDateMs = optionalTimestampMs(payload.revocationDate);
  let revocationReason: number | null = null;
  if (payload.revocationReason !== undefined && payload.revocationReason !== null) {
    if (typeof payload.revocationReason !== 'number' || !Number.isSafeInteger(payload.revocationReason) || payload.revocationReason < 0) {
      throw new Error('invalid_payload');
    }
    revocationReason = payload.revocationReason;
  }

  let appAccountToken: string | null = null;
  if (payload.appAccountToken !== undefined && payload.appAccountToken !== null) {
    if (typeof payload.appAccountToken !== 'string' || !UUID_PATTERN.test(payload.appAccountToken)) {
      throw new Error('invalid_payload');
    }
    appAccountToken = payload.appAccountToken.toLowerCase();
  }

  // Note: isUpgraded is intentionally ignored in S9 (single product).
  return {
    originalTransactionId: requireNonEmptyString(payload.originalTransactionId),
    transactionId: requireNonEmptyString(payload.transactionId),
    bundleId,
    productId: requireNonEmptyString(payload.productId),
    environment: payload.environment,
    inAppOwnershipType: payload.inAppOwnershipType,
    signedDateMs,
    expiresAt: expiresDateMs === null ? null : Math.floor(expiresDateMs / 1000),
    revokedAt: revocationDateMs === null ? null : Math.floor(revocationDateMs / 1000),
    revocationReason,
    appAccountToken,
  };
}
