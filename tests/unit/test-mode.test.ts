import { afterEach, describe, expect, it } from 'vitest';
import { ConfigurationError, parseEnv, resetEnvForTests } from '@/lib/config/env';
import { evaluateGate } from '@/lib/email/send-gate';
import { testAgentAuthorized } from '@/lib/util/cron-auth';

const live = parseEnv({ NODE_ENV: 'test', APP_MODE: 'live', EMAIL_SEND_ENABLED: 'true', RESEND_API_KEY: 're_x', EXTRACTION_PROVIDER: 'rules', EMAIL_TEST_RECIPIENT_ALLOWLIST: 'tester@customer.example' });
const base = { messageClass: 'acknowledgment' as const, recipientLookup: 'persona@example.com', approved: false, approvalHashMatches: false, revisionCurrent: true, evidenceFresh: true, containsFixtureData: false, marketingPermission: false };

describe('test mode at the send gate', () => {
  it('lifts only the tester allowlist, since a recorded send reaches nobody', () => {
    expect(evaluateGate(live, {}, new Set(), base)).toEqual({ allowed: false, reasons: ['recipient_not_in_test_allowlist'] });
    expect(evaluateGate(live, {}, new Set(), { ...base, testMode: true })).toEqual({ allowed: true });
  });

  it('every other check still applies', () => {
    const r = evaluateGate(live, { all_outbound: false }, new Set(['global']), { ...base, testMode: true, containsFixtureData: true, revisionCurrent: false });
    expect(r).toEqual({ allowed: false, reasons: ['content_contains_fixture_data', 'kill_switch_all_outbound', 'suppressed_global', 'revision_stale'] });
    const rec = evaluateGate(live, {}, new Set(), { ...base, messageClass: 'recommendation', testMode: true });
    expect(rec.allowed === false && rec.reasons).toEqual(['not_approved', 'approval_hash_mismatch']);
  });
});

describe('the test agent token', () => {
  afterEach(() => {
    delete process.env.TEST_AGENT_TOKEN;
    resetEnvForTests();
  });

  it('must be long enough when set, and is optional', () => {
    expect(() => parseEnv({ NODE_ENV: 'test', TEST_AGENT_TOKEN: 'short' })).toThrow(ConfigurationError);
    expect(parseEnv({ NODE_ENV: 'test' }).TEST_AGENT_TOKEN).toBeUndefined();
  });

  it('authorizes the exact bearer token only, and never throws on odd input', () => {
    process.env.TEST_AGENT_TOKEN = 'a'.repeat(40);
    resetEnvForTests();
    const req = (auth?: string) => new Request('https://x.example/api/test/requests', { headers: auth ? { authorization: auth } : {} });
    expect(testAgentAuthorized(req(`Bearer ${'a'.repeat(40)}`))).toBe(true);
    expect(testAgentAuthorized(req(`Bearer ${'a'.repeat(39)}b`))).toBe(false);
    expect(testAgentAuthorized(req())).toBe(false);
    // Same string length, different byte length.
    expect(testAgentAuthorized(req(`Bearer ${'é'.repeat(40)}`))).toBe(false);
  });
});
