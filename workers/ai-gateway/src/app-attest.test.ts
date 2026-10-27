import { describe, expect, it } from 'vitest';
import { decode, encode } from 'cbor-x';
import { verifyAssertion, verifyAttestation } from './app-attest';
import {
  appAttestTestConfig,
  buildAssertionFixture,
  buildAttestationFixture,
  type AppAttestConfig,
} from './test-support/app-attest-fixture';

const b64 = (value: Uint8Array) => {
  let binary = '';
  for (let offset = 0; offset < value.length; offset += 0x8000) {
    binary += String.fromCharCode(...value.subarray(offset, offset + 0x8000));
  }
  return btoa(binary);
};

const fromB64 = (value: string) => Uint8Array.from(atob(value), char => char.charCodeAt(0));
const otherConfig = (config: AppAttestConfig): AppAttestConfig => ({ ...config, appId: 'FGHIJ67890.jp.kakeimatch.ios' });

async function assertAttestationRejected(options: Parameters<typeof buildAttestationFixture>[0], config?: AppAttestConfig) {
  const fixture = await buildAttestationFixture(options);
  await expect(verifyAttestation(
    config ? { ...fixture.input, config } : fixture.input,
    fixture.trustAnchorDER,
  )).rejects.toThrow();
}

describe('App Attest attestation verification', () => {
  it.each(['development', 'production'] as const)('accepts a valid %s attestation and synthetic certificate chain', async environment => {
    const config = { ...appAttestTestConfig, environment };
    const fixture = await buildAttestationFixture({ config });

    const result = await verifyAttestation(fixture.input, fixture.trustAnchorDER);

    expect(result.publicKey).toBe(fixture.publicKeySPKI);
    expect(result.receipt).toBe('AQIDBA==');
  });

  it.each([2, 4, 5])('accepts production validation category %i', async validationCategory => {
    const config = { ...appAttestTestConfig, environment: 'production' as const };
    const fixture = await buildAttestationFixture({ config, validationCategory });
    await expect(verifyAttestation(fixture.input, fixture.trustAnchorDER)).resolves.toMatchObject({
      publicKey: fixture.publicKeySPKI,
    });
  });

  it('rejects malformed base64 before parsing', async () => {
    const fixture = await buildAttestationFixture();
    await expect(verifyAttestation({ ...fixture.input, attestation: 'not base64!' }, fixture.trustAnchorDER)).rejects.toThrow();
  });

  it('rejects non-CBOR attestation objects', async () => {
    const fixture = await buildAttestationFixture();
    await expect(verifyAttestation({ ...fixture.input, attestation: b64(new TextEncoder().encode('no-cbor')) }, fixture.trustAnchorDER)).rejects.toThrow();
  });

  it('rejects a certificate whose signature was made by a different issuer key', async () => {
    await assertAttestationRejected({ leafSignatureFromWrongKey: true });
  });

  it('rejects a certificate chain that does not terminate at the supplied trust anchor', async () => {
    await assertAttestationRejected({ untrustedRoot: true });
  });

  it('rejects expired leaf and intermediate certificates', async () => {
    await assertAttestationRejected({ expiredCertificate: 'leaf' });
    await assertAttestationRejected({ expiredCertificate: 'intermediate' });
  });

  it('rejects an expired trust anchor', async () => {
    await assertAttestationRejected({ expiredCertificate: 'root' });
  });

  it('rejects invalid CA constraints on the leaf and intermediate', async () => {
    await assertAttestationRejected({ leafIsCa: true });
    await assertAttestationRejected({ intermediateIsCa: false });
  });

  it('enforces intermediate path length when the chain has multiple CAs', async () => {
    await assertAttestationRejected({ intermediateCount: 2, intermediatePathLengths: [0, 0] });
  });

  it('requires leaf digitalSignature and CA keyCertSign usages', async () => {
    await assertAttestationRejected({ leafKeyUsage: 0 });
    await assertAttestationRejected({ intermediateKeyUsage: 0 });
  });

  it('rejects a nonce extension that does not bind authData and clientDataHash', async () => {
    await assertAttestationRejected({ nonceValue: new Uint8Array(32).fill(0x33) });
  });

  it('rejects malformed nonce extension ASN.1', async () => {
    await assertAttestationRejected({ malformedNonceDER: true });
  });

  it('rejects malformed certificate ASN.1', async () => {
    await assertAttestationRejected({ corruptLeafCertificateDER: true });
  });

  it('rejects a mismatched App ID and environment AAGUID', async () => {
    const fixture = await buildAttestationFixture();
    await expect(verifyAttestation({ ...fixture.input, config: otherConfig(fixture.input.config) }, fixture.trustAnchorDER)).rejects.toThrow();

    const productionConfig = { ...fixture.input.config, environment: 'production' as const };
    await expect(verifyAttestation({ ...fixture.input, config: productionConfig }, fixture.trustAnchorDER)).rejects.toThrow();
  });

  it('rejects an unsupported validation category for the development environment', async () => {
    const fixture = await buildAttestationFixture({ validationCategory: 2 });
    await expect(verifyAttestation(fixture.input, fixture.trustAnchorDER)).rejects.toThrow();
  });

  it('rejects a mismatched keyId while keeping it valid base64', async () => {
    const fixture = await buildAttestationFixture({ keyId: b64(new Uint8Array(32).fill(0x44)) });
    await expect(verifyAttestation(fixture.input, fixture.trustAnchorDER)).rejects.toThrow();
  });

  it('rejects a COSE key that does not match the leaf public key', async () => {
    const fixture = await buildAttestationFixture({
      coseKey: new Map<number, unknown>([[1, 2], [3, -7], [-1, 1], [-2, new Uint8Array(32).fill(0x21)], [-3, new Uint8Array(32).fill(0x22)]]),
    });
    await expect(verifyAttestation(fixture.input, fixture.trustAnchorDER)).rejects.toThrow();
  });

  it('rejects an invalid COSE algorithm or curve description', async () => {
    const fixture = await buildAttestationFixture({
      coseKey: new Map<number, unknown>([[1, 2], [3, -257], [-1, 1], [-2, new Uint8Array(32)], [-3, new Uint8Array(32)]]),
    });
    await expect(verifyAttestation(fixture.input, fixture.trustAnchorDER)).rejects.toThrow();
  });

  it('rejects a credential ID that differs from the keyId digest', async () => {
    const fixture = await buildAttestationFixture({ credentialId: new Uint8Array(32).fill(0x55) });
    await expect(verifyAttestation(fixture.input, fixture.trustAnchorDER)).rejects.toThrow();
  });

  it('requires the initial attestation counter to be zero', async () => {
    await assertAttestationRejected({ counter: 1 });
  });

  it('requires the attested-credential flag in authenticatorData', async () => {
    await assertAttestationRejected({ flags: 0x00 });
  });

  it('rejects extension data when the authenticator extension flag is absent', async () => {
    await assertAttestationRejected({ flags: 0x40, includeExtensions: true });
  });
});

