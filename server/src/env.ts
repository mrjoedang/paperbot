import type { Directory } from "./directory";
import type { Inbox, TaskList } from "./inbox";
import type { WorkAgent } from "./agent";
import type { PipelineParams } from "./pipeline";

export interface Env {
  AI: Ai;
  AUDIO: R2Bucket;
  ASSETS: Fetcher; // public/ (web app), served through the Worker so auth runs first
  INBOX: DurableObjectNamespace<Inbox>;
  DIRECTORY: DurableObjectNamespace<Directory>; // accounts, device tokens, setup sign-ins (one object)
  TASKS: DurableObjectNamespace<TaskList>; // legacy (v1) task list, read only: used by /admin/migrate-legacy
  WorkAgent: DurableObjectNamespace<WorkAgent>;
  PIPELINE: Workflow<PipelineParams>;
  DEVICE_TOKEN: string;
  WIFI_KEY: string; // secret: 32 random bytes, base64 (AES-GCM key for stored Wi-Fi passwords)
  GATEWAY_ID: string;
  TZ: string; // user time zone for relative dates ("tomorrow at 3")
  WEB_SEARCH: string;
  SEARCH_PROVIDER: string;
  TEST_HOOKS: string; // "1" (test deployment only): X-Test-* request headers, /admin/test/*, the /admin/app/ test mount
  APP_ORIGIN: string; // the app's address (https://app.paperbot.ca); web pages on any other address redirect there. Empty locally
  OWNER_EMAIL: string; // secret: the owner (signed in with a verified address): inbox "default", research included
  AUTH_DB: D1Database; // Better Auth: users, sessions, passkeys, device codes, OAuth clients and tokens
  BETTER_AUTH_SECRET: string;
  GOOGLE_CLIENT_ID: string; // Google sign-in (public); the secret is GOOGLE_CLIENT_SECRET
  GOOGLE_CLIENT_SECRET: string;
  // The address a board is told to reach this server at (setup's claim). Unset: the page's own. Locally, the Mac's LAN
  // address while the page stays on loopback (tools/e2e/setup-openbelt.mjs --real-board).
  BOARD_SERVER?: string;
  OPENBELT_URL: string; // where app memos are built (src/openbelt.ts): https://openbelt.com, staging on dev
}

/** One Inbox Durable Object per person: "default" = the owner, "u:<email>" = everyone else (Directory). */
export const inbox = (env: Env, name = "default") => env.INBOX.get(env.INBOX.idFromName(name));
/** R2 key of a per-person object (audio, reports): the owner keeps the original flat keys. */
export const objKey = (box: string, dir: "audio" | "reports" | "bad", id: string, ext: string) =>
  box === "default" ? `${dir}/${id}${ext}` : `${dir}/${box}/${id}${ext}`;
export const directory = (env: Env) => env.DIRECTORY.get(env.DIRECTORY.idFromName("directory"));

import { getAgentByName } from "agents";
/** Typed stub for the WorkAgent of one record. Named per inbox, so two accounts' records with the same id never
 *  share an agent; the owner's ("default") keep the bare record id they had before accounts existed. */
export async function agentStub(env: Env, box: string, id: string): Promise<DurableObjectStub<WorkAgent>> {
  return (await getAgentByName(env.WorkAgent as any, box === "default" ? id : `${box}:${id}`)) as unknown as DurableObjectStub<WorkAgent>;
}
