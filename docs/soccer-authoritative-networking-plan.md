# SoccerMap Multiplayer Physics Rework Plan and Status

Last updated: 2026-02-08

## Objective

Make SoccerMap movement feel stable at normal latency (for example 40-70ms RTT) while keeping **server authority** over:

- player physics state
- ball physics state
- collisions, knockback, and skills

The client should only predict for responsiveness, then reconcile cleanly to server truth.

## Implementation Status (2026-02-08)

The following lag/rubberbanding items are now implemented in code:

1. Input downsampling removed:
- Client now sends all fixed-tick inputs in ordered batches (`playerInputBatch`) instead of dropping to latest-only state.
- Files: `/Users/AndrewPinon/projects/workdash/src/game/scenes/SoccerMap.ts`, `/Users/AndrewPinon/projects/workdash-media-server/src/services/game.service.ts`.

2. Input send decoupled from render FPS:
- Soccer input flush now runs on its own timer (8ms cadence), not per-frame `update()`.
- File: `/Users/AndrewPinon/projects/workdash/src/game/scenes/SoccerMap.ts`.

3. Server input application hardened:
- Server now stores an ordered per-player input queue and applies one queued input each authoritative tick.
- Stale/duplicate sequences are dropped against `lastProcessedSequence`.
- File: `/Users/AndrewPinon/projects/workdash-media-server/src/services/soccer.service.ts`.

4. Local prediction now models authoritative interaction forces:
- Local player-side collision/ball knockback prediction is enabled.
- Ball knockback prediction is edge-triggered (contact start only), matching server behavior and preventing repeated local impulse stacking.
- File: `/Users/AndrewPinon/projects/workdash/src/game/player/player.ts`.

5. Reconciliation smoothing tightened:
- Reconciliation now uses dynamic correction thresholds and sequence-lag-aware blending to reduce visible pullbacks while moving.
- Startup grace is reduced to avoid long deferred corrections.
- File: `/Users/AndrewPinon/projects/workdash/src/game/player/player.ts`.

6. Camera follow latency reduced (non-soccer base scenes):
- Base camera follow lerp increased for faster camera convergence.
- File: `/Users/AndrewPinon/projects/workdash/src/game/scenes/BaseGameScene.ts`.

7. Movement feel retuned for lower perceived sluggishness:
- Shared authoritative constants updated: higher accel/drag and adjusted correction thresholds.
- File pair (kept synchronized):
- `/Users/AndrewPinon/projects/workdash/src/game/soccer/shared-physics.ts`
- `/Users/AndrewPinon/projects/workdash-media-server/src/services/shared-physics.ts`

8. Server loop pacing improved:
- Replaced tight recursive `setImmediate` loop with a drift-corrected monotonic scheduler (`setTimeout` + hrtime target).
- File: `/Users/AndrewPinon/projects/workdash-media-server/src/services/soccer.service.ts`.

## Current Implementation Audit (Server + Client)

### Server

- Input entry point: `src/services/game.service.ts` (`playerInput` -> `SoccerService.updatePlayerInput`).
- Physics simulation + reconciliation data: `src/services/soccer.service.ts`.
- Shared deterministic kernel: `src/services/shared-physics.ts`.

### Client

- Local prediction + reconciliation: `/Users/AndrewPinon/projects/workdash/src/game/player/player.ts`.
- Soccer scene networking: `/Users/AndrewPinon/projects/workdash/src/game/scenes/SoccerMap.ts`.
- Ball prediction + reconciliation: `/Users/AndrewPinon/projects/workdash/src/game/soccer/Ball.ts`.
- Shared deterministic kernel: `/Users/AndrewPinon/projects/workdash/src/game/soccer/shared-physics.ts`.

## Key Findings

### 1) Critical loop lifecycle bug (high severity)

`SoccerService.startPhysicsLoop()` uses recursive `setImmediate`, but startup and teardown are guarded by `updateInterval`, which is never assigned in that path.

Result:

- each new `SoccerService` construction can start another physics loop
- loops do not stop via existing `cleanup()` logic
- server authority becomes unstable and non-deterministic under multiple connections

References:

- `src/services/soccer.service.ts:495`
- `src/services/soccer.service.ts:542`
- `src/services/soccer.service.ts:2058`

Status:

- Fixed in Phase 0.

### 2) Input queue model can process stale intent

Current model queues many per-tick client inputs and consumes one queued input per server tick.

At jitter or burst delivery, the server can apply old intent for too long before catching up, which increases correction churn.

References:

- `/Users/AndrewPinon/projects/workdash/src/game/scenes/SoccerMap.ts:487`
- `src/services/soccer.service.ts:169`
- `src/services/soccer.service.ts:843`
- `src/services/soccer.service.ts:2275`

### 3) Local prediction does not model all authoritative forces

Server applies player-player collision resolution and ball knockback each physics tick; client prediction intentionally disables local collision prediction by default.

This guarantees frequent divergence in contested play, then visible server corrections.

References:

- `/Users/AndrewPinon/projects/workdash/src/game/player/player.ts:85`
- `src/services/soccer.service.ts:836`
- `src/services/soccer.service.ts:923`

### 4) Reconciliation is sequence-based but not tick-anchored end-to-end

Client replays unacked inputs from server state, but correction policy is primarily distance-threshold driven and can produce repeated medium corrections in dynamic interactions.

References:

- `/Users/AndrewPinon/projects/workdash/src/game/player/player.ts:569`
- `src/services/soccer.service.ts:1054`

