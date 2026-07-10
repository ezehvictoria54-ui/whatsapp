export type LeadStatus = 'NEW' | 'ENGAGED' | 'PAID' | 'OPTED_OUT';
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
  created_at: string;
}

export interface Followup {
  id: string;
  lead_id: string;
  send_at: string;
  step: number;
  channel: Channel;
  template_name: string | null;
  status: FollowupStatus;
  created_at: string;
}

export interface Payment {
  id: string;
  lead_id: string | null;
  provider: string;
  reference: string;
  amount: number | null;
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
