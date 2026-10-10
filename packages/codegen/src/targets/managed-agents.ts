// SPDX-License-Identifier: Apache-2.0
import { SpecError, type Graph, type NodeSpec } from "@ccgrapher/core";
import { modelIdOf } from "../tiers.js";
import { banner, type DirectoryEmitter, type EmitOptions, type Files } from "../types.js";
import { toYaml, type YamlValue } from "../yaml.js";

/**
 * Emits the directory `ant apply` reads for Claude Managed Agents: one agent
 * per model node, `agents/<folder>/agent.md`, and one environment for the
 * workflow. It is written for orchestrated mode, where a runner drives one
 * session per node in the order the spec declares and writes the trace itself,
 * so there is no coordinator agent: the order lives in the runner, not in a
 * prompt.
 *
 * Plain-code nodes (`model: null`) and gates get no agent. The runner runs them
 * locally, and the generated README lists them so nothing is silently missing.
 * A node that declares no tier at all is still an agent node, as it is in the
 * renderer, and gets the strong tier with a warning: an agent definition must
 * name a model, and the stronger one is the safer guess for unknown work.
 *
 * Field names and limits are the documented ones: the agent fields `name`,
 * `description`, `model`, `metadata`, `tools`, `mcp_servers`, `skills` and
 * `multiagent`; metadata at most 16 pairs, keys up to 64 characters and values
 * up to 512; a description up to 2048. The body of `agent.md` is the system
 * prompt, so the generated-from banner goes in the frontmatter as `#` comments
 * and never in the body.
 */
export const managedAgentsEmitter: DirectoryEmitter = {
  target: "managed-agents",

  warnings(graph: Graph): string[] {
    const folders = folderMap(graph);
    const tierless = agentNodes(graph).filter((node) => node.model === undefined);
    return [
      // One line for all of them: a spec that leaves tiers out tends to leave
      // them all out, and ten identical warnings bury the ones that differ.
      ...(tierless.length > 0
        ? [
            `${tierless.map((n) => `'${n.id}'`).join(", ")} ${tierless.length === 1 ? "declares" : "declare"} no model tier, so the managed-agents target gives ${tierless.length === 1 ? "it" : "them"} the strong tier (${modelIdOf("strong")}).`,
          ]
        : []),
      ...agentNodes(graph).flatMap((node) => capabilities(graph, node, folders).warnings),
      // A read-only member gets no built-in write tool, because it declares no
      // writes. An MCP tool is another matter: whether it writes is opaque.
      ...(graph.spec.boundaries ?? [])
        .filter(
          (boundary) =>
            boundary.access === "read-only" &&
            boundary.members.some((id) => graph.nodes.get(id)?.uses?.some((u) => u.startsWith("mcp:"))),
        )
        .map(
          (boundary) =>
            `boundary '${boundary.id}' is read-only, and nothing on the platform stops an MCP tool one of its members uses from writing.`,
        ),
    ];
  },

  emitFiles(graph: Graph, options: EmitOptions): Files {
    const folders = folderMap(graph);
    const files: Record<string, string> = {};
    const comments = bannerComments(graph, options);
    let mcp = false;

    for (const node of agentNodes(graph)) {
      const caps = capabilities(graph, node, folders);
      if (caps.mcpServers.length > 0) mcp = true;
      files[`agents/${folders.get(node.id)!}/agent.md`] = agentFile(graph, node, caps, comments);
    }

    const environment = `agents/${environmentFolder(graph)}/environment.yaml`;
    files[environment] = environmentFile(graph, mcp, comments);
    files["README.md"] = readme(graph, folders, environment, options);

    return Object.fromEntries(Object.keys(files).sort().map((path) => [path, files[path]!]));
  },
};

/** A node becomes an agent unless it is plain code or a human gate. */
export function agentNodes(graph: Graph): NodeSpec[] {
  return graph.spec.nodes.filter(isAgentNode);
}

