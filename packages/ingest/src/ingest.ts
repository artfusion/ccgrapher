// SPDX-License-Identifier: Apache-2.0
import type { EdgeSpec, NodeSpec, WorkflowSpec } from "@ccgrapher/core";
import { Node, Project, SyntaxKind, type FunctionDeclaration, type SourceFile } from "ts-morph";
import { descriptorFor } from "./descriptors.js";
import { parseTraits } from "./traits.js";

export interface IngestResult {
  readonly spec: WorkflowSpec;
  readonly warnings: readonly string[];
}

const RESULT_SUFFIX = "Result";
const ITEMS_SUFFIX = "Items";

/**
 * Reconstructs a spec from TypeScript orchestration code — the other direction.
 * Answers "what does my workflow actually do" rather than "what did I intend",
 * which is where the fake-edge audit finds waste that was never in a diagram.
 *
 * Targets the shape `codegen --target plain-ts` emits: a typed function per
 * node and a runner whose awaits describe the dependencies.
 */
export function ingest(source: string, options: { name?: string } = {}): IngestResult {
  const project = new Project({ useInMemoryFileSystem: true, skipAddingFilesFromTsConfig: true });
  const file = project.createSourceFile("orchestration.ts", source);
  const warnings: string[] = [];

  const fields = collectInterfaces(file);
  const nodes = collectNodes(file, fields, warnings);
  if (nodes.length === 0) {
    warnings.push("no exported node functions found — is this a plain-ts orchestration file?");
  }

  const known = new Set(nodes.map((n) => n.id));
  const edges = collectEdges(file, known, warnings);

  const banner = readBanner(source);
  const name = options.name ?? banner.name ?? runnerName(file) ?? "ingested";
  if (!options.name && !banner.name) {
    warnings.push(`spec name not recorded in the source; inferred '${name}'`);
  }

  const spec: WorkflowSpec = {
    version: 1,
    name,
    ...(banner.goal ? { goal: banner.goal } : {}),
    nodes,
    edges: withCarries(edges, nodes),
  };

  return { spec, warnings };
}

/** `interface FooIn { a: string; b: string; // url }` -> { a: "string", b: "url" } */
function collectInterfaces(file: SourceFile): Map<string, Record<string, string>> {
  const out = new Map<string, Record<string, string>>();

  for (const declaration of file.getInterfaces()) {
    const fields: Record<string, string> = {};

    for (const property of declaration.getProperties()) {
      const comment = property
        .getTrailingCommentRanges()
        .map((range) => range.getText())
        .join(" ");
      fields[property.getName()] = descriptorFor(
        property.getTypeNode()?.getText() ?? "string",
        comment,
      );
    }
    // An empty shape is written as an index signature; treat it as no fields.
    out.set(declaration.getName(), fields);
  }
  return out;
}

function collectNodes(
  file: SourceFile,
  interfaces: Map<string, Record<string, string>>,
  warnings: string[],
): NodeSpec[] {
  const nodes: NodeSpec[] = [];

  for (const fn of file.getFunctions()) {
    if (!fn.isExported() || !fn.isAsync()) continue;
    if (fn.getName()?.startsWith("run")) continue;

    const id = fn.getName();
    if (!id) continue;

    const inName = fn.getParameters()[0]?.getTypeNode()?.getText();
    const outName = returnTypeName(fn);
    if (!inName || !outName) {
      warnings.push(`${id}: could not read its input/output types; skipped`);
      continue;
    }

    const traits = parseTraits(docOf(fn), id);
    nodes.push({
      id,
      label: traits.label,
      kind: traits.kind,
      ...(traits.model !== undefined ? { model: traits.model } : {}),
      in: interfaces.get(inName) ?? {},
      out: interfaces.get(outName) ?? {},
      ...(traits.writes ? { writes: traits.writes } : {}),
      ...(traits.freshContext ? { freshContext: traits.freshContext } : {}),
      ...(traits.expects !== undefined ? { expects: traits.expects } : {}),
      ...(traits.fanOut ? { fanOut: traits.fanOut } : {}),
      ...(traits.worktree ? { worktree: traits.worktree } : {}),
    } as NodeSpec);
  }

  return nodes;
}

/** `Promise<FooOut>` -> `FooOut` */
function returnTypeName(fn: FunctionDeclaration): string | undefined {
  const node = fn.getReturnTypeNode();
  if (!node) return undefined;
  const match = /^Promise<(.+)>$/.exec(node.getText().trim());
  return match?.[1]?.trim();
}

function docOf(fn: FunctionDeclaration): string {
  return fn
    .getJsDocs()
    .map((doc) => doc.getInnerText())
    .join(" ");
}

