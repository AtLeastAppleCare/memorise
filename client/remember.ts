import { MAX_SUBJECT_CHARS, type MemoryType, type Scope } from "../shared/memory";

export interface RememberRequest {
  scope: Scope;
  type: MemoryType;
  subject: string;
  body: string;
}

export const REMEMBER_HINT = "[--global] [type:] <fact>";

// `/remember [--global] [type:] <fact>`. Without a type the fact is a reference; without --global it
// belongs to the workspace's repo. A `word:` prefix is a type only when it is one of `types`, the
// types that may be chosen now; any other prefix is part of the fact.
export function parseRemember(args: string, types: readonly string[]): RememberRequest {
  let rest = args.trim();
  let scope: Scope = "repo";
  if (/^--global\b/.test(rest)) {
    scope = "global";
    rest = rest.replace(/^--global\b/, "").trim();
  }
  let type: MemoryType = "reference";
  const typed = /^([a-z][a-z0-9-]*):\s*/.exec(rest);
  if (typed && types.includes(typed[1])) {
    type = typed[1];
    rest = rest.slice(typed[0].length);
  }
  const body = rest.trim();
  if (body === "") throw new Error(`Write the fact after /remember, like: /remember ${REMEMBER_HINT}`);
  const firstLine = body.split("\n")[0];
  const subject = firstLine.length > MAX_SUBJECT_CHARS ? `${firstLine.slice(0, MAX_SUBJECT_CHARS - 1)}…` : firstLine;
  return { scope, type, subject, body };
}
