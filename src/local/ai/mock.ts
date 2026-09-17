import type { ChatOptions } from './chat';

/**
 * The offline improviser.
 *
 * AI Town is more fun to poke at when it *runs* before you've configured a key,
 * so `provider: 'mock'` answers with a tiny rule-based generator: it reads the
 * same prompts the real providers get (personality, the other speaker, chat
 * history) and produces short in-character lines. It's also what the unit tests
 * use, so behaviour stays deterministic-ish without a network.
 */

const OPENERS = [
  "Hey {other}, small world.",
  "{other}! I was hoping to run into you.",
  "Well hello there, {other}.",
  "{other}, right? I think about you more than I'll admit.",
  "Psst, {other} — got a second?",
];

const SHARED_INTEREST = [
  "I've been {verb} {interest} all morning and my brain is full.",
  "Funny, I was just thinking about {interest}.",
  "Tell me honestly: do you like {interest} too?",
];

const REPLIES = [
  "Ha! {agreement} {interest} is exactly the sort of thing I chase.",
  "{agreement} I'd rather talk about {interest} than almost anything.",
  "That tracks. {planSentence}",
  "Careful, I'll take that as an invitation to keep talking.",
  "I've got a theory about that, and it involves {interest}.",
];

const LEAVERS = [
  "I should get going — {interest} waits for no one. Later, {other}!",
  "Duty calls. Good talking with you, {other}.",
  "Let me let you breathe. Catch you later, {other}!",
];

const AGREEMENT = ['Exactly.', 'Right?', 'No kidding —', 'See, this is why I like you.', 'Sure.'];

const INTERESTS = [
  'old maps',
  'thunderstorms',
  'cheap wine',
  'space elevators',
  'gardening',
  'ghost stories',
  'the price of cheese',
  'train timetables',
  'robot ethics',
  'forgotten languages',
];

const VERBS = ['reading about', 'daydreaming about', 'arguing about', 'sketching', 'organizing'];

function pick<T>(list: T[], seed: number): T {
  return list[Math.abs(seed) % list.length];
}

function hash(str: string): number {
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h | 0;
}

function extract(prompt: string, pattern: RegExp): string | undefined {
  const match = prompt.match(pattern);
  return match?.[1]?.trim();
}

function keywords(text: string): string[] {
  return (text || '')
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter((w) => w.length > 4)
    .slice(-4);
}

/**
 * @internal exported for tests
 */
export function improvise(options: ChatOptions): string {
  const system = options.messages.find((m) => m.role === 'system')?.content ?? '';
  const ctx: NonNullable<ChatOptions['context']> = options.context ?? ({} as any);

  const speaker =
    ctx.speaker ?? extract(system, /You are ([A-Z][\w' -]{1,24}?),/) ?? 'Someone';
  const listener =
    ctx.listener ?? extract(system, /with ([A-Z][\w' -]{1,24}?)[.\n]/) ?? 'you';
  const identity = ctx.identity ?? extract(system, /About you: ([^\n]+)/) ?? '';
  const plan = ctx.plan ?? extract(system, /Your goals[^:]*: ([^\n]+)/) ?? '';
  const last = ctx.lastMessage ?? [...options.messages].reverse().find((m) => m.role === 'user')?.content ?? '';

  const seed = hash(`${speaker}${listener}${last}${system.length}`);
  const interest = identity ? (keywords(identity)[0] ?? pick(INTERESTS, seed)) : pick(INTERESTS, seed);
  const planSentence = plan ? plan.replace(/^You want to /i, 'I want to ') : 'I have places to be.';
  const fill = (template: string) =>
    template
      .replace('{other}', listener)
      .replace('{speaker}', speaker)
      .replace('{interest}', interest)
      .replace('{verb}', pick(VERBS, seed >> 2))
      .replace('{agreement}', pick(AGREEMENT, seed >> 3))
      .replace('{planSentence}', planSentence);

  switch (ctx.kind) {
    case 'importance': {
      const text = (ctx.input ?? last).toLowerCase();
      const strong = ['love', 'hate', 'die', 'death', 'marry', 'fired', 'quit', 'secret', 'trust', 'betray'];
      const score = strong.reduce((acc, w) => acc + (text.includes(w) ? 2 : 0), 3);
      return String(Math.min(9, score + (Math.abs(seed) % 2)));
    }
    case 'summary': {
      const lines = options.messages
        .filter((m) => m.role === 'user')
        .map((m) => m.content)
        .filter((c) => !/^Summary:/.test(c));
      const gist = keywords(lines.join(' ')).slice(0, 3).join(', ');
      const mood = seed % 3 === 0 ? 'I enjoyed it' : seed % 3 === 1 ? 'it was pleasant enough' : 'I left with more questions than answers';
      return `I chatted with ${listener} about ${gist || 'a few things'}, and ${mood}.`;
    }
    case 'leave':
      return fill(pick(LEAVERS, seed));
    case 'start': {
      const opener = fill(pick(OPENERS, seed));
      const bridge = fill(pick(SHARED_INTEREST, seed >> 1));
      return `${opener} ${bridge}`;
    }
    case 'continue': {
      const isQuestion = /\?\s*$/.test(last.trim());
      const reply = fill(pick(REPLIES, seed));
      if (isQuestion) {
        return `${reply} ${fill(pick(SHARED_INTEREST, seed >> 4))}`;
      }
      return `${reply} ${pick(AGREEMENT, seed >> 5)}`;
    }
    default:
      return fill(pick(REPLIES, seed));
  }
}
