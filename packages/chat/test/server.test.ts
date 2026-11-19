// The chat on the server, against a real Zubra Sync server on a log in memory: what a room keeps,
// who may change what, polls, the filter, notices, and who may follow a room live.
import { createSyncServer, memoryLog } from "@zubra/sync/server";
import { describe, expect, it } from "vitest";
import { chatAuthorize, createChat, LIMITS, LOOKING, type ChatMember, type ChatNotice, type ChatRoom } from "../src/server.js";

const mikey: ChatMember = { id: "m1", name: "McMikey", manager: true };
const dubs: ChatMember = { id: "m2", name: "Dubs" };
const grammi: ChatMember = { id: "m3", name: "Grammi" };
const room: ChatRoom = { key: "house:parts", title: "The Parts Store", members: [mikey, dubs, grammi] };

/** A chat on a Sync server whose pages are anyone with a `who` cookie naming a member of the room. */
function setup(options: Parameters<typeof createChat>[1] = {}) {
  let clock = 1_000_000;
  const notices: { to: string[]; notice: ChatNotice }[] = [];
  const holder: { follow?: ReturnType<typeof chatAuthorize> } = {};
  const sync = createSyncServer({ mount: "/_zb/chat", log: memoryLog({ keep: "latest" }), authorize: (from) => holder.follow!(from), warn: false });
  const chat = createChat(sync, { notify: (to, notice) => notices.push({ to: to.map((m) => m.id), notice }), now: () => clock, ...options });
  holder.follow = chatAuthorize(chat, { member: (request, key) => (key === room.key ? room.members.find((m) => request.headers.get("cookie") === `who=${m.id}`) : null) });
  const as = (me: ChatMember) => (input?: Record<string, unknown>, query?: string) => chat.handle(room, me, input ? "POST" : "GET", input, new URLSearchParams(query ?? ""));
  const page = (cookie: string | null) => async (path: string, body?: unknown) => {
    const response = await sync.fetch(new Request(`http://test${path}`, { method: body ? "POST" : "GET", headers: { "content-type": "application/json", origin: "http://test", ...(cookie ? { cookie } : {}) }, body: body ? JSON.stringify(body) : undefined }));
    return { status: response!.status, body: await response!.json() };
  };
  return { chat, sync, notices, as, page, tick: (ms: number) => (clock += ms) };
}

const texts = (body: unknown) => (body as { messages: { text: string }[] }).messages.map((m) => m.text);

