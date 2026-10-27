import 'reflect-metadata';
import { Decoder } from 'cbor-x';
import { AsnEcSignatureFormatter, BasicConstraintsExtension, KeyUsagesExtension, KeyUsageFlags, X509Certificate } from '@peculiar/x509';

export interface AppAttestConfig { appId: string; environment: 'production' | 'development' }
type AttestInput = { attestation: string; keyId: string; clientDataHash: Uint8Array; config: AppAttestConfig; now?: Date };
type AssertionInput = { assertion: string; publicKey: string; clientDataHash: Uint8Array; config: AppAttestConfig; counter: number };
type Bytes = Uint8Array;

// Public trust anchor, not a secret. Downloaded 2026-10-26 from:
// https://www.apple.com/certificateauthority/Apple_App_Attestation_Root_CA.pem
// SHA-256: 1C:B9:82:3B:A2:8B:A6:AD:2D:33:A0:06:94:1D:E2:AE:4F:51:3E:F1:D4:E8:31:B9:F7:E0:FA:7B:62:42:C9:32
const APPLE_ROOT = 'MIICITCCAaegAwIBAgIQC/O+DvHN0uD7jG5yH2IXmDAKBggqhkjOPQQDAzBSMSYwJAYDVQQDDB1BcHBsZSBBcHAgQXR0ZXN0YXRpb24gUm9vdCBDQTETMBEGA1UECgwKQXBwbGUgSW5jLjETMBEGA1UECAwKQ2FsaWZvcm5pYTAeFw0yMDAzMTgxODMyNTNaFw00NTAzMTUwMDAwMDBaMFIxJjAkBgNVBAMMHUFwcGxlIEFwcCBBdHRlc3RhdGlvbiBSb290IENBMRMwEQYDVQQKDApBcHBsZSBJbmMuMRMwEQYDVQQIDApDYWxpZm9ybmlhMHYwEAYHKoZIzj0CAQYFK4EEACIDYgAERTHhmLW07ATaFQIEVwTtT4dyctdhNbJhFs/Ii2FdCgAHGbpphY3+d8qjuDngIN3WVhQUBHAoMeQ/cLiP1sOUtgjqK9auYen1mMEvRq9Sk3Jm5X8U62H+xTD3FE9TgS41o0IwQDAPBgNVHRMBAf8EBTADAQH/MB0GA1UdDgQWBBSskRBTM72+aEH/pwyp5frq5eWKoTAOBgNVHQ8BAf8EBAMCAQYwCgYIKoZIzj0EAwMDaAAwZQIwQgFGnByvsiVbpTKwSga0kP0e8EeDS4+sQmTvb7vn53O5+FRXgeLhpJ06ysC5PrOyAjEAp5U4xDgEgllF7En3VcE3iexZZtKeYnpqtijVoyFraWVIyd/dganmrduC1bmTBGwD';
const decoder = new Decoder({ mapsAsObjects: false, useRecords: false });
const signatureFormatter = new AsnEcSignatureFormatter();
const ec = { name: 'ECDSA', namedCurve: 'P-256' };
const utf8 = new TextEncoder();
const b64encode = (v: Bytes) => btoa(String.fromCharCode(...v));
const b64 = (v: unknown, max = 64 * 1024): Bytes => {
  if (typeof v !== 'string' || !v.length || v.length > max || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(v)) throw new Error('invalid_base64');
  const out = Uint8Array.from(atob(v), c => c.charCodeAt(0));
  if (b64encode(out) !== v) throw new Error('invalid_base64');
  return out;
};
const ab = (v: Bytes): ArrayBuffer => v.slice().buffer as ArrayBuffer;
const sha = async (v: Bytes) => new Uint8Array(await crypto.subtle.digest('SHA-256', ab(v)));
const equal = (a: Bytes, b: Bytes) => a.length === b.length && a.every((v, i) => v === b[i]);
const cat = (...parts: Bytes[]) => { const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0)); let i = 0; for (const p of parts) { out.set(p, i); i += p.length; } return out; };
function map(value: unknown): Map<unknown, unknown> { if (!(value instanceof Map)) throw new Error('invalid_cbor_map'); return value; }
function bytes(value: unknown): Bytes { if (!(value instanceof Uint8Array)) throw new Error('invalid_bytes'); return value; }
function exactKeys(value: Map<unknown, unknown>, keys: string[]) {
  if (value.size !== keys.length || keys.some(k => !value.has(k))) throw new Error('invalid_cbor_shape');
}
function configValid(config: AppAttestConfig) {
  if (!/^[A-Z0-9]{10}\.jp\.kakeimatch\.ios$/.test(config.appId) || !['production', 'development'].includes(config.environment)) throw new Error('invalid_config');
}
function nonceOctet(data: Bytes): Bytes {
  // Apple's exact DER schema: SEQUENCE { [1] EXPLICIT OCTET STRING (SIZE(32)) }.
  // Fixed lengths avoid writing a general ASN.1 parser or accepting BER ambiguity.
  if (data.length !== 38 || !equal(data.slice(0, 6), Uint8Array.of(0x30, 0x24, 0xa1, 0x22, 0x04, 0x20))) throw new Error('invalid_nonce_der');
  return data.slice(6);
}
function validateExtensions(value: unknown, config: AppAttestConfig) {
  const ext = map(value);
  const categoryBytes = bytes(ext.get('apple_validation_category_01'));
  const version = ext.get('apple_bundle_version_01');
  if (categoryBytes.length !== 4) throw new Error('invalid_validation_category');
  const category = new DataView(categoryBytes.buffer, categoryBytes.byteOffset, 4).getUint32(0, true);
  const allowed = config.environment === 'development' ? [3] : [2, 4, 5];
  if (!allowed.includes(category)) throw new Error('invalid_validation_category');
  // No minimum-version rollout policy yet; validate the signed version, never use it as identity.
  if (typeof version !== 'string' || !/^\d{1,10}(?:\.\d{1,10}){0,2}$/.test(version)) throw new Error('invalid_bundle_version');
}
function authData(input: Bytes, config: AppAttestConfig, requireCredential: boolean) {
  if (input.length < 37 || input.length > 4096) throw new Error('invalid_auth_data');
  const flags = input[32];
  // App Attest is not a user-verification ceremony. Only AT and ED flags apply.
  if (flags & ~0xc0 || Boolean(flags & 0x40) !== requireCredential) throw new Error('invalid_auth_flags');
  const appHash = input.slice(0, 32);
  const counter = new DataView(input.buffer, input.byteOffset + 33, 4).getUint32(0, false);
  if (requireCredential) {
    if (input.length < 87) throw new Error('missing_attested_credential');
    const aaguid = config.environment === 'production' ? cat(utf8.encode('appattest'), new Uint8Array(7)) : utf8.encode('appattestdevelop');
    if (!equal(input.slice(37, 53), aaguid)) throw new Error('wrong_environment');
    const length = new DataView(input.buffer, input.byteOffset + 53, 2).getUint16(0, false);
    if (length !== 32 || input.length <= 55 + length) throw new Error('invalid_credential_id');
    const trailing = decoder.decodeMultiple(input.slice(55 + length)) as unknown[];
    if (trailing.length !== (flags & 0x80 ? 2 : 1)) throw new Error('invalid_auth_trailing_data');
    if (flags & 0x80) validateExtensions(trailing[1], config);
    return { appHash, counter, credentialId: input.slice(55, 55 + length), cose: trailing[0] };
  }
  if (flags & 0x80) validateExtensions(decoder.decode(input.slice(37)), config);
  else if (input.length !== 37) throw new Error('invalid_auth_trailing_data');
  return { appHash, counter };
}
async function verifyChain(encoded: unknown, anchor: string | Uint8Array | undefined, now: Date) {
  if (!Array.isArray(encoded) || encoded.length < 2 || encoded.length > 4 || !Number.isFinite(now.getTime())) throw new Error('invalid_chain');
  const certs = encoded.map(item => { const der = bytes(item); if (der.length > 8192) throw new Error('invalid_certificate'); return new X509Certificate(ab(der)); });
  const root = new X509Certificate(ab(anchor instanceof Uint8Array ? anchor : b64(anchor ?? APPLE_ROOT)));
  const chain = [...certs, root];
  for (let i = 0; i < chain.length; i++) {
    const cert = chain[i];
    if (now < cert.notBefore || now > cert.notAfter) throw new Error('certificate_expired');
    if (new Set(cert.extensions.map(ext => ext.type)).size !== cert.extensions.length) throw new Error('duplicate_certificate_extension');
    const constraints = cert.getExtension(BasicConstraintsExtension);
    const usage = cert.getExtension(KeyUsagesExtension);
    if (i === 0) {
      if (constraints?.ca || !usage || !(usage.usages & KeyUsageFlags.digitalSignature) || usage.usages & KeyUsageFlags.keyCertSign) throw new Error('invalid_leaf_constraints');
    } else {
      if (!constraints?.ca || !usage || !(usage.usages & KeyUsageFlags.keyCertSign)) throw new Error('invalid_ca');
      if (constraints.pathLength !== undefined && constraints.pathLength < i - 1) throw new Error('invalid_path_length');
    }
    const knownCritical = ['2.5.29.19', '2.5.29.15', '2.5.29.37', '2.5.29.14', '2.5.29.35'];
    if (cert.extensions.some(ext => ext.critical && !knownCritical.includes(ext.type))) throw new Error('unsupported_critical_extension');
    const algorithm = cert.signatureAlgorithm;
    if (algorithm.name !== 'ECDSA' || !['SHA-256', 'SHA-384'].includes(algorithm.hash?.name ?? '')) throw new Error('invalid_certificate_algorithm');
    const issuer = chain[i + 1] ?? root;
    if (cert.issuer !== issuer.subject || !await cert.verify({ publicKey: issuer.publicKey, date: now })) throw new Error('invalid_certificate_signature');
  }
  return certs[0];
}
function coseKey(value: unknown): { x: Bytes; y: Bytes } {
  const cose = map(value);
  if (cose.size !== 5 || cose.get(1) !== 2 || cose.get(3) !== -7 || cose.get(-1) !== 1) throw new Error('invalid_cose_key');
  const x = bytes(cose.get(-2)), y = bytes(cose.get(-3));
  if (x.length !== 32 || y.length !== 32) throw new Error('invalid_cose_key');
  return { x, y };
}

