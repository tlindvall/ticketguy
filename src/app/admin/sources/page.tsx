import { asc, eq } from 'drizzle-orm';
import { getDb } from '@/lib/db';
import * as t from '@/lib/db/schema';
import { guardPage } from '@/lib/admin/guard';
import { JsonForm } from '@/components/JsonForm';
import { CATEGORY_ROUTES, ROUTING_VERSION } from '@/lib/sources/routing';

export const dynamic = 'force-dynamic';

export default async function Sources({ searchParams }: { searchParams: Promise<{ group?: string; edit?: string }> }) {
  const staff = await guardPage();
  const { group, edit } = await searchParams;
  const { db } = await getDb();
  const rows = await db.select({ s: t.sourceRegistry, a: t.adapterConfigs }).from(t.sourceRegistry).leftJoin(t.adapterConfigs, eq(t.adapterConfigs.sourceId, t.sourceRegistry.id)).orderBy(asc(t.sourceRegistry.groupName), asc(t.sourceRegistry.name));
  const groups = [...new Set(rows.map((r) => r.s.groupName))];
  const shown = group ? rows.filter((r) => r.s.groupName === group) : rows;
  const editing = edit ? rows.find((r) => r.s.id === edit) : null;
  return (
    <main className="space-y-6">
      <header>
        <h1 className="text-xl font-bold">Sources</h1>
        <p className="mt-1 text-sm text-gray-600">{rows.length} registry entries · {rows.filter((r) => r.a?.enabled).length} enabled adapters · routing {ROUTING_VERSION} with {CATEGORY_ROUTES.length} category routes. Research evidence is never overwritten by activation.</p>
        <div className="mt-2 flex flex-wrap gap-2 text-xs">
          <a href="/admin/sources" className={`tg-badge ${!group ? 'tg-badge-ok' : 'tg-badge-muted'}`}>all</a>
          {groups.map((g) => <a key={g} href={`/admin/sources?group=${encodeURIComponent(g)}`} className={`tg-badge ${group === g ? 'tg-badge-ok' : 'tg-badge-muted'}`}>{g}</a>)}
        </div>
      </header>
      {editing ? (
        <section className="rounded border border-gray-300 p-3">
          <h2 className="font-semibold">Activation: {editing.s.name}</h2>
          <p className="text-xs text-gray-600">Enabling a non-fixture adapter requires written access-approval evidence (rights to query, cache, monitor and retain). Fixture adapters exist only in fixture mode.</p>
          {staff.role === 'admin' ? (
            <div className="mt-2">
              <JsonForm url={`/api/admin/sources/${editing.s.id}`} submitLabel="Save activation" fields={[{ name: 'implementation', label: 'Implementation (not_integrated | manual | fixture | ticketmaster_discovery)', required: true, defaultValue: editing.a?.implementation ?? 'not_integrated' }, { name: 'enabled', label: 'Enabled', type: 'checkbox', defaultValue: editing.a?.enabled ?? false }, { name: 'monitoringAllowed', label: 'Monitoring (polling) rights confirmed', type: 'checkbox', defaultValue: editing.a?.monitoringAllowed ?? false }, { name: 'retentionDays', label: 'Licensed retention (days)', type: 'number', defaultValue: editing.a?.retentionDays ?? 90 }, { name: 'dailyCallLimit', label: 'Daily call limit', type: 'number', defaultValue: editing.a?.dailyCallLimit ?? undefined }, { name: 'accessApprovalEvidence', label: 'Access approval evidence (who approved what, when, reference)', type: 'textarea', defaultValue: editing.a?.accessApprovalEvidence ?? '' }]} />
            </div>
          ) : <p className="mt-2 text-sm text-rose-700">Admin role required to change activation.</p>}
        </section>
      ) : null}
      <table className="tg-table">
        <thead><tr><th>Source</th><th>Group</th><th>Tier</th><th>Type</th><th>Evidence level</th><th>Adapter</th><th>Monitoring</th><th></th></tr></thead>
        <tbody>{shown.map(({ s, a }) => (
          <tr key={s.id}>
            <td><a className="underline" href={s.url} rel="noreferrer noopener" target="_blank">{s.name}</a><div className="text-xs text-gray-500">{s.routingNote}</div></td>
            <td className="text-xs">{s.groupName}</td><td className="text-xs">{s.routingTier}</td><td className="text-xs">{s.sourceType}</td>
            <td className="text-xs text-gray-600">{s.evidenceLevel}</td>
            <td>{a?.enabled ? <span className={`tg-badge ${a.implementation === 'fixture' ? 'tg-badge-danger' : 'tg-badge-ok'}`}>{a.implementation}</span> : <span className="tg-badge tg-badge-muted">{s.integrationStatus}</span>}</td>
            <td>{a?.monitoringAllowed ? 'yes' : '—'}</td>
            <td><a className="text-xs underline" href={`/admin/sources?${group ? `group=${encodeURIComponent(group)}&` : ''}edit=${s.id}`}>activation</a></td>
          </tr>
        ))}</tbody>
      </table>
    </main>
  );
}
