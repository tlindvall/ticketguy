import Link from 'next/link';
import { getDb } from '@/lib/db';
import { testModeOn } from '@/lib/email/test-mode';

export const dynamic = 'force-dynamic';

export default async function AdminLayout({ children }: { children: React.ReactNode }) {
  const nav: Array<[string, string]> = [
    ['/admin/inbox', 'Requests'],
    ['/admin/watches', 'Price watches'],
    ['/admin/pilot', 'Pilot'],
    ['/admin/market', 'Resale market'],
    ['/admin/sources', 'Sellers'],
    ['/admin/templates', 'Email wording'],
    ['/admin/operations', 'System health'],
    ['/admin/test', 'Test mode'],
    ['/preview/home', 'Homepage preview'],
  ];
  // Every page says so while test mode is on: a reply that "went out" here reached no one.
  const testMode = await getDb().then(({ db }) => testModeOn(db)).catch(() => false);
  return (
    <div className="mx-auto w-full max-w-6xl px-4 py-4">
      {testMode ? (
        <p role="status" className="mb-3 rounded border border-amber-400 bg-amber-100 px-3 py-2 text-sm text-amber-950">
          <strong>Test mode is on.</strong> Everything runs as live, but no email is sent: replies are recorded on each request instead. <Link className="underline" href="/admin/test">Test mode</Link>
        </p>
      ) : null}
      <nav aria-label="Staff" className="mb-4 flex flex-wrap items-center gap-4 border-b border-gray-200 pb-2 text-sm">
        <span className="font-semibold">Ticket Guy staff</span>
        {nav.map(([href, label]) => (
          <Link key={href} href={href} className="text-gray-700 hover:underline">{label}</Link>
        ))}
        <Link href="/admin/setup-mfa" className="ml-auto text-gray-500 hover:underline">Two-factor login</Link>
      </nav>
      {children}
    </div>
  );
}
