import {
  array,
  boolean,
  fallback,
  looseObject,
  nullish,
  number,
  object,
  optional,
  parse,
  picklist,
  string,
  type BaseIssue,
  type BaseSchema,
  type InferOutput,
  type ObjectEntries,
} from "valibot";

export function defaultString(value = "") {
  return fallback(nullish(string(), value), value);
}

export function defaultNumber(value: number) {
  return fallback(nullish(number(), value), value);
}

export function defaultBoolean(value: boolean) {
  return fallback(nullish(boolean(), value), value);
}

export function optionalString() {
  return fallback(optional(string()), undefined);
}

export function optionalBoolean() {
  return fallback(optional(boolean()), undefined);
}

export function defaultLooseObject<const TEntries extends ObjectEntries>(
  entries: TEntries,
) {
  const schema = looseObject(entries);
  const createDefault = () => ({} as InferOutput<typeof schema>);
  return fallback(nullish(schema, createDefault), createDefault);
}

export function defaultPicklist<
  const TOptions extends readonly [
    string | number | bigint,
    ...(string | number | bigint)[],
  ],
>(options: TOptions, value: TOptions[number]) {
  return fallback(nullish(picklist(options), value), value);
}

export function defaultArray<
  TItem extends BaseSchema<unknown, unknown, BaseIssue<unknown>>,
>(item: TItem) {
  const createDefault = (): InferOutput<TItem>[] => [];
  return fallback(nullish(array(item), createDefault), createDefault);
}

export function defaultStringArray() {
  return defaultArray(string());
}

type ParsedDefaults<TEntries extends ObjectEntries> = {
  -readonly [TKey in keyof TEntries]-?: InferOutput<TEntries[TKey]>;
};

export function parseDefaults<const TEntries extends ObjectEntries>(
  entries: TEntries,
  input: unknown,
): ParsedDefaults<TEntries> {
  return parse(object(entries), input, { abortEarly: true }) as ParsedDefaults<TEntries>;
}

export function mergeDefaults<const TEntries extends ObjectEntries>(
  entries: TEntries,
  input: unknown,
): Record<string, unknown> & ParsedDefaults<TEntries> {
  const source =
    input !== null && typeof input === "object" && !Array.isArray(input)
      ? input
      : {};
  return {
    ...source,
    ...parseDefaults(entries, source),
  } as Record<string, unknown> & ParsedDefaults<TEntries>;
}
