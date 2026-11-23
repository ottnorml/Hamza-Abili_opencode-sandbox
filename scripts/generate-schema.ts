/**
 * Generate and check the trusted-policy schema using SandboxOptions and
 * DEFAULT_OPTIONS as the source of truth for names, types, enums and defaults.
 * Descriptions and security-specific editor constraints remain reviewed in
 * the checked-in JSON Schema.
 *
 * bun run schema:generate
 * bun run schema:check
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DEFAULT_OPTIONS, type SandboxOptions } from "../src/types.ts";

type Schema = Record<string, unknown>;
const root = fileURLToPath(new URL("../", import.meta.url));
const sourcePath = path.join(root, "src/types.ts");
const schemaPath = path.join(root, "schemas/opencode-sandbox.schema.json");
const source = fs.readFileSync(sourcePath, "utf8");

const aliases = new Map(
  [...source.matchAll(/^export type (\w+) = ([^;]+);$/gm)].map((match) => [match[1], match[2]])
);
const declaration = source.match(/export interface SandboxOptions \{([\s\S]*?)^\}/m)?.[1];
if (declaration === undefined) throw new Error("SandboxOptions interface not found");

const members = [...declaration.matchAll(/^  (\w+): (\w+(?:\[\])?);$/gm)];
if (members.length === 0) throw new Error("No SandboxOptions members found");

function toSchema(type: string): Schema {
  if (type === "string") return { type: "string" };
  if (type.endsWith("[]")) {
    return { type: "array", items: toSchema(type.slice(0, -2)), uniqueItems: true };
  }
  const alias = aliases.get(type);
  if (alias !== undefined) {
    const enumValues = alias.split("|").map((part) => {
      const match = /^"([^"]+)"$/.exec(part.trim());
      if (match === null) throw new Error(`Unsupported type alias: ${type}`);
      return match[1];
    });
    return { type: "string", enum: enumValues };
  }
  throw new Error(`Unsupported SandboxOptions type: ${type}`);
}

export function generateSchema(): Schema {
  const existing = JSON.parse(fs.readFileSync(schemaPath, "utf8")) as {
    properties: Record<string, Schema>;
    [key: string]: unknown;
  };
  const properties: Record<string, Schema> = {
    $schema: {
      type: "string",
      minLength: 1,
      description:
        "Optional schema URI for editor tooling only; the plugin never fetches it or uses it for runtime security decisions."
    }
  };

  for (const [, name, type] of members) {
    const key = name as keyof SandboxOptions;
    if (!(key in DEFAULT_OPTIONS)) throw new Error(`Option ${key} has no default`);
    const previous = existing.properties[key] ?? {};
    const inferred = toSchema(type);
    if (inferred.items !== undefined) {
      inferred.items = {
        ...((previous.items as Schema | undefined) ?? {}),
        ...(inferred.items as Schema)
      };
    }
    properties[key] = { ...previous, ...inferred, default: DEFAULT_OPTIONS[key] };
  }

  const keys = Object.keys(properties)
    .filter((key) => key !== "$schema")
    .sort();
  if (JSON.stringify(keys) !== JSON.stringify(Object.keys(DEFAULT_OPTIONS).sort())) {
    throw new Error("SandboxOptions and DEFAULT_OPTIONS are out of sync");
  }

  return { ...existing, additionalProperties: false, properties };
}

if (import.meta.main) {
  const generated = generateSchema();
  if (process.argv.includes("--check")) {
    const actual = JSON.parse(fs.readFileSync(schemaPath, "utf8")) as Schema;
    if (JSON.stringify(actual) !== JSON.stringify(generated)) {
      console.error("The trusted policy schema is out of date. Run bun run schema:generate.");
      process.exit(1);
    }
    console.log("Trusted policy schema is up to date.");
  } else {
    fs.writeFileSync(schemaPath, `${JSON.stringify(generated, null, 2)}\n`);
    console.log("Generated schemas/opencode-sandbox.schema.json");
  }
}
