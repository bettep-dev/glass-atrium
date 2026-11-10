// Tailwind role keys of public/index.html → the utility CSS the CDN would generate for them.
// Pages rendered in tests never load the CDN, so every e2e whose markup carries role keys adds this CSS.
// The config literal is read as a syntax tree and never evaluated.

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const INDEX_HTML = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "public", "index.html");

export type RoleSection = "padding" | "gap" | "margin" | "space";
export type RoleKeys = Record<RoleSection, Record<string, string>>;

const SECTIONS: RoleSection[] = ["padding", "gap", "margin", "space"];

// utility prefix → the properties it sets, per config section
const PREFIXES: Record<RoleSection, Record<string, string[]>> = {
  padding: {
    p: ["padding"],
    px: ["padding-left", "padding-right"],
    py: ["padding-top", "padding-bottom"],
    pt: ["padding-top"],
    pr: ["padding-right"],
    pb: ["padding-bottom"],
    pl: ["padding-left"],
  },
  gap: { gap: ["gap"], "gap-x": ["column-gap"], "gap-y": ["row-gap"] },
  margin: {
    m: ["margin"],
    mx: ["margin-left", "margin-right"],
    my: ["margin-top", "margin-bottom"],
    mt: ["margin-top"],
    mr: ["margin-right"],
    mb: ["margin-bottom"],
    ml: ["margin-left"],
  },
  space: { "space-x": ["margin-left"], "space-y": ["margin-top"] },
};

/** The role keys under `theme.extend.{padding,gap,margin,space}`; throws when a section or a string value is missing. */
export function getRoleKeys(html: string = readFileSync(INDEX_HTML, "utf8")): RoleKeys {
  const extend = getProperty(getProperty(getConfigLiteral(html), "theme"), "extend");
  const entries = SECTIONS.map((section) => [section, getStringEntries(getProperty(extend, section), section)]);
  return Object.fromEntries(entries) as RoleKeys;
}

/** One rule per allowed prefix × key; `space-*` keeps Tailwind's child-sibling form. */
export function getRoleKeyCss(keys: RoleKeys = getRoleKeys()): string {
  return SECTIONS.flatMap((section) =>
    Object.entries(keys[section]).flatMap(([key, value]) =>
      Object.entries(PREFIXES[section]).map(([prefix, props]) => buildRule(section, `${prefix}-${key}`, props, value)),
    ),
  ).join("\n");
}

function buildRule(section: RoleSection, className: string, props: string[], value: string): string {
  const selector = section === "space" ? `.${className} > :not([hidden]) ~ :not([hidden])` : `.${className}`;
  return `${selector} { ${props.map((prop) => `${prop}: ${value};`).join(" ")} }`;
}

function getConfigLiteral(html: string): ts.ObjectLiteralExpression {
  // the config holds `<alpha-value>` placeholders → split on tags, never a `[^<]*` body match
  const script = html.split("<script>").map((chunk) => chunk.split("</script>")[0]).find((body) => /tailwind\.config\s*=/.test(body));
  if (!script) throw new Error("index.html holds no inline <script> assigning tailwind.config");
  const source = ts.createSourceFile("tailwind-config.js", script, ts.ScriptTarget.Latest, true);
  let literal: ts.ObjectLiteralExpression | undefined;
  const visit = (node: ts.Node): void => {
    if (ts.isBinaryExpression(node) && node.left.getText(source) === "tailwind.config" && ts.isObjectLiteralExpression(node.right)) {
      literal = node.right;
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  if (!literal) throw new Error("tailwind.config is not assigned an object literal");
  return literal;
}

function getProperty(literal: ts.ObjectLiteralExpression, name: string): ts.ObjectLiteralExpression {
  const found = literal.properties.find(
    (prop): prop is ts.PropertyAssignment => ts.isPropertyAssignment(prop) && getKeyText(prop.name) === name,
  );
  const value = found && getObjectLiteral(found.initializer);
  if (!value) throw new Error(`tailwind.config holds no object at "${name}"`);
  return value;
}

// an object literal, or an identifier naming a same-script `const` bound to one
function getObjectLiteral(node: ts.Expression): ts.ObjectLiteralExpression | undefined {
  if (ts.isObjectLiteralExpression(node)) return node;
  if (!ts.isIdentifier(node)) return undefined;
  const declaration = node
    .getSourceFile()
    .statements.filter(ts.isVariableStatement)
    .flatMap((statement) => [...statement.declarationList.declarations])
    .find((decl) => ts.isIdentifier(decl.name) && decl.name.text === node.text);
  return declaration?.initializer && ts.isObjectLiteralExpression(declaration.initializer) ? declaration.initializer : undefined;
}

function getStringEntries(literal: ts.ObjectLiteralExpression, section: RoleSection): Record<string, string> {
  return Object.fromEntries(
    literal.properties.map((prop) => {
      if (!ts.isPropertyAssignment(prop) || !ts.isStringLiteral(prop.initializer)) {
        throw new Error(`theme.extend.${section} holds an entry that is not "key": "string"`);
      }
      return [getKeyText(prop.name), prop.initializer.text];
    }),
  );
}

function getKeyText(name: ts.PropertyName): string {
  return ts.isIdentifier(name) || ts.isStringLiteral(name) ? name.text : name.getText();
}
