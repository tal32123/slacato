import { request } from 'node:http';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Body, Controller, Module, Post } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { IsString } from 'class-validator';
import { z } from 'zod';
import { ZodRequestPipe } from '../../apps/api/src/common/wire/zod-request.pipe';
import { ApiWireBoundaryMiddleware } from '../../apps/api/src/common/wire/api-wire-boundary.middleware';
import { ClassDtoBody, ZodBody, ZodResponse, createSsePublisher, validateSseEnvelope } from '../../apps/api/src/common/wire/zod.decorators';
import { configureApiApplication } from '../../apps/api/src/main';

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

it('rejects malformed SSE envelopes before they are serialized', () => {
  expect(() => validateSseEnvelope({ id: 'event-1', streamId: 'run-1', type: 'progress', timestamp: new Date().toISOString(), version: 1, payload: {}, hidden: true })).toThrow();
});

it('does not publish an invalid SSE envelope through the shared publisher primitive', () => {
  const emitted: unknown[] = [];
  const publish = createSsePublisher((envelope) => emitted.push(envelope));
  expect(() => publish({ id: 'event-1', streamId: 'run-1', type: 'progress', timestamp: new Date().toISOString(), version: 1, payload: {}, hidden: true })).toThrow();
  expect(emitted).toEqual([]);
});

const payloadSchema = z.object({ id: z.string() }).strict();

class WireTestController {
  public echo(body: { id: string }): { id: string } {
    return body;
  }

  public invalidResponse(_body: { id: string }): unknown {
    void _body;
    return { id: 'safe', unexpected: true };
  }

  public undecorated(body: unknown): unknown {
    return body;
  }

  public classDto(body: TestDto): TestDto {
    return body;
  }
}

class TestDto {
  public id!: string;
}

class WireTestModule {}

Controller('wire-test')(WireTestController);
for (const [method, path] of [['echo', 'echo'], ['invalidResponse', 'invalid-response']] as const) {
  const descriptor = Object.getOwnPropertyDescriptor(WireTestController.prototype, method)!;
  Post(path)(WireTestController.prototype, method, descriptor);
  ZodResponse(payloadSchema)(WireTestController.prototype, method, descriptor);
  ZodBody(payloadSchema)(WireTestController.prototype, method, 0);
}
const undecoratedDescriptor = Object.getOwnPropertyDescriptor(WireTestController.prototype, 'undecorated')!;
Post('undecorated')(WireTestController.prototype, 'undecorated', undecoratedDescriptor);
Body()(WireTestController.prototype, 'undecorated', 0);

const classDtoDescriptor = Object.getOwnPropertyDescriptor(WireTestController.prototype, 'classDto')!;
Post('class-dto')(WireTestController.prototype, 'classDto', classDtoDescriptor);
ZodResponse(payloadSchema)(WireTestController.prototype, 'classDto', classDtoDescriptor);
ClassDtoBody()(WireTestController.prototype, 'classDto', 0);
Reflect.defineMetadata('design:paramtypes', [TestDto], WireTestController.prototype, 'classDto');
IsString()(TestDto.prototype, 'id');
Module({ controllers: [WireTestController] })(WireTestModule);

