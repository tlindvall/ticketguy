import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { env } from '@/lib/config/env';

export const dynamic = 'force-dynamic';
export const metadata: Metadata = { title: 'Ticket Guy preview', robots: { index: false, follow: false } };

/**
 * Brand direction 01 ("Your guy in the inbox") previews, for review before anything goes live. They exist
 * only in local development: every other environment answers 404, so a deploy cannot publish them.
 */
export default function PreviewLayout({ children }: { children: React.ReactNode }) {
  if (env().appEnv !== 'development') notFound();
  return children;
}
