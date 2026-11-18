// The chat on the page: the connection that brings rooms live, and the ways to change one.
// Plain TypeScript that knows nothing of the page's framework; `<chat-room>` (from
// `@journey-to-code/chat-ui`) takes what `openChat()` returns as its `actions`.
//
//   import { openChat } from "@journey-to-code/chat/client";
//   const actions = openChat({ room: "house:parts", endpoint: "/houses/parts/chat" });
//   // then <chat-room doc="house:parts" me="m1" .members=${members} .actions=${actions}>
//
// What was said arrives through Zubra Sync: `connect()` follows the collection on the chat's Sync
// server, and the `<chat-feed>` inside `<chat-room>` holds the room's document and its presence.
// Nothing here reads the chat; it only sends what the person does to the app's route for the
// room, and pulls once after, so the change shows even while the live stream is reconnecting.
import { connect } from "@zubra/sync/connect";

/** What `<chat-room>` calls. Each resolves to what went wrong, or null when it's done. */
export interface ChatActions {
  say(text: string): Promise<string | null>;
  unsay(id: number): Promise<string | null>;
  ask(question: string, options: string[]): Promise<string | null>;
  vote(id: number, option: number | null): Promise<string | null>;
  setFilter(on: boolean): Promise<string | null>;
  /** Done with this room: nothing more is sent. (The page's connection stays, for the next room.) */
  stop(): void;
}

type Connection = { pull(): Promise<void>; stop(): void };
type Connect = (options: { url: string; scope: Record<string, true> }) => Connection;

export interface OpenChatOptions {
  /** The room's document key, as the server knows it: `house:parts`. */
  room: string;
  /** The app's route for this room (`chat.handle` on the server). Changes are POSTed there as JSON. */
  endpoint?: string;
  /** Or send them yourself: given the body, resolve when it's done, throw an Error whose message says what went wrong. */
  send?: (body: Record<string, unknown>) => Promise<unknown>;
  /** The chat's Sync server. Default `/_zb/chat`. */
  url?: string;
  /** The collection the rooms are kept in. Default `chats`. */
  collection?: string;
  /** For tests: what makes the connection. */
  connect?: Connect;
}

/** POST the body as JSON; an answer that isn't 2xx throws its `error`. */
export function postTo(endpoint: string) {
  return async (body: Record<string, unknown>) => {
    const response = await fetch(endpoint, { method: "POST", credentials: "same-origin", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    const answer = (await response.json().catch(() => ({}))) as { error?: string };
    if (!response.ok) throw new Error(answer.error ?? `The chat answered ${response.status}.`);
    return answer;
  };
}

// The page's connections, one for each Sync server, made on first use and kept open.
//
// Zubra Sync keeps one peer id for a page while each connection keeps its own live-stream key, so
// a connection stopped and another started at the same address is refused (409) until the server
// notices the first has gone, and then the page takes a new peer id. Kept open, that never happens.
// The scope is the whole collection: the server's `authorize` sends each member only their rooms.
const connections = new Map<Connect, Map<string, Connection>>();

/**
 * Open a room on this page. Call it before the room's `<chat-room>` starts, as Sync asks, so the
 * element waits for the connection's first pull and never shows last visit's chat over this one.
 */
export function openChat(options: OpenChatOptions): ChatActions {
  const { room, url = "/_zb/chat", collection = "chats" } = options;
  const open = options.connect ?? (connect as unknown as Connect);
  const send = options.send ?? (options.endpoint ? postTo(options.endpoint) : null);
  if (!send) throw new Error("openChat: give the room's endpoint, or a send function");

  let mine = connections.get(open);
  if (!mine) connections.set(open, (mine = new Map()));
  const key = `${url} ${collection}`;
  let live = mine.get(key);
  if (!live) mine.set(key, (live = open({ url, scope: { [collection]: true } })));
  const connection = live;

  let stopped = false;
  const attempt = async (body: Record<string, unknown>) => {
    if (stopped) return "The chat has closed.";
    try {
      await send(body);
      void connection.pull().catch(() => undefined);
      return null;
    } catch (e) {
      return e instanceof Error ? e.message : String(e);
    }
  };
  return {
    say: (text) => attempt({ text }),
    unsay: (id) => attempt({ remove: id }),
    ask: (question, answers) => attempt({ poll: { question, options: answers } }),
    vote: (id, option) => attempt({ vote: { id, option } }),
    setFilter: (on) => attempt({ filter: on }),
    stop() {
      stopped = true;
    },
  };
}

/** "3:42 PM" today, "Mon 3:42 PM" this week, "Nov 3" before that, in the page's own language. */
export function when(at: number, now = Date.now()): string {
  const then = new Date(at);
  const time = then.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  if (then.toDateString() === new Date(now).toDateString()) return time;
  if (now - at < 6 * 86_400_000) return `${then.toLocaleDateString([], { weekday: "short" })} ${time}`;
  return then.toLocaleDateString([], { month: "short", day: "numeric" });
}

export { tally, LIMITS } from "./types.js";
export type { ChatMessage, ChatPoll, ChatMember } from "./types.js";
