// File-glob matching without backtracking. Node's matchesGlob backtracks: a stored glob with a
// dozen `*` could take minutes on one file name, and every new agent in the project waited for it.
// Globs are stored data written by agents and background workers, so the matcher, not the writer,
// has to be safe for any glob. One path costs at most (alternatives of the `{a,b}` group) x
// (glob length) x (path length) steps: a few milliseconds for the longest glob a memory may hold.
// A caller matching many paths bounds the total with its own time budget (see PathMatcher).
//
// The rules, which give Node's answers for the globs memories use: `*` and `?` stay inside one
// path segment; `**` as a whole segment spans any number of segments; `[abc]` and `[a-z]` match one
// character; a `{a,b}` group with a comma gives alternatives (without one it is plain text); empty
// and "." segments are ignored in the glob and in the path; a glob ending in "/" matches only a
// path ending in "/"; a segment starting with "." is
// matched only by a pattern segment that starts with "." or with a bracket class holding ".", and never by `**`; a `**` that
// ends a longer pattern needs at least one segment (`src/**` is not `src` itself); and letter case
// is ignored where Node ignores it: on macOS and Windows, in pattern segments that hold a wildcard.
// Node has further special cases this matcher does not copy; glob.test.ts names the ones found.

const CASELESS_PLATFORM = process.platform === "darwin" || process.platform === "win32";

type Token = { any: true } | { one: true } | { chars: string; ranges: [string, string][] } | { literal: string };

function tokens(segment: string): Token[] {
  const out: Token[] = [];
  for (let i = 0; i < segment.length; i += 1) {
    const char = segment[i];
    if (char === "*") {
      // A run of stars inside a segment is one star.
      if (!(out.length > 0 && "any" in out[out.length - 1])) out.push({ any: true });
    } else if (char === "?") {
      out.push({ one: true });
    } else if (char === "[" && segment.indexOf("]", i + 2) !== -1) {
      const end = segment.indexOf("]", i + 2);
      const body = segment.slice(i + 1, end);
      const set: { chars: string; ranges: [string, string][] } = { chars: "", ranges: [] };
      for (let j = 0; j < body.length; j += 1) {
        if (body[j + 1] === "-" && j + 2 < body.length) {
          set.ranges.push([body[j], body[j + 2]]);
          j += 2;
        } else {
          set.chars += body[j];
        }
      }
      // A class of one character is that character, as plain text (so it keeps its case).
      out.push(set.ranges.length === 0 && set.chars.length === 1 ? { literal: set.chars } : set);
      i = end;
    } else {
      out.push({ literal: char });
    }
  }
  return out;
}

function tokenMatches(token: Token, char: string, ignoreCase: boolean): boolean {
  if ("one" in token) return true;
  if ("literal" in token) return ignoreCase ? token.literal.toLowerCase() === char.toLowerCase() : token.literal === char;
  if ("chars" in token) {
    const candidates = ignoreCase ? [char.toLowerCase(), char.toUpperCase()] : [char];
    return candidates.some((candidate) => token.chars.includes(candidate) || token.ranges.some(([from, to]) => candidate >= from && candidate <= to));
  }
  return false;
}

// One path segment against one pattern segment. `reach[j]` says whether the first j tokens can
// match the text read so far, so each character costs one pass over the tokens: no backtracking.
function segmentMatches(text: string, pattern: Token[]): boolean {
  const first = pattern[0];
  const takesDot = first !== undefined && (("literal" in first && first.literal === ".") || ("chars" in first && first.chars.includes(".")));
  if (text.startsWith(".") && !takesDot) return false;
  const ignoreCase = CASELESS_PLATFORM && pattern.some((token) => !("literal" in token));
  let reach = new Array<boolean>(pattern.length + 1).fill(false);
  reach[0] = true;
  for (let j = 0; j < pattern.length && "any" in pattern[j]; j += 1) reach[j + 1] = true;
  for (const char of text) {
    const next = new Array<boolean>(pattern.length + 1).fill(false);
    for (let j = 0; j < pattern.length; j += 1) {
      const token = pattern[j];
      if ("any" in token) next[j + 1] = reach[j + 1] || next[j];
      else next[j + 1] = reach[j] && tokenMatches(token, char, ignoreCase);
    }
    reach = next;
  }
  return reach[pattern.length];
}

function expandBraces(glob: string): string[] {
  const open = glob.indexOf("{");
  const close = open === -1 ? -1 : glob.indexOf("}", open);
  if (close === -1 || !glob.slice(open, close).includes(",")) return [glob];
  const choices = new Set(glob.slice(open + 1, close).split(","));
  return [...choices].map((choice) => glob.slice(0, open) + choice + glob.slice(close + 1));
}

const realSegments = (text: string) => text.split("/").filter((segment) => segment !== "" && segment !== ".");

// null stands for `**`; a run of them is one.
function compileSegments(pattern: string): (Token[] | null)[] {
  const segments: (Token[] | null)[] = [];
  for (const segment of realSegments(pattern)) {
    if (segment !== "**") segments.push(tokens(segment));
    else if (segments[segments.length - 1] !== null) segments.push(null);
  }
  return segments;
}

function segmentsMatch(path: string[], segments: (Token[] | null)[]): boolean {
  // reach[i]: the pattern segments read so far can match the first i path segments.
  let reach = new Array<boolean>(path.length + 1).fill(false);
  reach[0] = true;
  segments.forEach((segment, index) => {
    const next = new Array<boolean>(path.length + 1).fill(false);
    if (segment === null) {
      // `**` takes whole segments, none of them starting with ".": zero or more, or one or more
      // when it ends a longer pattern.
      const needsOne = index > 0 && index === segments.length - 1;
      for (let i = 0; i <= path.length; i += 1) {
        const extended = i > 0 && !path[i - 1].startsWith(".") && (next[i - 1] || (needsOne && reach[i - 1]));
        next[i] = (!needsOne && reach[i]) || extended;
      }
    } else {
      for (let i = 0; i < path.length; i += 1) next[i + 1] = reach[i] && segmentMatches(path[i], segment);
    }
    reach = next;
  });
  return reach[path.length];
}

// Reads the glob once; the returned function answers for one path at a time.
export function compileGlob(glob: string): (path: string) => boolean {
  const alternatives = expandBraces(glob).map((pattern) => ({ segments: compileSegments(pattern), folderOnly: pattern.endsWith("/") }));
  return (path) => {
    const segments = realSegments(path);
    const isFolder = path.endsWith("/");
    return alternatives.some((alternative) => (isFolder || !alternative.folderOnly) && segmentsMatch(segments, alternative.segments));
  };
}
