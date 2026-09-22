import { Inngest, eventType } from 'inngest';
import { z } from 'zod';

/** Event envelopes carry IDs and revisions only (API_AND_DATA_CONTRACTS §5). Versioned via `version`. */
export const emailReceived = eventType('tg/email.received', { schema: z.object({ inboundEventId: z.string(), correlationId: z.string() }), version: '1' });
export const outboxKick = eventType('tg/outbox.kick', { schema: z.object({ reason: z.string() }), version: '1' });

export const inngest = new Inngest({ id: 'ticketguy' });