describe("a room's chat", () => {
  it("is one conversation for the room, told apart for each member", async () => {
    const { as } = setup();
    expect((await as(mikey)()).body).toMatchObject({ rev: 0, here: ["m1"], messages: [], manager: true, filter: false, canFilter: false, limits: LIMITS, others: 2 });
    expect((await as(mikey)({ text: "  Spades at\n eight?  " })).status).toBe(201);
    await as(dubs)({ text: "I'm in" });
    const seen = (await as(grammi)()).body as { manager: boolean; messages: { name: string; text: string; mine: boolean }[] };
    expect(seen.manager).toBe(false);
    expect(seen.messages.map((m) => [m.name, m.text, m.mine])).toEqual([
      ["McMikey", "Spades at eight?", false],
      ["Dubs", "I'm in", false],
    ]);
    expect(Object.keys(seen.messages[0]!).sort()).toEqual(["at", "by", "id", "mine", "name", "text"]);
  });

  it("answers in a few bytes when there is nothing new, and says who is here", async () => {
    const { as, tick } = setup();
    await as(mikey)({ text: "Anyone about?" });
    const { rev } = (await as(dubs)()).body as { rev: number };
    expect((await as(dubs)(undefined, `rev=${rev}`)).body).toEqual({ rev, here: ["m1", "m2"] });
    tick(LOOKING + 1);
    expect(((await as(grammi)()).body as { here: string[] }).here).toEqual(["m3"]);
  });

  it("turns away nothing, too much, and too much at once", async () => {
    const { as } = setup();
    for (const text of ["", "   \n ", undefined, 7, "x".repeat(LIMITS.message + 1)]) expect((await as(mikey)({ text })).status).toBe(400);
    for (let i = 0; i < 5; i++) expect((await as(mikey)({ text: `line ${i}` })).status).toBe(201);
    expect((await as(mikey)({ text: "and another" })).status).toBe(429);
    // Someone else isn't held up by it.
    expect((await as(dubs)({ text: "Slow down" })).status).toBe(201);
  });

  it("lets anyone take down their own message, and a manager anyone's", async () => {
    const { as } = setup();
    for (const [who, text] of [[mikey, "one"], [dubs, "two"], [grammi, "three"]] as const) await as(who)({ text });
    const [one, two, three] = ((await as(mikey)()).body as { messages: { id: number }[] }).messages.map((m) => m.id);
    expect((await as(dubs)({ remove: one })).status).toBe(403);
    expect(texts((await as(dubs)({ remove: two })).body)).toEqual(["one", "three"]);
    expect(texts((await as(mikey)({ remove: three })).body)).toEqual(["one"]);
    const { rev } = (await as(mikey)()).body as { rev: number };
    expect(((await as(mikey)({ remove: three })).body as { rev: number }).rev).toBe(rev);
  });

  it("keeps the last messages only, and never gives an id out twice", async () => {
    const { as, tick } = setup();
    for (let i = 0; i < LIMITS.kept + 5; i++) {
      await as(mikey)({ text: `line ${i}` });
      tick(60_000);
    }
    const { messages } = (await as(mikey)()).body as { messages: { id: number; text: string }[] };
    expect(messages).toHaveLength(LIMITS.kept);
    expect(messages[0]!.text).toBe("line 5");
    await as(mikey)({ remove: messages.at(-1)!.id });
    expect(((await as(mikey)({ text: "after" })).body as { messages: { id: number }[] }).messages.at(-1)!.id).toBe(LIMITS.kept + 6);
  });

  it("asks a question with a few answers, and keeps one vote per member, which they can change or take back", async () => {
    const { as } = setup();
    for (const poll of [{ question: "", options: ["a", "b"] }, { question: "Tonight?", options: ["only one"] }, { question: "Tonight?", options: ["a", "b", "c", "d", "e"] }, { question: "Tonight?", options: ["Yes", "yes"] }, { question: "Tonight?", options: ["x".repeat(LIMITS.option + 1), "b"] }, { question: "x".repeat(LIMITS.question + 1), options: ["a", "b"] }, null]) {
      expect((await as(mikey)({ poll })).status).toBe(400);
    }
    const asked = await as(mikey)({ poll: { question: " Spades or\nPalace? ", options: ["Spades", " Palace ", ""] } });
    expect(asked.status).toBe(201);
    const poll = (asked.body as { messages: { id: number }[] }).messages.at(-1)!;
    expect(poll).toMatchObject({ text: "Spades or Palace?", poll: { options: ["Spades", "Palace"], votes: {} } });
    const votes = async () => ((await as(mikey)()).body as { messages: { poll: { votes: Record<string, number> } }[] }).messages.at(-1)!.poll.votes;
    await as(dubs)({ vote: { id: poll.id, option: 1 } });
    await as(grammi)({ vote: { id: poll.id, option: 1 } });
    await as(grammi)({ vote: { id: poll.id, option: 0 } });
    expect(await votes()).toEqual({ m2: 1, m3: 0 });
    await as(grammi)({ vote: { id: poll.id, option: null } });
    expect(await votes()).toEqual({ m2: 1 });
    for (const option of [2, -1, 0.5, "0"]) expect((await as(dubs)({ vote: { id: poll.id, option } })).status).toBe(400);
    await as(mikey)({ text: "Just talking" });
    const talk = ((await as(mikey)()).body as { messages: { id: number }[] }).messages.at(-1)!.id;
    expect((await as(dubs)({ vote: { id: talk, option: 0 } })).status).toBe(404);
    await as(mikey)({ remove: poll.id });
    expect((await as(dubs)({ vote: { id: poll.id, option: 0 } })).status).toBe(404);
  });

  it("covers words only when the app can and a manager turns that on, and only from then", async () => {
    expect((await setup().as(mikey)({ filter: true })).status).toBe(400);
    const { as } = setup({ mask: (text) => text.replace(/\bdarn\b/gi, (w) => "•".repeat(w.length)) });
    expect(((await as(mikey)()).body as { canFilter: boolean }).canFilter).toBe(true);
    await as(dubs)({ text: "well darn" });
    expect((await as(dubs)({ filter: true })).status).toBe(403);
    expect((await as(mikey)({ filter: "yes" })).status).toBe(400);
    expect(((await as(mikey)({ filter: true })).body as { filter: boolean }).filter).toBe(true);
    await as(dubs)({ text: "darn it again" });
    await as(dubs)({ poll: { question: "Darn or dang?", options: ["darn", "dang"] } });
    const after = (await as(mikey)()).body as { messages: { text: string; poll?: { options: string[] } }[] };
    expect(after.messages.map((m) => m.text)).toEqual(["well darn", "•••• it again", "•••• or dang?"]);
    expect(after.messages[2]!.poll!.options).toEqual(["••••", "dang"]);
    await as(mikey)({ filter: false });
    await as(dubs)({ text: "darn" });
    expect(texts((await as(mikey)()).body).at(-1)).toBe("darn");
  });

  it("keeps everything said at once, each under its own id", async () => {
    // The app takes its time over each message (it asks its database, say), and posts its own words meanwhile.
    const { chat, as } = setup({ beforeSay: async ({ text }) => (await new Promise((done) => setTimeout(done, 5)), text) });
    await Promise.all([
      as(mikey)({ text: "one" }),
      as(dubs)({ text: "two" }),
      chat.post(room.key, { id: "bot", name: "Dot" }, "three", { bot: true }),
      as(grammi)({ text: "four" }),
      chat.post(room.key, null, "five", { notice: true }),
    ]);
    const { messages, next, rev } = await chat.read(room.key);
    expect(messages.map((m) => m.text).sort()).toEqual(["five", "four", "one", "three", "two"]);
    expect(new Set(messages.map((m) => m.id)).size).toBe(5);
    expect([next, rev]).toEqual([6, 5]);
    // Taking down and votes wait their turn too.
    const asked = (await as(mikey)({ poll: { question: "Spades?", options: ["Yes", "No"] } })).body as { messages: { id: number; poll?: unknown }[] };
    const poll = asked.messages.find((m) => m.poll)!.id;
    await Promise.all([as(dubs)({ vote: { id: poll, option: 0 } }), as(grammi)({ vote: { id: poll, option: 1 } }), chat.redact(room.key, messages[0]!.id), as(mikey)({ text: "six" })]);
    const after = await chat.read(room.key);
    expect(after.messages.find((m) => m.id === poll)!.poll!.votes).toEqual({ m2: 0, m3: 1 });
    expect(after.messages.map((m) => m.text)).toContain("six");
    expect(after.messages.some((m) => m.id === messages[0]!.id)).toBe(false);
  });

  it("starts over when cleared, without giving an id out again", async () => {
    const { chat, as } = setup();
    await as(mikey)({ text: "The old room" });
    await chat.clear(room.key);
    expect((await as(mikey)()).body).toMatchObject({ messages: [], filter: false });
    expect(((await as(mikey)({ text: "new" })).body as { messages: { id: number }[] }).messages[0]!.id).toBe(2);
  });

  it("lets the app's moderators read a room and take a message down", async () => {
    const { chat, as } = setup();
    await as(dubs)({ text: "Something rude" });
    const [rude] = (await chat.read(room.key)).messages;
    expect(await chat.redact(room.key, rude!.id)).toMatchObject({ name: "Dubs", text: "Something rude" });
    expect(await chat.redact(room.key, rude!.id)).toBeNull();
    expect(texts((await as(dubs)()).body)).toEqual([]);
  });
});

