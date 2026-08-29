import { BadRequestException, ConflictException, ForbiddenException, NotFoundException } from '@nestjs/common';
import type { AppError, DecideApproval, StartDealBrief } from '@slacato/core';

export const START_DEAL_BRIEF = Symbol('START_DEAL_BRIEF');
export const DECIDE_APPROVAL = Symbol('DECIDE_APPROVAL');

export type WorkflowApiOptions = Readonly<{
  startDealBrief: StartDealBrief;
  decideApproval: DecideApproval;
}>;


export function toHttpError(error: unknown): never {
  const applicationError = error as Partial<AppError>;
  const body = { code: applicationError.code ?? 'INTERNAL_ERROR', message: applicationError.safeMessage ?? 'The request could not be completed.' };
  if (applicationError.code === 'AUTHORIZATION_DENIED') throw new ForbiddenException(body);
  if (applicationError.code === 'NOT_FOUND') throw new NotFoundException(body);
  if (applicationError.code === 'CONFLICT' || applicationError.code === 'INVALID_RUN_TRANSITION') throw new ConflictException(body);
  if (applicationError.code === 'VALIDATION_FAILED') throw new BadRequestException(body);
  throw error;
}