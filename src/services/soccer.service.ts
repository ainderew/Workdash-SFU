import { Socket, Server } from "socket.io";
import { GameEventEnums } from "./_enums.js";
import type {
  BallState,
  BallKickData,
  BallDribbleData,
  PlayerState,
} from "./_types.js";
import { getPlayerPositions } from "./game.service.js";
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

export class SoccerService {
  private socket: Socket;
  private io: Server;

  /**
   * Singleton on purpose do not change please
   */
  private static ballState: BallState = {
    x: 1760,
    y: 800,
    vx: 0,
    vy: 0,
    lastTouchId: null,
    lastTouchTimestamp: 0,
    isMoving: false,
  };

  // exponential drag v(t) = v0 * e^(-DRAG * t)
  // DRAG = 1.5 gives ~2-3 second ball roll from full power kick (1000 px/s)
  private static readonly DRAG = 1;
  private static readonly BOUNCE = 0.7; // Energy retention on wall bounce
  private static readonly BALL_RADIUS = 30; // Pixels
  private static readonly UPDATE_INTERVAL_MS = 16.6; // 50Hz update rate
  private static readonly VELOCITY_THRESHOLD = 10; // Stop when speed < 10 px/s
  private static readonly WORLD_BOUNDS = { width: 3520, height: 1600 };
  private static readonly KICK_COOLDOWN_MS = 500; // Prevent spam
  private static readonly MAX_DRIBBLE_DISTANCE = 300; // Max distance for dribble

  private static readonly PLAYER_RADIUS = 30;
  private static readonly PLAYER_MASS = 1.5;
  private static readonly PUSH_DAMPING = 1.5;
  private static readonly BALL_KNOCKBACK = 0.6;
  private static readonly KICK_KNOCKBACK = 400;

  // Update loop management
  private static updateInterval: NodeJS.Timeout | null = null;
  private static activeConnections = 0;
  private static lastKickTime = 0;

  private static collisionRects: CollisionRect[] = [];
  private static mapLoaded = false;

  private static playerPhysics: Map<string, PlayerPhysicsState> = new Map();
  private static ioInstance: Server | null = null;

  private static goalZones: GoalZone[] = [];
  private static goalsLoaded = false;
  private static score = { red: 0, blue: 0 };
  private static hasScoredGoal = false;