describe("the app's own words, and its say over people's", () => {
  it("posts a computer player's words and the room's notices past every check, and notifies nobody", async () => {
    const { chat, as, notices } = setup();
    const said = await chat.post(room.key, { id: "seat:2", name: "Robo" }, "  Nice\n play  ", { bot: true });
    expect(said).toMatchObject({ by: "seat:2", name: "Robo", text: "Nice play", bot: true });
    expect(await chat.post(room.key, null, "Grammi joined", { notice: true })).toMatchObject({ by: "", name: "", text: "Grammi joined", notice: true });
    expect(await chat.post(room.key, { id: "x", name: "X" }, "   ")).toBe("Nothing to say.");
    // As fast as the app likes: no five-in-ten-seconds for it.
    for (let i = 0; i < 8; i++) expect(typeof (await chat.post(room.key, { id: "seat:2", name: "Robo" }, `line ${i}`, { bot: true }))).not.toBe("string");
    expect(notices).toEqual([]);
    // Members see them; a notice is nobody's unread, a bot's line is.
    const seen = (await as(dubs)()).body as { messages: { bot?: boolean; notice?: boolean }[] };
    expect(seen.messages.filter((m) => m.notice)).toHaveLength(1);
    await chat.post(room.key, null, "Dubs left", { notice: true });
    await chat.post(room.key, { id: "seat:2", name: "Robo" }, "Bye", { bot: true });
    expect(await chat.unread(room.key, "m2")).toBe(1);
  });

  it("lets the app change people's words or turn them away, for messages and every piece of a poll", async () => {
    const asked: string[] = [];
    const { as } = setup({
      beforeSay: ({ me, text }) => {
        asked.push(`${me.id}:${text}`);
        if (me.id === "m3") return { error: "You've been muted at this table." };
        return text.replace(/heck/g, "h**k");
      },
    });
    expect(((await as(dubs)({ text: "what the heck" })).body as { messages: { text: string }[] }).messages.at(-1)!.text).toBe("what the h**k");
    const muted = await as(grammi)({ text: "Hello?" });
    expect(muted).toMatchObject({ status: 403, body: { error: "You've been muted at this table." } });
    const poll = await as(dubs)({ poll: { question: "Heck or no?", options: ["heck yes", "no"] } });
    expect((poll.body as { messages: { text: string; poll: { options: string[] } }[] }).messages.at(-1)).toMatchObject({ poll: { options: ["h**k yes", "no"] } });
    expect(asked).toContain("m2:heck yes");
    // Turned to nothing is nothing to say.
    const { as: blank } = setup({ beforeSay: () => "   " });
    expect((await blank(dubs)({ text: "gone" })).status).toBe(400);
  });

  it("tells the app what people said, not what it posted itself", async () => {
    const heard: string[] = [];
    const { chat, as } = setup({ onSay: ({ me, message }) => heard.push(`${me.id}:${message.text}`) });
    await as(dubs)({ text: "Hi all" });
    await as(dubs)({ poll: { question: "Tonight?", options: ["Yes", "No"] } });
    await chat.post(room.key, { id: "seat:2", name: "Robo" }, "Hello", { bot: true });
    expect((await as(dubs)({ text: "" })).status).toBe(400);
    expect(heard).toEqual(["m2:Hi all", "m2:Tonight?"]);
  });

  it("lets a member who can't speak read, and take down what they said before, but not say, ask or vote", async () => {
    const { as } = setup();
    const watcher: ChatMember = { ...grammi, canSpeak: false };
    const poll = ((await as(dubs)({ poll: { question: "Tonight?", options: ["Yes", "No"] } })).body as { messages: { id: number }[] }).messages[0]!.id;
    await as(grammi)({ text: "Said before" });
    const before = ((await as(grammi)()).body as { messages: { id: number; text: string }[] }).messages.find((m) => m.text === "Said before")!.id;
    for (const input of [{ text: "Hi" }, { poll: { question: "Q?", options: ["a", "b"] } }, { vote: { id: poll, option: 0 } }]) {
      expect(await as(watcher)(input)).toMatchObject({ status: 403, body: { error: "You can't speak here." } });
    }
    expect((await as(watcher)()).status).toBe(200);
    expect(texts((await as(watcher)({ remove: before })).body)).toEqual(["Tonight?"]);
  });
});

