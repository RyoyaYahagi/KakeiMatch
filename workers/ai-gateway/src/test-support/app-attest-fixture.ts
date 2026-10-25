import 'reflect-metadata';
import {
  BasicConstraintsExtension,
  Extension,
  KeyUsageFlags,
  KeyUsagesExtension,
  X509CertificateGenerator,
} from '@peculiar/x509';
import { encode } from 'cbor-x';

export interface AppAttestConfig {
  appId: string;
  environment: 'production' | 'development';
}

const TEST_NOW = new Date('2030-01-01T00:00:00.000Z');
const VALID_FROM = new Date('2029-01-01T00:00:00.000Z');
const VALID_UNTIL = new Date('2031-01-01T00:00:00.000Z');
const APP_ATTEST_NONCE_OID = '1.2.840.113635.100.8.2';
const encoder = new TextEncoder();
type Bytes = Uint8Array;

function concat(...parts: Bytes[]): Bytes {
  const result = new Uint8Array(parts.reduce((total, part) => total + part.length, 0));
  let offset = 0;
  for (const part of parts) {
    result.set(part, offset);
    offset += part.length;
  }
  return result;
}

function base64(value: Bytes): string {
  let binary = '';
  for (let offset = 0; offset < value.length; offset += 0x8000) {
    binary += String.fromCharCode(...value.subarray(offset, offset + 0x8000));
  }
  return btoa(binary);
}

function arrayBuffer(value: Bytes): ArrayBuffer {
  return value.slice().buffer as ArrayBuffer;
}

async function sha256(value: Bytes): Promise<Bytes> {
  return new Uint8Array(await crypto.subtle.digest('SHA-256', arrayBuffer(value)));
}

function derLength(length: number): Bytes {
  if (length < 0x80) return Uint8Array.of(length);
  const octets: number[] = [];
  for (let remaining = length; remaining > 0; remaining >>>= 8) octets.unshift(remaining & 0xff);
  return Uint8Array.of(0x80 | octets.length, ...octets);
}

function der(tag: number, content: Bytes): Bytes {
  return concat(Uint8Array.of(tag), derLength(content.length), content);
}

/** Apple nonce extension value: SEQUENCE { [1] EXPLICIT OCTET STRING nonce }. */
function appleNonceDER(nonce: Bytes): Bytes {
  return der(0x30, der(0xa1, der(0x04, nonce)));
}

function uint32LE(value: number): Bytes {
  const bytes = new Uint8Array(4);
  new DataView(bytes.buffer).setUint32(0, value, true);
  return bytes;
}

function uint32BE(value: number): Bytes {
  const bytes = new Uint8Array(4);
  new DataView(bytes.buffer).setUint32(0, value, false);
  return bytes;
}

function aaguid(environment: AppAttestConfig['environment']): Bytes {
  return environment === 'production'
    ? concat(encoder.encode('appattest'), new Uint8Array(7))
    : encoder.encode('appattestdevelop');
}

async function generateEcKeyPair(curve: 'P-256' | 'P-384'): Promise<CryptoKeyPair> {
  return crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: curve }, true, ['sign', 'verify']) as Promise<CryptoKeyPair>;
}

function rawEcdsaToDer(raw: Bytes): Bytes {
  if (raw.length !== 64) throw new Error(`Expected a 64-byte P-256 WebCrypto signature, got ${raw.length}`);
  const integer = (part: Bytes) => {
    let first = 0;
    while (first < part.length - 1 && part[first] === 0) first++;
    const magnitude = part.subarray(first);
    return der(0x02, magnitude[0] & 0x80 ? concat(Uint8Array.of(0), magnitude) : magnitude);
  };
  return der(0x30, concat(integer(raw.subarray(0, 32)), integer(raw.subarray(32))));
}

export interface AttestationFixtureOptions {
  config?: AppAttestConfig;
  clientDataHash?: Bytes;
  /** Hash this app ID into authData instead of config.appId. */
  rpId?: string;
  /** Change the AAGUID independently from the expected environment. */
  aaguid?: Bytes;
  flags?: number;
  counter?: number;
  credentialId?: Bytes;
  keyId?: string;
  coseKey?: Map<number, unknown>;
  includeExtensions?: boolean;
  validationCategory?: number;
  bundleVersion?: string;
  nonceValue?: Bytes;
  malformedNonceDER?: boolean;
  corruptLeafCertificateDER?: boolean;
  leafSignatureFromWrongKey?: boolean;
  leafIsCa?: boolean;
  intermediateIsCa?: boolean;
  leafKeyUsage?: number;
  intermediateKeyUsage?: number;
  /** One path length per intermediate, ordered from root toward the leaf. */
  intermediatePathLengths?: Array<number | undefined>;
  /** Number of intermediates, allowing path-length cases to be represented. */
  intermediateCount?: number;
  expiredCertificate?: 'leaf' | 'intermediate' | 'root';
  untrustedRoot?: boolean;
}

