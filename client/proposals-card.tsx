import { type PluginTimelineItemProps, useAgent, useRpc, useWorkspace } from "@getpaseo/plugin/client";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { type ReactNode, useEffect, useState } from "react";
import { Pressable, Text, View } from "react-native";
import type { z } from "zod";
import { approveProposalRpc, listProposalsRpc, type proposalsCardSchema, rejectProposalRpc } from "../shared/memory";
import { memoryChanged, onMemoryChanged } from "./memory-events";
import { count, errorText, kindLabel } from "./copy";
import { Badge, Button, type Styles, useStyles } from "./panel-ui";
import { cardHeading, cardSuggestions, decideEach, oneLine, reviewedText, sameIds } from "./proposals-view";

type CardData = z.infer<typeof proposalsCardSchema>;
type Listed = z.infer<typeof listProposalsRpc.output>["proposals"][number];
type Decision = "approve" | "reject";

// Spacing, in one place: the card's inner edge, the space above and below each line of the card,
// and the width of the open-or-closed mark, which the lines under a title are indented by.
const EDGE = 12;
const LINE = 8;
const MARK = 16;

function Mark({ open, styles }: { open: boolean; styles: Styles }) {
  return <Text style={[styles.muted, { width: MARK }]}>{open ? "▾" : "▸"}</Text>;
}

// The card's box and top line. Pressing the top line folds the card down to that line and opens it
// again. Whether it starts open comes from the setting when the card was made.
function Frame({ waiting, autoSaved, startOpen, actions, styles, children }: { waiting: number; autoSaved: number; startOpen: boolean; actions?: ReactNode; styles: Styles; children: ReactNode }) {
  const [open, setOpen] = useState(startOpen);
  const heading = cardHeading(waiting, autoSaved);
  return (
    <View style={{ borderWidth: 1, borderColor: styles.card.borderColor, borderRadius: 10, padding: EDGE }}>
      <View style={styles.row}>
        {/* No label of its own, so a screen reader reads the count; `expanded` says which way it is. */}
        <Pressable accessibilityRole="button" accessibilityState={{ expanded: open }} aria-expanded={open} onPress={() => setOpen((value) => !value)} style={{ flexDirection: "row", flexGrow: 1, flexShrink: 1, flexBasis: 200 }}>
          <Mark open={open} styles={styles} />
          <Text style={[styles.muted, { flexShrink: 1 }]}>
            <Text style={{ color: styles.body.color }}>{heading.lead}</Text>
            {heading.rest}
          </Text>
        </Pressable>
        {/* One group, so on a narrow screen the buttons move under the text together. */}
        {open && actions && <View style={[styles.row, { flexShrink: 1, paddingLeft: MARK }]}>{actions}</View>}
      </View>
      {open && <View style={{ paddingTop: LINE }}>{children}</View>}
    </View>
  );
}

// One suggestion: its title and kind, then its text (one line until opened), with Approve and
// Reject beside it, or under it on a narrow screen. `running` is the decision in flight, if any.
function Suggestion({ proposal, styles, compact, running, locked, onDecide }: { proposal: Listed; styles: Styles; compact: boolean; running: Decision | undefined; locked: boolean; onDecide(decision: Decision): void }) {
  const [open, setOpen] = useState(false);
  const { subject, body, paths } = proposal;
  return (
    <View style={{ borderTopWidth: 1, borderTopColor: styles.card.borderColor, paddingVertical: LINE, gap: LINE, flexDirection: compact ? "column" : "row", alignItems: compact ? "stretch" : "flex-start" }}>
      {/* No label of its own: a label would replace the title, kind, and text for a screen reader. */}
      <Pressable
        accessibilityRole="button"
        accessibilityState={{ expanded: open }}
        aria-expanded={open}
        onPress={() => setOpen((value) => !value)}
        style={[{ gap: 2, minWidth: 0 }, !compact && { flex: 1 }]}
      >
        <View style={{ flexDirection: "row", alignItems: "center" }}>
          <Mark open={open} styles={styles} />
          <Text style={[styles.body, { flexShrink: 1, marginRight: LINE }]} numberOfLines={open ? undefined : 1}>
            {subject}
          </Text>
          <Badge label={kindLabel(proposal.type)} styles={styles} />
        </View>
        <Text style={[styles.muted, { paddingLeft: MARK }]} numberOfLines={open ? undefined : 1}>
          {open ? body : oneLine(body)}
        </Text>
        {open && paths.length > 0 && <Text style={[styles.muted, { paddingLeft: MARK }]}>About files: {paths.join(", ")}</Text>}
      </Pressable>
      <View style={{ flexDirection: "row", gap: LINE, paddingLeft: compact ? MARK : 0 }}>
        <Button label={running === "approve" ? "Approving" : "Approve"} accessibilityLabel={`Approve ${subject}`} tone="primary" disabled={locked} styles={styles} onPress={() => onDecide("approve")} />
        <Button label={running === "reject" ? "Rejecting" : "Reject"} accessibilityLabel={`Reject ${subject}`} disabled={locked} styles={styles} onPress={() => onDecide("reject")} />
      </View>
    </View>
  );
}

