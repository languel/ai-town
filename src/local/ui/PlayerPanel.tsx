import { useEffect, useMemo, useRef, useState } from 'react';
import clsx from 'clsx';
import { useTown, useMessages, useDbRevision } from '../state.tsx';
import type { GameId } from '../engine/ids.ts';
import type { Message } from '../db/schema.ts';
import { localDB } from '../db/local.ts';
import type { ArchivedConversation } from '../db/schema.ts';

/**
 * The right-hand panel: who you selected, what they're like, and the live chat.
 * Replaces `PlayerDetails.tsx` + `Messages.tsx` + `MessageInput.tsx`.
 */
export function PlayerPanel({
  playerId,
  onSelectPlayer,
}: {
  playerId?: GameId<'players'>;
  onSelectPlayer: (id?: GameId<'players'>) => void;
}) {
  const { runtime, world, playerDescriptions, agentDescriptions } = useTown();
  useDbRevision();
  const humanPlayerId = runtime.humanPlayerId ;
  const player = playerId ? world.players.get(playerId) : undefined;
  const description = playerId ? playerDescriptions.get(playerId) : undefined;
  const agent = playerId ? world.agentForPlayer(playerId) : undefined;
  const agentDescription = agent ? agentDescriptions.get(agent.id) : undefined;
  const conversation = player ? world.playerConversation(player) : undefined;
  const humanPlayer = humanPlayerId ? world.players.get(humanPlayerId) : undefined;
  const humanConversation = humanPlayer ? world.playerConversation(humanPlayer) : undefined;

  const withMe =
    !!humanConversation && !!playerId && humanConversation.participants.has(playerId);
  const activeConversationId = withMe ? humanConversation.id : conversation?.id;
  const messages = useMessages(activeConversationId);

  const humanStatus = humanPlayerId
    ? humanConversation?.participants.get(humanPlayerId)?.status
    : undefined;
  const theirStatus = withMe ? humanConversation?.participants.get(playerId)?.status : undefined;
  /** The agent was invited by us and hasn't answered yet. */
  const theyHaveInvite = withMe && theirStatus?.kind === 'invited';
  /** An agent invited *us* — the human is the one who has to answer. */
  const iHaveInvite = !!humanPlayerId && humanStatus?.kind === 'invited';

  const canInvite = !!humanPlayerId && !!playerId && !conversation && !humanConversation;

  const archived = useMemo(() => {
    if (!playerId) return undefined;
    const list = localDB
      .all<ArchivedConversation>('conversations')
      .filter((c) => c.participants.includes(playerId))
      .sort((a, b) => b.ended - a.ended);
    return list[0];
  }, [playerId, messages.length, world.conversations.size]);

  if (!playerId || !player) {
    return <CastList onSelectPlayer={onSelectPlayer} selected={playerId} />;
  }

  const isMe = humanPlayerId === playerId;

  return (
    <div className="flex h-full flex-col gap-3">
      <div className="flex items-start justify-between gap-2">
        <div>
          <h2 className="font-display text-2xl leading-none">{description?.name}</h2>
          <p className="text-xs text-brown-200">
            {isMe ? 'That’s you' : agent ? 'AI agent' : 'Player'} · {playerId}
          </p>
        </div>
        <button
          className="rounded bg-brown-700 px-2 py-1 text-xs hover:bg-brown-500"
          onClick={() => onSelectPlayer(undefined)}
        >
          ✕
        </button>
      </div>

      <div className="rounded bg-brown-900/60 p-2 text-xs leading-snug">
        <p>{description?.description}</p>
        {agentDescription && (
          <details className="mt-1">
            <summary className="cursor-pointer text-brown-200">personality & goals</summary>
            <p className="mt-1 whitespace-pre-wrap">{agentDescription.identity}</p>
            <p className="mt-1 italic text-brown-200">{agentDescription.plan}</p>
          </details>
        )}
        {player.activity && player.activity.until > runtime.game.currentTime && (
          <p className="mt-1">
            {player.activity.emoji} {player.activity.description}
          </p>
        )}
      </div>

      <div className="flex flex-wrap gap-2">
        {canInvite && (
          <PanelButton
            onClick={() =>
              void runtime
                .sendInput('startConversation', { playerId: humanPlayerId, invitee: playerId })
                .catch((e: Error) => console.warn(e.message))
            }
          >
            💬 Start conversation
          </PanelButton>
        )}
        {iHaveInvite && humanConversation && (
          <PanelButton
            onClick={() =>
              void runtime
                .sendInput('acceptInvite', {
                  playerId: humanPlayerId,
                  conversationId: humanConversation.id,
                })
                .catch((e: Error) => console.warn(e.message))
            }
          >
            ✅ Accept
          </PanelButton>
        )}
        {iHaveInvite && humanConversation && (
          <PanelButton
            onClick={() =>
              void runtime
                .sendInput('rejectInvite', {
                  playerId: humanPlayerId,
                  conversationId: humanConversation.id,
                })
                .catch(() => null)
            }
          >
            ⛔ Decline
          </PanelButton>
        )}
        {theyHaveInvite && (
          <span className="self-center text-xs opacity-70">waiting for {description?.name}…</span>
        )}
        {withMe && (
          <PanelButton
            onClick={() =>
              void runtime
                .sendInput('leaveConversation', {
                  playerId: humanPlayerId!,
                  conversationId: humanConversation.id,
                })
                .catch(() => null)
            }
          >
            🚪 Leave conversation
          </PanelButton>
        )}
        {!withMe && theirStatus && (
          <span className="self-center text-xs text-brown-200">
            {theirStatus.kind === 'walkingOver' ? 'walking over…' : 'in a conversation'}
          </span>
        )}
      </div>

      <ConversationView
        conversationId={activeConversationId}
        messages={messages}
        typingPlayerId={
          (withMe ? humanConversation : conversation)?.isTyping?.playerId as string | undefined
        }
        names={playerDescriptions}
      />

      {withMe && (
        <ChatInput
          onSend={(text) => void runtime.sendHumanMessage(humanPlayerId!, humanConversation.id, text)}
        />
      )}

      {!activeConversationId && archived && (
        <details className="mt-auto">
          <summary className="cursor-pointer text-xs text-brown-200">
            last conversation ({new Date(archived.ended).toLocaleString()})
          </summary>
          <ConversationView
            conversationId={archived.id}
            messages={localDB
              .all<Message>('messages')
              .filter((m) => m.conversationId === archived.id)
              .sort((a, b) => a._creationTime - b._creationTime)}
            names={playerDescriptions}
          />
        </details>
      )}
    </div>
  );
}

