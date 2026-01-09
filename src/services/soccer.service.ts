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
  radius: number;
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

interface PendingKick {
  playerId: string;
  angle: number;
  kickPower: number;
  timestamp: number;
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

  private static ballState: BallState & { previousTouchId: string | null } = {
    x: 1760,
    y: 800,
    vx: 0,
    vy: 0,
    lastTouchId: null,
    previousTouchId: null,
    lastTouchTimestamp: 0,
    isMoving: false,
  };

  private static readonly DRAG = 1;
  private static readonly BOUNCE = 0.7;
  private static readonly BALL_RADIUS = 30;
  private static readonly PHYSICS_RATE_MS = 16.6;
  private static readonly NETWORK_RATE_MS = 50;
  private static readonly VELOCITY_THRESHOLD = 10;
  private static readonly WORLD_BOUNDS = { width: 3520, height: 1600 };
  private static readonly KICK_COOLDOWN_MS = 300;
  private static readonly MAX_DRIBBLE_DISTANCE = 300;
  private static readonly MAX_DELTA_TIME = 0.1;

  private static readonly SPECTATOR_SPAWN = { x: 250, y: 100 };
  private static readonly PLAYER_RADIUS = 30;
  private static readonly PUSH_DAMPING = 1.5;
  private static readonly BALL_KNOCKBACK = 0.6;
  private static readonly KICK_KNOCKBACK = 400;

  private static physicsLoopRunning = false;
  private static activeConnections = 0;
  private static lastKickTime = 0;
  private static lastPhysicsUpdate = Date.now();
  private static lastNetworkBroadcast = 0;

  private static collisionRects: CollisionRect[] = [];
  private static mapLoaded = false;

  private static playerPhysics: Map<string, PlayerPhysicsState> = new Map();
  private static ioInstance: Server | null = null;

  private static goalZones: GoalZone[] = [];
  private static goalsLoaded = false;
  private static score = { red: 0, blue: 0 };
  private static goalScoredAt: number = 0;
  private static readonly GOAL_RESET_DELAY_MS = 3000;

  private static readonly DEFAULT_GAME_TIME = 5 * 60;
  private static readonly OVERTIME_DURATION = 1 * 60;
  private static gameTimeRemaining = SoccerService.DEFAULT_GAME_TIME;
  private static isGameActive = false;
  private static lastTimerUpdate = Date.now();

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

  private static pendingKicks: PendingKick[] = [];
  private static pendingDribbles: BallDribbleData[] = [];
  private static inputLock = false;

  private static skillTimeouts: Map<string, NodeJS.Timeout> = new Map();

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

