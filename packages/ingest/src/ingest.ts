// SPDX-License-Identifier: Apache-2.0
import type { EdgeSpec, NodeSpec, WorkflowSpec } from "@ccgrapher/core";
import {
  Node,
  Project,
  SyntaxKind,
  type ArrowFunction,
  type BindingElement,
  type CallExpression,
  type FunctionDeclaration,
  type Identifier,
  type JSDocableNode,
  type ParameterDeclaration,
  type SourceFile,
} from "ts-morph";
import { descriptorFor } from "./descriptors.js";
import { parseTraits } from "./traits.js";

export interface IngestResult {
  readonly spec: WorkflowSpec;
  readonly warnings: readonly string[];
}

const RESULT_SUFFIX = "Result";

/** Callbacks whose parameter is one element of the receiver. */
const PER_ITEM = new Set(["map", "flatMap", "forEach", "filter"]);

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

/** An async function that could be a node or the runner, however it is written. */
interface Declared {
  readonly id: string;
  readonly fn: FunctionDeclaration | ArrowFunction;
  readonly doc: string;
  readonly exported: boolean;
}

/**
 * Every declared function in source order. Codegen emits `function` declarations,
 * but `export const step = async (input) => {}` is just as common in code someone
 * wrote by hand, and a node is a node either way.
 */
function declaredFunctions(file: SourceFile): Declared[] {
  const out: Declared[] = [];

  for (const statement of file.getStatements()) {
    if (Node.isFunctionDeclaration(statement)) {
      const id = statement.getName();
      if (id) {
        out.push({ id, fn: statement, doc: jsDoc(statement), exported: statement.isExported() });
      }
      continue;
    }
    if (!Node.isVariableStatement(statement)) continue;

    for (const declaration of statement.getDeclarations()) {
      const initialiser = declaration.getInitializer();
      if (!initialiser || !Node.isArrowFunction(initialiser)) continue;
      // The doc comment sits on the statement, not on the arrow itself.
      out.push({
        id: declaration.getName(),
        fn: initialiser,
        doc: jsDoc(statement),
        exported: statement.isExported(),
      });
    }
  }
  return out;
}

function collectNodes(
  file: SourceFile,
  interfaces: Map<string, Record<string, string>>,
  warnings: string[],
): NodeSpec[] {
  const nodes: NodeSpec[] = [];

  for (const { id, fn, doc, exported } of declaredFunctions(file)) {
    if (!exported || !fn.isAsync()) continue;
    if (id.startsWith("run")) continue;

    const inName = fn.getParameters()[0]?.getTypeNode()?.getText();
    const outName = returnTypeName(fn);
    if (!inName || !outName) {
      warnings.push(`${id}: could not read its input/output types; skipped`);
      continue;
    }

    const traits = parseTraits(doc, id);
    nodes.push({
      id,
      label: traits.label,
      kind: traits.kind,
      ...(traits.model !== undefined ? { model: traits.model } : {}),
      in: interfaces.get(inName) ?? {},
      out: interfaces.get(outName) ?? {},
      ...(traits.writes ? { writes: traits.writes } : {}),
      ...(traits.uses ? { uses: traits.uses } : {}),
      ...(traits.freshContext ? { freshContext: traits.freshContext } : {}),
      ...(traits.expects !== undefined ? { expects: traits.expects } : {}),
      ...(traits.fanOut ? { fanOut: traits.fanOut } : {}),
      ...(traits.worktree ? { worktree: traits.worktree } : {}),
    } as NodeSpec);
  }

  return nodes;
}

/** `Promise<FooOut>` -> `FooOut` */
function returnTypeName(fn: FunctionDeclaration | ArrowFunction): string | undefined {
  const node = fn.getReturnTypeNode();
  if (!node) return undefined;
  const match = /^Promise<(.+)>$/.exec(node.getText().trim());
  return match?.[1]?.trim();
}

function jsDoc(node: JSDocableNode): string {
  return node
    .getJsDocs()
    .map((doc) => doc.getInnerText())
    .join(" ");
}

/**
 * Which node results reach an expression, and the fields the code named on the
 * way. An empty field set means the whole result travelled.
 */
type Flow = Map<string, Set<string>>;

/** An edge before `carries` is worked out. */
interface Recovered {
  readonly from: string;
  readonly to: string;
  readonly fields: Set<string>;
}

/**
 * Walks the runner. Every call to a node function is a step, and whatever flows
 * into its arguments names that step's dependencies — recovered from what the
 * values do rather than from what the variables holding them are called.
 *
 * Naming is a convention; dataflow is the program. A runner that writes
 * `const brief = await scope(args)` describes exactly the same graph as one that
 * writes `const scopeResult`, and both have to read back the same.
 */
