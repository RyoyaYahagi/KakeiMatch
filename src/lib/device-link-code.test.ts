import { describe, expect, it } from 'vitest';
import { decodeLinkCode, encodeLinkCode, LinkCodeError, sha256Hex } from '../../apps/pwa/src/device-link-code';

const description = ['v=0', 'o=- 1 2 IN IP4 127.0.0.1', 's=-', 't=0 0', 'a=group:BUNDLE 0',
  'a=fingerprint:sha-256 AA:BB:CC:DD:EE:FF:00:11:22:33:44:55:66:77:88:99:AA:BB:CC:DD:EE:FF:00:11:22:33:44:55:66:77:88:99',
  'm=application 9 UDP/DTLS/SCTP webrtc-datachannel', 'a=candidate:1 1 udp 2122260223 synthetic-host.local 54321 typ host', ''].join('\r\n');

describe('device link codes', () => {
  it('round-trips a session description in a compact, URL-safe code', async () => {
    const code = await encodeLinkCode('offer', description);
    expect(code).toMatch(/^KM1O\.[A-Za-z0-9_-]+$/);
    expect(code.length).toBeLessThan(description.length);
    expect(await decodeLinkCode(code, 'offer')).toBe(description);
  });

  it('ignores whitespace and line breaks added by copying', async () => {
    const code = await encodeLinkCode('answer', description);
    const wrapped = ` ${code.slice(0, 20)}\n${code.slice(20, 40)} \r\n${code.slice(40)} `;
    expect(await decodeLinkCode(wrapped, 'answer')).toBe(description);
  });

  it('explains a code read at the wrong step, a truncated code, and a foreign one', async () => {
    const offer = await encodeLinkCode('offer', description);
    await expect(decodeLinkCode(offer, 'answer')).rejects.toThrow('これは最初のコードです');
    await expect(decodeLinkCode(await encodeLinkCode('answer', description), 'offer')).rejects.toThrow('これは返事のコードです');
    await expect(decodeLinkCode(offer.slice(0, offer.length - 10), 'offer')).rejects.toBeInstanceOf(LinkCodeError);
    await expect(decodeLinkCode('https://example.test/not-a-code', 'offer')).rejects.toThrow('KakeiMatchの同期のコードではありません');
  });

  it('rejects a description without a DTLS fingerprint, which could not be authenticated', async () => {
    const unauthenticated = await encodeLinkCode('offer', description.replace(/^a=fingerprint:.*$/m, 'a=setup:actpass'));
    await expect(decodeLinkCode(unauthenticated, 'offer')).rejects.toThrow('コードの内容を確認できません');
  });

  it('hashes snapshot bytes for the transfer check', async () => {
    expect(await sha256Hex(new TextEncoder().encode('abc').buffer as ArrayBuffer)).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  });
});