// The card for an agent that has a workspace: its waiting suggestions, with actions for one or all.
function Review({ agentId, workspaceId, data, styles, compact, openPanel }: { agentId: string; workspaceId: string; data: CardData; styles: Styles; compact: boolean; openPanel(workspaceId: string): void }) {
  const directory = useWorkspace(workspaceId, (workspace) => workspace.directory);
  const list = useRpc(listProposalsRpc);
  const approve = useRpc(approveProposalRpc);
  const reject = useRpc(rejectProposalRpc);
  const queryClient = useQueryClient();
  const where = { directory: directory ?? "" };
  const query = useQuery({ queryKey: ["memorise-proposals", where], queryFn: () => list({ where }), enabled: directory !== null });
  // Decisions in flight. One that failed is taken out so it can be tried again; one that worked
  // stays, so its row cannot be pressed again before the refreshed list drops it.
  const [running, setRunning] = useState<Record<string, Decision>>({});
  // Why a suggestion's last decision failed, by its id, until it is tried again.
  const [failures, setFailures] = useState<Record<string, string>>({});
  // A suggestion decided on another screen leaves this card too.
  useEffect(() => onMemoryChanged(() => void queryClient.invalidateQueries({ queryKey: ["memorise-proposals"] })), [queryClient]);
  // "Reject all" asks once, about exactly the suggestions waiting when it was pressed.
  const [asked, setAsked] = useState<string[] | null>(null);

  const mine = query.data ? cardSuggestions(query.data.proposals, agentId, data.ids) : null;
  const waitingIds = mine?.map((proposal) => proposal.id) ?? [];
  const question = asked && sameIds(asked, waitingIds) ? asked : null;
  const busy = waitingIds.some((id) => Object.hasOwn(running, id));

  const decide = async (ids: readonly string[], decision: Decision) => {
    setAsked(null);
    setFailures((current) => Object.fromEntries(Object.entries(current).filter(([id]) => !ids.includes(id))));
    setRunning((current) => ({ ...current, ...Object.fromEntries(ids.map((id) => [id, decision])) }));
    const failedIds: string[] = [];
    const failed = await decideEach(
      ids,
      async (id) => {
        try {
          await (decision === "approve" ? approve({ where, id }) : reject({ where, id }));
        } catch (error) {
          failedIds.push(id);
          throw error;
        }
      },
      errorText,
    );
    setRunning((current) => Object.fromEntries(Object.entries(current).filter(([id]) => !failedIds.includes(id))));
    setFailures((current) => ({ ...current, ...Object.fromEntries(failedIds.map((id, index) => [id, failed[index]])) }));
    void queryClient.invalidateQueries({ queryKey: ["memorise-proposals"] });
    if (failed.length < ids.length) memoryChanged();
  };

  const actions =
    waitingIds.length < 2 ? null : question ? (
      <>
        <Text style={[styles.body, { flexShrink: 1 }]}>Reject {count(question.length, "suggestion", "suggestions")}? They won't be suggested again.</Text>
        <Button label={`Reject ${question.length}`} tone="danger" styles={styles} onPress={() => void decide(question, "reject")} />
        <Button label="Cancel" styles={styles} onPress={() => setAsked(null)} />
      </>
    ) : (
      <>
        {/* Approving needs no question: an approved memory can be archived afterwards. */}
        <Button label={`Approve all ${waitingIds.length}`} tone="primary" disabled={busy} styles={styles} onPress={() => void decide(waitingIds, "approve")} />
        <Button label="Reject all" disabled={busy} styles={styles} onPress={() => setAsked(waitingIds)} />
      </>
    );
  const reviewed = mine ? reviewedText(data.ids, waitingIds) : null;
  return (
    <Frame waiting={mine ? mine.length : data.count} autoSaved={data.autoSaved} startOpen={data.open} actions={actions} styles={styles}>
      {query.isPending && <Text style={[styles.muted, { paddingLeft: MARK, paddingBottom: LINE }]}>Loading suggestions</Text>}
      {query.error && <Text style={[styles.danger, { paddingLeft: MARK, paddingBottom: LINE }]}>{errorText(query.error)}</Text>}
      {mine?.map((proposal) => (
        <Suggestion key={proposal.id} proposal={proposal} styles={styles} compact={compact} running={running[proposal.id]} locked={Object.hasOwn(running, proposal.id)} onDecide={(decision) => void decide([proposal.id], decision)} />
      ))}
      {waitingIds
        .filter((id) => Object.hasOwn(failures, id))
        .map((id) => (
          <Text key={id} style={[styles.danger, { paddingLeft: MARK, paddingBottom: LINE }]}>
            {failures[id]}
          </Text>
        ))}
      <View style={[styles.row, { borderTopWidth: 1, borderTopColor: styles.card.borderColor, paddingTop: LINE }]}>
        <Text style={[styles.muted, { flexGrow: 1, flexShrink: 1, paddingLeft: MARK }]}>{reviewed}</Text>
        <Button label="Edit in Memorise" accessibilityLabel="Edit suggestions in the Memorise panel" styles={styles} onPress={() => openPanel(workspaceId)} />
      </View>
    </Frame>
  );
}

// Shown in the source agent's chat after a capture pass; the model never sees it.
export function ProposalsCard({ agentId, item, theme, layout, openPanel }: PluginTimelineItemProps<CardData> & { openPanel(workspaceId: string): void }) {
  const styles = useStyles(theme, layout.compact);
  const workspaceId = useAgent(agentId, (agent) => agent.workspaceId);
  if (workspaceId) return <Review agentId={agentId} workspaceId={workspaceId} data={item.data} styles={styles} compact={layout.compact} openPanel={openPanel} />;
  return (
    <Frame waiting={item.data.count} autoSaved={item.data.autoSaved} startOpen={item.data.open} styles={styles}>
      <Text style={[styles.muted, { paddingLeft: MARK }]}>Review them in Memorise, under Suggestions.</Text>
    </Frame>
  );
}
