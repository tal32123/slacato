import type { z } from 'zod';

type Primitive = bigint | boolean | null | number | string | symbol | undefined;

/** Recursively immutable value shape for parsed generated-output contracts. */
export type DeepReadonly<Value> = Value extends Primitive
  ? Value
  : Value extends (...arguments_: never[]) => unknown
    ? Value
    : Value extends readonly (infer Item)[]
      ? readonly DeepReadonly<Item>[]
      : Value extends object
        ? { readonly [Key in keyof Value]: DeepReadonly<Value[Key]> }
        : Value;

/** Freezes parsed output recursively, after Zod has validated and copied caller input. */
export function deepFreeze<Value>(value: Value): DeepReadonly<Value> {
  if (value !== null && typeof value === 'object') {
    for (const nestedValue of Object.values(value)) deepFreeze(nestedValue);
    Object.freeze(value);
  }
  return value as DeepReadonly<Value>;
}

/** Composes deep runtime freezing with a Zod schema and infers a deep readonly output. */
export function immutableSchema<Schema extends z.ZodType>(
  schema: Schema
): z.ZodType<DeepReadonly<z.output<Schema>>, z.input<Schema>> {
  return schema.transform((value): DeepReadonly<z.output<Schema>> => deepFreeze(value));
}
