// <chat-room> through plain HTML, React and Vue, the way apps on each would use it. The server is
// stood in for: the test hands the room's document and the others' presence to Zubra Sync the way
// `connect()` does, so the <chat-feed> inside is the real one, on a store in memory.
// `npm test` (Vitest browser mode, Chromium).
import { describe, expect, test } from 'vitest';
import { frameworks, mount } from '@zubra/runtime/testing';
import { configure, memoryStore, receive, receivePresence } from '@zubra/sync';
import ChatRoom from '../src/components/chat-room.zb?element';

configure({ store: memoryStore() });
let rooms = 0;

const found = await frameworks();
const members = [
  { id: 'm1', name: 'McMikey' },
  { id: 'm2', name: 'Dubs' },
  { id: 'm3', name: 'Grammi' },
];
const said = (id, by, text, extra = {}) => ({ id, by, name: members.find((m) => m.id === by).name, text, at: Date.now(), ...extra });
const settle = () => new Promise((resolve) => setTimeout(resolve, 30));

/** Actions that write down what they were asked, and answer with `fail` (or nothing wrong). */
function actions(fail = () => null) {
  const calls = [];
  const act = (name) => async (...args) => (calls.push([name, ...args]), fail(name, ...args));
  return { calls, say: act('say'), unsay: act('unsay'), ask: act('ask'), vote: act('vote'), setFilter: act('setFilter') };
}

async function room(framework, props = {}) {
  const sent = props.actions ?? actions();
  const doc = `house:test-${++rooms}`;
  const view = await mount(ChatRoom, { framework, props: { doc, me: 'm1', members, noun: 'house', ...props, actions: sent } });
  const el = view.element;
  let present = [];
  const flush = async () => {
    await settle();
    await view.set({});
  };
  return {
    view,
    el,
    calls: sent.calls,
    flush,
    async chat(messages, more = {}) {
      await receive('chats', doc, { messages, rev: messages.length + 1, next: messages.length + 1, filter: false, ...more });
      await flush();
    },
    async here(ids) {
      const room = `chats/${doc}`;
      for (const id of present.filter((id) => !ids.includes(id))) receivePresence({ room, peer: `tab-${id}`, state: null });
      for (const id of ids) receivePresence({ room, peer: `tab-${id}`, state: { here: { member: id } } });
      present = ids;
      await flush();
    },
    texts: () => [...el.querySelectorAll('.msg .text')].map((t) => t.textContent),
    button: (name, within = el) => [...within.querySelectorAll('button')].find((b) => b.textContent.trim() === name),
    async type(field, text) {
      const input = field.querySelector('input');
      input.value = text;
      input.dispatchEvent(new Event('input', { bubbles: true }));
      await flush();
    },
  };
}

test('React and Vue are installed, so all three run', () => {
  expect(found).toEqual(['html', 'react', 'vue']);
});

