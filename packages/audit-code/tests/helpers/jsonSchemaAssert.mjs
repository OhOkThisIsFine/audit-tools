import assert from "node:assert/strict";

function typeMatches(value, expected) {
  if (expected === "null") {
    return value === null;
  }
  if (expected === "array") {
    return Array.isArray(value);
  }
  if (expected === "integer") {
    return Number.isInteger(value);
  }
  if (expected === "object") {
    return typeof value === "object" && value !== null && !Array.isArray(value);
  }
  return typeof value === expected;
}

function describeValue(value) {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  return typeof value;
}

function isObjectLike(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normalizeSchemaRegistry(schemaRegistry) {
  const registry = new Map();
  if (!schemaRegistry) {
    return registry;
  }

  if (schemaRegistry instanceof Map) {
    for (const [key, schema] of schemaRegistry.entries()) {
      registry.set(key, schema);
    }
    return registry;
  }

  for (const [key, schema] of Object.entries(schemaRegistry)) {
    registry.set(key, schema);
  }
  return registry;
}

function resolveJsonPointer(documentRoot, pointer) {
  if (pointer === "#" || pointer === "") {
    return documentRoot;
  }
  const parts = pointer
    .replace(/^#\//, "")
    .split("/")
    .map((part) => part.replace(/~1/g, "/").replace(/~0/g, "~"));

  let current = documentRoot;
  for (const part of parts) {
    assert.ok(
      current !== null &&
        typeof current === "object" &&
        Object.prototype.hasOwnProperty.call(current, part),
      `Unable to resolve JSON pointer ${pointer}`,
    );
    current = current[part];
  }
  return current;
}

function resolveExternalDocument(ref, context) {
  if (ref === context.baseId) {
    return context.rootSchema;
  }
  if (context.registry.has(ref)) {
    return context.registry.get(ref);
  }

  if (typeof context.baseId === "string") {
    try {
      const resolved = new URL(ref, context.baseId).toString();
      if (context.registry.has(resolved)) {
        return context.registry.get(resolved);
      }
    } catch {
      // Ignore invalid URL resolution for non-URL schema ids.
    }
  }

  assert.fail(`Unable to resolve schema reference ${ref}`);
}

function resolveReferencedSchema(ref, context) {
  if (ref.startsWith("#")) {
    return {
      schema: resolveJsonPointer(context.rootSchema, ref),
      context,
    };
  }

  const [documentRef, fragment = ""] = ref.split("#");
  const documentRoot = resolveExternalDocument(documentRef, context);
  const nextContext = {
    ...context,
    rootSchema: documentRoot,
    baseId:
      (documentRoot &&
        typeof documentRoot === "object" &&
        typeof documentRoot.$id === "string" &&
        documentRoot.$id) ||
      documentRef,
  };

  return {
    schema: fragment
      ? resolveJsonPointer(documentRoot, `#${fragment}`)
      : documentRoot,
    context: nextContext,
  };
}

function tryValidateNode(schema, value, path, context) {
  try {
    validateNode(schema, value, path, context);
    return null;
  } catch (error) {
    return error instanceof Error ? error : new Error(String(error));
  }
}

function validateCombinerKeywords(schema, value, path, context) {
  if (Array.isArray(schema.allOf) && schema.allOf.length > 0) {
    for (const branch of schema.allOf) {
      validateNode(branch, value, path, context);
    }
  }

  if (Array.isArray(schema.anyOf) && schema.anyOf.length > 0) {
    const errors = schema.anyOf
      .map((branch) => tryValidateNode(branch, value, path, context))
      .filter((error) => error !== null);
    assert.ok(
      errors.length < schema.anyOf.length,
      `${path} must satisfy at least one anyOf branch`,
    );
  }

  if (Array.isArray(schema.oneOf) && schema.oneOf.length > 0) {
    const passCount = schema.oneOf.reduce(
      (count, branch) =>
        count +
        (tryValidateNode(branch, value, path, context) === null ? 1 : 0),
      0,
    );
    assert.equal(passCount, 1, `${path} must satisfy exactly one oneOf branch`);
  }

  if (schema.not !== undefined && schema.not !== null) {
    const notError = tryValidateNode(schema.not, value, path, context);
    assert.ok(
      notError !== null,
      `${path} must NOT satisfy the 'not' schema`,
    );
  }
}

function validateIfThenKeyword(schema, value, path, context) {
  if (!schema.if) {
    return;
  }
  const ifError = tryValidateNode(schema.if, value, path, context);
  if (ifError === null) {
    if (schema.then) {
      validateNode(schema.then, value, path, context);
    }
  } else {
    if (schema.else) {
      validateNode(schema.else, value, path, context);
    }
  }
}

function validateConstKeyword(schema, value, path) {
  if (Object.prototype.hasOwnProperty.call(schema, "const")) {
    assert.deepEqual(
      value,
      schema.const,
      `${path} must equal ${JSON.stringify(schema.const)}`,
    );
  }
}

function validateEnumKeyword(schema, value, path) {
  if (schema.enum) {
    assert.ok(
      schema.enum.includes(value),
      `${path} must be one of ${schema.enum.join(", ")}`,
    );
  }
}

function validateTypeKeyword(schema, value, path) {
  if (schema.type) {
    const allowed = Array.isArray(schema.type) ? schema.type : [schema.type];
    assert.ok(
      allowed.some((entry) => typeMatches(value, entry)),
      `${path} must be of type ${allowed.join(" or ")}, got ${describeValue(value)}`,
    );
  }
}

function shouldValidateObjectKeywords(schema, value) {
  return (
    schema.type === "object" ||
    (Array.isArray(schema.type) &&
      schema.type.includes("object") &&
      isObjectLike(value)) ||
    (isObjectLike(value) &&
      (schema.properties !== undefined ||
        schema.required !== undefined ||
        schema.additionalProperties !== undefined))
  );
}

function validateObjectKeywords(schema, value, path, context) {
  if (!shouldValidateObjectKeywords(schema, value)) {
    return;
  }

  const properties = schema.properties ?? {};
  const required = schema.required ?? [];

  for (const key of required) {
    assert.ok(
      Object.prototype.hasOwnProperty.call(value, key),
      `${path}.${key} is required`,
    );
  }

  const additionalProperties = schema.additionalProperties;
  for (const key of Object.keys(value)) {
    if (Object.prototype.hasOwnProperty.call(properties, key)) {
      continue;
    }
    if (additionalProperties === false) {
      assert.fail(`${path}.${key} is not allowed by schema`);
    }
    if (additionalProperties && typeof additionalProperties === "object") {
      validateNode(additionalProperties, value[key], `${path}.${key}`, context);
    }
  }

  for (const [key, childSchema] of Object.entries(properties)) {
    if (Object.prototype.hasOwnProperty.call(value, key)) {
      validateNode(childSchema, value[key], `${path}.${key}`, context);
    }
  }
}

function shouldValidateArrayKeywords(schema, value) {
  return (
    schema.type === "array" ||
    (Array.isArray(schema.type) &&
      schema.type.includes("array") &&
      Array.isArray(value)) ||
    (Array.isArray(value) &&
      (schema.items !== undefined ||
        schema.minItems !== undefined ||
        schema.maxItems !== undefined))
  );
}

function validateArrayKeywords(schema, value, path, context) {
  if (!shouldValidateArrayKeywords(schema, value)) {
    return;
  }

  if (schema.minItems !== undefined) {
    assert.ok(
      value.length >= schema.minItems,
      `${path} must have at least ${schema.minItems} item(s), got ${value.length}`,
    );
  }
  if (schema.maxItems !== undefined) {
    assert.ok(
      value.length <= schema.maxItems,
      `${path} must have at most ${schema.maxItems} item(s), got ${value.length}`,
    );
  }
  const itemSchema = schema.items;
  if (itemSchema) {
    value.forEach((item, index) =>
      validateNode(itemSchema, item, `${path}[${index}]`, context),
    );
  }
}

function hasDateTimeFormat(value) {
  const match =
    /^(\d{4})-(\d{2})-(\d{2})[Tt](\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(?:[Zz]|([+-])(\d{2}):(\d{2}))$/.exec(
      value,
    );
  if (!match) {
    return false;
  }

  const [, year, month, day, hour, minute, second, , offsetHour, offsetMinute] =
    match;
  const parts = {
    year: Number(year),
    month: Number(month),
    day: Number(day),
    hour: Number(hour),
    minute: Number(minute),
    second: Number(second),
    offsetHour: offsetHour === undefined ? 0 : Number(offsetHour),
    offsetMinute: offsetMinute === undefined ? 0 : Number(offsetMinute),
  };

  if (
    parts.hour > 23 ||
    parts.minute > 59 ||
    parts.second > 59 ||
    parts.offsetHour > 23 ||
    parts.offsetMinute > 59
  ) {
    return false;
  }

  const date = new Date(
    Date.UTC(
      parts.year,
      parts.month - 1,
      parts.day,
      parts.hour,
      parts.minute,
      parts.second,
    ),
  );
  return (
    date.getUTCFullYear() === parts.year &&
    date.getUTCMonth() === parts.month - 1 &&
    date.getUTCDate() === parts.day
  );
}

function validateStringFormatKeyword(schema, value, path) {
  if (schema.format !== "date-time") {
    return;
  }

  assert.ok(hasDateTimeFormat(value), `${path} must match date-time format`);
}

function shouldValidateStringKeywords(schema, value) {
  return (
    typeof value === "string" &&
    (schema.type === "string" ||
      schema.minLength !== undefined ||
      schema.maxLength !== undefined ||
      schema.pattern !== undefined ||
      schema.format !== undefined)
  );
}

function validateStringKeywords(schema, value, path) {
  if (!shouldValidateStringKeywords(schema, value)) {
    return;
  }

  if (schema.minLength !== undefined) {
    assert.ok(
      value.length >= schema.minLength,
      `${path} must have length >= ${schema.minLength}, got ${value.length}`,
    );
  }
  if (schema.maxLength !== undefined) {
    assert.ok(
      value.length <= schema.maxLength,
      `${path} must have length <= ${schema.maxLength}, got ${value.length}`,
    );
  }
  if (schema.pattern !== undefined) {
    const expression = new RegExp(schema.pattern);
    assert.match(
      value,
      expression,
      `${path} must match pattern ${schema.pattern}`,
    );
  }
  validateStringFormatKeyword(schema, value, path);
}

function shouldValidateNumberKeywords(schema, value) {
  return (
    typeof value === "number" &&
    (schema.type === "number" ||
      schema.type === "integer" ||
      schema.minimum !== undefined ||
      schema.maximum !== undefined)
  );
}

function validateNumberKeywords(schema, value, path) {
  if (!shouldValidateNumberKeywords(schema, value)) {
    return;
  }

  if (schema.minimum !== undefined) {
    assert.ok(
      value >= schema.minimum,
      `${path} must be >= ${schema.minimum}, got ${value}`,
    );
  }
  if (schema.maximum !== undefined) {
    assert.ok(
      value <= schema.maximum,
      `${path} must be <= ${schema.maximum}, got ${value}`,
    );
  }
}

const keywordValidators = [
  validateCombinerKeywords,
  validateIfThenKeyword,
  validateConstKeyword,
  validateEnumKeyword,
  validateTypeKeyword,
];

const valueKeywordValidators = [
  validateObjectKeywords,
  validateArrayKeywords,
  validateStringKeywords,
  validateNumberKeywords,
];

function validateNode(schema, value, path, context) {
  if (schema.$ref) {
    const resolved = resolveReferencedSchema(schema.$ref, context);
    validateNode(resolved.schema, value, path, resolved.context);
    return;
  }

  for (const validateKeyword of keywordValidators) {
    validateKeyword(schema, value, path, context);
  }

  if (value === null) {
    return;
  }

  for (const validateKeyword of valueKeywordValidators) {
    validateKeyword(schema, value, path, context);
  }
}

export function assertMatchesJsonSchema(
  schema,
  value,
  rootName = "value",
  options = {},
) {
  const registry = normalizeSchemaRegistry(options.schemaRegistry);
  if (schema && typeof schema === "object" && typeof schema.$id === "string") {
    registry.set(schema.$id, schema);
  }
  const context = {
    rootSchema: schema,
    baseId:
      schema && typeof schema === "object" && typeof schema.$id === "string"
        ? schema.$id
        : undefined,
    registry,
  };
  validateNode(schema, value, rootName, context);
}
