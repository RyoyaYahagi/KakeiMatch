import 'reflect-metadata';
import {
  BasicConstraintsExtension,
  Extension,
  KeyUsageFlags,
  KeyUsagesExtension,
  X509CertificateGenerator,
} from '@peculiar/x509';
import { STOREKIT_INTERMEDIATE_OID, STOREKIT_LEAF_OID } from '../storekit-certs';

const encoder = new TextEncoder();
const DEFAULT_NOW = new Date('2030-01-01T00:00:00.000Z');
const VALID_FROM = new Date('2029-01-01T00:00:00.000Z');
const VALID_UNTIL = new Date('2031-01-01T00:00:00.000Z');

function base64(bytes: Uint8Array): string {
  let binary = '';
  for (let offset = 0; offset < bytes.length; offset += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
  }
  return btoa(binary);
}

function base64Url(bytes: Uint8Array): string {
  return base64(bytes).replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
}

function arrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.slice().buffer as ArrayBuffer;
}

async function generateEcKeyPair(curve: 'P-256' | 'P-384'): Promise<CryptoKeyPair> {
  return crypto.subtle.generateKey(
    { name: 'ECDSA', namedCurve: curve },
    true,
    ['sign', 'verify'],
  ) as Promise<CryptoKeyPair>;
}

export interface StoreKitChainFixture {
  rootDER: Uint8Array;
  intermediateDER: Uint8Array;
  leafDER: Uint8Array;
  leafPrivateKey: CryptoKey;
  leafCurve: 'P-256' | 'P-384';
}

export interface StoreKitChainOptions {
  leafCurve?: 'P-256' | 'P-384';
  includeIntermediateOid?: boolean;
  includeLeafOid?: boolean;
  expiredLeaf?: boolean;
}

export async function buildStoreKitChainFixture(
  options: StoreKitChainOptions = {},
): Promise<StoreKitChainFixture> {
  const leafCurve = options.leafCurve ?? 'P-256';
  const rootKeys = await generateEcKeyPair('P-384');
  const intermediateKeys = await generateEcKeyPair('P-384');
  const leafKeys = await generateEcKeyPair(leafCurve);

  const rootName = 'CN=StoreKit Synthetic Root';
  const intermediateName = 'CN=StoreKit Synthetic Intermediate';

  const root = await X509CertificateGenerator.createSelfSigned({
    name: rootName,
    keys: rootKeys,
    notBefore: VALID_FROM,
    notAfter: VALID_UNTIL,
    signingAlgorithm: { name: 'ECDSA', hash: 'SHA-384' },
    extensions: [
      new BasicConstraintsExtension(true, 1, true),
      new KeyUsagesExtension(KeyUsageFlags.keyCertSign | KeyUsageFlags.cRLSign, true),
    ],
  });

  const intermediateExtensions: Extension[] = [
    new BasicConstraintsExtension(true, 0, true),
    new KeyUsagesExtension(KeyUsageFlags.keyCertSign | KeyUsageFlags.cRLSign, true),
  ];
  if (options.includeIntermediateOid ?? true) {
    intermediateExtensions.push(new Extension(STOREKIT_INTERMEDIATE_OID, false, arrayBuffer(Uint8Array.of(0x05, 0x00))));
  }

  const intermediate = await X509CertificateGenerator.create({
    subject: intermediateName,
    issuer: rootName,
    publicKey: intermediateKeys.publicKey,
    signingKey: rootKeys.privateKey,
    notBefore: VALID_FROM,
    notAfter: VALID_UNTIL,
    signingAlgorithm: { name: 'ECDSA', hash: 'SHA-384' },
    extensions: intermediateExtensions,
  });

  const leafExtensions: Extension[] = [
    new BasicConstraintsExtension(false, undefined, true),
    new KeyUsagesExtension(KeyUsageFlags.digitalSignature, true),
  ];
  if (options.includeLeafOid ?? true) {
    leafExtensions.push(new Extension(STOREKIT_LEAF_OID, false, arrayBuffer(Uint8Array.of(0x05, 0x00))));
  }

  const leaf = await X509CertificateGenerator.create({
    subject: 'CN=StoreKit Synthetic Leaf',
    issuer: intermediateName,
    publicKey: leafKeys.publicKey,
    signingKey: intermediateKeys.privateKey,
    notBefore: VALID_FROM,
    notAfter: options.expiredLeaf ? new Date('2029-12-31T23:59:59.000Z') : VALID_UNTIL,
    signingAlgorithm: { name: 'ECDSA', hash: 'SHA-384' },
    extensions: leafExtensions,
  });

  return {
    rootDER: new Uint8Array(root.rawData),
    intermediateDER: new Uint8Array(intermediate.rawData),
    leafDER: new Uint8Array(leaf.rawData),
    leafPrivateKey: leafKeys.privateKey,
    leafCurve,
  };
}

export interface StoreKitJwsOptions {
  chain?: StoreKitChainFixture;
  headerOverrides?: Record<string, unknown>;
  x5cOverride?: string[];
  payloadOverrides?: Record<string, unknown>;
  tamperSignature?: boolean;
  now?: Date;
}

export async function buildStoreKitJwsFixture(options: StoreKitJwsOptions = {}): Promise<{
  jws: string;
  trustAnchorDER: Uint8Array;
  now: Date;
}> {
  const chain = options.chain ?? (await buildStoreKitChainFixture());
  const now = options.now ?? DEFAULT_NOW;
  const alg = chain.leafCurve === 'P-384' ? 'ES384' : 'ES256';
  const hash = chain.leafCurve === 'P-384' ? 'SHA-384' : 'SHA-256';

  const header: Record<string, unknown> = {
    alg,
    x5c: options.x5cOverride ?? [
      base64(chain.leafDER),
      base64(chain.intermediateDER),
      base64(chain.rootDER),
    ],
    ...options.headerOverrides,
  };

  const payload: Record<string, unknown> = {
    originalTransactionId: '1000000000000001',
    transactionId: '2000000000000001',
    bundleId: 'jp.kakeimatch.ios',
    productId: 'jp.kakeimatch.pro.monthly',
    type: 'Auto-Renewable Subscription',
    environment: 'Sandbox',
    inAppOwnershipType: 'PURCHASED',
    signedDate: now.getTime() - 10_000,
    expiresDate: now.getTime() + 30 * 24 * 60 * 60 * 1000,
    ...options.payloadOverrides,
  };

  const encodedHeader = base64Url(encoder.encode(JSON.stringify(header)));
  const encodedPayload = base64Url(encoder.encode(JSON.stringify(payload)));
  const signingInput = encoder.encode(`${encodedHeader}.${encodedPayload}`);

  const signature = new Uint8Array(
    await crypto.subtle.sign(
      { name: 'ECDSA', hash },
      chain.leafPrivateKey,
      arrayBuffer(signingInput),
    ),
  );
  if (options.tamperSignature) {
    signature[signature.length - 1] ^= 0x01;
  }

  return {
    jws: `${encodedHeader}.${encodedPayload}.${base64Url(signature)}`,
    trustAnchorDER: chain.rootDER,
    now,
  };
}

export const storeKitTestNow = DEFAULT_NOW;
