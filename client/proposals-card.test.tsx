import { isValidElement, type ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { proposalsCardSchema } from "../shared/memory";
import { ProposalsCard } from "./proposals-card";

// Execute the component tree against host primitives, not a browser layout engine. Hook state is
// retained by tree position so pressing the real handlers exercises folding and row expansion.
const host = vi.hoisted(() => ({ workspaceId: "workspace" as string | null, proposals: [] as unknown[], states: new Map<string, unknown>(), path: "", hook: 0 }));
vi.mock("react", async (original) => ({
  ...await original<typeof import("react")>(),
  useEffect: () => undefined,
  useMemo: (make: () => unknown) => make(),
  useState: (initial: unknown) => {
    const key = `${host.path}:${host.hook++}`;
    if (!host.states.has(key)) host.states.set(key, initial);
    return [host.states.get(key), (value: unknown) => host.states.set(key, typeof value === "function" ? value(host.states.get(key)) : value)];
  },
}));
vi.mock("react-native", () => ({ View: "View", Text: "Text", Pressable: "Pressable" }));
vi.mock("@getpaseo/plugin/client", () => ({
  useAgent: () => host.workspaceId,
  useWorkspace: () => "/project",
  useRpc: () => async () => undefined,
}));
vi.mock("@tanstack/react-query", () => ({
  useQuery: () => ({ data: { proposals: host.proposals }, isPending: false, error: null }),
  useQueryClient: () => ({ invalidateQueries: async () => undefined }),
}));

type Node = { type: unknown; props: Record<string, unknown>; children: Array<Node | string> };
function render(node: ReactNode, path = "root"): Array<Node | string> {
  if (node === null || node === undefined || typeof node === "boolean") return [];
  if (Array.isArray(node)) return node.flatMap((child, index) => render(child, `${path}.${index}`));
  if (!isValidElement<{ children?: ReactNode }>(node)) return [String(node)];
  if (typeof node.type === "function") {
    host.path = path;
    host.hook = 0;
    return render((node.type as (props: unknown) => ReactNode)(node.props), `${path}.component`);
  }
  return [{ type: node.type, props: node.props, children: render(node.props.children, `${path}.children`) }];
}
function text(nodes: Array<Node | string>): string {
  return nodes.map((node) => typeof node === "string" ? node : text(node.children)).join(" ");
}
function buttons(nodes: Array<Node | string>): Node[] {
  return nodes.flatMap((node) => typeof node === "string" ? [] : [...(node.type === "Pressable" ? [node] : []), ...buttons(node.children)]);
}
function card(data: unknown) {
  const props = { agentId: "agent", item: { data: proposalsCardSchema.parse(data) }, theme: { colors: {} }, layout: { compact: false }, openPanel: () => undefined } as unknown as Parameters<typeof ProposalsCard>[0];
  return () => render(<ProposalsCard {...props} />);
}

const saved = { id: "01JB8Z6X3T5Q9V2M4N7P8R1S0W", type: "gotcha", subject: "Integration tests", body: "First line.\nSecond line.", paths: ["scripts/**"] };

beforeEach(() => {
  host.workspaceId = "workspace";
  host.proposals = [];
  host.states.clear();
});

describe("saved memories on the chat card", () => {
  it("explains why an older saved-only card has no details", () => {
    expect(text(card({ count: 0, autoSaved: 5, ids: [], open: true })())).toContain("This older card did not record the saved details. Find the memories in Memorise.");
  });

  it("shows saved details without a workspace and does not ask to review saved memories", () => {
    host.workspaceId = null;
    const tree = card({ count: 0, autoSaved: 1, ids: [], saved: [saved], open: true })();
    expect(text(tree)).toContain("Integration tests");
    expect(text(tree)).not.toContain("Review them in Memorise");
  });

  it("keeps saved details folded until the card is opened", () => {
    const draw = card({ count: 0, autoSaved: 1, ids: [], saved: [saved] });
    expect(text(draw())).not.toContain("Integration tests");
    const heading = buttons(draw())[0];
    expect(heading.props.accessibilityState).toEqual({ expanded: false });
    (heading.props.onPress as () => void)();
    expect(text(draw())).toContain("Integration tests");
    expect(buttons(draw())[0].props.accessibilityState).toEqual({ expanded: true });
  });

  it("keeps review controls only on waiting suggestions when the card also has saved memories", () => {
    host.proposals = [{ ...saved, id: "waiting", subject: "Pending tests", source: { agentId: "agent" } }];
    const tree = card({ count: 1, autoSaved: 1, ids: ["waiting"], saved: [saved], open: true })();
    expect(text(tree)).toContain("Integration tests");
    expect(text(tree)).toContain("Pending tests");
    expect(buttons(tree).map((node) => node.props.accessibilityLabel).filter((label) => typeof label === "string" && /^(Approve|Reject) /.test(label))).toEqual(["Approve Pending tests", "Reject Pending tests"]);
  });

  it("does not show saved content or a legacy warning when nothing was saved", () => {
    const tree = card({ count: 0, autoSaved: 0, ids: [], saved: [], open: true })();
    expect(text(tree)).not.toContain("Wording saved");
    expect(text(tree)).not.toContain("older card");
  });

  it("shows saved titles, kind and text without review buttons and expands to the full text and paths", () => {
    const draw = card({ count: 0, autoSaved: 1, ids: [], saved: [saved], open: true });
    expect(text(draw())).toContain("Integration tests");
    expect(text(draw())).toContain("Gotcha");
    expect(text(draw())).toContain("First line. Second line.");
    expect(buttons(draw()).map((node) => node.props.accessibilityLabel)).not.toContain("Approve Integration tests");
    expect(buttons(draw()).map((node) => node.props.accessibilityLabel)).not.toContain("Reject Integration tests");
    const row = buttons(draw()).find((node) => text(node.children).includes("Integration tests"));
    expect(row).toBeDefined();
    (row!.props.onPress as () => void)();
    expect(text(draw())).toContain("First line.\nSecond line.");
    expect(text(draw())).toContain("About files:  scripts/**");
  });
});
