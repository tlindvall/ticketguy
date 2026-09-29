import type { Metadata } from 'next';
import { env } from '@/lib/config/env';
import { InboxHome } from '@/components/preview/InboxHome';

export const dynamic = 'force-dynamic';

export function generateMetadata(): Metadata {
  return {
    title: 'Ticket Guy — You’ve finally got a ticket guy now.',
    description: 'Found tickets? Get a second opinion before you buy. Email a link, a screenshot or your plans to my@ticketguy.now. Free, for live events across the US.',
  };
}

export default function Home() {
  // The homepage invites real requests ("Now in beta") by the owner's decision, not by launchState: the
  // send gate still decides who actually gets a reply (EMAIL_TEST_RECIPIENT_ALLOWLIST). /preview/home still
  // shows either state. The earlier page is `Landing`, one import away, if this has to be rolled back.
  return <InboxHome state="live" address={env().CONCIERGE_INBOUND_ADDRESS} />;
}
