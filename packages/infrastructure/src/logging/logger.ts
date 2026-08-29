import pino, { type DestinationStream, type Logger } from 'pino';
import { redactLogPayload } from './redaction.js';

const PINO_REDACTION_PATHS = [
  'authorization',
  'cookie',
  'apiKey',
  'x-api-key',
  'auth',
  'credentials',
  'msg',
  'err',
  'error',
  'stack',
  'cause',
  'message',
  'messages',
  'prompt',
  'completion',
  'sourceBody',
  'sourceBodies',
  'sourceContent',
  'sourceContents',
  'evidenceExcerpt',
  'evidenceExcerpts',
  'headers.authorization',
  'headers.cookie',
  'headers.set-cookie',
  'headers.x-api-key',
  'req.headers.authorization',
  'req.headers.cookie',
  'req.headers.x-api-key'
] as const;

/** Ensures child loggers sanitize their inherited bindings through the same allowlist. */
function protectChildBindings<
  CustomLevels extends string = never,
  UseOnlyCustomLevels extends boolean = boolean
>(instance: Logger<CustomLevels, UseOnlyCustomLevels>): Logger<CustomLevels, UseOnlyCustomLevels> {
  const createChild = instance.child.bind(instance) as typeof instance.child;
  instance.child = <ChildCustomLevels extends string = never>(
    bindings: pino.Bindings,
    options?: pino.ChildLoggerOptions<ChildCustomLevels>
  ): Logger<CustomLevels | ChildCustomLevels> => {
    const sanitized = redactLogPayload(bindings);
    const safeBindings =
      sanitized !== null && typeof sanitized === 'object' && !Array.isArray(sanitized)
        ? sanitized
        : {};
    return protectChildBindings(createChild<ChildCustomLevels>(safeBindings, options));
  };
  return instance;
}

/** Creates a Pino logger that sanitizes every object before Pino serialization and destination writes. */
export function createSafeLogger(destination?: DestinationStream): Logger {
  const options: pino.LoggerOptions = {
    base: null,
    level: 'info',
    timestamp: pino.stdTimeFunctions.isoTime,
    redact: { paths: [...PINO_REDACTION_PATHS], censor: '[REDACTED]' },
    hooks: {
      logMethod(args, method) {
        const safeArgs = args.map((argument) =>
          argument !== null && typeof argument === 'object'
            ? redactLogPayload(argument)
            : typeof argument === 'string'
              ? '[REDACTED]'
              : argument
        );
        Reflect.apply(method, this, safeArgs);
      }
    }
  };
  const instance = destination === undefined ? pino(options) : pino(options, destination);
  return protectChildBindings(instance);
}

/** Process-wide structured logger; callers emit event objects rather than free-form messages. */
export const logger = createSafeLogger();
