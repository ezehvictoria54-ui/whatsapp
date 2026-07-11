/** Format kobo as a naira amount with thousands separators (no decimals). */
export function naira(amountKobo: number): string {
  return '₦' + Math.round(amountKobo / 100).toLocaleString('en-NG');
}

export interface RenderContext {
  name?: string | null;
  offerName?: string;
  priceKobo?: number;
}

/**
 * Render the small set of placeholders offer messages may use:
 *   {name}  → the lead's first name (or "there")
 *   {offer} → the offer name
 *   {price} → the offer price formatted as naira
 */
export function renderMessage(body: string, ctx: RenderContext): string {
  const firstName = ctx.name ? ctx.name.split(' ')[0]! : 'there';
  return body
    .replace(/\{name\}/gi, firstName)
    .replace(/\{offer\}/gi, ctx.offerName ?? '')
    .replace(/\{price\}/gi, ctx.priceKobo != null ? naira(ctx.priceKobo) : '');
}
