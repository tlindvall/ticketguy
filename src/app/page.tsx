import type { Metadata } from 'next';
import { env } from '@/lib/config/env';
import { launchState, pilotScopeLabels } from '@/lib/config/launch';
import { ComingSoon } from '@/components/public/ComingSoon';
import { LiveHome } from '@/components/public/LiveHome';

export const dynamic = 'force-dynamic';

export function generateMetadata(): Metadata {
  if (launchState(env()) === 'live') return {};
  return {
    title: 'Ticket Guy — coming soon',
    description: 'A ticket guy you can trust. We check the sellers, compare the real total with fees, and send you straight to the best ticket. You buy direct from the seller.',
  };
}

export default function Home() {
  const e = env();
  if (launchState(e) === 'live') return <LiveHome />;
  const scope = pilotScopeLabels(e);
  return <ComingSoon address={e.CONCIERGE_INBOUND_ADDRESS} categories={scope.categories} markets={scope.markets} />;
}
