import { toNextJsHandler } from 'better-auth/next-js';
import { getAuth } from '@/lib/auth';

export const dynamic = 'force-dynamic';

async function handler(req: Request) {
  const auth = await getAuth();
  const h = toNextJsHandler(auth);
  return req.method === 'GET' ? h.GET(req) : h.POST(req);
}
export { handler as GET, handler as POST };
