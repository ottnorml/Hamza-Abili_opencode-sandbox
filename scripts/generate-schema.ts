/**
 * Generate the trusted-policy JSON Schema from the SandboxOptions TypeScript
 * interface, its string-literal union aliases and DEFAULT_OPTIONS. The small
 * constraints map documents extra runtime checks that cannot be inferred from
 * TypeScript alone.
 *
 * bun run schema:generate
 * bun run schema:check
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { DEFAULT_OPTIONS, RESERVED_ENV, type SandboxOptions } from "../src/types.ts";

const root = fileURLToPath(new URL("../", import.meta.url));
const typesPath = path.join(root, "src/types.ts");
const schemaPath = path.join(root, "schemas/opencode-sandbox.schema.json");
const source = ts.createSourceFile(
  typesPath,
  fs.readFileSync(typesPath, "utf8"),
  ts.ScriptTarget.Latest,
  true,
  ts.ScriptKind.TS
);

const aliases = new Map(
  source.statements
    .filter(ts.isTypeAliasDeclaration)
    .map((node) => [node.name.text, node.type])
);
const optionsType = source.statements.find(
  (node): node is ts.InterfaceDeclaration =>
    ts.isInterfaceDeclaration(node) && node.name.text === "SandboxOptions"
);
if (optionsType === undefined) throw new Error("SandboxOptions interface not found");

type Schema = Record<string, unknown>;

function toSchema(node: ts.TypeNode): Schema {
  if (node.kind === ts.SyntaxKind.StringKeyword) return { type: "string" };
  if (ts.isArrayTypeNode(node)) {
    return { type: "array", items: toSchema(node.elementType), uniqueItems: true };
  }
  if (ts.isTypeReferenceNode(node)) {
    const alias = aliases.get(node.typeName.getText(source));
    if (alias !== undefined) return toSchema(alias);
  }
  if (ts.isUnionTypeNode(node)) {
    const values = node.types.map((type) =>
      ts.isLiteralTypeNode(type) && ts.isStringLiteral(type.literal)
        ? type.literal.text
        : undefined
    );
    if (values.every((value): value is string => value !== undefined)) {
      return { type: "string", enum: values };
    }
  }
  throw new Error(`Unsupported SandboxOptions type: ${node.getText(source)}`);
}

function description(member: ts.PropertySignature): string {
  return (
    member.jsDoc
      ?.map((doc) => (typeof doc.comment === "string" ? doc.comment : ""))
      .join(" ")
      .replace(/\s+/g, " ")
      .trim() ?? ""
  );
}

const extra: Partial<Record<keyof SandboxOptions, Schema>> = {
  network: {
    description: "Controls sandboxed shell network access; allow enables unrestricted egress, not only GitHub."
  },
  writablePaths: {
    items: { type: "string", minLength: 1 }
  },
  readablePaths: {
    items: { type: "string", minLength: 1 }
  },
  passEnv: {
    items: {
      type: "string",
      pattern: "^[A-Za-z_][A-Za-z0-9_]*$",
      not: { enum: [...RESERVED_ENV] }
    }
  },
  shell: { pattern: "^/" },
  webfetchAllowlist: {
    items: {
      type: "string",
      pattern:
        "^(?:\\*\\.|\\.)?[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?(?:\\.[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?)*\\.?$"
    },
    description: "Plain hostnames for the OpenCode webfetch tool. Empty allows all hosts. Not a shell-network filter."
  },
  deniedPaths: {
    items: { type: "string", pattern: "\\S" }
  },
  unsandboxedCommands: {
    items: {
      type: "string",
      pattern: "^(?!\\s*$)(?![\\s\\S]*[;&|`$()<>\\r\\n])(?:[^*\\r\\n]*|[^*\\r\\n]+ \\*)$"
    },
    description: "Exact commands or a 'prefix *' bypass. Commands run with host environment and permissions; prefer narrow allowlists."
  }
};

export function generateSchema(): Schema {
  const properties: Record<string, Schema> = {
    $schema: {
      type: "string",
      minLength: 1,
      description:
        "Optional schema URI for editor tooling only; the plugin does not load this URL or use it for runtime security decisions."
    }
  };

  for (const member of optionsType.members) {
    if (!ts.isPropertySignature(member) || member.type === undefined) {
      throw new Error("Unexpected member of SandboxOptions");
    }
    const key = member.name.getText(source) as keyof SandboxOptions;
    if (!(key in DEFAULT_OPTIONS)) throw new Error(`Option ${key} has no default`);
    const desc = description(member);
    properties[key] = {
      ...toSchema(member.type),
      default: DEFAULT_OPTIONS[key],
      ...(desc === "" ? {} : { description: desc }),
      ...extra[key]
    };
  }

  const keys = Object.keys(properties).filter((key) => key !== "$schema").sort();
  if (JSON.stringify(keys) !== JSON.stringify(Object.keys(DEFAULT_OPTIONS).sort())) {
    throw new Error("SandboxOptions and DEFAULT_OPTIONS are out of sync");
  }

  return {
    $schema: "https://json-schema.org/draft/2020-12/schema",
    title: "OpenCode Sandbox trusted policy",
    description:
      "Editor schema for opencode-sandbox.json; the runtime parser retains authority for policy security.",
    type: "object",
    additionalProperties: false,
    properties,
    allOf: [
      {
        if: { properties: { toolGuard: { const: "off" } }, required: ["toolGuard"] },
        then: {
          properties: {
            webfetch: { const: "allow" },
            webfetchAllowlist: { maxItems: 0 }
          }
        }
      }
    ],
    examples: [
      {
        $schema: "./schemas/opencode-sandbox.schema.json",
        network: "deny",
        mode: "enforce",
        unsandboxedCommands: ["gh auth status", "gh pr *", "gh issue *"]
      }
    ]
  };
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
