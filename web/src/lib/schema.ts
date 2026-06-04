// Client-side mirror of src/config-schema.ts's validator. Used for instant
// feedback as the user edits; the server re-validates authoritatively on PUT.
// The schema itself is delivered by the API (GET .../config), so this walks
// whatever the server sent rather than embedding its own copy.

import type { ConfigValidationError, JsonSchema } from "../api/types";

function typeOf(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  return typeof value;
}

function matchesType(value: unknown, type: NonNullable<JsonSchema["type"]>): boolean {
  switch (type) {
    case "object":
      return typeOf(value) === "object";
    case "array":
      return Array.isArray(value);
    case "string":
      return typeof value === "string";
    case "boolean":
      return typeof value === "boolean";
    case "number":
      return typeof value === "number" && Number.isFinite(value);
    case "integer":
      return typeof value === "number" && Number.isInteger(value);
  }
}

function walk(value: unknown, schema: JsonSchema, path: string, errors: ConfigValidationError[]): void {
  if (value === undefined || value === null) return;

  if (schema.type && !matchesType(value, schema.type)) {
    errors.push({ path: path || "(root)", message: `expected ${schema.type}, got ${typeOf(value)}` });
    return;
  }

  if (schema.enum && !schema.enum.includes(value as string | number)) {
    errors.push({ path: path || "(root)", message: `must be one of: ${schema.enum.join(", ")}` });
  }

  if ((schema.type === "integer" || schema.type === "number") && typeof schema.minimum === "number") {
    if (typeof value === "number" && value < schema.minimum) {
      errors.push({ path: path || "(root)", message: `must be >= ${schema.minimum}` });
    }
  }

  if (schema.type === "object" && typeOf(value) === "object") {
    const obj = value as Record<string, unknown>;
    const props = schema.properties ?? {};
    for (const req of schema.required ?? []) {
      if (obj[req] === undefined || obj[req] === null) {
        errors.push({ path: path ? `${path}.${req}` : req, message: "is required" });
      }
    }
    for (const [key, child] of Object.entries(obj)) {
      const childPath = path ? `${path}.${key}` : key;
      const childSchema = props[key];
      if (!childSchema) {
        if (schema.additionalProperties === false) {
          errors.push({ path: childPath, message: "unknown option" });
        }
        continue;
      }
      walk(child, childSchema, childPath, errors);
    }
  }

  if (schema.type === "array" && Array.isArray(value) && schema.items) {
    value.forEach((item, i) => walk(item, schema.items as JsonSchema, `${path}[${i}]`, errors));
  }
}

export function validateAgainstSchema(value: unknown, schema: JsonSchema): ConfigValidationError[] {
  const errors: ConfigValidationError[] = [];
  if (typeOf(value) !== "object") {
    return [{ path: "(root)", message: `expected a YAML mapping, got ${typeOf(value)}` }];
  }
  walk(value, schema, "", errors);
  return errors;
}

/** A sensible empty value for a schema node — used when adding array items. */
export function emptyValueFor(schema: JsonSchema): unknown {
  switch (schema.type) {
    case "object": {
      const obj: Record<string, unknown> = {};
      for (const req of schema.required ?? []) {
        const child = schema.properties?.[req];
        if (child) obj[req] = emptyValueFor(child);
      }
      return obj;
    }
    case "array":
      return [];
    case "boolean":
      return false;
    case "integer":
    case "number":
      return 0;
    case "string":
    default:
      return "";
  }
}

/** Title-case a snake_case schema key for form labels. */
export function humanizeKey(key: string): string {
  return key.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}
