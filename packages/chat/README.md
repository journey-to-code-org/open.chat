# open.chat

A chat for any app. Rooms are kept on a [Zubra Sync](https://github.com/journey-to-code-org/zubra) server and followed live by their members' pages, but only the server changes them, so every message is checked first. Each room has polls, a way to take messages down, an optional word filter, and notices for members who aren't looking. On the page, the chat is one element, `<chat-room>`, made of Zubra components. It works the same in plain HTML, React, Vue, Svelte, Solid and Angular.

It started as the house chat in [open.parlor](https://github.com/journey-to-code-org/open.parlor), and the parlor uses it from here.

| Package | What |
| --- | --- |
| [`@journey-to-code/chat`](packages/chat) | The rooms on the server (`./server`), and the page's connection to them (`./client`) |
| [`@journey-to-code/chat-ui`](packages/chat-ui) | `<chat-room>`, the chat whole, and `<chat-feed>`, the live room alone, to draw a chat of your own |

## What a room does

- One conversation per room, kept to its last 200 messages of 280 characters each. Ids are never given out twice.
- **Who's here**: every member, with those who have the room open first. That's Zubra Sync's presence, so no polling.
- **Polls**: a question with two to four answers. Each member has one vote, which they can change or take back.
- **Taking down**: anyone their own message, a manager anyone's, and the app's own moderators anything (`chat.redact`).
- **Word filter**, for apps that pass a `mask`: managers switch it on, and it covers what's said from then on.
- **Notices**: the app is told who to notify, at most once every five minutes per member, and never someone whose page is open on the room.
- Five messages in ten seconds at most, per member.
- **The app's own words**: `chat.post(key, speaker, text, { bot, notice })` puts a message in a room without the checks: a computer player's reply (`bot`, shown with 🤖), or a line about the room itself (`notice`, shown on its own, never counted as unread, never notified).
- **The app's say**: `beforeSay({ room, me, text })` sees every message, poll question and answer before it's kept, and returns the words to keep, or `{ error }` to refuse (a closed table, a muted player). `onSay({ room, me, message })` hears each one after, to answer it.
- **Reading along**: a member with `canSpeak: false` follows the room but can't say, ask or vote; their own messages can still be taken down.
- **Unread**: `chat.unread(key, member)` counts what others said since that member last had the room open. Reading the room, saying something, or a presence heartbeat counts as having seen it. The markers are kept per room in a server-only collection, `chats-seen`, which pages are never sent.

## Using it

### On the server

```ts
import { createSyncServer } from "@zubra/sync/server";
import { chatAuthorize, createChat } from "@journey-to-code/chat/server";

const sync = createSyncServer({ mount: "/_zb/chat", log, authorize: (from) => follow(from) });
const chat = createChat(sync, {
  notify: (to, notice) => sendPush(to, notice), // optional
  mask: (text) => coverCrudeWords(text), // optional: without it, the filter can't be switched on
});
// Who may follow a room live: its members read it and send presence; nobody but the server writes it.
const follow = chatAuthorize(chat, { member: (request, key) => memberOf(request, key) });

// The app's route for a room (say POST /houses/:slug/chat), once it knows the room and who's asking:
const room = { key: `house:${slug}`, title: house.name, members: house.members.map((m) => ({ id: m.id, name: m.name, manager: m.role !== "member" })) };
const { status, body } = await chat.handle(room, me, request.method, input);
```

A room open to anyone (comments under a post, say) is the same: the app's route makes `me` from the visitor, with the name they give (`input.name`, sent by `actions.say(text, name)`), and `<chat-room ask-name show-here="false">` asks for it.

Serve `sync.fetch(request)` (or `sync.handle(req, res)` in Node) for `/_zb/chat`. The chat's collection, `chats`, can share a log with other Sync servers. Each server sends out only its own changes.

### On the page

```js
import { openChat } from "@journey-to-code/chat/client";
import "@journey-to-code/chat-ui/chat-room";

// Before the element starts, so it waits for the first pull:
const actions = openChat({ room: "house:parts", endpoint: "/houses/parts/chat" });
```

```html
<chat-room doc="house:parts" me="m1" noun="house"></chat-room>
<script>
  const room = document.querySelector("chat-room");
  room.members = [{ id: "m1", name: "Mikey" }, { id: "m2", name: "Grammi" }];
  room.actions = actions;
  room.addEventListener("heard", () => playSound());
</script>
```

From React, `import { ChatRoom } from "@journey-to-code/chat-ui/react"`; from Vue, `@journey-to-code/chat-ui/vue`. Svelte, Solid and Angular use the element itself. In an app that compiles Zubra components itself, import `@journey-to-code/chat-ui/components/chat-room.zb` instead. Where the app has its own copy of one of the parts (`action-button`, `text-field` and the rest), the app's copy stands in for the package's.

The components follow [zubra-ui](https://github.com/journey-to-code-org/zubra-ui)'s theme variables (shadcn/ui's). `@journey-to-code/chat-ui/theme.css` is its default theme. `--chat-bubble`, `--chat-bubble-mine`, `--chat-name` and `--chat-height` set the chat's own look.

`<chat-room>` also takes `can-speak` (false: read along, no box), `ask-name` (a "Your name" field, kept on the device and sent with each message) and `show-here` (false: no row of who's here).

## Working on it

`npm run build` (the UI's tests need the chat package built), `npm run typecheck`, `npm test` (Node 22.12 or later). chat-ui's tests run in Chromium through plain HTML, React and Vue: `npx playwright install chromium` once, or set `CHROMIUM=<path to chrome>`.

Releasing works as in open.games: bump a package's version, and merging it to `main` publishes it (`.github/workflows/release.yml`, trusted publishing, no token). A new package's first version has to be published by hand; after that, add the trusted publisher on npmjs.com: organization `journey-to-code-org`, repository `open.chat`, workflow `release.yml`, environment `release`.

## Known in Zubra Sync 5.22.0

- **Presence goes through every connection on a page**, whatever its scope. With two connections, a room's presence is also posted to the other server, which refuses it.
- **A stopped connection's peer id can't be taken up by a new one** at the same address until the server lets go of the old stream. A new connection is refused (409) and then gives the whole page a new peer id. `openChat()` keeps one connection per server for the page, never stopped, so it never meets this.