describe("notices", () => {
  it("go to the members who aren't looking, once for a conversation", async () => {
    const { as, notices, tick } = setup();
    await as(grammi)(); // Grammi has the room open.
    await as(mikey)({ text: "Spades at eight?" });
    await as(mikey)({ text: "Bring snacks" });
    expect(notices).toHaveLength(1);
    expect(notices[0]!.to).toEqual(["m2"]);
    expect(notices[0]!.notice).toMatchObject({ from: { id: "m1" }, body: "Spades at eight?", room: { key: "house:parts" } });
    // Five minutes on, and Grammi long gone: both hear of the next.
    tick(5 * 60_000);
    await as(mikey)({ poll: { question: "x".repeat(130), options: ["a", "b"] } });
    expect(notices[1]!.to).toEqual(["m2", "m3"]);
    expect(notices[1]!.notice.body).toBe(`📊 ${"x".repeat(114)}…`);
  });

  it("aren't sent for votes, taking down or the filter", async () => {
    const { as, notices } = setup({ mask: (t) => t });
    const poll = ((await as(mikey)({ poll: { question: "Tonight?", options: ["Yes", "No"] } })).body as { messages: { id: number }[] }).messages[0]!.id;
    notices.length = 0;
    await as(dubs)({ vote: { id: poll, option: 0 } });
    await as(mikey)({ filter: true });
    await as(mikey)({ remove: poll });
    expect(notices).toEqual([]);
  });
});

