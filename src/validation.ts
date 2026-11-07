export function apartmentNumber(value: string): string | null {
  // Canonical numeric IDs prevent apartments 01 and 1 from voting separately.
  const clean = value.trim();
  if (!/^\d{1,5}$/.test(clean)) return null;
  const number = Number(clean);
  return number > 0 ? String(number) : null;
}
export function parsePoll(value: string) {
  const parts = value.split('|').map(v => v.trim());
  const [question, ...options] = parts;
  if (!question || question.length > 300 || options.length < 2 || options.length > 8 ||
      options.some(v => !v || v.length > 60) || new Set(options).size !== options.length) return null;
  return { question, options };
}
export function positiveId(value: string | undefined): number | null {
  if (!value || !/^[1-9]\d*$/.test(value)) return null;
  const n = Number(value);
  return Number.isSafeInteger(n) ? n : null;
}

export function ukrainianPhone(value: string): string | null {
  // Accept usual display formatting, but never discard letters or other content.
  const compact = value.trim().replace(/[\s()\-]/g, '');
  const match = /^(?:\+380|380|0)([1-9]\d{8})$/.exec(compact);
  return match ? `+380${match[1]}` : null;
}
