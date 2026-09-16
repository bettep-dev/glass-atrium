// Parity pin for the monitor.DocStatus stage vocabulary across the three artifacts that together
// decide what a database can hold: the Prisma schema, the migration chain and the shared response
// types. A token declared on one surface only never reaches both the column and the client.
// Runner: npx tsx --import ./test/lib/select-test-db.ts --test test/clauded-docs.doc-status-vocabulary.test.ts

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";

// The retired in-flight token. It stays IN the enum — a stored one is read as the first
// stage rather than dropped — but it is no longer the default and no longer a stage.
const RETIRED_ALIAS = "progress";

function getRepoSource(relative: string): string {
  return readFileSync(fileURLToPath(new URL(`../${relative}`, import.meta.url)), "utf8");
}

// Prose in a line comment must never be mistaken for a member of the set.
function getUncommented(src: string): string {
  return src.replace(/^\s*(\/\/|\/{3}).*$/gm, "");
}

function getSchemaSource(): string {
  return getRepoSource("prisma/schema.prisma");
}

function getSchemaEnumValues(): string[] {
  const block = getSchemaSource().match(/enum DocStatus\s*\{([\s\S]*?)\n\}/);
  assert.ok(block, "schema.prisma must declare enum DocStatus");
  return getUncommented(block[1])
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => /^[a-z_]+$/.test(line));
}

function getSchemaDefaultStage(): string {
  const declaration = getSchemaSource().match(/docStatus\s+DocStatus\s+@default\(([a-z_]+)\)/);
  assert.ok(declaration, "ClaudedDoc.docStatus must declare a DocStatus default");
  return declaration[1];
}

function getTypeDeclaration(alias: string): string {
  const src = getRepoSource("src/server/types/clauded-docs.ts");
  const declaration = src.match(new RegExp(`export type ${alias}\\s*=([\\s\\S]*?);`));
  assert.ok(declaration, `types/clauded-docs.ts must declare ${alias}`);
  return getUncommented(declaration[1]);
}

function getUnionMembers(alias: string): string[] {
  return [...getTypeDeclaration(alias).matchAll(/"([a-z_]+)"/g)].map((m) => m[1]);
}

// `sql` keeps the file verbatim; `body` drops the SQL comments. Every assertion below reads
// `body`: reversal prose routinely names a token or restates a statement, and matching it would
// credit a comment with a change no database ever sees.
function getMigrationSqls(): { name: string; sql: string; body: string }[] {
  const dir = fileURLToPath(new URL("../prisma/migrations", import.meta.url));
  return readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((entry) => {
      const sql = readFileSync(`${dir}/${entry.name}/migration.sql`, "utf8");
      return { name: entry.name, sql, body: sql.replace(/^\s*--.*$/gm, "") };
    });
}

// A value reaches a database either through the init CREATE TYPE list or through a later
// ADD VALUE — anchored on the statements themselves, so reversal prose naming a token in a
// sibling migration never counts as introducing it.
function getIntroducingMigrations(value: string): string[] {
  const created = new RegExp(`CREATE TYPE\\s+"monitor"\\."DocStatus"\\s+AS ENUM\\s*\\([^)]*'${value}'`, "i");
  const added = new RegExp(`ALTER TYPE\\s+"monitor"\\."DocStatus"\\s+ADD VALUE[^;]*'${value}'`, "i");
  return getMigrationSqls()
    .filter(({ body }) => created.test(body) || added.test(body))
    .map(({ name }) => name);
}

const SCHEMA_VALUES = getSchemaEnumValues();

test("every schema enum value is introduced by exactly one migration", () => {
  for (const value of SCHEMA_VALUES) {
    assert.deepStrictEqual(
      getIntroducingMigrations(value).length,
      1,
      `exactly one migration must introduce '${value}' (schema-only addition never reaches a database)`,
    );
  }
});

test("no migration consumes a DocStatus value it added in the same file", () => {
  for (const { name, body } of getMigrationSqls()) {
    const added = [...body.matchAll(/ALTER TYPE\s+"monitor"\."DocStatus"\s+ADD VALUE[^;]*'([a-z_]+)'/gi)].map(
      (m) => m[1],
    );
    if (added.length === 0) continue;
    const consuming = body.replace(/ALTER TYPE\s+"monitor"\."DocStatus"\s+ADD VALUE[^;]*;/gi, "");
    for (const value of added) {
      assert.ok(
        !new RegExp(`'${value}'`).test(consuming),
        // Prisma wraps a migration file in one transaction, and PostgreSQL refuses a value
        // added in the transaction that consumes it — the apply fails on a real database.
        `${name} adds '${value}' and consumes it in the same transaction`,
      );
    }
  }
});

test("the stage vocabulary, its retired alias and the enum are the same set", () => {
  const stages = getUnionMembers("DocStageLiteral");
  assert.ok(!stages.includes(RETIRED_ALIAS), `'${RETIRED_ALIAS}' is an alias, never a stage`);
  const stored = getTypeDeclaration("DocStatusLiteral");
  assert.match(stored, /DocStageLiteral/, "the stored vocabulary must derive from the stages, never restate them");
  assert.deepStrictEqual(
    [...stored.matchAll(/"([a-z_]+)"/g)].map((m) => m[1]),
    [RETIRED_ALIAS],
    "the stored vocabulary adds exactly the retired alias to the stages",
  );
  assert.deepStrictEqual(
    SCHEMA_VALUES.slice().sort(),
    [...stages, RETIRED_ALIAS].sort(),
    "a token the enum cannot hold, or one the types cannot name, is a read that drops rows",
  );
});

test("the default stage agrees across schema and migration, and is never the retired alias", () => {
  const fallback = getSchemaDefaultStage();
  assert.ok(getUnionMembers("DocStageLiteral").includes(fallback), `default '${fallback}' must be a stage`);
  const setting = getMigrationSqls().filter(({ body }) =>
    new RegExp(`ALTER COLUMN\\s+"doc_status"\\s+SET DEFAULT\\s+'${fallback}'`, "i").test(body),
  );
  assert.strictEqual(setting.length, 1, `exactly one migration must move the column default to '${fallback}'`);
  // Same file, same token: a default moved without its backfill strands every existing row
  // on the retired alias, and a backfill without the default strands every new one.
  assert.match(
    setting[0].body,
    new RegExp(`UPDATE[\\s\\S]*"documents"[\\s\\S]*SET\\s+"doc_status"\\s*=\\s*'${fallback}'[\\s\\S]*'${RETIRED_ALIAS}'`, "i"),
    `the default move must carry the '${RETIRED_ALIAS}' backfill to the same token`,
  );
});

test("the last-status-model column is nullable in both schema and migration", () => {
  assert.match(
    getUncommented(getSchemaSource()),
    /lastStatusModel\s+String\?\s+@map\("last_status_model"\)/,
    // Unknown is a real state the screen renders; NOT NULL would force a lying placeholder.
    "ClaudedDoc must declare lastStatusModel as a nullable mapped column",
  );
  const adding = getMigrationSqls().filter(({ body }) =>
    /ALTER TABLE\s+"monitor"\."documents"\s+ADD COLUMN[^;]*"last_status_model"/i.test(body),
  );
  assert.strictEqual(adding.length, 1, "exactly one migration must add last_status_model");
  const statement = adding[0].body.match(/ALTER TABLE\s+"monitor"\."documents"\s+ADD COLUMN[^;]*"last_status_model"[^;]*;/i);
  assert.ok(statement, "the add must be a single ALTER TABLE statement");
  assert.ok(!/NOT\s+NULL/i.test(statement[0]), "last_status_model must stay nullable");
});