const isAgentNode = (node: NodeSpec) => node.kind !== "gate" && node.model !== null;

/**
 * The folder name must be kebab-case, so `skeptic_correct` lives in
 * `agents/skeptic-correct/` while its `name:` stays `skeptic_correct`, which is
 * the id the platform reports on every event and the audit joins on.
 */
export function kebab(id: string): string {
  return id
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function folderMap(graph: Graph): Map<string, string> {
  const folders = new Map<string, string>();
  const owners = new Map<string, string>();
  for (const node of agentNodes(graph)) {
    if (node.id === "self") {
      throw new SpecError(`node 'self' cannot become a Managed Agents agent: the name is reserved for the roster.`);
    }
    if (node.id.length > 256) {
      throw new SpecError(`node '${node.id.slice(0, 40)}…' is longer than the 256 characters an agent name may have.`);
    }
    const folder = kebab(node.id);
    if (!folder) {
      throw new SpecError(`node '${node.id}' has no letters or digits to name its agent folder with.`);
    }
    const owner = owners.get(folder);
    if (owner) {
      throw new SpecError(
        `nodes '${owner}' and '${node.id}' would share the agent folder agents/${folder}/; rename one of them.`,
      );
    }
    owners.set(folder, node.id);
    folders.set(node.id, folder);
  }
  return folders;
}

/**
 * The environment sits in a folder named after the spec. If an agent folder has
 * the same name the two files share it, which `ant apply` reads without trouble.
 */
const environmentFolder = (graph: Graph) => kebab(graph.spec.name) || "workflow";

// --- capabilities -----------------------------------------------------------

/** The prebuilt Anthropic skills, referenced by name. Anything else is a custom skill id. */
const PREBUILT_SKILLS = new Set(["docx", "pdf", "pptx", "xlsx"]);

interface Capabilities {
  readonly mcpServers: YamlValue[];
  readonly mcpToolsets: YamlValue[];
  readonly skills: YamlValue[];
  readonly roster: YamlValue[];
  readonly warnings: string[];
}

/**
 * `uses:` mapped to agent fields where the docs give a mapping, and a warning
 * where they do not. A value the spec cannot supply goes in as a `YOUR_...`
 * placeholder, which `ant apply` refuses rather than guessing at.
 */
function capabilities(graph: Graph, node: NodeSpec, folders: ReadonlyMap<string, string>): Capabilities {
  const file = `agents/${folders.get(node.id)}/agent.md`;
  const servers = new Map<string, string[]>();
  const skills: YamlValue[] = [];
  const roster: YamlValue[] = [];
  const warnings: string[] = [];

  for (const use of [...(node.uses ?? [])].sort()) {
    const colon = use.indexOf(":");
    const namespace = colon === -1 ? "" : use.slice(0, colon);
    const rest = colon === -1 ? use : use.slice(colon + 1);

    if (namespace === "mcp") {
      const slash = rest.indexOf("/");
      const server = slash === -1 ? rest : rest.slice(0, slash);
      const tool = slash === -1 ? "" : rest.slice(slash + 1);
      const tools = servers.get(server) ?? [];
      if (tool && !tools.includes(tool)) tools.push(tool);
      servers.set(server, tools);
    } else if (namespace === "skill") {
      if (PREBUILT_SKILLS.has(rest)) {
        skills.push({ skill_id: rest, type: "anthropic" });
      } else {
        const placeholder = `YOUR_SKILL_ID_${constant(rest)}`;
        skills.push({ skill_id: placeholder, type: "custom" });
        warnings.push(
          `'${node.id}' uses ${use}, which is not a prebuilt Anthropic skill: ${file} carries the placeholder ${placeholder} until the custom skill's id is filled in.`,
        );
      }
    } else if (namespace === "agent") {
      const sibling = graph.nodes.get(rest);
      if (sibling && isAgentNode(sibling) && sibling.id !== node.id) {
        roster.push(`../${folders.get(sibling.id)}/agent.md`);
        if ((sibling.uses ?? []).some((u) => u.startsWith("agent:"))) {
          warnings.push(
            `'${node.id}' rosters '${sibling.id}', which has a roster of its own: Managed Agents allows one level of delegation, so the apply will fail.`,
          );
        }
      } else {
        const placeholder = `YOUR_AGENT_ID_${constant(rest)}`;
        roster.push({ id: placeholder, type: "agent" });
        warnings.push(
          `'${node.id}' uses ${use}, which is not a model node in this spec: ${file} carries the placeholder ${placeholder} until the agent's id is filled in.`,
        );
      }
    } else if (namespace === "plugin") {
      warnings.push(
        `'${node.id}' uses ${use}, and Managed Agents has no equivalent of a plugin: the agent is generated without it, and the claim survives only in its metadata.`,
      );
    } else {
      warnings.push(
        `'${node.id}' uses ${use}, which the managed-agents target has no mapping for: the claim survives only in its metadata.`,
      );
    }
  }

  const mcpServers: YamlValue[] = [];
  const mcpToolsets: YamlValue[] = [];
  for (const server of [...servers.keys()].sort()) {
    const placeholder = `YOUR_MCP_URL_${constant(server)}`;
    const tools = servers.get(server)!;
    mcpServers.push({ name: server, type: "url", url: placeholder });
    // MCP tools default to always_ask. Said explicitly, because an unattended
    // run pauses on every call until someone confirms it, and whether a tool
    // is safe to allow is the operator's call, not something the spec records.
    const ask = { permission_policy: { type: "always_ask" } };
    mcpToolsets.push(
      tools.length > 0
        ? {
            configs: [...tools].sort().map((name) => ({ enabled: true, name, ...ask })),
            default_config: { enabled: false },
            mcp_server_name: server,
            type: "mcp_toolset",
          }
        : { default_config: ask, mcp_server_name: server, type: "mcp_toolset" },
    );
    warnings.push(
      `'${node.id}' uses the MCP server '${server}', and the spec names no URL for it: ${file} carries the placeholder ${placeholder}, and its tools are set to always_ask, which pauses an unattended run on every call until it is confirmed.`,
    );
  }

  return { mcpServers, mcpToolsets, skills, roster, warnings };
}

/** `docs-search` to `DOCS_SEARCH`, for a placeholder name. */
const constant = (text: string) =>
  text
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "") || "UNNAMED";

