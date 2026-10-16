import { pluginRegistry, type ExternalLink } from "../../shared/plugins";
import {
  PluginError,
  safeUrl,
  serviceUrl,
  type PluginContext,
  type PluginDefinition,
} from "./index";

type Session = {
  id: string;
  name?: string;
  parentSessionId?: string | null;
  status: string;
  statusVersion?: number | null;
  workItems?: { source: string; url: string }[];
  links: { session: string };
};
type Snapshot = { sessions: Session[]; cursor: string };
type Event = {
  id: string;
  sequence?: number;
  type: string;
  data: {
    session?: Session;
    sessionId?: string;
    status?: string;
    version?: number;
    sessionIds?: string[];
    reviewRequest?: { url: string; title: string; status: string };
  };
};
type Feed = {
  events: Event[];
  cursor: string;
  truncated?: boolean;
  hasMore?: boolean;
};
type State = {
  cursor: string;
  sessions: Record<string, Session>;
  seen: string[];
  reviews: Record<
    string,
    { sessionIds: string[]; title: string; status: string }
  >;
};
class Fatal extends Error {
  constructor(readonly status: number) {
    super("r5d access unavailable");
  }
}
const fatalMessage = (status: number) =>
  status === 401
    ? "r5d rejected the team API key. Enter a valid key and save to restart."
    : "The r5d team was not found. Check the team URL name and save to restart.";
async function request<T>(context: PluginContext, suffix: string): Promise<T> {
  const base = serviceUrl(
    String(context.values.baseUrl),
    context.allowInsecureLocalhost,
  );
  const url = new URL(
    `${base.pathname.replace(/\/$/, "")}/api/v1/teams/${encodeURIComponent(String(context.values.team))}${suffix}`,
    base,
  );
  if (url.origin !== base.origin)
    throw new PluginError("Invalid r5d service URL");
  const response = await fetch(url, {
    headers: { Authorization: `Bearer ${context.values.apiKey}` },
    redirect: "error",
    signal: AbortSignal.any([context.signal, AbortSignal.timeout(45_000)]),
  });
  if (response.status === 401 || response.status === 404) {
    await response.body?.cancel();
    throw new Fatal(response.status);
  }
  if (!response.ok) {
    await response.body?.cancel();
    throw new Error("r5d request failed");
  }
  return response.json() as Promise<T>;
}
const statuses = new Set([
  "provisioning",
  "running",
  "waiting_for_input",
  "completed",
  "failed",
  "stopped",
  "idle",
]);
const label = (value: string) =>
  value.charAt(0).toUpperCase() + value.slice(1).replaceAll("_", " ");
const cursor = (value: unknown): value is string =>
  typeof value === "string" &&
  /^(0|[1-9]\d*)$/.test(value) &&
  Number.isSafeInteger(Number(value));
const ids = (value: unknown): value is string[] =>
  Array.isArray(value) && value.every((id) => typeof id === "string");
