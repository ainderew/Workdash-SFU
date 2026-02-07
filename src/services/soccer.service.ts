import {
  integrateBall,
  integratePlayer,
  calculateKickVelocity,
  calculateSpeedMultiplier,
  calculateDragMultiplier,
  PHYSICS_CONSTANTS,
} from "./shared-physics.js";
import { Socket, Server } from "socket.io";
import { GameEventEnums } from "./_enums.js";
import type {
  BallState,
  BallKickData,
  BallDribbleData,
  PlayerState,
  SkillActivationData,
  SoccerStats,
} from "./_types.js";
import type { Character } from "@prisma/client";
import { getPlayerPositions } from "./game.service.js";
import {
  getSkillConfig,
  getAllSkills,
  isSpeedEffect,
} from "../config/soccer-skills.config.js";
import { MmrSystem, MatchResult } from "./mmr.service.js";
import { SoccerStatsRepository } from "../repositories/soccer-stats/soccer-stats.repository.js";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

interface CollisionRect {
  x: number;
  y: number;
  width: number;
  height: number;
}
interface PlayerPhysicsState {
  id: string;
  x: number;
  y: number;
  vx: number;
  vy: number;
  radius: number; // Collision radius
  team?: "red" | "blue" | "spectator" | null;
  soccerStats?: { speed: number; kickPower: number; dribbling: number } | null;
}
interface GoalZone {
  name: string;
  team: "red" | "blue";
  x: number;
  y: number;
  width: number;
  height: number;
}

enum GameStatus {
  LOBBY = "LOBBY",
  SKILL_SELECTION = "SKILL_SELECTION",
  ACTIVE = "ACTIVE",
}

interface PlayerMatchStats {
  goals: number;
  assists: number;
  interceptions: number;
}

interface PlayerHistoryState {
  x: number;
  y: number;
  timestamp: number;
}

interface BallHistoryState {
  x: number;
  y: number;
  timestamp: number;
}

interface PlayerInputState {
  up: boolean;
  down: boolean;
  left: boolean;
  right: boolean;
  sequence: number;
}

export class SoccerService {
  private socket: Socket;
  private io: Server;
  private static statsRepository = new SoccerStatsRepository();

  private static gameStatus: GameStatus = GameStatus.LOBBY;
  private static selectionOrder: string[] = [];
  private static currentPickerIndex: number = -1;
  private static playerAssignedSkills: Map<string, string> = new Map();
  private static availableSkillIds: string[] = [];
  private static midGamePickers: Set<string> = new Set();
  private static selectionTimer: NodeJS.Timeout | null = null;
  private static selectionTurnEndTime: number = 0;

  private static playerMatchStats: Map<string, PlayerMatchStats> = new Map();

  /**
   * Singleton on purpose do not change please
   */
  private static ballState = {
    x: 1760,
    y: 800,
    vx: 0,
    vy: 0,
    sequence: 0,
    lastTouchId: null as string | null,
    previousTouchId: null as string | null,
    lastTouchTimestamp: 0,
    isMoving: false,
  };

  private static currentTick = 0;
  private static lastTime = process.hrtime();
  private static accumulator = 0;
  private static networkAccumulator = 0;

  private static updateInterval: NodeJS.Timeout | null = null;

  private static readonly BASE_KICK_POWER = 1000;
  private static readonly KICK_COOLDOWN_MS = 300;
  private static readonly KICK_KNOCKBACK = 400;

  // exponential drag v(t) = v0 * e^(-DRAG * t)
  private static readonly DRAG = PHYSICS_CONSTANTS.BALL_DRAG;
  private static readonly PLAYER_DRAG = PHYSICS_CONSTANTS.PLAYER_DRAG;
  private static readonly BASE_ACCEL = PHYSICS_CONSTANTS.PLAYER_ACCEL;
  private static readonly BASE_MAX_SPEED = PHYSICS_CONSTANTS.PLAYER_MAX_SPEED;
  private static readonly BOUNCE = PHYSICS_CONSTANTS.BALL_BOUNCE;
  private static readonly BALL_RADIUS = PHYSICS_CONSTANTS.BALL_RADIUS;
  /**
   * Physics runs at 60Hz (16.6ms)
   * Network broadcasts are throttled to 20Hz
   */
  private static readonly UPDATE_INTERVAL_MS = PHYSICS_CONSTANTS.FIXED_TIMESTEP_MS;
  private static readonly VELOCITY_THRESHOLD = PHYSICS_CONSTANTS.VELOCITY_STOP_THRESHOLD;
  private static readonly WORLD_BOUNDS = { 
    width: PHYSICS_CONSTANTS.WORLD_WIDTH, 
    height: PHYSICS_CONSTANTS.WORLD_HEIGHT 
  };
  private static readonly MAX_DRIBBLE_DISTANCE = 300;

  private static readonly SPECTATOR_SPAWN = { x: 250, y: 100 };
  private static readonly PLAYER_RADIUS = PHYSICS_CONSTANTS.PLAYER_RADIUS;
  private static readonly PUSH_DAMPING = 1.5;
  private static readonly BALL_KNOCKBACK = 0.6;

  private static readonly NETWORK_TICK_MS = PHYSICS_CONSTANTS.NETWORK_TICK_MS;
  private static readonly PHYSICS_TICK_MS = PHYSICS_CONSTANTS.FIXED_TIMESTEP_MS;
  private static activeConnections = 0;
  private static lastKickTime = 0;
  private static tickCount = 0; // Throttling counter

  private static collisionRects: CollisionRect[] = [];
  private static mapLoaded = false;

  private static playerPhysics: Map<string, PlayerPhysicsState> = new Map();
  private static playerInputs: Map<string, PlayerInputState> = new Map();
  private static playerInputQueues: Map<string, PlayerInputState[]> = new Map();
  private static playerHistory: Map<string, PlayerHistoryState[]> = new Map();
  private static ballHistory: BallHistoryState[] = [];
  private static lastProcessedSequence: Map<string, number> = new Map();
  private static ioInstance: Server | null = null;

  private static goalZones: GoalZone[] = [];
  private static goalsLoaded = false;
  private static score = { red: 0, blue: 0 };
  private static hasScoredGoal = false;

  private static readonly DEFAULT_GAME_TIME = 5 * 60;
  private static readonly OVERTIME_DURATION = 1 * 60;
  private static gameTimeRemaining = SoccerService.DEFAULT_GAME_TIME;
  private static isGameActive = false;
  private static lastTimerUpdate = Date.now();

  // Skill system
  private static playerSkillCooldowns: Map<string, Map<string, number>> =
    new Map();
  private static slowedPlayers: Set<string> = new Set();
  private static metavisionPlayers: Set<string> = new Set();
  private static ninjaStepPlayers: Set<string> = new Set();
  private static lurkingPlayers: Map<string, number> = new Map();
  private static powerShotActivation: {
    playerId: string;
    knockbackForce: number;
    ballRetention: number;
    expiresAt: number;
  } | null = null;

  private static playerBuffs: Map<
    string,
    {
      kickPower?: { value: number; expiresAt: number };
      speed?: { value: number; expiresAt: number };
    }
  > = new Map();

  private static readonly RED_TEAM_SPAWNS = [
    { x: 1413, y: 515 },
    { x: 1413, y: 777 },
    { x: 1413, y: 985 },
    { x: 941.3, y: 515 },
    { x: 941.3, y: 777 },
    { x: 941.3, y: 985 },
  ];

  private static readonly BLUE_TEAM_SPAWNS = [
    { x: 2102.73, y: 515 },
    { x: 2102.73, y: 777 },
    { x: 2102.73, y: 985 },
    { x: 2532, y: 515 },
    { x: 2532, y: 777.78 },
    { x: 2532, y: 985.32 },
  ];

  constructor(socket: Socket, io: Server) {
    this.socket = socket;
    this.io = io;
    SoccerService.activeConnections++;

    if (!SoccerService.ioInstance) {
      SoccerService.ioInstance = io;
    }

    if (!SoccerService.mapLoaded) {
      SoccerService.loadMapCollisions();
    }

    if (!SoccerService.goalsLoaded) {
      SoccerService.loadGoalZones();
    }

    if (!SoccerService.updateInterval) {
      SoccerService.startPhysicsLoop(io);
    }
  }

  listenForSoccerEvents() {
    this.socket.on(GameEventEnums.BALL_KICK, (data: BallKickData) => {
      this.handleBallKick(data);
    });

    this.socket.on(GameEventEnums.BALL_DRIBBLE, (data: BallDribbleData) => {
      this.handleBallDribble(data);
    });

    this.socket.on(
      "soccer:assignTeam",
      (data: { playerId: string; team: "red" | "blue" | "spectator" }) => {
        this.handleTeamAssignment(data);
      },
    );

    this.socket.on("soccer:resetGame", () => {
      this.handleResetGame();
    });

    this.socket.on("soccer:startGame", () => {
      this.handleStartGame();
    });

    this.socket.on("soccer:randomizeTeams", () => {
      this.handleRandomizeTeams();
    });

    this.socket.on("soccer:pickSkill", (data: { skillId: string }) => {
      this.handlePickSkill(data);
    });

    this.socket.on("soccer:requestGameState", (callback) => {
      callback({
        gameStatus: SoccerService.gameStatus,
        isGameActive: SoccerService.isGameActive,
        playerPicks: Object.fromEntries(SoccerService.playerAssignedSkills),
      });
    });

    this.socket.on("soccer:activateSkill", (data: SkillActivationData) => {
      this.handleActivateSkill(data);
    });

    this.socket.on("soccer:requestSkillConfig", (callback) => {
      const skills = getAllSkills().map((skill) => ({
        id: skill.id,
        name: skill.name,
        description: skill.description,
        keyBinding: skill.keyBinding,
        cooldownMs: skill.cooldownMs,
        durationMs: skill.durationMs,
        serverEffect: skill.serverEffect,
        clientVisuals: skill.clientVisuals,
      }));
      callback(skills);
    });

    this.socket.on("soccer:getPlayers", (callback) => {
      this.handleGetPlayers(callback);
    });

    this.socket.on("disconnect", () => {
      this.cleanup();
    });
  }

