// Parse + duplicate-decl smoke for every .ts under tests_gold/playwright/.
//
// Motivation (iter 252): iter 247 introduced a duplicate `const`
// declaration in tests_gold/playwright/fixtures/liveProjectBootstrap.ts
// (two consecutive blocks each declaring `const token` / `const
// appName` in the same scope). Babel/SWC rejects the file at
// Playwright transform time, propagates through globalSetup.ts, and
// kills the entire gold run before any spec executes. Nothing in
// tests_normal/ imports the file and `pnpm -r typecheck` only walks
// apps/* and packages/*, so the syntax error shipped and wedged
// iters 247–250 of live gold.
//
// Two checks per file:
//
//  1. **Syntactic parse** via `ts.createSourceFile`. Catches
//     unterminated strings, unbalanced braces, malformed
//     declarations — the parser-level defect class.
//
//  2. **Duplicate block-scoped identifier** via a hand-rolled AST
//     walker over `const`/`let`/`function`/`class` declarations
//     inside the same lexical block. TypeScript's binder *can*
//     report this (TS2451) but only when the program's lib + module
//     resolution succeed, which they don't for these files in
//     isolation (Playwright/Node typings live in workspace
//     `node_modules` not currently on the program's path). The
//     walker doesn't depend on type resolution, so it stays robust
//     as fixtures evolve.

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const HERE = fileURLToPath(new URL(".", import.meta.url));
const ROOT = join(HERE, "..", "..");
const PW_DIR = join(ROOT, "tests_gold", "playwright");

function walk(dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) {
      if (name === "node_modules") continue;
      out.push(...walk(p));
    } else if (name.endsWith(".ts")) {
      out.push(p);
    }
  }
  return out;
}

/**
 * Walk `node`'s children, tracking which AST nodes introduce a new
 * lexical scope. For each scope, collect block-scoped names
 * (const/let/function/class) and report any duplicates.
 *
 * Scope-introducing nodes per ES/TS semantics: SourceFile, Block,
 * ForStatement, ForInStatement, ForOfStatement, CaseBlock,
 * ModuleBlock, plus any function-like node (their parameter scope
 * encloses the body block). For function-likes we descend into the
 * body block; the body block creates its own scope.
 */
function checkDuplicates(sf, reporter) {
  function isScope(n) {
    switch (n.kind) {
      case ts.SyntaxKind.SourceFile:
      case ts.SyntaxKind.Block:
      case ts.SyntaxKind.ModuleBlock:
      case ts.SyntaxKind.CaseBlock:
      case ts.SyntaxKind.ForStatement:
      case ts.SyntaxKind.ForInStatement:
      case ts.SyntaxKind.ForOfStatement:
        return true;
      default:
        return false;
    }
  }

  function collectBindingNames(name, out) {
    if (ts.isIdentifier(name)) {
      out.push({ name: name.text, pos: name.pos });
    } else if (ts.isObjectBindingPattern(name) || ts.isArrayBindingPattern(name)) {
      for (const el of name.elements) {
        if (ts.isOmittedExpression(el)) continue;
        if (el.name) collectBindingNames(el.name, out);
      }
    }
  }

  function visitScope(scope) {
    const seen = new Map(); // name → first pos
    function visit(node) {
      // Skip nested scopes: they manage their own bindings.
      if (node !== scope && isScope(node)) {
        visitScope(node);
        return;
      }
      // VariableStatement → VariableDeclarationList → VariableDeclaration[]
      if (ts.isVariableStatement(node)) {
        const flags = node.declarationList.flags;
        if (flags & (ts.NodeFlags.Const | ts.NodeFlags.Let)) {
          for (const decl of node.declarationList.declarations) {
            const names = [];
            collectBindingNames(decl.name, names);
            for (const { name, pos } of names) {
              if (seen.has(name)) {
                reporter(sf, pos, name, seen.get(name));
              } else {
                seen.set(name, pos);
              }
            }
          }
        }
      } else if (
        ts.isFunctionDeclaration(node) ||
        ts.isClassDeclaration(node)
      ) {
        // Function/class declarations bind their name in the
        // enclosing scope.
        if (node.name && ts.isIdentifier(node.name)) {
          const name = node.name.text;
          if (seen.has(name)) {
            reporter(sf, node.name.pos, name, seen.get(name));
          } else {
            seen.set(name, node.name.pos);
          }
        }
        // Then recurse into the body as a fresh scope. Body of a
        // FunctionDeclaration is a Block (a scope); for a class,
        // each method body is its own scope (handled below).
        if (ts.isFunctionDeclaration(node) && node.body) visitScope(node.body);
        else if (ts.isClassDeclaration(node)) node.forEachChild(visit);
        return;
      } else if (
        ts.isArrowFunction(node) ||
        ts.isFunctionExpression(node) ||
        ts.isMethodDeclaration(node) ||
        ts.isConstructorDeclaration(node) ||
        ts.isGetAccessorDeclaration(node) ||
        ts.isSetAccessorDeclaration(node)
      ) {
        // These don't bind anything in the enclosing scope. Descend
        // into the body (which is itself a Block scope, or for
        // arrow-functions with expression bodies, a non-scope
        // expression — recurse plain).
        if (node.body) {
          if (isScope(node.body)) visitScope(node.body);
          else visit(node.body);
        }
        return;
      }
      node.forEachChild(visit);
    }
    scope.forEachChild(visit);
  }

  visitScope(sf);
}

const files = walk(PW_DIR);
let failed = 0;

function report(sf, pos, name, firstPos) {
  failed++;
  const { line, character } = sf.getLineAndCharacterOfPosition(pos);
  const { line: firstLine } = sf.getLineAndCharacterOfPosition(firstPos);
  console.error(
    `${relative(ROOT, sf.fileName)}:${line + 1}:${character + 1}: ` +
      `duplicate block-scoped identifier '${name}' ` +
      `(first declared at line ${firstLine + 1})`,
  );
}

for (const file of files) {
  const text = readFileSync(file, "utf8");
  const sf = ts.createSourceFile(
    file,
    text,
    ts.ScriptTarget.Latest,
    /*setParentNodes*/ true,
    ts.ScriptKind.TS,
  );
  // Syntactic parse diagnostics first.
  const parseDiags = sf.parseDiagnostics ?? [];
  for (const d of parseDiags) {
    failed++;
    const msg = ts.flattenDiagnosticMessageText(d.messageText, "\n");
    let where = "";
    if (d.start !== undefined) {
      const { line, character } = sf.getLineAndCharacterOfPosition(d.start);
      where = `:${line + 1}:${character + 1}`;
    }
    console.error(`${relative(ROOT, file)}${where}: TS${d.code}: ${msg}`);
  }
  // Duplicate-decl walk (only if parse was clean enough to walk).
  if (parseDiags.length === 0) {
    checkDuplicates(sf, report);
  }
}

if (failed > 0) {
  console.error(`\n${failed} defect(s) across tests_gold/playwright/`);
  process.exit(1);
}
console.log(
  `tests_gold/playwright/: clean across ${files.length} file(s) ` +
    `(parse + duplicate-decl)`,
);
