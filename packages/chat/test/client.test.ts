// The chat on the page: what it sends, the one connection it keeps, and how a poll stands.
import { afterEach, describe, expect, it, vi } from "vitest";
import { openChat, postTo, tally, when } from "../src/client.js";

function setup(fail?: string) {
  const sent: Record<string, unknown>[] = [];
  const send = async (body: Record<string, unknown>) => {
    sent.push(body);
    if (fail) throw new Error(fail);
  };
  const connection = { pull: vi.fn(async () => undefined), stop: vi.fn() };
  const connect = vi.fn(() => connection);
  return { sent, connection, connect, send };
}

afterEach(() => vi.unstubAllGlobals());

describe("openChat", () => {
  it("follows the whole collection on the chat's Sync server, with one connection for the page that every room shares and nothing stops", () => {
    const { connect, connection, send } = setup();
    const one = openChat({ room: "house:parts", send, connect });
    expect(connect).toHaveBeenCalledWith({ url: "/_zb/chat", scope: { chats: true } });
    one.stop();
    openChat({ room: "house:other", send, connect }).stop();
    expect(connect).toHaveBeenCalledOnce();
    expect(connection.stop).not.toHaveBeenCalled();
    // Another server, or another collection, is another connection.
    openChat({ room: "x", send, connect, url: "/_zb/talk" });
    openChat({ room: "x", send, connect, collection: "talk" });
    expect(connect.mock.calls.map((c) => (c as unknown[])[0])).toEqual([
      { url: "/_zb/chat", scope: { chats: true } },
      { url: "/_zb/talk", scope: { chats: true } },
      { url: "/_zb/chat", scope: { talk: true } },
    ]);
  });

  it("sends what the person does, and pulls once after each, so it shows while the live stream reconnects", async () => {
    const { sent, connection, connect, send } = setup();
    const chat = openChat({ room: "house:parts", send, connect });
    expect(await chat.say("Hello")).toBeNull();
    expect(await chat.ask("Tonight?", ["Yes", "No"])).toBeNull();
    expect(await chat.vote(3, 1)).toBeNull();
    expect(await chat.vote(3, null)).toBeNull();
    expect(await chat.unsay(2)).toBeNull();
    expect(await chat.setFilter(true)).toBeNull();
    expect(sent).toEqual([{ text: "Hello" }, { poll: { question: "Tonight?", options: ["Yes", "No"] } }, { vote: { id: 3, option: 1 } }, { vote: { id: 3, option: null } }, { remove: 2 }, { filter: true }]);
    expect(connection.pull).toHaveBeenCalledTimes(6);
  });

  it("hands back what went wrong, and pulls nothing then", async () => {
    const { connection, connect, send } = setup("Give the others a moment to answer.");
    expect(await openChat({ room: "r", send, connect }).say("too much")).toBe("Give the others a moment to answer.");
    expect(connection.pull).not.toHaveBeenCalled();
  });

  it("sends nothing once it has stopped", async () => {
    const { sent, connect, send } = setup();
    const chat = openChat({ room: "r", send, connect });
    chat.stop();
    expect(await chat.say("Anyone?")).toBe("The chat has closed.");
    expect(sent).toEqual([]);
  });

  it("needs somewhere to send", () => {
    expect(() => openChat({ room: "r", connect: setup().connect })).toThrow(/endpoint/);
  });

  it("posts JSON to the room's endpoint, and reads the server's error", async () => {
    const fetches: [string, RequestInit][] = [];
    vi.stubGlobal("fetch", async (url: string, init: RequestInit) => {
      fetches.push([url, init]);
      return JSON.parse(String(init.body)).text === "bad" ? new Response(JSON.stringify({ error: "Say something first." }), { status: 400 }) : new Response("{}", { status: 201 });
    });
    const { connect } = setup();
    const chat = openChat({ room: "r", endpoint: "/houses/parts/chat", connect });
    expect(await chat.say("Hi")).toBeNull();
    expect(await chat.say("bad")).toBe("Say something first.");
    expect(fetches[0]![0]).toBe("/houses/parts/chat");
    expect(fetches[0]![1]).toMatchObject({ method: "POST", credentials: "same-origin", headers: { "content-type": "application/json" } });
    vi.stubGlobal("fetch", async () => new Response("not json", { status: 502 }));
    await expect(postTo("/x")({})).rejects.toThrow("The chat answered 502.");
  });
});

describe("a poll", () => {
  it("counts each member's one vote, and knows which is this member's", () => {
    const poll = { options: ["Spades", "Palace", "Hearts"], votes: { a: 1, b: 1, c: 0, me: 1, stale: 7 } };
    expect(tally(poll, "me")).toEqual({ counts: [1, 3, 0], total: 4, mine: 1 });
    expect(tally(poll, "nobody").mine).toBeNull();
    expect(tally({ options: ["Yes", "No"], votes: {} }, "me")).toEqual({ counts: [0, 0], total: 0, mine: null });
  });
});

describe("when a message was said", () => {
  const now = new Date(2026, 10, 17, 22, 0).getTime();
  it("is a time today, a day and a time this week, and a date before that", () => {
    expect(when(new Date(2026, 10, 17, 15, 42).getTime(), now)).toMatch(/3:42/);
    expect(when(new Date(2026, 10, 15, 15, 42).getTime(), now)).toMatch(/Sun.*3:42/);
    expect(when(new Date(2026, 10, 3, 15, 42).getTime(), now)).toMatch(/Nov 3|3 Nov/);
  });
});