describe('configured API wire boundary', () => {
  let app: Awaited<ReturnType<typeof NestFactory.create>>;
  let baseUrl = '';

  beforeEach(async () => {
    app = await NestFactory.create(WireTestModule, { bodyParser: false, logger: false });
    configureApiApplication(app);
    await app.listen(0, '127.0.0.1');
    const address = app.getHttpServer().address() as { port: number };
    baseUrl = `http://127.0.0.1:${address.port}`;
  });

  afterEach(async () => app.close());

  it('returns typed errors for malformed JSON and unknown request properties', async () => {
    const malformed = await fetch(`${baseUrl}/wire-test/echo`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"id":' });
    expect(malformed.status).toBe(400);
    await expect(malformed.json()).resolves.toMatchObject({ code: 'INVALID_JSON' });

    const extra = await fetch(`${baseUrl}/wire-test/echo`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id: 'run-1', unexpected: true }) });
    expect(extra.status).toBe(400);
    await expect(extra.json()).resolves.toMatchObject({ code: 'INVALID_REQUEST' });
  });

  it('rejects an undecorated controller body so request validation cannot be bypassed', async () => {
    const response = await fetch(`${baseUrl}/wire-test/undecorated`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id: 'run-1' }) });
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({ code: 'WIRE_SCHEMA_REQUIRED' });
  });

  it('keeps strict class DTO validation behind explicit fallback metadata', async () => {
    const response = await fetch(`${baseUrl}/wire-test/class-dto`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id: 42, extra: true }) });
    expect(response.status).toBe(400);
  });

  it('validates actual controller responses', async () => {
    const response = await fetch(`${baseUrl}/wire-test/invalid-response`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id: 'run-1' }) });
    expect(response.status).toBe(500);
    await expect(response.json()).resolves.toMatchObject({ code: 'INVALID_RESPONSE' });
  });

  it('returns a typed 413 for an oversized chunked JSON body without Content-Length', async () => {
    const response = await requestChunked(`${baseUrl}/wire-test/echo`, JSON.stringify({ id: 'x'.repeat(1_048_577) }));
    expect(response.statusCode).toBe(413);
    expect(JSON.parse(response.body)).toMatchObject({ code: 'REQUEST_TOO_LARGE' });
  });

  it('returns typed safe errors for unsupported, declared oversized, and other parser failures', async () => {
    const unsupported = await fetch(`${baseUrl}/wire-test/echo`, { method: 'POST', headers: { 'content-type': 'text/plain' }, body: '{"id":"run-1"}' });
    expect(unsupported.status).toBe(415);
    await expect(unsupported.json()).resolves.toMatchObject({ code: 'UNSUPPORTED_CONTENT_TYPE' });

    const oversizedJson = JSON.stringify({ id: 'x'.repeat(1_048_577) });
    const declaredOversized = await requestWithHeaders(`${baseUrl}/wire-test/echo`, oversizedJson, { 'content-type': 'application/json', 'content-length': String(Buffer.byteLength(oversizedJson)) });
    expect(declaredOversized.statusCode).toBe(413);
    expect(JSON.parse(declaredOversized.body)).toMatchObject({ code: 'REQUEST_TOO_LARGE' });

    const invalidEncoding = await requestWithHeaders(`${baseUrl}/wire-test/echo`, '{"id":"run-1"}', { 'content-type': 'application/json', 'content-encoding': 'gzip' });
    expect(invalidEncoding.statusCode).toBe(400);
    expect(JSON.parse(invalidEncoding.body)).toMatchObject({ code: 'INVALID_REQUEST' });
  });
});

function requestChunked(url: string, body: string): Promise<{ statusCode: number | undefined; body: string }> {
  const target = new URL(url);
  return new Promise((resolve, reject) => {
    const client = request({ hostname: target.hostname, port: target.port, path: target.pathname, method: 'POST', headers: { 'content-type': 'application/json' } }, (response) => {
      let received = '';
      response.setEncoding('utf8');
      response.on('data', (chunk: string) => { received += chunk; });
      response.on('end', () => resolve({ statusCode: response.statusCode, body: received }));
    });
    client.on('error', reject);
    client.write(body.slice(0, 256));
    client.end(body.slice(256));
  });
}

function requestWithHeaders(url: string, body: string, headers: Record<string, string>): Promise<{ statusCode: number | undefined; body: string }> {
  const target = new URL(url);
  return new Promise((resolve, reject) => {
    const client = request({ hostname: target.hostname, port: target.port, path: target.pathname, method: 'POST', headers }, (response) => {
      let received = '';
      response.setEncoding('utf8');
      response.on('data', (chunk: string) => { received += chunk; });
      response.on('end', () => resolve({ statusCode: response.statusCode, body: received }));
    });
    client.on('error', reject);
    client.end(body);
  });
}
