jest.mock('../demoHttps', () => ({
  onCall: (handler: unknown) => handler,
  HttpsError: class extends Error {},
}));
jest.mock('fs', () => ({ ...jest.requireActual('fs'), readdirSync: jest.fn() }));

import * as fs from 'fs';
import { getAvailablePrompts } from '../availablePrompts';
import { DEMO_MODEL_RATES } from '../demoPaidProviders';

describe('demo model catalog', () => {
  afterEach(() => jest.restoreAllMocks());

  it('offers only models admitted by the paid-processing guard', async () => {
    (fs.readdirSync as jest.Mock).mockReturnValue([]);
    const handler = getAvailablePrompts as unknown as (request: unknown) => Promise<{
      analyzerModels: { available: string[]; default: string };
    }>;
    const result = await handler({ auth: { uid: 'demo-admin' } });
    expect(result.analyzerModels.default).toBe('gpt-5.4');
    expect(result.analyzerModels.available).toEqual(Object.keys(DEMO_MODEL_RATES));
    expect(result.analyzerModels.available).not.toContain('gpt-6-astra');
  });
});
