import { query, withTransaction } from '../db/pool.js';
import { config } from '../config.js';
import { log } from '../logger.js';
import type { Lead, Payment } from '../types.js';
import { getLeadByWaId, getLeadById, setStatus } from './leads.js';
import { cancelPendingFollowups } from './followups.js';
import { sendFreeformToLead } from './outbound.js';
import { createBankTransferCharge, type BankTransferDetails } from '../paystack/client.js';

function naira(amountKobo: number): string {
  return (amountKobo / 100).toLocaleString('en-NG', { minimumFractionDigits: 0 });
}

/** WhatsApp copy — bank transfer prompt (§6.3a). */
export function bankTransferCopy(d: BankTransferDetails, amountKobo: number, hours: number): string {
  return (
    `You're almost there! To complete your order, please transfer ₦${naira(amountKobo)} to:\n\n` +
    `Bank: ${d.bankName}\n` +
    `Account Number: ${d.accountNumber}\n` +
    `Account Name: ${d.accountName}\n\n` +
    'This is a secure account created just for your order — it works with any bank app ' +
    `or USSD, and only accepts this exact payment. It expires in ${hours} hours.\n\n` +
    "The moment your transfer lands, you'll get an automatic confirmation right here."
  );
}

/** WhatsApp copy — payment received (§6.3b). */
export function receiptCopy(): string {
  return (
    'Payment received — thank you! Your order is confirmed.\n\n' +
    `${config.app.deliveryDetails}\n\n` +
    'If you need anything at all, just reply to this message.'
  );
}

/**
 * Generate a Pay-with-Transfer prompt for a ready-to-pay lead (§6.3a): create
 * the temporary virtual account, record the reference against a payment row, and
 * send the account details over WhatsApp.
 */
export async function sendBankTransferPrompt(params: {
  lead: Lead;
  email: string;
  amountKobo: number;
  hours?: number;
}): Promise<BankTransferDetails> {
  const hours = params.hours ?? 3;
  const expiresAt = new Date(Date.now() + hours * 60 * 60 * 1000);
  const details = await createBankTransferCharge({
    email: params.email,
    amountKobo: params.amountKobo,
    waId: params.lead.wa_id,
    expiresAt,
  });

  // Record the reference now so the webhook can fall back to it if metadata is
  // ever missing. Not a confirmation — the lead is only PAID on charge.success.
  if (details.reference) {
    await query(
      `INSERT INTO payments (lead_id, provider, reference, amount)
       VALUES ($1, 'paystack', $2, $3)
       ON CONFLICT (reference) DO NOTHING`,
      [params.lead.id, details.reference, params.amountKobo],
    );
  }

  await sendFreeformToLead(
    params.lead.id,
    params.lead.wa_id,
    bankTransferCopy(details, params.amountKobo, hours),
  );
  return details;
}

export interface ChargeSuccess {
  reference: string;
  waId: string | null;
  amountKobo: number | null;
  provider?: string;
}

/**
 * Handle a confirmed payment (§6.3b steps 3–6). Matches the lead, records the
 * payment, marks it PAID, cancels pending follow-ups and sends a receipt.
 *
 * Idempotent: the receipt + cancellation only run on the first transition into
 * PAID, so a re-delivered webhook is a no-op.
 */
export async function handleChargeSuccess(evt: ChargeSuccess): Promise<{
  matched: boolean;
  leadId?: string;
  alreadyPaid?: boolean;
}> {
  // Step 3 — match the lead: metadata.wa_id first, then stored reference.
  let lead: Lead | null = evt.waId ? await getLeadByWaId(evt.waId) : null;
  if (!lead && evt.reference) {
    const res = await query<Payment>('SELECT * FROM payments WHERE reference = $1', [evt.reference]);
    const existing = res.rows[0];
    if (existing?.lead_id) lead = await getLeadById(existing.lead_id);
  }

  if (!lead) {
    log.warn('paystack charge.success matched no lead', {
      reference: evt.reference,
      waId: evt.waId,
    });
    // Still record the payment (orphaned) so it isn't lost.
    await query(
      `INSERT INTO payments (lead_id, provider, reference, amount)
       VALUES (NULL, $1, $2, $3) ON CONFLICT (reference) DO NOTHING`,
      [evt.provider ?? 'paystack', evt.reference, evt.amountKobo],
    );
    return { matched: false };
  }

  const wasAlreadyPaid = lead.status === 'PAID';

  await withTransaction(async (client) => {
    // Step 4 — insert/patch payment row (dedupe on reference).
    await client.query(
      `INSERT INTO payments (lead_id, provider, reference, amount)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (reference) DO UPDATE SET
         lead_id = COALESCE(payments.lead_id, EXCLUDED.lead_id),
         amount  = COALESCE(EXCLUDED.amount, payments.amount)`,
      [lead!.id, evt.provider ?? 'paystack', evt.reference, evt.amountKobo],
    );
    // Step 5 — mark PAID + cancel pending follow-ups.
    await setStatus(lead!.id, 'PAID', client);
    await cancelPendingFollowups(lead!.id, client);
  });

  // Step 6 — receipt, only on the first transition into PAID.
  if (!wasAlreadyPaid) {
    try {
      await sendFreeformToLead(lead.id, lead.wa_id, receiptCopy());
    } catch (err) {
      log.error('receipt send failed', { leadId: lead.id, error: (err as Error).message });
    }
  }

  log.info('payment confirmed', { leadId: lead.id, reference: evt.reference, wasAlreadyPaid });
  return { matched: true, leadId: lead.id, alreadyPaid: wasAlreadyPaid };
}
