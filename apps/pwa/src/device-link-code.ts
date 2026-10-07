// The connection codes that two devices exchange by QR code or by copying text.
// A code carries one WebRTC session description, compressed. It also carries the
// DTLS fingerprint, so the encrypted channel is bound to the device that showed it.

export type LinkCodeKind = 'offer' | 'answer';

const VERSION = 'KM1';
const KIND_LETTER: Record<LinkCodeKind, string> = { offer: 'O', answer: 'A' };
const MAX_CODE_LENGTH = 8_000;
const MAX_DESCRIPTION_BYTES = 16_000;

export class LinkCodeError extends Error {
  constructor(message: string) { super(message); this.name = 'LinkCodeError'; }
}

function toBase64Url(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_');
}
function fromBase64Url(value: string): Uint8Array {
  const binary = atob(value.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - value.length % 4) % 4));
  return Uint8Array.from(binary, char => char.charCodeAt(0));
}
async function transform(bytes: Uint8Array, stream: CompressionStream | DecompressionStream, limit: number): Promise<Uint8Array> {
  const reader = new Blob([bytes as BlobPart]).stream().pipeThrough(stream).getReader();
  const chunks: Uint8Array[] = []; let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > limit) { await reader.cancel(); throw new LinkCodeError('コードが長すぎます。'); }
    chunks.push(value);
  }
  const result = new Uint8Array(size); let offset = 0;
  for (const chunk of chunks) { result.set(chunk, offset); offset += chunk.byteLength; }
  return result;
}

/**
 * Drops what two browsers on one network do not need, so the QR code is coarser and quicker to read:
 * TCP candidates, and optional candidate attributes and session lines that only matter elsewhere.
 */
export function compactDescription(description: string): string {
  return description.split('\r\n')
    .filter(line => !/^a=(extmap-allow-mixed|msid-semantic)\b/.test(line) && !/^a=candidate:\S+ \d+ tcp /i.test(line))
    .map(line => line.startsWith('a=candidate:') ? line.replace(/ (generation|network-id|network-cost|ufrag) \S+/g, '') : line)
    .join('\r\n');
}

/** `KM1O.<deflated SDP>` for an offer, `KM1A.` for an answer. */
export async function encodeLinkCode(kind: LinkCodeKind, description: string): Promise<string> {
  const compressed = await transform(new TextEncoder().encode(compactDescription(description)), new CompressionStream('deflate-raw'), MAX_CODE_LENGTH);
  return `${VERSION}${KIND_LETTER[kind]}.${toBase64Url(compressed)}`;
}

/** Reads a pasted or scanned code. Whitespace from copying is ignored; anything else must be exact. */
export async function decodeLinkCode(code: string, expected: LinkCodeKind): Promise<string> {
  const value = code.replace(/\s+/g, '');
  if (value.length > MAX_CODE_LENGTH) throw new LinkCodeError('コードが長すぎます。');
  const match = /^KM1([OA])\.([A-Za-z0-9_-]+)$/.exec(value);
  if (!match) throw new LinkCodeError('KakeiMatchの同期のコードではありません。');
  if (match[1] !== KIND_LETTER[expected]) {
    throw new LinkCodeError(expected === 'answer' ? 'これは最初のコードです。相手の端末に表示された返事のコードを読んでください。' : 'これは返事のコードです。相手の端末で「この端末からつなぐ」を選んだ時のコードを読んでください。');
  }
  let description: string;
  try {
    description = new TextDecoder('utf-8', { fatal: true }).decode(await transform(fromBase64Url(match[2]!), new DecompressionStream('deflate-raw'), MAX_DESCRIPTION_BYTES));
  } catch (error) {
    if (error instanceof LinkCodeError) throw error;
    throw new LinkCodeError('コードの一部が欠けています。もう一度読み取るか、全体をコピーしてください。');
  }
  if (!description.startsWith('v=0') || !/^a=fingerprint:/m.test(description)) throw new LinkCodeError('コードの内容を確認できません。');
  return description;
}

/** SHA-256 of the snapshot, so the receiver can tell a complete transfer from a broken one. */
export async function sha256Hex(bytes: ArrayBuffer): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
  return Array.from(digest, byte => byte.toString(16).padStart(2, '0')).join('');
}
