// Optional biometric unlock for the local screen lock. The platform authenticator
// performs user verification; the assertion is checked on this device against the
// public key saved at enrollment, so unlocking works offline and never reaches the
// Cloud account passkey endpoints.

const ES256 = -7;
const RS256 = -257;
const TIMEOUT_MS = 60_000;

export type LocalScreenLockBiometric = {
  credentialId: string;
  publicKey: string;
  algorithm: typeof ES256 | typeof RS256;
};

export type BiometricAssertion = {
  credentialId: Uint8Array;
  clientDataJSON: Uint8Array;
  authenticatorData: Uint8Array;
  signature: Uint8Array;
};

export type BiometricExpectation = {
  challenge: Uint8Array;
  origin: string;
  rpId: string;
};

function toBase64Url(value: Uint8Array): string {
  let binary = '';
  for (const byte of value) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
}

function fromBase64Url(value: string): Uint8Array<ArrayBuffer> {
  const binary = atob(value.replaceAll('-', '+').replaceAll('_', '/'));
  return Uint8Array.from(binary, character => character.charCodeAt(0));
}

function copy(value: Uint8Array): Uint8Array<ArrayBuffer> {
  const buffer = new ArrayBuffer(value.length);
  new Uint8Array(buffer).set(value);
  return new Uint8Array(buffer);
}

function equalBytes(left: Uint8Array, right: Uint8Array): boolean {
  if (left.length !== right.length) return false;
  let difference = 0;
  for (let index = 0; index < left.length; index++) difference |= left[index] ^ right[index];
  return difference === 0;
}

async function sha256(value: Uint8Array): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.digest('SHA-256', copy(value)));
}

// WebAuthn returns ECDSA signatures as DER, while WebCrypto expects raw r||s.
function derToRawEcdsa(signature: Uint8Array): Uint8Array | null {
  if (signature[0] !== 0x30 || signature.length < 8) return null;
  let offset = 2;
  const integers: Uint8Array[] = [];
  for (let index = 0; index < 2; index++) {
    if (signature[offset] !== 0x02) return null;
    const length = signature[offset + 1];
    const start = offset + 2;
    if (start + length > signature.length) return null;
    let value = signature.subarray(start, start + length);
    while (value.length > 32 && value[0] === 0) value = value.subarray(1);
    if (value.length > 32) return null;
    integers.push(value);
    offset = start + length;
  }
  const raw = new Uint8Array(64);
  raw.set(integers[0], 32 - integers[0].length);
  raw.set(integers[1], 64 - integers[1].length);
  return raw;
}

export function parseLocalScreenLockBiometric(value: unknown): LocalScreenLockBiometric | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  const row = value as Partial<LocalScreenLockBiometric>;
  if (typeof row.credentialId !== 'string' || typeof row.publicKey !== 'string'
    || (row.algorithm !== ES256 && row.algorithm !== RS256)) return undefined;
  return { credentialId: row.credentialId, publicKey: row.publicKey, algorithm: row.algorithm };
}

