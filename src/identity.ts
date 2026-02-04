import crypto from 'node:crypto';

// Deterministic agent identity derived from its public key.
// This makes wallets/reputation persist across reconnects without server-side issued UUIDs.
export function deriveAgentId(publicKeyDerB64: string): string {
  const hashHex = crypto.createHash('sha256').update(publicKeyDerB64, 'utf8').digest('hex');
  return `agent_${hashHex}`; // stable, URL/DB safe
}