function collectEdges(file: SourceFile, known: Set<string>, warnings: string[]): Recovered[] {
  const runner = declaredFunctions(file).find((d) => d.id.startsWith("run"))?.fn;
  if (!runner) {
    warnings.push("no run* function found — edges could not be recovered");
    return [];
  }

  const flowOf = dataflow(known);
  const edges: Recovered[] = [];
  const byKey = new Map<string, Recovered>();

  const add = (from: string, to: string, fields: Set<string>) => {
    if (from === to || !known.has(from) || !known.has(to)) return;
    const existing = byKey.get(`${from}->${to}`);
    if (existing) {
      for (const field of fields) existing.fields.add(field);
      return;
    }
    const edge: Recovered = { from, to, fields: new Set(fields) };
    byKey.set(`${from}->${to}`, edge);
    edges.push(edge);
  };

  for (const call of runner.getDescendantsOfKind(SyntaxKind.CallExpression)) {
    const to = call.getExpression().getText();
    if (!known.has(to)) continue;
    for (const argument of call.getArguments()) {
      for (const [from, fields] of flowOf(argument)) add(from, to, fields);
    }
  }

  // An edgeless graph is legal, so nothing downstream objects to one: it lints
  // clean and plans as a single wave — the most flattering answer, and the one
  // we produce when the values travel by a route this cannot follow.
  if (edges.length === 0 && known.size > 0) {
    warnings.push(
      `found ${known.size} nodes but no dependencies — every step will look independent and ` +
        "the graph will lint clean; no awaited result could be traced into another node's " +
        "arguments, so either the steps really are unrelated or the values move somewhere opaque",
    );
  }

  return edges;
}

/**
 * Resolves what flows into an expression, following bindings through the symbol
 * table rather than pattern-matching their names. Memoised per declaration: a
 * runner is a straight line of consts and the same one is read many times.
 */
function dataflow(known: Set<string>): (expr: Node) => Flow {
  const memo = new Map<Node, Flow>();

  const flowOf = (expr: Node): Flow => {
    // A call to a node function *is* the value here; nothing further inside it
    // reaches the caller, so the walk stops rather than descending into args.
    const calls = outermostNodeCalls(expr, known);
    if (calls.length > 0) {
      const out: Flow = new Map();
      for (const call of calls) out.set(call.getExpression().getText(), new Set());
      return out;
    }
    return referencesIn(expr);
  };

  /** Union of everything the expression reads, in source order. */
  const referencesIn = (expr: Node): Flow => {
    const out: Flow = new Map();

    const visit = (node: Node): void => {
      if (Node.isPropertyAccessExpression(node)) {
        const receiver = flowOf(node.getExpression());
        // `brief.summary` says which field travels. `items.map(...)` says
        // nothing — it is a method, not a field — so only a read counts.
        absorb(out, isCallee(node) ? receiver : withField(receiver, node.getName()));
        return;
      }
      if (Node.isIdentifier(node)) {
        absorb(out, fromIdentifier(node));
        return;
      }
      node.forEachChild(visit);
    };

    visit(expr);
    return out;
  };

  const fromIdentifier = (identifier: Identifier): Flow => {
    for (const declaration of declarationsOf(identifier)) {
      const flow = fromDeclaration(declaration);
      if (flow.size > 0) return flow;
    }

    // Codegen names its results `<nodeId>Result`, and that is worth something
    // when the binding itself is unreachable — a value handed in from another
    // module, say. A name is weaker evidence than dataflow, so it is only ever
    // consulted after dataflow has come back empty, never instead of it.
    const text = identifier.getText();
    if (text.endsWith(RESULT_SUFFIX)) {
      const candidate = text.slice(0, -RESULT_SUFFIX.length);
      if (known.has(candidate)) return new Map([[candidate, new Set<string>()]]);
    }
    return new Map();
  };

  const fromDeclaration = (declaration: Node): Flow => {
    const cached = memo.get(declaration);
    if (cached) return cached;
    // Seed empty first: a self-referential binding resolves to nothing rather
    // than recursing forever.
    memo.set(declaration, new Map());

    let flow: Flow = new Map();
    if (Node.isVariableDeclaration(declaration)) {
      const initialiser = declaration.getInitializer();
      // A node written as `export const step = async () => {}` is a function,
      // not a value: naming it does not make its body's calls flow anywhere.
      const isFunction =
        initialiser !== undefined &&
        (Node.isArrowFunction(initialiser) || Node.isFunctionExpression(initialiser));
      flow = initialiser && !isFunction ? flowOf(initialiser) : new Map();
    } else if (Node.isBindingElement(declaration)) {
      flow = fromBindingElement(declaration);
    } else if (Node.isParameterDeclaration(declaration)) {
      flow = fromParameter(declaration);
    }

    memo.set(declaration, flow);
    return flow;
  };

  /** `const { brief } = ...` and `const [a, b] = await Promise.all([...])`. */
  const fromBindingElement = (element: BindingElement): Flow => {
    const pattern = element.getParent();
    const owner = pattern.getParent();
    const initialiser = Node.isVariableDeclaration(owner) ? owner.getInitializer() : undefined;
    const source: Flow = initialiser
      ? flowOf(initialiser)
      : Node.isBindingElement(owner)
        ? fromDeclaration(owner)
        : new Map();

    if (Node.isArrayBindingPattern(pattern)) {
      // A rank compiles to one wave, so position in the pattern lines up with
      // position in the array. Index into the literal when there is one.
      const at = waveElements(initialiser)?.[pattern.getElements().indexOf(element)];
      return at ? flowOf(at) : source;
    }

    // The property name is the field that travels out of the source.
    const field = element.getPropertyNameNode()?.getText() ?? element.getName();
    return withField(source, field);
  };

  /**
   * `items.map((item) => audit(item))` — the callback's parameter is one of the
   * items, so it carries whatever produced the list. That is the only reason a
   * fanOut rank reads back as an edge from its source at all.
   */
  const fromParameter = (parameter: ParameterDeclaration): Flow => {
    const fn = parameter.getParent();
    if (!Node.isArrowFunction(fn) && !Node.isFunctionExpression(fn)) return new Map();

    const call = fn.getParent();
    if (!Node.isCallExpression(call)) return new Map();

    const callee = call.getExpression();
    if (!Node.isPropertyAccessExpression(callee)) return new Map();
    if (!PER_ITEM.has(callee.getName())) return new Map();
    return flowOf(callee.getExpression());
  };

  return flowOf;
}