  private handleBallKick(data: BallKickData) {
    const now = Date.now();

    // === Cooldown Check ===
    if (now - SoccerService.lastKickTime < SoccerService.KICK_COOLDOWN_MS) {
      return;
    }

    // === Player Validation ===
    const kickerPhysics = SoccerService.playerPhysics.get(data.playerId);
    const playerPositions = getPlayerPositions();
    const playerState = playerPositions.get(data.playerId);

    if (!kickerPhysics || !playerState) return;

    // Only active players can kick
    if (playerState.team !== "red" && playerState.team !== "blue") {
      return;
    }

    // === Lag Compensation: Rewind to client's timestamp ===
    let kickerX = kickerPhysics.x;
    let kickerY = kickerPhysics.y;
    let ballX = SoccerService.ballState.x;
    let ballY = SoccerService.ballState.y;

    if (data.timestamp) {
      // Rewind player position
      const playerHist = SoccerService.playerHistory.get(data.playerId);
      if (playerHist && playerHist.length > 0) {
        const rewound = SoccerService.findClosestHistoryState(
          playerHist,
          data.timestamp,
        );
        if (rewound) {
          kickerX = rewound.x;
          kickerY = rewound.y;
        }
      }

      // Rewind ball position
      if (SoccerService.ballHistory.length > 0) {
        const rewound = SoccerService.findClosestHistoryState(
          SoccerService.ballHistory,
          data.timestamp,
        );
        if (rewound) {
          ballX = rewound.x;
          ballY = rewound.y;
        }
      }
    }

    // === Distance Validation ===
    const dx = ballX - kickerX;
    const dy = ballY - kickerY;
    const distance = Math.sqrt(dx * dx + dy * dy);

    // Allow some tolerance for network jitter
    const isMetaVisionActive = SoccerService.metavisionPlayers.has(
      data.playerId,
    );
    const maxKickDistance = isMetaVisionActive ? 300 : 250; // Generous to account for lag
    if (distance > maxKickDistance) {
      console.log(
        `[Soccer] Kick rejected: distance ${distance.toFixed(0)} > ${maxKickDistance}`,
      );
      return;
    }

    // === Apply Kick ===
    SoccerService.lastKickTime = now;

    // Calculate kick velocity using shared function (ensures client/server match)
    let kickPowerStat = kickerPhysics.soccerStats?.kickPower ?? 0;
    const buffs = SoccerService.playerBuffs.get(data.playerId);
    if (buffs?.kickPower && Date.now() < buffs.kickPower.expiresAt) {
      kickPowerStat += buffs.kickPower.value;
    }

    const kickVelocity = calculateKickVelocity(
      data.angle,
      data.kickPower || SoccerService.BASE_KICK_POWER,
      kickPowerStat,
      isMetaVisionActive,
    );

    const ball = SoccerService.ballState;

    // CRITICAL: Increment sequence BEFORE changing velocity
    // This allows clients to detect "a new kick happened"
    ball.sequence++;

    // Apply velocity
    ball.vx = kickVelocity.vx;
    ball.vy = kickVelocity.vy;
    ball.isMoving = true;

    // Update touch tracking
    if (ball.lastTouchId !== data.playerId) {
      ball.previousTouchId = ball.lastTouchId;
      ball.lastTouchId = data.playerId;
    }
    ball.lastTouchTimestamp = now;

    // Apply knockback to kicker
    const knockbackVx = -Math.cos(data.angle) * SoccerService.KICK_KNOCKBACK;
    const knockbackVy = -Math.sin(data.angle) * SoccerService.KICK_KNOCKBACK;
    kickerPhysics.vx += knockbackVx;
    kickerPhysics.vy += knockbackVy;

    console.log(
      `[Soccer] Kick by ${data.playerId}: seq=${ball.sequence}, vel=(${ball.vx.toFixed(0)}, ${ball.vy.toFixed(0)})`,
    );

    // Broadcast kick event for sound/visual effects on other clients
    this.io.to("scene:SoccerMap").emit(GameEventEnums.BALL_KICKED, {
      kickerId: data.playerId,
      localKickId:
        typeof data.localKickId === "number" ? data.localKickId : undefined,
      sequence: ball.sequence, // Include sequence so clients know which kick this is
      ballX: ball.x,
      ballY: ball.y,
      vx: ball.vx,
      vy: ball.vy,
    });

    // Immediately broadcast authoritative state
    this.broadcastBallState();
  }

  private handleBallDribble(data: BallDribbleData) {
    // Prevent dribble from overriding recent kicks (100ms cooldown)
    const now = Date.now();
    const timeSinceLastKick = now - SoccerService.lastKickTime;
    if (timeSinceLastKick < 100) {
      return;
    }

    const playerPositions = getPlayerPositions();
    const playerState = playerPositions.get(data.playerId);
    if (
      !playerState ||
      (playerState.team !== "red" && playerState.team !== "blue")
    ) {
      return;
    }

    // 1. GET SERVER AUTHORITATIVE POSITION (Fixes the inconsistency)
    const playerPhysics = SoccerService.playerPhysics.get(data.playerId);
    if (!playerPhysics) return;

    const ballState = SoccerService.ballState;

    // 2. USE SERVER COORDINATES, NOT CLIENT DATA
    const dx = ballState.x - playerPhysics.x;
    const dy = ballState.y - playerPhysics.y;
    const distance = Math.sqrt(dx * dx + dy * dy);

    // 3. STRICT CHECK
    if (distance > SoccerService.MAX_DRIBBLE_DISTANCE) {
        // Optional: Send a "correction" packet to client here to snap them back
        return;
    }

    const dribblePower = 300;
    const angle = Math.atan2(dy, dx);

    ballState.vx = Math.cos(angle) * dribblePower;
    ballState.vy = Math.sin(angle) * dribblePower;
    if (ballState.lastTouchId !== data.playerId) {
      ballState.previousTouchId = ballState.lastTouchId;
      ballState.lastTouchId = data.playerId;
    }
    ballState.lastTouchTimestamp = Date.now();
    ballState.isMoving = true;

    console.log(`Ball dribbled by ${data.playerId}`);
    this.broadcastBallState();
  }



  private static startPhysicsLoop(io: Server) {
    this.lastTime = process.hrtime();
    this.accumulator = 0;
    this.networkAccumulator = 0;

    // Run physics loop
    // Using setImmediate for more consistent timing than setInterval(0)
    const loop = () => {
      this.serverTick(io);
      setImmediate(loop);
    };

    setImmediate(loop);
  }

  private static serverTick(io: Server) {
    // Calculate delta time using high-resolution timer
    const diff = process.hrtime(this.lastTime);
    const dtMs = diff[0] * 1000 + diff[1] / 1e6;
    this.lastTime = process.hrtime();

    // Accumulate time
    this.accumulator += dtMs;
    this.networkAccumulator += dtMs;

    // Safety cap (prevents spiral of death if server lags)
    const maxAccumulator = PHYSICS_CONSTANTS.FIXED_TIMESTEP_MS * 10;
    if (this.accumulator > maxAccumulator) {
      console.warn(
        `[Soccer] Physics accumulator capped: ${this.accumulator.toFixed(1)}ms`,
      );
      this.accumulator = maxAccumulator;
    }

    // === Fixed Timestep Physics (Target: 62.5 Hz) ===
    while (this.accumulator >= PHYSICS_CONSTANTS.FIXED_TIMESTEP_MS) {
      this.currentTick++;

      // Update ball and player physics
      this.updateBallPhysics(io, PHYSICS_CONSTANTS.FIXED_TIMESTEP_SEC);
      this.updateGameTimer(io, PHYSICS_CONSTANTS.FIXED_TIMESTEP_SEC);

      // Record history for lag compensation
      this.recordHistory();

      this.accumulator -= PHYSICS_CONSTANTS.FIXED_TIMESTEP_MS;
    }

    // === Network Broadcast (Target: 20 Hz) ===
    if (this.networkAccumulator >= this.NETWORK_TICK_MS) {
      this.broadcastBallState(io);
      this.broadcastPlayerStates(io);
      this.networkAccumulator -= this.NETWORK_TICK_MS;
    }
  }

  private static recordHistory() {
    const now = Date.now();

    // Record ball history
    this.ballHistory.push({
      x: this.ballState.x,
      y: this.ballState.y,
      timestamp: now,
    });

    // Keep ~1 second of history (60 ticks at 60Hz)
    while (this.ballHistory.length > 60) {
      this.ballHistory.shift();
    }

    // Record player history
    for (const [id, player] of this.playerPhysics) {
      let history = this.playerHistory.get(id);
      if (!history) {
        history = [];
        this.playerHistory.set(id, history);
      }

      history.push({
        x: player.x,
        y: player.y,
        timestamp: now,
      });

      while (history.length > 60) {
        history.shift();
      }
    }
  }