  // Team spawn positions
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
      (data: { playerId: string; team: "red" | "blue" | null }) => {
        this.handleTeamAssignment(data);
      },
    );

    this.socket.on("soccer:resetGame", () => {
      this.handleResetGame();
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

    if (now - SoccerService.lastKickTime < SoccerService.KICK_COOLDOWN_MS) {
      return;
    }

    SoccerService.lastKickTime = now;

    const ballState = SoccerService.ballState;

    const kickerPhysics = SoccerService.playerPhysics.get(data.playerId);
    const kickPowerStat = kickerPhysics?.soccerStats?.kickPower ?? 0;
    const kickPowerMultiplier = 1.0 + kickPowerStat * 0.1;
    const kickVx = Math.cos(data.angle) * data.kickPower * kickPowerMultiplier;
    const kickVy = Math.sin(data.angle) * data.kickPower * kickPowerMultiplier;

    ballState.vx = kickVx;
    ballState.vy = kickVy;
    ballState.lastTouchId = data.playerId;
    ballState.lastTouchTimestamp = now;
    ballState.isMoving = true;

    if (kickerPhysics) {
      const knockbackVx = -Math.cos(data.angle) * SoccerService.KICK_KNOCKBACK;
      const knockbackVy = -Math.sin(data.angle) * SoccerService.KICK_KNOCKBACK;
      kickerPhysics.vx += knockbackVx;
      kickerPhysics.vy += knockbackVy;
      console.log(
        `Applied kick knockback to ${data.playerId}: (${knockbackVx.toFixed(0)}, ${knockbackVy.toFixed(0)})`,
      );
    }

    console.log(
      `Ball kicked by ${data.playerId}: power=${data.kickPower}, angle=${data.angle}`,
    );

    this.io.to("scene:SoccerMap").emit(GameEventEnums.BALL_KICKED, {
      kickerId: data.playerId,
      kickPower: data.kickPower,
      ballX: ballState.x,
      ballY: ballState.y,
    });

    this.broadcastBallState();
  }

  private handleBallDribble(data: BallDribbleData) {
    // Prevent dribble from overriding recent kicks (100ms cooldown)
    const now = Date.now();
    const timeSinceLastKick = now - SoccerService.lastKickTime;
    if (timeSinceLastKick < 100) {
      // Kick takes priority - ignore dribble events for 100ms after a kick
      return;
    }

    const ballState = SoccerService.ballState;

    // Calculate distance from player to ball
    const dx = ballState.x - data.playerX;
    const dy = ballState.y - data.playerY;
    const distance = Math.sqrt(dx * dx + dy * dy);

    if (distance > SoccerService.MAX_DRIBBLE_DISTANCE) {
      return;
    }

    const dribblePower = 300;
    const angle = Math.atan2(dy, dx);

    ballState.vx = Math.cos(angle) * dribblePower;
    ballState.vy = Math.sin(angle) * dribblePower;
    ballState.lastTouchId = data.playerId;
    ballState.lastTouchTimestamp = Date.now();
    ballState.isMoving = true;

    console.log(`Ball dribbled by ${data.playerId}`);
    this.broadcastBallState();
  }

  private static startPhysicsLoop(io: Server) {
    console.log("Starting soccer ball physics loop at 50Hz");
    this.updateInterval = setInterval(() => {
      this.updateBallPhysics(io);
    }, this.UPDATE_INTERVAL_MS);
  }

  private static updateBallPhysics(io: Server) {
    const ball = this.ballState;
    const dt = this.UPDATE_INTERVAL_MS / 1000;
    if (ball.isMoving) {
      const dragFactor = Math.exp(-this.DRAG * dt);
      ball.vx *= dragFactor;
      ball.vy *= dragFactor;

      ball.x += ball.vx * dt;
      ball.y += ball.vy * dt;

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

      // Check goal collisions (before boundary collision)
      for (const goal of this.goalZones) {
        if (this.checkBallGoalCollision(ball, goal) && !this.hasScoredGoal) {
          // Goal scored!
          const scoringTeam = goal.team === "red" ? "blue" : "red"; // Opposite team scores
          this.score[scoringTeam]++;

          console.log(
            `GOAL! ${scoringTeam.toUpperCase()} team scored! Score: Red ${this.score.red} - Blue ${this.score.blue}`,
          );

          // Broadcast goal event
          io.to("scene:SoccerMap").emit("goal:scored", {
            scoringTeam,
            goalName: goal.name,
            lastTouchId: ball.lastTouchId,
            score: {
              red: this.score.red,
              blue: this.score.blue,
            },
          });

          // Reset ball to center (with delay)
          this.resetBall();

          // Reset all player positions to their team spawns (with same delay)
          this.resetAllPlayerPositions();

          // Broadcast new ball state immediately
          this.broadcastBallState(io);

          // Exit physics loop for this frame (ball has been reset)
          return;
        }
      }

      // Boundary collision with bounce
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

      // Stop if velocity too low
      const speed = Math.sqrt(ball.vx * ball.vx + ball.vy * ball.vy);
      if (speed < this.VELOCITY_THRESHOLD) {
        ball.vx = 0;
        ball.vy = 0;
        ball.isMoving = false;
        console.log("Ball stopped moving");
      }
    }

    // Update player physics (always runs, even when ball is stationary)
    this.updatePlayerPhysics(io, dt);

    // Broadcast both ball and player states
    SoccerService.broadcastBallState(io);
    SoccerService.broadcastPlayerStates(io);
  }

  private static broadcastBallState(io: Server) {
    io.to("scene:SoccerMap").emit(GameEventEnums.BALL_STATE, {
      x: Math.round(this.ballState.x),
      y: Math.round(this.ballState.y),
      vx: Math.round(this.ballState.vx),
      vy: Math.round(this.ballState.vy),
      lastTouchId: this.ballState.lastTouchId,
      timestamp: Date.now(),
    });
  }

  private static updatePlayerPhysics(io: Server, deltaTime: number) {
    const players = Array.from(this.playerPhysics.values());

    /**
     *player collision
     */
    for (let i = 0; i < players.length; i++) {
      for (let j = i + 1; j < players.length; j++) {
        const p1 = players[i];
        const p2 = players[j];

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
     * Ball to player collision
     * knockback stuff I clamped the distance so it wono't be weird to look at front end
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
    for (const player of players) {
      player.x += player.vx * deltaTime;
      player.y += player.vy * deltaTime;
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

  private static handlePlayerCollision(
    p1: PlayerPhysicsState,
    p2: PlayerPhysicsState,
    dx: number,
    dy: number,
    distance: number,
  ) {
    // Normalize collision normal
    const nx = dx / distance;
    const ny = dy / distance;

    // Separate players (push apart)
    const overlap = p1.radius + p2.radius - distance;
    const separationX = nx * (overlap / 2);
    const separationY = ny * (overlap / 2);

    p1.x -= separationX;
    p1.y -= separationY;
    p2.x += separationX;
    p2.y += separationY;

    const pushForce = this.PUSH_DAMPING * 100; // Scale up for visibility
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

    if (ballSpeed < 100) return; // Only knockback if ball is fast

    // Normalize direction (from ball to player)
    const nx = -dx / distance;
    const ny = -dy / distance;

    // Apply knockback proportional to ball speed
    const knockbackMagnitude = Math.min(ballSpeed * this.BALL_KNOCKBACK, 200);
    player.vx += nx * knockbackMagnitude;
    player.vy += ny * knockbackMagnitude;

    console.log(
      `Player ${player.id} knocked back by ball (${ballSpeed.toFixed(0)} px/s)`,
    );
  }

  private static broadcastPlayerStates(io: Server) {
    const updates: any[] = [];

    for (const [id, player] of this.playerPhysics.entries()) {
      updates.push({
        id,
        x: player.x, // No rounding - preserve precision
        y: player.y,
        vx: player.vx, // No rounding for velocities
        vy: player.vy,
      });
    }

    if (updates.length > 0) {
      io.to("scene:SoccerMap").emit("players:physicsUpdate", updates);
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

    // Normalize collision normal (from player to ball)
    const nx = dx / distance;
    const ny = dy / distance;

    // Calculate reflection (v' = v - 2(v · n)n)
    const dotProduct = ball.vx * nx + ball.vy * ny;
    ball.vx = ball.vx - 2 * dotProduct * nx;
    ball.vy = ball.vy - 2 * dotProduct * ny;

    // Apply bounce damping (60% velocity retained)
    const bounceDamping = 0.6;
    ball.vx *= bounceDamping;
    ball.vy *= bounceDamping;

    // Push ball outside collision (prevent sticking)
    const ballRadius = this.BALL_RADIUS;
    const overlap = ballRadius + playerRadius - distance;
    ball.x += nx * (overlap + 1);
    ball.y += ny * (overlap + 1);

    // Update ball ownership
    ball.lastTouchId = playerId;
    ball.lastTouchTimestamp = Date.now();

    const speed = Math.sqrt(ball.vx * ball.vx + ball.vy * ball.vy);
    console.log(
      `Ball intercepted by ${playerId}, bounced at ${speed.toFixed(0)}px/s`,
    );

    // Emit interception event for client-side effects
    io.to("scene:SoccerMap").emit("ball:intercepted", {
      playerId,
      ballX: ball.x,
      ballY: ball.y,
    });
  }

  private broadcastBallState() {
    SoccerService.broadcastBallState(this.io);
  }

  private handleTeamAssignment(data: {
    playerId: string;
    team: "red" | "blue" | null;
  }) {
    const playerPositions = getPlayerPositions();
    const playerState = playerPositions.get(data.playerId);

    if (playerState && playerState.currentScene === "SoccerMap") {
      playerState.team = data.team;
      playerPositions.set(data.playerId, playerState);

      // Reset player position to their team spawn
      if (data.team) {
        SoccerService.resetPlayerPosition(data.playerId, data.team);
      }

      // Broadcast team assignment to all players in SoccerMap
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
    // Reset score
    SoccerService.score = { red: 0, blue: 0 };

    // Reset ball position
    SoccerService.resetBall();

    // Reset all player positions to their team spawns
    SoccerService.resetAllPlayerPositions();

    // Broadcast reset to all players
    this.io.to("scene:SoccerMap").emit("soccer:gameReset", {
      score: SoccerService.score,
    });

    console.log("Soccer game reset - score: 0-0");
  }

  private handleGetPlayers(callback: (players: any[]) => void) {
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

    // Clear ownership if this player was last to touch
    if (SoccerService.ballState.lastTouchId === this.socket.id) {
      SoccerService.ballState.lastTouchId = null;
      console.log(`Ball ownership cleared for ${this.socket.id}`);
    }

    // Stop physics loop if no connections
    if (SoccerService.activeConnections === 0 && SoccerService.updateInterval) {
      clearInterval(SoccerService.updateInterval);
      SoccerService.updateInterval = null;
      console.log("Stopped soccer ball physics loop (no active connections)");
    }
  }

  // Check if ball (circle) collides with rectangle and calculate bounce
  private static checkBallRectCollision(
    ball: BallState,
    rect: CollisionRect,
  ): { collides: boolean; normal: { x: number; y: number } } | null {
    const ballRadius = this.BALL_RADIUS;

    // Find closest point on rectangle to ball center
    const closestX = Math.max(rect.x, Math.min(ball.x, rect.x + rect.width));
    const closestY = Math.max(rect.y, Math.min(ball.y, rect.y + rect.height));

    // Calculate distance from ball center to closest point
    const dx = ball.x - closestX;
    const dy = ball.y - closestY;
    const distance = Math.sqrt(dx * dx + dy * dy);

    if (distance < ballRadius) {
      // Collision detected - calculate normal vector
      let nx = dx;
      let ny = dy;

      // If ball center is inside rectangle, use edge-based normal
      if (distance === 0) {
        // Ball center exactly on rectangle - use closest edge
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
        // Normalize the vector
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

  // Check if ball (circle) is inside goal zone (rectangle)
  private static checkBallGoalCollision(
    ball: BallState,
    goal: GoalZone,
  ): boolean {
    // Check if ball center is inside the goal rectangle
    // (Using ball center rather than edges for cleaner goal detection)
    return (
      ball.x >= goal.x &&
      ball.x <= goal.x + goal.width &&
      ball.y >= goal.y &&
      ball.y <= goal.y + goal.height
    );
  }

  // Load collision objects from static collision data file
  private static loadMapCollisions() {
    try {
      // Path to collision data file in backend project
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

      // Store collision rectangles
      this.collisionRects = collisionData.collisions.map((obj: any) => ({
        x: obj.x,
        y: obj.y,
        width: obj.width,
        height: obj.height,
      }));

      console.log(
        `Loaded ${this.collisionRects.length} collision objects for SoccerMap`,
      );
      this.mapLoaded = true;
    } catch (error) {
      console.error("Failed to load soccer collision data:", error);
      this.mapLoaded = true; // Prevent retry spam
    }
  }

  // Load goal zones from static data file
  private static loadGoalZones() {
    try {
      // Path to goal data file in backend project
      const goalDataPath = path.join(__dirname, "../../data/soccer-goals.json");

      if (!fs.existsSync(goalDataPath)) {
        console.error("Soccer goal data file not found:", goalDataPath);
        console.error("Create this file with goal zones from your Tiled map");
        this.goalsLoaded = true;
        return;
      }

      const goalData = JSON.parse(fs.readFileSync(goalDataPath, "utf-8"));

      if (!goalData.goals || !Array.isArray(goalData.goals)) {
        console.error("Invalid goal data format");
        this.goalsLoaded = true;
        return;
      }

      // Store goal zones
      this.goalZones = goalData.goals.map((obj: any) => ({
        name: obj.name,
        team: obj.team,
        x: obj.x,
        y: obj.y,
        width: obj.width,
        height: obj.height,
      }));

      console.log(`Loaded ${this.goalZones.length} goal zones for SoccerMap`);
      this.goalsLoaded = true;
    } catch (error) {
      console.error("Failed to load soccer goal data:", error);
      this.goalsLoaded = true; // Prevent retry spam
    }
  }

  // Method to update player physics state (called from game.service.ts)
  public static updatePlayerPhysicsState(
    playerId: string,
    state: {
      x: number;
      y: number;
      vx: number;
      vy: number;
      radius: number;
      soccerStats?: {
        speed: number;
        kickPower: number;
        dribbling: number;
      } | null;
    },
  ) {
    this.playerPhysics.set(playerId, {
      id: playerId,
      ...state,
    });
  }

  // Method to remove player from physics tracking
  public static removePlayerPhysics(playerId: string) {
    this.playerPhysics.delete(playerId);
  }

  // Broadcast current physics state to a specific player (for joins)
  public static broadcastInitialPhysicsState(socketId: string) {
    if (!this.ioInstance) {
      console.error(
        "Cannot broadcast initial physics: io instance not available",
      );
      return;
    }

    const updates: any[] = [];

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
      this.ioInstance.to(socketId).emit("players:physicsUpdate", updates);
      console.log(
        `Sent initial physics state (${updates.length} players) to ${socketId}`,
      );
    }
  }

  public static resetBall() {
    this.hasScoredGoal = true;
    setTimeout(() => {
      this.ballState = {
        x: this.WORLD_BOUNDS.width / 2,
        y: this.WORLD_BOUNDS.height / 2,
        vx: 0,
        vy: 0,
        lastTouchId: null,
        lastTouchTimestamp: 0,
        isMoving: false,
      };

      this.hasScoredGoal = false;
      console.log("Ball reset to center");
    }, 3000);
  }

  public static getScore() {
    return { ...this.score };
  }

  // Reset a single player to their team spawn position
  private static resetPlayerPosition(playerId: string, team: "red" | "blue") {
    const playerPositions = getPlayerPositions();
    const playerPhysics = this.playerPhysics.get(playerId);
    const playerState = playerPositions.get(playerId);

    if (!playerState || !playerPhysics) return;

    // Get team spawns
    const spawns =
      team === "red" ? this.RED_TEAM_SPAWNS : this.BLUE_TEAM_SPAWNS;

    // Count how many players are already on this team
    const teamPlayers = Array.from(playerPositions.values()).filter(
      (p) => p.team === team && p.currentScene === "SoccerMap",
    );
    const spawnIndex = Math.min(teamPlayers.length - 1, spawns.length - 1);
    const spawn = spawns[spawnIndex] || spawns[0];

    // Update physics position
    playerPhysics.x = spawn.x;
    playerPhysics.y = spawn.y;
    playerPhysics.vx = 0;
    playerPhysics.vy = 0;

    // Update player state position
    playerState.x = spawn!.x;
    playerState.y = spawn!.y;
    playerState.vx = 0;
    playerState.vy = 0;

    playerPositions.set(playerId, playerState);

    // Broadcast position update
    if (this.ioInstance) {
      this.ioInstance.to("scene:SoccerMap").emit("soccer:playerReset", {
        playerId,
        x: spawn!.x,
        y: spawn!.y,
      });
    }

    console.log(
      `Reset ${playerState.name} to ${team} team spawn: (${spawn!.x}, ${spawn!.y})`,
    );
  }

  // Reset all players to their team spawn positions
  private static resetAllPlayerPositions() {
    setTimeout(() => {
      const playerPositions = getPlayerPositions();
      const redTeamPlayers: string[] = [];
      const blueTeamPlayers: string[] = [];

      // Categorize players by team
      for (const [playerId, player] of playerPositions.entries()) {
        if (player.currentScene !== "SoccerMap") continue;

        if (player.team === "red") {
          redTeamPlayers.push(playerId);
        } else if (player.team === "blue") {
          blueTeamPlayers.push(playerId);
        }
      }

      // Reset red team players
      redTeamPlayers.forEach((playerId, index) => {
        const spawn = this.RED_TEAM_SPAWNS[index % this.RED_TEAM_SPAWNS.length];
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

      // Reset blue team players
      blueTeamPlayers.forEach((playerId, index) => {
        const spawn =
          this.BLUE_TEAM_SPAWNS[index % this.BLUE_TEAM_SPAWNS.length];
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
    }, 3000);
  }
}
