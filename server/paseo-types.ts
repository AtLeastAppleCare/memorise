import type { PluginHandlerContext } from "@getpaseo/plugin/server";

// The plugin SDK uses these types in its contexts but does not export them by name. Deriving them
// here keeps every import inside the SDK: Paseo rejects type imports from @getpaseo/client or
// @getpaseo/protocol, which a Git install without dev packages does not contain.
export type PaseoApi = PluginHandlerContext["paseo"];
type AgentHandle = ReturnType<PaseoApi["agents"]["ref"]>;
type TimelinePage = Awaited<ReturnType<AgentHandle["timeline"]["refetch"]>>;
export type AgentTimelineItem = TimelinePage["entries"][number]["item"];
