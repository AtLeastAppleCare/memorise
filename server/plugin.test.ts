import { execFileSync } from "node:child_process";
import { statSync } from "node:fs";
import { mkdir, readFile, readdir, realpath, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import type { PluginServerContext, PluginSessionOpenContext, PluginSessionOpenRequest } from "@getpaseo/plugin/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type MemorySettings, memorySettings, updateMemoryRpc } from "../shared/memory";
import { contributeMemory, mergeAliasKeys } from "./plugin";
import { ProjectKeys } from "./project-keys";
import { ProposalStore } from "./proposals";
import { folderKey } from "./repo-key";
import { MemoryStore } from "./store";
import { loadTokenSecret, TokenAuthority } from "./mcp-auth";
import { tempDir } from "./test-temp-dir";

type Handler = (...args: never[]) => unknown;
const fullSupport: NonNullable<PluginSessionOpenRequest["openSupport"]> = {
  adapter: { kind: "builtin", id: "claude" },
  instructions: "supported",
  mcpHttp: "supported",
  exactMcpPreapproval: "supported",
  attachedTools: { delivery: "mcp", enabled: true, disabledTools: [] },
  restrictions: { mcpConfiguration: "mutable", processEnvironment: "mutable" },
  providerOptions: [],
};

function fakeServer(values: MemorySettings, readSettings?: () => Promise<unknown>) {
  const before = new Map<string, Handler>();
  const on = new Map<string, Handler>();
  const rpc = new Map<string, Handler>();
  const recipes: Parameters<PluginServerContext["registerLegacyAgentConfig"]>[0][] = [];
  const respondToPermission = vi.fn(async (_input: { requestId: string }) => undefined);
  const server = {
    features: { adaptiveAgentFeatures: true },
    registerLegacyAgentConfig: (recipe: Parameters<PluginServerContext["registerLegacyAgentConfig"]>[0]) => recipes.push(recipe),
    registerSettings: () => ({ read: readSettings ?? (async () => ({ status: "ready", revision: "1", values })), subscribe: () => () => undefined }),
    addHook: (name: string, handler: Handler) => before.set(name, handler),
    before: (name: string, handler: Handler) => before.set(name, handler),
    on: (name: string, handler: Handler) => on.set(name, handler),
    handle: (contract: { name: string }, handler: Handler) => rpc.set(contract.name, handler),
    registerProvider: () => undefined,
    registerUsageSource: () => undefined,
  } as unknown as PluginServerContext;
  const workspaces: { workspaceDirectory?: string; projectRootPath: string; projectKind?: string }[] = [];
  // Rows appended to agents' chats, by agent id.
  const appended: { agentId: string; row: Record<string, any> }[] = [];
  // Each agent's timeline, served only through refetch, as Paseo does: "after" a cursor, or the
  // most recent page for "tail".
  const timelines = new Map<string, unknown[]>();
  let nextLaunch = 0;
  const launches = new Map<string, { agentId: string; installed: boolean; users: number; released: boolean; controller: AbortController; disposals: ((outcome: { installed: boolean }) => void | Promise<void>)[] }>();
  async function releaseLaunch(id: string): Promise<void> {
    const lifetime = launches.get(id);
    if (!lifetime) return;
    lifetime.released = true;
    if (lifetime.users > 0) return;
    launches.delete(id);
    lifetime.controller.abort();
    await Promise.all(lifetime.disposals.map((dispose) => dispose({ installed: lifetime.installed })));
  }
  const refetch = (agentId: string) => async (options: { direction?: string; cursor?: { seq: number }; limit?: number } = {}) => {
    const all = (timelines.get(agentId) ?? []).map((item, i) => ({ item, seqStart: i + 1, seqEnd: i + 1 }));
    const limit = options.limit ?? 200;
    const page = options.direction === "after" && options.cursor ? all.filter((entry) => entry.seqEnd > (options.cursor?.seq ?? 0)).slice(0, limit) : all.slice(-limit);
    return { epoch: "e1", entries: page, hasNewer: false, reset: false, staleCursor: false };
  };
  const paseo = { agents: { ref: (agentId: string) => ({ respondToPermission, timeline: { refetch: refetch(agentId), append: async (row: Record<string, any>) => appended.push({ agentId, row }) } }), list: async () => ({ entries: [] }) }, workspaces: {
      // One workspace per page, so a lookup must follow the cursor.
      list: async ({ page }: { page?: { cursor?: string } } = {}) => {
        const at = Number(page?.cursor ?? 0);
        return { entries: workspaces.slice(at, at + 1), pageInfo: { hasMore: at + 1 < workspaces.length, nextCursor: String(at + 1), prevCursor: null } };
      },
    },
  };
  return {
    server,
    before,
    recipes,
    workspaces,
    respondToPermission,
    appended,
    agentCreated: (id: string, cwd: string) => (on.get("agent.created") as (event: unknown, context: unknown) => Promise<void>)({ agent: { id, cwd, provider: "claude", workspaceId: "ws-1", parentAgentId: null, title: null } }, { paseo }),
    // Items join the agent's timeline; the event itself carries an empty timeline, as Paseo's does.
    addToTimeline: (id: string, items: unknown[]) => timelines.set(id, [...(timelines.get(id) ?? []), ...items]),
    turnEnded: (id: string, cwd: string, items: unknown[]) => {
      timelines.set(id, [...(timelines.get(id) ?? []), ...items]);
      return (on.get("agent.turn_ended") as (event: unknown, context: unknown) => Promise<void>)({ agent: { id, cwd, provider: "claude", workspaceId: "ws-1", parentAgentId: null, title: null }, turnId: null, outcome: { kind: "completed" }, timeline: [] }, { paseo });
    },
    open: async (config: Record<string, unknown>, env: Record<string, string> = {}, options: Partial<PluginSessionOpenRequest> = {}) => {
      const launchId = options.launchId ?? `launch-${++nextLaunch}`;
      const request: PluginSessionOpenRequest = { agentId: "agent-1", launchId, workspaceId: "ws-1", provider: config.provider as string, cwd: config.cwd as string, reason: "create", purpose: "interactive", title: null, background: false, labels: {}, metadata: {}, env, tools: [], mcpServers: {}, baseConfig: config as PluginSessionOpenRequest["baseConfig"], openSupport: fullSupport, legacyConfigState: { selectors: { "memory-instructions": "absent" } }, ...options };
      const controller = new AbortController();
      const lifetime = { agentId: request.agentId, installed: false, users: 0, released: false, controller, disposals: [] as ((outcome: { installed: boolean }) => void | Promise<void>)[] };
      launches.set(launchId, lifetime);
      const installations: (() => void | Promise<void>)[] = [];
      const launch: PluginSessionOpenContext["launch"] = {
        id: launchId, signal: controller.signal,
        onDispose: (cleanup) => { lifetime.disposals.push(cleanup); },
        onInstalled: (callback) => { installations.push(callback); },
        retainPrevious: () => {
          const previous = request.previousContribution;
          const prior = previous && launches.get(previous.launchId);
          if (!previous || !prior || !prior.installed || prior.agentId !== request.agentId || prior.controller.signal.aborted) throw new Error("No live owner-specific prior contribution");
          prior.users += 1;
          lifetime.disposals.push(async () => {
            prior.users -= 1;
            if (prior.released) await releaseLaunch(previous.launchId);
          });
          return previous;
        },
      };
      let result: PluginSessionOpenRequest;
      try {
        result = await (before.get("agent.open.before") as (input: unknown, context: unknown) => Promise<PluginSessionOpenRequest | void>)({ request }, { paseo, signal: controller.signal, launch }) ?? request;
      } catch (error) {
        await releaseLaunch(launchId);
        throw error;
      }
      const basePrompt = config.systemPrompt as string | undefined;
      const append = result.appendSystemPrompt ?? [];
      return {
        request: result,
        contribution: { launchId, mcpServers: result.mcpServers, appendSystemPrompt: result.appendSystemPrompt?.slice(options.appendSystemPrompt?.length ?? 0), toolPolicy: result.toolPolicy, providerOptions: result.providerOptions, env: Object.fromEntries(Object.entries(result.env).filter(([key, value]) => env[key] !== value)) },
        config: { ...config, systemPrompt: [basePrompt, ...append].filter(Boolean).join("\n\n") || undefined, mcpServers: { ...((config.mcpServers as object | undefined) ?? {}), ...result.mcpServers } } as Record<string, any>,
        signal: controller.signal,
        install: async () => { lifetime.installed = true; await Promise.all(installations.map((callback) => callback())); },
        dispose: () => releaseLaunch(launchId),
      };
    },
    call: (name: string, input: unknown) => (rpc.get(name) as (input: unknown, context: unknown) => Promise<any>)(input, { paseo }),
    workspaceCreated: (cwd: string) => (on.get("workspace.created") as (event: unknown, context: unknown) => Promise<void>)({ workspace: { id: "ws-1", projectId: "p-1", cwd, name: null, archivedAt: null } }, { paseo }),
    permission: (request: Record<string, unknown>, cwd = "/tmp", provider = "claude") => (on.get("agent.permission_requested") as (event: unknown, context: unknown) => Promise<void>)({ agent: { id: "agent-1", cwd, provider }, request }, { paseo }),
  };
}

async function repoWithOrigin(origin: string): Promise<string> {
  const cwd = tempDir("plugin-repo-");
  execFileSync("git", ["init", "-q", cwd]);
  execFileSync("git", ["-C", cwd, "remote", "add", "origin", origin]);
  return cwd;
}

const defaults: MemorySettings = { ...memorySettings.schema.parse({}), mcpPort: 0 };
const other = { excalidraw: { type: "stdio", command: "excalidraw" } };

describe("memorise server entry", () => {
  let cleanup: () => unknown = () => undefined;
  let root: string;
  beforeEach(async () => {
    root = tempDir("plugin-root-");
  });
  afterEach(async () => {
    // Reset after use: a test that never starts the plugin must not run the previous one's cleanup again.
    await cleanup();
    cleanup = () => undefined;
    vi.restoreAllMocks();
  });

  function start(values: MemorySettings = defaults) {
    const fake = fakeServer(values);
    cleanup = contributeMemory(fake.server, async () => root) as () => unknown;
    return fake;
  }

  it("rejects an old host before starting runtime work and registers one static legacy recipe", () => {
    const old = fakeServer(defaults);
    Object.assign(old.server, { features: undefined });
    const resolveRoot = vi.fn(async () => root);
    expect(() => contributeMemory(old.server, resolveRoot)).toThrow(/Update.*host.*adaptive/i);
    expect(resolveRoot).not.toHaveBeenCalled();
    const fake = start();
    expect(fake.before.has("agent.create")).toBe(false);
    expect(fake.recipes).toEqual([{ version: 1, selectors: [
      { id: "memory-read-server", group: "memory", label: "Memory read tools", kind: "mcp", name: "paseo-memorise" },
      { id: "memory-write-server", group: "memory", label: "Memory write tools", kind: "mcp", name: "paseo-memorise-write" },
      { id: "memory-instructions", group: "memory", label: "Saved memory notes and guidance", kind: "prompt-section", start: "<memorise>", end: "</memorise>" },
    ] }]);
  });

  it("restores supported features after a limited open without changing saved preferences or memories", async () => {
    const fake = start();
    const cwd = await repoWithOrigin("git@github.com:acme/api.git");
    const where = { repoKey: "github.com/acme/api" };
    await fake.call("memory.save", { where, scope: "repo", type: "howto", subject: "deploy", body: "Run make deploy.", activation: "title" });
    await fake.call("memory.repo-prefs.set", { repoKey: where.repoKey, prefs: { includeGlobal: false } });
    const prefs = await readFile(join(root, "repo-prefs.json"), "utf8");
    const facts = await fake.call("memory.list", { where });
    const base = { provider: "custom-alias", cwd };
    const supported = await fake.open(base);
    const limited = await fake.open(base, {}, { reason: "refresh", launchId: "limited", openSupport: { ...fullSupport, mcpHttp: "unknown", exactMcpPreapproval: "unknown" } });
    const restored = await fake.open(base, {}, { reason: "resume", launchId: "restored" });
    expect(Object.keys(supported.request.mcpServers)).toEqual(["paseo-memorise", "paseo-memorise-write"]);
    expect(limited.request.mcpServers).toEqual({});
    expect(limited.config.systemPrompt).toContain("read-only");
    expect(limited.config.systemPrompt).not.toMatch(/memory_(read|search|write|update|retire)/);
    expect(limited.request.toolPolicy).toBeUndefined();
    expect(Object.keys(restored.request.mcpServers)).toEqual(["paseo-memorise", "paseo-memorise-write"]);
    expect(restored.request.toolPolicy).toEqual({ preapproved: [
      { kind: "mcp", server: "paseo-memorise", tool: "memory_search" },
      { kind: "mcp", server: "paseo-memorise", tool: "memory_read" },
    ] });
    expect(await readFile(join(root, "repo-prefs.json"), "utf8")).toBe(prefs);
    expect((await fake.call("memory.list", { where })).facts.map((fact: { body: string }) => fact.body)).toEqual(facts.facts.map((fact: { body: string }) => fact.body));
    expect(base).toEqual({ provider: "custom-alias", cwd });
  });

  it("keeps tools without instructions or exact approval, and never answers normal prompts", async () => {
    const fake = start();
    const cwd = tempDir("plugin-plain-");
    const opened = await fake.open({ provider: "custom-alias", cwd }, {}, { openSupport: { ...fullSupport, instructions: "unknown", exactMcpPreapproval: "unsupported" } });
    expect(Object.keys(opened.request.mcpServers)).toEqual(["paseo-memorise", "paseo-memorise-write"]);
    expect(opened.request.appendSystemPrompt).toBeUndefined();
    expect(opened.request.toolPolicy).toBeUndefined();
    await fake.permission({ id: "read", name: "mcp__paseo-memorise__memory_read" }, cwd, "custom-alias");
    expect(fake.respondToPermission).not.toHaveBeenCalled();
  });

  it.each(["none", "unknown"] as const)("keeps only read-only notes when MCP configuration is %s", async (mcpConfiguration) => {
    const fake = start();
    const opened = await fake.open({ provider: "claude", cwd: tempDir("plugin-plain-") }, {}, { openSupport: { ...fullSupport, restrictions: { ...fullSupport.restrictions, mcpConfiguration } } });
    expect(opened.request.mcpServers).toEqual({});
    expect(opened.request.toolPolicy).toBeUndefined();
    expect(opened.config.systemPrompt).toContain("read-only");
    expect(opened.config.systemPrompt).not.toMatch(/memory_(read|search|write|update|retire)/);
  });

  it("treats absent support as unknown rather than guessing from the selected provider", async () => {
    const fake = start();
    const opened = await fake.open({ provider: "claude", cwd: tempDir("plugin-plain-") }, {}, { openSupport: undefined });
    expect(opened.request.mcpServers).toEqual({});
    expect(opened.request.appendSystemPrompt).toBeUndefined();
    expect(opened.request.toolPolicy).toBeUndefined();
  });

  it("omits exact grants when automatic reads are disabled", async () => {
    const fake = start({ ...defaults, autoApproveReads: false });
    const opened = await fake.open({ provider: "claude", cwd: tempDir("plugin-plain-") });
    expect(Object.keys(opened.request.mcpServers)).toHaveLength(2);
    expect(opened.request.toolPolicy).toBeUndefined();
  });

  it.each(["unknown", "unsupported"] as const)("keeps tools and notes with ordinary prompts when exact approval is %s", async (exactMcpPreapproval) => {
    const fake = start();
    const opened = await fake.open({ provider: "claude", cwd: tempDir("plugin-plain-") }, {}, { openSupport: { ...fullSupport, exactMcpPreapproval } });
    expect(Object.keys(opened.request.mcpServers)).toHaveLength(2);
    expect(opened.config.systemPrompt).toContain("memory_search and memory_read");
    expect(opened.request.toolPolicy).toBeUndefined();
  });

  it("suppresses the entire group for an occupied saved name without touching caller policy", async () => {
    const fake = start();
    const saved = { provider: "claude", cwd: tempDir("plugin-plain-"), systemPrompt: "Caller.", mcpServers: { "paseo-memorise-write": { type: "http", url: "http://caller.invalid/mcp" } }, toolPolicy: { preapproved: [{ kind: "mcp", server: "paseo-memorise-write", tool: "caller_tool" }] } };
    const tokens = vi.spyOn(TokenAuthority.prototype, "mintLaunch");
    const opened = await fake.open(saved);
    expect(opened.config).toEqual(saved);
    expect(opened.request.mcpServers).toEqual({});
    expect(opened.request.toolPolicy).toBeUndefined();
    expect(opened.request.appendSystemPrompt).toBeUndefined();
    expect(tokens).not.toHaveBeenCalled();
    tokens.mockRestore();
  });

  it.each(["present", "ambiguous"] as const)("suppresses fresh guidance for a %s saved prompt while allowing free endpoints", async (status) => {
    const fake = start();
    const saved = { provider: "claude", cwd: tempDir("plugin-plain-"), systemPrompt: "Caller.\n\n<memorise>saved</memorise>" };
    const opened = await fake.open(saved, {}, { legacyConfigState: { selectors: { "memory-instructions": status } } });
    expect(opened.config.systemPrompt).toBe(saved.systemPrompt);
    expect(Object.keys(opened.request.mcpServers)).toHaveLength(2);
    expect(opened.request.appendSystemPrompt).toBeUndefined();
  });

  it("allocates nothing for history or fixed openings without prior bindings", async () => {
    const fake = start();
    const base = { provider: "claude", cwd: tempDir("plugin-plain-") };
    const minted = vi.spyOn(TokenAuthority.prototype, "mintLaunch");
    const history = await fake.open(base, {}, { purpose: "history" });
    expect(history.config).toEqual({ ...base, mcpServers: {} });
    const fixed = await fake.open(base, {}, { openSupport: { ...fullSupport, restrictions: { ...fullSupport.restrictions, mcpConfiguration: "fixed" } } });
    expect(fixed.request.mcpServers).toEqual({});
    expect(fixed.request.toolPolicy).toBeUndefined();
    expect(fixed.config.systemPrompt).toContain("read-only");
    expect(fixed.config.systemPrompt).not.toMatch(/memory_(read|search|write|update|retire)/);
    expect(minted).not.toHaveBeenCalled();
  });

  it("keeps an installed empty contribution empty when fixed memory remains Off", async () => {
    const fake = start({ ...defaults, enabled: false });
    const base = { provider: "work-alias", cwd: tempDir("plugin-plain-"), systemPrompt: "Caller." };
    const minted = vi.spyOn(TokenAuthority.prototype, "mintLaunch");
    const first = await fake.open(base);
    await first.install();
    const fixed = await fake.open(base, {}, { reason: "refresh", previousContribution: first.contribution, openSupport: { ...fullSupport, restrictions: { ...fullSupport.restrictions, mcpConfiguration: "fixed" } } });
    expect(fixed.config).toEqual({ ...base, mcpServers: {} });
    expect(fixed.request.mcpServers).toEqual({});
    expect(fixed.request.appendSystemPrompt).toBeUndefined();
    expect(fixed.request.toolPolicy).toBeUndefined();
    expect(minted).not.toHaveBeenCalled();
  });

  it("keeps an installed limited contribution empty on a fixed opening without HTTP or instructions", async () => {
    const fake = start();
    const base = { provider: "work-alias", cwd: tempDir("plugin-plain-"), systemPrompt: "Caller." };
    const limitedSupport = { ...fullSupport, instructions: "unsupported" as const, mcpHttp: "unsupported" as const };
    const minted = vi.spyOn(TokenAuthority.prototype, "mintLaunch");
    const first = await fake.open(base, {}, { openSupport: limitedSupport });
    await first.install();
    const fixed = await fake.open(base, {}, { reason: "refresh", previousContribution: first.contribution, openSupport: { ...limitedSupport, restrictions: { ...limitedSupport.restrictions, mcpConfiguration: "fixed" } } });
    expect(fixed.config).toEqual({ ...base, mcpServers: {} });
    expect(fixed.request.mcpServers).toEqual({});
    expect(fixed.request.appendSystemPrompt).toBeUndefined();
    expect(fixed.request.toolPolicy).toBeUndefined();
    expect(minted).not.toHaveBeenCalled();
  });

  it("preserves saved caller names and suppresses new memory on a fixed opening without an owned binding", async () => {
    const fake = start();
    const saved = { provider: "work-alias", cwd: tempDir("plugin-plain-"), systemPrompt: "Caller.\n\n<memorise>saved</memorise>", mcpServers: { "paseo-memorise-write": { type: "http", url: "http://caller.invalid/mcp" } }, toolPolicy: { preapproved: [{ kind: "mcp", server: "paseo-memorise-write", tool: "caller_tool" }] } };
    const minted = vi.spyOn(TokenAuthority.prototype, "mintLaunch");
    const first = await fake.open(saved);
    await first.install();
    const fixed = await fake.open(saved, {}, { reason: "refresh", previousContribution: first.contribution, openSupport: { ...fullSupport, restrictions: { ...fullSupport.restrictions, mcpConfiguration: "fixed" } } });
    expect(fixed.config).toEqual(saved);
    expect(fixed.request.mcpServers).toEqual({});
    expect(fixed.request.appendSystemPrompt).toBeUndefined();
    expect(fixed.request.toolPolicy).toBeUndefined();
    expect(minted).not.toHaveBeenCalled();
  });

  it("derives newly eligible fixed notes without tools or excluded global memories after an empty opening", async () => {
    const fake = start();
    const cwd = await repoWithOrigin("git@github.com:acme/api.git");
    const where = { repoKey: "github.com/acme/api" };
    await fake.call("memory.save", { where, scope: "repo", type: "howto", subject: "repo build", body: "Run make build." });
    await fake.call("memory.save", { where, scope: "global", type: "preference", subject: "global style", body: "Use global style." });
    await fake.call("memory.repo-prefs.set", { repoKey: where.repoKey, prefs: { includeGlobal: false } });
    const base = { provider: "work-alias", cwd };
    const minted = vi.spyOn(TokenAuthority.prototype, "mintLaunch");
    const first = await fake.open(base, {}, { openSupport: { ...fullSupport, instructions: "unsupported", mcpHttp: "unsupported" } });
    await first.install();
    const fixed = await fake.open(base, {}, { reason: "refresh", previousContribution: first.contribution, openSupport: { ...fullSupport, restrictions: { ...fullSupport.restrictions, mcpConfiguration: "fixed" } } });
    expect(fixed.request.mcpServers).toEqual({});
    expect(fixed.request.toolPolicy).toBeUndefined();
    expect(fixed.config.systemPrompt).toContain("repo build: Run make build.");
    expect(fixed.config.systemPrompt).not.toContain("global style");
    expect(fixed.config.systemPrompt).toContain("read-only");
    expect(fixed.config.systemPrompt).not.toMatch(/memory_(read|search|write|update|retire)/);
    expect(minted).not.toHaveBeenCalled();
  });

  it("keeps fixed notes read-only after an installed notes-only contribution", async () => {
    const fake = start();
    const base = { provider: "work-alias", cwd: tempDir("plugin-plain-") };
    const limitedSupport = { ...fullSupport, mcpHttp: "unsupported" as const };
    const minted = vi.spyOn(TokenAuthority.prototype, "mintLaunch");
    const first = await fake.open(base, {}, { openSupport: limitedSupport });
    await first.install();
    expect(first.request.mcpServers).toEqual({});
    expect(first.config.systemPrompt).toContain("read-only");
    const fixed = await fake.open(base, {}, { reason: "refresh", previousContribution: first.contribution, openSupport: { ...limitedSupport, restrictions: { ...limitedSupport.restrictions, mcpConfiguration: "fixed" } } });
    expect(fixed.request.mcpServers).toEqual({});
    expect(fixed.request.toolPolicy).toBeUndefined();
    expect(fixed.config.systemPrompt).toContain("read-only");
    expect(fixed.config.systemPrompt).not.toMatch(/memory_(read|search|write|update|retire)/);
    expect(minted).not.toHaveBeenCalled();
  });

  it("reports a fixed notes loading problem without full-close guidance when no owned binding exists", async () => {
    let unavailable = false;
    const fake = fakeServer(defaults, async () => {
      if (unavailable) throw new Error("settings store offline");
      return { status: "ready", revision: "1", values: defaults };
    });
    cleanup = contributeMemory(fake.server, async () => root) as () => unknown;
    const base = { provider: "work-alias", cwd: tempDir("plugin-plain-") };
    const minted = vi.spyOn(TokenAuthority.prototype, "mintLaunch");
    const first = await fake.open(base, {}, { openSupport: { ...fullSupport, instructions: "unsupported", mcpHttp: "unsupported" } });
    await first.install();
    unavailable = true;
    const fixed = await fake.open(base, {}, { reason: "refresh", previousContribution: first.contribution, openSupport: { ...fullSupport, restrictions: { ...fullSupport.restrictions, mcpConfiguration: "fixed" } } });
    expect(fixed.request.mcpServers).toEqual({});
    expect(fixed.request.toolPolicy).toBeUndefined();
    expect(fixed.config.systemPrompt).toContain("memory could not be loaded (Error: settings store offline)");
    expect(fixed.config.systemPrompt).not.toMatch(/fully close|reopen|memory_(read|search|write|update|retire)/i);
    expect(minted).not.toHaveBeenCalled();
  });

  it("reuses the exact installed own contribution for compatible fixed openings without minting a credential", async () => {
    const fake = start();
    const base = { provider: "work-alias", cwd: tempDir("plugin-plain-") };
    const first = await fake.open(base, { CALLER_ENV: "old" });
    await first.install();
    const minted = vi.spyOn(TokenAuthority.prototype, "mintLaunch");
    const fixed = await fake.open(base, { CALLER_ENV: "current" }, { reason: "refresh", previousContribution: first.contribution, openSupport: { ...fullSupport, restrictions: { ...fullSupport.restrictions, mcpConfiguration: "fixed" } } });
    expect(fixed.request.mcpServers).toEqual(first.request.mcpServers);
    expect(fixed.request.toolPolicy).toEqual(first.request.toolPolicy);
    expect(fixed.request.appendSystemPrompt).toEqual(first.request.appendSystemPrompt);
    expect(fixed.request.providerOptions).toEqual(first.request.providerOptions);
    expect(fixed.request.env).toEqual({ CALLER_ENV: "current" });
    expect(minted).not.toHaveBeenCalled();
  });

  it("preserves the current incoming instruction prefix before its own retained fixed instructions", async () => {
    const fake = start();
    const base = { provider: "work-alias", cwd: tempDir("plugin-plain-"), systemPrompt: "Caller." };
    const first = await fake.open(base, {}, { appendSystemPrompt: ["Earlier plugin on create."] });
    await first.install();
    expect(first.contribution.appendSystemPrompt).toHaveLength(1);
    const minted = vi.spyOn(TokenAuthority.prototype, "mintLaunch");
    const fixed = await fake.open(base, {}, { reason: "refresh", appendSystemPrompt: ["Earlier plugin on refresh."], previousContribution: first.contribution, openSupport: { ...fullSupport, restrictions: { ...fullSupport.restrictions, mcpConfiguration: "fixed" } } });
    expect(fixed.request.appendSystemPrompt?.[0]).toBe("Earlier plugin on refresh.");
    expect(fixed.request.appendSystemPrompt).toHaveLength(2);
    expect(fixed.contribution.appendSystemPrompt).toEqual(first.contribution.appendSystemPrompt);
    expect(fixed.config.systemPrompt).not.toContain("Earlier plugin on create.");
    expect(fixed.request.mcpServers).toEqual(first.request.mcpServers);
    expect(minted).not.toHaveBeenCalled();
  });

  it.each([{ autoApproveReads: false }, { enabled: false }, { indexMaxLines: 0 }])("refuses fixed reuse after settings change to %j before allocation", async (change) => {
    let values = { ...defaults };
    const fake = fakeServer(defaults, async () => ({ status: "ready", revision: "1", values }));
    cleanup = contributeMemory(fake.server, async () => root) as () => unknown;
    const base = { provider: "claude", cwd: tempDir("plugin-plain-") };
    const first = await fake.open(base);
    await first.install();
    values = { ...values, ...change };
    const minted = vi.spyOn(TokenAuthority.prototype, "mintLaunch");
    await expect(fake.open(base, {}, { previousContribution: first.contribution, openSupport: { ...fullSupport, restrictions: { ...fullSupport.restrictions, mcpConfiguration: "fixed" } } })).rejects.toThrow(/fully close.*reopen/i);
    expect(minted).not.toHaveBeenCalled();
    expect(first.signal.aborted).toBe(false);
  });

  it.each([{ includeGlobal: false }, { enabled: false }])("refuses fixed reuse after project preferences change to %j", async (prefs) => {
    const fake = start();
    const base = { provider: "claude", cwd: await repoWithOrigin("git@github.com:acme/api.git") };
    const first = await fake.open(base);
    await first.install();
    await fake.call("memory.repo-prefs.set", { repoKey: "github.com/acme/api", prefs });
    const minted = vi.spyOn(TokenAuthority.prototype, "mintLaunch");
    await expect(fake.open(base, {}, { previousContribution: first.contribution, openSupport: { ...fullSupport, restrictions: { ...fullSupport.restrictions, mcpConfiguration: "fixed" } } })).rejects.toThrow(/fully close.*reopen/i);
    expect(minted).not.toHaveBeenCalled();
  });

  it("keeps a retained credential alive after prior release and through chained fixed openings", async () => {
    const fake = start();
    const base = { provider: "claude", cwd: tempDir("plugin-plain-") };
    const minted = vi.spyOn(TokenAuthority.prototype, "mintLaunch");
    const first = await fake.open(base);
    await first.install();
    const fixedSupport = { ...fullSupport, restrictions: { ...fullSupport.restrictions, mcpConfiguration: "fixed" as const } };
    const second = await fake.open(base, {}, { previousContribution: first.contribution, openSupport: fixedSupport });
    await second.install();
    await first.dispose();
    const authority = minted.mock.contexts[0] as TokenAuthority;
    const authorization = first.config.mcpServers["paseo-memorise"].headers.Authorization;
    expect(first.signal.aborted).toBe(false);
    expect(authority.verify(authorization)?.agentId).toBe("agent-1");
    const third = await fake.open(base, {}, { previousContribution: second.contribution, openSupport: fixedSupport });
    await third.install();
    await second.dispose();
    expect(authority.verify(authorization)?.agentId).toBe("agent-1");
    await third.dispose();
    expect(authority.verify(authorization)).toBeNull();
    expect(first.signal.aborted).toBe(true);
  });

  it("rejects provisional or disposed prior contributions and changed prompt eligibility", async () => {
    const fake = start();
    const base = { provider: "claude", cwd: tempDir("plugin-plain-") };
    const first = await fake.open(base);
    const fixedSupport = { ...fullSupport, restrictions: { ...fullSupport.restrictions, mcpConfiguration: "fixed" as const } };
    await expect(fake.open(base, {}, { previousContribution: first.contribution, openSupport: fixedSupport })).rejects.toThrow(/fully close.*reopen/i);
    await first.install();
    await expect(fake.open(base, {}, { previousContribution: first.contribution, openSupport: fixedSupport, legacyConfigState: { selectors: { "memory-instructions": "present" } } })).rejects.toThrow(/fully close.*reopen/i);
    await first.dispose();
    await expect(fake.open(base, {}, { previousContribution: first.contribution, openSupport: fixedSupport })).rejects.toThrow(/fully close.*reopen/i);
  });

  it("releases only a failed replacement's retention while its prior launch stays usable", async () => {
    const fake = start();
    const base = { provider: "claude", cwd: tempDir("plugin-plain-") };
    const minted = vi.spyOn(TokenAuthority.prototype, "mintLaunch");
    const first = await fake.open(base);
    await first.install();
    const fixedSupport = { ...fullSupport, restrictions: { ...fullSupport.restrictions, mcpConfiguration: "fixed" as const } };
    const provisional = await fake.open(base, {}, { previousContribution: first.contribution, openSupport: fixedSupport });
    await provisional.dispose();
    const authority = minted.mock.contexts[0] as TokenAuthority;
    const authorization = first.config.mcpServers["paseo-memorise"].headers.Authorization;
    expect(authority.verify(authorization)?.agentId).toBe("agent-1");
    expect(first.signal.aborted).toBe(false);
    const retry = await fake.open(base, {}, { previousContribution: first.contribution, openSupport: fixedSupport });
    await retry.install();
    expect(retry.request.mcpServers).toEqual(first.request.mcpServers);
    await retry.dispose();
    await first.dispose();
    expect(authority.verify(authorization)).toBeNull();
  });

  it("refuses fixed reuse after a plugin restart even when a prior snapshot is supplied", async () => {
    const fake = start();
    const base = { provider: "claude", cwd: tempDir("plugin-plain-") };
    const first = await fake.open(base);
    await first.install();
    await cleanup();
    const restarted = start();
    const minted = vi.spyOn(TokenAuthority.prototype, "mintLaunch");
    await expect(restarted.open(base, {}, { previousContribution: first.contribution, openSupport: { ...fullSupport, restrictions: { ...fullSupport.restrictions, mcpConfiguration: "fixed" } } })).rejects.toThrow(/fully close.*reopen/i);
    expect(minted).not.toHaveBeenCalled();
  });

  it("refuses fixed reuse when the current folder resolves to another project", async () => {
    const fake = start();
    const cwd = await repoWithOrigin("git@github.com:acme/api.git");
    const base = { provider: "claude", cwd };
    const first = await fake.open(base);
    await first.install();
    execFileSync("git", ["-C", cwd, "remote", "set-url", "origin", "git@github.com:acme/web.git"]);
    const minted = vi.spyOn(TokenAuthority.prototype, "mintLaunch");
    await expect(fake.open(base, {}, { previousContribution: first.contribution, openSupport: { ...fullSupport, restrictions: { ...fullSupport.restrictions, mcpConfiguration: "fixed" } } })).rejects.toThrow(/fully close.*reopen/i);
    expect(minted).not.toHaveBeenCalled();
  });

  it.each([{ instructions: "unsupported" as const }, { exactMcpPreapproval: "unknown" as const }, { mcpHttp: "unsupported" as const }])("refuses fixed reuse when current feature eligibility changes to %j", async (support) => {
    const fake = start();
    const base = { provider: "claude", cwd: tempDir("plugin-plain-") };
    const first = await fake.open(base);
    await first.install();
    const minted = vi.spyOn(TokenAuthority.prototype, "mintLaunch");
    await expect(fake.open(base, {}, { previousContribution: first.contribution, openSupport: { ...fullSupport, ...support, restrictions: { ...fullSupport.restrictions, mcpConfiguration: "fixed" } } })).rejects.toThrow(/fully close.*reopen/i);
    expect(minted).not.toHaveBeenCalled();
  });

  it("never reuses another agent's matching-settings prior contribution", async () => {
    const fake = start();
    const base = { provider: "claude", cwd: tempDir("plugin-plain-") };
    const first = await fake.open(base, {}, { agentId: "owner" });
    await first.install();
    const minted = vi.spyOn(TokenAuthority.prototype, "mintLaunch");
    await expect(fake.open(base, {}, { agentId: "outsider", previousContribution: first.contribution, openSupport: { ...fullSupport, restrictions: { ...fullSupport.restrictions, mcpConfiguration: "fixed" } } })).rejects.toThrow(/fully close.*reopen/i);
    expect(minted).not.toHaveBeenCalled();
    expect(first.signal.aborted).toBe(false);
  });

  it("registers independent token disposal for each launch", async () => {
    const fake = start();
    const cwd = tempDir("plugin-plain-");
    const minted = vi.spyOn(TokenAuthority.prototype, "mintLaunch");
    const first = await fake.open({ provider: "claude", cwd });
    const second = await fake.open({ provider: "claude", cwd }, {}, { launchId: "second" });
    const tokens = new TokenAuthority(await loadTokenSecret(root));
    const legacy = tokens.mint({ repoKey: null, cwd, provider: "claude" });
    expect(first.config.mcpServers["paseo-memorise"].headers.Authorization).not.toBe(second.config.mcpServers["paseo-memorise"].headers.Authorization);
    expect(first.config.mcpServers["paseo-memorise"].headers.Authorization).toMatch(/^Bearer launch\./);
    expect(second.config.mcpServers["paseo-memorise"].headers.Authorization).toMatch(/^Bearer launch\./);
    await first.dispose();
    const authority = minted.mock.contexts[0] as TokenAuthority;
    expect(authority.verify(first.config.mcpServers["paseo-memorise"].headers.Authorization)).toBeNull();
    expect(authority.verify(second.config.mcpServers["paseo-memorise"].headers.Authorization)?.agentId).toBe("agent-1");
    expect(tokens.verify(`Bearer ${legacy}`)?.provider).toBe("claude");
  });

  it("does not let a limited agent in the same folder borrow another agent's receipt", async () => {
    const fake = start({ ...defaults, showInAgentChats: true });
    const cwd = tempDir("plugin-plain-");
    await fake.call("memory.save", { where: { directory: cwd }, scope: "repo", type: "howto", subject: "build", body: "Run make." });
    await fake.open({ provider: "claude", cwd }, {}, { agentId: "owner", launchId: "owner-launch" });
    await fake.open({ provider: "claude", cwd }, {}, { agentId: "limited", launchId: "limited-launch", openSupport: { ...fullSupport, instructions: "unsupported", mcpHttp: "unsupported" } });
    await fake.agentCreated("limited", cwd);
    await fake.agentCreated("owner", cwd);
    expect(fake.appended).toEqual([{ agentId: "owner", row: expect.objectContaining({ data: expect.objectContaining({ listed: 1 }) }) }]);
  });

  it("acts on the key a folder now goes by when the panel names one of its alias keys", async () => {
    const notes = await realpath(tempDir("plugin-alias-"));
    const info = statSync(notes, { bigint: true });
    const kept = folderKey(notes);
    const alias = `${kept}-2`;
    const same = { path: notes, ino: String(info.ino), born: String(info.birthtimeNs), root: false };
    await writeFile(join(root, "folders.json"), JSON.stringify({ version: 1, folders: [{ key: kept, dev: "1", ...same }, { key: alias, dev: "2", ...same }] }));
    const fake = start();
    await fake.call("memory.save", { where: { repoKey: alias }, scope: "repo", type: "howto", subject: "notes", body: "Notes are in notes.md." });
    expect((await fake.call("memory.list", { where: { repoKey: kept } })).facts.map((fact: { repoKey: string }) => fact.repoKey)).toEqual([kept]);
    expect((await fake.call("memory.list", { where: { repoKey: alias } })).repoKey).toBe(kept);
    await fake.call("memory.repo-prefs.set", { repoKey: alias, prefs: { capture: "off" } });
    expect((await fake.call("memory.repo-prefs.get", { repoKey: kept })).prefs.capture).toBe("off");
  });

  it("gives a new agent the index and both tool servers, keeping other plugins' servers", async () => {
    const fake = start();
    const cwd = await repoWithOrigin("git@github.com:acme/api.git");
    await fake.call("memory.save", { where: { directory: cwd }, scope: "global", type: "preference", subject: "commits", body: "Ask before running git commit." });
    const { config } = await fake.open({ provider: "claude", cwd, systemPrompt: "Be brief.", mcpServers: other });
    expect(config.systemPrompt).toMatch(/^Be brief\.\n\n<memorise>/);
    expect(config.systemPrompt).toContain("preference (global): commits: Ask before running git commit.");
    expect(Object.keys(config.mcpServers).sort()).toEqual(["excalidraw", "paseo-memorise", "paseo-memorise-write"]);
    expect(config.mcpServers["paseo-memorise"].headers.Authorization).toMatch(/^Bearer /);
  });

  it("scopes independent opens to their actual provider and project without saving contributions", async () => {
    const fake = start();
    const parentCwd = await repoWithOrigin("git@github.com:acme/api.git");
    const childCwd = await repoWithOrigin("git@github.com:acme/web.git");
    const minted = vi.spyOn(TokenAuthority.prototype, "mintLaunch");
    const base = { provider: "my-codex", cwd: parentCwd, mcpServers: other };
    const parent = (await fake.open(base)).config;
    const child = (await fake.open({ provider: "my-opencode", cwd: childCwd }, {}, { agentId: "child-1", launchId: "child-launch" })).config;
    expect(child.systemPrompt.match(/<memorise>/g)).toHaveLength(1);
    expect(child.systemPrompt).toContain("github.com/acme/web");
    expect(child.mcpServers["paseo-memorise"].headers.Authorization).not.toBe(parent.mcpServers["paseo-memorise"].headers.Authorization);
    expect(base).toEqual({ provider: "my-codex", cwd: parentCwd, mcpServers: other });
    const tokens = minted.mock.contexts[0] as TokenAuthority;
    expect(tokens.verify(parent.mcpServers["paseo-memorise"].headers.Authorization)?.provider).toBe("my-codex");
    expect(tokens.verify(child.mcpServers["paseo-memorise"].headers.Authorization)?.provider).toBe("my-opencode");
  });

  it("adds nothing while Off and preserves saved caller endpoints, prompt and policy", async () => {
    const cwd = await repoWithOrigin("git@github.com:acme/api.git");
    const fake = start({ ...defaults, enabled: false });
    const saved = { provider: "claude", cwd, systemPrompt: "Own.\n\n<memorise>saved</memorise>", mcpServers: { "paseo-memorise": { type: "http", url: "http://caller.invalid/mcp" } }, toolPolicy: { preapproved: [{ kind: "mcp", server: "paseo-memorise", tool: "caller_tool" }] } };
    const opened = await fake.open(saved);
    expect(opened.config).toEqual(saved);
    expect(opened.request.toolPolicy).toBeUndefined();
  });

  it("adds no notes, endpoints or grants for a fresh opening with memory Off", async () => {
    const fake = start({ ...defaults, enabled: false });
    const opened = await fake.open({ provider: "claude", cwd: tempDir("plugin-plain-"), systemPrompt: "Own.", mcpServers: other });
    expect(opened.config.systemPrompt).toBe("Own.");
    expect(opened.request.mcpServers).toEqual({});
    expect(opened.request.toolPolicy).toBeUndefined();
  });

  it("leaves ordinary permission requests unanswered, including named reads and writes", async () => {
    const fake = start();
    await fake.permission({ id: "r1", name: "mcp__paseo-memorise__memory_search" });
    await fake.permission({ id: "r2", name: "CodexMcpElicitation", metadata: { serverName: "paseo-memorise" } });
    await fake.permission({ id: "w1", name: "mcp__paseo-memorise-write__memory_write" });
    await fake.permission({ id: "w2", name: "CodexMcpElicitation", metadata: { serverName: "paseo-memorise-write" } });
    // A user's own server that happens to use the old, generic name is never approved.
    await fake.permission({ id: "u1", name: "mcp__memorise__delete_everything" });
    await fake.permission({ id: "u2", name: "CodexMcpElicitation", metadata: { serverName: "memorise" } });
    // Exact read grants never authorize another tool under the read server's name.
    await fake.permission({ id: "r3", name: "mcp__paseo-memorise__memory_read" });
    await fake.permission({ id: "f1", name: "mcp__paseo-memorise__delete_everything" });
    await fake.permission({ id: "f2", name: "mcp__paseo-memorise__memory_read_all" });
    expect(fake.respondToPermission).not.toHaveBeenCalled();
  });

  it("approves no read where Memorise gives agents no tools: memory off, the project off, or another provider", async () => {
    const read = { id: "r1", name: "mcp__paseo-memorise__memory_read" };
    const off = start({ ...defaults, enabled: false });
    await off.permission(read);
    expect(off.respondToPermission).not.toHaveBeenCalled();
    await cleanup();
    const fake = start();
    await fake.permission(read, "/tmp", "gemini");
    const cwd = await repoWithOrigin("git@github.com:acme/api.git");
    await fake.call("memory.repo-prefs.set", { repoKey: "github.com/acme/api", prefs: { enabled: false, includeGlobal: true, capture: "default", autoApprove: false } });
    await fake.permission(read, cwd);
    expect(fake.respondToPermission).not.toHaveBeenCalled();
    await fake.call("memory.repo-prefs.set", { repoKey: "github.com/acme/api", prefs: { enabled: true, includeGlobal: true, capture: "default", autoApprove: false } });
    await fake.permission(read, cwd);
    expect(fake.respondToPermission).not.toHaveBeenCalled();
  });

  it("asks for every read when automatic read approval is off", async () => {
    const fake = start({ ...defaults, autoApproveReads: false });
    await fake.permission({ id: "r1", name: "mcp__paseo-memorise__memory_read" });
    expect(fake.respondToPermission).not.toHaveBeenCalled();
  });

  it("keeps a folder outside git as its own project, for agents and the app, and refuses a secret-shaped memory", async () => {
    const fake = start();
    const plain = tempDir("plain-");
    const { fact } = await fake.call("memory.save", { where: { directory: plain }, scope: "repo", type: "howto", subject: "notes", body: "Drafts live in drafts/." });
    expect(fact.repoKey).toMatch(/^folder\/plain-/);
    const errors = vi.spyOn(console, "error");
    const { config } = await fake.open({ provider: "claude", cwd: plain });
    // No git history to diff, so changed files are not asked for (and no error is logged).
    expect(errors.mock.calls.flat().join("\n")).not.toMatch(/changed files/);
    errors.mockRestore();
    expect(config.systemPrompt).toContain("notes: Drafts live in drafts/.");
    expect(Object.keys(config.mcpServers)).toEqual(["paseo-memorise", "paseo-memorise-write"]);
    // A workspace's project folder outside git is a project root, so an agent in a subfolder gets the
    // same memories.
    fake.workspaces.push({ projectRootPath: plain, projectKind: "non_git" });
    await fake.workspaceCreated(plain);
    const sub = join(plain, "drafts");
    await mkdir(sub);
    await vi.waitFor(async () => expect((await fake.open({ provider: "claude", cwd: sub })).config.systemPrompt).toContain("notes: Drafts live in drafts/."));
    await expect(fake.call("memory.save", { where: { directory: plain }, scope: "global", type: "howto", subject: "x", body: "token: ghp_abcdefghijklmnopqrstuvwxyz0123456789" })).rejects.toThrow(/GitHub token/);
  });

  it("still opens the agent, with the problem named, when settings cannot be read", async () => {
    const fake = fakeServer(defaults, async () => {
      throw new Error("settings store offline");
    });
    cleanup = contributeMemory(fake.server, async () => root) as () => unknown;
    const cwd = await repoWithOrigin("git@github.com:acme/api.git");
    const { config } = await fake.open({ provider: "codex", cwd, systemPrompt: "Own.", mcpServers: other });
    expect(config.systemPrompt).toMatch(/Memory problem: memory could not be loaded \(Error: settings store offline\)/);
    expect(Object.keys(config.mcpServers)).toEqual(["excalidraw"]);
  });

  it("restores a retired memory through the app", async () => {
    const fake = start();
    const cwd = await repoWithOrigin("git@github.com:acme/api.git");
    const { fact } = await fake.call("memory.save", { where: { directory: cwd }, scope: "repo", type: "howto", subject: "build", body: "Run make build." });
    await fake.call("memory.retire", { where: { directory: cwd }, id: fact.id });
    expect((await fake.call("memory.restore", { where: { directory: cwd }, id: fact.id })).fact.status).toBe("active");
  });

  it("gives the plugin's own workers no memory, and denies their permission requests", async () => {
    const fake = start();
    const cwd = await repoWithOrigin("git@github.com:acme/api.git");
    await fake.call("memory.save", { where: { directory: cwd }, scope: "global", type: "preference", subject: "commits", body: "Ask before committing." });
    const byMarker = (await fake.open({ provider: "codex", cwd, systemPrompt: "Extract facts.", mcpServers: other }, { MEMORISE_ROLE: "worker" })).config;
    expect(byMarker.systemPrompt).toBe("Extract facts.");
    expect(Object.keys(byMarker.mcpServers)).toEqual(["excalidraw"]);
    const byFolder = (await fake.open({ provider: "claude", cwd: join(root, "workers", "run-1"), systemPrompt: "Tidy." })).config;
    expect(byFolder.systemPrompt).toBe("Tidy.");
    await fake.permission({ id: "p1", name: "Bash" }, join(root, "workers", "run-1"));
    expect(fake.respondToPermission).toHaveBeenCalledWith({ requestId: "p1", response: { behavior: "deny", message: "Memory workers may not use tools." } });
  });

  it("pins only through the app, and pinned facts lead the index", async () => {
    const fake = start();
    const cwd = await repoWithOrigin("git@github.com:acme/api.git");
    const { fact: first } = await fake.call("memory.save", { where: { directory: cwd }, scope: "repo", type: "howto", subject: "first", body: "Older fact." });
    await fake.call("memory.save", { where: { directory: cwd }, scope: "repo", type: "howto", subject: "second", body: "Newer fact." });
    await fake.call("memory.pin", { where: { directory: cwd }, id: first.id, pinned: true });
    const { config } = await fake.open({ provider: "claude", cwd });
    const lines = config.systemPrompt.split("\n").filter((line: string) => line.startsWith("- ["));
    expect(lines[0]).toContain("(pinned): first");
    const listed = await fake.call("memory.list", { where: { directory: cwd } });
    expect(listed.facts.find((fact: { id: string }) => fact.id === first.id).usage.shown).toBe(1);
  });

  it("manages a repo's memories by repo key, without a workspace", async () => {
    const fake = start();
    const repo = { repoKey: "github.com/acme/api" };
    const { fact } = await fake.call("memory.save", { where: repo, scope: "repo", type: "howto", subject: "build", body: "Run make build.", paths: ["Makefile"], pinned: true });
    expect(fact).toMatchObject({ repoKey: "github.com/acme/api", paths: ["Makefile"], pinned: true, source: { by: "user" } });
    const { fact: edited } = await fake.call("memory.update", { where: repo, id: fact.id, subject: "build command", type: "gotcha", paths: ["Makefile", "scripts/**"] });
    expect(edited).toMatchObject({ subject: "build command", type: "gotcha", body: "Run make build.", paths: ["Makefile", "scripts/**"], supersedes: fact.id });
    const listed = await fake.call("memory.list", { where: repo });
    expect(listed.repoKey).toBe("github.com/acme/api");
    expect(listed.facts.filter((item: { superseded: boolean }) => !item.superseded).map((item: { id: string }) => item.id)).toEqual([edited.id]);
    expect((await fake.call("memory.history", { where: repo, id: fact.id })).versions.map((item: { id: string }) => item.id)).toEqual([edited.id, fact.id]);
  });

  it("treats a null repo key as global memory only", async () => {
    const fake = start();
    await fake.call("memory.save", { where: { repoKey: "github.com/acme/api" }, scope: "repo", type: "howto", subject: "repo", body: "Repo fact." });
    await fake.call("memory.save", { where: { repoKey: null }, scope: "global", type: "preference", subject: "global", body: "Global fact." });
    expect((await fake.call("memory.list", { where: { repoKey: null } })).facts.map((item: { body: string }) => item.body)).toEqual(["Global fact."]);
    await expect(fake.call("memory.save", { where: { repoKey: null }, scope: "repo", type: "howto", subject: "x", body: "y" })).rejects.toThrow(/save the memory as global/);
  });

  it("refuses an update that changes nothing", () => {
    const id = "01JB8Z6X3T5Q9V2M4N7P8R1S0W";
    expect(updateMemoryRpc.input.safeParse({ where: { repoKey: null }, id }).success).toBe(false);
    expect(updateMemoryRpc.input.safeParse({ where: { repoKey: null }, id, body: "new" }).success).toBe(true);
  });

  it("refuses an update whose new subject contains a secret", async () => {
    const fake = start();
    const repo = { repoKey: "github.com/acme/api" };
    const { fact } = await fake.call("memory.save", { where: repo, scope: "repo", type: "howto", subject: "token", body: "Where the token lives." });
    await expect(fake.call("memory.update", { where: repo, id: fact.id, subject: "ghp_abcdefghijklmnopqrstuvwxyz0123456789" })).rejects.toThrow(/Refused/);
  });

  it("reverts a memory to an older version and moves it between repo and global", async () => {
    const fake = start();
    const repo = { repoKey: "github.com/acme/api" };
    const { fact: v1 } = await fake.call("memory.save", { where: repo, scope: "repo", type: "howto", subject: "lint", body: "Run npm run lint." });
    const { fact: v2 } = await fake.call("memory.update", { where: repo, id: v1.id, body: "Run pnpm lint." });
    const { fact: v3 } = await fake.call("memory.revert", { where: repo, id: v2.id, versionId: v1.id });
    expect(v3).toMatchObject({ body: "Run npm run lint.", supersedes: v2.id });
    const { fact: global } = await fake.call("memory.move", { where: repo, id: v3.id, to: "global" });
    expect(global).toMatchObject({ scope: "global", repoKey: null, body: "Run npm run lint." });
    expect((await fake.call("memory.list", { where: { repoKey: "github.com/acme/web" } })).facts.map((item: { id: string }) => item.id)).toEqual([global.id]);
  });

  it("applies a bulk action and reports each memory's result", async () => {
    const fake = start();
    const repo = { repoKey: "github.com/acme/api" };
    const { fact: a } = await fake.call("memory.save", { where: repo, scope: "repo", type: "howto", subject: "a", body: "Fact a." });
    const { fact: b } = await fake.call("memory.save", { where: repo, scope: "repo", type: "howto", subject: "b", body: "Fact b." });
    const missing = "01JB8Z6X3T5Q9V2M4N7P8R1S0W";
    const { results } = await fake.call("memory.bulk", { where: repo, ids: [a.id, b.id, missing], action: "pin" });
    expect(results).toEqual([
      { id: a.id, ok: true },
      { id: b.id, ok: true },
      { id: missing, ok: false, error: `No memory with id ${missing} in this repo or in global memory` },
    ]);
    const pinned = (await fake.call("memory.list", { where: repo })).facts.filter((item: { pinned: boolean }) => item.pinned);
    expect(pinned.map((item: { id: string }) => item.id).sort()).toEqual([a.id, b.id].sort());
  });

  it("changes controls in place, and a content edit keeps them in the new version", async () => {
    const fake = start();
    const repo = { repoKey: "github.com/acme/api" };
    const { fact } = await fake.call("memory.save", { where: repo, scope: "repo", type: "howto", subject: "deploy", body: "Old steps." });
    const { fact: off } = await fake.call("memory.update", { where: repo, id: fact.id, enabled: false, activation: "title" });
    expect(off).toMatchObject({ id: fact.id, enabled: false, activation: "title" });
    const { fact: next } = await fake.call("memory.update", { where: repo, id: fact.id, body: "New steps.", until: "2027-01-01" });
    expect(next).toMatchObject({ supersedes: fact.id, body: "New steps.", enabled: false, activation: "title", until: "2027-01-01" });
  });

  it("keeps disabled and manual memories out of a new agent's index, and bulk-enables them", async () => {
    const fake = start();
    const cwd = await repoWithOrigin("git@github.com:acme/api.git");
    const where = { directory: cwd };
    await fake.call("memory.save", { where, scope: "repo", type: "howto", subject: "listed one", body: "Shown." });
    const { fact: off } = await fake.call("memory.save", { where, scope: "repo", type: "howto", subject: "disabled one", body: "Hidden.", enabled: false });
    const { fact: manual } = await fake.call("memory.save", { where, scope: "repo", type: "howto", subject: "manual one", body: "Search only.", activation: "manual" });
    const listedSubjects = async () => (await fake.open({ provider: "claude", cwd })).config.systemPrompt.split("\n").filter((line: string) => line.startsWith("- ["));
    const before = (await listedSubjects()).join("\n");
    expect(before).toContain("listed one");
    expect(before).not.toContain("disabled one");
    expect(before).not.toContain("manual one");
    expect((await fake.call("memory.bulk", { where, ids: [off.id], action: "enable" })).results).toEqual([{ id: off.id, ok: true }]);
    expect((await listedSubjects()).join("\n")).toContain("disabled one");
    expect((await fake.call("memory.bulk", { where, ids: [off.id, manual.id], action: "disable" })).results.every((result: { ok: boolean }) => result.ok)).toBe(true);
    expect((await fake.call("memory.list", { where })).facts.filter((item: { enabled: boolean }) => !item.enabled)).toHaveLength(2);
  });

  it("previews exactly what a new agent gets, with why each memory is listed", async () => {
    const fake = start();
    const cwd = await repoWithOrigin("git@github.com:acme/api.git");
    const where = { directory: cwd };
    const { fact: pinned } = await fake.call("memory.save", { where, scope: "repo", type: "howto", subject: "lint", body: "Run pnpm lint.", pinned: true });
    const { fact: title } = await fake.call("memory.save", { where, scope: "repo", type: "howto", subject: "deploy", body: "Long steps.", activation: "title" });
    const { fact: global } = await fake.call("memory.save", { where, scope: "global", type: "preference", subject: "commits", body: "Small commits." });
    const preview = await fake.call("memory.preview", { directory: cwd });
    expect(preview).toMatchObject({ repoKey: "github.com/acme/api", off: false, maxLines: 150, maxBytes: 8192 });
    expect(preview.listed).toEqual([
      { id: pinned.id, subject: "lint", reason: "pinned", titleOnly: false },
      { id: global.id, subject: "commits", reason: "global", titleOnly: false },
      { id: title.id, subject: "deploy", reason: "repo", titleOnly: true },
    ]);
    const { config } = await fake.open({ provider: "claude", cwd });
    expect(config.systemPrompt).toContain(preview.text);
    expect(preview.bytes).toBe(Buffer.byteLength(preview.text));
  });

  it("turns memory off for one repo, and can keep a repo apart from global memories", async () => {
    const fake = start();
    const cwd = await repoWithOrigin("git@github.com:acme/api.git");
    const repoKey = "github.com/acme/api";
    await fake.call("memory.save", { where: { directory: cwd }, scope: "repo", type: "howto", subject: "repo fact", body: "Repo only." });
    await fake.call("memory.save", { where: { directory: cwd }, scope: "global", type: "preference", subject: "global fact", body: "Everywhere." });
    expect((await fake.call("memory.repo-prefs.get", { repoKey })).prefs).toEqual({ enabled: true, includeGlobal: true, capture: "default", autoApprove: false });
    await fake.call("memory.repo-prefs.set", { repoKey, prefs: { enabled: false, includeGlobal: true, capture: "default" } });
    const off = (await fake.open({ provider: "claude", cwd, systemPrompt: "Own.", mcpServers: other })).config;
    expect(off.systemPrompt).toBe("Own.");
    expect(Object.keys(off.mcpServers)).toEqual(["excalidraw"]);
    expect((await fake.call("memory.preview", { directory: cwd })).off).toBe(true);
    await fake.call("memory.repo-prefs.set", { repoKey, prefs: { enabled: true, includeGlobal: false, capture: "default" } });
    const apart = (await fake.open({ provider: "claude", cwd })).config.systemPrompt;
    expect(apart).toContain("repo fact");
    expect(apart).not.toContain("global fact");
  });

  it("exports a repo's memories and imports them into another repo once, with a dry run first", async () => {
    const fake = start();
    const api = { repoKey: "github.com/acme/api" };
    const web = { repoKey: "github.com/acme/web" };
    await fake.call("memory.save", { where: api, scope: "repo", type: "howto", subject: "build", body: "Run make build.", paths: ["Makefile"] });
    await fake.call("memory.save", { where: api, scope: "repo", type: "gotcha", subject: "docker", body: "Tests need DOCKER_HOST." });
    await fake.call("memory.save", { where: api, scope: "global", type: "preference", subject: "style", body: "Small commits." });
    const exported = await fake.call("memory.export", { where: api, format: "json" });
    expect(exported.count).toBe(2);
    const dry = await fake.call("memory.import", { where: web, scope: "repo", text: exported.text, dryRun: true });
    // Both were saved in the same moment, so the test checks which were added, not their order.
    expect(dry.added.map((entry: { subject: string }) => entry.subject).sort()).toEqual(["build", "docker"]);
    expect((await fake.call("memory.list", { where: web })).facts.filter((item: { scope: string }) => item.scope === "repo")).toEqual([]);
    await fake.call("memory.import", { where: web, scope: "repo", text: exported.text, dryRun: false });
    const imported = (await fake.call("memory.list", { where: web })).facts.filter((item: { scope: string }) => item.scope === "repo");
    expect(imported.map((item: { subject: string; paths: string[]; source: { by: string } }) => [item.subject, item.paths, item.source.by]).sort()).toEqual([
      ["build", ["Makefile"], "user"],
      ["docker", [], "user"],
    ]);
    const again = await fake.call("memory.import", { where: web, scope: "repo", text: exported.text, dryRun: false });
    expect(again.added).toEqual([]);
    expect(again.skipped.map((entry: { reason: string }) => entry.reason)).toEqual(["already saved", "already saved"]);
  });

  it("applies the memory length setting to saves and skips longer entries in an import", async () => {
    const fake = start();
    const api = { repoKey: "github.com/acme/api" };
    await expect(fake.call("memory.save", { where: api, scope: "repo", type: "howto", subject: "long", body: "x".repeat(1_200) })).rejects.toThrow("Memory must be 1,000 characters or less; this one has 1,200");
    const text = JSON.stringify([{ type: "howto", subject: "short", body: "Run make." }, { type: "howto", subject: "long", body: "x".repeat(1_200) }]);
    const dry = await fake.call("memory.import", { where: api, scope: "repo", text, dryRun: true });
    expect(dry.added.map((entry: { subject: string }) => entry.subject)).toEqual(["short"]);
    expect(dry.skipped).toEqual([{ line: "long", reason: "longer than 1,000 characters" }]);
    const roomy = start({ ...defaults, memoryMaxChars: 5_000 });
    expect((await roomy.call("memory.save", { where: api, scope: "repo", type: "howto", subject: "long", body: "x".repeat(1_200) })).fact.body).toHaveLength(1_200);
  });

  it("lists, approves, and rejects a repo's proposals by repo key, and starts a tidy by repo key", async () => {
    const fake = start();
    const repo = { repoKey: "github.com/acme/api" };
    const source = { from: "capture" as const, agentId: "agent-1", provider: "claude", model: null };
    const base = { repoKey: "github.com/acme/api", kind: "new" as const, targets: [], type: "howto" as const, paths: [], reason: "", source };
    await new ProposalStore(root).add([{ ...base, subject: "keep", body: "Keep this." }, { ...base, subject: "drop", body: "Drop this." }], []);
    const listed = (await fake.call("memory.proposals.list", { where: repo })).proposals;
    expect(listed.map((proposal: { subject: string }) => proposal.subject).sort()).toEqual(["drop", "keep"]);
    const id = (subject: string) => listed.find((proposal: { subject: string }) => proposal.subject === subject).id;
    await fake.call("memory.proposals.approve", { where: repo, id: id("keep") });
    await fake.call("memory.proposals.reject", { where: repo, id: id("drop") });
    expect((await fake.call("memory.proposals.list", { where: repo })).proposals).toEqual([]);
    expect((await fake.call("memory.list", { where: repo })).facts.map((fact: { subject: string }) => fact.subject)).toEqual(["keep"]);
    // One memory is not enough to tidy, and the caller is told so instead of a tidy that does nothing.
    await expect(fake.call("memory.tidy", { where: repo })).rejects.toThrow(/at least 2 memories/);
  });

  it("lets the app choose a custom type the user listed, and no other", async () => {
    const fake = start({ ...defaults, customTypes: ["eval-trap"] });
    const repo = { repoKey: "github.com/acme/api" };
    expect(await fake.call("memory.types", {})).toEqual({ types: ["preference", "decision", "gotcha", "howto", "reference", "eval-trap"] });
    const { fact } = await fake.call("memory.save", { where: repo, scope: "repo", type: "eval-trap", subject: "local eval", body: "Local eval needs --local-images." });
    expect(fact.type).toBe("eval-trap");
    await expect(fake.call("memory.save", { where: repo, scope: "repo", type: "runbook", subject: "deploys", body: "Deploys go through make release." })).rejects.toThrow('Type "runbook" is not one of: preference, decision, gotcha, howto, reference, eval-trap.');
    await expect(fake.call("memory.update", { where: repo, id: fact.id, type: "runbook" })).rejects.toThrow('Type "runbook" is not one of');
    expect((await fake.call("memory.update", { where: repo, id: fact.id, type: "gotcha" })).fact.type).toBe("gotcha");
    const imported = await fake.call("memory.import", { where: repo, scope: "repo", dryRun: false, text: JSON.stringify([{ type: "eval-trap", body: "Eval images live in fixtures." }, { type: "runbook", body: "Rotate keys monthly." }]) });
    expect(imported.added).toEqual([{ type: "eval-trap", subject: "Eval images live in fixtures." }]);
    expect(imported.skipped).toEqual([expect.objectContaining({ reason: expect.stringContaining('Type "runbook" is not one of') })]);
  });

  it("keeps a memory whose type left the list usable: listed, edited, reverted, moved, and a waiting suggestion approved", async () => {
    const fake = start();
    const repo = { repoKey: "github.com/acme/api" };
    const source = { by: "user" as const, provider: null, branch: null, commit: null };
    const v1 = await new MemoryStore(root).create({ scope: "repo", repoKey: repo.repoKey, type: "eval-trap", subject: "local eval", body: "Local eval needs --local-images.", supersedes: null, source, citations: [] });
    expect((await fake.call("memory.list", { where: repo })).facts.map((fact: { type: string }) => fact.type)).toEqual(["eval-trap"]);
    const { fact: v2 } = await fake.call("memory.update", { where: repo, id: v1.id, body: "Local eval needs --local-images DIR.", type: "eval-trap" });
    expect(v2).toMatchObject({ type: "eval-trap", body: "Local eval needs --local-images DIR." });
    const { fact: v3 } = await fake.call("memory.revert", { where: repo, id: v2.id, versionId: v1.id });
    expect(v3.type).toBe("eval-trap");
    expect((await fake.call("memory.move", { where: repo, id: v3.id, to: "global" })).fact.type).toBe("eval-trap");
    await expect(fake.call("memory.save", { where: repo, scope: "repo", type: "eval-trap", subject: "another", body: "Another one." })).rejects.toThrow('Type "eval-trap" is not one of');
    await new ProposalStore(root).add([{ repoKey: repo.repoKey, kind: "new", targets: [], type: "eval-trap", subject: "suggested", body: "Suggested while the type was listed.", paths: [], reason: "", source: { from: "capture", agentId: "agent-1", provider: "claude", model: null } }], []);
    const [proposal] = (await fake.call("memory.proposals.list", { where: repo })).proposals;
    await fake.call("memory.proposals.approve", { where: repo, id: proposal.id });
    expect((await fake.call("memory.list", { where: repo })).facts.find((fact: { subject: string }) => fact.subject === "suggested").type).toBe("eval-trap");
  });

  it("counts pending proposals per repo", async () => {
    const fake = start();
    const source = { from: "capture" as const, agentId: null, provider: "claude", model: null };
    const proposal = (repoKey: string, subject: string) => ({ repoKey, kind: "new" as const, targets: [], type: "howto" as const, subject, body: `${subject} body.`, paths: [], reason: "", source });
    const store = new ProposalStore(root);
    await store.add([proposal("github.com/acme/api", "a")], []);
    await store.add([proposal("github.com/acme/web", "b"), proposal("github.com/acme/web", "c")], []);
    // A proposal file that cannot be read is skipped by the list, so it is not counted either.
    await mkdir(join(root, "proposals", "github.com", "acme", "docs"), { recursive: true });
    await writeFile(join(root, "proposals", "github.com", "acme", "docs", "broken.json"), "{");
    expect((await fake.call("memory.proposals.summary", {})).repos).toEqual([
      { repoKey: "github.com/acme/api", pending: 1 },
      { repoKey: "github.com/acme/web", pending: 2 },
    ]);
  });

  it("scans a project by repo key through an open workspace of it, and says what to do without one", async () => {
    const fake = start();
    const where = { repoKey: "github.com/acme/api" };
    await expect(fake.call("memory.project.scan", { where, mode: "create" })).rejects.toThrow(/Open a workspace of github.com\/acme\/api/);
    const other = await repoWithOrigin("git@github.com:acme/web.git");
    const cwd = await repoWithOrigin("git@github.com:acme/api.git");
    for (const folder of [other, cwd]) await writeFile(join(folder, "README.md"), "Run make dev.\n");
    // The repo's workspace is on the second page.
    fake.workspaces.push({ projectRootPath: other }, { workspaceDirectory: cwd, projectRootPath: cwd });
    expect(await fake.call("memory.project.scan", { where, mode: "create" })).toEqual({ started: true, folder: cwd });
    // A scan by folder needs no open workspace; a different repo, so it does not wait on the first.
    expect(await fake.call("memory.project.scan", { where: { directory: other }, mode: "refresh" })).toEqual({ started: true, folder: other });
    // The fake Paseo cannot start a worker, so each scan fails, and the inbox is told why.
    for (const scanned of [where, { repoKey: "github.com/acme/web" }]) {
      await vi.waitFor(async () => expect((await fake.call("memory.proposals.list", { where: scanned })).lastRun).toMatchObject({ kind: "scan", state: "failed" }));
    }
  });

  it("gives the very first agent in a subfolder of a Paseo project outside git that project's memories", async () => {
    const fake = start();
    const site = tempDir("plugin-site-");
    fake.workspaces.push({ projectRootPath: site, projectKind: "non_git" });
    await fake.call("memory.save", { where: { directory: site }, scope: "repo", type: "howto", subject: "deploy", body: "Upload with rsync." });
    const blog = join(site, "blog");
    await mkdir(blog);
    expect((await fake.open({ provider: "claude", cwd: blog })).config.systemPrompt).toContain("deploy: Upload with rsync.");
  });

  it("shows each agent a receipt of the memories it was given, updated as it uses them", async () => {
    const fake = start({ ...defaults, showInAgentChats: true });
    const cwd = await repoWithOrigin("git@github.com:acme/api.git");
    const where = { repoKey: "github.com/acme/api" };
    for (const subject of ["one", "two"]) await fake.call("memory.save", { where, scope: "repo", type: "howto", subject, body: `${subject} body.` });
    await fake.open({ provider: "claude", cwd }, {}, { agentId: "agent-9" });
    // An agent Memorise did not prepare (another folder) gets no receipt.
    await fake.agentCreated("agent-8", tempDir("plugin-plain-"));
    const read = { type: "tool_call", callId: "c1", name: "mcp__paseo-memorise__memory_read", detail: { type: "unknown" }, status: "completed", error: null };
    // What is in the timeline before the agent is created is not its use.
    fake.addToTimeline("agent-9", [{ ...read, callId: "c0" }]);
    await fake.agentCreated("agent-9", cwd);
    expect(fake.appended).toEqual([{ agentId: "agent-9", row: { type: "plugin", id: expect.stringMatching(/^memorise-receipt:/), kind: "memorise-receipt", version: 1, data: { listed: 2, opened: 0, searched: 0, saved: 0, archived: 0, other: 0 } } }]);
    await fake.turnEnded("agent-9", cwd, [read, { ...read, callId: "c2" }]);
    await fake.turnEnded("agent-9", cwd, [{ type: "assistant_message", text: "done" }]);
    expect(fake.appended).toHaveLength(2);
    expect(fake.appended[1].row.data).toEqual({ listed: 2, opened: 2, searched: 0, saved: 0, archived: 0, other: 0 });
    // A new row each time: Paseo stretches a replaced row across every reply in between, and refuses
    // to fork from those replies.
    expect(fake.appended[1].row.id).toMatch(/^memorise-receipt:/);
    expect(fake.appended[1].row.id).not.toBe(fake.appended[0].row.id);
  });

  it("adds no receipt with the default settings", async () => {
    const fake = start();
    const cwd = await repoWithOrigin("git@github.com:acme/api.git");
    await fake.open({ provider: "claude", cwd });
    await fake.agentCreated("agent-1", cwd);
    await fake.turnEnded("agent-1", cwd, [{ type: "tool_call", callId: "c1", name: "memory_read", detail: {}, status: "completed", error: null }]);
    expect(fake.appended).toEqual([]);
  });

  it("stops updating an agent's receipt once the setting is turned off", async () => {
    let values: MemorySettings = { ...defaults, showInAgentChats: true };
    const fake = fakeServer(defaults, async () => ({ status: "ready", revision: "1", values }));
    cleanup = contributeMemory(fake.server, async () => root) as () => unknown;
    const cwd = await repoWithOrigin("git@github.com:acme/api.git");
    await fake.open({ provider: "claude", cwd });
    await fake.agentCreated("agent-1", cwd);
    expect(fake.appended).toHaveLength(1);
    values = { ...values, showInAgentChats: false };
    await fake.turnEnded("agent-1", cwd, [{ type: "tool_call", callId: "c1", name: "mcp__paseo-memorise__memory_read", detail: { type: "unknown" }, status: "completed", error: null }]);
    expect(fake.appended).toHaveLength(1);
  });

  it("lists a folder memory meant for matching files once a matching file changed this week", async () => {
    const fake = start();
    const plain = tempDir("plugin-plain-");
    const where = { directory: plain };
    await fake.call("memory.save", { where, scope: "repo", type: "howto", subject: "drafts", body: "Drafts use the template.", paths: ["drafts/**"], activation: "files" });
    const listed = async () => (await fake.open({ provider: "claude", cwd: plain })).config.systemPrompt as string;
    expect(await listed()).not.toContain("Drafts use the template.");
    await mkdir(join(plain, "drafts"));
    await writeFile(join(plain, "drafts", "trip.md"), "Day one.\n");
    expect(await listed()).toContain("Drafts use the template.");
  });

  it("scans a new workspace's project when automatic scans are on, and the inbox says how it went", async () => {
    const fake = start({ ...defaults, projectAutoScan: "once" });
    const cwd = tempDir("plugin-plain-");
    await writeFile(join(cwd, "README.md"), "Notes.\n");
    // The hook returns before the scan finishes, which takes longer than Paseo waits for a hook.
    await fake.workspaceCreated(cwd);
    // The fake Paseo cannot start a worker, so the scan that started fails, and the inbox is told.
    await vi.waitFor(async () => expect((await fake.call("memory.proposals.list", { where: { directory: cwd } })).lastRun).toMatchObject({ kind: "scan", state: "failed" }));
  });

  it("searches a repo's memories by repo key and lists every repo with counts", async () => {
    const fake = start();
    const repo = { repoKey: "github.com/acme/api" };
    const { fact } = await fake.call("memory.save", { where: repo, scope: "repo", type: "gotcha", subject: "docker", body: "Integration tests need DOCKER_HOST set." });
    await fake.call("memory.save", { where: repo, scope: "repo", type: "howto", subject: "build", body: "Run make build." });
    await fake.call("memory.save", { where: { repoKey: null }, scope: "global", type: "preference", subject: "style", body: "Prefer small commits." });
    expect((await fake.call("memory.search", { where: repo, query: "docker" })).ids).toEqual([fact.id]);
    const { repos } = await fake.call("memory.repos", {});
    expect(repos.map(({ repoKey, active }: { repoKey: string | null; active: number }) => ({ repoKey, active }))).toEqual([
      { repoKey: null, active: 1 },
      { repoKey: "github.com/acme/api", active: 2 },
    ]);
  });

  it("lists repos with an open workspace or only proposals beside those with memories, each once", async () => {
    const fake = start();
    await fake.call("memory.save", { where: { repoKey: "github.com/acme/api" }, scope: "repo", type: "howto", subject: "build", body: "Run make build." });
    const api = await repoWithOrigin("git@github.com:acme/api.git");
    const web = await repoWithOrigin("git@github.com:acme/web.git");
    const notGit = tempDir("plugin-plain-");
    // One workspace per page in the fake, so the web workspace is on the fourth page.
    // The plugin's own worker folders are never listed as projects.
    const worker = join(root, "workers", "w1");
    await mkdir(worker, { recursive: true });
    fake.workspaces.push({ workspaceDirectory: api, projectRootPath: api }, { projectRootPath: notGit }, { projectRootPath: worker }, { projectRootPath: web });
    const source = { from: "capture" as const, agentId: null, provider: "claude", model: null };
    await new ProposalStore(root).add([{ repoKey: "github.com/acme/docs", kind: "new", targets: [], type: "howto", subject: "docs", body: "Docs build with mkdocs.", paths: [], reason: "", source }], []);
    const { repos } = await fake.call("memory.repos", {});
    expect(repos).toEqual([
      { repoKey: null, active: 0, retired: 0, lastModified: null, label: null },
      // A workspace folder outside git is a project of its own, shown by its folder's name.
      { repoKey: expect.stringMatching(/^folder\/plugin-plain-/), active: 0, retired: 0, lastModified: null, label: basename(notGit) },
      { repoKey: "github.com/acme/api", active: 1, retired: 0, lastModified: expect.any(String), label: null },
      { repoKey: "github.com/acme/docs", active: 0, retired: 0, lastModified: null, label: null },
      { repoKey: "github.com/acme/web", active: 0, retired: 0, lastModified: null, label: null },
    ]);
  });
});

describe("memories and suggestions under a folder's alias keys", () => {
  it("move to the key the folder now goes by, keeping the old files and copying no duplicate suggestion", async () => {
    const root = tempDir("alias-");
    const notes = join(tempDir("alias-folders-"), "notes");
    await mkdir(notes);
    const info = statSync(notes, { bigint: true });
    const kept = folderKey(await realpath(notes));
    const alias = `${kept}-2`;
    const same = { path: await realpath(notes), ino: String(info.ino), born: String(info.birthtimeNs), root: true };
    await writeFile(join(root, "folders.json"), JSON.stringify({ version: 1, folders: [{ key: kept, dev: "1", ...same }, { key: alias, dev: "2", ...same }] }));
    const store = new MemoryStore(root);
    const proposals = new ProposalStore(root);
    const keys = new ProjectKeys(root);
    const fact = { scope: "repo" as const, type: "howto" as const, subject: "deploy", supersedes: null, source: { by: "user" as const, provider: null, branch: null, commit: null }, citations: [] };
    const first = await store.create({ ...fact, repoKey: alias, body: "Deploy with make." });
    const current = await store.supersede(first.id, alias, { body: "Deploy with make deploy." });
    const source = { from: "capture" as const, agentId: "a", provider: "codex", model: null };
    const suggestion = { kind: "new" as const, targets: [], type: "howto" as const, paths: [], reason: "", source };
    await proposals.add([{ ...suggestion, repoKey: kept, subject: "tests", body: "Run make test." }], []);
    await proposals.add([{ ...suggestion, repoKey: alias, subject: "tests", body: "Run make test." }, { ...suggestion, repoKey: alias, subject: "lint", body: "Run make lint." }], []);

    await mergeAliasKeys(store, proposals, keys);
    await mergeAliasKeys(store, proposals, keys);

    const listed = (await store.list(kept)).filter((item) => item.scope === "repo");
    expect(listed.map((item) => [item.id, item.repoKey, item.superseded])).toEqual(expect.arrayContaining([[first.id, kept, true], [current.id, kept, false]]));
    expect((await store.history(current.id, kept)).map((version) => version.id)).toEqual([current.id, first.id]);
    expect((await store.list(alias)).filter((item) => item.scope === "repo")).toEqual([]);
    expect((await proposals.list(kept)).map((item) => [item.subject, item.repoKey])).toEqual([["tests", kept], ["lint", kept]]);
    expect(await proposals.list(alias)).toEqual([]);
    const aside = [...(await readdir(join(root, "repos", ...alias.split("/")))), ...(await readdir(join(root, "proposals", ...alias.split("/"))))];
    expect(aside.filter((name) => name.endsWith(".md.merged")).sort()).toEqual([`${first.id}.md.merged`, `${current.id}.md.merged`].sort());
    expect(aside.filter((name) => name.endsWith(".json.merged"))).toHaveLength(2);
    expect(aside).toHaveLength(4);
  });
});
