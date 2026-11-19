// The chat on the server: one document for each room, changed only here, so every message is
// checked first. The app says who is in a room and what to call them; the chat does the rest.
//
//   import { createSyncServer } from "@zubra/sync/server";
//   import { createChat, chatAuthorize } from "@journey-to-code/chat/server";
//
//   const sync = createSyncServer({ mount: "/_zb/chat", log, authorize: (from) => follow(from) });
//   const chat = createChat(sync, { notify, mask });
//   const follow = chatAuthorize(chat, { member: (request, key) => memberOf(request, key) });
//
//   // and in the app's own route for a room, once it knows the room and who is asking:
//   const { status, body } = await chat.handle(room, me, request.method, input);
//
// Members' pages follow their rooms live through Zubra Sync (`/_zb/chat` above, with
// `openChat()` and `<chat-room>` on the page); the app's route is how they change them.
import { LIMITS, type ChatDocument, type ChatMember, type ChatMessage, type ChatRoom } from "./types.js";

/** What the chat needs of a Zubra Sync server (`createSyncServer()` from `@zubra/sync/server`). */
export interface ChatSync {
  write(collection: string, key: string, fields: Record<string, unknown>): Promise<unknown>;
  documents(): Promise<{ get(collection: string, key: string): Record<string, unknown> | undefined }>;
}

export interface ChatReply {
  status: number;
  body: unknown;
}

/** A notice for members who aren't looking: the app sends it (a push, an email, a badge). */
export interface ChatNotice {
  room: ChatRoom;
  /** Who said it, and the message. */
  from: ChatMember;
  message: ChatMessage;
  /** A line to show: the message, or the poll's question, cut to 120 characters. */
  body: string;
}

export interface ChatOptions {
  /** The collection the rooms' documents are kept in. Pages must use the same one. Default `chats`. */
  collection?: string;
  /**
   * Where each room's read markers are kept (the last message each member has seen, for
   * `unread`): one document per room, which pages are never sent. Default `<collection>-seen`.
   */
  seenCollection?: string;
  /**
   * Tell members who aren't looking that something was said. Called at most once every
   * `notifyEvery` for each member, and never for one whose page is open on the room.
   */
  notify?: (to: ChatMember[], notice: ChatNotice) => void;
  /** Default: five minutes. */
  notifyEvery?: number;
  /**
   * Cover crude words, for rooms whose managers switch the filter on. Without it the filter can't
   * be switched on (the app knows its own word lists and its own languages).
   */
  mask?: (text: string) => string;
  /** A member may say this many things in `burstMs` at most. Default 5 in 10 seconds. */
  burst?: number;
  burstMs?: number;
  /**
   * Before a person's words are added (a message, or a poll's question and each of its answers):
   * return the words to post, changed perhaps, or `{ error }` to turn them away with a reason. For
   * what the app knows and the chat doesn't: a muted player, a closed table, words covered always.
   * Changes to the room wait for it, so it mustn't wait for one itself (a `post` to the same room).
   */
  beforeSay?: (event: { room: ChatRoom; me: ChatMember; text: string }) => string | { error: string } | Promise<string | { error: string }>;
  /** After a person says something or asks (not after `post`): a bot's answer, a log. */
  onSay?: (event: { room: ChatRoom; me: ChatMember; message: ChatMessage }) => void;
  /** The clock, for tests. */
  now?: () => number;
}

/**
 * Someone heard from this recently has the room open: they are "here", and get no notice. A page
 * says so with each presence heartbeat (every 10 seconds; Sync drops a viewer after 30) or by
 * reading the room through `handle`.
 */
export const LOOKING = 35_000;

const empty = (): ChatDocument => ({ messages: [], rev: 0, next: 1, filter: false });

/** One line: whatever was pasted, without its line breaks and the spaces around them. */
const line = (value: unknown) => (typeof value === "string" ? value.replace(/\s+/g, " ").trim() : "");

