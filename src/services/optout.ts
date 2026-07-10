const OPT_OUT_KEYWORDS = new Set(['STOP', 'UNSUBSCRIBE', 'STOPALL', 'CANCEL', 'END', 'QUIT']);

/**
 * An inbound counts as an opt-out when its trimmed, upper-cased body is exactly
 * one of the recognised keywords. We require an exact match (not substring) so a
 * message like "please don't stop helping me" is not misread as an opt-out.
 */
export function isOptOut(body: string): boolean {
  if (!body) return false;
  return OPT_OUT_KEYWORDS.has(body.trim().toUpperCase());
}
