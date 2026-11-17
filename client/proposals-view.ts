// The waiting proposals a chat card lists: the ones its capture pass added, or, on a card that names
// none (added before 0.10.4), every waiting proposal from the agent.
export function cardSuggestions<T extends { id: string; source: { agentId: string | null } }>(proposals: readonly T[], agentId: string, ids: readonly string[] | undefined): T[] {
  return proposals.filter((proposal) => proposal.source.agentId === agentId && (ids === undefined || ids.includes(proposal.id)));
}

// A memory's text on one line, for a preview: line breaks would otherwise cut it at its first line.
export function oneLine(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

// How many of a card's suggestions have been decided, wherever that happened. Null for a card that
// names none (added before 0.10.4) or whose pass left nothing waiting.
export function reviewedCount(ids: readonly string[] | undefined, waitingIds: readonly string[]): { reviewed: number; total: number } | null {
  if (ids === undefined || ids.length === 0) return null;
  return { reviewed: ids.filter((id) => !waitingIds.includes(id)).length, total: ids.length };
}

// The card's top line: `lead` is what to read first, `rest` the quieter remainder. `waiting` is how
// many of the card's suggestions still wait; `autoSaved` how many its pass saved without review.
export function cardHeading(waiting: number, autoSaved: number): { lead: string; rest: string } {
  const saved = autoSaved > 0 ? `${autoSaved} saved without review` : "";
  if (waiting === 0) return { lead: saved || "Suggested memories", rest: "" };
  return { lead: `${waiting} ${waiting === 1 ? "memory" : "memories"} to review`, rest: ` · agents see them once approved${saved ? ` · ${saved}` : ""}` };
}

// The card's bottom line: how far the review has got, or null when there is nothing to say.
export function reviewedText(ids: readonly string[] | undefined, waitingIds: readonly string[]): string | null {
  const counted = reviewedCount(ids, waitingIds);
  if (!counted) return ids === undefined && waitingIds.length === 0 ? "All reviewed." : null;
  if (counted.reviewed === counted.total) return `All ${counted.total} reviewed.`;
  return counted.reviewed > 0 ? `${counted.reviewed} of ${counted.total} reviewed` : null;
}

// Whether two lists hold exactly the same ids. "Reject all" is asked about a fixed list; when the
// waiting list is no longer that list, the question is withdrawn.
export function sameIds(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((id) => b.includes(id));
}

// Decides each suggestion on its own, in order, so one that fails does not stop the rest. Returns
// the failures as text.
export async function decideEach(ids: readonly string[], decide: (id: string) => Promise<unknown>, describe: (error: unknown) => string): Promise<string[]> {
  const failed: string[] = [];
  for (const id of ids) {
    try {
      await decide(id);
    } catch (error) {
      failed.push(describe(error));
    }
  }
  return failed;
}
