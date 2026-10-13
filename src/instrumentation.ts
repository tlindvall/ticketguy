import { initLogger } from 'braintrust';

export function register() {
  if (process.env.NEXT_RUNTIME === 'nodejs' || process.env.NEXT_RUNTIME === 'edge') {
    initLogger({ projectName: 'My Project' });
  }
}
