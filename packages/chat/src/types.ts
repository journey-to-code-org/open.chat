// What a chat is made of, the same on the server and on the page.

/** A question with a few answers, asked in a chat. Each member has one vote, and may change it. */
export interface ChatPoll {
  options: string[];
  /** Member id → the answer they chose. */
  votes: Record<string, number>;
}

/** Something said in a chat, as every member sees it. */
export interface ChatMessage {
  id: number;
  /** The member who said it (an id the app gave them), and their name as it was then. */
  by: string;
  name: string;
  /** What was said; for a poll, its question. */
  text: string;
  /** When, in milliseconds since 1970. */
  at: number;
  poll?: ChatPoll;
}

/** A chat as it is kept: one document for each room, in the `chats` collection by default. */
export interface ChatDocument {
  messages: ChatMessage[];
  /** Goes up with every change. */
  rev: number;
  /** The id the next message gets: ids are never given out twice, even after one is taken down. */
  next: number;
  /** Whether crude words are covered in what is said from now on. */
  filter: boolean;
}

/** Someone in a room. Ids are the app's own; they are shown to the room's other members. */
export interface ChatMember {
  id: string;
  name: string;
  /** A manager may take down what anyone said, and switch the word filter. */
  manager?: boolean;
}

/** A room: where one conversation happens, and who is in it. */
export interface ChatRoom {
  /** The room's document key, unique in the collection: `house:parts`, `table:x7k2`, `post:hello-world`. */
  key: string;
  /** A name for it, for notifications ("McMikey at The Parts Store"). */
  title: string;
  members: ChatMember[];
}

/** The limits a chat keeps to. */
export const LIMITS = {
  /** The longest a message may be. */
  message: 280,
  /** A poll's question, and each of its answers. */
  question: 140,
  option: 40,
  /** A poll has two answers at least, and this many at most. */
  options: 4,
  /** How many messages a room keeps; older ones fall off the start. */
  kept: 200,
} as const;

/** How a poll stands: the votes for each answer, how many in all, and which this member chose (null for none). */
export function tally(poll: ChatPoll, member: string): { counts: number[]; total: number; mine: number | null } {
  const counts = poll.options.map(() => 0);
  for (const option of Object.values(poll.votes)) if (Number.isInteger(option) && option >= 0 && option < counts.length) counts[option]! += 1;
  return { counts, total: counts.reduce((a, b) => a + b, 0), mine: poll.votes[member] ?? null };
}