// --- files ------------------------------------------------------------------

function agentFile(graph: Graph, node: NodeSpec, caps: Capabilities, comments: string[]): string {
  const tier = node.model ?? "strong";
  const model = modelIdOf(tier);

  const builtIn: YamlValue[] = [
    { enabled: false, name: "web_fetch" },
    { enabled: false, name: "web_search" },
  ];
  // The spec says which files a node writes; nothing it says asks for a shell
  // or the web, so those stay off rather than being granted on a hunch.
  if ((node.writes ?? []).length > 0) builtIn.push({ enabled: true, name: "write" });

  const config: { [key: string]: YamlValue } = {
    description: limit(`Spec node '${node.id}' (${node.kind}) of ${graph.spec.name}: ${sentence(node.label)}`, 2048),
    metadata: metadata(graph, node),
    model,
    name: node.id,
    tools: [
      {
        configs: builtIn,
        default_config: { enabled: false, permission_policy: { type: "auto" } },
        type: "agent_toolset_20260401",
      },
      ...caps.mcpToolsets,
    ],
  };
  if (caps.mcpServers.length > 0) config.mcp_servers = caps.mcpServers;
  if (caps.skills.length > 0) config.skills = caps.skills;
  if (caps.roster.length > 0) config.multiagent = { agents: caps.roster, type: "coordinator" };

  const header = comments.length > 0
    ? [...comments, comment(`Node: ${node.id} (${node.kind}, ${node.model ?? "no tier, so strong"} -> ${model})`)]
    : [];

  return ["---", ...header, toYaml(config).trimEnd(), "---", "", systemPrompt(graph, node), ""].join("\n");
}

