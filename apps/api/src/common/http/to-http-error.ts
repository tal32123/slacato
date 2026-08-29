import { BadRequestException, ConflictException, NotFoundException } from '@nestjs/common';
import type { AppError } from '@slacato/core';

/** Translates an application error into its HTTP delivery exception. */
export function toHttpError(error: unknown): never {
  const applicationError = error as Partial<AppError>;
  if (applicationError.code === 'AUTHORIZATION_DENIED' || applicationError.code === 'NOT_FOUND') {
    throw new NotFoundException({ code: 'NOT_FOUND', message: 'The requested resource was not found.' });
  }
  const body = { code: applicationError.code ?? 'INTERNAL_ERROR', message: applicationError.safeMessage ?? 'The request could not be completed.' };
  if (applicationError.code === 'CONFLICT' || applicationError.code === 'INVALID_RUN_TRANSITION') throw new ConflictException(body);
  if (applicationError.code === 'VALIDATION_FAILED') throw new BadRequestException(body);
  throw error;
}
