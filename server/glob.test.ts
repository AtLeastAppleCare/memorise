import { matchesGlob } from "node:path/posix";
import { describe, expect, it } from "vitest";
import { compileGlob } from "./glob";

const globMatches = (path: string, glob: string) => compileGlob(glob)(path);

const GLOBS = [
  "src/**/*.ts",
  "docs/**",
  "**",
  "*",
  "*.md",
  "src/*",
  "src/**",
  "src/**/",
  "**/*.test.ts",
  "a/b/c.ts",
  "src/{api,db}/*.ts",
  "{src,docs}/**",
  "*.{ts,tsx}",
  "src/api/user?.ts",
  "src/[ab]pi/*.ts",
  "[a-c]*.ts",
  "**/api/**",
  ".github/**",
  "**/.env",
  "src/*/*.ts",
  "src/**/**/x.ts",
  "a**b/c",
  "Makefile",
  "src/api/*",
  "**/x.ts",
  "src//a.ts",
  "src/./a.ts",
  "[.]env",
  "{src}/a.ts",
  "a{}b",
  "**/{src,docs,}/**",
  "src/a.ts/",
  "[s]rc/x.ts",
  "a[.]ts",
];

const PATHS = [
  "src/a/b.ts",
  "src/a.ts",
  "src",
  "README.md",
  "docs/x/y.md",
  "docs",
  "a/b/c.ts",
  "src/api/users.ts",
  "src/api/Users.ts",
  "src/db/x.ts",
  "src/api/user1.ts",
  "src/api/users.test.ts",
  ".github/workflows/ci.yml",
  ".env",
  "src/.env",
  "src/.hidden/x.ts",
  "Makefile",
  "makefile",
  "x.tsx",
  "a.ts",
  "c.ts",
  "d.ts",
  "src/x.ts",
  "src/a/b/x.ts",
  "aXXb/c",
  "x.ts",
  "ab",
  "SRC/x.ts",
  "A.ts",
  ".ENV",
  "{src}/a.ts",
  "src/a.ts/",
  "",
];

describe("globMatches", () => {
  it("agrees with Node's matcher on the globs memories use", () => {
    const differences = GLOBS.flatMap((glob) => PATHS.filter((path) => globMatches(path, glob) !== matchesGlob(path, glob)).map((path) => `${glob} on ${path}: Node says ${matchesGlob(path, glob)}`));
    expect(differences).toEqual([]);
  });

  it("answers at once for globs that make a backtracking matcher take seconds or minutes", () => {
    const started = Date.now();
    // 12 stars took Node's matcher about 25 seconds on this name; these have up to 60.
    expect(globMatches("a".repeat(40), `${"*a".repeat(12)}b`)).toBe(false);
    expect(globMatches("a".repeat(120), `${"*a".repeat(60)}b`)).toBe(false);
    expect(globMatches("a".repeat(120), `${"*a".repeat(60)}`)).toBe(true);
    expect(globMatches("src/components/settings/MemoryProposalReviewPanel.test.tsx", `**/${"*[a-z]".repeat(32)}0`)).toBe(false);
    expect(globMatches(`${"a/".repeat(60)}b`, `${"**/a/".repeat(30)}c`)).toBe(false);
    expect(Date.now() - started).toBeLessThan(500);
  });

  it("keeps to its own stated rules where Node's matcher has special cases", () => {
    // Node says false here, though it matches `src/**/.env` on `src/y/.env`: a ".env" segment is
    // matched by a ".env" pattern segment wherever it sits.
    expect(globMatches("x/src/y/.env", "**/src/**/.env")).toBe(true);
    // Node lets `**` take a ".." segment and refuses `.?` on ".."; here a segment starting with "."
    // is matched only by a pattern segment that starts with ".".
    expect(globMatches("c/..", "**")).toBe(false);
    expect(globMatches("..", ".?")).toBe(true);
    // Node refuses a class of several characters for a leading "."; here a class holding "." takes it.
    expect(globMatches(".env", "[a.]env")).toBe(true);
  });

  it("treats an unclosed bracket or brace as plain text", () => {
    expect(globMatches("a[b", "a[b")).toBe(true);
    expect(globMatches("a{b", "a{b")).toBe(true);
  });
});
