import type { SimRuntime } from '../sim/runtime';
import { C } from '../constants';
import { getSettings } from '../db/settings';
import { localDB } from '../db/local';
import type { ArchivedConversation, Message, ParticipatedTogether } from '../db/schema';
import { chatCompletion } from './chat';
import { renderPromptKey } from './prompts';
import {
  calculateImportance,
  formatMemoriesForPrompt,
  insertMemory,
  reflectOnMemories,
  searchMemories,
} from './memory';
import { findFreeSpot } from '../engine/inputs';
import { findFreeSpotNear } from '../engine/movement';

/**
 * The async half of the agents — what the Convex build ran in "actions".
 * Each job reads the world, calls the configured provider, then hands the
 * result back to the engine as an input.
 */

function names(runtime: SimRuntime, playerId: string) {
  const description = runtime.game.playerDescriptions.get(playerId as any);
  return { name: description?.name ?? 'Unknown', description };
}

function agentInfo(runtime: SimRuntime, playerId: string) {
  const agent = [...runtime.game.world.agents.values()].find(
    (a) => a.playerId === (playerId as any),
  );
  if (!agent) return null;
  const description = runtime.game.agentDescriptions.get(agent.id);
  return {
    agentId: agent.id,
    identity: description?.identity ?? '',
    plan: description?.plan ?? '',
    styleNotes: description?.styleNotes ?? '',
  };
}

function conversationMessages(runtime: SimRuntime, conversationId: string): Message[] {
  return localDB
    .all<Message>('messages')
    .filter((m) => m.conversationId === conversationId)
    .sort((a, b) => a._creationTime - b._creationTime);
}

async function buildPrompt(
  runtime: SimRuntime,
  type: 'start' | 'continue' | 'leave',
  playerId: string,
  otherPlayerId: string,
  conversationId: string,
) {
  const { name } = names(runtime, playerId);
  const { name: otherName } = names(runtime, otherPlayerId);
  const me = agentInfo(runtime, playerId);
  const other = agentInfo(runtime, otherPlayerId);
  const conversation = runtime.game.world.conversations.get(conversationId as any);

  const memoriesQuery =
    type === 'start'
      ? `${name} is talking to ${otherName}`
      : `What do you think about ${otherName}?`;
  const memories = getSettings().ai.useFor.memories
    ? await searchMemories(playerId, memoriesQuery, C.NUM_MEMORIES_TO_SEARCH).catch(() => [])
    : [];

  const lastPrompt = `${name} to ${otherName}:`;
  const vars: Record<string, unknown> = {
    name,
    otherName,
    identity: me?.identity ?? '',
    plan: me?.plan ?? '',
    styleNotes: me?.styleNotes ? `Style notes: ${me.styleNotes}` : '',
    otherIdentity: other?.identity ?? '',
    otherPlan: other?.plan ?? '',
    memories: formatMemoriesForPrompt(memories),
    lastPrompt,
    now: new Date().toLocaleString(),
    started: conversation ? new Date(conversation.created).toLocaleString() : 'just now',
  };

  if (type === 'start' && memories.length > 0) {
    const shared = memories.find(
      (m) => m.memory.data?.type === 'conversation' && (m.memory.data as any).playerIds?.includes(otherPlayerId),
    );
    if (shared) {
      vars.memories = `${String(vars.memories ?? '')}\nYou also remember: ${String(shared.memory.description)}`;
    }
  }

  const system = renderPromptKey(`chat.${type}`, vars);
  const messages = [
    { role: 'system' as const, content: system },
    ...conversationMessages(runtime, conversationId).map((m) => {
      const author = m.author === playerId ? name : otherName;
      const recipient = m.author === playerId ? otherName : name;
      return {
        role: 'user' as const,
        content: `${author} to ${recipient}: ${m.text}`,
      };
    }),
    { role: 'user' as const, content: lastPrompt },
  ];
  return { messages, lastPrompt, name, otherName, identity: String(vars.identity ?? ''), plan: String(vars.plan ?? '') };
}