describe('App Attest assertion verification', () => {
  it('accepts a valid assertion signed over authenticatorData || clientDataHash', async () => {
    const fixture = await buildAssertionFixture();

    await expect(verifyAssertion(fixture.input)).resolves.toEqual({ counter: 1 });
  });

  it('rejects malformed base64 and non-CBOR assertion objects', async () => {
    const fixture = await buildAssertionFixture();
    await expect(verifyAssertion({ ...fixture.input, assertion: 'not base64!' })).rejects.toThrow();
    await expect(verifyAssertion({ ...fixture.input, assertion: b64(new TextEncoder().encode('no-cbor')) })).rejects.toThrow();
  });

  it('rejects a tampered DER assertion signature', async () => {
    const fixture = await buildAssertionFixture();
    const object = decode(fromB64(fixture.input.assertion)) as { authenticatorData: Uint8Array; signature: Uint8Array };
    const tamperedSignature = object.signature.slice();
    tamperedSignature[tamperedSignature.length - 1] ^= 1;
    const assertion = b64(encode({ ...object, signature: tamperedSignature }));
    await expect(verifyAssertion({ ...fixture.input, assertion })).rejects.toThrow();
  });

  it('rejects a replayed or non-increasing counter', async () => {
    const fixture = await buildAssertionFixture();
    await expect(verifyAssertion({ ...fixture.input, counter: 1 })).rejects.toThrow();
    await expect(verifyAssertion({ ...fixture.input, counter: 2 })).rejects.toThrow();
  });

  it('rejects a changed clientDataHash', async () => {
    const fixture = await buildAssertionFixture();
    const differentHash = fixture.input.clientDataHash.slice();
    differentHash[0] ^= 1;
    await expect(verifyAssertion({ ...fixture.input, clientDataHash: differentHash })).rejects.toThrow();
  });

  it('rejects an assertion for a different App ID', async () => {
    const fixture = await buildAssertionFixture();
    await expect(verifyAssertion({ ...fixture.input, config: otherConfig(fixture.input.config) })).rejects.toThrow();
  });

  it('rejects authenticatorData with a zero counter or a non-assertion flag', async () => {
    const zeroCounter = await buildAssertionFixture({ counter: 0 });
    await expect(verifyAssertion(zeroCounter.input)).rejects.toThrow();

    const invalidFlags = await buildAssertionFixture({ flags: 0x40 });
    await expect(verifyAssertion(invalidFlags.input)).rejects.toThrow();
  });

  it('rejects a structurally invalid assertion payload', async () => {
    const fixture = await buildAssertionFixture();
    const malformed = b64(encode({ authenticatorData: new Uint8Array(), signature: new Uint8Array() }));
    await expect(verifyAssertion({ ...fixture.input, assertion: malformed })).rejects.toThrow();
  });
});