export interface AttestationFixture {
  input: {
    attestation: string;
    keyId: string;
    clientDataHash: Bytes;
    config: AppAttestConfig;
    now: Date;
  };
  trustAnchorDER: Bytes;
  authData: Bytes;
  leafCertificateDER: Bytes;
  intermediateCertificateDER: Bytes;
  publicKeySPKI: string;
  keyId: string;
}

export async function buildAttestationFixture(options: AttestationFixtureOptions = {}): Promise<AttestationFixture> {
  const config = options.config ?? { appId: 'ABCDE12345.jp.kakeimatch.ios', environment: 'development' as const };
  const clientDataHash = options.clientDataHash?.slice() ?? new Uint8Array(32).fill(0x5a);
  const now = TEST_NOW;
  const leafKeys = await generateEcKeyPair('P-256');
  const leafPublicKey = new Uint8Array(await crypto.subtle.exportKey('raw', leafKeys.publicKey));
  const computedKeyId = base64(await sha256(leafPublicKey));
  const keyId = options.keyId ?? computedKeyId;
  const credentialId = options.credentialId?.slice() ?? Uint8Array.from(atob(computedKeyId), char => char.charCodeAt(0));
  const coseKey = options.coseKey ?? new Map<number, unknown>([
    [1, 2],
    [3, -7],
    [-1, 1],
    [-2, leafPublicKey.slice(1, 33)],
    [-3, leafPublicKey.slice(33, 65)],
  ]);
  const includeExtensions = options.includeExtensions ?? true;
  const flags = options.flags ?? (includeExtensions ? 0xc0 : 0x40);
  const extensionMap = {
    apple_validation_category_01: uint32LE(options.validationCategory ?? (config.environment === 'development' ? 3 : 4)),
    apple_bundle_version_01: options.bundleVersion ?? '1',
  };
  const encodedCose = encode(coseKey);
  const encodedExtensions = includeExtensions ? encode(extensionMap) : new Uint8Array();
  const appIdHash = await sha256(encoder.encode(options.rpId ?? config.appId));
  const authData = concat(
    appIdHash,
    Uint8Array.of(flags),
    uint32BE(options.counter ?? 0),
    options.aaguid?.slice() ?? aaguid(config.environment),
    Uint8Array.of((credentialId.length >>> 8) & 0xff, credentialId.length & 0xff),
    credentialId,
    encodedCose,
    encodedExtensions,
  );
  const expectedNonce = await sha256(concat(authData, clientDataHash));
  const nonceValue = options.nonceValue?.slice() ?? expectedNonce;
  const validNonceDER = appleNonceDER(nonceValue);
  const nonceDER = options.malformedNonceDER ? validNonceDER.slice(0, -1) : validNonceDER;

  const intermediateCount = options.intermediateCount ?? 1;
  if (!Number.isInteger(intermediateCount) || intermediateCount < 1 || intermediateCount > 4) {
    throw new Error('intermediateCount must be between 1 and 4');
  }
  const rootKeys = await generateEcKeyPair('P-384');
  const rootName = 'CN=App Attest Synthetic Root';
  const rootExpired = options.expiredCertificate === 'root';
  const root = await X509CertificateGenerator.createSelfSigned({
    name: rootName,
    keys: rootKeys,
    notBefore: VALID_FROM,
    notAfter: rootExpired ? new Date('2029-12-31T23:59:59.000Z') : VALID_UNTIL,
    signingAlgorithm: { name: 'ECDSA', hash: 'SHA-384' },
    extensions: [
      new BasicConstraintsExtension(true, intermediateCount, true),
      new KeyUsagesExtension(KeyUsageFlags.keyCertSign | KeyUsageFlags.cRLSign, true),
    ],
  });

  const intermediates: Array<{ cert: Awaited<ReturnType<typeof X509CertificateGenerator.create>>; keys: CryptoKeyPair; name: string }> = [];
  let issuerName = rootName;
  let issuerKeys = rootKeys;
  for (let index = 0; index < intermediateCount; index++) {
    const keys = await generateEcKeyPair('P-384');
    const name = `CN=App Attest Synthetic Intermediate ${index + 1}`;
    const expired = options.expiredCertificate === 'intermediate' && index === intermediateCount - 1;
    const isCa = options.intermediateIsCa ?? true;
    const defaultPathLength = intermediateCount - index - 1;
    const pathLength = options.intermediatePathLengths?.[index] ?? defaultPathLength;
    const cert = await X509CertificateGenerator.create({
      subject: name,
      issuer: issuerName,
      publicKey: keys.publicKey,
      signingKey: issuerKeys.privateKey,
      notBefore: VALID_FROM,
      notAfter: expired ? new Date('2029-12-31T23:59:59.000Z') : VALID_UNTIL,
      signingAlgorithm: { name: 'ECDSA', hash: 'SHA-384' },
      extensions: [
        new BasicConstraintsExtension(isCa, pathLength, true),
        new KeyUsagesExtension(options.intermediateKeyUsage ?? (KeyUsageFlags.keyCertSign | KeyUsageFlags.cRLSign), true),
      ],
    });
    intermediates.push({ cert, keys, name });
    issuerName = name;
    issuerKeys = keys;
  }

  const wrongLeafSigner = options.leafSignatureFromWrongKey ? await generateEcKeyPair('P-384') : undefined;
  const leafExpired = options.expiredCertificate === 'leaf';
  const leaf = await X509CertificateGenerator.create({
    subject: 'CN=App Attest Synthetic Leaf',
    issuer: issuerName,
    publicKey: leafKeys.publicKey,
    signingKey: wrongLeafSigner?.privateKey ?? issuerKeys.privateKey,
    notBefore: VALID_FROM,
    notAfter: leafExpired ? new Date('2029-12-31T23:59:59.000Z') : VALID_UNTIL,
    signingAlgorithm: { name: 'ECDSA', hash: 'SHA-384' },
    extensions: [
      new BasicConstraintsExtension(options.leafIsCa ?? false, undefined, true),
      new KeyUsagesExtension(options.leafKeyUsage ?? KeyUsageFlags.digitalSignature, true),
      new Extension(APP_ATTEST_NONCE_OID, false, arrayBuffer(nonceDER)),
    ],
  });

  const rootDER = new Uint8Array(root.rawData);
  let trustAnchorDER = rootDER;
  if (options.untrustedRoot) {
    const unrelatedKeys = await generateEcKeyPair('P-384');
    const unrelatedRoot = await X509CertificateGenerator.createSelfSigned({
      // Deliberately reuse the issuer name while supplying the wrong root key.
      name: rootName,
      keys: unrelatedKeys,
      notBefore: VALID_FROM,
      notAfter: VALID_UNTIL,
      signingAlgorithm: { name: 'ECDSA', hash: 'SHA-384' },
      extensions: [
        new BasicConstraintsExtension(true, 4, true),
        new KeyUsagesExtension(KeyUsageFlags.keyCertSign | KeyUsageFlags.cRLSign, true),
      ],
    });
    trustAnchorDER = new Uint8Array(unrelatedRoot.rawData);
  }

  const encodedLeafDER = new Uint8Array(leaf.rawData);
  const leafDER = options.corruptLeafCertificateDER ? encodedLeafDER.slice(0, -1) : encodedLeafDER;
  const certChain = [leafDER, ...intermediates.slice().reverse().map(({ cert }) => new Uint8Array(cert.rawData))];
  const attestation = encode({
    fmt: 'apple-appattest',
    authData,
    attStmt: { x5c: certChain, receipt: Uint8Array.of(1, 2, 3, 4) },
  });
  const leafSpki = new Uint8Array(await crypto.subtle.exportKey('spki', leafKeys.publicKey));

  return {
    input: { attestation: base64(attestation), keyId, clientDataHash, config, now },
    trustAnchorDER,
    authData,
    leafCertificateDER: leafDER,
    intermediateCertificateDER: new Uint8Array(intermediates[0].cert.rawData),
    publicKeySPKI: base64(leafSpki),
    keyId: computedKeyId,
  };
}

