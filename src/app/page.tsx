import type { Metadata } from 'next';
import { env } from '@/lib/config/env';
import { launchState } from '@/lib/config/launch';
import { Landing } from '@/components/public/Landing';

export const dynamic = 'force-dynamic';

export function generateMetadata(): Metadata {
  const live = launchState(env()) === 'live';
  return {
    title: 'Ticket Guy — Good tickets. Better advice.',
    description: live
      ? 'Independent advice for sports, concerts and shows across the US. Email a link, a screenshot or your plans.'
      : 'Ticket Guy is coming soon. Independent advice for sports, concerts and shows across the US. Email for early access.',
  };
}

export default function Home() {
  const e = env();
  return <Landing state={launchState(e)} address={e.CONCIERGE_INBOUND_ADDRESS} />;
}
