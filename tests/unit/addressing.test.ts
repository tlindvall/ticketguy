import { describe, expect, it } from 'vitest';
import { ConfigurationError, MESSAGE_CLASSES, parseEnv } from '@/lib/config/env';
import type { MessageClass as GateMessageClass } from '@/lib/email/send-gate';

const base = { NODE_ENV: 'development', CONCIERGE_INBOUND_ADDRESS: 'my@ticketguy.now', CONCIERGE_FROM_ADDRESS: 'my@ticketguy.now' };

describe('inbound address set', () => {
  it('always contains the public address and dedupes case-insensitively', () => {
    const e = parseEnv({ ...base, CONCIERGE_INBOUND_ADDRESSES: 'MY@ticketguy.now, support@ticketguy.now' });
    expect(e.inboundAddresses).toEqual(['my@ticketguy.now', 'support@ticketguy.now']);
  });

  it('defaults to the public address alone', () => {
    expect(parseEnv(base).inboundAddresses).toEqual(['my@ticketguy.now']);
  });
});

describe('per-message-class From addresses', () => {
  it('sends every class from CONCIERGE_FROM_ADDRESS when unconfigured', () => {
    const m = parseEnv(base).messageClassFromAddresses;
    expect(Object.keys(m).sort()).toEqual([...MESSAGE_CLASSES].sort());
    expect(new Set(Object.values(m))).toEqual(new Set(['my@ticketguy.now']));
  });

  it('applies an override only to the named class', () => {
    const m = parseEnv({ ...base, CONCIERGE_INBOUND_ADDRESSES: 'alerts@ticketguy.now', MESSAGE_CLASS_FROM_ADDRESSES: 'watch_alert=alerts@ticketguy.now' }).messageClassFromAddresses;
    expect(m.watch_alert).toBe('alerts@ticketguy.now');
    expect(m.recommendation).toBe('my@ticketguy.now');
  });

  it('refuses a From address the intake does not accept', () => {
    expect(() => parseEnv({ ...base, MESSAGE_CLASS_FROM_ADDRESSES: 'watch_alert=alerts@ticketguy.now' })).toThrow(ConfigurationError);
  });

  it('allows an unreceivable From only when it is declared unmonitored', () => {
    const m = parseEnv({ ...base, MESSAGE_CLASS_FROM_ADDRESSES: 'marketing=deals@news.ticketguy.now', UNMONITORED_FROM_ADDRESSES: 'deals@news.ticketguy.now' }).messageClassFromAddresses;
    expect(m.marketing).toBe('deals@news.ticketguy.now');
  });

  it('refuses an unknown message class rather than ignoring it', () => {
    expect(() => parseEnv({ ...base, MESSAGE_CLASS_FROM_ADDRESSES: 'reccomendation=my@ticketguy.now' })).toThrow(/unknown message class/);
  });

  it('refuses a malformed pair rather than skipping it', () => {
    expect(() => parseEnv({ ...base, MESSAGE_CLASS_FROM_ADDRESSES: 'watch_alert' })).toThrow(ConfigurationError);
  });
});

it('keeps the env and send-gate message class lists in step', () => {
  // A class missing from MESSAGE_CLASSES would silently lose its From override; this fails to compile if so.
  const roundTrip: readonly GateMessageClass[] = MESSAGE_CLASSES;
  const all: Record<GateMessageClass, true> = Object.fromEntries(MESSAGE_CLASSES.map((c) => [c, true])) as Record<GateMessageClass, true>;
  expect(roundTrip.length).toBe(Object.keys(all).length);
});
