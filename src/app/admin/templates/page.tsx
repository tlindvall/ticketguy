import { getDb } from '@/lib/db';
import { guardPage } from '@/lib/admin/guard';
import { ActionButton } from '@/components/ActionButton';
import { JsonForm } from '@/components/JsonForm';
import { TemplateEditor } from '@/components/TemplateEditor';
import { SLOTS, STARTER_BODY } from '@/lib/email/custom-templates';
import { listSignatures, listTemplates, loadActiveTemplates } from '@/lib/email/template-store';

export const dynamic = 'force-dynamic';

/**
 * Email copy. Reviewers can read what is live; authoring and activating are admin-only, because a template
 * change alters what customers receive with no further approval step.
 */
export default async function Templates() {
  const staff = await guardPage();
  const { db } = await getDb();
  const [active, all, signatures] = await Promise.all([loadActiveTemplates(db), listTemplates(db), listSignatures(db)]);
  const canEdit = staff.role === 'admin';
  const sigOptions = signatures.map((s) => ({ id: s.id, name: `${s.name}${s.isDefault ? ' (default)' : ''}`, body: s.bodyText }));

  return (
    <main className="space-y-8">
      <header>
        <h1 className="text-xl font-bold">Email templates</h1>
        <p className="mt-1 max-w-3xl text-sm text-gray-600">
          Each template replaces the wording of one automatic email. It cannot create a new send, and the
          compliance footer is added after your signature on every message, so it can never be edited away.
          Recommendation bodies are not listed here — that copy is generated from the offer evidence.
        </p>
        {!canEdit ? <p className="mt-2 text-sm text-gray-600">You have read access. An admin can change templates.</p> : null}
      </header>

      <section>
        <h2 className="font-semibold">Live copy</h2>
        <table className="tg-table mt-2">
          <thead><tr><th>Template</th><th>Source</th><th>Version</th><th>Signature</th><th></th></tr></thead>
          <tbody>
            {SLOTS.map((s) => {
              const a = active[s.name];
              return (
                <tr key={s.name}>
                  <td>{s.label}</td>
                  <td>{a ? <span className="tg-badge tg-badge-ok">staff-authored</span> : <span className="tg-badge">built-in</span>}</td>
                  <td>{a ? `v${a.version}` : '—'}</td>
                  <td>{a?.signature ? 'custom' : 'default sign-off'}</td>
                  <td>{a && canEdit ? <ActionButton url="/api/admin/templates" body={{ action: 'revert', slot: s.name }} label="Revert to built-in" confirm={`Revert ${s.label} to the built-in wording?`} /> : null}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </section>

      <section>
        <h2 className="font-semibold">Signatures</h2>
        <p className="text-sm text-gray-600">Plain text, appended above the compliance footer. A signature used by any saved version cannot be deleted.</p>
        <table className="tg-table mt-2">
          <thead><tr><th>Name</th><th>Text</th><th>Default</th><th></th></tr></thead>
          <tbody>
            {signatures.length ? signatures.map((s) => (
              <tr key={s.id}>
                <td>{s.name}</td>
                <td><pre className="whitespace-pre-wrap text-xs">{s.bodyText}</pre></td>
                <td>{s.isDefault ? 'yes' : ''}</td>
                <td>{canEdit ? <ActionButton url="/api/admin/signatures" body={{ action: 'delete', id: s.id }} label="Delete" confirm={`Delete signature "${s.name}"?`} /> : null}</td>
              </tr>
            )) : <tr><td colSpan={4} className="text-sm text-gray-600">None yet — emails use the default &ldquo;&mdash; Ticket Guy&rdquo; sign-off.</td></tr>}
          </tbody>
        </table>
        {canEdit ? (
          <div className="mt-3 rounded border border-gray-200 p-3">
            <h3 className="text-sm font-medium">Add a signature</h3>
            <JsonForm
              url="/api/admin/signatures"
              submitLabel="Save signature"
              extra={{ action: 'save', id: null }}
              fields={[
                { name: 'name', label: 'Name', required: true, placeholder: 'Concierge team' },
                { name: 'isDefault', label: 'Use as default', type: 'checkbox' },
                { name: 'body', label: 'Signature text', type: 'textarea', required: true, placeholder: '— Tobias, Ticket Guy' },
              ]}
            />
          </div>
        ) : null}
      </section>

      {canEdit ? (
        <section className="space-y-4">
          <h2 className="font-semibold">Edit a template</h2>
          {SLOTS.map((s) => (
            <TemplateEditor
              key={s.name}
              slot={s.name}
              label={s.label}
              description={s.description}
              variables={s.variables.map((v) => ({ name: v.name, kind: v.kind, description: v.description }))}
              signatures={sigOptions}
              initialSubject={active[s.name]?.subject ?? null}
              initialBody={active[s.name]?.body ?? STARTER_BODY[s.name]}
              initialSignatureId={all.find((r) => r.slot === s.name && r.state === 'active')?.signatureId ?? null}
              builtInBody={STARTER_BODY[s.name]}
            />
          ))}
        </section>
      ) : null}

      <section>
        <h2 className="font-semibold">Version history</h2>
        <table className="tg-table mt-2">
          <thead><tr><th>Template</th><th>Version</th><th>State</th><th>Note</th><th>Created</th><th></th></tr></thead>
          <tbody>
            {all.length ? all.map((r) => (
              <tr key={r.id}>
                <td>{r.slot}</td>
                <td>v{r.version}</td>
                <td><span className={`tg-badge ${r.state === 'active' ? 'tg-badge-ok' : ''}`}>{r.state}</span></td>
                <td className="text-xs">{r.note}</td>
                <td className="text-xs">{r.createdAt.toISOString().slice(0, 16).replace('T', ' ')}</td>
                <td className="whitespace-nowrap">
                  {canEdit && r.state === 'draft' ? <ActionButton url="/api/admin/templates" body={{ action: 'activate', id: r.id }} label="Activate" confirm="Make this the live wording?" /> : null}
                  {canEdit && r.state === 'draft' ? <ActionButton url="/api/admin/templates" body={{ action: 'delete_draft', id: r.id }} label="Delete draft" /> : null}
                </td>
              </tr>
            )) : <tr><td colSpan={6} className="text-sm text-gray-600">No staff-authored versions yet.</td></tr>}
          </tbody>
        </table>
      </section>
    </main>
  );
}
