# @journey-to-code/chat-ui

The chat's screen as Zubra components, for any framework or none. See [open.chat](https://github.com/journey-to-code-org/open.chat#on-the-page) for how to use them with `@journey-to-code/chat`.

- `<chat-room>`: the chat whole. It shows who's here, what was said, polls to vote on and a box to say something. It follows the room live by itself, and sends what the person does to its `actions`. `can-speak="false"` makes it read-only, `ask-name` asks a guest's name, and `show-here="false"` leaves out who's here.
- `<chat-feed>`: the live room alone (`'use collection chats'`), for drawing a chat of your own. Its events say what changed.

The rest (`action-button`, `text-field`, `modal-dialog` and others) are [zubra-ui](https://github.com/zubra-js/zubra-ui)'s, which `<chat-room>` is made of.

`dist/skills/` holds a skill for agents using the package, written by Zubra's build.
