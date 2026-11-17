/** Loaded only by verify-host-goal into a fresh DSH Web profile. */
import assert from 'node:assert/strict'
import { writeFile } from 'node:fs/promises'

export const name = 'codex-host-goal-verification'
export const inject = ['agents', 'agentLoop', 'goals', 'sessionProjections']
export function apply(ctx, config) {
  const handles = []
  const wait = async predicate => {
    for (let i = 0; i < 1200; i++) {
      if (predicate()) return
      await new Promise(resolve => setTimeout(resolve, 50))
    }
    throw new Error('Timed out waiting for host goal state')
  }
  const run = async () => {
    const create = async sessionId => {
      const handle = await ctx.agents.create({ sessionId, meta: { cwd: config.cwd }, agentOptions: { provider: 'codex', model: 'default' } })
      handles.push(handle)
      return handle.agent
    }
    const first = await create('host-goal-completion')
    ctx.goals.create(first, { objective: 'HOST_GOAL_COMPLETE_PROBE: finish in two rounds.', maxGoalRounds: 3 })
    await wait(() => {
      const goal = ctx.goals.get(first)
      assert(!['paused', 'blocked'].includes(goal?.phase), `Goal unexpectedly stopped: ${JSON.stringify(goal)}`)
      return goal?.phase === 'complete'
    })
    await first.whenIdle()
    const snapshot = ctx.sessionProjections.snapshot(first.session).values
    assert.equal(snapshot.goal.goal.phase, 'complete')
    assert.equal(snapshot.goal.roundsStarted, 2)
    assert.equal(snapshot.tavloCodex.goal.status, 'complete')
    const rounds = first.session.snapshotEvents().filter(event => event.type === 'user/message' && event.data.source.kind === 'goal' && event.data.source.round > 0)
    assert.deepEqual(rounds.map(event => event.data.source.round), [1, 2])

    const second = await create('host-goal-pause')
    ctx.goals.create(second, { objective: 'HOST_GOAL_PAUSE_PROBE: wait for user pause.', maxGoalRounds: 3 })
    await wait(() => {
      const state = ctx.sessionProjections.snapshot(second.session).values.tavloCodex
      return state?.turnId && state.goal?.status === 'active'
    })
    ctx.goals.pause(second, ctx.goals.get(second))
    await second.whenIdle()
    await wait(() => ctx.sessionProjections.snapshot(second.session).values.tavloCodex.goal?.status === 'paused')
    assert.equal(ctx.goals.get(second).phase, 'paused')
    assert.equal(ctx.goals.get(second).roundsStarted, 1)
    ctx.goals.clear(second, ctx.goals.get(second))
    await wait(() => ctx.sessionProjections.snapshot(second.session).values.tavloCodex.hostGoal === null)
    assert.equal(ctx.sessionProjections.snapshot(second.session).values.goal, null)
    assert.equal(ctx.sessionProjections.snapshot(second.session).values.tavloCodex.goal, null)
    const third = await create('host-goal-blocked')
    ctx.goals.create(third, { objective: 'HOST_GOAL_BLOCK_PROBE: verify a native blocker is shown by the host.', maxGoalRounds: 2 })
    await wait(() => ctx.goals.get(third)?.phase === 'blocked')
    await third.whenIdle()
    assert.equal(ctx.goals.get(third).blockedReason.code, 'codex-blocked')
    assert.equal(ctx.goals.get(third).roundsStarted, 1)

    const fourth = await create('host-goal-failure')
    ctx.goals.create(fourth, { objective: 'HOST_GOAL_FAILURE_PROBE: verify failed native execution stops host continuation.', maxGoalRounds: 2 })
    await wait(() => ctx.goals.get(fourth)?.phase === 'blocked')
    await fourth.whenIdle()
    assert.equal(ctx.goals.get(fourth).blockedReason.code, 'codex-turn-failed')
    assert.equal(ctx.goals.get(fourth).roundsStarted, 1)
    return { passed: true, actualDsh: true, actualCodex: true, hostRounds: 2, goalBarProjection: 'complete', nativeGoal: 'complete', pauseAndClear: true, nativeBlocker: true, nativeFailure: true }
  }
  ctx.effect(() => {
    void run().then(async result => {
      for (const handle of handles) await handle.dispose()
      await writeFile(config.result, JSON.stringify(result, null, 2))
    }).catch(async error => {
      await writeFile(config.result, JSON.stringify({ passed: false, error: String(error), stack: error.stack }, null, 2))
    })
  })
}