## Target Networking Model

### Authoritative server simulation

- Single soccer simulation loop (fixed tick, one owner).
- Lifecycle tied to active SoccerMap participants, not generic socket connections.
- All gameplay state transitions mutate only on server simulation ticks.

### Input protocol (client -> server)

- Send compact input state (`bitmask`) + `sequence` + `clientTick`.
- Send at input change + low-rate heartbeat (for hold states), not one emit per local physics tick.
- Server stores **latest known input state** per player for current/future ticks (no long backlog replay).

### Snapshot protocol (server -> client)

- Broadcast player snapshots at stable cadence (for example 20-30Hz).
- Include `serverTick`.
- Include per-player physics state.
- Include `lastProcessedSequence` ack per player.
- Include optional impulse/event metadata (collisions, knockback source, resets).

### Client local player

- Predict immediately using shared kernel.
- On snapshot, reset to authoritative state at `serverTick`.
- Replay unacked inputs from `lastProcessedSequence + 1`.
- Apply bounded correction policy (tiny ignore, medium smooth, large snap).

### Client remote players

- Interpolate purely from server snapshots buffered by server tick time.
- Avoid mixing legacy movement channels with SoccerMap physics snapshots.

## Phased Implementation Plan

### Phase 0 - Stabilize current authority path (hotfixes)

- Fix loop lifecycle bug so only one soccer simulation loop can run.
- Start loop only when first active SoccerMap player exists; stop when none remain.
- Add diagnostics counter for active loops and server tick rate.

Exit criteria:

- one loop instance in logs/metrics under connect-disconnect churn
- stable server tick progression

Implementation status:

- Completed in `/Users/AndrewPinon/projects/workdash-media-server/src/services/soccer.service.ts`.
- Physics loop now has an explicit single-runner guard (`isPhysicsLoopRunning`) and stop path.
- Loop lifecycle is now tied to active SoccerMap players (`activeSoccerPlayers`) via:
- `updatePlayerPhysicsState(...)` to start
- `removePlayerPhysics(...)` to stop when the last player leaves
- Added periodic loop diagnostics logs (tick-rate and active-player count).
- Added monotonic sequence hardening in `updatePlayerInput(...)` to drop stale out-of-order packets.
- Replaced queued input replay with latest-state input application to reduce stale-intent drift.
- Ball knockback on players is now edge-triggered per contact, preventing repeated per-tick impulse stacking.
- Dribble authority checks tightened (distance and target ball-speed gating) to reduce mid-flight ball velocity snaps.
- Increased authoritative state broadcast cadence from 20Hz to ~40Hz for lower correction latency.
- Added zero-distance collision guards to avoid NaN cascades that can cause hard snaps.

### Phase 1 - Replace stale queue replay with latest-state input

- Replace long input queue consumption with latest input state per player.
- Keep sequence ack for reconciliation.
- Rate-limit client input sends to input changes immediately.
- Send heartbeat every 50-100ms while held.

Exit criteria:

- sequence ack remains monotonic
- no queue-growth induced delayed intent

### Phase 2 - Reconciliation hardening

- Make reconciliation strictly tick-anchored.
- Add correction budget per second to avoid visual oscillation.
- Introduce correction telemetry for average position error.
- Introduce correction telemetry for correction count.
- Introduce correction telemetry for hard snap count.

Exit criteria:

- low snap frequency during normal play (no teleports/resets)
- smooth path under 50ms RTT test

### Phase 3 - Dynamic interaction consistency

- Send explicit impulse metadata for strong server-only events (knockback/collision heavy events) when needed.
- Keep ball and player corrections independent but time-consistent.
- Ensure reset/goal/team teleport events are explicit and authoritative.

Exit criteria:

- contested-ball scenarios avoid repeated back/forth rubberbanding

### Phase 4 - Rollout and validation

- Add synthetic lag/jitter test passes (for example 50ms, 100ms, 2-5% jitter/loss).
- Roll out behind a feature flag.
- Compare correction and snap telemetry before/after.

Exit criteria:

- median correction error reduced
- user-visible sliding/rubberbanding materially reduced

## Suggested Immediate Priority Order

1. Fix simulation loop singleton/lifecycle.
2. Move to latest-state input handling.
3. Tighten reconciliation policy with telemetry.
4. Iterate on contested-collision handling.

## Validation Checklist

- With 50ms RTT: local player path remains smooth during continuous movement.
- With nearby players and ball contact: no repeated oscillating correction every snapshot.
- Scene join/leave does not spawn extra simulation loops.
- Score/reset/team assignment events still hard-authoritative and deterministic.

## Additional Audit Findings (Post-Phase 0)

### A) Queue model still replays stale intent under bursty delivery

Even with out-of-order stale packet drops, the server still applies queued historical inputs one-by-one. Under jitter spikes this can increase correction churn before converging.

References:

- `src/services/soccer.service.ts:843`
- `src/services/soccer.service.ts:2303`

### B) Kick lag compensation relies on client wall-clock timestamp

Kick rewind currently uses client-provided `timestamp` matched against server `Date.now()` history, which is sensitive to client clock skew.

References:

- `src/services/soccer.service.ts:341`
- `src/services/soccer.service.ts:650`

### C) Simulation driver remains busy-loop style

The `setImmediate` loop is now safe (single instance + stoppable), but it still runs as a near-continuous scheduler while SoccerMap is active. This can be CPU-heavy at scale and should be profiled.

References:

- `src/services/soccer.service.ts:495`