  private static findClosestHistoryState(
    history: Array<{ x: number; y: number; timestamp: number }>,
    targetTimestamp: number,
  ): { x: number; y: number } | null {
    if (history.length === 0) return null;

    let closest = history[0];
    if (!closest) return null;
    let closestDiff = Math.abs(targetTimestamp - closest.timestamp);

    for (const entry of history) {
      const diff = Math.abs(targetTimestamp - entry.timestamp);
      if (diff < closestDiff) {
        closestDiff = diff;
        closest = entry;
      }
    }

    // Only use if within reasonable time window (500ms)
    if (closestDiff > 500) {
      return null;
    }

    return closest;
  }

  private static updateBallPhysics(io: Server, dt: number) {
    const ball = this.ballState;
    if (ball.isMoving) {
      // USE SHARED KERNEL
      integrateBall(ball, dt);

      const playersInScene = Array.from(this.playerPhysics.values());
      for (const player of playersInScene) {
        const dx = ball.x - player.x;
        const dy = ball.y - player.y;
        const distance = Math.sqrt(dx * dx + dy * dy);
        const playerRadius = this.PLAYER_RADIUS;
        const ballRadius = this.BALL_RADIUS;
        const minDistance = ballRadius + playerRadius;

        if (distance < minDistance && ball.isMoving) {
          const playerState = getPlayerPositions().get(player.id);
          if (playerState) {
            this.handleBallPlayerCollision(
              io,
              player.id,
              playerState,
              dx,
              dy,
              distance,
              playerRadius,
            );
          }
          break;
        }
      }
      for (const rect of this.collisionRects) {
        const collision = this.checkBallRectCollision(ball, rect);

        if (collision) {
          const normal = collision.normal;
          const dotProduct = ball.vx * normal.x + ball.vy * normal.y;

          ball.vx = ball.vx - 2 * dotProduct * normal.x;
          ball.vy = ball.vy - 2 * dotProduct * normal.y;
          ball.vx *= this.BOUNCE;
          ball.vy *= this.BOUNCE;

          const penetration =
            this.BALL_RADIUS -
            Math.sqrt(
              Math.pow(
                ball.x -
                  Math.max(rect.x, Math.min(ball.x, rect.x + rect.width)),
                2,
              ) +
                Math.pow(
                  ball.y -
                    Math.max(rect.y, Math.min(ball.y, rect.y + rect.height)),
                  2,
                ),
            );
          ball.x += normal.x * (penetration + 1);
          ball.y += normal.y * (penetration + 1);

          console.log(
            `Ball bounced off wall at (${ball.x.toFixed(0)}, ${ball.y.toFixed(0)})`,
          );
          break; // Only one wall collision per frame
        }
      }

      // Check goal collisions before boundary collision
      for (const goal of this.goalZones) {
        if (this.checkBallGoalCollision(ball, goal) && !this.hasScoredGoal) {
          const scoringTeam = goal.team === "red" ? "blue" : "red";
          this.score[scoringTeam]++;

          // Record Goal
          if (ball.lastTouchId) {
            const stats = this.playerMatchStats.get(ball.lastTouchId) || {
              goals: 0,
              assists: 0,
              interceptions: 0,
            };
            stats.goals++;
            this.playerMatchStats.set(ball.lastTouchId, stats);
            console.log(
              `Goal recorded for ${ball.lastTouchId}! Total: ${stats.goals}`,
            );

            // Record Assist
            if (ball.previousTouchId) {
              const scorerState = getPlayerPositions().get(ball.lastTouchId);
              const assisterState = getPlayerPositions().get(
                ball.previousTouchId,
              );
              if (
                scorerState &&
                assisterState &&
                scorerState.team === assisterState.team
              ) {
                const assistStats = this.playerMatchStats.get(
                  ball.previousTouchId,
                ) || { goals: 0, assists: 0, interceptions: 0 };
                assistStats.assists++;
                this.playerMatchStats.set(ball.previousTouchId, assistStats);
                console.log(
                  `Assist recorded for ${ball.previousTouchId}! Total: ${assistStats.assists}`,
                );
              }
            }
          }

          console.log(
            `GOAL! ${scoringTeam.toUpperCase()} team scored! Score: Red ${this.score.red} - Blue ${this.score.blue}`,
          );

          io.to("scene:SoccerMap").emit("goal:scored", {
            scoringTeam,
            goalName: goal.name,
            lastTouchId: ball.lastTouchId,
            score: {
              red: this.score.red,
              blue: this.score.blue,
            },
          });

          this.resetBall();
          this.resetAllPlayerPositions();

          // Force broadcast update immediately on goal
          this.broadcastBallState(io);

          return;
        }
      }

      // Stop check
      const speed = Math.sqrt(ball.vx * ball.vx + ball.vy * ball.vy);
      if (speed < this.VELOCITY_THRESHOLD) {
        ball.vx = 0;
        ball.vy = 0;
        ball.isMoving = false;
        console.log("Ball stopped moving");
      }
    }

    this.updatePlayerPhysics(io, dt);
  }

  private static broadcastBallState(io: Server) {
    io.to("scene:SoccerMap").emit(GameEventEnums.BALL_STATE, {
      x: this.ballState.x,
      y: this.ballState.y,
      vx: this.ballState.vx,
      vy: this.ballState.vy,
      lastTouchId: this.ballState.lastTouchId,
      timestamp: Date.now(),
      sequence: this.ballState.sequence || 0,
      tick: this.currentTick,
    });
  }

  private static updatePlayerPhysics(io: Server, deltaTime: number) {
    const players = Array.from(this.playerPhysics.values());

    /**
     * 1. Velocity Update & Integration (Acceleration, Drag, Move)
     */
    for (const player of players) {
      const queue = this.playerInputQueues.get(player.id);
      if (queue && queue.length > 0) {
        const nextInput = queue.shift();
        if (nextInput) {
          this.playerInputs.set(player.id, nextInput);
        }
      }

      const input = this.playerInputs.get(player.id);
      if (!input) continue;

      // Skip spectators
      if (player.team !== "red" && player.team !== "blue") continue;

      // Calculate stat multipliers
      const speedStat = player.soccerStats?.speed ?? 0;
      const dribblingStat = player.soccerStats?.dribbling ?? 0;
      let speedMultiplier = calculateSpeedMultiplier(speedStat);
      const dragMultiplier = calculateDragMultiplier(dribblingStat);

      // Apply slow effect if active
      if (SoccerService.isPlayerSlowed(player.id)) {
        speedMultiplier *= SoccerService.getSlowMultiplier();
      }

      // Run deterministic physics (MUST match client exactly)
      integratePlayer(
        player,
        input,
        deltaTime,
        dragMultiplier,
        speedMultiplier,
      );

      // Track the last input actually applied for reconciliation
      this.lastProcessedSequence.set(player.id, input.sequence || 0);
    }

    /**
     * 2. Resolve Collisions (Updates velocity and position)
     */
    for (let i = 0; i < players.length; i++) {
      for (let j = i + 1; j < players.length; j++) {
        const p1 = players[i];
        const p2 = players[j];

        if (!p1 || !p2) continue;

        // Ninja Step: Skip collision if either player is ghosted has skill and not touching ball
        const p1Ghosted =
          SoccerService.ninjaStepPlayers.has(p1.id) &&
          !SoccerService.isTouchingBall(p1);
        const p2Ghosted =
          SoccerService.ninjaStepPlayers.has(p2.id) &&
          !SoccerService.isTouchingBall(p2);

        // Spectator: Skip collision if either player is a spectator
        const p1Spectator = p1.team !== "red" && p1.team !== "blue";
        const p2Spectator = p2.team !== "red" && p2.team !== "blue";

        if (p1Ghosted || p2Ghosted || p1Spectator || p2Spectator) {
          continue;
        }

        const dx = p2.x - p1.x;
        const dy = p2.y - p1.y;
        const distance = Math.sqrt(dx * dx + dy * dy);
        const minDistance = p1.radius + p2.radius;

        if (distance < minDistance) {
          this.handlePlayerCollision(p1, p2, dx, dy, distance);
        }
      }
    }

    /**
     * Ball to player collision knockback
     */
    for (const player of players) {
      const dx = this.ballState.x - player.x;
      const dy = this.ballState.y - player.y;
      const distance = Math.sqrt(dx * dx + dy * dy);
      const minDistance = this.BALL_RADIUS + player.radius;

      if (distance < minDistance && this.ballState.isMoving) {
        this.handleBallPlayerKnockback(player, dx, dy, distance);
      }
    }

    /**
     * 3. Map Boundary Clamping & Spectator Wall Collision
     */
    for (const player of players) {
      // Note: Movement is already done in Step 1 via integratePlayer

      // Map Boundary Clamping (Keep all players within world bounds)
      player.x = Math.max(
        player.radius,
        Math.min(this.WORLD_BOUNDS.width - player.radius, player.x),
      );
      player.y = Math.max(
        player.radius,
        Math.min(this.WORLD_BOUNDS.height - player.radius, player.y),
      );

      const isSpectator = player.team !== "red" && player.team !== "blue";
      if (isSpectator) {
        for (const rect of this.collisionRects) {
          const closestX = Math.max(
            rect.x,
            Math.min(player.x, rect.x + rect.width),
          );
          const closestY = Math.max(
            rect.y,
            Math.min(player.y, rect.y + rect.height),
          );

          const dx = player.x - closestX;
          const dy = player.y - closestY;
          const distance = Math.sqrt(dx * dx + dy * dy);

          if (distance < player.radius) {
            const overlap = player.radius - distance;
            if (distance > 0) {
              player.x += (dx / distance) * overlap;
              player.y += (dy / distance) * overlap;
            } else {
              const dL = player.x - rect.x;
              const dR = rect.x + rect.width - player.x;
              const dT = player.y - rect.y;
              const dB = rect.y + rect.height - player.y;
              const min = Math.min(dL, dR, dT, dB);
              if (min === dL) player.x = rect.x - player.radius;
              else if (min === dR)
                player.x = rect.x + rect.width + player.radius;
              else if (min === dT) player.y = rect.y - player.radius;
              else player.y = rect.y + rect.height + player.radius;
            }
            player.vx = 0;
            player.vy = 0;
          }
        }
      }
    }
  }

