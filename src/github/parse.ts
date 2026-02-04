export function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

export function getString(obj: Record<string, unknown>, key: string): string | null {
  const v = obj[key];
  return typeof v === 'string' ? v : null;
}

export function getNumber(obj: Record<string, unknown>, key: string): number | null {
  const v = obj[key];
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

export function parseBudgetFromText(text: string | null | undefined): number | null {
  if (!text) return null;
  // Accept: "budget: 123", "/budget 123", "Budget=123"
  const m =
    /(?:^|\n)\s*(?:budget\s*[:=]\s*|\/budget\s+)(\d{1,9})\s*(?:\n|$)/i.exec(text) ??
    /(?:^|\s)budget\s*[:=]\s*(\d{1,9})(?:\s|$)/i.exec(text);
  if (!m) return null;
  const n = Number(m[1]);
  if (!Number.isFinite(n) || n <= 0) return null;
  return Math.floor(n);
}

export function hasSynapseLabel(labels: unknown): boolean {
  if (!Array.isArray(labels)) return false;
  return labels.some((l) => {
    if (!isObject(l)) return false;
    const name = getString(l, 'name');
    return typeof name === 'string' && name.toLowerCase() === 'synapse';
  });
}

export function parseSynapseJobRefFromText(text: string | null | undefined): number | null {
  if (!text) return null;
  // Accept: "Synapse-Job: 123" (recommended)
  const m = /synapse-job\s*:\s*(\d{1,9})/i.exec(text);
  if (!m) return null;
  const n = Number(m[1]);
  if (!Number.isFinite(n) || n <= 0) return null;
  return Math.floor(n);
}