function ConversationView({
  conversationId,
  messages,
  typingPlayerId,
  names,
}: {
  conversationId?: string;
  messages: Message[];
  typingPlayerId?: string;
  names: Map<any, { name: string }>;
}) {
  const scroller = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = scroller.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages.length, typingPlayerId, conversationId]);

  if (!conversationId) return null;
  return (
    <div
      ref={scroller}
      className="min-h-[80px] flex-1 space-y-2 overflow-y-auto rounded bg-brown-200 p-2 text-black"
    >
      {messages.length === 0 && (
        <p className="text-center text-xs italic opacity-70">
          {typingPlayerId ? 'someone is typing…' : 'no messages yet'}
        </p>
      )}
      {messages.map((message) => (
        <div key={message._id} className="text-sm leading-tight">
          <div className="flex justify-between text-[10px] uppercase">
            <span>{names.get(message.author as any)?.name ?? message.author}</span>
            <time>{new Date(message._creationTime).toLocaleTimeString()}</time>
          </div>
          <p className={clsx('rounded bg-white px-2 py-1', message.isStreaming && 'italic opacity-80')}>
            {message.text || '…'}
          </p>
        </div>
      ))}
    </div>
  );
}

function ChatInput({ onSend }: { onSend: (text: string) => void }) {
  const [value, setValue] = useState('');
  return (
    <form
      className="flex gap-2"
      onSubmit={(e) => {
        e.preventDefault();
        const text = value.trim();
        if (!text) return;
        onSend(text);
        setValue('');
      }}
    >
      <input
        value={value}
        onChange={(e) => setValue(e.target.value)}
        placeholder="Say something…"
        className="min-w-0 flex-1 rounded border border-brown-700 bg-brown-900 px-2 py-1 text-sm text-white outline-none focus:border-brown-300"
      />
      <button
        type="submit"
        className="rounded bg-clay-700 px-3 py-1 text-sm hover:bg-clay-500"
      >
        Send
      </button>
    </form>
  );
}

function CastList({
  selected,
  onSelectPlayer,
}: {
  selected?: GameId<'players'>;
  onSelectPlayer: (id?: GameId<'players'>) => void;
}) {
  const { world, playerDescriptions, runtime } = useTown();
  useDbRevision();
  const players = [...world.players.values()];
  return (
    <div className="flex h-full flex-col gap-2">
      <h2 className="font-display text-xl">In town</h2>
      <p className="text-xs text-brown-200">
        Click a face on the map (or below) to open a chat. Nothing here needs a server.
      </p>
      <div className="flex flex-col gap-1">
        {players.map((player) => {
          const description = playerDescriptions.get(player.id);
          const agent = world.agentForPlayer(player.id);
          const conversation = world.playerConversation(player);
          const status = agent?.inProgressOperation
            ? 'thinking'
            : conversation
              ? 'talking'
              : player.pathfinding
                ? 'walking'
                : 'idle';
          return (
            <button
              key={player.id}
              onClick={() => onSelectPlayer(player.id)}
              className={clsx(
                'flex items-center justify-between gap-2 rounded px-2 py-1 text-left text-sm hover:bg-brown-700',
                selected === player.id && 'bg-brown-700',
              )}
            >
              <span>{description?.name ?? player.id}</span>
              <span className="text-[10px] uppercase text-brown-200">{status}</span>
            </button>
          );
        })}
        {players.length === 0 && (
          <button
            className="mt-2 rounded bg-clay-700 px-3 py-2 text-sm hover:bg-clay-500"
            onClick={() => void runtime.joinHuman()}
          >
            Nobody is here — join the town
          </button>
        )}
      </div>
    </div>
  );
}

function PanelButton({ onClick, children }: { onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      onClick={onClick}
      className="rounded border border-white/20 bg-clay-700 px-2 py-1 text-xs hover:bg-clay-500"
    >
      {children}
    </button>
  );
}