describe("what each member hasn't seen", () => {
  it("is what others said since their page last had the room open", async () => {
    const { chat, as, sync } = setup();
    await as(mikey)({ text: "Spades at eight?" });
    await as(mikey)({ text: "Bring snacks" });
    // Never opened: all of it. Their own words never count.
    expect(await chat.unread(room.key, "m2")).toBe(2);
    expect(await chat.unread(room.key, "m1")).toBe(0);
    // Reading the room sees it all.
    await as(dubs)();
    expect(await chat.unread(room.key, "m2")).toBe(0);
    await as(grammi)({ text: "I'm in" });
    expect(await chat.unread(room.key, "m2")).toBe(1);
    // Saying something sees what was there.
    await as(dubs)({ text: "Me too" });
    expect(await chat.unread(room.key, "m2")).toBe(0);
    expect(await chat.unread(room.key, "m1")).toBe(2);
    // A member's own words are never unread, even said after their marker (from another app's
    // route, say, that didn't mark it).
    await sync.write("chats-seen", room.key, { m2: 0 });
    expect(await chat.unread(room.key, "m2")).toBe(3);
    await as(dubs)();
        // A message taken down is no longer unread.
    const said = (await chat.read(room.key)).messages.find((m) => m.text === "Me too")!;
    await chat.redact(room.key, said.id);
    expect(await chat.unread(room.key, "m1")).toBe(1);
  });

  it("is seen by a presence heartbeat, as by reading", async () => {
    const { chat, as, page } = setup();
    await as(mikey)({ text: "Anyone?" });
    await page("who=m3")("/_zb/chat/presence", { room: "chats/house:parts", peer: "grammi-tab", state: { here: { member: "m3" } } });
    await new Promise((r) => setTimeout(r, 10));
    expect(await chat.unread(room.key, "m3")).toBe(0);
    expect(await chat.unread(room.key, "m2")).toBe(1);
  });

  it("is kept where pages can't read it, and written only when it moves on", async () => {
    const writes: string[] = [];
    const sync = createSyncServer({ mount: "/_zb/chat", log: memoryLog({ keep: "latest" }), warn: false });
    const counted = { write: (c: string, k: string, f: Record<string, unknown>) => (writes.push(c), sync.write(c, k, f)), documents: () => sync.documents() };
    const chat = createChat(counted);
    await chat.handle(room, mikey, "POST", { text: "Hi" });
    writes.length = 0;
    for (let i = 0; i < 5; i++) chat.looking(room.key, "m2");
    await new Promise((r) => setTimeout(r, 10));
    expect(writes).toEqual(["chats-seen"]);
    // And no page is sent it, member or not.
    const follow = chatAuthorize(chat, { member: () => dubs });
    expect(await follow({ request: new Request("http://test"), collection: "chats-seen", key: room.key, kind: "read" })).toBe(false);
  });
});

