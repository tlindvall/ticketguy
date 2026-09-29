import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { env } from '@/lib/config/env';
import { requireStaff } from '@/lib/auth/require-staff';

export const dynamic = 'force-dynamic';
export const metadata: Metadata = { title: 'Ticket Guy preview', robots: { index: false, follow: false } };

/**
 * Brand direction 01 ("Your guy in the inbox") previews, for review before anything goes live. Open in local
 * development and, on the live site, to signed-in staff only; everyone else gets a 404 (not a login prompt),
 * so a deploy never publishes them.
 */
export default async function PreviewLayout({ children }: { children: React.ReactNode }) {
  if (env().appEnv === 'development') return children;
  try {
    await requireStaff();
  } catch {
    notFound();
  }
  return children;
}
