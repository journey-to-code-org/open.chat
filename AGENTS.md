# open.chat

A chat for any app: rooms on a Zubra Sync server, changed only by the server, followed live by members' pages; and the chat's screen as Zubra components that work in any framework.

- `packages/chat` (`@journey-to-code/chat`): `src/server.ts` (`createChat`, `chatAuthorize`), `src/client.ts` (`openChat`), `src/types.ts` (the shapes, `LIMITS`, `tally`). Plain TypeScript, built with `tsc`.
- `packages/chat-ui` (`@journey-to-code/chat-ui`): `src/components/chat-room.zb` (the chat whole) and `chat-feed.zb` (the live room: `'use collection chats'`, presence). The other components are copies of zubra-ui's, from open.parlor's copies (which carry fixes; see each file's first line). Built with `zubra build --lib`; the package exports the build from `dist/` and the `.zb` sources under `./components/*.zb`.
- `.github/workflows/`: CI, and the release (as open.games: merging a version bump to `main` publishes).

Commands: `npm run build`, `npm run typecheck` (`tsc`, and `zubra check` for the components), `npm test`. All must pass before a change is done. chat-ui's tests run in Chromium through plain HTML, React and Vue (`CHROMIUM=<path>` for a Chromium of your own).

Rules:
- Nothing in a page writes a room: `chatAuthorize` refuses every change, and the server's `handle` checks each one. Keep it so.
- The room's document holds only what every member may see. Per-member things (`mine`, `manager`) are worked out on the page or in `handle`'s answer, never stored.
- The app decides who is in a room, who manages it, what words to cover and how to notify. Nothing app-specific goes in the packages.
- Commits are authored by Mikey Nichols, with no trailers.
