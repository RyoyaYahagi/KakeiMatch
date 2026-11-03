import { Encoder } from "cbor-x";
import { describe, expect, it } from "vitest";
import { verifyAuthenticationResponse } from "@simplewebauthn/server";

// Regression for the duplicate @peculiar/asn1-* installation that broke native
// Passkey login. SimpleWebAuthn parsed the EC2 signature with AsnParser from one
// @peculiar/asn1-schema copy while @peculiar/asn1-ecc registered ECDSASigValue in
// another, so verification failed with "Cannot get schema for 'ECDSASigValue' target".
const origin = "https://native.example.test";
const rpId = "native.example.test";
const encoder = new TextEncoder();
type Bytes = Uint8Array<ArrayBuffer>;

function base64url(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("base64url");
}

function fromBase64url(value: string): Bytes {
  return new Uint8Array(Buffer.from(value, "base64url"));
}

function concat(...parts: Bytes[]): Bytes {
  const result = new Uint8Array(parts.reduce((size, part) => size + part.length, 0));
  let offset = 0;
  for (const part of parts) {
    result.set(part, offset);
    offset += part.length;
  }
  return result;
}

async function sha256(value: Bytes): Promise<Bytes> {
  return new Uint8Array(await crypto.subtle.digest("SHA-256", value));
}

function derInteger(value: Bytes): Bytes {
  let start = 0;
  while (start < value.length - 1 && value[start] === 0) start += 1;
  const trimmed = value.subarray(start);
  const pad = (trimmed[0] & 0x80) === 0x80;
  const length = trimmed.length + (pad ? 1 : 0);
  const result = new Uint8Array(2 + length);
  result[0] = 0x02;
  result[1] = length;
  if (pad) result[2] = 0;
  result.set(trimmed, 2 + (pad ? 1 : 0));
  return result;
}

/** WebCrypto returns the raw r || s form; WebAuthn signatures use ASN.1 DER. */
function rawEcdsaToDer(signature: Bytes): Bytes {
  const r = derInteger(signature.subarray(0, 32));
  const s = derInteger(signature.subarray(32));
  return Uint8Array.from([0x30, r.length + s.length, ...r, ...s]);
}

async function makeCredential() {
  const pair = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
  const jwk = await crypto.subtle.exportKey("jwk", pair.publicKey);
  if (!jwk.x || !jwk.y) throw new Error("missing P-256 public coordinates");
  const credentialIdBytes = crypto.getRandomValues(new Uint8Array(32));
  const credentialId = base64url(credentialIdBytes);
  const encodedCosePublicKey = new Encoder({ useRecords: true, tagUint8Array: false }).encode(
    new Map<number, number | Uint8Array>([
      [1, 2],
      [3, -7],
      [-1, 1],
      [-2, fromBase64url(jwk.x)],
      [-3, fromBase64url(jwk.y)],
    ]),
  );
  const cosePublicKey = new Uint8Array(encodedCosePublicKey);
  return { privateKey: pair.privateKey, credentialId, credentialIdBytes, cosePublicKey };
}

async function signedAssertion(
  credential: Awaited<ReturnType<typeof makeCredential>>,
  challenge: string,
  { counter = 1 }: { counter?: number } = {},
) {
  const clientDataJSON = encoder.encode(
    JSON.stringify({ type: "webauthn.get", challenge, origin, crossOrigin: false }),
  );
  const authenticatorData = concat(
    await sha256(encoder.encode(rpId)),
    new Uint8Array([0x05]), // UP | UV
    new Uint8Array([(counter >>> 24) & 0xff, (counter >>> 16) & 0xff, (counter >>> 8) & 0xff, counter & 0xff]),
  );
  const rawSignature = new Uint8Array(
    await crypto.subtle.sign(
      { name: "ECDSA", hash: "SHA-256" },
      credential.privateKey,
      concat(authenticatorData, await sha256(clientDataJSON)),
    ),
  );
  return {
    id: credential.credentialId,
    rawId: credential.credentialId,
    type: "public-key" as const,
    response: {
      clientDataJSON: base64url(clientDataJSON),
      authenticatorData: base64url(authenticatorData),
      signature: base64url(rawEcdsaToDer(rawSignature)),
      userHandle: undefined,
    },
    clientExtensionResults: {},
  };
}

describe("Passkey assertion verification", () => {
  it("verifies a synthetic ES256 assertion through SimpleWebAuthn", async () => {
    const credential = await makeCredential();
    const challenge = base64url(crypto.getRandomValues(new Uint8Array(32)));

    const result = await verifyAuthenticationResponse({
      response: await signedAssertion(credential, challenge),
      expectedChallenge: challenge,
      expectedOrigin: origin,
      expectedRPID: rpId,
      credential: {
        id: credential.credentialId,
        publicKey: credential.cosePublicKey,
        counter: 0,
        transports: ["internal"],
      },
      requireUserVerification: true,
    });

    expect(result.verified).toBe(true);
    expect(result.authenticationInfo).toMatchObject({
      credentialID: credential.credentialId,
      newCounter: 1,
      userVerified: true,
      origin,
      rpID: rpId,
    });
  });

  it("rejects an assertion whose signature was altered", async () => {
    const credential = await makeCredential();
    const challenge = base64url(crypto.getRandomValues(new Uint8Array(32)));
    const assertion = await signedAssertion(credential, challenge);
    const signature = fromBase64url(assertion.response.signature);
    signature[signature.length - 1] ^= 0xff;

    const result = await verifyAuthenticationResponse({
      response: { ...assertion, response: { ...assertion.response, signature: base64url(signature) } },
      expectedChallenge: challenge,
      expectedOrigin: origin,
      expectedRPID: rpId,
      credential: {
        id: credential.credentialId,
        publicKey: credential.cosePublicKey,
        counter: 0,
        transports: ["internal"],
      },
    });

    expect(result.verified).toBe(false);
  });
});
