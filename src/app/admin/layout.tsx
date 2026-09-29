import Link from 'next/link';

export default function AdminLayout({ children }: { children: React.ReactNode }) {
  const nav: Array<[string, string]> = [
    ['/admin/inbox', 'Requests'],
    ['/admin/watches', 'Price watches'],
    ['/admin/pilot', 'Pilot'],
    ['/admin/market', 'Resale market'],
    ['/admin/sources', 'Sellers'],
    ['/admin/templates', 'Email wording'],
    ['/admin/operations', 'System health'],
    ['/preview/home', 'Homepage preview'],
  ];
  return (
    <div className="mx-auto w-full max-w-6xl px-4 py-4">
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
