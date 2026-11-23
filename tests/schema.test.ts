import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { generateSchema } from "../scripts/generate-schema.ts";
import { DEFAULT_OPTIONS } from "../src/types.ts";

interface SchemaProperty {
  items?: {
    pattern?: string;
    not?: { enum?: string[] };
  };
}

const schema = JSON.parse(
  readFileSync(new URL("../schemas/opencode-sandbox.schema.json", import.meta.url), "utf8")
) as {
  $schema: string;
  additionalProperties: boolean;
  properties: Record<string, SchemaProperty>;
  allOf: unknown[];
};

describe("trusted policy JSON Schema", () => {
  test("is synchronized with generated types, enums and defaults", () => {
    expect(schema).toEqual(generateSchema() as typeof schema);
  });
  test("covers exactly the supported options and rejects unknown keys", () => {
    expect(schema.$schema).toBe("https://json-schema.org/draft/2020-12/schema");
    expect(schema.additionalProperties).toBe(false);
    expect(Object.keys(schema.properties).sort()).toEqual(
      ["$schema", ...Object.keys(DEFAULT_OPTIONS)].sort()
    );
    expect(schema.properties).toHaveProperty("$schema");
    expect(schema.properties.$schema).toMatchObject({ type: "string", minLength: 1 });
  });

  test("limits unsandboxed command patterns to safe exact/prefix forms", () => {
    const pattern = new RegExp(schema.properties.unsandboxedCommands.items?.pattern ?? "");
    for (const value of ["gh auth status", "gh pr *", "git push origin main"]) {
      expect(pattern.test(value)).toBe(true);
    }
    for (const value of ["", " ", "gh *; curl evil.example", "gh *\nwhoami", "gh **"]) {
      expect(pattern.test(value)).toBe(false);
    }
  });

  test("validates webfetch hostname syntax", () => {
    const pattern = new RegExp(schema.properties.webfetchAllowlist.items?.pattern ?? "");
    for (const value of ["github.com", "*.github.com", ".example.com", "localhost"]) {
      expect(pattern.test(value)).toBe(true);
    }
    for (const value of ["https://github.com", "example..com", "*", "github.com:443"]) {
      expect(pattern.test(value)).toBe(false);
    }
  });

  test("documents reserved environment names and toolGuard dependency", () => {
    expect(schema.properties.passEnv.items?.not?.enum).toContain("HOME");
    expect(schema.properties.passEnv.items?.not?.enum).toContain("PATH");
    expect(JSON.stringify(schema.allOf)).toContain('"toolGuard"');
    expect(JSON.stringify(schema.allOf)).toContain('"webfetchAllowlist"');
  });
});
