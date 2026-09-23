import { describe, expect, it } from 'vitest';
import { fetchReceivedEmail } from '@/lib/email/resend';

const respond = (status: number, body: unknown) =>
  (async () => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })) as unknown as typeof fetch;

/**
 * A bare status code cannot tell a restricted key from a wrong id, which is the difference between
 * "rotate the key" and "the endpoint is wrong". The provider says which; the error has to carry it.
 */
describe('received-email fetch failures', () => {
  it('names a restricted API key rather than reporting a bare 401', async () => {
    await expect(fetchReceivedEmail('re_test', 'abc', respond(401, { statusCode: 401, name: 'restricted_api_key', message: 'This API key is restricted to only send emails' })))
      .rejects.toThrow('resend_receive_fetch_failed:401:restricted_api_key: This API key is restricted to only send emails');
  });

  it('distinguishes a missing email from a rejected key', async () => {
    await expect(fetchReceivedEmail('re_test', 'abc', respond(404, { name: 'not_found', message: 'Email not found' })))
      .rejects.toThrow('resend_receive_fetch_failed:404:not_found: Email not found');
  });

  it('still reports the status when the body is not the expected envelope', async () => {
    const html = (async () => new Response('<html>nope</html>', { status: 502 })) as unknown as typeof fetch;
    await expect(fetchReceivedEmail('re_test', 'abc', html)).rejects.toThrow('resend_receive_fetch_failed:502');
  });

  it('bounds the provider message so a large error body cannot flood the outbox row', async () => {
    try {
      await fetchReceivedEmail('re_test', 'abc', respond(400, { name: 'validation_error', message: 'x'.repeat(5_000) }));
      expect.unreachable('should have thrown');
    } catch (e) {
      expect((e as Error).message.length).toBeLessThan(300);
    }
  });

  it('never puts the API key in the error', async () => {
    try {
      await fetchReceivedEmail('re_super_secret_key', 'abc', respond(401, { name: 'invalid_api_key', message: 'API key is invalid' }));
      expect.unreachable('should have thrown');
    } catch (e) {
      expect((e as Error).message).not.toContain('re_super_secret_key');
    }
  });
});