function validSession(value: unknown): value is Session {
  if (!value || typeof value !== "object") return false;
  const s = value as Session;
  if (
    typeof s.id !== "string" ||
    !s.id ||
    !statuses.has(s.status) ||
    (s.name !== undefined && typeof s.name !== "string") ||
    (s.parentSessionId != null && typeof s.parentSessionId !== "string") ||
    !s.links ||
    typeof s.links.session !== "string" ||
    (s.statusVersion != null &&
      (!Number.isSafeInteger(s.statusVersion) || s.statusVersion < 0)) ||
    (s.workItems !== undefined &&
      (!Array.isArray(s.workItems) ||
        !s.workItems.every(
          (item) =>
            item &&
            typeof item.source === "string" &&
            typeof item.url === "string",
        )))
  )
    return false;
  try {
    safeUrl(s.links.session);
  } catch {
    return false;
  }
  return true;
}
function issueIds(session: Session, context: PluginContext) {
  if (session.parentSessionId != null) return [];
  const base = new URL(context.baseUrl);
  const ids = new Set<string>();
  for (const item of session.workItems ?? []) {
    if (!item || item.source !== "threadline") continue;
    try {
      const url = new URL(item.url),
        match = /^\/w\/([a-z0-9]+(?:-[a-z0-9]+)*)\/issues\/([1-9]\d*)$/.exec(url.pathname);
      if (
        url.origin === base.origin &&
        !url.username &&
        !url.password &&
        !url.search &&
        !url.hash &&
        match && Number.isSafeInteger(Number(match[2]))
      ) {
        const issueId = context.resolveIssue(match[1]!, match[2]!);
        if (issueId) ids.add(issueId);
      }
    } catch {
      /* Foreign or malformed work item. */
    }
  }
  return [...ids];
}
function tone(status: string): ExternalLink["tone"] {
  return status === "completed" || status === "merged"
    ? "success"
    : status === "failed"
      ? "danger"
      : status === "waiting_for_input" || status === "stopped"
        ? "warning"
        : status === "running" || status === "provisioning" || status === "open"
          ? "info"
          : "neutral";
}
function render(context: PluginContext, state: State) {
  context.removeLinks();
  for (const session of Object.values(state.sessions))
    for (const issueId of issueIds(session, context)) {
      context.putLink(issueId, {
        externalId: `session:${session.id}`,
        title: session.name || "r5d session",
        url: session.links.session,
        status: label(session.status),
        tone: tone(session.status),
      });
    }
  for (const [url, review] of Object.entries(state.reviews)) {
    const ids = new Set(
      review.sessionIds.flatMap((id) =>
        state.sessions[id] ? issueIds(state.sessions[id], context) : [],
      ),
    );
    for (const issueId of ids)
      context.putLink(issueId, {
        externalId: `review:${url}`,
        title: review.title,
        url,
        status: label(review.status),
        tone: tone(review.status),
      });
  }
}
function pause(ms: number, signal: AbortSignal) {
  return new Promise<void>((resolve) => {
    if (signal.aborted) return resolve();
    const done = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    signal.addEventListener("abort", done, { once: true });
  });
}
export const r5dPlugin: PluginDefinition = {
  ...pluginRegistry.find((plugin) => plugin.id === "r5d")!,
  defaults: {
    baseUrl: "https://r5d.dev",
    team: "",
    projects: [],
  },
  publicFields: ["baseUrl", "team", "projects"],
  async check(context) {
    if (
      !/^[a-z0-9][a-z0-9-]{0,99}$/.test(String(context.values.team)) ||
      !/^r5d_team_[0-9a-f]{20}_[0-9a-f]{64}$/.test(
        String(context.values.apiKey),
      )
    )
      throw new PluginError("Invalid r5d team or team API key");
    for (const mapping of context.values.projects as {
      remote: string;
      defaultBranch: string;
    }[]) {
      if (
        mapping.defaultBranch.length > 200 ||
        !/^(?:https?:\/\/|ssh:\/\/|git:\/\/|[^\s@:]+@[^\s:]+:)/.test(
          mapping.remote,
        )
      )
        throw new PluginError("Invalid git remote or default branch");
    }
    try {
      await request(context, "");
    } catch (error) {
      throw new PluginError(
        error instanceof Fatal
          ? fatalMessage(error.status)
          : "Unable to check r5d team credentials",
      );
    }
  },
  async task(context) {
    const saved = context.get("feed") as State | undefined;
    let state: State = saved ?? {
      cursor: "",
      sessions: {},
      seen: [],
      reviews: {},
    };
    let list = !saved,
      failures = 0;
    while (!context.signal.aborted) {
      try {
        if (list) {
          const snapshot = await request<Snapshot>(context, "/sessions");
          if (context.signal.aborted) return;
          if (!Array.isArray(snapshot.sessions) || !cursor(snapshot.cursor))
            throw new Error("Invalid r5d snapshot");
          // Preserve known reviews for surviving sessions only. Newly changed PR
          // state cannot be recovered from this list; it needs a subsequent event.
          const currentIds = new Set(
            snapshot.sessions.filter(validSession).map((s) => s.id),
          );
          const reviews: State["reviews"] = {};
          for (const [url, review] of Object.entries(state.reviews)) {
            const sessionIds = review.sessionIds.filter((id) =>
              currentIds.has(id),
            );
            if (sessionIds.length) reviews[url] = { ...review, sessionIds };
          }
          state = {
            cursor: snapshot.cursor,
            sessions: Object.fromEntries(
              snapshot.sessions
                .filter(validSession)
                .map((session) => [session.id, session]),
            ),
            seen: [],
            reviews,
          };
          context.transaction(() => {
            render(context, state);
            context.set("feed", state);
          });
          list = false;
        }
        const feed = await request<Feed>(
          context,
          `/events?after=${encodeURIComponent(state.cursor)}&wait=30`,
        );
        if (context.signal.aborted) return;
        if (feed.truncated) {
          list = true;
          continue;
        }
        if (!Array.isArray(feed.events) || !cursor(feed.cursor))
          throw new Error("Invalid r5d feed");
        const next = structuredClone(state);
        let sequence = Number(state.cursor);
        for (const event of feed.events) {
          if (
            !event ||
            typeof event.id !== "string" ||
            !event.data ||
            next.seen.includes(event.id)
          )
            continue;
          // Cursor is the last committed sequence; replayed old pages cannot resurrect revoked sessions.
          if (event.sequence !== undefined) {
            if (
              !Number.isSafeInteger(event.sequence) ||
              event.sequence <= sequence
            )
              continue;
            sequence = event.sequence;
          }
          const data = event.data;
          if (event.type === "share.revoked" && ids(data.sessionIds)) {
            for (const id of data.sessionIds ?? []) delete next.sessions[id];
          } else if (
            event.type === "session.shared" &&
            validSession(data.session)
          ) {
            const previous = next.sessions[data.session.id];
            if (
              !previous ||
              (data.session.statusVersion ?? -1) >
                (previous.statusVersion ?? -1)
            )
              next.sessions[data.session.id] = data.session;
          } else if (
            event.type === "session.status" &&
            validSession(data.session) &&
            data.sessionId === data.session.id &&
            typeof data.version === "number" &&
            Number.isSafeInteger(data.version) &&
            data.version >= 0 &&
            typeof data.status === "string" &&
            statuses.has(data.status)
          ) {
            const previous = next.sessions[data.sessionId];
            if (data.version > (previous?.statusVersion ?? -1))
              next.sessions[data.sessionId] = {
                ...data.session,
                status: data.status,
                statusVersion: data.version,
              };
          } else if (
            event.type === "branch.review_request" &&
            data.reviewRequest &&
            ids(data.sessionIds)
          ) {
            try {
              safeUrl(data.reviewRequest.url);
            } catch {
              continue;
            }
            if (
              typeof data.reviewRequest.title !== "string" ||
              typeof data.reviewRequest.status !== "string"
            )
              continue;
            next.reviews[data.reviewRequest.url] = {
              sessionIds: data.sessionIds ?? [],
              title: data.reviewRequest.title,
              status: data.reviewRequest.status,
            };
          }
          next.seen.push(event.id);
        }
        if (Number(feed.cursor) < sequence)
          throw new Error("Invalid r5d cursor");
        next.seen = next.seen.slice(-10000);
        next.cursor =
          /^\d+$/.test(feed.cursor) &&
          /^\d+$/.test(state.cursor) &&
          BigInt(feed.cursor) < BigInt(state.cursor)
            ? state.cursor
            : feed.cursor;
        context.transaction(() => {
          render(context, next);
          context.set("feed", next);
        });
        state = next;
        failures = 0;
        context.status("running");
        // Real servers hold empty responses for 30s; avoid spinning against a broken proxy.
        if (!feed.hasMore && !feed.events.length)
          await pause(250, context.signal);
      } catch (error) {
        if (context.signal.aborted) return;
        if (error instanceof Fatal) {
          context.status("error", fatalMessage(error.status));
          console.error(`Plugin r5d: feed stopped (${error.status})`);
          return;
        }
        context.status(
          "retrying",
          "Unable to read the r5d feed; retrying automatically.",
        );
        console.error("Plugin r5d: feed request failed; retrying");
        await pause(
          Math.min(30_000, 1000 * 2 ** Math.min(failures++, 5)),
          context.signal,
        );
      }
    }
  },
};
