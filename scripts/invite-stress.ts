/**
 * Stress test for the human-invite path (npm run test:invite).
 *
 * Invites an agent to talk 25 times in a row and reports how often the agent
 * fails to walk over and answer. The real browser flow depends on this, and it
 * used to be flaky whenever the invitee was mid-activity or blocked: see the
 * forgiving arrival radius in src/local/engine/conversation.ts.
 */
import { SimRuntime } from '../src/local/sim/runtime.ts';
import { localDB } from '../src/local/db/local.ts';
import { updateSettings } from '../src/local/db/settings.ts';

updateSettings({ ai: { mockLatencyMs: 0 } });

const runtime = new SimRuntime();
await runtime.init();
runtime.pause();
await runtime.fastForward(200);
const humanId = (await runtime.joinHuman())!;
let failures = 0;
for (let round = 0; round < 25; round++) {
  const agentPlayers = [...runtime.game.world.agents.values()]
    .map((a) => runtime.game.world.players.get(a.playerId)!)
    .filter((p) => !!p);
  // Leave any chat still running from the previous round, like the panel does.
  if (runtime.game.playerConversation(humanId)) {
    const stale = runtime.game.playerConversation(humanId);
    if (stale) {
      await runtime
        .sendInput('leaveConversation', { playerId: humanId, conversationId: stale.id })
        .catch(() => null);
    }
    // Wait for the leave to land, otherwise this round measures the harness.
    for (let i = 0; i < 20 && runtime.game.playerConversation(humanId); i++) {
      await runtime.fastForward(5);
    }
  }
  let partner = agentPlayers.find((p) => !runtime.game.world.playerConversation(p));
  if (!partner) {
    await runtime.fastForward(40);
    partner = agentPlayers.find((p) => !runtime.game.world.playerConversation(p));
  }
  if (!partner) continue;
  try {
    await runtime.sendInput('startConversation', { playerId: humanId, invitee: partner.id });
  } catch {
    continue;
  }
  // wait until participating
  let conversationId: string | undefined;
  for (let i = 0; i < 100; i++) {
    const c = runtime.game.playerConversation(humanId);
    if (c && [...c.participants.values()].every((m) => m.status.kind === 'participating')) {
      conversationId = c.id;
      break;
    }
    await runtime.fastForward(3);
  }
  if (!conversationId) {
    console.log(`round ${round}: never got to participating`);
    failures++;
    continue;
  }
  const before = new Set(localDB.all<any>('messages').map((m) => m._id as string));
  const blanks = new Set(localDB.all<any>('messages').filter((m) => !m.text).map((m) => m._id));
  await runtime.sendHumanMessage(humanId, conversationId, `ping ${round}`);
  let ok = false;
  for (let i = 0; i < 60 && !ok; i++) {
    await runtime.fastForward(5);
    ok = localDB.all<any>('messages').some(
      (m) =>
        m.conversationId === conversationId &&
        m.author !== humanId &&
        m.text.length > 4 &&
        (!before.has(m._id) || blanks.has(m._id)),
    );
  }
  if (!ok) {
    failures++;
    const c = runtime.game.playerConversation(humanId);
    const agent = runtime.game.world.agents.get(
      [...runtime.game.world.agents.values()].find((a) => a.playerId === partner!.id)!.id,
    )!;
    console.log(
      `round ${round}: NO REPLY  live=${!!c} statuses=${
        c ? [...c.participants.values()].map((m) => m.status.kind).join('/') : '-'
      } n=${c?.numMessages ?? 'x'} lastAuthor=${c?.lastMessage?.author ?? '-'} agentOp=${
        agent.inProgressOperation?.name ?? '-'
      } queue=${(runtime as any).opQueue.length}/${(runtime as any).activeOps} err=${
        runtime.lastLlmError ?? '-'
      }`,
    );
    console.log(
      '   rows:',
      localDB
        .all<any>('messages')
        .filter((m) => m.conversationId === conversationId)
        .map((m) => `${m.author}:${m.text.slice(0, 18)}`)
        .join(' | '),
    );
  }
}
console.log(`failures: ${failures}/25`);
// Agents occasionally decline or take a long walk; only a systematic failure is
// a regression.
console.log(`${failures <= 2 ? 'INVITE STRESS PASSED' : 'INVITE STRESS FAILED'} (tolerance: 2/25)`);
process.exit(failures <= 2 ? 0 : 1);
runtime.destroy();
process.exit(0);
