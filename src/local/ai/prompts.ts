import { createLocalStore } from '../db/settings';

/**
 * Editable prompt templates.
 *
 * These are the prompts the original Convex agent built by string
 * concatenation (see `convex/agent/conversation.ts` and `convex/agent/memory.ts`),
 * lifted into a named, {{interpolated}} form you can edit in the Personality tab.
 * Overrides are stored in localStorage (`aifavella.prompts`) so they're part of an
 * export and survive reloads.
 */

export const PROMPT_KEYS = [
  'chat.start',
  'chat.continue',
  'chat.leave',
  'memory.summarize',
  'memory.importance',
  'memory.reflect',
] as const;

export type PromptKey = (typeof PROMPT_KEYS)[number];

export const PROMPT_LABELS: Record<PromptKey, string> = {
  'chat.start': 'Opening line',
  'chat.continue': 'Reply',
  'chat.leave': 'Closing line',
  'memory.summarize': 'Conversation summary (memory)',
  'memory.importance': 'Importance rating',
  'memory.reflect': 'Reflection',
};

export const PROMPT_HINTS: Record<PromptKey, string> = {
  'chat.start': 'System prompt used when the agent greets someone.',
  'chat.continue': 'System prompt for each turn; chat history is appended as user messages.',
  'chat.leave': 'System prompt for the goodbye that ends a conversation.',
  'memory.summarize': 'Asked after a conversation ends; the answer is stored as a memory.',
  'memory.importance': 'Rates a memory 0-9 (drives recall ranking). Answer must be a number.',
  'memory.reflect': 'Turns recent memories into 3 self-insights (JSON out).',
};

export const PROMPT_VARIABLES: Record<PromptKey, string[]> = {
  'chat.start': [
    'name',
    'otherName',
    'identity',
    'plan',
    'otherIdentity',
    'otherPlan',
    'styleNotes',
    'memories',
    'lastPrompt',
    'now',
  ],
  'chat.continue': [
    'name',
    'otherName',
    'identity',
    'plan',
    'otherIdentity',
    'otherPlan',
    'styleNotes',
    'memories',
    'started',
    'now',
    'lastPrompt',
  ],
  'chat.leave': [
    'name',
    'otherName',
    'identity',
    'plan',
    'styleNotes',
    'lastPrompt',
  ],
  'memory.summarize': ['name', 'otherName', 'chatLog'],
  'memory.importance': ['description'],
  'memory.reflect': ['name', 'statements'],
};

export const DEFAULT_PROMPTS: Record<PromptKey, string> = {
  'chat.start': `You are {{name}}, and you just started a conversation with {{otherName}}.
About you: {{identity}}
Your goals for the conversation: {{plan}}
About {{otherName}}: {{otherIdentity}}
{{styleNotes}}
{{memories}}
If you have talked to {{otherName}} before, casually refer to something from that conversation.
Keep your reply short: 1-2 sentences, under 200 characters. Do not narrate actions.
{{lastPrompt}}`,

  'chat.continue': `You are {{name}}, and you're currently in a conversation with {{otherName}}.
The conversation started at {{started}}. It's now {{now}}.
About you: {{identity}}
Your goals for the conversation: {{plan}}
About {{otherName}}: {{otherIdentity}}
{{styleNotes}}
{{memories}}
Below is the current chat history between you and {{otherName}}.
DO NOT greet them again. Do NOT use the word "Hey" too often. Your response should be brief and within 200 characters.
{{lastPrompt}}`,

  'chat.leave': `You are {{name}}, and you're currently in a conversation with {{otherName}}.
You've decided to leave the conversation and would like to politely tell them you're leaving.
About you: {{identity}}
Your goals for the conversation: {{plan}}
{{styleNotes}}
Below is the current chat history between you and {{otherName}}.
How would you like to tell them that you're leaving? Your response should be brief and within 200 characters.
{{lastPrompt}}`,

  'memory.summarize': `You are {{name}}, and you just finished a conversation with {{otherName}}. I would
like you to summarize the conversation from {{name}}'s perspective, using first-person pronouns like
"I," and add if you liked or disliked this interaction.

{{chatLog}}

Summary:`,

  'memory.importance': `On the scale of 0 to 9, where 0 is purely mundane (e.g., brushing teeth, making bed) and 9 is extremely poignant (e.g., a break up, college acceptance), rate the likely poignancy of the following piece of memory.
Memory: {{description}}
Answer on a scale of 0 to 9. Respond with number only, e.g. "5"`,

  'memory.reflect': `[no prose]
[Output only JSON]
You are {{name}}, statements about you:
{{statements}}
What 3 high-level insights can you infer from the above statements?
Return in JSON format, an array of objects like {"insight": "...", "statementIds": [1,2]}.
Make the response parseable by TypeScript JSON.parse(). Do not escape characters or include newlines.`,
};

const store = createLocalStore<Record<PromptKey, string>>('aifavella.prompts', DEFAULT_PROMPTS);

export const promptStore = store;

export function getPrompts(): Record<PromptKey, string> {
  return store.get();
}

export function getPrompt(key: PromptKey): string {
  const prompts = store.get();
  return prompts?.[key] ?? DEFAULT_PROMPTS[key];
}

export function setPrompt(key: PromptKey, value: string) {
  store.set({ ...store.get(), [key]: value });
}

export function resetPrompts() {
  store.reset();
}

export function isPromptModified(key: PromptKey): boolean {
  return (store.get()?.[key] ?? DEFAULT_PROMPTS[key]) !== DEFAULT_PROMPTS[key];
}

/** Replaces `{{var}}` (and tolerates `{{ var }}`). Unknown vars render empty. */
export function renderPrompt(template: string, vars: Record<string, unknown>): string {
  return template
    .replace(/\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g, (_all, name: string) => {
      const value = vars[name];
      if (value === undefined || value === null) return '';
      return String(value);
    })
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

export function renderPromptKey(key: PromptKey, vars: Record<string, unknown>): string {
  return renderPrompt(getPrompt(key), vars);
}