  private static handlePlayerCollision(
    p1: PlayerPhysicsState,
    p2: PlayerPhysicsState,
    dx: number,
    dy: number,
    distance: number,
  ) {
    const nx = dx / distance;
    const ny = dy / distance;

    // Separate players push Apart
    const overlap = p1.radius + p2.radius - distance;
    const separationX = nx * (overlap / 2);
    const separationY = ny * (overlap / 2);

    p1.x -= separationX;
    p1.y -= separationY;
    p2.x += separationX;
    p2.y += separationY;

    const pushForce = this.PUSH_DAMPING * 100;
    p1.vx -= nx * pushForce;
    p1.vy -= ny * pushForce;
    p2.vx += nx * pushForce;
    p2.vy += ny * pushForce;
  }

  private static handleBallPlayerKnockback(
    player: PlayerPhysicsState,
    dx: number,
    dy: number,
    distance: number,
  ) {
    const ballSpeed = Math.sqrt(
      this.ballState.vx * this.ballState.vx +
        this.ballState.vy * this.ballState.vy,
    );

    if (ballSpeed < 100) return;
    const nx = -dx / distance;
    const ny = -dy / distance;

    const isPowerShot =
      this.powerShotActivation &&
      Date.now() < this.powerShotActivation.expiresAt;

    // Apply enhanced knockback for power shot
    const knockbackMagnitude = isPowerShot
      ? this.powerShotActivation!.knockbackForce
      : Math.min(ballSpeed * this.BALL_KNOCKBACK, 200);

    player.vx += nx * knockbackMagnitude;
    player.vy += ny * knockbackMagnitude;

    console.log(
      `Player ${player.id} knocked back by ball: ${knockbackMagnitude.toFixed(0)} px/s${isPowerShot ? " (POWER SHOT)" : ""}`,
    );
  }

  private static isTouchingBall(p: PlayerPhysicsState) {
    const dx = this.ballState.x - p.x;
    const dy = this.ballState.y - p.y;
    const dist = Math.sqrt(dx * dx + dy * dy);
    return dist < this.BALL_RADIUS + p.radius + 20; // 20px buffer
  }

  private static broadcastPlayerStates(io: Server) {
    const updates: Array<{
      id: string;
      x: number;
      y: number;
      vx: number;
      vy: number;
      isGhosted: boolean;
      isSpectator: boolean;
      lastSequence: number;
    }> = [];

    for (const [id, player] of this.playerPhysics.entries()) {
      updates.push({
        id,
        x: player.x,
        y: player.y,
        vx: player.vx,
        vy: player.vy,
        isGhosted:
          SoccerService.ninjaStepPlayers.has(id) &&
          !SoccerService.isTouchingBall(player),
        isSpectator: player.team !== "red" && player.team !== "blue",
        lastSequence: this.lastProcessedSequence.get(id) || 0,
      });
    }

    if (updates.length > 0) {
      io.to("scene:SoccerMap").emit("players:physicsUpdate", {
        players: updates,
        timestamp: Date.now(),
        tick: this.currentTick,
      });
    }
  }

  private static handleBallPlayerCollision(
    io: Server,
    playerId: string,
    player: PlayerState,
    dx: number,
    dy: number,
    distance: number,
    playerRadius: number,
  ) {
    const ball = this.ballState;

    const nx = dx / distance;
    const ny = dy / distance;

    // Calculate reflection (v' = v - 2(v · n)n)
    const dotProduct = ball.vx * nx + ball.vy * ny;
    ball.vx = ball.vx - 2 * dotProduct * nx;
    ball.vy = ball.vy - 2 * dotProduct * ny;

    const isPowerShot =
      SoccerService.powerShotActivation &&
      Date.now() < SoccerService.powerShotActivation.expiresAt;

    const bounceDamping = isPowerShot
      ? SoccerService.powerShotActivation!.ballRetention
      : 0.6;

    ball.vx *= bounceDamping;
    ball.vy *= bounceDamping;

    if (isPowerShot) {
      console.log(
        `Ball bounced off player with power shot retention (${bounceDamping * 100}%)`,
      );
    }

    const ballRadius = this.BALL_RADIUS;
    const overlap = ballRadius + playerRadius - distance;
    ball.x += nx * (overlap + 1);
    ball.y += ny * (overlap + 1);

    if (ball.lastTouchId !== playerId) {
      // Interception logic
      const previousKickerState = ball.lastTouchId
        ? getPlayerPositions().get(ball.lastTouchId)
        : null;
      if (previousKickerState && previousKickerState.team !== player.team) {
        const stats = this.playerMatchStats.get(playerId) || {
          goals: 0,
          assists: 0,
          interceptions: 0,
        };
        stats.interceptions++;
        this.playerMatchStats.set(playerId, stats);
        console.log(
          `Interception recorded for ${playerId}! Total: ${stats.interceptions}`,
        );
      }

      ball.previousTouchId = ball.lastTouchId;
      ball.lastTouchId = playerId;
    }
    ball.lastTouchTimestamp = Date.now();

    const speed = Math.sqrt(ball.vx * ball.vx + ball.vy * ball.vy);
    console.log(
      `Ball intercepted by ${playerId}, bounced at ${speed.toFixed(0)}px/s`,
    );

    io.to("scene:SoccerMap").emit("ball:intercepted", {
      playerId,
      ballX: ball.x,
      ballY: ball.y,
    });
  }

  private broadcastBallState() {
    SoccerService.broadcastBallState(this.io);
  }

  private static updateGameTimer(io: Server, deltaTime: number) {
    if (!this.isGameActive) return;

    this.gameTimeRemaining -= deltaTime;

    if (
      Math.floor(this.gameTimeRemaining) !==
      Math.floor(this.gameTimeRemaining + deltaTime)
    ) {
      io.to("scene:SoccerMap").emit("soccer:timerUpdate", {
        timeRemaining: Math.max(0, Math.floor(this.gameTimeRemaining)),
      });
    }

    if (this.gameTimeRemaining <= 0) {
      this.handleGameEnd(io);
    }
  }

