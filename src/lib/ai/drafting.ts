import type { AdvicePacket } from '@/lib/advice/packet';
import type { ResponseBlocks } from '@/lib/advice/renderer';

/**
 * Stage 3: explain the verified comparison. The drafter sees ONLY the packet (claim IDs + server text) and
 * minimal customer context (quantity, priorities). It returns structured blocks; the renderer validates.
 */
export type DraftContext = { quantity: number; mustAttend: boolean | null; waitRiskTolerance: 'low' | 'medium' | 'high' | null; togetherRequired: boolean | null };

export interface Drafter {
  readonly name: string;
  draft(packet: AdvicePacket, ctx: DraftContext): Promise<ResponseBlocks>;
}

/** Deterministic drafter for fixture mode: always compliant with the renderer's rules. */
export class FixtureDrafter implements Drafter {
  readonly name = 'fixture';
  async draft(packet: AdvicePacket, ctx: DraftContext): Promise<ResponseBlocks> {
    const ids = new Set(packet.claimRecords.filter((c) => c.customerVisible).map((c) => c.id));
    const groupWord = ctx.quantity > 1 ? `${ctx.togetherRequired ? 'seats together' : 'seats'} for your group` : 'a seat';
    const opening: Record<AdvicePacket['decision'], string> = {
      buy_now: `For ${groupWord}, I would be comfortable taking the option below.`,
      wait_and_recheck: `For ${groupWord}, a bounded wait is reasonable — with a clear point to decide.`,
      consider_alternative: `Nothing qualifying fits inside your budget right now; here is the closest verified alternative.`,
      insufficient_evidence: `We could not verify a suitable option yet; here is exactly what we checked.`,
    };
    const paragraphs: ResponseBlocks['paragraphs'] = [];
    if (ids.has('C_BEST')) paragraphs.push({ claimIds: ['C_BEST'], prose: 'Best verified option for your group:' });
    else if (ids.has('C_ALT1')) paragraphs.push({ claimIds: ['C_ALT1'], prose: 'Closest verified option:' });
    const context: string[] = [];
    if (ids.has('C_BENCH')) context.push('C_BENCH');
    else if (ids.has('C_NOHIST')) context.push('C_NOHIST');
    if (ids.has('C_TREND')) context.push('C_TREND');
    else if (ids.has('C_NOTREND')) context.push('C_NOTREND');
    if (context.length) paragraphs.push({ claimIds: context, prose: 'How this compares:' });
    const group: string[] = [];
    if (ids.has('C_ENTRY')) group.push('C_ENTRY');
    if (ids.has('C_COUNT')) group.push('C_COUNT');
    if (group.length) paragraphs.push({ claimIds: group, prose: ctx.quantity > 1 ? 'Why your group size matters here:' : 'Options observed:' });
    const alts = ['C_ALT1', 'C_ALT2'].filter((id) => ids.has(id) && !(paragraphs[0]?.claimIds.includes(id)));
    if (alts.length) paragraphs.push({ claimIds: alts, prose: 'Alternatives, clearly labeled as different seats or conditions:' });
    if (ids.has('C_CHECKPOINT')) paragraphs.push({ claimIds: ['C_CHECKPOINT'], prose: 'What I would do next:' });
    const closing: Record<AdvicePacket['decision'], string> = {
      buy_now: ctx.mustAttend ? 'Since attending together matters more than the last few dollars, I would secure this rather than risk losing it.' : 'This is a reasonable buy on the evidence we have; reply if you want us to keep looking instead.',
      wait_and_recheck: 'Waiting carries the risk that these options disappear; if that would be a problem, buy now instead.',
      consider_alternative: 'Reply if you want us to watch for something inside your budget, or if a different date or section would work.',
      insufficient_evidence: 'Reply with any extra detail and we will look again.',
    };
    return { decision: packet.decision, opening: opening[packet.decision], paragraphs, closing: closing[packet.decision] };
  }
}
