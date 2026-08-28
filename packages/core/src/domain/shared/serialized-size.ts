import { z } from 'zod';

/**
 * Largest accepted serialized generated artifact or DealBrief (128 KiB).
 * This bounds storage, model-context fan-in, and export handling uniformly.
 */
export const MAX_SERIALIZED_ARTIFACT_BYTES = 128 * 1024;

/** Returns the UTF-8 byte length that a JSON value occupies when persisted or sent to a model. */
export function serializedByteLength(value: unknown): number {
  return new TextEncoder().encode(JSON.stringify(value)).byteLength;
}

/** Adds the shared serialized-size limit to a strict generated-output schema. */
export function withSerializedByteLimit<Schema extends z.ZodType>(schema: Schema, maxBytes = MAX_SERIALIZED_ARTIFACT_BYTES): Schema {
  return schema.superRefine((value, context) => {
    const actualBytes = serializedByteLength(value);
    if (actualBytes > maxBytes) {
      context.addIssue({
        code: 'custom',
        message: `Serialized value is ${actualBytes} bytes; maximum is ${maxBytes} bytes`
      });
    }
  }) as Schema;
}