export function createChat(sync: ChatSync, options: ChatOptions = {}) {
  const collection = options.collection ?? "chats";
  const seenCollection = options.seenCollection ?? `${collection}-seen`;
  const { notify, mask, beforeSay, onSay, burst = 5, burstMs = 10_000, notifyEvery = 5 * 60_000 } = options;
  const clock = options.now ?? Date.now;

  const read = async (key: string): Promise<ChatDocument> => {
    const doc = (await sync.documents()).get(collection, key);
    if (!doc) return empty();
    return {
      messages: Array.isArray(doc.messages) ? structuredClone(doc.messages as ChatMessage[]) : [],
      rev: typeof doc.rev === "number" ? doc.rev : 0,
      next: typeof doc.next === "number" ? doc.next : 1,
      filter: doc.filter === true,
    };
  };
  const keep = (key: string, chat: ChatDocument) => sync.write(collection, key, { ...chat });

  // Each change to a room reads it, may wait (the app's `beforeSay`), and writes it whole: one at a
  // time for each room, so two at once don't both start from the same document and lose one.
  const turns = new Map<string, Promise<unknown>>();
  function inTurn<T>(key: string, change: () => Promise<T>): Promise<T> {
    const next = (turns.get(key) ?? Promise.resolve()).then(change);
    const settled = next.catch(() => undefined);
    turns.set(key, settled);
    void settled.then(() => turns.get(key) === settled && turns.delete(key));
    return next;
  }

  // Kept in memory: losing them at a restart costs one extra notice at most.
  const said = new Map<string, number[]>();
  const looked = new Map<string, number>();

  // What each member has seen: the last message there was when their page last had the room open.
  const seenIn = async (key: string): Promise<Record<string, number>> => ((await sync.documents()).get(seenCollection, key) as Record<string, number> | undefined) ?? {};
  // One at a time for each room, so two at once (two tabs' heartbeats) don't both write.
  const seeing = new Map<string, Promise<void>>();
  function see(key: string, member: string): Promise<void> {
    const next = (seeing.get(key) ?? Promise.resolve()).then(async () => {
      const last = (await read(key)).messages.at(-1)?.id ?? 0;
      // Written only when it moves on: a heartbeat every ten seconds mustn't fill the log.
      if (((await seenIn(key))[member] ?? 0) < last) await sync.write(seenCollection, key, { [member]: last });
    });
    const settled = next.catch(() => undefined);
    seeing.set(key, settled);
    void settled.then(() => seeing.get(key) === settled && seeing.delete(key));
    return next;
  }
  const notified = new Map<string, number>();
  const at = (room: string, member: string) => `${room}\u0000${member}`;

  /** The members with the room open, by id, in the room's own order. The one asking is always among them. */
  const here = (room: ChatRoom, me: ChatMember, now: number) => room.members.filter((m) => m.id === me.id || now - (looked.get(at(room.key, m.id)) ?? -Infinity) < LOOKING).map((m) => m.id);

  const shown = (room: ChatRoom, me: ChatMember, chat: ChatDocument, now: number) => ({
    rev: chat.rev,
    here: here(room, me, now),
    messages: chat.messages.map((m) => ({ ...m, mine: m.by === me.id })),
    /** Whether this member may take down what others said, and switch the filter. */
    manager: me.manager === true,
    filter: chat.filter,
    /** Whether the filter can be switched on at all. */
    canFilter: mask !== undefined,
    limits: LIMITS,
    others: room.members.length - 1,
  });

  function tell(room: ChatRoom, me: ChatMember, message: ChatMessage, now: number) {
    if (!notify) return;
    const to = room.members.filter((m) => {
      if (m.id === me.id) return false;
      const them = at(room.key, m.id);
      if (now - (looked.get(them) ?? -Infinity) < LOOKING || now - (notified.get(them) ?? -Infinity) < notifyEvery) return false;
      notified.set(them, now);
      return true;
    });
    const text = message.poll ? `📊 ${message.text}` : message.text;
    if (to.length) notify(to, { room, from: me, message, body: text.length > 120 ? `${text.slice(0, 117)}…` : text });
  }

  return {
    collection,

    /** A room's document as it stands, for the app (a room's page drawn on the server, say). */
    read,

    /** Start a room over: a new room under an old one's key doesn't inherit its conversation. */
    clear: (key: string) =>
      inTurn(key, async () => {
        const chat = await read(key);
        if (chat.messages.length || chat.filter) await keep(key, { messages: [], rev: chat.rev + 1, next: chat.next, filter: false });
      }),

    /**
     * A member has the room open (a presence heartbeat): no notice for them for a while, and
     * everything said so far is seen.
     */
    looking(key: string, member: string, now = clock()) {
      looked.set(at(key, member), now);
      void see(key, member).catch(() => undefined);
    },

    /**
     * How many messages a member hasn't seen: what others said since their page last had the room
     * open. A member who has never opened it hasn't seen any.
     */
    async unread(key: string, member: string): Promise<number> {
      const seen = (await seenIn(key))[member] ?? 0;
      return (await read(key)).messages.filter((m) => m.id > seen && m.by !== member && !m.notice).length;
    },

    /**
     * Words from the app itself, past every check a person's go through: a computer player's
     * (`{ bot: true }`, as `speaker`), or a notice to the room (`{ notice: true }`, no speaker).
     * Nobody is notified. Resolves to the message, or to why there's none (nothing to say).
     */
    post: (key: string, speaker: { id: string; name: string } | null, text: string, { bot = false, notice = false }: { bot?: boolean; notice?: boolean } = {}, now = clock()): Promise<ChatMessage | string> =>
      inTurn(key, async () => {
        const words = line(text).slice(0, LIMITS.message);
        if (!words) return "Nothing to say.";
        const chat = await read(key);
        const message: ChatMessage = { id: chat.next, by: notice ? "" : (speaker?.id ?? ""), name: notice ? "" : (speaker?.name ?? ""), at: now, text: words, ...(bot && !notice ? { bot: true as const } : {}), ...(notice ? { notice: true as const } : {}) };
        chat.messages = [...chat.messages, message].slice(-LIMITS.kept);
        chat.next += 1;
        chat.rev += 1;
        await keep(key, chat);
        return message;
      }),

    /** Take a message down, for the app's own moderators. Resolves to it, or null when there's no such message. */
    redact: (key: string, id: number): Promise<ChatMessage | null> =>
      inTurn(key, async () => {
        const chat = await read(key);
        const message = chat.messages.find((m) => m.id === id);
        if (!message) return null;
        chat.messages = chat.messages.filter((m) => m !== message);
        chat.rev += 1;
        await keep(key, chat);
        return message;
      }),

    /**
     * A room's route, for a member of it. The app finds the room and the member; anyone else
     * should get the app's own "not here" before this is called.
     *   GET  [?rev=]                         → { rev, here, messages, manager, filter, canFilter, limits, others }, or just { rev, here } when that is the rev the page has
     *   POST { text }                        → the same, with the message said (201); 429 when they are saying too much at once
     *   POST { poll: { question, options } } → the same, with a poll asked (201)
     *   POST { vote: { id, option } }        → the same, with this member's vote on that poll (option null takes it back)
     *   POST { remove: id }                  → the same, without it: one's own, or anyone's for a manager
     *   POST { filter: boolean }             → the same, with crude words covered from now on, or not (managers)
     */
    async handle(room: ChatRoom, me: ChatMember, method: string, input: Record<string, unknown> = {}, query: URLSearchParams = new URLSearchParams(), now = clock()): Promise<ChatReply> {
      const reply = await inTurn(room.key, () => answer(room, me, method, input, query, now));
      // Whoever reads the room, or says something in it, has seen what's there.
      if (reply.status < 400) await see(room.key, me.id);
      return reply;
    },
  };

  async function answer(room: ChatRoom, me: ChatMember, method: string, input: Record<string, unknown>, query: URLSearchParams, now: number): Promise<ChatReply> {
    {
      const who = at(room.key, me.id);
      const chat = await read(room.key);
      const saved = async (status = 200) => {
        chat.rev += 1;
        await keep(room.key, chat);
        return { status, body: shown(room, me, chat, now) };
      };
      looked.set(who, now);

      if (method === "GET") {
        if (query.has("rev") && Number(query.get("rev")) === chat.rev) return { status: 200, body: { rev: chat.rev, here: here(room, me, now) } };
        return { status: 200, body: shown(room, me, chat, now) };
      }
      if (method !== "POST") return { status: 405, body: { error: "A chat is read with GET and changed with POST." } };

      if (input.remove !== undefined) {
        const message = chat.messages.find((m) => m.id === input.remove);
        // Already gone is the same as taken down: the page is shown the chat as it stands.
        if (!message) return { status: 200, body: shown(room, me, chat, now) };
        if (message.by !== me.id && !me.manager) return { status: 403, body: { error: "Only someone who runs this room can take down what someone else said." } };
        chat.messages = chat.messages.filter((m) => m !== message);
        return saved();
      }

      if (input.filter !== undefined) {
        if (!me.manager) return { status: 403, body: { error: "Only someone who runs this room can change that." } };
        if (typeof input.filter !== "boolean") return { status: 400, body: { error: "On or off?" } };
        if (input.filter && !mask) return { status: 400, body: { error: "This chat can't cover words." } };
        if (chat.filter === input.filter) return { status: 200, body: shown(room, me, chat, now) };
        chat.filter = input.filter;
        return saved();
      }

      const mute = { status: 403, body: { error: "You can't speak here." } };
      if (input.vote !== undefined) {
        if (me.canSpeak === false) return mute;
        const vote = input.vote as { id?: unknown; option?: unknown } | null;
        const message = chat.messages.find((m) => m.id === vote?.id);
        if (!message?.poll) return { status: 404, body: { error: "That poll has been taken down." } };
        const option = vote?.option;
        if (option === null) delete message.poll.votes[me.id];
        else if (typeof option === "number" && Number.isInteger(option) && option >= 0 && option < message.poll.options.length) message.poll.votes[me.id] = option;
        else return { status: 400, body: { error: "That isn't one of the answers." } };
        return saved();
      }

      // Saying something, or asking: either is a new message, and counts against saying too much at once.
      if (me.canSpeak === false) return mute;
      const words = chat.filter && mask ? mask : (text: string) => text;
      // The app's say on each piece of words, after the room's own filter.
      const checked = async (text: string): Promise<string | { error: string }> => (beforeSay ? beforeSay({ room, me, text: words(text) }) : words(text));
      let content: Pick<ChatMessage, "text" | "poll">;
      if (input.poll !== undefined) {
        const asked = input.poll as { question?: unknown; options?: unknown } | null;
        const question = line(asked?.question);
        const answers = Array.isArray(asked?.options) ? asked.options.map(line).filter(Boolean) : [];
        if (!question) return { status: 400, body: { error: "Ask a question first." } };
        if (question.length > LIMITS.question) return { status: 400, body: { error: `That question is too long: ${LIMITS.question} characters at most.` } };
        if (answers.length < 2 || answers.length > LIMITS.options) return { status: 400, body: { error: `Give two to ${LIMITS.options} answers.` } };
        if (answers.some((o) => o.length > LIMITS.option)) return { status: 400, body: { error: `Keep each answer to ${LIMITS.option} characters.` } };
        if (new Set(answers.map((o) => o.toLowerCase())).size !== answers.length) return { status: 400, body: { error: "Two of those answers are the same." } };
        const pieces = await Promise.all([question, ...answers].map(checked));
        const refused = pieces.find((p): p is { error: string } => typeof p !== "string");
        if (refused) return { status: 403, body: { error: refused.error } };
        const [said, ...options] = (pieces as string[]).map(line);
        if (!said || options.some((o) => !o)) return { status: 400, body: { error: "Ask a question first, with an answer in each box." } };
        content = { text: said, poll: { options, votes: {} } };
      } else {
        const text = line(input.text);
        if (!text) return { status: 400, body: { error: "Say something first." } };
        if (text.length > LIMITS.message) return { status: 400, body: { error: `That's too long: ${LIMITS.message} characters at most.` } };
        const piece = await checked(text);
        if (typeof piece !== "string") return { status: 403, body: { error: piece.error } };
        if (!line(piece)) return { status: 400, body: { error: "Say something first." } };
        content = { text: line(piece).slice(0, LIMITS.message) };
      }
      const recent = (said.get(who) ?? []).filter((t) => now - t < burstMs);
      if (recent.length >= burst) return { status: 429, body: { error: "Give the others a moment to answer." } };
      said.set(who, [...recent, now]);

      const message: ChatMessage = { id: chat.next, by: me.id, name: me.name, at: now, ...content };
      chat.messages = [...chat.messages, message].slice(-LIMITS.kept);
      chat.next += 1;
      const reply = await saved(201);
      tell(room, me, message, now);
      onSay?.({ room, me, message });
      return reply;
    }
  }
}

export type Chat = ReturnType<typeof createChat>;

/** What Zubra Sync's `authorize` is given (`createSyncServer({ authorize })`). */
export interface SyncRequest {
  request: Request;
  collection: string;
  key: string;
  kind: "change" | "presence" | "read";
}

/**
 * The `authorize` for a chat's Zubra Sync server: a room's members may read it and say they're
 * there (presence); nobody but the server writes it. `member` finds who is asking in the room
 * under `key`, or null. A member's presence keeps their notices quiet while they're looking.
 * Anything outside the chat's collection is refused; give it to another server's `authorize`.
 */
export function chatAuthorize(chat: Pick<Chat, "collection" | "looking">, { member }: { member: (request: Request, key: string) => Promise<ChatMember | null | undefined> | ChatMember | null | undefined }) {
  return async ({ request, collection, key, kind }: SyncRequest): Promise<boolean> => {
    if (collection !== chat.collection || kind === "change") return false;
    const me = await member(request, key);
    if (!me) return false;
    if (kind === "presence") chat.looking(key, me.id);
    return true;
  };
}

export { LIMITS };
export type { ChatDocument, ChatMember, ChatMessage, ChatRoom };
