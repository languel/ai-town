import pathlib

# --- 1. Take the frame()-loop nudge back out of SimRuntime -------------------
rt = pathlib.Path('src/local/sim/runtime.ts')
s = rt.read_text()

start = s.index('  /**\n   * Keep the human walking towards whoever they are talking to.')
end = s.index('  private drainOperations() {')
s = s[:start] + s[end:]

s = s.replace("      this.followInvitee();\n", "", 1)
s = s.replace("  private lastFollowAttempt = 0;\n", "", 1)
s = s.replace("import { distance } from '../engine/geometry';\n", "", 1)
s = s.replace("import { findFreeSpotNear } from '../engine/movement';\n", "", 1)
s = s.replace("import { C } from '../constants';\n", "", 1)
assert 'followInvitee' not in s and 'lastFollowAttempt' not in s
rt.write_text(s)

# --- 2. Retry the walk inside the engine, where fast-forward sees it ---------
cv = pathlib.Path('src/local/engine/conversation.ts')
c = cv.read_text()

old = """    // Orient the two players towards each other if they're not moving."""
new = """    if (member1.status.kind === 'walkingOver' || member2.status.kind === 'walkingOver') {
      // Whoever is still standing still while their counterpart walks over
      // gets re-nudged: a single failed A* (a wall, a pond, a crowded doorway)
      // used to leave the pair staring at each other until INVITE_TIMEOUT
      // quietly cancelled the chat.
      const nudge = (self: Player, other: Player, selfMember: ConversationMembership) => {
        if (selfMember.status.kind !== 'walkingOver') return;
        if (self.pathfinding || self.activity) return;
        if (playerDistance <= arriveRadius) return;
        if (this.lastNudge && now - this.lastNudge < 1500) return;
        this.lastNudge = now;
        try {
          movePlayer(game, now, self, findFreeSpotNear(game, other.position, 3), true);
        } catch {
          // Nowhere safe to step; the other side keeps coming.
        }
      };
      nudge(player1, player2, member1);
      nudge(player2, player1, member2);
    }

    // Orient the two players towards each other if they're not moving."""
assert old in c
c = c.replace(old, new, 1)

# arriveRadius must exist for both blocks; hoist it out of the arrival branch.
old2 = """      // A human sits where they stand and waits, so don't make the agent walk
      // all the way into the exact conversation radius – it gives up on
      // obstacles otherwise and the chat silently never starts.
      const arriveRadius =
        C.CONVERSATION_DISTANCE + (player1.human || player2.human ? 1.0 : 0);
      if (playerDistance < arriveRadius) {"""
new2 = """      if (playerDistance < arriveRadius) {"""
assert old2 in c
c = c.replace(old2, new2, 1)

old3 = """    if (member1.status.kind === 'walkingOver' && member2.status.kind === 'walkingOver') {"""
new3 = """    // A human sits where they stand and waits, so don't make the other person
    // walk all the way into the exact conversation radius - they give up on
    // obstacles otherwise and the chat silently never starts.
    const arriveRadius = C.CONVERSATION_DISTANCE + (player1.human || player2.human ? 1.0 : 0);

    if (member1.status.kind === 'walkingOver' && member2.status.kind === 'walkingOver') {"""
assert old3 in c
c = c.replace(old3, new3, 1)

# imports + ephemeral field
old_imp = "import { stopPlayer, blocked, movePlayer } from './movement';"
assert old_imp in c
c = c.replace(old_imp, "import { stopPlayer, blocked, movePlayer, findFreeSpotNear } from './movement';", 1)

old4 = """export class Conversation extends GameObject {"""
new4 = """export class Conversation extends GameObject {
  /** Ephemeral throttle for re-nudging a stuck participant; not serialized. */
  lastNudge?: number;
"""
assert old4 in c
c = c.replace(old4, new4, 1)


cv.write_text(c)
print('patched')
