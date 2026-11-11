import { describe, expect, it, vi } from 'vitest';
import type { NextFunction, Request, Response } from 'express';

vi.mock('../src/config/env.js', () => ({
  corsOrigins: ['https://school.example'],
  isCorsOriginAllowed: (origin: string) => origin === 'https://school.example',
  isTest: false,
}));

import { csrfGuard, isOriginAllowed, requestOrigin } from '../src/middleware/csrf.js';

function runGuard(method: string, headers: Record<string, string> = {}) {
  const req = {
    method,
    get: (name: string) => headers[name.toLowerCase()],
  } as unknown as Request;
  let nextError: unknown;
  const next = ((error?: unknown) => {
    nextError = error;
  }) as NextFunction;
  csrfGuard(req, {} as Response, next);
  return nextError;
}

describe('CSRF origin checks', () => {
  it('accepts only exact configured origins', () => {
    expect(isOriginAllowed('https://school.example', ['https://school.example'])).toBe(true);
    expect(isOriginAllowed('https://school.example.attacker.test', ['https://school.example'])).toBe(false);
    expect(isOriginAllowed(undefined, ['https://school.example'])).toBe(false);
  });

  it('allows safe methods without an origin', () => {
    expect(runGuard('GET')).toBeUndefined();
  });

  it('allows state-changing requests from a configured origin', () => {
    expect(runGuard('POST', { origin: 'https://school.example' })).toBeUndefined();
  });

  it('blocks state-changing requests with a missing or untrusted origin', () => {
    expect(runGuard('POST')).toMatchObject({ statusCode: 403 });
    expect(runGuard('DELETE', { origin: 'https://attacker.test' })).toMatchObject({ statusCode: 403 });
  });

  it('uses the Referer origin when the Origin header is absent', () => {
    expect(requestOrigin({
      get: (name: string) => name === 'referer' ? 'https://school.example/settings' : undefined,
    } as unknown as Request)).toBe('https://school.example');
    expect(runGuard('PATCH', { referer: 'https://school.example/settings' })).toBeUndefined();
  });
});
