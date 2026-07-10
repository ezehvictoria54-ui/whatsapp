import { config } from '../config.js';
import { log } from '../logger.js';

const BASE = 'https://api.paystack.co';

export interface BankTransferDetails {
  reference: string;
  accountNumber: string;
  accountName: string;
  bankName: string;
  expiresAt: string | null;
}

export interface UssdDetails {
  reference: string;
  ussdCode: string;
}

interface ChargeResponse {
  status: boolean;
  message?: string;
  data?: {
    reference?: string;
    status?: string;
    account_number?: string;
    account_name?: string;
    bank?: { name?: string; slug?: string };
    account_expires_at?: string;
    ussd_code?: string;
    display_text?: string;
  };
}

async function postCharge(body: Record<string, unknown>): Promise<ChargeResponse> {
  if (config.dryRun) {
    const ref = `dryrun-ref-${Date.now()}`;
    log.info('paystack charge (DRY_RUN)', { body });
    return {
      status: true,
      data: {
        reference: ref,
        status: 'pay_offline',
        account_number: '0001234567',
        account_name: 'PAYSTACK-TITAN / ORDER',
        bank: { name: 'Titan Bank' },
        account_expires_at: (body.bank_transfer as { account_expires_at?: string })
          ?.account_expires_at,
        ussd_code: '*901*000#',
      },
    };
  }

  const res = await fetch(`${BASE}/charge`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${config.paystack.secretKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });
  const json = (await res.json()) as ChargeResponse;
  if (!res.ok || !json.status) {
    const msg = json.message ?? `HTTP ${res.status}`;
    log.error('paystack charge failed', { status: res.status, error: msg });
    throw new Error(`Paystack charge failed: ${msg}`);
  }
  return json;
}

/**
 * Create a "Pay with Transfer" temporary virtual account (§6.3a). `expiresAt`
 * must be between 15 minutes and 8 hours out. The lead's `wa_id` is passed in
 * metadata so the webhook can map the payment back to the exact lead.
 */
export async function createBankTransferCharge(params: {
  email: string;
  amountKobo: number;
  waId: string;
  expiresAt: Date;
}): Promise<BankTransferDetails> {
  const json = await postCharge({
    email: params.email,
    amount: params.amountKobo,
    metadata: { wa_id: params.waId },
    bank_transfer: { account_expires_at: params.expiresAt.toISOString() },
  });
  const d = json.data ?? {};
  return {
    reference: d.reference ?? '',
    accountNumber: d.account_number ?? '',
    accountName: d.account_name ?? '',
    bankName: d.bank?.name ?? '',
    expiresAt: d.account_expires_at ?? params.expiresAt.toISOString(),
  };
}

/**
 * Create a USSD charge (§6.3, secondary channel) for buyers on a feature phone.
 * Returns the code the buyer dials, confirmed by the same charge.success webhook.
 */
export async function createUssdCharge(params: {
  email: string;
  amountKobo: number;
  waId: string;
  bankType: string; // e.g. 'guaranty-trust', 'united-bank-for-africa'
}): Promise<UssdDetails> {
  const json = await postCharge({
    email: params.email,
    amount: params.amountKobo,
    metadata: { wa_id: params.waId },
    ussd: { type: params.bankType },
  });
  const d = json.data ?? {};
  return { reference: d.reference ?? '', ussdCode: d.ussd_code ?? '' };
}
