import Link from 'next/link';

export default function AdminLayout({ children }: { children: React.ReactNode }) {
  const nav: Array<[string, string]> = [
    ['/admin/inbox', 'Inbox'],
    ['/admin/watches', 'Watches'],
    ['/admin/sources', 'Sources'],
    ['/admin/templates', 'Templates'],
    ['/admin/operations', 'Operations'],
  ];
  return (
    <div className="mx-auto w-full max-w-6xl px-4 py-4">
      <nav aria-label="Staff" className="mb-4 flex flex-wrap items-center gap-4 border-b border-gray-200 pb-2 text-sm">
        <span className="font-semibold">Ticket Guy staff</span>
        {nav.map(([href, label]) => (
          <Link key={href} href={href} className="text-gray-700 hover:underline">{label}</Link>
        ))}
        <Link href="/admin/setup-mfa" className="ml-auto text-gray-500 hover:underline">MFA</Link>
      </nav>
      {children}
    </div>
  );
}
