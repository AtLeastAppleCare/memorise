import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { repoKeySchema } from "../shared/memory";

const SECRET_BYTES = 32;

export const agentScopeSchema = z.object({
  repoKey: repoKeySchema.nullable(),
  cwd: z.string().min(1),
  provider: z.string().min(1),
  agentId: z.string().min(1).optional(),
});
export type AgentScope = z.infer<typeof agentScopeSchema>;

// Legacy saved endpoints use stateless signed tokens that survive restarts. New endpoints use
// random in-memory credentials, revoked only when their host-owned launch lifetime is disposed.
export class TokenAuthority {
  private readonly launches = new Map<string, AgentScope>();

  constructor(private readonly secret: Buffer) {
    if (secret.length !== SECRET_BYTES) throw new Error(`Expected a ${SECRET_BYTES}-byte token secret, got ${secret.length} bytes`);
  }

  private sign(payload: string): Buffer {
    return createHmac("sha256", this.secret).update(payload).digest();
  }

  mint(scope: AgentScope): string {
    const payload = Buffer.from(JSON.stringify(agentScopeSchema.parse(scope))).toString("base64url");
    return `${payload}.${this.sign(payload).toString("base64url")}`;
  }

  mintLaunch(scope: AgentScope): { token: string; dispose: () => void } {
    const token = `launch.${randomBytes(32).toString("base64url")}`;
    this.launches.set(token, agentScopeSchema.parse(scope));
    return { token, dispose: () => { this.launches.delete(token); } };
  }

  verify(authorization: string | undefined): AgentScope | null {
    if (authorization?.startsWith("Bearer launch.")) return this.launches.get(authorization.slice(7)) ?? null;
    const match = /^Bearer ([A-Za-z0-9_-]+)\.([A-Za-z0-9_-]+)$/.exec(authorization ?? "");
    if (!match) return null;
    const expected = this.sign(match[1]);
    const given = Buffer.from(match[2], "base64url");
    if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null;
    const parsed = agentScopeSchema.safeParse(JSON.parse(Buffer.from(match[1], "base64url").toString("utf8")));
    return parsed.success ? parsed.data : null;
  }
}

// Created once with mode 0600. Deleting the file invalidates every token already handed out.
export async function loadTokenSecret(root: string): Promise<Buffer> {
  const path = join(root, "secret");
  await mkdir(root, { recursive: true, mode: 0o700 });
  try {
    await writeFile(path, randomBytes(SECRET_BYTES), { flag: "wx", mode: 0o600 });
  } catch (error) {
    if (Reflect.get(Object(error), "code") !== "EEXIST") throw error;
  }
  return readFile(path);
}