/**
 * Walks the runner. Every await names the node it calls, and the result
 * variables inside its arguments name that node's dependencies — which is the
 * edge set, recovered from what the code does rather than what a diagram claims.
 */
function collectEdges(
  file: SourceFile,
  known: Set<string>,
  warnings: string[],
): Array<{ from: string; to: string }> {
  const runner = file.getFunctions().find((fn) => fn.getName()?.startsWith("run"));
  if (!runner) {
    warnings.push("no run* function found — edges could not be recovered");
    return [];
  }

  const edges: Array<{ from: string; to: string }> = [];
  const seen = new Set<string>();
  const add = (from: string, to: string) => {
    const key = `${from}->${to}`;
    if (from === to || seen.has(key) || !known.has(from) || !known.has(to)) return;
    seen.add(key);
    edges.push({ from, to });
  };

  for (const statement of runner.getStatements()) {
    if (!Node.isVariableStatement(statement)) continue;

    for (const declaration of statement.getDeclarations()) {
      const initialiser = declaration.getInitializer();
      if (!initialiser) continue;

      const nameNode = declaration.getNameNode();

      // const fooItems = toList(barResult).slice(0, 20)
      if (Node.isIdentifier(nameNode) && nameNode.getText().endsWith(ITEMS_SUFFIX)) {
        const target = trimSuffix(nameNode.getText(), ITEMS_SUFFIX);
        for (const source of resultsIn(initialiser)) add(source, target);
        continue;
      }

      // const [aResult, bResult] = await Promise.all([a(x), b(x)])
      if (Node.isArrayBindingPattern(nameNode)) {
        for (const call of callsIn(initialiser, known)) {
          for (const source of resultsIn(call)) add(source, call.getExpression().getText());
        }
        continue;
      }

      // const fooResult = await foo(barResult)
      if (Node.isIdentifier(nameNode) && nameNode.getText().endsWith(RESULT_SUFFIX)) {
        const target = trimSuffix(nameNode.getText(), RESULT_SUFFIX);
        for (const source of resultsIn(initialiser)) add(source, target);
      }
    }
  }

  // An edgeless graph is legal, so nothing downstream objects to one: it lints
  // clean and plans as a single wave. That is also what a runner written
  // without the `Result` convention produces — so silence here would report
  // "everything is independent" with the same confidence as a real answer.
  if (edges.length === 0 && known.size > 0) {
    warnings.push(
      `found ${known.size} nodes but no dependencies — every step will look independent and the ` +
        "graph will lint clean; a result variable must be named `<nodeId>Result` for an await to " +
        "count as an edge",
    );
  }

  return edges;
}

/** Identifiers like `splitResult` inside an expression, as node ids. */
function resultsIn(node: Node): string[] {
  return node
    .getDescendantsOfKind(SyntaxKind.Identifier)
    .map((identifier) => identifier.getText())
    .filter((text) => text.endsWith(RESULT_SUFFIX))
    .map((text) => trimSuffix(text, RESULT_SUFFIX));
}

/** Direct calls to known node functions inside an expression. */
function callsIn(node: Node, known: Set<string>) {
  return node
    .getDescendantsOfKind(SyntaxKind.CallExpression)
    .filter((call) => known.has(call.getExpression().getText()));
}

/**
 * An edge carries whatever the source declares and the target consumes — which
 * is the definition the linter uses, so recovering it this way reproduces the
 * original `carries` exactly, including the empty list on a fake edge.
 */
function withCarries(
  edges: Array<{ from: string; to: string }>,
  nodes: NodeSpec[],
): EdgeSpec[] {
  const byId = new Map(nodes.map((n) => [n.id, n]));
  return edges.map(({ from, to }) => {
    const source = byId.get(from);
    const target = byId.get(to);
    const carries =
      source && target
        ? Object.keys(source.out).filter((field) => Object.hasOwn(target.in, field))
        : [];
    return { from, to, carries };
  });
}

function readBanner(source: string): { name?: string; goal?: string } {
  const name = /^\/\/ Spec: (.+)$/m.exec(source)?.[1]?.trim();
  const goal = /^\/\/ Goal: (.+)$/m.exec(source)?.[1]?.trim();
  return { ...(name && { name }), ...(goal && { goal }) };
}

function runnerName(file: SourceFile): string | undefined {
  const runner = file.getFunctions().find((fn) => fn.getName()?.startsWith("run"));
  const name = runner?.getName()?.slice(3);
  return name ? name.replace(/([a-z0-9])([A-Z])/g, "$1-$2").toLowerCase() : undefined;
}

const trimSuffix = (text: string, suffix: string) => text.slice(0, -suffix.length);
