/**
 * Types for scripts/canary-envelope.mjs — the Node port of the capture envelope that the
 * deploy canary uses (Brief 36 §F).
 *
 * Declared here so the cross-verification test can import BOTH implementations and compare
 * them under the same type discipline. The port itself stays plain JavaScript on purpose:
 * a build step between the gate and the format it checks is one more place for the two to
 * disagree, and the whole point of §F is that they cannot.
 */

export interface SealedEnvelope {
  alg: string;
  epk: string;
  iv: string;
  ct: string;
}

export declare const ENVELOPE_ALG: string;

export declare function toB64(bytes: Uint8Array): string;
export declare function fromB64(b64: string): Uint8Array;

export declare function generateEnvelopeKeypair(): Promise<CryptoKeyPair>;
export declare function exportPublicKey(key: CryptoKey): Promise<string>;
export declare function importPublicKey(b64: string): Promise<CryptoKey>;
export declare function exportPrivateKey(key: CryptoKey): Promise<string>;
export declare function importPrivateKey(b64: string): Promise<CryptoKey>;

export declare function generateDek(): Promise<CryptoKey>;
export declare function importDekRaw(raw: Uint8Array): Promise<CryptoKey>;
export declare function exportDekRaw(dek: CryptoKey): Promise<Uint8Array>;

export declare function randomIvPrefix(): Uint8Array;

export declare function encryptChunk(opts: {
  dek: CryptoKey;
  plaintext: Uint8Array;
  captureId: string;
  chunkIndex: number;
  isFinal: boolean;
  ivPrefix: Uint8Array;
}): Promise<Uint8Array>;

export declare function decryptChunk(opts: {
  dek: CryptoKey;
  framed: Uint8Array;
  captureId: string;
  chunkIndex: number;
  isFinal: boolean;
}): Promise<Uint8Array>;

export declare function plaintextCommitment(plaintext: Uint8Array): Promise<string>;

export declare function sealToPublicKey(
  plaintext: Uint8Array,
  recipientPublicKey: CryptoKey,
): Promise<SealedEnvelope>;
export declare function openWithPrivateKey(
  env: SealedEnvelope,
  recipientPrivateKey: CryptoKey,
): Promise<Uint8Array>;
export declare function wrapDek(dek: CryptoKey, recipientPublicKey: CryptoKey): Promise<SealedEnvelope>;
export declare function unwrapDek(env: SealedEnvelope, recipientPrivateKey: CryptoKey): Promise<CryptoKey>;
