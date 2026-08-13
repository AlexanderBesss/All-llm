import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";

type SchemaType = "object" | "array" | "string" | "boolean" | "integer" | "number" | "null";

type Schema = {
  type?: SchemaType | SchemaType[];
  required?: string[];
  properties?: Record<string, Schema>;
  additionalProperties?: boolean;
  items?: Schema;
  enum?: unknown[];
  anyOf?: Schema[];
  minItems?: number;
  minimum?: number;
};

const schemas = new Map<string, Promise<Schema>>();

export function factorySchemaPath(repoPath: string, fileName: string): string {
  const nested = path.join(repoPath, "factory", "src", "schemas", fileName);
  if (existsSync(nested)) return nested;
  return path.join(repoPath, "src", "schemas", fileName);
}

function matchesSingleType(value: unknown, type: SchemaType): boolean {
  if (type === "null") return value === null;
  if (type === "array") return Array.isArray(value);
  if (type === "object") return Boolean(value && typeof value === "object" && !Array.isArray(value));
  if (type === "integer") return Number.isInteger(value);
  if (type === "number") return typeof value === "number" && Number.isFinite(value);
  return typeof value === type;
}

function matchesType(value: unknown, type: SchemaType | SchemaType[]): boolean {
  return Array.isArray(type)
    ? type.some((candidate) => matchesSingleType(value, candidate))
    : matchesSingleType(value, type);
}

function validationErrors(value: unknown, schema: Schema, location = "/"): string[] {
  if (schema.anyOf) {
    if (schema.anyOf.some((candidate) => validationErrors(value, candidate, location).length === 0)) return [];
    return [`${location} must match one schema in anyOf`];
  }
  if (schema.enum && !schema.enum.some((candidate) => Object.is(candidate, value))) {
    return [`${location} must be one of ${schema.enum.map(String).join(", ")}`];
  }
  if (schema.type && !matchesType(value, schema.type)) {
    const expected = Array.isArray(schema.type) ? schema.type.join(" or ") : schema.type;
    return [`${location} must be ${expected}`];
  }

  const errors: string[] = [];
  if (schema.type === "object" && matchesType(value, "object")) {
    const record = value as Record<string, unknown>;
    for (const required of schema.required || []) {
      if (!Object.prototype.hasOwnProperty.call(record, required)) errors.push(`${location} must have required property '${required}'`);
    }
    for (const [key, child] of Object.entries(schema.properties || {})) {
      if (Object.prototype.hasOwnProperty.call(record, key)) {
        errors.push(...validationErrors(record[key], child, `${location === "/" ? "" : location}/${key}` || "/"));
      }
    }
    if (schema.additionalProperties === false) {
      const allowed = new Set(Object.keys(schema.properties || {}));
      for (const key of Object.keys(record)) {
        if (!allowed.has(key)) errors.push(`${location} must not have additional property '${key}'`);
      }
    }
  }
  if (schema.type === "array" && matchesType(value, "array")) {
    const values = value as unknown[];
    if (schema.minItems !== undefined && values.length < schema.minItems) errors.push(`${location} must contain at least ${schema.minItems} item(s)`);
    if (schema.items) values.forEach((item, index) => errors.push(...validationErrors(item, schema.items!, `${location === "/" ? "" : location}/${index}` || "/")));
  }
  if ((schema.type === "integer" || schema.type === "number") && schema.minimum !== undefined && (value as number) < schema.minimum) {
    errors.push(`${location} must be >= ${schema.minimum}`);
  }
  return errors;
}

async function schemaFor(schemaPath: string): Promise<Schema> {
  const existing = schemas.get(schemaPath);
  if (existing) return existing;
  const pending = readFile(schemaPath, "utf8").then((source) => JSON.parse(source) as Schema);
  schemas.set(schemaPath, pending);
  return pending;
}

export async function assertSchema(value: unknown, schemaPath: string): Promise<void> {
  const errors = validationErrors(value, await schemaFor(schemaPath));
  if (!errors.length) return;
  throw new Error(`Agent result does not satisfy ${schemaPath}: ${errors.join("; ")}`);
}