export interface AssertionFixtureOptions {
  config?: AppAttestConfig;
  clientDataHash?: Bytes;
  rpId?: string;
  counter?: number;
  flags?: number;
}

export interface AssertionFixture {
  input: {
    assertion: string;
    publicKey: string;
    clientDataHash: Bytes;
    config: AppAttestConfig;
    counter: number;
  };
  authenticatorData: Bytes;
}

export async function buildAssertionFixture(options: AssertionFixtureOptions = {}): Promise<AssertionFixture> {
  const config = options.config ?? { appId: 'ABCDE12345.jp.kakeimatch.ios', environment: 'development' as const };
  const clientDataHash = options.clientDataHash?.slice() ?? new Uint8Array(32).fill(0x6b);
  const counter = options.counter ?? 1;
  const keyPair = await generateEcKeyPair('P-256');
  const authenticatorData = concat(
    await sha256(encoder.encode(options.rpId ?? config.appId)),
    Uint8Array.of(options.flags ?? 0),
    uint32BE(counter),
  );
  // WebCrypto hashes the complete message once using SHA-256; this must not be pre-hashed.
  const signature = rawEcdsaToDer(new Uint8Array(await crypto.subtle.sign(
    { name: 'ECDSA', hash: 'SHA-256' },
    keyPair.privateKey,
    arrayBuffer(concat(authenticatorData, clientDataHash)),
  )));
  const publicKeySPKI = new Uint8Array(await crypto.subtle.exportKey('spki', keyPair.publicKey));
  const assertion = encode({ authenticatorData, signature });
  return {
    input: {
      assertion: base64(assertion),
      publicKey: base64(publicKeySPKI),
      clientDataHash,
      config,
      counter: 0,
    },
    authenticatorData,
  };
}

export const appAttestTestNow = TEST_NOW;
export const appAttestTestConfig: AppAttestConfig = {
  appId: 'ABCDE12345.jp.kakeimatch.ios',
  environment: 'development',
};
