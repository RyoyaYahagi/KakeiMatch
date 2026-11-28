import { describe, expect, it } from 'vitest';
import {
  APPLE_ROOT_CA_G3_DER,
  APPLE_ROOT_CA_G3_SHA256,
  getAppleRootCaG3Der,
  sha256Fingerprint,
} from './storekit-certs';
import { verifyStoreKitTransactionJws } from './storekit-jws';
import {
  buildStoreKitChainFixture,
  buildStoreKitJwsFixture,
  storeKitTestNow,
} from './test-support/storekit-fixture';

describe('StoreKit JWS verification', () => {
  it('verifies the embedded Apple Root CA - G3 SHA-256 fingerprint', async () => {
    expect(await sha256Fingerprint(APPLE_ROOT_CA_G3_DER)).toBe(APPLE_ROOT_CA_G3_SHA256);
    expect(await getAppleRootCaG3Der()).toBe(APPLE_ROOT_CA_G3_DER);
  });

  it.each(['P-256', 'P-384'] as const)('accepts a valid synthetic %s certificate chain and JWS', async leafCurve => {
    const chain = await buildStoreKitChainFixture({ leafCurve });
    const fixture = await buildStoreKitJwsFixture({ chain });

    const verified = await verifyStoreKitTransactionJws(fixture.jws, {
      now: fixture.now,
      testTrustAnchor: fixture.trustAnchorDER,
    });

    expect(verified).toMatchObject({
      originalTransactionId: '1000000000000001',
      transactionId: '2000000000000001',
      bundleId: 'jp.kakeimatch.ios',
      productId: 'jp.kakeimatch.pro.monthly',
      environment: 'Sandbox',
      inAppOwnershipType: 'PURCHASED',
    });
  });

  it('rejects a chain anchored to a different root', async () => {
    const fixture = await buildStoreKitJwsFixture();
    const otherChain = await buildStoreKitChainFixture();

    await expect(
      verifyStoreKitTransactionJws(fixture.jws, {
        now: fixture.now,
        testTrustAnchor: otherChain.rootDER,
      }),
    ).rejects.toThrow('untrusted_root');
  });

  it('rejects a tampered JWS signature', async () => {
    const fixture = await buildStoreKitJwsFixture({ tamperSignature: true });

    await expect(
      verifyStoreKitTransactionJws(fixture.jws, {
        now: fixture.now,
        testTrustAnchor: fixture.trustAnchorDER,
      }),
    ).rejects.toThrow('invalid_signature');
  });

  it('rejects x5c chains that do not have exactly 3 certificates', async () => {
    const chain = await buildStoreKitChainFixture();
    const leafB64 = btoa(String.fromCharCode(...chain.leafDER));
    const interB64 = btoa(String.fromCharCode(...chain.intermediateDER));
    const rootB64 = btoa(String.fromCharCode(...chain.rootDER));

    const tooShort = await buildStoreKitJwsFixture({ chain, x5cOverride: [leafB64, interB64] });
    await expect(
      verifyStoreKitTransactionJws(tooShort.jws, {
        now: tooShort.now,
        testTrustAnchor: tooShort.trustAnchorDER,
      }),
    ).rejects.toThrow('invalid_x5c');

    const tooLong = await buildStoreKitJwsFixture({ chain, x5cOverride: [leafB64, interB64, rootB64, rootB64] });
    await expect(
      verifyStoreKitTransactionJws(tooLong.jws, {
        now: tooLong.now,
        testTrustAnchor: tooLong.trustAnchorDER,
      }),
    ).rejects.toThrow('invalid_x5c');
  });

  it('rejects a leaf certificate missing the StoreKit leaf OID', async () => {
    const chain = await buildStoreKitChainFixture({ includeLeafOid: false });
    const fixture = await buildStoreKitJwsFixture({ chain });

    await expect(
      verifyStoreKitTransactionJws(fixture.jws, {
        now: fixture.now,
        testTrustAnchor: fixture.trustAnchorDER,
      }),
    ).rejects.toThrow('missing_leaf_oid');
  });

  it('rejects an intermediate certificate missing the Apple intermediate OID', async () => {
    const chain = await buildStoreKitChainFixture({ includeIntermediateOid: false });
    const fixture = await buildStoreKitJwsFixture({ chain });

    await expect(
      verifyStoreKitTransactionJws(fixture.jws, {
        now: fixture.now,
        testTrustAnchor: fixture.trustAnchorDER,
      }),
    ).rejects.toThrow('missing_intermediate_oid');
  });

  it('rejects a JWS header containing crit or any key outside alg and x5c', async () => {
    const withCrit = await buildStoreKitJwsFixture({ headerOverrides: { crit: ['exp'] } });
    await expect(
      verifyStoreKitTransactionJws(withCrit.jws, {
        now: withCrit.now,
        testTrustAnchor: withCrit.trustAnchorDER,
      }),
    ).rejects.toThrow('invalid_jws_header');

    const withTyp = await buildStoreKitJwsFixture({ headerOverrides: { typ: 'JWT' } });
    await expect(
      verifyStoreKitTransactionJws(withTyp.jws, {
        now: withTyp.now,
        testTrustAnchor: withTyp.trustAnchorDER,
      }),
    ).rejects.toThrow('invalid_jws_header');
  });

  it('rejects a payload whose signedDate is in the future', async () => {
    const fixture = await buildStoreKitJwsFixture({
      payloadOverrides: { signedDate: storeKitTestNow.getTime() + 1000 },
    });

    await expect(
      verifyStoreKitTransactionJws(fixture.jws, {
        now: fixture.now,
        testTrustAnchor: fixture.trustAnchorDER,
      }),
    ).rejects.toThrow('future_signed_date');
  });

  it('rejects non-auto-renewable transactions and wrong bundleId', async () => {
    const nonSub = await buildStoreKitJwsFixture({
      payloadOverrides: { type: 'Consumable' },
    });
    await expect(
      verifyStoreKitTransactionJws(nonSub.jws, {
        now: nonSub.now,
        testTrustAnchor: nonSub.trustAnchorDER,
      }),
    ).rejects.toThrow('unsupported_transaction_type');

    const wrongBundle = await buildStoreKitJwsFixture({
      payloadOverrides: { bundleId: 'com.example.other' },
    });
    await expect(
      verifyStoreKitTransactionJws(wrongBundle.jws, {
        now: wrongBundle.now,
        testTrustAnchor: wrongBundle.trustAnchorDER,
      }),
    ).rejects.toThrow('invalid_bundle_id');
  });
});