function metadata(graph: Graph, node: NodeSpec): { [key: string]: YamlValue } {
  const md: Record<string, string> = {
    ccg_spec: graph.spec.name,
    ccg_node: node.id,
    ccg_kind: node.kind,
    ccg_tier: node.model ?? "unset",
  };
  if (node.fanOut) {
    md.ccg_fanout_over = node.fanOut.over;
    if (node.fanOut.cap !== undefined) md.ccg_fanout_cap = String(node.fanOut.cap);
  }
  if (node.freshContext) md.ccg_fresh_context = "true";
  if (node.expects !== undefined) md.ccg_expects = String(node.expects);
  if (node.worktree) md.ccg_worktree = "true";
  const boundary = boundaryOf(graph, node.id);
  if (boundary) md.ccg_boundary = boundary;
  if (node.writes?.length) md.ccg_writes = node.writes.join(" ");
  if (node.uses?.length) md.ccg_uses = node.uses.join(" ");
  // Eleven keys at most, inside the documented sixteen.
  return Object.fromEntries(Object.entries(md).map(([key, value]) => [key, limit(value, 512)]));
}

function boundaryOf(graph: Graph, id: string): string | undefined {
  const boundary = (graph.spec.boundaries ?? []).find((b) => b.members.includes(id));
  return boundary ? `${boundary.id}${boundary.access ? ` (${boundary.access})` : ""}` : undefined;
}

const KIND: Readonly<Record<NodeSpec["kind"], string>> = {
  goal: "you state what the workflow is for",
  split: "you divide the input into independent pieces of work",
  worker: "you do one bounded piece of work",
  verifier: "you check the work in your input",
  reduce: "you combine the results in your input into one",
  synthesize: "you bring the results in your input together into one deliverable",
  gate: "you decide whether the work may go on",
};

/**
 * The body of agent.md, which the platform uses as the system prompt. It is
 * built only from what the spec declares: the label, the kind, the fields in
 * and out, the files written and the capabilities claimed.
 */
function systemPrompt(graph: Graph, node: NodeSpec): string {
  const parts: string[] = [];
  parts.push(
    `Your job: ${sentence(node.label)}\n\nYou are the \`${node.id}\` step of the ${graph.spec.name} workflow, a ${node.kind} step: ${KIND[node.kind]}.`,
  );
  if (graph.spec.goal) parts.push(`The workflow as a whole is for: ${sentence(graph.spec.goal)}`);

  if (node.fanOut) {
    const cap = node.fanOut.cap;
    parts.push(
      `You run once per \`${node.fanOut.over}\`${cap ? `, as one of up to ${cap} instances at the same time` : ""}. Handle only the item you are given.`,
    );
  }
  if (node.freshContext) {
    parts.push(
      node.kind === "verifier"
        ? "You are a verifier with a fresh context. You have not seen the work you are checking, and you judge it only on the evidence in your input. Do not ask how it was produced, and do not take its own account of itself on trust."
        : "You start with a fresh context. Rely only on your input.",
    );
  }

  parts.push(
    Object.keys(node.in).length > 0
      ? `## Input\n\nThe message you receive is one JSON object with these fields:\n\n${fieldList(node.in)}`
      : "## Input\n\nNo input fields are declared for this step.",
  );
  parts.push(
    Object.keys(node.out).length > 0
      ? `## Output\n\nReply with one JSON object and nothing else, with exactly these fields:\n\n${fieldList(node.out)}`
      : "## Output\n\nNo output fields are declared for this step. Reply with a short note of what you did.",
  );

  if (node.writes?.length) {
    parts.push(
      `## Files\n\nThis step declares that it writes ${node.writes.map((w) => `\`${w}\``).join(", ")}. Write ${node.writes.length === 1 ? "it" : "them"} under /mnt/session/outputs/, where the session keeps files after it ends, and write nothing else.`,
    );
  }
  if (node.uses?.length) {
    parts.push(
      `## Capabilities\n\nThe spec declares these capabilities for this step: ${node.uses.map((u) => `\`${u}\``).join(", ")}.`,
    );
  }
  return parts.join("\n\n");
}