/**
 * `{ brief }` resolves to the property it defines, not to the binding it copies,
 * so that one shape needs the language service to say what it means.
 */
function declarationsOf(identifier: Identifier): Node[] {
  if (Node.isShorthandPropertyAssignment(identifier.getParent())) {
    return identifier.getDefinitionNodes();
  }
  return identifier.getSymbol()?.getDeclarations() ?? [];
}

/** Calls to node functions that are not themselves inside another such call. */
function outermostNodeCalls(expr: Node, known: Set<string>): CallExpression[] {
  const isNodeCall = (call: CallExpression) => known.has(call.getExpression().getText());
  if (Node.isCallExpression(expr) && isNodeCall(expr)) return [expr];

  const found = expr.getDescendantsOfKind(SyntaxKind.CallExpression).filter(isNodeCall);
  return found.filter((call) => !found.some((other) => other !== call && isAncestor(other, call)));
}

const isAncestor = (ancestor: Node, node: Node) =>
  node.getFirstAncestor((candidate) => candidate === ancestor) !== undefined;

const isCallee = (node: Node) => {
  const parent = node.getParent();
  return parent !== undefined && Node.isCallExpression(parent) && parent.getExpression() === node;
};

/** `await Promise.all([...])`, `parallel([...])` — the array a rank compiles to. */
function waveElements(expr: Node | undefined): Node[] | undefined {
  const value = unwrap(expr);
  if (!value) return undefined;
  if (Node.isArrayLiteralExpression(value)) return value.getElements();

  if (Node.isCallExpression(value)) {
    for (const argument of value.getArguments()) {
      const inner = unwrap(argument);
      if (inner && Node.isArrayLiteralExpression(inner)) return inner.getElements();
    }
  }
  return undefined;
}

/** Strips the wrappers that do not change the value: await, parens, casts. */
function unwrap(node: Node | undefined): Node | undefined {
  let current = node;
  while (
    current &&
    (Node.isAwaitExpression(current) ||
      Node.isParenthesizedExpression(current) ||
      Node.isAsExpression(current) ||
      Node.isNonNullExpression(current) ||
      Node.isTypeAssertion(current))
  ) {
    current = current.getExpression();
  }
  return current;
}

const withField = (flow: Flow, field: string): Flow => {
  const out: Flow = new Map();
  for (const [id, fields] of flow) out.set(id, new Set([...fields, field]));
  return out;
};

const absorb = (target: Flow, source: Flow) => {
  for (const [id, fields] of source) {
    const existing = target.get(id);
    if (existing) for (const field of fields) existing.add(field);
    else target.set(id, new Set(fields));
  }
};

/**
 * An edge carries whatever the source declares and the target consumes — which
 * is the definition the linter uses, so recovering it this way reproduces the
 * original `carries` exactly, including the empty list on a fake edge.
 */
function withCarries(edges: Recovered[], nodes: NodeSpec[]): EdgeSpec[] {
  const byId = new Map(nodes.map((n) => [n.id, n]));
  return edges.map(({ from, to, fields }) => {
    const source = byId.get(from);
    const target = byId.get(to);
    if (!source || !target) return { from, to, carries: [] };

    const declared = Object.keys(source.out);
    // A field the code named — `brief.summary`, or `const { brief } =` — is a
    // stronger statement than two shapes happening to share a key, so it wins
    // where it applies. Generated code names none and falls through.
    const named = declared.filter((field) => fields.has(field));
    const carries =
      named.length > 0 ? named : declared.filter((field) => Object.hasOwn(target.in, field));
    return { from, to, carries };
  });
}

function readBanner(source: string): { name?: string; goal?: string } {
  const name = /^\/\/ Spec: (.+)$/m.exec(source)?.[1]?.trim();
  const goal = /^\/\/ Goal: (.+)$/m.exec(source)?.[1]?.trim();
  return { ...(name && { name }), ...(goal && { goal }) };
}

function runnerName(file: SourceFile): string | undefined {
  const runner = declaredFunctions(file).find((d) => d.id.startsWith("run"));
  const name = runner?.id.slice(3);
  return name ? name.replace(/([a-z0-9])([A-Z])/g, "$1-$2").toLowerCase() : undefined;
}
