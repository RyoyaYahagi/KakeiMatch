// A direct, encrypted connection between two of the user's devices, with no server.
// The devices exchange connection codes (QR or text), open a WebRTC data channel,
// show each other's household summary, and one sends its whole household to the other.
import { decodeLinkCode, encodeLinkCode, sha256Hex } from './device-link-code';

export type LinkRole = 'offerer' | 'answerer';
export type HouseholdSummary = { device: string; transactions: number; latestDate: string | null };
type Message =
  | { t: 'hello'; version: 1; summary: HouseholdSummary }
  | { t: 'choose'; source: LinkRole }
  | { t: 'agree'; source: LinkRole }
  | { t: 'snapshot'; size: number; sha256: string }
  | { t: 'received' }
  | { t: 'failed' };
export type FailureReason = 'unreachable' | 'closed' | 'broken_transfer' | 'peer_failed';
export type LinkEvents = {
  onPeerSummary(summary: HouseholdSummary): void;
  /** `source` is the side whose household is kept. `chosenHere` is false when the other device chose. */
  onChoice(source: LinkRole, chosenHere: boolean): void;
  onProgress(fraction: number): void;
  onSnapshot(snapshot: Blob): void;
  onPeerReceived(): void;
  /** `unreachable`: the two devices never reached each other on the network. */
  onFailed(reason: FailureReason): void;
};

const CHANNEL = 'kakeimatch-sync';
const CHUNK_BYTES = 16 * 1024;
const MAX_SNAPSHOT_BYTES = 1024 * 1024 * 1024;
// Without a server there are only local candidates, which gather within a moment.
const ICE_GATHER_TIMEOUT_MS = 3_000;
// On one network the devices find each other within seconds; longer means something blocks them.
const CONNECT_TIMEOUT_MS = 20_000;

async function gathered(connection: RTCPeerConnection): Promise<string> {
  if (connection.iceGatheringState !== 'complete') {
    await new Promise<void>(resolve => {
      const timer = setTimeout(resolve, ICE_GATHER_TIMEOUT_MS);
      connection.addEventListener('icegatheringstatechange', () => {
        if (connection.iceGatheringState === 'complete') { clearTimeout(timer); resolve(); }
      });
    });
  }
  const description = connection.localDescription?.sdp;
  if (!description) throw new Error('link_unavailable');
  return description;
}

export class DeviceLink {
  private channel: RTCDataChannel | null = null;
  private chosen: LinkRole | null = null;
  private pending: LinkRole | null = null;
  private incoming: { size: number; sha256: string; bytes: Uint8Array; received: number } | null = null;
  private finished = false;
  private opened = false;
  private connectTimer: ReturnType<typeof setTimeout> | null = null;

  private constructor(private readonly connection: RTCPeerConnection, readonly role: LinkRole,
    private readonly summary: () => Promise<HouseholdSummary>, private readonly events: LinkEvents) {
    connection.addEventListener('connectionstatechange', () => {
      if (['failed', 'closed', 'disconnected'].includes(connection.connectionState)) this.fail(this.opened ? 'closed' : 'unreachable');
    });
  }

  /** The first device: returns its code and a function that takes the other device's reply. */
  static async start(summary: () => Promise<HouseholdSummary>, events: LinkEvents): Promise<{ link: DeviceLink; code: string; accept(answerCode: string): Promise<void> }> {
    const connection = new RTCPeerConnection({ iceServers: [] });
    const link = new DeviceLink(connection, 'offerer', summary, events);
    link.attach(connection.createDataChannel(CHANNEL, { ordered: true }));
    await connection.setLocalDescription(await connection.createOffer());
    const code = await encodeLinkCode('offer', await gathered(connection));
    return {
      link, code,
      accept: async answerCode => { await connection.setRemoteDescription({ type: 'answer', sdp: await decodeLinkCode(answerCode, 'answer') }); link.waitForConnection(); },
    };
  }

  /** The second device: reads the first device's code and returns the reply to show. */
  static async join(offerCode: string, summary: () => Promise<HouseholdSummary>, events: LinkEvents): Promise<{ link: DeviceLink; code: string }> {
    const offer = await decodeLinkCode(offerCode, 'offer');
    const connection = new RTCPeerConnection({ iceServers: [] });
    const link = new DeviceLink(connection, 'answerer', summary, events);
    connection.addEventListener('datachannel', event => { if (event.channel.label === CHANNEL) link.attach(event.channel); });
    await connection.setRemoteDescription({ type: 'offer', sdp: offer });
    await connection.setLocalDescription(await connection.createAnswer());
    const code = await encodeLinkCode('answer', await gathered(connection));
    link.waitForConnection();
    return { link, code };
  }

  /** Gives up when the channel has not opened in time, instead of waiting forever. */
  private waitForConnection() {
    if (this.connectTimer !== null) return;
    this.connectTimer = setTimeout(() => {
      if (this.opened) return;
      this.fail('unreachable');
      this.connection.close();
    }, CONNECT_TIMEOUT_MS);
  }