  private static handleGameEnd(io: Server) {
    this.isGameActive = false;

    let winner: "red" | "blue" | "tie";
    if (this.score.red > this.score.blue) {
      winner = "red";
    } else if (this.score.blue > this.score.red) {
      winner = "blue";
    } else {
      winner = "tie";
    }

    if (winner === "tie") {
      console.log("Game tied! Adding 1 minute overtime...");
      this.gameTimeRemaining = this.OVERTIME_DURATION;
      this.isGameActive = true;
      this.lastTimerUpdate = Date.now();

      io.to("scene:SoccerMap").emit("soccer:overtime", {
        message: "Overtime! 1 minute added",
        duration: this.OVERTIME_DURATION,
      });
    } else {
      // Calculate MVP
      let mvp: {
        id: string;
        name: string;
        stats: PlayerMatchStats;
        character: Character;
      } | null = null;
      let highestScore = -1;

      for (const [playerId, stats] of this.playerMatchStats.entries()) {
        const score =
          stats.goals * 10 + stats.assists * 5 + stats.interceptions * 2;
        if (score > highestScore) {
          highestScore = score;
          const playerState = getPlayerPositions().get(playerId);
          if (playerState) {
            mvp = {
              id: playerId,
              name: playerState.name,
              stats,
              character: playerState.character,
            };
          }
        }
      }

      // --- MMR Calculation System ---
      const mmrUpdates: Array<{
        playerId: string;
        name: string;
        delta: number;
        newMmr: number;
        rank: string;
        streak: number;
        stats: PlayerMatchStats;
        isMVP: boolean;
        featCount: number;
      }> = [];
      const playerPositions = getPlayerPositions();

      // Process MMR for everyone in the scene who was on a team
      const processMmr = async () => {
        for (const [playerId, player] of playerPositions.entries()) {
          if (
            player.currentScene !== "SoccerMap" ||
            (player.team !== "red" && player.team !== "blue")
          ) {
            continue;
          }

          const matchResult =
            player.team === winner ? MatchResult.WIN : MatchResult.LOSS;
          const isMVP = mvp?.id === playerId;
          const stats = this.playerMatchStats.get(playerId) || {
            goals: 0,
            assists: 0,
            interceptions: 0,
          };

          // Calculate feats
          let featCount = 0;
          if (stats.goals >= 2) featCount++; // Sniper
          if (stats.assists >= 2) featCount++; // Playmaker
          if (stats.interceptions >= 3) featCount++; // Guardian

          try {
            // Get current persistent stats
            const dbStats = await SoccerService.statsRepository.findByUserId(
              player.userId,
            );
            const currentMmr = dbStats?.mmr ?? MmrSystem.INITIAL_MMR;
            const currentStreak = dbStats?.winStreak ?? 0;

            const calculation = MmrSystem.calculateMatchResult(
              currentMmr,
              currentStreak,
              matchResult,
              isMVP,
              featCount,
            );

            // Update Database
            await SoccerService.statsRepository.updateMmr(player.userId, {
              mmr: calculation.newMMR,
              winStreak: calculation.newStreak,
            });

            // Log Match History
            await SoccerService.statsRepository.addMatchHistory({
              userId: player.userId,
              result: matchResult,
              isMVP,
              mmrDelta: calculation.mmrDelta,
              newMmr: calculation.newMMR,
              goals: stats.goals,
              assists: stats.assists,
              interceptions: stats.interceptions,
              rankAtTime: calculation.newRank,
              ourScore:
                player.team === "red" ? this.score.red : this.score.blue,
              opponentScore:
                player.team === "red" ? this.score.blue : this.score.red,
            });

            mmrUpdates.push({
              playerId,
              name: player.name,
              delta: calculation.mmrDelta,
              newMmr: calculation.newMMR,
              rank: calculation.newRank,
              streak: calculation.newStreak,
              stats,
              isMVP,
              featCount,
            });
          } catch (error) {
            console.error(
              `Failed to process MMR for player ${playerId}:`,
              error,
            );
          }
        }

        // Broadcast everything
        io.to("scene:SoccerMap").emit("soccer:gameEnd", {
          winner,
          score: this.score,
          mvp,
          mmrUpdates,
        });
      };

      processMmr();
      this.resetGame();
    }
  }

  private static resetGame() {
    this.gameStatus = GameStatus.LOBBY;
    if (this.selectionTimer) {
      clearTimeout(this.selectionTimer);
      this.selectionTimer = null;
    }
    this.playerAssignedSkills.clear();
    this.playerMatchStats.clear();

    this.score = { red: 0, blue: 0 };
    this.gameTimeRemaining = this.DEFAULT_GAME_TIME;
    this.isGameActive = false;
    this.resetBall(false);
    this.resetAllPlayerPositions(false);
  }

  private static startSelectionPhase(io: Server) {
    if (this.gameStatus !== GameStatus.LOBBY) return;

    this.gameStatus = GameStatus.SKILL_SELECTION;
    this.playerAssignedSkills.clear();
    this.availableSkillIds = getAllSkills().map((s) => s.id);

    const playersInScene = Array.from(getPlayerPositions().values()).filter(
      (p) =>
        p.currentScene === "SoccerMap" &&
        (p.team === "red" || p.team === "blue"),
    );

    this.selectionOrder = playersInScene
      .map((p) => p.id)
      .sort(() => Math.random() - 0.5);

    this.currentPickerIndex = 0;

    io.to("scene:SoccerMap").emit("soccer:selectionPhaseStarted", {
      order: this.selectionOrder,
      availableSkills: this.availableSkillIds,
    });

    this.nextSelectionTurn(io);
  }

  private static nextSelectionTurn(io: Server) {
    if (this.selectionTimer) {
      clearTimeout(this.selectionTimer);
      this.selectionTimer = null;
    }

    if (
      this.currentPickerIndex >= this.selectionOrder.length ||
      this.availableSkillIds.length === 0
    ) {
      this.gameStatus = GameStatus.ACTIVE;
      this.startGame(io);
      return;
    }

    const currentPickerId = this.selectionOrder[this.currentPickerIndex];
    if (!currentPickerId) {
      this.currentPickerIndex++;
      this.nextSelectionTurn(io);
      return;
    }

    // Skip if player is no longer on a team
    const playerPositions = getPlayerPositions();
    const playerState = playerPositions.get(currentPickerId);
    if (
      !playerState ||
      (playerState.team !== "red" && playerState.team !== "blue")
    ) {
      console.log(
        `Skipping turn for player ${currentPickerId} as they are no longer on a team`,
      );
      this.currentPickerIndex++;
      this.nextSelectionTurn(io);
      return;
    }

    const pickTurnDuration = 30000;
    this.selectionTurnEndTime = Date.now() + pickTurnDuration;

    io.to("scene:SoccerMap").emit("soccer:selectionUpdate", {
      currentPickerId,
      endTime: this.selectionTurnEndTime,
      availableSkills: this.availableSkillIds,
    });

    this.selectionTimer = setTimeout(() => {
      this.autoPickSkill(io, currentPickerId);
    }, pickTurnDuration);
  }

  private static autoPickSkill(io: Server, playerId: string) {
    if (this.availableSkillIds.length > 0) {
      const randomIndex = Math.floor(
        Math.random() * this.availableSkillIds.length,
      );
      const skillId = this.availableSkillIds[randomIndex];
      if (skillId) {
        this.performPick(io, playerId, skillId);
      } else {
        this.currentPickerIndex++;
        this.nextSelectionTurn(io);
      }
    } else {
      this.currentPickerIndex++;
      this.nextSelectionTurn(io);
    }
  }

  private static performPick(io: Server, playerId: string, skillId: string) {
    this.playerAssignedSkills.set(playerId, skillId);
    this.availableSkillIds = this.availableSkillIds.filter(
      (id) => id !== skillId,
    );

    io.to("scene:SoccerMap").emit("soccer:skillPicked", {
      playerId,
      skillId,
      availableSkills: this.availableSkillIds,
    });

    if (this.midGamePickers.has(playerId)) {
      this.midGamePickers.delete(playerId);
      const playerState = getPlayerPositions().get(playerId);
      if (playerState && playerState.team) {
        this.resetPlayerPosition(playerId, playerState.team);
      }
    } else {
      this.currentPickerIndex++;
      this.nextSelectionTurn(io);
    }
  }

  private handlePickSkill(data: { skillId: string }) {
    const { skillId } = data;
    const playerId = this.socket.id;

    if (
      SoccerService.gameStatus !== GameStatus.SKILL_SELECTION &&
      SoccerService.gameStatus !== GameStatus.ACTIVE
    )
      return;

    if (SoccerService.gameStatus === GameStatus.SKILL_SELECTION) {
      const currentPickerId =
        SoccerService.selectionOrder[SoccerService.currentPickerIndex];
      if (playerId !== currentPickerId) return;
    } else {
      if (!SoccerService.midGamePickers.has(playerId)) return;
    }

    if (!SoccerService.availableSkillIds.includes(skillId)) return;

    SoccerService.performPick(this.io, playerId, skillId);
  }

  private static startGame(io: Server) {
    this.isGameActive = true;
    this.gameTimeRemaining = this.DEFAULT_GAME_TIME;
    this.lastTimerUpdate = Date.now();
    this.score = { red: 0, blue: 0 };

    io.to("scene:SoccerMap").emit("soccer:gameStarted", {
      duration: this.DEFAULT_GAME_TIME,
    });
  }

  /**
   *
   * TODO: I should move this to a util or service
   * skill turned based choosing
   */
  private handleTeamAssignment(data: {
    playerId: string;
    team: "red" | "blue" | "spectator";
  }) {
    const playerPositions = getPlayerPositions();
    const playerState = playerPositions.get(data.playerId);

    if (playerState && playerState.currentScene === "SoccerMap") {
      const oldTeam = playerState.team;
      playerState.team = data.team;
      playerPositions.set(data.playerId, playerState);

      const physics = SoccerService.playerPhysics.get(data.playerId);
      if (physics) {
        physics.team = data.team;
      }

      const wasSpectator = oldTeam !== "red" && oldTeam !== "blue";
      const isNowPlayer = data.team === "red" || data.team === "blue";

      if (wasSpectator && isNowPlayer) {
        if (SoccerService.gameStatus === GameStatus.SKILL_SELECTION) {
          if (!SoccerService.selectionOrder.includes(data.playerId)) {
            SoccerService.selectionOrder.push(data.playerId);
            this.io.to("scene:SoccerMap").emit("soccer:selectionPhaseStarted", {
              order: SoccerService.selectionOrder,
              availableSkills: SoccerService.availableSkillIds,
            });
          }
        } else if (SoccerService.gameStatus === GameStatus.ACTIVE) {
          SoccerService.midGamePickers.add(data.playerId);

          this.io.to(data.playerId).emit("soccer:startMidGamePick", {
            availableSkills: SoccerService.availableSkillIds,
          });
        }
      }

      if (data.team && !SoccerService.midGamePickers.has(data.playerId)) {
        SoccerService.resetPlayerPosition(data.playerId, data.team);
      }

      this.io.to("scene:SoccerMap").emit("soccer:teamAssigned", {
        playerId: data.playerId,
        team: data.team,
        playerName: playerState.name,
      });

      console.log(
        `Player ${playerState.name} assigned to ${data.team || "no"} team`,
      );
    }
  }

