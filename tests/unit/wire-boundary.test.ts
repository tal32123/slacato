import { z } from 'zod';
import { describe, expect, it } from 'vitest';
import { ZodRequestPipe } from '../../apps/api/src/common/wire/zod-request.pipe';
import { ApiWireBoundaryMiddleware } from '../../apps/api/src/common/wire/api-wire-boundary.middleware';

describe('ZodRequestPipe', () => {
  it('rejects unknown request fields with a safe typed error', () => {
    const pipe = new ZodRequestPipe(z.object({ id: z.string() }).strict());

    expect(() => pipe.transform({ id: 'run-1', secret: 'leak' })).toThrow();
    try {
      pipe.transform({ id: 'run-1', secret: 'leak' });
    } catch (error: unknown) {
      expect((error as { getResponse(): unknown }).getResponse()).toMatchObject({ code: 'INVALID_REQUEST' });
    }
  });
});

describe('ApiWireBoundaryMiddleware', () => {
  it('rejects oversized JSON requests with a typed safe error', () => {
    const middleware = new ApiWireBoundaryMiddleware();

    expect(() => middleware.use(
      { method: 'POST', headers: { 'content-type': 'application/json', 'content-length': '1048577' } } as never,
      {} as never,
      () => undefined
    )).toThrow();
    try {
      middleware.use(
        { method: 'POST', headers: { 'content-type': 'application/json', 'content-length': '1048577' } } as never,
        {} as never,
        () => undefined
      );
    } catch (error: unknown) {
      expect((error as { getResponse(): unknown }).getResponse()).toMatchObject({ code: 'REQUEST_TOO_LARGE' });
    }
  });
});
