// @journey-to-code/chat: a chat for any app.
//
//   ./server  createChat(), chatAuthorize(): the rooms, kept on a Zubra Sync server, changed only by the server
//   ./client  openChat(): the page's connection to them, and the actions <chat-room> calls
//
// This entry has what both use: the shapes, the limits and how a poll stands.
export { LIMITS, tally } from "./types.js";
export type { ChatDocument, ChatMember, ChatMessage, ChatPoll, ChatRoom } from "./types.js";
