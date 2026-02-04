import crypto from 'node:crypto';

import { PROTOCOL_VERSION } from './protocol.js';

export type KeyPair = {
  publicKeyDerB64: string;
  privateKey: crypto.KeyObject;
  publicKey: crypto.KeyObject;
};

export function generateEd25519KeyPair(): KeyPair {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  const publicDer = publicKey.export({ type: 'spki', format: 'der' });
  return {
    publicKeyDerB64: publicDer.toString('base64'),
    privateKey,
    publicKey,
  };
}

export function buildAuthString(args: { nonceB64: string; agentName: string; publicKeyDerB64: string }): string {
  // Canonical string so both sides sign/verify the exact same bytes.
  return [
    'SYNAPSE_AUTH_V1',
    `v=${PROTOCOL_VERSION}`,
    `nonce=${args.nonceB64}`,
    `agent=${args.agentName}`,
    `pub=${args.publicKeyDerB64}`,
  ].join('|');
}

export function signAuth(args: {
  nonceB64: string;
  agentName: string;
  publicKeyDerB64: string;
  privateKey: crypto.KeyObject;
}): string {
  const message = buildAuthString({
    nonceB64: args.nonceB64,
    agentName: args.agentName,
    publicKeyDerB64: args.publicKeyDerB64,
  });
  const sig = crypto.sign(null, Buffer.from(message, 'utf8'), args.privateKey);
  return sig.toString('base64');
}

export function verifyAuth(args: {
  nonceB64: string;
  agentName: string;
  publicKeyDerB64: string;
  signatureB64: string;
}): boolean {
  const message = buildAuthString({
    nonceB64: args.nonceB64,
    agentName: args.agentName,
    publicKeyDerB64: args.publicKeyDerB64,
  });
  const signature = Buffer.from(args.signatureB64, 'base64');
  const publicKey = crypto.createPublicKey({
    key: Buffer.from(args.publicKeyDerB64, 'base64'),
    format: 'der',
    type: 'spki',
  });
  return crypto.verify(null, Buffer.from(message, 'utf8'), publicKey, signature);
}

export function randomNonceB64(bytes = 24): string {
  return crypto.randomBytes(bytes).toString('base64');
}