describe("following a room live, through Zubra Sync", () => {
  const scope = encodeURIComponent(JSON.stringify({ chats: true }));

  it("is for the room's members only, and nobody but the server writes it", async () => {
    const { as, page } = setup();
    await as(mikey)({ text: "Spades at eight?" });
    const pulled = (await page("who=m2")(`/_zb/chat/pull?since=0&scope=${scope}`)).body as { changes: { collection: string; key: string; field: string; value: unknown }[] };
    const fields = Object.fromEntries(pulled.changes.map((c) => [c.field, c.value]));
    expect(texts(fields)).toEqual(["Spades at eight?"]);
    expect(pulled.changes.every((c) => c.collection === "chats" && c.key === "house:parts")).toBe(true);
    for (const stranger of ["who=nobody", null]) expect(((await page(stranger)(`/_zb/chat/pull?since=0&scope=${scope}`)).body as { changes: unknown[] }).changes).toEqual([]);
    const change = { collection: "chats", key: "house:parts", field: "messages", value: [], clock: `${String(Date.now()).padStart(15, "0")}-00000-x` };
    expect((await page("who=m1")("/_zb/chat/push", { changes: [change] })).status).toBe(403);
  });

  it("refuses anything outside the chat's collection", async () => {
    const { chat } = setup();
    const follow = chatAuthorize(chat, { member: () => mikey });
    const request = new Request("http://test");
    expect(await follow({ request, collection: "chats", key: "house:parts", kind: "read" })).toBe(true);
    expect(await follow({ request, collection: "rooms", key: "house:parts", kind: "read" })).toBe(false);
    expect(await follow({ request, collection: "chats", key: "house:parts", kind: "change" })).toBe(false);
  });

  it("takes a member's presence as looking, so they get no notice", async () => {
    const { as, page, notices } = setup();
    const said = await page("who=m3")("/_zb/chat/presence", { room: "chats/house:parts", peer: "grammi-tab", state: { here: { member: "m3" } } });
    // Without a live stream the peer id isn't hers to speak as, but the heartbeat was let in first.
    expect([200, 403]).toContain(said.status);
    await as(mikey)({ text: "Spades at eight?" });
    expect(notices[0]!.to).toEqual(["m2"]);
  });

  it("keeps another collection's name if the app gives one", async () => {
    const sync = createSyncServer({ mount: "/_zb/chat", log: memoryLog({ keep: "latest" }), warn: false });
    const chat = createChat(sync, { collection: "talk" });
    await chat.handle(room, mikey, "POST", { text: "Hi" });
    expect((await sync.documents()).get("talk", room.key)).toBeDefined();
    expect((await sync.documents()).get("chats", room.key)).toBeUndefined();
  });
});
