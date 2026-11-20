import { createHash, randomUUID } from "node:crypto";
import type { Server } from "node:http";
import type { PluginServerContext, PluginSessionOpenRequest } from "@getpaseo/plugin/server";
import {
  allowedTypes,
  approveProposalRpc,
  bodyLengthProblem,
  type BulkAction,
  getRepoPrefsRpc,
  bulkMemoryRpc,
  deleteMemoryRpc,
  exportMemoryRpc,
  importMemoryRpc,
  listMemoriesRpc,
  isFolderKey,
  listProposalsRpc,
  listReposRpc,
  listTypesRpc,
  MAX_BULK_IDS,
  memoryHistoryRpc,
  memorySettings,
  type MemorySettings,
  type MemoryType,
  moveMemoryRpc,
  pinMemoryRpc,
  previewMemoryRpc,
  proposalsSummaryRpc,
  RECEIPT_KIND,
  type Receipt,
  type RepoPrefsValue,
  rejectProposalRpc,
  restoreMemoryRpc,
  retireMemoryRpc,
  revertMemoryRpc,
  saveMemoryRpc,
  scanProjectRpc,
  searchMemoriesRpc,
  setRepoPrefsRpc,
  tidyMemoryRpc,
  typeProblem,
  updateMemoryRpc,
  type Where,
} from "../shared/memory";
import { Capture } from "./capture";
import { checkCitations } from "./citations";
import { buildMemorySection, INDEX_MAX_BYTES, SECTION_END, SECTION_START } from "./index-prompt";
import { MemoryMcp, mcpServerEntries, READ_SERVER, WRITE_SERVER } from "./mcp";
import { loadTokenSecret, TokenAuthority } from "./mcp-auth";
import { ProposalStore } from "./proposals";
import { memoryToolUse, Receipts } from "./receipts";
import type { PaseoApi } from "./paseo-types";
import { ProjectKeys, type Project } from "./project-keys";
import { RepoPrefs } from "./repo-prefs";
import { SearchIndex } from "./search-index";
import { assertNoSecret } from "./secrets";
import { MemoryStore } from "./store";
import { readTimelineSince, timelineEnd } from "./timeline";
import { formatExport, importKey, parseImport } from "./transfer";
import { UsageLog, usageOf } from "./usage";
import { isVisibleToAgents, orderForAgents, rankWithReasons } from "./visibility";
import { PathMatcher, recentFiles, workFiles } from "./work-files";
import { markProjectRoots, openRepoCheckouts } from "./workspaces";
import { isWorkerRequest } from "./workers";
import { Interop } from "./interop";

const CITATION_BUDGET_MS = 1_000;
const PATH_MATCH_BUDGET_MS = 500;
const BY_USER = { by: "user" as const, provider: null, branch: null, commit: null };

interface Runtime {
  root: string;
  store: MemoryStore;
  tokens: TokenAuthority;
  search: SearchIndex | null;
  usage: UsageLog;
  proposals: ProposalStore;
  repoPrefs: RepoPrefs;
  keys: ProjectKeys;
  receipts: Receipts;
  capture: Capture;
  stopInterop: () => void;
  port: number;
  mcpProblem: string | null;
  http: Server | null;
}

// Memories and suggestions saved under a folder's alias keys (one per device number the folder had,
// before 0.10.2) move to the key it now goes by, before anything else reads them. Memories go first,
// so a suggestion equal to one of them is not copied. A failure leaves the files where they were,
// to try again at the next start.
export async function mergeAliasKeys(store: MemoryStore, proposals: ProposalStore, keys: ProjectKeys): Promise<void> {
  const aliases = await keys.aliases().catch((error: unknown) => {
    console.error(`[memorise] folder key aliases could not be read: ${String(error)}`);
    return new Map<string, string>();
  });
  for (const [alias, kept] of aliases) {
    try {
      const memories = await store.mergeRepo(alias, kept);
      const suggestions = await proposals.mergeRepo(alias, kept, await store.list(kept));
      if (memories + suggestions > 0) console.log(`[memorise] moved ${memories} memories and ${suggestions} suggestions from ${alias} to ${kept}; the old files are kept with ".merged" added`);
    } catch (error) {
      console.error(`[memorise] could not move ${alias} into ${kept}: ${String(error)}`);
    }
  }
}