  private handleResetGame() {
    // Reset state using static method
    SoccerService.resetGame();

    // Broadcast reset to all players
    this.io.to("scene:SoccerMap").emit("soccer:gameReset", {
      score: SoccerService.score,
    });

    console.log("Soccer game reset - back to lobby");
  }

  private handleStartGame() {
    // Instead of starting immediately, start the selection phase
    SoccerService.startSelectionPhase(this.io);
    console.log("Soccer selection phase started");
  }

  private handleRandomizeTeams() {
    const playerPositions = getPlayerPositions();

    // Get all players in the SoccerMap scene
    const soccerPlayers = Array.from(playerPositions.values()).filter(
      (p) => p.currentScene === "SoccerMap",
    );

    if (soccerPlayers.length === 0) {
      console.log("No players to randomize");
      return;
    }

    // Shuffle players using Fisher-Yates algorithm
    const shuffled = [...soccerPlayers];
    for (let i = 0; i < shuffled.length - 1; i++) {
      const j = Math.floor(Math.random() * (i + 1));
      const temp = shuffled[i];
      if (temp && shuffled[j]) {
        shuffled[i] = shuffled[j]!;
        shuffled[j] = temp;
      }
    }

    // Split evenly between red and blue teams
    const midpoint = Math.ceil(shuffled.length / 2);
    const redTeam = shuffled.slice(0, midpoint);
    const blueTeam = shuffled.slice(midpoint);

    // Assign teams
    redTeam.forEach((player) => {
      player.team = "red";
      playerPositions.set(player.id, player);

      // Reset to red team spawn
      SoccerService.resetPlayerPosition(player.id, "red");

      // Broadcast team assignment
      this.io.to("scene:SoccerMap").emit("soccer:teamAssigned", {
        playerId: player.id,
        team: "red",
      });
    });

    blueTeam.forEach((player) => {
      player.team = "blue";
      playerPositions.set(player.id, player);

      // Reset to blue team spawn
      SoccerService.resetPlayerPosition(player.id, "blue");

      // Broadcast team assignment
      this.io.to("scene:SoccerMap").emit("soccer:teamAssigned", {
        playerId: player.id,
        team: "blue",
      });
    });

    console.log(
      `Randomized teams: ${redTeam.length} red, ${blueTeam.length} blue`,
    );
  }

  private handleActivateSkill(data: SkillActivationData) {
    const skillId = data.skillId;
    const skillConfig = getSkillConfig(skillId);

    if (!skillConfig) return;

    const playerPositions = getPlayerPositions();
    const playerState = playerPositions.get(data.playerId);
    if (!playerState) return;

    // Spectators cannot use skills
    if (playerState.team !== "red" && playerState.team !== "blue") {
      return;
    }

    // Enforce skill ownership ONLY if game is active or in selection
    if (SoccerService.gameStatus !== GameStatus.LOBBY) {
      const assignedSkillId = SoccerService.playerAssignedSkills.get(
        data.playerId,
      );
      if (assignedSkillId !== skillId) {
        console.log(
          `Player ${data.playerId} tried to use unassigned skill ${skillId}`,
        );
        return;
      }
    }

    // Handle passive skill Ninja Step
    if (skillId === "ninja_step") {
      if (SoccerService.ninjaStepPlayers.has(data.playerId)) {
        SoccerService.ninjaStepPlayers.delete(data.playerId);
      } else {
        SoccerService.ninjaStepPlayers.add(data.playerId);
      }

      // Broadcast toggle event so client can update visuals
      this.io.to("scene:SoccerMap").emit("soccer:skillActivated", {
        activatorId: data.playerId,
        skillId: skillId,
        affectedPlayers: [],
        duration: 0,
        visualConfig: skillConfig.clientVisuals,
      });
      return;
    }

    const now = Date.now();
    const playerCooldowns =
      SoccerService.playerSkillCooldowns.get(data.playerId) || new Map();
    const lastUsed = playerCooldowns.get(skillId) || 0;

    // Handle Lurking Radius (Two-Stage Skill)
    if (skillId === "lurking_radius") {
      const lurkingExpiration = SoccerService.lurkingPlayers.get(data.playerId);

      // Stage 2: Trigger (Intercept) if already lurking
      if (lurkingExpiration && now < lurkingExpiration) {
        // Check if ball is in range
        const ball = SoccerService.ballState;
        const playerPhysics = SoccerService.playerPhysics.get(data.playerId);
        if (playerPhysics) {
          const dist = Math.sqrt(
            Math.pow(ball.x - playerPhysics.x, 2) +
              Math.pow(ball.y - playerPhysics.y, 2),
          );
          const radius =
            skillConfig.serverEffect.params.type === "lurking_radius"
              ? skillConfig.serverEffect.params.radius
              : 200;

          if (dist <= radius) {
            const playerPositions = getPlayerPositions();
            const playerState = playerPositions.get(data.playerId);
            const team = playerState?.team;

            let interceptX = ball.x;
            let interceptY = ball.y;
            const offsetDistance = 40; // 40px from ball

            if (team === "red") {
              interceptX = ball.x - offsetDistance;
            } else if (team === "blue") {
              interceptX = ball.x + offsetDistance;
            }

            interceptX = Math.max(
              0,
              Math.min(interceptX, SoccerService.WORLD_BOUNDS.width),
            );
            interceptY = Math.max(
              0,
              Math.min(interceptY, SoccerService.WORLD_BOUNDS.height),
            );

            playerPhysics.x = interceptX;
            playerPhysics.y = interceptY;
            playerPhysics.vx = 0;
            playerPhysics.vy = 0;

            if (playerState) {
              playerState.x = interceptX;
              playerState.y = interceptY;
              playerState.vx = 0;
              playerState.vy = 0;
              playerPositions.set(data.playerId, playerState);
            }

            ball.lastTouchId = data.playerId;
            ball.lastTouchTimestamp = now;
            ball.vx = 0;
            ball.vy = 0;

            SoccerService.lurkingPlayers.delete(data.playerId);

            this.io.to("scene:SoccerMap").emit("soccer:skillTriggered", {
              activatorId: data.playerId,
              skillId: skillId,
              type: "intercept",
              targetX: interceptX,
              targetY: interceptY,
            });

            // don't wait for the next tick
            SoccerService.broadcastBallState(this.io);
            SoccerService.broadcastPlayerStates(this.io);
            return;
          } else {
            console.log(
              `Lurking Intercept Failed: Ball too far (${dist.toFixed(0)} > ${radius})`,
            );
            return;
          }
        }
      }

      if (now - lastUsed < skillConfig.cooldownMs) {
        return;
      }

      playerCooldowns.set(skillId, now);
      SoccerService.playerSkillCooldowns.set(data.playerId, playerCooldowns);
      SoccerService.lurkingPlayers.set(
        data.playerId,
        now + skillConfig.durationMs,
      );

      this.io.to("scene:SoccerMap").emit("soccer:skillActivated", {
        activatorId: data.playerId,
        skillId: skillId,
        affectedPlayers: [],
        duration: skillConfig.durationMs,
        visualConfig: skillConfig.clientVisuals,
      });

      setTimeout(() => {
        if (SoccerService.lurkingPlayers.has(data.playerId)) {
          SoccerService.lurkingPlayers.delete(data.playerId);
          this.io.to("scene:SoccerMap").emit("soccer:skillEnded", {
            activatorId: data.playerId,
            skillId: skillId,
          });
        }
      }, skillConfig.durationMs);

      return;
    }

    if (skillId === "power_shot") {
      const params = skillConfig.serverEffect.params as {
        type: "power_shot";
        force: number;
        knockbackForce: number;
        ballRetention: number;
        activeWindowMs: number;
      };

      const activatorPhysics = SoccerService.playerPhysics.get(data.playerId);
      const playerPositions = getPlayerPositions();
      const activatorState = playerPositions.get(data.playerId);

      if (!activatorPhysics || !activatorState) {
        console.log("Power Shot failed: Player not found");
        return;
      }

      const ball = SoccerService.ballState;
      const distToBall = Math.sqrt(
        Math.pow(ball.x - activatorPhysics.x, 2) +
          Math.pow(ball.y - activatorPhysics.y, 2),
      );

      if (distToBall > 200) {
        console.log(
          `Power Shot failed: Too far from ball (${distToBall.toFixed(0)} > 200)`,
        );
        return;
      }

      let goalX: number;
      const goalY = 800;

      if (activatorState.team === "red") {
        goalX = 3400;
      } else if (activatorState.team === "blue") {
        goalX = 120;
      } else {
        console.log("Power Shot failed: Player has no team");
        return;
      }

      const toGoalX = goalX - activatorPhysics.x;
      const toGoalY = goalY - activatorPhysics.y;
      const angle = Math.atan2(toGoalY, toGoalX);
      const kickPowerMultiplier =
        1.0 + (activatorPhysics.soccerStats?.kickPower ?? 0) * 0.1;

      ball.vx = Math.cos(angle) * params.force * kickPowerMultiplier;
      ball.vy = Math.sin(angle) * params.force * kickPowerMultiplier;
      ball.lastTouchId = data.playerId;
      ball.lastTouchTimestamp = now;
      ball.isMoving = true;

      // Apply knockback to kicker recoil
      const knockbackVx = -Math.cos(angle) * SoccerService.KICK_KNOCKBACK;
      const knockbackVy = -Math.sin(angle) * SoccerService.KICK_KNOCKBACK;
      activatorPhysics.vx += knockbackVx;
      activatorPhysics.vy += knockbackVy;

      SoccerService.powerShotActivation = {
        playerId: data.playerId,
        knockbackForce: params.knockbackForce,
        ballRetention: params.ballRetention,
        expiresAt: now + params.activeWindowMs,
      };

      const buffExpiresAt = now + 3000;
      const currentBuffs = SoccerService.playerBuffs.get(data.playerId) || {};
      currentBuffs.kickPower = {
        value: 5,
        expiresAt: buffExpiresAt,
      };
      SoccerService.playerBuffs.set(data.playerId, currentBuffs);

      this.io.to("scene:SoccerMap").emit("soccer:skillActivated", {
        activatorId: data.playerId,
        skillId: skillId,
        affectedPlayers: [],
        duration: 3000,
        visualConfig: skillConfig.clientVisuals,
      });

      SoccerService.broadcastBallState(this.io);

      console.log(
        `Power Shot activated by ${data.playerId} (team: ${activatorState.team}) toward goal at angle ${((angle * 180) / Math.PI).toFixed(1)}°`,
      );

      return;
    }

    if (now - lastUsed < skillConfig.cooldownMs) {
      return;
    }

    playerCooldowns.set(skillId, now);
    SoccerService.playerSkillCooldowns.set(data.playerId, playerCooldowns);

    const affectedPlayers: string[] = [];

    if (skillConfig.serverEffect.type === "blink") {
      const params = skillConfig.serverEffect.params as {
        type: "blink";
        distance: number;
        preventWallClip: boolean;
      };
      const activatorPhysics = SoccerService.playerPhysics.get(data.playerId);
      const activatorState = playerPositions.get(data.playerId);

      if (activatorPhysics && activatorState && data.facingDirection) {
        const startX = activatorPhysics.x;
        const startY = activatorPhysics.y;

        const direction = SoccerService.getFacingVector(data.facingDirection);
        let targetX = startX + direction.dx * params.distance;
        let targetY = startY + direction.dy * params.distance;

        if (params.preventWallClip) {
          const collision = SoccerService.checkBlinkCollision(
            startX,
            startY,
            targetX,
            targetY,
            activatorPhysics.team,
          );
          if (collision) {
            targetX = collision.x;
            targetY = collision.y;
          }
        }

        activatorPhysics.x = targetX;
        activatorPhysics.y = targetY;
        activatorPhysics.vx = 0;
        activatorPhysics.vy = 0;

        activatorState.x = targetX;
        activatorState.y = targetY;
        activatorState.vx = 0;
        activatorState.vy = 0;

        this.io.to("scene:SoccerMap").emit("soccer:blinkActivated", {
          activatorId: data.playerId,
          fromX: startX,
          fromY: startY,
          toX: targetX,
          toY: targetY,
          visualConfig: skillConfig.clientVisuals,
        });

        console.log(
          `Player ${data.playerId} blinked from (${startX}, ${startY}) to (${targetX}, ${targetY})`,
        );

        return;
      }
    }

    if (isSpeedEffect(skillConfig.serverEffect.params)) {
      const multiplier = skillConfig.serverEffect.params.multiplier;

      for (const [playerId, playerState] of playerPositions.entries()) {
        if (
          playerState.currentScene !== "SoccerMap" ||
          playerId === data.playerId
        ) {
          continue;
        }

        SoccerService.slowedPlayers.add(playerId);
        affectedPlayers.push(playerId);

        const playerPhysics = SoccerService.playerPhysics.get(playerId);
        if (playerPhysics) {
          playerPhysics.vx *= multiplier;
          playerPhysics.vy *= multiplier;
        }
      }
    }

    this.io.to("scene:SoccerMap").emit("soccer:skillActivated", {
      activatorId: data.playerId,
      skillId: skillId,
      affectedPlayers,
      duration: skillConfig.durationMs,
      visualConfig: skillConfig.clientVisuals,
    });

    if (skillId === "metavision") {
      SoccerService.metavisionPlayers.add(data.playerId);
    }

    setTimeout(() => {
      for (const playerId of affectedPlayers) {
        SoccerService.slowedPlayers.delete(playerId);
      }

      if (skillId === "metavision") {
        SoccerService.metavisionPlayers.delete(data.playerId);
      }

      this.io.to("scene:SoccerMap").emit("soccer:skillEnded", {
        activatorId: data.playerId,
        skillId: skillId,
      });
    }, skillConfig.durationMs);
  }

