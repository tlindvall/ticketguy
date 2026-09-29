import { describe, expect, it } from 'vitest';
import { ago, briefLines, reasonText, stateInfo } from '@/lib/admin/labels';

describe('staff console wording', () => {
  it('says what a state means and which group it belongs in', () => {
    expect(stateInfo('awaiting_review')).toMatchObject({ label: 'Reply ready to approve', group: 'needs_you' });
    expect(stateInfo('manual_attention').group).toBe('needs_you');
    expect(stateInfo('needs_clarification').group).toBe('waiting_customer');
    expect(stateInfo('some_new_state').label).toBe('some new state');
  });

  it('turns reason codes into sentences, and field lists into the question we asked', () => {
    expect(reasonText('official_sale_open', 'referred')).toBe('Still on general sale; pointed to the official seller.');
    expect(reasonText('quantity,resolvedLocalDate', 'needs_clarification')).toBe('We asked how many tickets and which date.');
    expect(reasonText('Extraction failed twice: provider timeout', 'manual_attention')).toBe('Extraction failed twice: provider timeout');
  });

  it('shows only the brief fields that are set, in words', () => {
    const lines = briefLines({ intent: 'new_search', performerOrTeam: 'Miami Dolphins', resolvedLocalDate: '2026-10-11', quantity: 2, togetherRequired: true, budgetCents: null, quotedPriceCents: 10600, quotedPriceBasis: 'per_ticket', mustAttend: null });
    expect(lines).toEqual([
      ['Wants', 'Tickets for an event'],
      ['Event', 'Miami Dolphins'],
      ['When', 'Sun, Oct 11'],
      ['Tickets', '2, together'],
      ['Price they saw', '$106 per ticket'],
    ]);
  });

  it('says how long ago in the unit a person would use', () => {
    const now = Date.UTC(2026, 8, 29, 12);
    expect(ago(now - 30_000, now)).toBe('just now');
    expect(ago(now - 5 * 60_000, now)).toBe('5 min ago');
    expect(ago(now - 3 * 3_600_000, now)).toBe('3 h ago');
    expect(ago(now - 3 * 86_400_000, now)).toBe('3 days ago');
  });
});
