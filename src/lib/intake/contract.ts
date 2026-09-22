import { z } from 'zod';

/**
 * Application-normalized inbound email contract. The Resend normalizer (webhook + retrieval) and the local
 * simulator both produce this shape. Simulated payloads never claim provider signature verification.
 */
export const NormalizedAttachmentSchema = z.object({
  providerAttachmentId: z.string().nullable(),
  filename: z.string().nullable(),
  declaredMimeType: z.string().nullable(),
  bytes: z.instanceof(Uint8Array),
  inline: z.boolean().default(false),
});

export const NormalizedInboundSchema = z.object({
  provider: z.enum(['resend', 'simulator']),
  providerEmailId: z.string(),
  rfcMessageId: z.string().nullable(),
  inReplyTo: z.string().nullable(),
  references: z.string().nullable(),
  from: z.string().email(),
  to: z.array(z.string()),
  subject: z.string().nullable(),
  text: z.string(),
  headers: z.record(z.string(), z.string()).default({}),
  receivedAt: z.coerce.date(),
  attachments: z.array(NormalizedAttachmentSchema).default([]),
  authentication: z.object({ spf: z.string().nullable(), dkim: z.string().nullable(), dmarc: z.string().nullable() }).default({ spf: null, dkim: null, dmarc: null }),
  signatureVerified: z.boolean(),
});
export type NormalizedInbound = z.infer<typeof NormalizedInboundSchema>;
export type NormalizedAttachment = z.infer<typeof NormalizedAttachmentSchema>;
