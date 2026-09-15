/**
 * hksv-csr.ts
 *
 * Client-certificate provisioning primitives for CMAF Ingest, per §4.25 of the HKSV Open
 * Source Compatibility Guide: on a Camera Client CSR write the accessory receives a random
 * 32-byte nonce and must respond with
 *
 *   1 CSR              — a Certificate Signing Request, DER format
 *   2 Nonce Signature  — an elliptic-curve signature of the nonce, signed by the same private
 *                        key as the CSR; max 128 bytes
 *
 * This module generates and persists an EC P-256 identity, builds the PKCS#10 CSR with a
 * minimal DER encoder (no npm dependencies — node:crypto only), and signs nonces with
 * ECDSA-SHA256 (DER encoding, ≤ 72 bytes for P-256, comfortably under the 128-byte cap).
 *
 * Validated by hksv-recording-protocol.test.ts (including an openssl cross-check when the
 * openssl binary is available).
 */

import { createPrivateKey, createPublicKey, createSign, generateKeyPairSync, KeyObject } from 'node:crypto';

// ---------------------------------------------------------------------------
// Minimal DER encoding
// ---------------------------------------------------------------------------

function derLength(n: number): Buffer {
    if (n < 0x80)
        return Buffer.from([n]);
    if (n <= 0xff)
        return Buffer.from([0x81, n]);
    return Buffer.from([0x82, (n >> 8) & 0xff, n & 0xff]);
}

function der(tag: number, ...content: Buffer[]): Buffer {
    const body = Buffer.concat(content);
    return Buffer.concat([Buffer.from([tag]), derLength(body.length), body]);
}

const derSequence = (...content: Buffer[]) => der(0x30, ...content);
const derSet = (...content: Buffer[]) => der(0x31, ...content);
const derInteger = (n: number) => der(0x02, Buffer.from([n]));
const derUtf8String = (s: string) => der(0x0c, Buffer.from(s, 'utf8'));
const derOid = (encoded: number[]) => der(0x06, Buffer.from(encoded));
const derBitString = (content: Buffer) => der(0x03, Buffer.concat([Buffer.from([0x00]), content]));
/** [0] IMPLICIT constructed context tag (CSR attributes). */
const derContext0 = (...content: Buffer[]) => der(0xa0, ...content);

/** OID 2.5.4.3 (commonName). */
const OID_COMMON_NAME = [0x55, 0x04, 0x03];
/** OID 1.2.840.10045.4.3.2 (ecdsa-with-SHA256). */
const OID_ECDSA_WITH_SHA256 = [0x2a, 0x86, 0x48, 0xce, 0x3d, 0x04, 0x03, 0x02];

// ---------------------------------------------------------------------------
// Identity
// ---------------------------------------------------------------------------

export interface ClientIdentity {
    privateKey: KeyObject;
    publicKey: KeyObject;
    /** PKCS#8 PEM of the private key, for persistence across restarts. */
    privateKeyPem: string;
}

/** Generate a fresh EC P-256 client identity. */
export function createClientIdentity(): ClientIdentity {
    const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
    return {
        privateKey,
        publicKey,
        privateKeyPem: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
    };
}

/** Load a previously persisted identity from its PKCS#8 PEM. */
export function loadClientIdentity(privateKeyPem: string): ClientIdentity {
    const privateKey = createPrivateKey(privateKeyPem);
    return {
        privateKey,
        publicKey: createPublicKey(privateKey),
        privateKeyPem,
    };
}

// ---------------------------------------------------------------------------
// PKCS#10 CSR
// ---------------------------------------------------------------------------

/**
 * Build a DER CertificationRequest (PKCS#10) for the identity:
 *
 *   CertificationRequest ::= SEQUENCE {
 *     certificationRequestInfo SEQUENCE { version 0, subject, subjectPKInfo, attributes [0] {} },
 *     signatureAlgorithm       ecdsa-with-SHA256,
 *     signature                BIT STRING }
 *
 * The subject is a single CN RDN naming the camera (e.g. its sensor/accessory UUID).
 */
export function buildClientCSR(identity: ClientIdentity, commonName: string): Buffer {
    const subject = derSequence(
        derSet(
            derSequence(
                derOid(OID_COMMON_NAME),
                derUtf8String(commonName),
            ),
        ),
    );
    const spki = identity.publicKey.export({ type: 'spki', format: 'der' }) as Buffer;

    const certificationRequestInfo = derSequence(
        derInteger(0), // version v1(0)
        subject,
        spki,
        derContext0(), // attributes: empty [0] IMPLICIT SET
    );

    const signature = createSign('sha256')
        .update(certificationRequestInfo)
        .sign({ key: identity.privateKey, dsaEncoding: 'der' });

    return derSequence(
        certificationRequestInfo,
        derSequence(derOid(OID_ECDSA_WITH_SHA256)),
        derBitString(signature),
    );
}

/**
 * Sign the controller-provided nonce with the CSR's private key (ECDSA-SHA256).
 * The spec caps the field at 128 bytes but doesn't state the signature encoding; both fit:
 * DER (X9.62, ≤72 bytes, the default) or raw r||s (IEEE P1363, exactly 64 bytes).
 * VALIDATE: flip to 'ieee-p1363' if certificate provisioning stalls after the CSR is read.
 */
export function signNonce(identity: ClientIdentity, nonce: Buffer, encoding: 'der' | 'ieee-p1363' = 'der'): Buffer {
    return createSign('sha256')
        .update(nonce)
        .sign({ key: identity.privateKey, dsaEncoding: encoding });
}
