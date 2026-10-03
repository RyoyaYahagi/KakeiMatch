import { describe, expect, it } from 'vitest';
import {
  parseLocalScreenLockBiometric,
  verifyBiometricAssertion,
  type BiometricAssertion,
  type LocalScreenLockBiometric,
} from '../../apps/pwa/src/local-screen-lock-biometric';

const origin = 'https://kakeimatch.example';
const rpId = 'kakeimatch.example';

function base64Url(value: Uint8Array): string {
  return Buffer.from(value).toString('base64url');
}

function rawToDer(raw: Uint8Array): Uint8Array {
  const integer = (value: Uint8Array) => {
    let start = 0;
    while (start < value.length - 1 && value[start] === 0) start++;
    const trimmed = value.subarray(start);
    const padded = trimmed[0] & 0x80 ? Uint8Array.of(0, ...trimmed) : trimmed;
    return Uint8Array.of(0x02, padded.length, ...padded);
  };
  const body = Uint8Array.of(...integer(raw.subarray(0, 32)), ...integer(raw.subarray(32)));
  return Uint8Array.of(0x30, body.length, ...body);
}

async function enrolledDevice() {
  const keys = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign', 'verify']);
  const credentialId = crypto.getRandomValues(new Uint8Array(16));
  const biometric: LocalScreenLockBiometric = {
    credentialId: base64Url(credentialId),
    publicKey: base64Url(new Uint8Array(await crypto.subtle.exportKey('spki', keys.publicKey))),
    algorithm: -7,
  };
  async function assert(options: { challenge: Uint8Array; flags?: number; origin?: string; rpId?: string; type?: string }): Promise<BiometricAssertion> {
    const rpIdHash = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(options.rpId ?? rpId)));
    const authenticatorData = Uint8Array.of(...rpIdHash, options.flags ?? 0x05, 0, 0, 0, 0);
    const clientDataJSON = new TextEncoder().encode(JSON.stringify({
      type: options.type ?? 'webauthn.get',
      challenge: base64Url(options.challenge),
      origin: options.origin ?? origin,
      crossOrigin: false,
    }));
    const clientDataHash = new Uint8Array(await crypto.subtle.digest('SHA-256', clientDataJSON));
    const raw = new Uint8Array(await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, keys.privateKey, Uint8Array.of(...authenticatorData, ...clientDataHash)));
    return { credentialId, clientDataJSON, authenticatorData, signature: rawToDer(raw) };
  }
  return { biometric, assert };
}

describe('local screen lock biometric unlock', () => {
  it('accepts a user-verified assertion signed by the enrolled device key', async () => {
    const device = await enrolledDevice();
    const challenge = crypto.getRandomValues(new Uint8Array(32));
    expect(await verifyBiometricAssertion(device.biometric, { challenge, origin, rpId }, await device.assert({ challenge }))).toBe(true);
  });

  it('rejects assertions without user verification, for another challenge, origin, or RP, or of the wrong type', async () => {
    const device = await enrolledDevice();
    const challenge = crypto.getRandomValues(new Uint8Array(32));
    const expected = { challenge, origin, rpId };
    expect(await verifyBiometricAssertion(device.biometric, expected, await device.assert({ challenge, flags: 0x01 }))).toBe(false);
    expect(await verifyBiometricAssertion(device.biometric, expected, await device.assert({ challenge: new Uint8Array(32) }))).toBe(false);
    expect(await verifyBiometricAssertion(device.biometric, expected, await device.assert({ challenge, origin: 'https://evil.example' }))).toBe(false);
    expect(await verifyBiometricAssertion(device.biometric, expected, await device.assert({ challenge, rpId: 'evil.example' }))).toBe(false);
    expect(await verifyBiometricAssertion(device.biometric, expected, await device.assert({ challenge, type: 'webauthn.create' }))).toBe(false);
  });

  it('rejects a signature from another key or another credential', async () => {
    const device = await enrolledDevice();
    const other = await enrolledDevice();
    const challenge = crypto.getRandomValues(new Uint8Array(32));
    const assertion = await other.assert({ challenge });
    expect(await verifyBiometricAssertion(device.biometric, { challenge, origin, rpId }, assertion)).toBe(false);
    expect(await verifyBiometricAssertion(
      { ...device.biometric, credentialId: other.biometric.credentialId },
      { challenge, origin, rpId },
      assertion,
    )).toBe(false);
  });

  it('ignores malformed stored biometric settings', () => {
    expect(parseLocalScreenLockBiometric({ credentialId: 'a', publicKey: 'b', algorithm: -8 })).toBeUndefined();
    expect(parseLocalScreenLockBiometric('x')).toBeUndefined();
    expect(parseLocalScreenLockBiometric({ credentialId: 'a', publicKey: 'b', algorithm: -7 })).toEqual({ credentialId: 'a', publicKey: 'b', algorithm: -7 });
  });
});
