import { env } from '@/lib/config/env';
import { launchState } from '@/lib/config/launch';
import { InboxHome } from '@/components/preview/InboxHome';

export default async function HomePreview({ searchParams }: { searchParams: Promise<{ state?: string }> }) {
  const e = env();
  // ?state=live or ?state=coming_soon shows either version; otherwise the page follows the real launch state.
  const { state } = await searchParams;
  return <InboxHome state={state === 'live' || state === 'coming_soon' ? state : launchState(e)} address={e.CONCIERGE_INBOUND_ADDRESS} />;
}