  private attach(channel: RTCDataChannel) {
    this.channel = channel;
    channel.binaryType = 'arraybuffer';
    channel.bufferedAmountLowThreshold = CHUNK_BYTES * 8;
    channel.addEventListener('open', () => { this.opened = true; if (this.connectTimer !== null) clearTimeout(this.connectTimer); void this.summary().then(summary => this.send({ t: 'hello', version: 1, summary })).catch(() => this.fail('peer_failed')); });
    channel.addEventListener('message', event => { this.receive(event.data as string | ArrayBuffer); });
    channel.addEventListener('close', () => this.fail(this.opened ? 'closed' : 'unreachable'));
  }

  private send(message: Message) { this.channel?.send(JSON.stringify(message)); }

  private fail(reason: FailureReason) {
    if (this.finished) return;
    this.finished = true;
    this.events.onFailed(reason);
  }

  private receive(data: string | ArrayBuffer) {
    if (typeof data !== 'string') {
      const incoming = this.incoming;
      if (!incoming || incoming.received + data.byteLength > incoming.size) { this.send({ t: 'failed' }); this.fail('broken_transfer'); return; }
      incoming.bytes.set(new Uint8Array(data), incoming.received);
      incoming.received += data.byteLength;
      this.events.onProgress(incoming.received / incoming.size);
      if (incoming.received === incoming.size) void this.completeIncoming(incoming);
      return;
    }
    let message: Message;
    try { message = JSON.parse(data) as Message; } catch { this.fail('broken_transfer'); return; }
    if (message.t === 'hello' && message.version === 1) this.events.onPeerSummary(message.summary);
    else if (message.t === 'choose') this.peerChose(message.source);
    else if (message.t === 'agree') this.peerAgreed(message.source);
    else if (message.t === 'snapshot') {
      if (this.chosen === null || this.chosen === this.role || !Number.isSafeInteger(message.size) || message.size <= 0 || message.size > MAX_SNAPSHOT_BYTES || !/^[0-9a-f]{64}$/.test(message.sha256)) {
        this.send({ t: 'failed' }); this.fail('broken_transfer'); return;
      }
      this.incoming = { size: message.size, sha256: message.sha256, bytes: new Uint8Array(message.size), received: 0 };
    } else if (message.t === 'received') { this.finished = true; this.events.onPeerReceived(); }
    else if (message.t === 'failed') this.fail('peer_failed');
  }

  private async completeIncoming(incoming: { sha256: string; bytes: Uint8Array }) {
    if (await sha256Hex(incoming.bytes.buffer as ArrayBuffer) !== incoming.sha256) { this.send({ t: 'failed' }); this.fail('broken_transfer'); return; }
    this.events.onSnapshot(new Blob([incoming.bytes as BlobPart]));
  }

  /**
   * Proposes keeping `source`'s household. Nothing moves until the other device agrees.
   * If both devices choose at once, the first device's choice wins, so both sides agree on one direction.
   */
  choose(source: LinkRole) {
    if (this.chosen !== null || this.pending !== null) return;
    this.pending = source;
    this.send({ t: 'choose', source });
  }

  private peerChose(source: LinkRole) {
    if (this.chosen !== null) return;
    if (this.pending !== null && this.role === 'offerer') return;
    this.pending = null;
    this.chosen = source;
    this.send({ t: 'agree', source });
    this.events.onChoice(source, false);
  }

  private peerAgreed(source: LinkRole) {
    if (this.chosen !== null || this.pending !== source) return;
    this.pending = null;
    this.chosen = source;
    this.events.onChoice(source, true);
  }

  /** The kept side sends its household, waiting whenever the channel's buffer fills up. */
  async sendSnapshot(snapshot: Blob) {
    const channel = this.channel;
    if (!channel || channel.readyState !== 'open') { this.fail('closed'); return; }
    const bytes = await snapshot.arrayBuffer();
    this.send({ t: 'snapshot', size: bytes.byteLength, sha256: await sha256Hex(bytes) });
    for (let offset = 0; offset < bytes.byteLength; offset += CHUNK_BYTES) {
      if (channel.bufferedAmount > channel.bufferedAmountLowThreshold) {
        await new Promise<void>(resolve => channel.addEventListener('bufferedamountlow', () => resolve(), { once: true }));
      }
      if (this.finished || channel.readyState !== 'open') return;
      channel.send(bytes.slice(offset, offset + CHUNK_BYTES));
      this.events.onProgress(Math.min(1, (offset + CHUNK_BYTES) / bytes.byteLength));
    }
  }

  /** The receiver says the household was switched, so the sender can stop waiting. */
  confirmReceived() { this.send({ t: 'received' }); this.finished = true; }
  reportFailure() { this.send({ t: 'failed' }); this.finished = true; }
  close() { this.finished = true; if (this.connectTimer !== null) clearTimeout(this.connectTimer); this.channel?.close(); this.connection.close(); }
}