/** Trust-anchor injection is for synthetic unit tests only. No HTTP/binding can supply it. */
export async function verifyAttestation(input: AttestInput, testTrustAnchor?: string | Uint8Array): Promise<{ publicKey: string; receipt: string }> {
  configValid(input.config);
  if (input.clientDataHash.length !== 32 || !/^[A-Za-z0-9+/]{43}=$/.test(input.keyId)) throw new Error('invalid_input');
  const outer = map(decoder.decode(b64(input.attestation)));
  exactKeys(outer, ['fmt', 'attStmt', 'authData']);
  if (outer.get('fmt') !== 'apple-appattest') throw new Error('invalid_format');
  const stmt = map(outer.get('attStmt')); exactKeys(stmt, ['x5c', 'receipt']);
  const auth = bytes(outer.get('authData'));
  const cert = await verifyChain(stmt.get('x5c'), testTrustAnchor, input.now ?? new Date());
  const parsed = authData(auth, input.config, true);
  if (!equal(parsed.appHash, await sha(utf8.encode(input.config.appId))) || parsed.counter !== 0) throw new Error('invalid_authenticator_data');
  const ext = cert.getExtension('1.2.840.113635.100.8.2');
  if (!ext || !equal(nonceOctet(new Uint8Array(ext.value)), await sha(cat(auth, input.clientDataHash)))) throw new Error('invalid_nonce');
  const publicKey = await cert.publicKey.export(ec, ['verify']);
  const spki = new Uint8Array(await crypto.subtle.exportKey('spki', publicKey));
  const raw = new Uint8Array(await crypto.subtle.exportKey('raw', publicKey));
  if (raw.length !== 65 || raw[0] !== 4 || b64encode(await sha(raw)) !== input.keyId || !equal(parsed.credentialId!, b64(input.keyId))) throw new Error('invalid_key_id');
  const cose = coseKey(parsed.cose);
  if (!equal(cose.x, raw.slice(1, 33)) || !equal(cose.y, raw.slice(33, 65))) throw new Error('cose_key_mismatch');
  const receipt = bytes(stmt.get('receipt'));
  if (!receipt.length || receipt.length > 32768) throw new Error('invalid_receipt');
  return { publicKey: b64encode(spki), receipt: b64encode(receipt) };
}
export async function verifyAssertion(input: AssertionInput): Promise<{ counter: number }> {
  configValid(input.config);
  if (input.clientDataHash.length !== 32 || !Number.isSafeInteger(input.counter) || input.counter < 0 || input.counter > 0xffffffff) throw new Error('invalid_input');
  const outer = map(decoder.decode(b64(input.assertion, 10000))); exactKeys(outer, ['authenticatorData', 'signature']);
  const auth = bytes(outer.get('authenticatorData')), signature = bytes(outer.get('signature'));
  const parsed = authData(auth, input.config, false);
  if (!equal(parsed.appHash, await sha(utf8.encode(input.config.appId))) || parsed.counter <= input.counter) throw new Error('invalid_assertion_counter_or_app');
  const key = await crypto.subtle.importKey('spki', ab(b64(input.publicKey, 1024)), ec, false, ['verify']);
  if (signature.length < 8 || signature.length > 72) throw new Error('invalid_assertion_signature');
  const webSignature = signatureFormatter.toWebSignature(ec, ab(signature));
  if (!webSignature || !equal(new Uint8Array(signatureFormatter.toAsnSignature(ec, webSignature)!), signature)) throw new Error('noncanonical_signature');
  // Apple signs nonce=SHA256(authenticatorData || clientDataHash). WebCrypto's
  // ECDSA SHA-256 hashes its input: pass the composite, not the already-hashed nonce.
  if (!await crypto.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, key, webSignature, ab(cat(auth, input.clientDataHash)))) throw new Error('invalid_assertion_signature');
  return { counter: parsed.counter };
}
