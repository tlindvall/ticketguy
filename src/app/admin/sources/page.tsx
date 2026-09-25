import { asc, eq } from 'drizzle-orm';
import { getDb } from '@/lib/db';
import * as t from '@/lib/db/schema';
import { guardPage } from '@/lib/admin/guard';
import { JsonForm } from '@/components/JsonForm';
import { CATEGORY_ROUTES, ROUTING_VERSION } from '@/lib/sources/routing';
import { ACCESS_CLASS_META, accessProfileFor, accessSummary, type AccessClass } from '@/lib/sources/access';

export const dynamic = 'force-dynamic';

export default async function Sources({ searchParams }: { searchParams: Promise<{ group?: string; edit?: string; access?: string }> }) {
  const staff = await guardPage();
  const { group, edit, access } = await searchParams;
  const { db } = await getDb();
  const rows = await db.select({ s: t.sourceRegistry, a: t.adapterConfigs }).from(t.sourceRegistry).leftJoin(t.adapterConfigs, eq(t.adapterConfigs.sourceId, t.sourceRegistry.id)).orderBy(asc(t.sourceRegistry.groupName), asc(t.sourceRegistry.name));
  const groups = [...new Set(rows.map((r) => r.s.groupName))];
  const profiled = rows.map((r) => ({ ...r, p: accessProfileFor({ id: r.s.id, source_type: r.s.sourceType, routing_tier: r.s.routingTier as Parameters<typeof accessProfileFor>[0]['routing_tier'] }) }));
  const accessFilter = access && access in ACCESS_CLASS_META ? (access as AccessClass) : null;
  const shown = profiled.filter((r) => (!group || r.s.groupName === group) && (!accessFilter || r.p.class === accessFilter));
  const editing = edit ? profiled.find((r) => r.s.id === edit) : null;
  const summary = accessSummary(profiled.map((r) => ({ id: r.s.id, source_type: r.s.sourceType, routing_tier: r.s.routingTier as Parameters<typeof accessProfileFor>[0]['routing_tier'] })));
  const automatable = profiled.filter((r) => r.p.automatable);
  const linkFor = (q: { group?: string | null; access?: string | null }) => {
    const params = new URLSearchParams();
    if (q.group) params.set('group', q.group);
    if (q.access) params.set('access', q.access);
    const qs = params.toString();
    return `/admin/sources${qs ? `?${qs}` : ''}`;
  };
  return (
    <main className="space-y-6">
      <header>
        <h1 className="text-xl font-bold">Sources</h1>
        <p className="mt-1 text-sm text-gray-600">{rows.length} registry entries · {rows.filter((r) => r.a?.enabled).length} enabled adapters · routing {ROUTING_VERSION} with {CATEGORY_ROUTES.length} category routes. Research evidence is never overwritten by activation.</p>
        <div className="mt-2 flex flex-wrap gap-2 text-xs">
          <a href={linkFor({ access })} className={`tg-badge ${!group ? 'tg-badge-ok' : 'tg-badge-muted'}`}>all</a>
          {groups.map((g) => <a key={g} href={linkFor({ group: g, access })} className={`tg-badge ${group === g ? 'tg-badge-ok' : 'tg-badge-muted'}`}>{g}</a>)}
        </div>
      </header>
      <section className="rounded border border-gray-300 p-3">
        <h2 className="font-semibold">Coverage: what each source can ever contribute</h2>
        <p className="mt-1 text-xs text-gray-600">
          &ldquo;Not integrated&rdquo; on every row is true and misleading. Only <strong>{automatable.length}</strong> of {rows.length} sources have an API at all, and every listing API sits behind a partner agreement. The rest are what a person follows: the seller of record, the official routing page, or a policy fact to note in the advice. Manual research through the request console <em>is</em> the integration for those, permanently.
        </p>
        <div className="mt-2 grid gap-2 sm:grid-cols-3">
          {summary.map((c) => {
            const enabled = profiled.filter((r) => r.p.class === c.class && r.a?.enabled && r.a.implementation !== 'not_integrated').length;
            return (
              <a key={c.class} href={linkFor({ group, access: accessFilter === c.class ? null : c.class })} className={`rounded border p-2 ${accessFilter === c.class ? 'border-gray-900' : 'border-gray-200'}`}>
                <div className="text-lg font-bold">{c.count}<span className="ml-1 text-xs font-normal text-gray-500">{c.automatable ? `· ${enabled} enabled` : '· manual by design'}</span></div>
                <div className="text-sm">{c.label}</div>
                <div className="mt-1 text-xs text-gray-600">{ACCESS_CLASS_META[c.class].nextAction}</div>
              </a>
            );
          })}
        </div>
      </section>
      {editing ? (
        <section className="rounded border border-gray-300 p-3">
          <h2 className="font-semibold">Activation: {editing.s.name}</h2>
          <p className="text-xs text-gray-600">Enabling a non-fixture adapter requires written access-approval evidence (rights to query, cache, monitor and retain). Fixture adapters exist only in fixture mode.</p>
          <p className="mt-1 text-xs text-gray-600"><strong>{editing.p.label}.</strong> {editing.p.nextAction}{editing.p.programmeUrl ? <> Programme: <a className="underline" href={editing.p.programmeUrl} rel="noreferrer noopener" target="_blank">{editing.p.programmeUrl}</a>.</> : null} While an application is open, leave the row disabled and record its date and reference in the evidence field: it shows on the coverage board.</p>
          {staff.role === 'admin' ? (
            <div className="mt-2">
              <JsonForm url={`/api/admin/sources/${editing.s.id}`} submitLabel="Save activation" fields={[{ name: 'implementation', label: 'Implementation (not_integrated | manual | fixture | ticketmaster_discovery)', required: true, defaultValue: editing.a?.implementation ?? 'not_integrated' }, { name: 'enabled', label: 'Enabled', type: 'checkbox', defaultValue: editing.a?.enabled ?? false }, { name: 'monitoringAllowed', label: 'Monitoring (polling) rights confirmed', type: 'checkbox', defaultValue: editing.a?.monitoringAllowed ?? false }, { name: 'retentionDays', label: 'Licensed retention (days)', type: 'number', defaultValue: editing.a?.retentionDays ?? 90 }, { name: 'dailyCallLimit', label: 'Daily call limit', type: 'number', defaultValue: editing.a?.dailyCallLimit ?? undefined }, { name: 'accessApprovalEvidence', label: 'Access approval evidence (who approved what, when, reference)', type: 'textarea', defaultValue: editing.a?.accessApprovalEvidence ?? '' }]} />
            </div>
          ) : <p className="mt-2 text-sm text-rose-700">Admin role required to change activation.</p>}
        </section>
      ) : null}
      <table className="tg-table">
        <thead><tr><th>Source</th><th>Group</th><th>Tier</th><th>Access</th><th>Evidence level</th><th>Adapter</th><th>Monitoring</th><th></th></tr></thead>
        <tbody>{shown.map(({ s, a, p }) => (
          <tr key={s.id}>
            <td><a className="underline" href={s.url} rel="noreferrer noopener" target="_blank">{s.name}</a><div className="text-xs text-gray-500">{s.sourceType} · {s.routingNote}</div></td>
            <td className="text-xs">{s.groupName}</td><td className="text-xs">{s.routingTier}</td>
            <td className="text-xs">
              <span className={`tg-badge ${p.automatable ? 'tg-badge-ok' : 'tg-badge-muted'}`}>{p.label}</span>
              {p.programmeUrl ? <div className="mt-1"><a className="underline" href={p.programmeUrl} rel="noreferrer noopener" target="_blank">apply / programme</a></div> : null}
              {a && !a.enabled && a.accessApprovalEvidence ? <div className="mt-1 text-gray-600">Note: {a.accessApprovalEvidence.slice(0, 160)}</div> : null}
            </td>
            <td className="text-xs text-gray-600">{s.evidenceLevel}</td>
            <td>{a?.enabled ? <span className={`tg-badge ${a.implementation === 'fixture' ? 'tg-badge-danger' : 'tg-badge-ok'}`}>{a.implementation}</span> : <span className="tg-badge tg-badge-muted">{p.automatable ? s.integrationStatus : 'manual by design'}</span>}</td>
            <td>{a?.monitoringAllowed ? 'yes' : '—'}</td>
            <td><a className="text-xs underline" href={`${linkFor({ group, access })}${linkFor({ group, access }).includes('?') ? '&' : '?'}edit=${s.id}`}>{p.automatable ? 'activation' : 'notes'}</a></td>
          </tr>
        ))}</tbody>
      </table>
    </main>
  );
}
