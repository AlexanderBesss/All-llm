export interface JsonObject {
  [key: string]: JsonValue;
}

export type JsonValue = string | number | boolean | null | JsonObject | JsonValue[];

export type UnknownRecord = Record<string, unknown>;
