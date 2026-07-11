/**
 * Payment-claim detection (§Feature B).
 *
 * Edit PAYMENT_INTENT_PHRASES to tune what counts as a buyer claiming they've
 * paid. Matching is done on the normalized (lowercased, punctuation-stripped)
 * message: a phrase matches if it appears as a whole word / word-run in the
 * message, so "paid" matches "I paid" and "paid o" but not "unpaid".
 */
export const PAYMENT_INTENT_PHRASES: string[] = [
  'paid',
  "i've paid",
  'ive paid',
  'i have paid',
  'paid o',
  'done',
  'sent',
  'i sent it',
  'transferred',
  'payment made',
  'made payment',
  'i just paid',
  'have paid',
];

function normalizeWords(text: string): string {
  // Lowercase, replace any non-alphanumeric run with a single space, trim.
  return ` ${(text ?? '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()} `;
}

/**
 * True if the message looks like a payment claim. We surround both the haystack
 * and each phrase with spaces and match on the space-padded substring so we get
 * whole-word matching ("paid" ✓ in "i paid", ✗ in "unpaid" / "paidx").
 */
export function isPaymentClaim(body: string, phrases: string[] = PAYMENT_INTENT_PHRASES): boolean {
  if (!body) return false;
  const hay = normalizeWords(body);
  for (const phrase of phrases) {
    const needle = ` ${phrase.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()} `;
    if (needle.trim() && hay.includes(needle)) return true;
  }
  return false;
}