export async function verifyBiometricAssertion(
  biometric: LocalScreenLockBiometric,
  expected: BiometricExpectation,
  assertion: BiometricAssertion,
): Promise<boolean> {
  if (!equalBytes(assertion.credentialId, fromBase64Url(biometric.credentialId))) return false;
  let clientData: { type?: unknown; challenge?: unknown; origin?: unknown; crossOrigin?: unknown };
  try {
    clientData = JSON.parse(new TextDecoder().decode(assertion.clientDataJSON)) as typeof clientData;
  } catch {
    return false;
  }
  if (clientData.type !== 'webauthn.get' || clientData.challenge !== toBase64Url(expected.challenge)
    || clientData.origin !== expected.origin || clientData.crossOrigin === true) return false;
  const authenticatorData = assertion.authenticatorData;
  if (authenticatorData.length < 37) return false;
  const rpIdHash = await sha256(new TextEncoder().encode(expected.rpId));
  if (!equalBytes(authenticatorData.subarray(0, 32), rpIdHash)) return false;
  const flags = authenticatorData[32];
  const userPresent = (flags & 0x01) !== 0;
  const userVerified = (flags & 0x04) !== 0;
  if (!userPresent || !userVerified) return false;

  const clientDataHash = await sha256(assertion.clientDataJSON);
  const signed = new Uint8Array(authenticatorData.length + clientDataHash.length);
  signed.set(authenticatorData);
  signed.set(clientDataHash, authenticatorData.length);
  if (biometric.algorithm === ES256) {
    const signature = derToRawEcdsa(assertion.signature);
    if (!signature) return false;
    const key = await crypto.subtle.importKey('spki', fromBase64Url(biometric.publicKey), { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify']);
    return crypto.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, key, copy(signature), signed);
  }
  const key = await crypto.subtle.importKey('spki', fromBase64Url(biometric.publicKey), { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['verify']);
  return crypto.subtle.verify('RSASSA-PKCS1-v1_5', key, copy(assertion.signature), signed);
}

export async function isBiometricUnlockAvailable(): Promise<boolean> {
  if (typeof PublicKeyCredential === 'undefined' || !window.isSecureContext) return false;
  try {
    return await PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable();
  } catch {
    return false;
  }
}

export async function registerBiometricUnlock(existing?: LocalScreenLockBiometric): Promise<LocalScreenLockBiometric> {
  const credential = await navigator.credentials.create({
    publicKey: {
      rp: { name: 'KakeiMatch 画面ロック' },
      user: {
        id: crypto.getRandomValues(new Uint8Array(16)),
        name: 'KakeiMatch 画面ロック（この端末）',
        displayName: 'KakeiMatch 画面ロック（この端末）',
      },
      challenge: crypto.getRandomValues(new Uint8Array(32)),
      pubKeyCredParams: [{ type: 'public-key', alg: ES256 }, { type: 'public-key', alg: RS256 }],
      authenticatorSelection: { authenticatorAttachment: 'platform', residentKey: 'discouraged', userVerification: 'required' },
      attestation: 'none',
      timeout: TIMEOUT_MS,
      excludeCredentials: existing ? [{ type: 'public-key', id: fromBase64Url(existing.credentialId) }] : [],
    },
  });
  if (!(credential instanceof PublicKeyCredential) || !(credential.response instanceof AuthenticatorAttestationResponse)) {
    throw new Error('生体認証を登録できませんでした。');
  }
  const publicKey = credential.response.getPublicKey();
  const algorithm = credential.response.getPublicKeyAlgorithm();
  if (!publicKey || (algorithm !== ES256 && algorithm !== RS256)) {
    throw new Error('この端末の生体認証には対応していません。');
  }
  return {
    credentialId: toBase64Url(new Uint8Array(credential.rawId)),
    publicKey: toBase64Url(new Uint8Array(publicKey)),
    algorithm,
  };
}

export async function verifyBiometricUnlock(biometric: LocalScreenLockBiometric): Promise<boolean> {
  const challenge = crypto.getRandomValues(new Uint8Array(32));
  const credential = await navigator.credentials.get({
    publicKey: {
      challenge,
      allowCredentials: [{ type: 'public-key', id: fromBase64Url(biometric.credentialId) }],
      userVerification: 'required',
      timeout: TIMEOUT_MS,
    },
  });
  if (!(credential instanceof PublicKeyCredential) || !(credential.response instanceof AuthenticatorAssertionResponse)) return false;
  return verifyBiometricAssertion(biometric, { challenge, origin: location.origin, rpId: location.hostname }, {
    credentialId: new Uint8Array(credential.rawId),
    clientDataJSON: new Uint8Array(credential.response.clientDataJSON),
    authenticatorData: new Uint8Array(credential.response.authenticatorData),
    signature: new Uint8Array(credential.response.signature),
  });
}