  private handleGetPlayers(
    callback: (
      players: Array<{
        id: string;
        name: string;
        team: "red" | "blue" | "spectator" | null;
      }>,
    ) => void,
  ) {
    const playerPositions = getPlayerPositions();
    const soccerPlayers = Array.from(playerPositions.values())
      .filter((p) => p.currentScene === "SoccerMap")
      .map((p) => ({
        id: p.id,
        name: p.name,
        team: p.team || null,
      }));

    callback(soccerPlayers);
  }

  private cleanup() {
    SoccerService.activeConnections--;

    if (SoccerService.ballState.lastTouchId === this.socket.id) {
      SoccerService.ballState.lastTouchId = null;
      console.log(`Ball ownership cleared for ${this.socket.id}`);
    }

    if (SoccerService.activeConnections === 0 && SoccerService.updateInterval) {
      clearInterval(SoccerService.updateInterval);
      SoccerService.updateInterval = null;
      console.log("Stopped soccer ball physics loop (no active connections)");
    }
  }

  private static checkBallRectCollision(
    ball: BallState,
    rect: CollisionRect,
  ): { collides: boolean; normal: { x: number; y: number } } | null {
    const ballRadius = this.BALL_RADIUS;

    const closestX = Math.max(rect.x, Math.min(ball.x, rect.x + rect.width));
    const closestY = Math.max(rect.y, Math.min(ball.y, rect.y + rect.height));

    const dx = ball.x - closestX;
    const dy = ball.y - closestY;
    const distance = Math.sqrt(dx * dx + dy * dy);

    if (distance < ballRadius) {
      let nx = dx;
      let ny = dy;

      if (distance === 0) {
        const distToLeft = ball.x - rect.x;
        const distToRight = rect.x + rect.width - ball.x;
        const distToTop = ball.y - rect.y;
        const distToBottom = rect.y + rect.height - ball.y;

        const minDist = Math.min(
          distToLeft,
          distToRight,
          distToTop,
          distToBottom,
        );

        if (minDist === distToLeft) {
          nx = -1;
          ny = 0;
        } else if (minDist === distToRight) {
          nx = 1;
          ny = 0;
        } else if (minDist === distToTop) {
          nx = 0;
          ny = -1;
        } else {
          nx = 0;
          ny = 1;
        }
      } else {
        nx /= distance;
        ny /= distance;
      }

      return {
        collides: true,
        normal: { x: nx, y: ny },
      };
    }

    return null;
  }

  private static checkBallGoalCollision(
    ball: BallState,
    goal: GoalZone,
  ): boolean {
    return (
      ball.x >= goal.x &&
      ball.x <= goal.x + goal.width &&
      ball.y >= goal.y &&
      ball.y <= goal.y + goal.height
    );
  }

  private static loadMapCollisions() {
    try {
      const collisionDataPath = path.join(
        __dirname,
        "../../data/soccer-collisions.json",
      );

      if (!fs.existsSync(collisionDataPath)) {
        console.error(
          "Soccer collision data file not found:",
          collisionDataPath,
        );
        console.error(
          "Create this file with collision rectangles from your Tiled map",
        );
        this.mapLoaded = true;
        return;
      }

      const collisionData = JSON.parse(
        fs.readFileSync(collisionDataPath, "utf-8"),
      );

      if (
        !collisionData.collisions ||
        !Array.isArray(collisionData.collisions)
      ) {
        console.error("Invalid collision data format");
        this.mapLoaded = true;
        return;
      }

      this.collisionRects = collisionData.collisions.map(
        (obj: { x: number; y: number; width: number; height: number }) => ({
          x: obj.x,
          y: obj.y,
          width: obj.width,
          height: obj.height,
        }),
      );

      this.mapLoaded = true;
    } catch (error) {
      console.error("Failed to load soccer collision data:", error);
      this.mapLoaded = true;
    }
  }

  private static loadGoalZones() {
    try {
      const goalDataPath = path.join(__dirname, "../../data/soccer-goals.json");

      if (!fs.existsSync(goalDataPath)) {
        this.goalsLoaded = true;
        return;
      }

      const goalData = JSON.parse(fs.readFileSync(goalDataPath, "utf-8"));

      if (!goalData.goals || !Array.isArray(goalData.goals)) {
        console.error("Invalid goal data format");
        this.goalsLoaded = true;
        return;
      }

      this.goalZones = goalData.goals.map(
        (obj: {
          name: string;
          team: "red" | "blue";
          x: number;
          y: number;
          width: number;
          height: number;
        }) => ({
          name: obj.name,
          team: obj.team,
          x: obj.x,
          y: obj.y,
          width: obj.width,
          height: obj.height,
        }),
      );

      this.goalsLoaded = true;
    } catch {
      this.goalsLoaded = true;
    }
  }