export function contributeMemory(server: PluginServerContext, resolveRoot: () => Promise<string>) {
  if (server.features?.adaptiveAgentFeatures !== true) throw new Error("Update the Paseo host to use Memorise adaptive agent features.");
  server.registerLegacyAgentConfig({ version: 1, selectors: [
    { id: "memory-read-server", group: "memory", label: "Memory read tools", kind: "mcp", name: READ_SERVER },
    { id: "memory-write-server", group: "memory", label: "Memory write tools", kind: "mcp", name: WRITE_SERVER },
    { id: "memory-instructions", group: "memory", label: "Saved memory notes and guidance", kind: "prompt-section", start: SECTION_START, end: SECTION_END },
  ] });
  const settings = server.registerSettings(memorySettings);

  async function currentSettings(): Promise<MemorySettings> {
    const state = await settings.read();
    if (state.status === "ready") return state.values;
    console.error(`[memorise] settings are invalid (${state.error}); using defaults until they are fixed`);
    return memorySettings.schema.parse({});
  }

  const currentTypes = async () => allowedTypes((await currentSettings()).customTypes);

  const runtime: Promise<Runtime> = (async () => {
    const root = await resolveRoot();
    const store = new MemoryStore(root, async () => (await currentSettings()).memoryMaxChars);
    const tokens = new TokenAuthority(await loadTokenSecret(root));
    // Search is one feature; a SQLite failure must not take the whole plugin down with it.
    let search: SearchIndex | null = null;
    let searchProblem: string | undefined;
    try {
      search = new SearchIndex(root);
    } catch (error) {
      searchProblem = String(error);
      console.error(`[memorise] the search index could not be opened (${searchProblem}); keyword search is off`);
    }
    const usage = new UsageLog(root);
    const proposals = new ProposalStore(root);
    const repoPrefs = new RepoPrefs(root);
    // A folder with memories or proposals of its own stays its own project under a later project root.
    const keys = new ProjectKeys(root, async (key) => (await store.list(key)).some((fact) => fact.scope === "repo") || (await proposals.list(key)).length > 0);
    await mergeAliasKeys(store, proposals, keys);
    const capture = new Capture({ root, store, proposals, usage, repoPrefs, keys, settings: currentSettings });
    capture.startWeeklyTidy(() => store.repoKeys());
    capture.startProjectScans();
    const stopInterop = new Interop({ root, store, proposals, keys }).start();
    const { mcpPort } = await currentSettings();
    const mcp = new MemoryMcp({
      store,
      tokens,
      search,
      searchProblem,
      usage,
      keys,
      expiryDays: async () => (await currentSettings()).expiryDays,
      includeGlobal: async (repoKey) => (await repoPrefs.get(repoKey)).includeGlobal,
      types: currentTypes,
    });
    const receipts = new Receipts(root);
    const base = { root, store, tokens, search, usage, proposals, repoPrefs, keys, receipts, capture, stopInterop, port: mcpPort };
    try {
      const http = await mcp.listen(mcpPort);
      console.log(`[memorise] store ${root}; MCP on 127.0.0.1:${mcpPort}`);
      return { ...base, mcpProblem: null, http };
    } catch (error) {
      // Agents keep their stored MCP address, so never silently move to another port.
      const problem = `the memory tool server could not listen on 127.0.0.1:${mcpPort} (${String(error)}); change the port in Settings > Plugins > Memorise and reload the plugin`;
      console.error(`[memorise] ${problem}`);
      return { ...base, mcpProblem: problem, http: null };
    }
  })();
  runtime.catch((error: unknown) => console.error(`[memorise] failed to start: ${String(error)}`));

  // What an opening agent in `cwd` gets, built the same way for the open hook and the preview. `off`
  // when the repo has memory turned off.
  async function prepareMemory(cwd: string, values: MemorySettings, delivery?: { toolsAvailable: boolean; problems: string[] }) {
    const { store, repoPrefs, keys, mcpProblem } = await runtime;
    const problems: string[] = [...(mcpProblem ? [mcpProblem] : []), ...(delivery?.problems ?? [])];
    const project = await keys.resolve(cwd).catch((error: unknown) => {
      problems.push(`repo memory is unavailable for this session (${String(error)})`);
      console.error(`[memorise] repo key for ${cwd} failed: ${String(error)}`);
      return null;
    });
    const repoKey = project?.key ?? null;
    const prefs = repoKey ? await repoPrefs.get(repoKey) : null;
    if (prefs && !prefs.enabled) return { off: true as const, repoKey };
    // In a repo, the files this checkout changed; in a folder outside git, which has no history, the
    // files changed in the last week. Both are relative to the project root, like a memory's paths.
    let changed: string[] = [];
    if (project && isFolderKey(project.key)) {
      const recent = await recentFiles(project.root);
      if (recent.cutShort) problems.push("the list of recently changed files was cut short (size or time limit); some memories about them may be listed lower");
      changed = recent.files;
    } else if (project) {
      changed = await workFiles(cwd).catch((error: unknown) => {
        console.error(`[memorise] changed files for ${cwd} unavailable: ${String(error)}`);
        return [];
      });
    }
    const paths = new PathMatcher(changed, PATH_MATCH_BUDGET_MS);
    const reachable = (await store.list(repoKey)).filter((fact) => (prefs?.includeGlobal ?? true) || fact.scope === "repo");
    const ranked = rankWithReasons(reachable.filter((fact) => isVisibleToAgents(fact, values.expiryDays)), paths);
    if (paths.skipped) problems.push("ranking by changed files was cut short (time budget); some memories about those files may be listed lower");
    const visible = ranked.map(({ fact }) => fact);
    const notes = project ? await checkCitations({ cwd, root: project.root }, visible.filter((fact) => fact.scope === "repo"), CITATION_BUDGET_MS) : new Map<string, string>();
    const section = buildMemorySection({ repoKey, facts: visible, notes, maxLines: values.indexMaxLines, toolsAvailable: mcpProblem === null && (delivery?.toolsAvailable ?? true), problems });
    return { off: false as const, repoKey, project, prefs, section, ranked };
  }

  // Project roots are recorded from Paseo's workspaces before the first agent's memory is prepared,
  // so an agent in a subfolder of a project outside git gets the project's memory from the start.
  let rootsKnown: Promise<void> | null = null;
  function projectRootsKnown(paseo: PaseoApi): Promise<void> {
    rootsKnown ??= runtime
      .then(({ root, keys }) => markProjectRoots(paseo, root, keys))
      .catch((error: unknown) => {
        rootsKnown = null;
        console.error(`[memorise] project roots could not be read from Paseo: ${error instanceof Error ? error.message : String(error)}`);
      });
    return rootsKnown;
  }

  const listedByAgent = new Map<string, { count: number; launchId: string }>();
  // Compatibility metadata only. The host's previous contribution and retention own reuse authority.
  const contributionSettings = new Map<string, { fingerprint: string; installed: boolean; hasBinding: boolean }>();
  function settingsFingerprint(request: PluginSessionOpenRequest, values: MemorySettings, project: Project | null, prefs: RepoPrefsValue | null): string {
    return createHash("sha256").update(JSON.stringify({
      agentId: request.agentId,
      provider: request.provider,
      cwd: request.cwd,
      project,
      settings: Object.fromEntries(Object.entries(values).sort(([a], [b]) => a.localeCompare(b))),
      prefs: prefs ? Object.fromEntries(Object.entries(prefs).sort(([a], [b]) => a.localeCompare(b))) : null,
      adapter: request.openSupport?.adapter,
      instructions: request.openSupport?.instructions === "supported",
      http: request.openSupport?.mcpHttp === "supported",
      exactApproval: request.openSupport?.exactMcpPreapproval === "supported",
      promptState: request.legacyConfigState?.selectors["memory-instructions"] ?? "unknown",
      occupied: Object.hasOwn(request.baseConfig?.mcpServers ?? {}, READ_SERVER) || Object.hasOwn(request.baseConfig?.mcpServers ?? {}, WRITE_SERVER),
    })).digest("hex");
  }
  // A new row per update, never a reused id: Paseo stretches a replaced row across every reply in
  // between and refuses to fork from those replies. Go back to one replaced row once Paseo's fork
  // check ignores plugin rows.
  const appendReceipt = (paseo: PaseoApi, agentId: string, receipt: Receipt) =>
    paseo.agents
      .ref(agentId)
      .timeline.append({ type: "plugin", id: `${RECEIPT_KIND}:${randomUUID()}`, kind: RECEIPT_KIND, version: 1, data: receipt })
      .catch((error: unknown) => console.error(`[memorise] could not show the memory receipt for agent ${agentId}: ${error instanceof Error ? error.message : String(error)}`));

  server.addHook("agent.open.before", async ({ request }, { paseo, launch }) => {
    if (request.purpose === "history") return;
    const base = request.baseConfig;
    if (!base || request.launchId !== launch.id) throw new Error("Update the Paseo host: Memorise requires projected agent configuration and a matching launch lifetime.");
    const occupied = Object.hasOwn(base.mcpServers ?? {}, READ_SERVER) || Object.hasOwn(base.mcpServers ?? {}, WRITE_SERVER);
    const fixed = request.openSupport?.restrictions.mcpConfiguration === "fixed";
    const previous = request.previousContribution;
    const prior = previous && contributionSettings.get(previous.launchId);
    const reuseFixedBinding = fixed && (Object.keys(previous?.mcpServers ?? {}).length > 0 || prior?.hasBinding === true);
    const instructions = request.openSupport?.instructions === "supported";
    const promptState = request.legacyConfigState?.selectors["memory-instructions"];
    const appendNotes = !occupied && instructions && promptState === "absent";
    const http = request.openSupport?.mcpHttp === "supported" && request.openSupport.restrictions.mcpConfiguration === "mutable";
    const deliveryProblems = http ? [] : ["memory tools are not available for this opening"];
    let active: Runtime;
    let values: MemorySettings;
    let prepared: Awaited<ReturnType<typeof prepareMemory>>;
    const rememberSettings = (fingerprint: string, hasBinding: boolean) => {
      const entry = { fingerprint, hasBinding, installed: false };
      contributionSettings.set(launch.id, entry);
      launch.onInstalled(() => { entry.installed = true; });
      launch.onDispose(() => { contributionSettings.delete(launch.id); });
    };
    try {
      active = await runtime;
      const { root, capture } = active;
      capture.remember(paseo);
      if (request.openSupport) capture.observeProvider(request.agentId, request.provider, request.openSupport.adapter);
      if (isWorkerRequest(root, request.cwd, request.env)) return;
      if (reuseFixedBinding) {
        const state = await settings.read();
        if (!previous || !prior?.installed || !prior.hasBinding || state.status !== "ready" || !state.values.enabled || occupied) throw new Error("No compatible installed memory contribution");
        await projectRootsKnown(paseo);
        const project = await active.keys.resolve(request.cwd);
        const prefs = await active.repoPrefs.get(project.key);
        const fingerprint = settingsFingerprint(request, state.values, project, prefs);
        if (!prefs.enabled || fingerprint !== prior.fingerprint || active.mcpProblem !== null || launch.signal.aborted) throw new Error("Memory settings, scope or feature eligibility changed");
        const retained = launch.retainPrevious();
        rememberSettings(fingerprint, true);
        console.log(`[memorise] agent ${request.agentId} provider ${request.provider}: reusing retained memory contribution for fixed MCP configuration`);
        return {
          ...request,
          mcpServers: { ...retained.mcpServers },
          appendSystemPrompt: retained.appendSystemPrompt ? [...(request.appendSystemPrompt ?? []), ...retained.appendSystemPrompt] : request.appendSystemPrompt,
          toolPolicy: retained.toolPolicy,
          providerOptions: retained.providerOptions,
          env: { ...retained.env, ...request.env },
        };
      }
      // Saved names suppress the whole dependent group; they confer no credential or approval ownership.
      if (occupied) {
        console.log(`[memorise] agent ${request.agentId} provider ${request.provider}: memory uses saved configuration; adopt it explicitly before adaptive replacement`);
        return;
      }
      if (promptState !== "absent") console.log(`[memorise] agent ${request.agentId} provider ${request.provider}: saved memory instructions ${promptState ?? "unknown"}; no duplicate guidance added`);
      if (!http || !instructions) console.log(`[memorise] agent ${request.agentId} provider ${request.provider}: optional memory features limited (instructions=${request.openSupport?.instructions ?? "unknown"}, http=${request.openSupport?.mcpHttp ?? "unknown"}, configuration=${request.openSupport?.restrictions.mcpConfiguration ?? "unknown"})`);
      if (!http && !appendNotes) return;
      values = await currentSettings();
      if (!values.enabled) return;
      await projectRootsKnown(paseo);
      prepared = await prepareMemory(request.cwd, values, { toolsAvailable: http, problems: deliveryProblems });
      if (prepared.off) return;
    } catch (error) {
      if (reuseFixedBinding) throw new Error(`Memorise cannot reuse this fixed memory contribution (${error instanceof Error ? error.message : String(error)}). Fully close this session and its retained children, then reopen it.`);
      if (launch.signal.aborted) throw error;
      console.error(`[memorise] could not prepare memory for agent ${request.agentId} provider ${request.provider}: ${String(error)}`);
      if (!appendNotes) return;
      const section = buildMemorySection({ repoKey: null, facts: [], notes: new Map(), maxLines: 0, toolsAvailable: false, problems: [`memory could not be loaded (${String(error)})`] });
      return { ...request, appendSystemPrompt: [...(request.appendSystemPrompt ?? []), section.text] };
    }
    if (launch.signal.aborted) throw new Error("Memorise session opening was disposed before memory preparation finished");
    const { tokens, usage, port, mcpProblem } = active;
    const { repoKey, section } = prepared;
    const binding = http && mcpProblem === null ? tokens.mintLaunch({ repoKey, cwd: request.cwd, provider: request.provider, agentId: request.agentId }) : null;
    if (binding) launch.onDispose(binding.dispose);
    rememberSettings(settingsFingerprint(request, values, prepared.project, prepared.prefs), binding !== null);
    if (appendNotes) {
      if (values.showInAgentChats && request.reason === "create") {
        listedByAgent.set(request.agentId, { count: section.shownIds.length, launchId: launch.id });
        launch.onDispose(() => {
          if (listedByAgent.get(request.agentId)?.launchId === launch.id) listedByAgent.delete(request.agentId);
        });
      }
      await usage.record("shown", section.shownIds).catch((error: unknown) => console.error(`[memorise] usage log write failed: ${String(error)}`));
    }
    return {
      ...request,
      ...(appendNotes ? { appendSystemPrompt: [...(request.appendSystemPrompt ?? []), section.text] } : {}),
      mcpServers: binding ? { ...request.mcpServers, ...mcpServerEntries(port, binding.token) } : request.mcpServers,
      ...(binding && values.autoApproveReads && request.openSupport?.exactMcpPreapproval === "supported" ? { toolPolicy: { preapproved: [...(request.toolPolicy?.preapproved ?? []),
        { kind: "mcp" as const, server: READ_SERVER, tool: "memory_search" },
        { kind: "mcp" as const, server: READ_SERVER, tool: "memory_read" },
      ] } } : {}),
    };
  });

  // Exact read conveniences travel only with this launch's own MCP bindings. Ordinary prompts
  // remain unanswered. Workers still deny every request, including requests for built-in tools.
  server.on("agent.permission_requested", async ({ agent, request }, { paseo }) => {
    const { capture } = await runtime;
    capture.remember(paseo);
    if (capture.isWorker(agent.id, agent.cwd)) {
      await paseo.agents.ref(agent.id).respondToPermission({ requestId: request.id, response: { behavior: "deny", message: "Memory workers may not use tools." } });
      return;
    }
  });

  // A new workspace's project is queued for a scan when automatic project scans are on and it is due.
  // The hook returns at once: a scan takes longer than Paseo waits for a hook. Workspaces of the
  // plugin's own workers are never scanned.
  server.on("workspace.created", async ({ workspace }, { paseo }) => {
    const { capture, keys, root } = await runtime;
    capture.remember(paseo);
    if (capture.isWorker("", workspace.cwd)) return;
    // The new workspace's project may be a new project root: folders below it share its memory.
    void markProjectRoots(paseo, root, keys)
      .then(() => keys.keyOf(workspace.cwd))
      .then((repoKey) => capture.scanIfDue(repoKey, workspace.cwd))
      .catch((error: unknown) => console.error(`[memorise] automatic project scan of ${workspace.cwd}: ${error instanceof Error ? error.message : String(error)}`));
  });

  server.on("agent.turn_started", async ({ agent }) => {
    const { capture } = await runtime;
    capture.onTurnStarted(agent.id);
  });

  // A new agent's receipt: the memories it was given. Agents Memorise did not prepare get none.
  server.on("agent.created", async ({ agent }, { paseo }) => {
    const { capture, receipts } = await runtime;
    capture.remember(paseo);
    const listed = listedByAgent.get(agent.id);
    if (!listed || capture.isWorker(agent.id, agent.cwd)) return;
    listedByAgent.delete(agent.id);
    if (!(await currentSettings()).showInAgentChats) return;
    // Counting starts where the timeline ends now, so nothing before the agent existed is its use.
    const receipt = await timelineEnd(paseo, agent.id)
      .then((cursor) => receipts.start(agent.id, listed.count, cursor))
      .catch((error: unknown) => {
        console.error(`[memorise] could not start the memory receipt for agent ${agent.id}: ${error instanceof Error ? error.message : String(error)}`);
        return null;
      });
    if (receipt) await appendReceipt(paseo, agent.id, receipt);
  });

  server.on("agent.turn_ended", async ({ agent }, { paseo }) => {
    const { capture, receipts } = await runtime;
    await capture.onTurnEnded(agent, paseo);
    if (capture.isWorker(agent.id, agent.cwd) || !(await currentSettings()).showInAgentChats) return;
    // Paseo's event carries no timeline, so the receipt reads the entries after the position it
    // counted up to. A rebuilt timeline moves the position without counting, so no call counts twice.
    const receipt = await (async () => {
      const previous = await receipts.cursor(agent.id);
      if (previous === null) return null;
      const fresh = await readTimelineSince(paseo, agent.id, previous);
      if (previous && !fresh.continued) console.log(`[memorise] the timeline of agent ${agent.id} was rebuilt; its receipt continues from the new end without counting this turn`);
      const use = previous && !fresh.continued ? memoryToolUse([]) : memoryToolUse(fresh.entries.map((entry) => entry.item));
      const updated = await receipts.add(agent.id, use, { epoch: fresh.epoch, seq: fresh.end });
      return Object.values(use).some((n) => n > 0) ? updated : null;
    })().catch((error: unknown) => {
      console.error(`[memorise] could not update the memory receipt for agent ${agent.id}: ${error instanceof Error ? error.message : String(error)}`);
      return null;
    });
    if (receipt) await appendReceipt(paseo, agent.id, receipt);
  });

  // The panel names a workspace folder; the manager names a repo key, or null for global only.
  const repoKeyOf = async (where: Where): Promise<string | null> => ("directory" in where ? (await runtime).keys.keyOf(where.directory) : (await runtime).keys.canonical(where.repoKey));

  server.handle(listMemoriesRpc, async ({ where }) => {
    const [{ store, usage }, repoKey, values] = await Promise.all([runtime, repoKeyOf(where), currentSettings()]);
    const counts = await usage.counts();
    const facts = orderForAgents(await store.list(repoKey)).map((fact) => ({ ...fact, visibleToAgents: isVisibleToAgents(fact, values.expiryDays), usage: usageOf(counts, fact.id) }));
    return { repoKey, facts };
  });

  server.handle(saveMemoryRpc, async ({ where, scope, type, subject, body, paths, pinned, activation, enabled, until }) => {
    const [{ store }, repoKey] = await Promise.all([runtime, repoKeyOf(where)]);
    if (scope === "repo" && !repoKey) throw new Error("No project was chosen; save the memory as global instead.");
    const problem = typeProblem(type, await currentTypes());
    if (problem) throw new Error(problem);
    assertNoSecret(subject, body);
    const fact = await store.create({ scope, repoKey: scope === "repo" ? repoKey : null, type, subject, body, paths, pinned, activation, enabled, until, supersedes: null, source: BY_USER, citations: [] });
    return { fact };
  });

  // A content change is a new version that also carries any control change; controls alone change
  // in place. Either way it is one write.
  server.handle(updateMemoryRpc, async ({ where, id, subject, body, type, paths, activation, enabled, until }) => {
    const [{ store }, repoKey] = await Promise.all([runtime, repoKeyOf(where)]);
    assertNoSecret(subject ?? "", body ?? "");
    // A memory keeps a type that has left the list; only choosing a different one is checked.
    if (type !== undefined && type !== (await store.get(id, repoKey)).type) {
      const problem = typeProblem(type, await currentTypes());
      if (problem) throw new Error(problem);
    }
    const content = { ...(subject !== undefined && { subject }), ...(body !== undefined && { body }), ...(type !== undefined && { type }), ...(paths !== undefined && { paths }) };
    const controls = { ...(activation !== undefined && { activation }), ...(enabled !== undefined && { enabled }), ...(until !== undefined && { until }) };
    if (Object.keys(content).length === 0) return { fact: await store.setControls(id, repoKey, controls) };
    return { fact: await store.supersede(id, repoKey, { ...content, ...controls, source: BY_USER }) };
  });

  server.handle(listTypesRpc, async () => ({ types: await currentTypes() }));

  server.handle(pinMemoryRpc, async ({ where, id, pinned }) => {
    const [{ store }, repoKey] = await Promise.all([runtime, repoKeyOf(where)]);
    return { fact: await store.setPinned(id, repoKey, pinned) };
  });

  server.handle(retireMemoryRpc, async ({ where, id }) => {
    const [{ store }, repoKey] = await Promise.all([runtime, repoKeyOf(where)]);
    return { fact: await store.retire(id, repoKey) };
  });

  server.handle(restoreMemoryRpc, async ({ where, id }) => {
    const [{ store }, repoKey] = await Promise.all([runtime, repoKeyOf(where)]);
    return { fact: await store.restore(id, repoKey) };
  });

  server.handle(deleteMemoryRpc, async ({ where, id }) => {
    const [{ store }, repoKey] = await Promise.all([runtime, repoKeyOf(where)]);
    await store.delete(id, repoKey);
    return { deleted: true as const };
  });

  server.handle(previewMemoryRpc, async ({ directory }) => {
    const values = await currentSettings();
    const prepared = await prepareMemory(directory, values);
    const limits = { maxLines: values.indexMaxLines, maxBytes: INDEX_MAX_BYTES };
    if (prepared.off) return { repoKey: prepared.repoKey, off: true, text: "", bytes: 0, ...limits, listed: [] };
    const shown = new Set(prepared.section.shownIds);
    const listed = prepared.ranked
      .filter(({ fact }) => shown.has(fact.id))
      .map(({ fact, reason }) => ({ id: fact.id, subject: fact.subject, reason, titleOnly: fact.activation === "title" && !fact.pinned }));
    return { repoKey: prepared.repoKey, off: false, text: prepared.section.text, bytes: Buffer.byteLength(prepared.section.text), ...limits, listed };
  });

  server.handle(exportMemoryRpc, async ({ where, format }) => {
    const [{ store }, repoKey] = await Promise.all([runtime, repoKeyOf(where)]);
    const scope = repoKey ? "repo" : "global";
    const facts = (await store.list(repoKey)).filter((fact) => fact.scope === scope && fact.status === "active" && !fact.superseded).sort((a, b) => a.created.localeCompare(b.created) || a.id.localeCompare(b.id));
    return { text: formatExport(facts, format, repoKey), count: facts.length };
  });

  // Imported memories are the user's own. Duplicates of current memories in the target scope, and
  // repeats within the same import, are skipped and named.
  server.handle(importMemoryRpc, async ({ where, scope, text, dryRun }) => {
    const [{ store }, repoKey] = await Promise.all([runtime, repoKeyOf(where)]);
    if (scope === "repo" && !repoKey) throw new Error("No project was chosen; import the memories as global instead.");
    const { entries, skipped } = parseImport(text, await currentTypes());
    const saved = new Set((await store.list(repoKey)).filter((fact) => fact.scope === scope && !fact.superseded).map((fact) => importKey(fact.subject, fact.body)));
    const seen = new Set<string>();
    const added: { type: MemoryType; subject: string }[] = [];
    const limit = (await currentSettings()).memoryMaxChars;
    for (const entry of entries) {
      const key = importKey(entry.subject, entry.body);
      // Checked here as well as in the store, so the preview names them and an import never stops halfway.
      if (bodyLengthProblem(entry.body, limit)) {
        skipped.push({ line: entry.subject, reason: `longer than ${limit.toLocaleString("en-US")} characters` });
        continue;
      }
      if (saved.has(key) || seen.has(key)) {
        skipped.push({ line: entry.subject, reason: saved.has(key) ? "already saved" : "repeated in this import" });
        continue;
      }
      seen.add(key);
      added.push({ type: entry.type, subject: entry.subject });
      if (!dryRun) await store.create({ ...entry, scope, repoKey: scope === "repo" ? repoKey : null, supersedes: null, source: BY_USER, citations: [] });
    }
    return { added, skipped };
  });

  server.handle(getRepoPrefsRpc, async ({ repoKey }) => {
    const { repoPrefs, keys } = await runtime;
    return { prefs: await repoPrefs.get(await keys.canonical(repoKey)) };
  });

  server.handle(setRepoPrefsRpc, async ({ repoKey, prefs }) => {
    const { repoPrefs, keys } = await runtime;
    return { prefs: await repoPrefs.set(await keys.canonical(repoKey), prefs) };
  });

  // Every repo the manager can work on: those with memories (with counts), those with an open Paseo
  // workspace, and those with proposals waiting. Global comes first, then repos by key.
  server.handle(listReposRpc, async (_input, { paseo }) => {
    const { store, proposals, root, keys } = await runtime;
    const [withMemories, open, waiting] = await Promise.all([store.summaries(), openRepoCheckouts(paseo, root, keys), proposals.summary()]);
    const known = new Set(withMemories.map((repo) => repo.repoKey));
    const others = [...new Set([...open.keys(), ...waiting.map((repo) => repo.repoKey)])].filter((repoKey) => !known.has(repoKey));
    const repos = [...withMemories, ...others.map((repoKey) => ({ repoKey, active: 0, retired: 0, lastModified: null }))];
    // A folder project is shown by its folder's current name, which a rename changes and its key does not.
    const labelled = await Promise.all(repos.map(async (repo) => ({ ...repo, label: repo.repoKey && isFolderKey(repo.repoKey) ? ((await keys.label(repo.repoKey))?.name ?? null) : null })));
    return { repos: labelled.sort((a, b) => (a.repoKey === null ? -1 : b.repoKey === null ? 1 : a.repoKey.localeCompare(b.repoKey))) };
  });

  server.handle(searchMemoriesRpc, async ({ where, query }) => {
    const [{ store, search }, repoKey] = await Promise.all([runtime, repoKeyOf(where)]);
    if (!search) throw new Error("Keyword search is unavailable: the search index could not be opened (see the plugin log).");
    const facts = await store.list(repoKey);
    const current = new Set(facts.filter((fact) => !fact.superseded).map((fact) => fact.id));
    return { ids: search.search(repoKey ?? "global", facts, current, query, MAX_BULK_IDS) };
  });

  server.handle(memoryHistoryRpc, async ({ where, id }) => {
    const [{ store }, repoKey] = await Promise.all([runtime, repoKeyOf(where)]);
    return { versions: await store.history(id, repoKey) };
  });

  server.handle(revertMemoryRpc, async ({ where, id, versionId }) => {
    const [{ store }, repoKey] = await Promise.all([runtime, repoKeyOf(where)]);
    return { fact: await store.revert(id, versionId, repoKey, BY_USER) };
  });

  server.handle(moveMemoryRpc, async ({ where, id, to }) => {
    const [{ store }, repoKey] = await Promise.all([runtime, repoKeyOf(where)]);
    return { fact: await store.move(id, repoKey, to) };
  });

  // Each id is applied on its own and reported, so one missing or retired memory does not stop the rest.
  server.handle(bulkMemoryRpc, async ({ where, ids, action }) => {
    const [{ store }, repoKey] = await Promise.all([runtime, repoKeyOf(where)]);
    const apply: Record<BulkAction, (id: string) => Promise<unknown>> = {
      retire: (id) => store.retire(id, repoKey),
      restore: (id) => store.restore(id, repoKey),
      pin: (id) => store.setPinned(id, repoKey, true),
      unpin: (id) => store.setPinned(id, repoKey, false),
      enable: (id) => store.setControls(id, repoKey, { enabled: true }),
      disable: (id) => store.setControls(id, repoKey, { enabled: false }),
      delete: (id) => store.delete(id, repoKey),
    };
    const results: { id: string; ok: boolean; error?: string }[] = [];
    for (const id of ids) {
      try {
        await apply[action](id);
        results.push({ id, ok: true });
      } catch (error) {
        results.push({ id, ok: false, error: error instanceof Error ? error.message : String(error) });
      }
    }
    return { results };
  });

  server.handle(listProposalsRpc, async ({ where }) => {
    const [{ store, proposals, capture }, repoKey] = await Promise.all([runtime, repoKeyOf(where)]);
    if (!repoKey) return { repoKey, proposals: [], captureRunsToday: await capture.runsToday(), lastRun: null };
    const facts = new Map((await store.list(repoKey)).map((fact) => [fact.id, fact]));
    const pending = (await proposals.list(repoKey)).map((proposal) => ({
      ...proposal,
      targetFacts: proposal.targets.flatMap((id) => {
        const fact = facts.get(id);
        return fact ? [{ id, subject: fact.subject, body: fact.body }] : [];
      }),
    }));
    return { repoKey, proposals: pending, captureRunsToday: await capture.runsToday(), lastRun: capture.lastRun(repoKey) };
  });

  server.handle(approveProposalRpc, async ({ where, id, subject, body, paths }) => {
    const [{ store, proposals }, repoKey] = await Promise.all([runtime, repoKeyOf(where)]);
    if (!repoKey) throw new Error("Suggestions belong to a project; choose one.");
    await proposals.approve(id, repoKey, store, { subject, body, paths });
    return { approved: true as const };
  });

  server.handle(rejectProposalRpc, async ({ where, id }) => {
    const [{ proposals }, repoKey] = await Promise.all([runtime, repoKeyOf(where)]);
    if (!repoKey) throw new Error("Suggestions belong to a project; choose one.");
    await proposals.reject(id, repoKey);
    return { rejected: true as const };
  });

  server.handle(proposalsSummaryRpc, async () => ({ repos: await (await runtime).proposals.summary() }));

  // A checkout to read for a project scan: the given workspace folder, or the folder of an open
  // workspace that belongs to the repo.
  async function checkoutFor(where: Where, paseo: PaseoApi): Promise<{ repoKey: string; folder: string }> {
    if ("directory" in where) {
      return { repoKey: await (await runtime).keys.keyOf(where.directory), folder: where.directory };
    }
    if (!where.repoKey) throw new Error("Suggesting from project files works on one project; choose one.");
    const { root, keys } = await runtime;
    const repoKey = await keys.canonical(where.repoKey);
    const folder = (await openRepoCheckouts(paseo, root, keys)).get(repoKey);
    if (folder) return { repoKey, folder };
    throw new Error(`Open a workspace of ${repoKey} in Paseo first; suggesting from project files reads that checkout's files.`);
  }

  // Starts a project scan and returns at once; its proposals appear in the inbox when it finishes.
  server.handle(scanProjectRpc, async ({ where, mode }, { paseo }) => {
    const { capture } = await runtime;
    capture.remember(paseo);
    const { repoKey, folder } = await checkoutFor(where, paseo);
    if (capture.isScanning(repoKey)) throw new Error("Suggestions from this project's files are already being made; they will appear here.");
    const { done } = await capture.startScan(repoKey, folder, mode);
    void done.catch((error: unknown) => console.error(`[memorise] project scan of ${repoKey} failed: ${error instanceof Error ? error.message : String(error)}`));
    return { started: true as const, folder };
  });

  // Starts a tidy pass and returns at once; its proposals appear in the inbox when it finishes. With a
  // workspace folder, tidy also checks citations against that checkout.
  server.handle(tidyMemoryRpc, async ({ where }, { paseo }) => {
    const [{ capture }, repoKey] = await Promise.all([runtime, repoKeyOf(where)]);
    if (!repoKey) throw new Error("Clean up works on one project's memories; choose a project.");
    const directory = "directory" in where ? where.directory : null;
    if (capture.isTidying(repoKey)) throw new Error("A clean-up of this project is already running; its suggestions will appear here.");
    capture.remember(paseo);
    const { done } = await capture.startTidy(repoKey, directory);
    void done.catch((error: unknown) => console.error(`[memorise] tidy of ${repoKey} failed: ${error instanceof Error ? error.message : String(error)}`));
    return { started: true as const };
  });

  return async () => {
    const resolved = await runtime.catch(() => null);
    if (!resolved) return;
    resolved.capture.stop();
    resolved.stopInterop();
    resolved.search?.close();
    const { http } = resolved;
    if (!http) return;
    const closed = new Promise<void>((resolve) => http.close(() => resolve()));
    // close() waits for open connections; agents keep theirs alive between requests.
    http.closeAllConnections();
    await closed;
  };
}
