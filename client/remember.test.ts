import { describe, expect, it } from "vitest";
import { BUILTIN_TYPES } from "../shared/memory";
import { parseRemember } from "./remember";

describe("parseRemember", () => {
  it("defaults to a repo reference", () => {
    expect(parseRemember("Deploys go through make release", BUILTIN_TYPES)).toEqual({ scope: "repo", type: "reference", subject: "Deploys go through make release", body: "Deploys go through make release" });
  });

  it("reads --global and a type prefix", () => {
    expect(parseRemember("--global preference: Never commit without asking", BUILTIN_TYPES)).toMatchObject({ scope: "global", type: "preference", body: "Never commit without asking" });
  });

  it("keeps an unknown prefix as part of the fact", () => {
    expect(parseRemember("note: keep this", BUILTIN_TYPES).body).toBe("note: keep this");
  });

  it("reads a custom type prefix only when the user listed that type", () => {
    const types = ["reference", "eval-trap"];
    expect(parseRemember("eval-trap: Local eval needs --local-images", types)).toMatchObject({ type: "eval-trap", body: "Local eval needs --local-images" });
    expect(parseRemember("runbook: Run make release", types)).toMatchObject({ type: "reference", body: "runbook: Run make release" });
    expect(parseRemember("eval-trap: Local eval needs --local-images", BUILTIN_TYPES)).toMatchObject({ type: "reference", body: "eval-trap: Local eval needs --local-images" });
  });

  it("explains an empty fact", () => {
    expect(() => parseRemember("--global ", BUILTIN_TYPES)).toThrow(/Write the fact after \/remember/);
  });
});