  public static updatePlayerPhysicsState(
    playerId: string,
    state: {
      x: number;
      y: number;
      vx: number;
      vy: number;
      radius: number;
      soccerStats?: SoccerStats | null;
    },
  ) {
    const playerPositions = getPlayerPositions();
    const playerState = playerPositions.get(playerId);

    if (playerState) {
      if (this.gameStatus !== GameStatus.LOBBY || !playerState.team) {
        playerState.team = "spectator";
        state.x = this.SPECTATOR_SPAWN.x;
        state.y = this.SPECTATOR_SPAWN.y;
        playerState.x = state.x;
        playerState.y = state.y;

        if (this.ioInstance) {
          this.ioInstance.to("scene:SoccerMap").emit("soccer:teamAssigned", {
            playerId: playerId,
            team: "spectator",
            playerName: playerState.name,
          });

          this.ioInstance.to("scene:SoccerMap").emit("soccer:playerReset", {
            playerId: playerId,
            x: state.x,
            y: state.y,
          });
        }
      }
    }

    this.playerPhysics.set(playerId, {
      id: playerId,
      team: playerState?.team || null,
      ...state,
    });
  }

  public static updatePlayerInput(
    playerId: string,
    input: {
      up: boolean;
      down: boolean;
      left: boolean;
      right: boolean;
      sequence?: number;
    },
  ) {
    const sequence = input.sequence || 0;
    const normalizedInput: PlayerInputState = {
      up: input.up,
      down: input.down,
      left: input.left,
      right: input.right,
      sequence,
    };

    let queue = this.playerInputQueues.get(playerId);
    if (!queue) {
      queue = [];
      this.playerInputQueues.set(playerId, queue);
    }

    const lastQueuedInput = queue[queue.length - 1];
    if (lastQueuedInput && lastQueuedInput.sequence === sequence) {
      return;
    }

    queue.push(normalizedInput);

    // Keep about 2 seconds of queued inputs as a safety cap.
    while (queue.length > 120) {
      queue.shift();
    }

    // Bootstrap current input so movement starts immediately.
    if (!this.playerInputs.has(playerId)) {
      this.playerInputs.set(playerId, normalizedInput);
    }
  }

  public static removePlayerPhysics(playerId: string) {
    this.playerPhysics.delete(playerId);
    this.playerInputs.delete(playerId);
    this.playerInputQueues.delete(playerId);
  }

  public static isPlayerSlowed(playerId: string): boolean {
    return this.slowedPlayers.has(playerId);
  }

  public static getSlowMultiplier(): number {
    const slowSkill = getSkillConfig("slowdown");
    if (slowSkill && isSpeedEffect(slowSkill.serverEffect.params)) {
      return slowSkill.serverEffect.params.multiplier;
    }
    return 1.0;
  }

  private static getFacingVector(facing: string): { dx: number; dy: number } {
    switch (facing) {
      case "UP":
        return { dx: 0, dy: -1 };
      case "DOWN":
        return { dx: 0, dy: 1 };
      case "LEFT":
        return { dx: -1, dy: 0 };
      case "RIGHT":
        return { dx: 1, dy: 0 };
      default:
        return { dx: 0, dy: 1 };
    }
  }

  private static checkBlinkCollision(
    startX: number,
    startY: number,
    endX: number,
    endY: number,
    team?: "red" | "blue" | "spectator" | null,
  ): { x: number; y: number } | null {
    const isSpectator = team !== "red" && team !== "blue";
    if (!isSpectator) {
      return null;
    }

    for (const rect of this.collisionRects) {
      if (
        endX >= rect.x &&
        endX <= rect.x + rect.width &&
        endY >= rect.y &&
        endY <= rect.y + rect.height
      ) {
        return { x: startX, y: startY };
      }
    }
    return null; // No collision
  }

  // Broadcast current physics state to a specific player for joins
  public static broadcastInitialPhysicsState(socketId: string) {
    if (!this.ioInstance) {
      console.error(
        "Cannot broadcast initial physics: io instance not available",
      );
      return;
    }

    const updates: Array<{
      id: string;
      x: number;
      y: number;
      vx: number;
      vy: number;
    }> = [];

    for (const [id, player] of this.playerPhysics.entries()) {
      updates.push({
        id,
        x: player.x,
        y: player.y,
        vx: player.vx,
        vy: player.vy,
      });
    }

    if (updates.length > 0) {
      this.ioInstance.to(socketId).emit("players:physicsUpdate", {
        players: updates,
        timestamp: Date.now(),
        tick: this.currentTick,
      });
      console.log(
        `Sent initial physics state (${updates.length} players) to ${socketId}`,
      );
    }
  }

  public static resetBall(withDelay: boolean = true) {
    const resetAction = () => {
      const nextSequence = (this.ballState.sequence || 0) + 1;
      this.ballState = {
        x: this.WORLD_BOUNDS.width / 2,
        y: this.WORLD_BOUNDS.height / 2,
        vx: 0,
        vy: 0,
        lastTouchId: null,
        previousTouchId: null,
        lastTouchTimestamp: 0,
        isMoving: false,
        sequence: nextSequence,
      };

      this.hasScoredGoal = false;
      console.log("Ball reset to center");
    };

    if (withDelay) {
      this.hasScoredGoal = true;
      setTimeout(resetAction, 3000);
    } else {
      resetAction();
    }
  }

  public static getScore() {
    return { ...this.score };
  }

  private static resetPlayerPosition(
    playerId: string,
    team: "red" | "blue" | "spectator",
  ) {
    const playerPositions = getPlayerPositions();
    const playerPhysics = this.playerPhysics.get(playerId);
    const playerState = playerPositions.get(playerId);

    if (!playerState || !playerPhysics) return;

    let targetX: number;
    let targetY: number;

    if (team === "spectator") {
      targetX = this.SPECTATOR_SPAWN.x;
      targetY = this.SPECTATOR_SPAWN.y;
    } else {
      // Get team spawns
      const spawns =
        team === "red" ? this.RED_TEAM_SPAWNS : this.BLUE_TEAM_SPAWNS;

      const teamPlayers = Array.from(playerPositions.values()).filter(
        (p) => p.team === team && p.currentScene === "SoccerMap",
      );
      const spawnIndex = Math.min(teamPlayers.length - 1, spawns.length - 1);
      const spawn = spawns[spawnIndex] || spawns[0]!;
      targetX = spawn.x;
      targetY = spawn.y;
    }

    playerPhysics.x = targetX;
    playerPhysics.y = targetY;
    playerPhysics.vx = 0;
    playerPhysics.vy = 0;

    playerState.x = targetX;
    playerState.y = targetY;
    playerState.vx = 0;
    playerState.vy = 0;

    playerPositions.set(playerId, playerState);

    if (this.ioInstance) {
      this.ioInstance.to("scene:SoccerMap").emit("soccer:playerReset", {
        playerId,
        x: targetX,
        y: targetY,
      });
    }
  }

  private static resetAllPlayerPositions(withDelay: boolean = true) {
    const resetAction = () => {
      const playerPositions = getPlayerPositions();
      const redTeamPlayers: string[] = [];
      const blueTeamPlayers: string[] = [];

      for (const [playerId, player] of playerPositions.entries()) {
        if (player.currentScene !== "SoccerMap") continue;

        if (player.team === "red") {
          redTeamPlayers.push(playerId);
        } else if (player.team === "blue") {
          blueTeamPlayers.push(playerId);
        }
      }

      redTeamPlayers.forEach((playerId, index) => {
        const spawn =
          this.RED_TEAM_SPAWNS[index % this.RED_TEAM_SPAWNS.length]!;
        const playerPhysics = this.playerPhysics.get(playerId);
        const playerState = playerPositions.get(playerId);

        if (playerPhysics && playerState) {
          playerPhysics.x = spawn.x;
          playerPhysics.y = spawn.y;
          playerPhysics.vx = 0;
          playerPhysics.vy = 0;

          playerState.x = spawn.x;
          playerState.y = spawn.y;
          playerState.vx = 0;
          playerState.vy = 0;

          playerPositions.set(playerId, playerState);

          if (this.ioInstance) {
            this.ioInstance.to("scene:SoccerMap").emit("soccer:playerReset", {
              playerId,
              x: spawn.x,
              y: spawn.y,
            });
          }
        }
      });

      blueTeamPlayers.forEach((playerId, index) => {
        const spawn =
          this.BLUE_TEAM_SPAWNS[index % this.BLUE_TEAM_SPAWNS.length]!;
        const playerPhysics = this.playerPhysics.get(playerId);
        const playerState = playerPositions.get(playerId);

        if (playerPhysics && playerState) {
          playerPhysics.x = spawn.x;
          playerPhysics.y = spawn.y;
          playerPhysics.vx = 0;
          playerPhysics.vy = 0;

          playerState.x = spawn.x;
          playerState.y = spawn.y;
          playerState.vx = 0;
          playerState.vy = 0;

          playerPositions.set(playerId, playerState);

          if (this.ioInstance) {
            this.ioInstance.to("scene:SoccerMap").emit("soccer:playerReset", {
              playerId,
              x: spawn.x,
              y: spawn.y,
            });
          }
        }
      });

      console.log(
        `Reset ${redTeamPlayers.length} red team and ${blueTeamPlayers.length} blue team players`,
      );
    };

    if (withDelay) {
      setTimeout(resetAction, 3000);
    } else {
      resetAction();
    }
  }
}