export async function generateConversationMessage(
  runtime: SimRuntime,
  args: {
    playerId: string;
    agentId: string;
    conversationId: string;
    otherPlayerId: string;
    messageUuid: string;
    type: 'start' | 'continue' | 'leave';
    operationId: string;
  },
): Promise<void> {
  const { messages, name, otherName, identity, plan } = await buildPrompt(
    runtime,
    args.type,
    args.playerId,
    args.otherPlayerId,
    args.conversationId,
  );

  const messageId = `msg-${args.messageUuid}`;
  let streamed = '';
  let lastPaint = 0;
  const settings = getSettings().ai;

  // Create a placeholder row so the UI shows the bubble (and "typing...") while
  // tokens stream in — same trick the hosted version used with its streaming writes.
  localDB.put<Message>('messages', {
    _id: messageId,
    _creationTime: Date.now(),
    conversationId: args.conversationId,
    messageUuid: args.messageUuid,
    author: args.playerId,
    worldId: 'world',
    text: '',
    isStreaming: true,
  });

  const paint = (text: string, done = false) => {
    const now = Date.now();
    if (!done && now - lastPaint < 60) return;
    lastPaint = now;
    localDB.patch('messages', messageId, { text, isStreaming: !done });
  };

  let text: string;
  try {
    text = await chatCompletion({
      messages,
      maxTokens: settings.maxTokens,
      stop: [`${name} to`, `${otherName} to`],
      context: {
        kind: args.type,
        speaker: name,
        listener: otherName,
        identity,
        plan,
        lastMessage: messages.at(-2)?.content,
      },
      onToken: (token) => {
        streamed += token;
        paint(streamed);
      },
    });
  } catch (e: any) {
    console.warn(`Message generation failed for ${name}: ${e?.message}`);
    localDB.delete('messages', messageId);
    // Release the conversation lock so agents don't stall forever.
    await runtime.sendInput('agentFinishSendingMessage', {
      agentId: args.agentId,
      conversationId: args.conversationId,
      timestamp: runtime.game.currentTime,
      operationId: args.operationId,
      leaveConversation: false,
    });
    runtime.log('warn', 'ai', `${name} gave up on replying: ${e?.message}`);
    return;
  }

  text = (text || streamed).trim();
  // A model that ignores the stop list can keep "writing" the other speaker.
  for (const marker of [`\n${otherName} to`, `${otherName} to:`]) {
    const at = text.indexOf(marker);
    if (at >= 0) text = text.slice(0, at).trim();
  }
  text = text.replace(/^["']|["']$/g, '').slice(0, 600);

  if (!text) {
    localDB.delete('messages', messageId);
  } else {
    paint(text, true);
  }

  await runtime.sendInput('agentFinishSendingMessage', {
    agentId: args.agentId,
    conversationId: args.conversationId,
    timestamp: runtime.game.currentTime,
    operationId: args.operationId,
    leaveConversation: args.type === 'leave',
  });
  runtime.log('info', 'ai', `${name} → ${otherName}: ${text.slice(0, 80)}`);
}

export async function rememberConversation(
  runtime: SimRuntime,
  args: { playerId: string; agentId: string; conversationId: string; operationId: string },
): Promise<void> {
  const { playerId, conversationId, operationId, agentId } = args;
  try {
    const messages = conversationMessages(runtime, conversationId);
    if (messages.length === 0) return;
    const player = names(runtime, playerId);
    const otherMessage = messages.find((m) => m.author !== playerId);
    const otherId = otherMessage?.author;
    const otherName = otherId ? names(runtime, otherId).name : 'someone';

    const chatLog = messages
      .map((m) => {
        const author = m.author === playerId ? player.name : otherName;
        const recipient = m.author === playerId ? otherName : player.name;
        return `${author} to ${recipient}: ${m.text}`;
      })
      .join('\n');

    const summary = await chatCompletion({
      messages: [
        {
          role: 'user',
          content: renderPromptKey('memory.summarize', {
            name: player.name,
            otherName,
            chatLog,
          }),
        },
      ],
      maxTokens: 500,
      context: { kind: 'summary', speaker: player.name, listener: otherName },
    });

    const conversation = localDB.first<ArchivedConversation>(
      'conversations',
      (c) => c.id === conversationId,
    );
    const description = `Conversation with ${otherName} at ${new Date(
      conversation?.created ?? Date.now(),
    ).toLocaleString()}: ${summary.trim()}`;
    const importance = await calculateImportance(description);
    const playerIds = [...new Set(messages.map((m) => m.author))].filter((a) => a !== playerId);

    await insertMemory({
      playerId,
      description,
      importance,
      lastAccess: messages.at(-1)?._creationTime ?? Date.now(),
      data: { type: 'conversation', conversationId, playerIds },
    });

    await reflectOnMemories(playerId, player.name);
    runtime.log('info', 'memory', `${player.name} remembered "${description.slice(0, 70)}…"`);
  } catch (e: any) {
    runtime.log('warn', 'memory', `Remembering failed: ${e?.message}`);
  } finally {
    await runtime
      .sendInput('finishRememberConversation', { agentId, operationId })
      .catch(() => null);
  }
}

/**
 * Decide what an idle agent does next: wander, do an activity, or go talk to
 * someone. Rule-based like the original — no LLM round-trip in the hot path.
 */
export async function doSomething(
  runtime: SimRuntime,
  args: {
    player: any;
    agent: any;
    map: any;
    otherFreePlayers: any[];
    operationId: string;
  },
): Promise<void> {
  const { player, agent, operationId } = args;
  // Engine timestamps (activity expiry, cooldowns) live on the simulation clock,
  // not the wall clock: they're compared against game.currentTime inside ticks.
  const now = runtime.game.currentTime;
  const justLeftConversation =
    agent.lastConversation && now < agent.lastConversation + C.CONVERSATION_COOLDOWN;
  const recentlyAttemptedInvite =
    agent.lastInviteAttempt && now < agent.lastInviteAttempt + C.CONVERSATION_COOLDOWN;
  const recentActivity = player.activity && now < player.activity.until + C.ACTIVITY_COOLDOWN;

  const finish = (extra: Record<string, unknown>) =>
    runtime.sendInput('finishDoSomething', {
      operationId,
      agentId: agent.id,
      ...extra,
    });

  if (!player.pathfinding) {
    if (recentActivity || justLeftConversation) {
      const spot = findFreeSpot(runtime.game) ?? findFreeSpotNear(runtime.game, player.position);
      await finish({ destination: spot });
      return;
    }
    const activity = C.ACTIVITIES[Math.floor(Math.random() * C.ACTIVITIES.length)];
    await finish({
      activity: {
        description: activity.description,
        emoji: activity.emoji,
        until: now + activity.duration,
      },
    });
    return;
  }

  if (justLeftConversation || recentlyAttemptedInvite) {
    await finish({});
    return;
  }

  const invitee = findConversationCandidate(runtime, player, args.otherFreePlayers, now);
  await finish({ invitee });
}

/** Port of `convex/aiTown/agent.ts#findConversationCandidate`. */
function findConversationCandidate(
  runtime: SimRuntime,
  player: any,
  otherFreePlayers: any[],
  now: number,
): string | undefined {
  const candidates: { id: string; distance: number }[] = [];
  for (const otherPlayer of otherFreePlayers) {
    const edges = localDB
      .all<ParticipatedTogether>('participatedTogether')
      .filter(
        (e) =>
          (e.player1 === player.id && e.player2 === otherPlayer.id) ||
          (e.player1 === otherPlayer.id && e.player2 === player.id),
      )
      .sort((a, b) => b.ended - a.ended);
    const last = edges[0];
    if (last && now < last.ended + C.PLAYER_CONVERSATION_COOLDOWN) continue;
    const dx = otherPlayer.position.x - player.position.x;
    const dy = otherPlayer.position.y - player.position.y;
    candidates.push({ id: otherPlayer.id, distance: Math.hypot(dx, dy) });
  }
  candidates.sort((a, b) => a.distance - b.distance);
  return candidates[0]?.id;
}