    if (!SoccerService.physicsLoopRunning) {
      SoccerService.startPhysicsLoop(io);
    }
  }

  listenForSoccerEvents() {
    this.socket.on(GameEventEnums.BALL_KICK, (data: BallKickData) => {
      this.queueBallKick(data);
    });

    this.socket.on(GameEventEnums.BALL_DRIBBLE, (data: BallDribbleData) => {
      this.queueBallDribble(data);
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

  private queueBallKick(data: BallKickData) {
    const now = Date.now();
    if (now - SoccerService.lastKickTime < SoccerService.KICK_COOLDOWN_MS) {
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

    SoccerService.pendingKicks.push({
      playerId: data.playerId,
      angle: data.angle,
      kickPower: data.kickPower,
      timestamp: now,
    });
  }

  private queueBallDribble(data: BallDribbleData) {
    const playerPositions = getPlayerPositions();
    const playerState = playerPositions.get(data.playerId);
    if (
      !playerState ||
      (playerState.team !== "red" && playerState.team !== "blue")
    ) {
      return;
    }

    SoccerService.pendingDribbles.push(data);
  }

  private static processInputQueue() {
    if (this.inputLock) return;
    this.inputLock = true;

    const now = Date.now();

    if (this.pendingKicks.length > 0) {
      this.pendingKicks.sort((a, b) => a.timestamp - b.timestamp);
      const kick = this.pendingKicks[0];
      if (kick) {
        this.executeKick(kick);
        this.lastKickTime = now;
      }
      this.pendingKicks = [];
      this.pendingDribbles = [];
    } else if (this.pendingDribbles.length > 0) {
      const timeSinceLastKick = now - this.lastKickTime;
      if (timeSinceLastKick >= 100) {
        const dribble = this.pendingDribbles[this.pendingDribbles.length - 1];
        if (dribble) {
          this.executeDribble(dribble);
        }
      }
      this.pendingDribbles = [];
    }

    this.inputLock = false;
  }

  private static executeKick(kick: PendingKick) {
    const ballState = this.ballState;
    const kickerPhysics = this.playerPhysics.get(kick.playerId);

    if (!kickerPhysics) return;

    const dx_dist = ballState.x - kickerPhysics.x;
    const dy_dist = ballState.y - kickerPhysics.y;
    const distance = Math.sqrt(dx_dist * dx_dist + dy_dist * dy_dist);

    const isMetaVisionActive = this.metavisionPlayers.has(kick.playerId);
    const kickThreshold = isMetaVisionActive ? 200 : 140;

    if (distance > kickThreshold) {
      return;
    }

    let kickPowerStat = kickerPhysics?.soccerStats?.kickPower ?? 0;

    const buffs = this.playerBuffs.get(kick.playerId);
    if (buffs?.kickPower && Date.now() < buffs.kickPower.expiresAt) {
      kickPowerStat += buffs.kickPower.value;
    }

    let kickPowerMultiplier = 1.0 + kickPowerStat * 0.1;

    if (isMetaVisionActive) {
      kickPowerMultiplier *= 1.2;
    }

    const kickVx = Math.cos(kick.angle) * kick.kickPower * kickPowerMultiplier;
    const kickVy = Math.sin(kick.angle) * kick.kickPower * kickPowerMultiplier;

    ballState.vx = kickVx;
    ballState.vy = kickVy;
    if (ballState.lastTouchId !== kick.playerId) {
      ballState.previousTouchId = ballState.lastTouchId;
      ballState.lastTouchId = kick.playerId;
    }
    ballState.lastTouchTimestamp = Date.now();
    ballState.isMoving = true;

    const knockbackVx = -Math.cos(kick.angle) * this.KICK_KNOCKBACK;
    const knockbackVy = -Math.sin(kick.angle) * this.KICK_KNOCKBACK;
    kickerPhysics.vx += knockbackVx;
    kickerPhysics.vy += knockbackVy;

    if (this.ioInstance) {
      this.ioInstance.to("scene:SoccerMap").emit(GameEventEnums.BALL_KICKED, {
        kickerId: kick.playerId,
        kickPower: kick.kickPower,
        ballX: ballState.x,
        ballY: ballState.y,
        timestamp: Date.now(),
      });
    }
  }

  private static executeDribble(data: BallDribbleData) {
    const ballState = this.ballState;

    const dx = ballState.x - data.playerX;
    const dy = ballState.y - data.playerY;
    const distance = Math.sqrt(dx * dx + dy * dy);

    if (distance > this.MAX_DRIBBLE_DISTANCE) {
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
  }

  private static async startPhysicsLoop(io: Server) {
    this.physicsLoopRunning = true;
    this.lastPhysicsUpdate = Date.now();
    this.lastNetworkBroadcast = Date.now();

    while (this.physicsLoopRunning) {
      const frameStart = Date.now();

      this.processInputQueue();
      this.updatePhysics(io);
      this.updateGameTimer(io);

      const now = Date.now();
      if (now - this.lastNetworkBroadcast >= this.NETWORK_RATE_MS) {
        this.lastNetworkBroadcast = now;
        this.broadcastBallState(io);
        this.broadcastPlayerStates(io);
      }

      const executionTime = Date.now() - frameStart;
      const waitTime = Math.max(0, this.PHYSICS_RATE_MS - executionTime);

      await new Promise((resolve) => setTimeout(resolve, waitTime));
    }
  }

  private static updatePhysics(io: Server) {
    const now = Date.now();
    const rawDt = (now - this.lastPhysicsUpdate) / 1000;
    const dt = Math.min(rawDt, this.MAX_DELTA_TIME);
    this.lastPhysicsUpdate = now;

    this.updateBallPhysics(io, dt);
    this.updatePlayerPhysics(io, dt);
  }

  private static updateBallPhysics(io: Server, dt: number) {
    const ball = this.ballState;

    if (this.goalScoredAt > 0) {
      if (Date.now() - this.goalScoredAt >= this.GOAL_RESET_DELAY_MS) {
        this.finalizeGoalReset();
      }
      return;
    }

    if (!ball.isMoving) return;

    const dragFactor = Math.exp(-this.DRAG * dt);
    ball.vx *= dragFactor;
    ball.vy *= dragFactor;

    ball.x += ball.vx * dt;
    ball.y += ball.vy * dt;

    this.handleBallPlayerCollisions(io);
    this.handleBallWallCollisions();
    this.handleBallGoalCollisions(io);
    this.handleBallBoundaryCollisions();

    const speed = Math.sqrt(ball.vx * ball.vx + ball.vy * ball.vy);
    if (speed < this.VELOCITY_THRESHOLD) {
      ball.vx = 0;
      ball.vy = 0;
      ball.isMoving = false;
    }
  }

  private static handleBallPlayerCollisions(io: Server) {
    const ball = this.ballState;
    const playersInScene = Array.from(this.playerPhysics.values());
    const collidedPlayers: PlayerPhysicsState[] = [];

    for (const player of playersInScene) {
      const dx = ball.x - player.x;
      const dy = ball.y - player.y;
      const distance = Math.sqrt(dx * dx + dy * dy);
      const minDistance = this.BALL_RADIUS + player.radius;

      if (distance < minDistance) {
        collidedPlayers.push(player);
      }
    }

    for (const player of collidedPlayers) {
      const playerState = getPlayerPositions().get(player.id);
      if (!playerState) continue;

      const dx = ball.x - player.x;
      const dy = ball.y - player.y;
      const distance = Math.sqrt(dx * dx + dy * dy);

      this.resolveBallPlayerCollision(
        io,
        player.id,
        playerState,
        dx,
        dy,
        distance,
        player.radius,
      );
    }
  }

  private static resolveBallPlayerCollision(
    io: Server,
    playerId: string,
    player: PlayerState,
    dx: number,
    dy: number,
    distance: number,
    playerRadius: number,
  ) {
    const ball = this.ballState;
    const safeDistance = Math.max(distance, 0.001);

    const nx = dx / safeDistance;
    const ny = dy / safeDistance;

    const dotProduct = ball.vx * nx + ball.vy * ny;
    ball.vx = ball.vx - 2 * dotProduct * nx;
    ball.vy = ball.vy - 2 * dotProduct * ny;

    const isPowerShot =
      this.powerShotActivation &&
      Date.now() < this.powerShotActivation.expiresAt;
    const bounceDamping = isPowerShot
      ? this.powerShotActivation!.ballRetention
      : 0.6;

    ball.vx *= bounceDamping;
    ball.vy *= bounceDamping;

    const overlap = this.BALL_RADIUS + playerRadius - safeDistance;
    ball.x += nx * (overlap + 1);
    ball.y += ny * (overlap + 1);

    if (ball.lastTouchId !== playerId) {
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
      }

      ball.previousTouchId = ball.lastTouchId;
      ball.lastTouchId = playerId;
    }
    ball.lastTouchTimestamp = Date.now();

    io.to("scene:SoccerMap").emit("ball:intercepted", {
      playerId,
      ballX: ball.x,
      ballY: ball.y,
      timestamp: Date.now(),
    });
  }

  private static handleBallWallCollisions() {
    const ball = this.ballState;

    for (const rect of this.collisionRects) {
      const collision = this.checkBallRectCollision(ball, rect);

      if (collision) {
        const normal = collision.normal;
        const dotProduct = ball.vx * normal.x + ball.vy * normal.y;

        ball.vx = ball.vx - 2 * dotProduct * normal.x;
        ball.vy = ball.vy - 2 * dotProduct * normal.y;
        ball.vx *= this.BOUNCE;
        ball.vy *= this.BOUNCE;

        const closestX = Math.max(
          rect.x,
          Math.min(ball.x, rect.x + rect.width),
        );
        const closestY = Math.max(
          rect.y,
          Math.min(ball.y, rect.y + rect.height),
        );
        const penetration =
          this.BALL_RADIUS -
          Math.sqrt(
            Math.pow(ball.x - closestX, 2) + Math.pow(ball.y - closestY, 2),
          );

        ball.x += normal.x * (penetration + 1);
        ball.y += normal.y * (penetration + 1);
        break;
      }
    }
  }

  private static handleBallGoalCollisions(io: Server) {
    const ball = this.ballState;

    for (const goal of this.goalZones) {
      if (this.checkBallInGoal(ball, goal)) {
        this.scoreGoal(io, goal);
        return;
      }
    }
  }

  private static checkBallInGoal(ball: BallState, goal: GoalZone): boolean {
    return (
      ball.x >= goal.x &&
      ball.x <= goal.x + goal.width &&
      ball.y >= goal.y &&
      ball.y <= goal.y + goal.height
    );
  }

  private static scoreGoal(io: Server, goal: GoalZone) {
    const ball = this.ballState;
    const scoringTeam = goal.team === "red" ? "blue" : "red";
    this.score[scoringTeam]++;

    if (ball.lastTouchId) {
      const stats = this.playerMatchStats.get(ball.lastTouchId) || {
        goals: 0,
        assists: 0,
        interceptions: 0,
      };
      stats.goals++;
      this.playerMatchStats.set(ball.lastTouchId, stats);

      if (ball.previousTouchId) {
        const scorerState = getPlayerPositions().get(ball.lastTouchId);
        const assisterState = getPlayerPositions().get(ball.previousTouchId);
        if (
          scorerState &&
          assisterState &&
          scorerState.team === assisterState.team
        ) {
          const assistStats = this.playerMatchStats.get(
            ball.previousTouchId,
          ) || {
            goals: 0,
            assists: 0,
            interceptions: 0,
          };
          assistStats.assists++;
          this.playerMatchStats.set(ball.previousTouchId, assistStats);
        }
      }
    }

    io.to("scene:SoccerMap").emit("goal:scored", {
      scoringTeam,
      goalName: goal.name,
      lastTouchId: ball.lastTouchId,
      score: { red: this.score.red, blue: this.score.blue },
      timestamp: Date.now(),
    });

    ball.vx = 0;
    ball.vy = 0;
    ball.isMoving = false;
    this.goalScoredAt = Date.now();
  }

  private static finalizeGoalReset() {
    this.ballState = {
      x: this.WORLD_BOUNDS.width / 2,
      y: this.WORLD_BOUNDS.height / 2,
      vx: 0,
      vy: 0,
      lastTouchId: null,
      previousTouchId: null,
      lastTouchTimestamp: 0,
      isMoving: false,
    };
    this.goalScoredAt = 0;
    this.resetAllPlayerPositionsImmediate();

    if (this.ioInstance) {
      this.broadcastBallState(this.ioInstance);
    }
  }

  private static handleBallBoundaryCollisions() {
    const ball = this.ballState;

    if (ball.x - this.BALL_RADIUS < 0) {
      ball.x = this.BALL_RADIUS;
      ball.vx = -ball.vx * this.BOUNCE;
    } else if (ball.x + this.BALL_RADIUS > this.WORLD_BOUNDS.width) {
      ball.x = this.WORLD_BOUNDS.width - this.BALL_RADIUS;
      ball.vx = -ball.vx * this.BOUNCE;
    }

    if (ball.y - this.BALL_RADIUS < 0) {
      ball.y = this.BALL_RADIUS;
      ball.vy = -ball.vy * this.BOUNCE;
    } else if (ball.y + this.BALL_RADIUS > this.WORLD_BOUNDS.height) {
      ball.y = this.WORLD_BOUNDS.height - this.BALL_RADIUS;
      ball.vy = -ball.vy * this.BOUNCE;
    }
  }

  private static broadcastBallState(io: Server) {
    io.to("scene:SoccerMap").emit(GameEventEnums.BALL_STATE, {
      x: this.ballState.x,
      y: this.ballState.y,
      vx: this.ballState.vx,
      vy: this.ballState.vy,
      lastTouchId: this.ballState.lastTouchId,
      timestamp: Date.now(),
    });
  }

  private static updatePlayerPhysics(io: Server, dt: number) {
    const players = Array.from(this.playerPhysics.values());

    for (let i = 0; i < players.length; i++) {
      for (let j = i + 1; j < players.length; j++) {
        const p1 = players[i];
        const p2 = players[j];

        if (!p1 || !p2) continue;

        const p1Ghosted =
          this.ninjaStepPlayers.has(p1.id) && !this.isTouchingBall(p1);
        const p2Ghosted =
          this.ninjaStepPlayers.has(p2.id) && !this.isTouchingBall(p2);
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

    for (const player of players) {
      const dx = this.ballState.x - player.x;
      const dy = this.ballState.y - player.y;
      const distance = Math.sqrt(dx * dx + dy * dy);
      const minDistance = this.BALL_RADIUS + player.radius;

      if (distance < minDistance && this.ballState.isMoving) {
        this.handleBallPlayerKnockback(player, dx, dy, distance);
      }
    }

    for (const player of players) {
      player.x += player.vx * dt;
      player.y += player.vy * dt;

      const isSpectator = player.team !== "red" && player.team !== "blue";
      if (isSpectator) {
        this.handleSpectatorWallCollisions(player);
      }
    }

    for (const player of players) {
      const dribblingStat = player.soccerStats?.dribbling ?? 0;
      const frictionCoefficient = 0.95 - dribblingStat * 0.02;

      player.vx *= frictionCoefficient;
      player.vy *= frictionCoefficient;

      const speed = Math.sqrt(player.vx * player.vx + player.vy * player.vy);
      if (speed < 5) {
        player.vx = 0;
        player.vy = 0;
      }
    }
  }

  private static handleSpectatorWallCollisions(player: PlayerPhysicsState) {
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
          else if (min === dR) player.x = rect.x + rect.width + player.radius;
          else if (min === dT) player.y = rect.y - player.radius;
          else player.y = rect.y + rect.height + player.radius;
        }
        player.vx = 0;
        player.vy = 0;
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
    const safeDistance = Math.max(distance, 0.001);
    const nx = dx / safeDistance;
    const ny = dy / safeDistance;

    const overlap = p1.radius + p2.radius - safeDistance;
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

    const safeDistance = Math.max(distance, 0.001);
    const nx = -dx / safeDistance;
    const ny = -dy / safeDistance;

    const isPowerShot =
      this.powerShotActivation &&
      Date.now() < this.powerShotActivation.expiresAt;
    const knockbackMagnitude = isPowerShot
      ? this.powerShotActivation!.knockbackForce
      : Math.min(ballSpeed * this.BALL_KNOCKBACK, 200);

    player.vx += nx * knockbackMagnitude;
    player.vy += ny * knockbackMagnitude;
  }

  private static isTouchingBall(p: PlayerPhysicsState) {
    const dx = this.ballState.x - p.x;
    const dy = this.ballState.y - p.y;
    const dist = Math.sqrt(dx * dx + dy * dy);
    return dist < this.BALL_RADIUS + p.radius + 20;
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
      timestamp: number;
    }> = [];

    const timestamp = Date.now();

    for (const [id, player] of this.playerPhysics.entries()) {
      updates.push({
        id,
        x: player.x,
        y: player.y,
        vx: player.vx,
        vy: player.vy,
        isGhosted:
          this.ninjaStepPlayers.has(id) && !this.isTouchingBall(player),
        isSpectator: player.team !== "red" && player.team !== "blue",
        timestamp,
      });
    }

    if (updates.length > 0) {
      io.to("scene:SoccerMap").emit("players:physicsUpdate", updates);
    }
  }

  private static updateGameTimer(io: Server) {
    if (!this.isGameActive) return;

    const now = Date.now();
    const deltaTime = (now - this.lastTimerUpdate) / 1000;
    this.lastTimerUpdate = now;

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
      this.gameTimeRemaining = this.OVERTIME_DURATION;
      this.isGameActive = true;
      this.lastTimerUpdate = Date.now();

      io.to("scene:SoccerMap").emit("soccer:overtime", {
        message: "Overtime! 1 minute added",
        duration: this.OVERTIME_DURATION,
      });
    } else {
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

          let featCount = 0;
          if (stats.goals >= 2) featCount++;
          if (stats.assists >= 2) featCount++;
          if (stats.interceptions >= 3) featCount++;

          try {
            const dbStats = await this.statsRepository.findByUserId(
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

            await this.statsRepository.updateMmr(player.userId, {
              mmr: calculation.newMMR,
              winStreak: calculation.newStreak,
            });

            await this.statsRepository.addMatchHistory({
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

    for (const timeout of this.skillTimeouts.values()) {
      clearTimeout(timeout);
    }
    this.skillTimeouts.clear();

    this.playerAssignedSkills.clear();
    this.playerMatchStats.clear();
    this.playerSkillCooldowns.clear();
    this.slowedPlayers.clear();
    this.metavisionPlayers.clear();
    this.ninjaStepPlayers.clear();
    this.lurkingPlayers.clear();
    this.playerBuffs.clear();
    this.powerShotActivation = null;

    this.score = { red: 0, blue: 0 };
    this.gameTimeRemaining = this.DEFAULT_GAME_TIME;
    this.isGameActive = false;
    this.goalScoredAt = 0;
    this.resetBallImmediate();
    this.resetAllPlayerPositionsImmediate();
  }

  private static resetBallImmediate() {
    this.ballState = {
      x: this.WORLD_BOUNDS.width / 2,
      y: this.WORLD_BOUNDS.height / 2,
      vx: 0,
      vy: 0,
      lastTouchId: null,
      previousTouchId: null,
      lastTouchTimestamp: 0,
      isMoving: false,
    };
  }

  private static resetAllPlayerPositionsImmediate() {
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
      const spawn = this.RED_TEAM_SPAWNS[index % this.RED_TEAM_SPAWNS.length]!;
      this.setPlayerPosition(playerId, spawn.x, spawn.y);
    });

    blueTeamPlayers.forEach((playerId, index) => {
      const spawn =
        this.BLUE_TEAM_SPAWNS[index % this.BLUE_TEAM_SPAWNS.length]!;
      this.setPlayerPosition(playerId, spawn.x, spawn.y);
    });
  }

  private static setPlayerPosition(playerId: string, x: number, y: number) {
    const playerPositions = getPlayerPositions();
    const playerPhysics = this.playerPhysics.get(playerId);
    const playerState = playerPositions.get(playerId);

    if (playerPhysics) {
      playerPhysics.x = x;
      playerPhysics.y = y;
      playerPhysics.vx = 0;
      playerPhysics.vy = 0;
    }

    if (playerState) {
      playerState.x = x;
      playerState.y = y;
      playerState.vx = 0;
      playerState.vy = 0;
      playerPositions.set(playerId, playerState);
    }

    if (this.ioInstance) {
      this.ioInstance.to("scene:SoccerMap").emit("soccer:playerReset", {
        playerId,
        x,
        y,
        timestamp: Date.now(),
      });
    }
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

    const playerPositions = getPlayerPositions();
    const playerState = playerPositions.get(currentPickerId);
    if (
      !playerState ||
      (playerState.team !== "red" && playerState.team !== "blue")
    ) {
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
    }
  }

  private handleResetGame() {
    SoccerService.resetGame();

    this.io.to("scene:SoccerMap").emit("soccer:gameReset", {
      score: SoccerService.score,
    });
  }

  private handleStartGame() {
    SoccerService.startSelectionPhase(this.io);
  }

  private handleRandomizeTeams() {
    const playerPositions = getPlayerPositions();

    const soccerPlayers = Array.from(playerPositions.values()).filter(
      (p) => p.currentScene === "SoccerMap",
    );

    if (soccerPlayers.length === 0) {
      return;
    }

    const shuffled = [...soccerPlayers];
    for (let i = shuffled.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [shuffled[i], shuffled[j]] = [shuffled[j]!, shuffled[i]!];
    }

    const midpoint = Math.ceil(shuffled.length / 2);
    const redTeam = shuffled.slice(0, midpoint);
    const blueTeam = shuffled.slice(midpoint);

    redTeam.forEach((player) => {
      player.team = "red";
      playerPositions.set(player.id, player);
      SoccerService.resetPlayerPosition(player.id, "red");
      this.io.to("scene:SoccerMap").emit("soccer:teamAssigned", {
        playerId: player.id,
        team: "red",
      });
    });

    blueTeam.forEach((player) => {
      player.team = "blue";
      playerPositions.set(player.id, player);
      SoccerService.resetPlayerPosition(player.id, "blue");
      this.io.to("scene:SoccerMap").emit("soccer:teamAssigned", {
        playerId: player.id,
        team: "blue",
      });
    });
  }

  private handleActivateSkill(data: SkillActivationData) {
    const skillId = data.skillId;
    const skillConfig = getSkillConfig(skillId);

    if (!skillConfig) return;

    const playerPositions = getPlayerPositions();
    const playerState = playerPositions.get(data.playerId);
    if (!playerState) return;

    if (playerState.team !== "red" && playerState.team !== "blue") {
      return;
    }

    if (SoccerService.gameStatus !== GameStatus.LOBBY) {
      const assignedSkillId = SoccerService.playerAssignedSkills.get(
        data.playerId,
      );
      if (assignedSkillId !== skillId) {
        return;
      }
    }

    if (skillId === "ninja_step") {
      if (SoccerService.ninjaStepPlayers.has(data.playerId)) {
        SoccerService.ninjaStepPlayers.delete(data.playerId);
      } else {
        SoccerService.ninjaStepPlayers.add(data.playerId);
      }

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

    if (skillId === "lurking_radius") {
      const lurkingExpiration = SoccerService.lurkingPlayers.get(data.playerId);

      if (lurkingExpiration && now < lurkingExpiration) {
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
            const team = playerState?.team;

            let interceptX = ball.x;
            let interceptY = ball.y;
            const offsetDistance = 40;

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

            const timeoutKey = `lurking_${data.playerId}`;
            const existingTimeout = SoccerService.skillTimeouts.get(timeoutKey);
            if (existingTimeout) {
              clearTimeout(existingTimeout);
              SoccerService.skillTimeouts.delete(timeoutKey);
            }

            this.io.to("scene:SoccerMap").emit("soccer:skillTriggered", {
              activatorId: data.playerId,
              skillId: skillId,
              type: "intercept",
              targetX: interceptX,
              targetY: interceptY,
            });

            SoccerService.broadcastBallState(this.io);
            SoccerService.broadcastPlayerStates(this.io);
            return;
          } else {
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

      const timeoutKey = `lurking_${data.playerId}`;
      const timeout = setTimeout(() => {
        if (SoccerService.lurkingPlayers.has(data.playerId)) {
          SoccerService.lurkingPlayers.delete(data.playerId);
          this.io.to("scene:SoccerMap").emit("soccer:skillEnded", {
            activatorId: data.playerId,
            skillId: skillId,
          });
        }
        SoccerService.skillTimeouts.delete(timeoutKey);
      }, skillConfig.durationMs);

      SoccerService.skillTimeouts.set(timeoutKey, timeout);
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
      const activatorState = playerPositions.get(data.playerId);

      if (!activatorPhysics || !activatorState) {
        return;
      }

      const ball = SoccerService.ballState;
      const distToBall = Math.sqrt(
        Math.pow(ball.x - activatorPhysics.x, 2) +
          Math.pow(ball.y - activatorPhysics.y, 2),
      );

      if (distToBall > 200) {
        return;
      }

      let goalX: number;
      const goalY = 800;

      if (activatorState.team === "red") {
        goalX = 3400;
      } else if (activatorState.team === "blue") {
        goalX = 120;
      } else {
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

        return;
      }
    }

    if (isSpeedEffect(skillConfig.serverEffect.params)) {
      const multiplier = skillConfig.serverEffect.params.multiplier;

      for (const [playerId, pState] of playerPositions.entries()) {
        if (pState.currentScene !== "SoccerMap" || playerId === data.playerId) {
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

    const timeoutKey = `skill_${data.playerId}_${skillId}`;
    const timeout = setTimeout(() => {
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

      SoccerService.skillTimeouts.delete(timeoutKey);
    }, skillConfig.durationMs);

    SoccerService.skillTimeouts.set(timeoutKey, timeout);
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
    const playerId = this.socket.id;

    if (SoccerService.ballState.lastTouchId === playerId) {
      SoccerService.ballState.lastTouchId = null;
    }

    SoccerService.playerSkillCooldowns.delete(playerId);
    SoccerService.slowedPlayers.delete(playerId);
    SoccerService.metavisionPlayers.delete(playerId);
    SoccerService.ninjaStepPlayers.delete(playerId);
    SoccerService.lurkingPlayers.delete(playerId);
    SoccerService.playerBuffs.delete(playerId);
    SoccerService.playerMatchStats.delete(playerId);
    SoccerService.playerAssignedSkills.delete(playerId);
    SoccerService.midGamePickers.delete(playerId);

    const keysToDelete: string[] = [];
    for (const key of SoccerService.skillTimeouts.keys()) {
      if (key.includes(playerId)) {
        keysToDelete.push(key);
      }
    }
    for (const key of keysToDelete) {
      const timeout = SoccerService.skillTimeouts.get(key);
      if (timeout) {
        clearTimeout(timeout);
      }
      SoccerService.skillTimeouts.delete(key);
    }

    if (
      SoccerService.activeConnections === 0 &&
      SoccerService.physicsLoopRunning
    ) {
      SoccerService.physicsLoopRunning = false;
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

  private static loadMapCollisions() {
    try {
      const collisionDataPath = path.join(
        __dirname,
        "../../data/soccer-collisions.json",
      );

      if (!fs.existsSync(collisionDataPath)) {
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

  public static removePlayerPhysics(playerId: string) {
    this.playerPhysics.delete(playerId);
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
    return null;
  }

  public static broadcastInitialPhysicsState(socketId: string) {
    if (!this.ioInstance) {
      return;
    }

    const updates: Array<{
      id: string;
      x: number;
      y: number;
      vx: number;
      vy: number;
      timestamp: number;
    }> = [];

    const timestamp = Date.now();

    for (const [id, player] of this.playerPhysics.entries()) {
      updates.push({
        id,
        x: player.x,
        y: player.y,
        vx: player.vx,
        vy: player.vy,
        timestamp,
      });
    }

    if (updates.length > 0) {
      this.ioInstance.to(socketId).emit("players:physicsUpdate", updates);
    }
  }

  public static resetBall(withDelay: boolean = true) {
    if (withDelay) {
      this.goalScoredAt = Date.now();
    } else {
      this.resetBallImmediate();
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
    const playerState = playerPositions.get(playerId);

    if (!playerState) return;

    let targetX: number;
    let targetY: number;

    if (team === "spectator") {
      targetX = this.SPECTATOR_SPAWN.x;
      targetY = this.SPECTATOR_SPAWN.y;
    } else {
      const spawns =
        team === "red" ? this.RED_TEAM_SPAWNS : this.BLUE_TEAM_SPAWNS;

      const teamPlayers = Array.from(playerPositions.values()).filter(
        (p) => p.team === team && p.currentScene === "SoccerMap",
      );
      const spawnIndex = Math.min(teamPlayers.length - 1, spawns.length - 1);
      const spawn = spawns[Math.max(0, spawnIndex)] || spawns[0]!;
      targetX = spawn.x;
      targetY = spawn.y;
    }

    this.setPlayerPosition(playerId, targetX, targetY);
  }
}