const fieldList = (fields: Readonly<Record<string, string>>) =>
  Object.entries(fields)
    .map(([name, descriptor]) => `- \`${name}\`: ${descriptor}`)
    .join("\n");

function environmentFile(graph: Graph, mcp: boolean, comments: string[]): string {
  // limited networking with nothing opted in, unless an agent declares an MCP
  // server. The web tools are not governed by this block; they are off on each
  // agent instead.
  const networking: { [key: string]: YamlValue } = { type: "limited" };
  if (mcp) networking.allow_mcp_servers = true;
  const body = toYaml({ config: { networking, type: "cloud" }, name: graph.spec.name });
  return [...comments, body].join("\n");
}

function readme(
  graph: Graph,
  folders: ReadonlyMap<string, string>,
  environment: string,
  options: EmitOptions,
): string {
  const agents = agentNodes(graph);
  const local = graph.spec.nodes.filter((node) => !isAgentNode(node));
  const agentFiles = agents.map((node) => `agents/${folders.get(node.id)}/agent.md`);
  const lines = [`# ${graph.spec.name}, for Claude Managed Agents`, ""];

  if (options.banner !== false) {
    lines.push(
      `Generated by ccgrapher from ${options.specPath ?? `${graph.spec.name}.yaml`}. Regenerate rather than editing here.`,
      "",
    );
  }

  lines.push(
    "One agent per model node, for orchestrated mode, in which a runner drives one session per node, in the order the spec declares, and writes the trace itself. There is no coordinator agent.",
    "",
    "## Agents",
    "",
    "| Node | File | Model |",
    "| --- | --- | --- |",
    ...agents.map(
      (node, i) => `| \`${node.id}\` | \`${agentFiles[i]}\` | \`${modelIdOf(node.model ?? "strong")}\` |`,
    ),
    "",
    "## Run by the runner, with no agent",
    "",
    ...(local.length > 0
      ? local.map(
          (node) =>
            `- \`${node.id}\` (${node.kind}): ${node.kind === "gate" ? "a person approves" : "plain code, no model"}`,
        )
      : ["None: every node is a model node."]),
    "",
    "## Environment",
    "",
    `\`${environment}\`: a cloud container with limited networking.`,
    "",
    "## Applying",
    "",
    "Name the files. `ant apply .` walks the whole directory tree and applies every file that looks like a resource, which in a repository that holds other skills uploads those too.",
    "",
    "```sh",
    "grep -rn YOUR_ agents/",
    `ant apply --dry-run ${[...agentFiles, environment].join(" ")}`,
    "```",
    "",
  );
  return lines.join("\n");
}

// --- helpers ----------------------------------------------------------------

/** The shared banner, as YAML comments. One line each, whatever the goal holds. */
function bannerComments(graph: Graph, options: EmitOptions): string[] {
  return banner(graph, options, "managed-agents")
    .filter((line) => line !== "")
    .map((line) => comment(line.replace(/^\/\/ ?/, "")));
}

const comment = (text: string) => `# ${text.replace(/\s*[\r\n]+\s*/g, " ")}`;

/** A label as a sentence: a full stop unless it already ends in one, or in `?` or `!`. */
const sentence = (text: string) => (/[.?!]$/.test(text.trim()) ? text.trim() : `${text.trim()}.`);

/** Cut to a documented limit, deterministically. */
const limit = (text: string, max: number) => (text.length <= max ? text : `${text.slice(0, max - 1)}…`);
