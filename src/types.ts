export type LeadStatus = 'NEW' | 'ENGAGED' | 'PAID' | 'OPTED_OUT' | 'PAYMENT_CLAIMED';
export type EntryPoint = 'ad' | 'organic';
export type Direction = 'IN' | 'OUT';
export type Channel = 'FREEFORM' | 'TEMPLATE';
export type FollowupStatus = 'PENDING' | 'SENT' | 'SKIPPED' | 'CANCELLED';

export interface Lead {
  id: string;
  wa_id: string;
  name: string | null;
  source: string | null;
  status: LeadStatus;
  window_expires_at: string | null;
  entry_point: EntryPoint;
  sequence_step: number;
  offer_id: string | null;
  offer_unmatched: boolean;
  payment_claimed_at: string | null;
  created_at: string;
  updated_at: string;
}

/** One WhatsApp bubble: a text body and/or an attached image. */
export interface Bubble {
  body?: string | null;
  imageUrl?: string | null;
}

/**
 * A single step in an offer's follow-up sequence. A FREEFORM step may send
 * several `bubbles` (2–3 separate messages with a short gap). `freeformBody` is
 * the legacy single-message form and is treated as a one-bubble step.
 */
export interface OfferSequenceStep {
  step: number;
  offsetMs: number;
  channel: Channel;
  purpose: string;
  bubbles?: Bubble[];
  freeformBody?: string;
  templateName?: string;
}

export interface Offer {
  id: string;
  name: string;
  price_kobo: number;
  keyword: string | null;
  keywords: string[];
  sequence: OfferSequenceStep[];
  is_default: boolean;
  active: boolean;
  created_at: string;
  updated_at: string;
}

export interface Message {
  id: string;
  lead_id: string;
  wa_message_id: string | null;
  direction: Direction;
  body: string | null;
  type: string;
  image_url: string | null;
  created_at: string;
}

export interface Followup {
  id: string;
  lead_id: string;
  send_at: string;
  step: number;
  channel: Channel;
  template_name: string | null;
  body: string | null;
  bubbles: Bubble[] | null;
  status: FollowupStatus;
  created_at: string;
}

export interface Payment {
  id: string;
  lead_id: string | null;
  offer_id: string | null;
  provider: string;
  reference: string;
  amount: number | null;
  claimed_at: string | null;
  created_at: string;
}

/** Normalised inbound message parsed out of a WhatsApp webhook payload. */
export interface ParsedInbound {
  waId: string;
  profileName: string | null;
  waMessageId: string;
  body: string;
  type: string;
  isAd: boolean;
  /** ad/campaign identifier from the referral payload, if present */
  source: string | null;
  timestamp: number | null;
}
