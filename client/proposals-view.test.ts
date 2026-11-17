import { describe, expect, it } from "vitest";
import { cardHeading, cardSuggestions, decideEach, oneLine, reviewedCount, reviewedText, sameIds } from "./proposals-view";

const waiting = (id: string, agentId: string | null) => ({ id, source: { agentId } });

describe("proposals card", () => {
  const proposals = [waiting("a", "agent-1"), waiting("b", "agent-1"), waiting("c", "agent-1"), waiting("d", "agent-2")];

  it("lists only the waiting suggestions its own pass added", () => {
    expect(cardSuggestions(proposals, "agent-1", ["b", "c"]).map((proposal) => proposal.id)).toEqual(["b", "c"]);
    // A decided suggestion is no longer waiting, so it drops out; another agent's never shows.
    expect(cardSuggestions(proposals, "agent-1", ["gone", "d"])).toEqual([]);
  });

  it("lists every waiting suggestion from the agent on a card that names none (added before 0.10.4)", () => {
    expect(cardSuggestions(proposals, "agent-1", undefined).map((proposal) => proposal.id)).toEqual(["a", "b", "c"]);
  });
});

describe("oneLine", () => {
  it("turns line breaks and repeated spaces into one space and trims the ends", () => {
    expect(oneLine("  First line.\n\nSecond   line.\t Third. \n")).toBe("First line. Second line. Third.");
  });
});

describe("reviewedCount", () => {
  it("has no count for a card that names no suggestions", () => {
    expect(reviewedCount(undefined, ["a"])).toBeNull();
  });

  it("has no count for a card whose pass left nothing waiting", () => {
    expect(reviewedCount([], [])).toBeNull();
  });

  it("counts the card's suggestions that no longer wait", () => {
    expect(reviewedCount(["a", "b", "c", "d", "e", "f", "g"], ["a", "b", "c", "d", "e"])).toEqual({ reviewed: 2, total: 7 });
  });

  it("ignores a waiting suggestion that is not on the card", () => {
    expect(reviewedCount(["a", "b"], ["a", "b", "other"])).toEqual({ reviewed: 0, total: 2 });
  });
});

describe("cardHeading", () => {
  it("counts the memories waiting and says agents see them once approved", () => {
    expect(cardHeading(7, 0)).toEqual({ lead: "7 memories to review", rest: " · agents see them once approved" });
    expect(cardHeading(1, 0).lead).toBe("1 memory to review");
  });

  it("adds how many were saved without review", () => {
    expect(cardHeading(2, 3).rest).toBe(" · agents see them once approved · 3 saved without review");
  });

  it("names only the saved ones when nothing waits", () => {
    expect(cardHeading(0, 3)).toEqual({ lead: "3 saved without review", rest: "" });
  });

  it("has a plain title when nothing waits and nothing was saved", () => {
    expect(cardHeading(0, 0)).toEqual({ lead: "Suggested memories", rest: "" });
  });
});

describe("reviewedText", () => {
  it("says how many of the card's suggestions are reviewed", () => {
    expect(reviewedText(["a", "b", "c"], ["b", "c"])).toBe("1 of 3 reviewed");
  });

  it("says nothing before the first one is reviewed", () => {
    expect(reviewedText(["a", "b", "c"], ["a", "b", "c"])).toBeNull();
  });

  it("says all are reviewed when none wait", () => {
    expect(reviewedText(["a", "b", "c"], [])).toBe("All 3 reviewed.");
  });

  it("says nothing on a card whose pass left nothing waiting", () => {
    expect(reviewedText([], [])).toBeNull();
  });

  it("keeps the old wording on a card that names no suggestions", () => {
    expect(reviewedText(undefined, ["a"])).toBeNull();
    expect(reviewedText(undefined, [])).toBe("All reviewed.");
  });
});

describe("sameIds", () => {
  it("is true for the same ids in another order", () => {
    expect(sameIds(["a", "b", "c"], ["c", "a", "b"])).toBe(true);
  });

  it("is false when one is missing or one is extra", () => {
    expect(sameIds(["a", "b", "c"], ["a", "b"])).toBe(false);
    expect(sameIds(["a", "b"], ["a", "b", "c"])).toBe(false);
    expect(sameIds(["a", "b"], ["a", "c"])).toBe(false);
  });
});

describe("decideEach", () => {
  it("decides each id in order, one after another", async () => {
    const calls: string[] = [];
    const failed = await decideEach(
      ["a", "b", "c"],
      async (id) => {
        calls.push(`start ${id}`);
        await Promise.resolve();
        calls.push(`end ${id}`);
      },
      String,
    );
    expect(calls).toEqual(["start a", "end a", "start b", "end b", "start c", "end c"]);
    expect(failed).toEqual([]);
  });

  it("goes on after a failure and returns each failure's text", async () => {
    const done: string[] = [];
    const failed = await decideEach(
      ["a", "b", "c"],
      async (id) => {
        if (id !== "c") throw new Error(`No suggestion with id ${id}`);
        done.push(id);
      },
      (error) => (error as Error).message,
    );
    expect(done).toEqual(["c"]);
    expect(failed).toEqual(["No suggestion with id a", "No suggestion with id b"]);
  });
});
