// Public trust anchor, not a secret. Downloaded from:
// https://www.apple.com/certificateauthority/AppleRootCA-G3.cer
// Verified SHA-256 fingerprint:
// 63:34:3A:BF:B8:9A:6A:03:EB:B5:7E:9B:3F:5F:A7:BE:7C:4F:5C:75:6F:30:17:B3:A8:C4:88:C3:65:3E:91:79
//
// NOTE (S9 -> S10):
// CRL / OCSP revocation checking is intentionally not implemented in S9.
// Before adding 'Production' to STOREKIT_ALLOWED_ENVIRONMENTS, S10 must evaluate
// and decide the CRL / OCSP strategy for Production StoreKit JWS verification.

export const APPLE_ROOT_CA_G3_SHA256 =
  '63:34:3A:BF:B8:9A:6A:03:EB:B5:7E:9B:3F:5F:A7:BE:7C:4F:5C:75:6F:30:17:B3:A8:C4:88:C3:65:3E:91:79';

export const STOREKIT_INTERMEDIATE_OID = '1.2.840.113635.100.6.2.1';
export const STOREKIT_LEAF_OID = '1.2.840.113635.100.6.11.1';

const APPLE_ROOT_CA_G3_BASE64 =
  'MIICQzCCAcmgAwIBAgIILcX8iNLFS5UwCgYIKoZIzj0EAwMwZzEbMBkGA1UEAwwSQXBwbGUgUm9vdCBDQSAtIEczMSYwJAYDVQQLDB1BcHBsZSBDZXJ0aWZpY2F0aW9uIEF1dGhvcml0eTETMBEGA1UECgwKQXBwbGUgSW5jLjELMAkGA1UEBhMCVVMwHhcNMTQwNDMwMTgxOTA2WhcNMzkwNDMwMTgxOTA2WjBnMRswGQYDVQQDDBJBcHBsZSBSb290IENBIC0gRzMxJjAkBgNVBAsMHUFwcGxlIENlcnRpZmljYXRpb24gQXV0aG9yaXR5MRMwEQYDVQQKDApBcHBsZSBJbmMuMQswCQYDVQQGEwJVUzB2MBAGByqGSM49AgEGBSuBBAAiA2IABJjpLz1AcqTtkyJygRMc3RCV8cWjTnHcFBbZDuWmBSp3ZHtfTjjTuxxEtX/1H7YyYl3J6YRbTzBPEVoA/VhYDKX1DyxNB0cTddqXl5dvMVztK517IDvYuVTZXpmkOlEKMaNCMEAwHQYDVR0OBBYEFLuw3qFYM4iapIqZ3r6966/ayySrMA8GA1UdEwEB/wQFMAMBAf8wDgYDVR0PAQH/BAQDAgEGMAoGCCqGSM49BAMDA2gAMGUCMQCD6cHEFl4aXTQY2e3v9GwOAEZLuN+yRhHFD/3meoyhpmvOwgPUnPWTxnS4at+qIxUCMG1mihDK1A3UT82NQz60imOlM27jbdoXt2QfyFMm+YhidDkLF1vLUagM6BgD56KyKA==';

export const APPLE_ROOT_CA_G3_DER: Uint8Array = Uint8Array.from(
  atob(APPLE_ROOT_CA_G3_BASE64),
  char => char.charCodeAt(0),
);

let verifiedRootPromise: Promise<Uint8Array> | null = null;

export async function sha256Fingerprint(der: Uint8Array): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', der.slice().buffer as ArrayBuffer));
  return Array.from(digest, byte => byte.toString(16).toUpperCase().padStart(2, '0')).join(':');
}

/** Returns the embedded Apple Root CA - G3 DER after verifying its pinned SHA-256 fingerprint. */
export async function getAppleRootCaG3Der(): Promise<Uint8Array> {
  if (!verifiedRootPromise) {
    verifiedRootPromise = (async () => {
      const fingerprint = await sha256Fingerprint(APPLE_ROOT_CA_G3_DER);
      if (fingerprint !== APPLE_ROOT_CA_G3_SHA256) {
        throw new Error('root_fingerprint_mismatch');
      }
      return APPLE_ROOT_CA_G3_DER;
    })();
  }
  return verifiedRootPromise;
}