describe.each(found)('%s', (framework) => {
  test("shows everyone in the room, whoever is here first, and says who", async () => {
    const r = await room(framework);
    const faces = () => [...r.el.querySelectorAll('.face')].map((f) => f.title);
    expect(faces()).toEqual(['McMikey (you): here now', 'Dubs: not here', 'Grammi: not here']);
    expect(r.el.querySelector('.count').textContent).toContain('Just you here');
    await r.here(['m3']);
    expect(faces()).toEqual(['McMikey (you): here now', 'Grammi: here now', 'Dubs: not here']);
    expect(r.el.querySelector('.count').textContent).toContain('Grammi is here');
    await r.here(['m3', 'm2']);
    expect(r.el.querySelector('.count').textContent).toContain('Dubs and Grammi are here');
    r.view.unmount();
  });

  test('shows what was said, with Take down on your own only', async () => {
    const r = await room(framework);
    expect(r.el.querySelector('empty-state').textContent).toContain('Say hi to the house.');
    await r.chat([said(1, 'm2', 'Spades at eight?'), said(2, 'm1', "I'm in")]);
    expect(r.texts()).toEqual(['Spades at eight?', "I'm in"]);
    const [theirs, mine] = r.el.querySelectorAll('.msg');
    expect(mine.classList.contains('mine')).toBe(true);
    expect(r.button('Take down', theirs)).toBeUndefined();
    expect(r.button('Take down', mine)).toBeDefined();
    r.view.unmount();
  });

  test('a manager may take down anyone’s, through a dialog that quotes it', async () => {
    const r = await room(framework, { manager: true });
    await r.chat([said(1, 'm2', 'Something rude'), said(2, 'm3', 'Hello')]);
    const dialog = () => [...r.el.querySelectorAll('dialog')].find((d) => d.open);
    r.button('Take down', r.el.querySelectorAll('.msg')[0]).click();
    await r.flush();
    expect(dialog().textContent).toContain('Take down what Dubs said?');
    expect(dialog().textContent).toContain('“Something rude”');
    r.button('Take it down', dialog()).click();
    await r.flush();
    expect(r.calls).toEqual([['unsay', 1]]);
    expect(dialog()).toBeUndefined();
    r.view.unmount();
  });

  test('sends what was typed, and empties the box once it went', async () => {
    const r = await room(framework);
    const field = r.el.querySelector('.compose text-field');
    const send = r.button('Send');
    expect(send.disabled).toBe(true);
    await r.type(field, '  Palace after?  ');
    expect(send.disabled).toBe(false);
    r.el.querySelector('form.compose').requestSubmit();
    await r.flush();
    expect(r.calls).toEqual([['say', 'Palace after?']]);
    expect(field.querySelector('input').value).toBe('');
    r.view.unmount();
  });

  test('keeps what was typed, and says what went wrong, when it didn’t go', async () => {
    const r = await room(framework, { actions: actions(() => 'Give the others a moment to answer.') });
    const field = r.el.querySelector('.compose text-field');
    await r.type(field, 'One more');
    r.el.querySelector('form.compose').requestSubmit();
    await r.flush();
    expect(r.el.querySelector('alert-banner').textContent).toContain('Give the others a moment to answer.');
    expect(field.querySelector('input').value).toBe('One more');
    r.view.unmount();
  });

  test('a poll: vote with the cards, see how it stands, take the vote back', async () => {
    const r = await room(framework);
    const poll = said(4, 'm2', 'Spades or Palace?', { poll: { options: ['Spades', 'Palace'], votes: { m2: 1, m3: 1 } } });
    await r.chat([poll]);
    const card = r.el.querySelector('.msg.poll');
    const radios = [...card.querySelectorAll('[role=radio]')];
    expect(radios.map((b) => b.textContent.trim())).toEqual(['Spades', 'Palace']);
    expect(radios.map((b) => b.getAttribute('aria-checked'))).toEqual(['false', 'false']);
    expect(card.querySelector('bar-chart').textContent.replace(/\s+/g, ' ')).toMatch(/Spades 0.*Palace 2/);
    expect(card.textContent).toContain('2 votes');
    expect(r.button('Take back my vote', card)).toBeUndefined();
    radios[0].click();
    await r.flush();
    expect(r.calls).toEqual([['vote', 4, 0]]);
    // The server says it counted.
    await r.chat([{ ...poll, poll: { ...poll.poll, votes: { ...poll.poll.votes, m1: 0 } } }]);
    const now = r.el.querySelector('.msg.poll');
    expect([...now.querySelectorAll('[role=radio]')].map((b) => b.getAttribute('aria-checked'))).toEqual(['true', 'false']);
    expect(now.textContent).toContain('3 votes');
    r.button('Take back my vote', now).click();
    await r.flush();
    expect(r.calls.at(-1)).toEqual(['vote', 4, null]);
    r.view.unmount();
  });

  test('asks the room a question with two to four answers', async () => {
    const r = await room(framework);
    r.button('Ask the house…').click();
    await r.flush();
    const dialog = [...r.el.querySelectorAll('dialog')].find((d) => d.open);
    expect(dialog.textContent).toContain('Ask the house');
    const ask = r.button('Ask', dialog);
    expect(ask.disabled).toBe(true);
    const fields = () => [...dialog.querySelectorAll('text-field')];
    await r.type(fields()[0], 'Spades or Palace?');
    await r.type(fields()[1], 'Spades');
    expect(ask.disabled).toBe(true);
    await r.type(fields()[2], 'Palace');
    r.button('Add an answer', dialog).click();
    await r.flush();
    r.button('Add an answer', dialog).click();
    await r.flush();
    expect(fields()).toHaveLength(5);
    expect(r.button('Add an answer', dialog)).toBeUndefined();
    await r.type(fields()[3], 'Both');
    ask.click();
    await r.flush();
    expect(r.calls).toEqual([['ask', 'Spades or Palace?', ['Spades', 'Palace', 'Both']]]);
    expect([...r.el.querySelectorAll('dialog')].some((d) => d.open)).toBe(false);
    r.view.unmount();
  });

  test('the word filter: a switch for a manager where the server can, a badge for everyone else', async () => {
    const plain = await room(framework, { manager: true });
    expect(plain.el.querySelector('toggle-switch')).toBeNull();
    plain.view.unmount();

    const manager = await room(framework, { manager: true, canFilter: true });
    manager.el.querySelector('toggle-switch [role=switch]').click();
    await manager.flush();
    expect(manager.calls).toEqual([['setFilter', true]]);
    manager.view.unmount();

    const member = await room(framework, { canFilter: true });
    expect(member.el.querySelector('toggle-switch')).toBeNull();
    expect(member.el.textContent).not.toContain('Crude words are covered');
    await member.chat([], { filter: true });
    expect(member.el.textContent).toContain('Crude words are covered');
    member.view.unmount();
  });

  test('says when someone else said something, but not of the history or of your own', async () => {
    const r = await room(framework);
    const heard = [];
    r.el.addEventListener('heard', (event) => heard.push(event.detail.id));
    await r.chat([said(1, 'm2', 'Before you came')]);
    await r.chat([said(1, 'm2', 'Before you came'), said(2, 'm1', 'Hi all')]);
    await r.chat([said(1, 'm2', 'Before you came'), said(2, 'm1', 'Hi all'), said(3, 'm3', 'Hello love')]);
    expect(heard).toEqual([3]);
    r.view.unmount();
  });

  test('offline: nothing can be sent', async () => {
    const r = await room(framework, { online: false });
    expect(r.el.querySelector('.compose input').disabled).toBe(true);
    expect(r.button('Send').disabled).toBe(true);
    expect(r.button('Ask the house…').disabled).toBe(true);
    expect(r.el.querySelector('empty-state').textContent).toContain('Nothing kept on this device');
    r.view.unmount();
  });
});
