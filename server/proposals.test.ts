import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { type NewProposal, ProposalStore } from "./proposals";
import { tempDir } from "./test-temp-dir";

const repoKey = "github.com/acme/api";
const suggestion = (subject: string): NewProposal => ({ repoKey, kind: "new", targets: [], type: "howto", subject, body: `Run make ${subject}.`, paths: [], reason: "", source: { from: "capture", agentId: "a", provider: "codex", model: null } });

describe("the order suggestions are listed in", () => {
  afterEach(() => vi.useRealTimers());

  it("is the order they were saved in, even when the clock does not move between saves", async () => {
    vi.useFakeTimers({ toFake: ["Date"], now: new Date("2026-11-17T10:00:00.000Z") });
    // Ids from one millisecond compare randomly, so one run could pass by luck; twenty cannot.
    for (let run = 0; run < 20; run += 1) {
      const store = new ProposalStore(tempDir("proposal-order-"));
      await store.add([suggestion("test")], []);
      await store.add([suggestion("lint"), suggestion("build")], []);
      expect((await store.list(repoKey)).map((item) => item.subject)).toEqual(["test", "lint", "build"]);
    }
  });

  it("is by id for stored suggestions that share a time, whatever their file names", async () => {
    const root = tempDir("proposal-ties-");
    const store = new ProposalStore(root);
    const [first] = await store.add([suggestion("test")], []);
    const dir = join(root, "proposals", ...repoKey.split("/"));
    await mkdir(dir, { recursive: true });
    // Eight more with the same time as `first`. A folder's files come back in no promised order, and
    // these names are unrelated to the ids, so only a sort by id can list all nine in id order.
    const ids = ["7", "2", "9", "4", "1", "8", "3", "6"].map((digit) => `${first.id.slice(0, -1)}${digit}`.replace(/^./, digit));
    for (const [index, id] of ids.entries()) await writeFile(join(dir, `tied-${index}.json`), JSON.stringify({ ...first, id, subject: `tied ${index}` }));
    expect((await store.list(repoKey)).map((item) => item.id)).toEqual([first.id, ...ids].sort());
  });
});
