import { Socket, Server } from "socket.io";
import { GameEventEnums } from "./_enums.js";
import type { BallState, BallKickData, BallDribbleData } from "./_types.js";

export class SoccerService {
  private socket: Socket;
  private io: Server;

  // Shared ball state (singleton across all instances)
  private static ballState: BallState = {
    x: 1760, // center of soccer map (3520/2)
    y: 800, // center of soccer map (1600/2)
    vx: 0,
    vy: 0,
    lastTouchId: null,
    lastTouchTimestamp: 0,
    isMoving: false,
  };

  // Physics constants matching frontend
  private static readonly DRAG = 50;
  private static readonly BOUNCE = 0.7;
  private static readonly BALL_RADIUS = 30;
  private static readonly UPDATE_INTERVAL_MS = 20; // 50Hz
  private static readonly VELOCITY_THRESHOLD = 5; // Stop threshold
  private static readonly WORLD_BOUNDS = { width: 3520, height: 1600 };
  private static readonly KICK_COOLDOWN_MS = 100; // Prevent spam
  private static readonly MAX_DRIBBLE_DISTANCE = 100; // Max distance for dribble

  // Update loop management
  private static updateInterval: NodeJS.Timeout | null = null;
  private static activeConnections = 0;
  private static lastKickTime = 0;

  constructor(socket: Socket, io: Server) {
    this.socket = socket;
    this.io = io;
    SoccerService.activeConnections++;

    // Start update loop if not running
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

    this.socket.on("disconnect", () => {
      this.cleanup();
    });
  }

  private handleBallKick(data: BallKickData) {
    const now = Date.now();

    // Prevent rapid-fire kicks
    if (now - SoccerService.lastKickTime < SoccerService.KICK_COOLDOWN_MS) {
      console.log("Kick ignored: cooldown active");
      return;
    }

    SoccerService.lastKickTime = now;

    const ballState = SoccerService.ballState;

    // Calculate new velocity from kick
    const kickVx = Math.cos(data.angle) * data.kickPower;
    const kickVy = Math.sin(data.angle) * data.kickPower;

    ballState.vx = kickVx;
    ballState.vy = kickVy;
    ballState.lastTouchId = data.playerId;
    ballState.lastTouchTimestamp = now;
    ballState.isMoving = true;

    console.log(
      `Ball kicked by ${data.playerId}: power=${data.kickPower}, angle=${data.angle}`,
    );

    // Broadcast kick event for animations
    this.io.to("scene:SoccerMap").emit(GameEventEnums.BALL_KICKED, {
      kickerId: data.playerId,
      kickPower: data.kickPower,
      ballX: ballState.x,
      ballY: ballState.y,
    });

    // Immediately broadcast new state
    this.broadcastBallState();
  }

  private handleBallDribble(data: BallDribbleData) {
    const ballState = SoccerService.ballState;

    // Calculate distance from player to ball
    const dx = ballState.x - data.playerX;
    const dy = ballState.y - data.playerY;
    const distance = Math.sqrt(dx * dx + dy * dy);

    // Validation: player must be close to ball
    if (distance > SoccerService.MAX_DRIBBLE_DISTANCE) {
      return; // Ignore invalid dribble
    }

    // Apply dribble force (gentler than kick)
    const dribblePower = 100;
    const angle = Math.atan2(dy, dx);

    ballState.vx = Math.cos(angle) * dribblePower;
    ballState.vy = Math.sin(angle) * dribblePower;
    ballState.lastTouchId = data.playerId;
    ballState.lastTouchTimestamp = Date.now();
    ballState.isMoving = true;

    console.log(`Ball dribbled by ${data.playerId}`);
  }

  private static startPhysicsLoop(io: Server) {
    console.log("Starting soccer ball physics loop at 50Hz");
    this.updateInterval = setInterval(() => {
      this.updateBallPhysics(io);
    }, this.UPDATE_INTERVAL_MS);
  }

  private static updateBallPhysics(io: Server) {
    const ball = this.ballState;

    if (!ball.isMoving) return;

    const dt = this.UPDATE_INTERVAL_MS / 1000; // Convert to seconds

    // Apply drag (friction)
    const dragFactor = Math.max(0, 1 - this.DRAG * dt);
    ball.vx *= dragFactor;
    ball.vy *= dragFactor;

    // Update position
    ball.x += ball.vx * dt;
    ball.y += ball.vy * dt;

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

    // Broadcast state to all clients in SoccerMap scene
    SoccerService.broadcastBallState(io);
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

  private broadcastBallState() {
    SoccerService.broadcastBallState(this.io);
  }

  private cleanup() {
    SoccerService.activeConnections--;

    // Clear ownership if this player was last to touch
    if (SoccerService.ballState.lastTouchId === this.socket.id) {
      SoccerService.ballState.lastTouchId = null;
      console.log(`Ball ownership cleared for ${this.socket.id}`);
    }

    // Stop physics loop if no connections
    if (
      SoccerService.activeConnections === 0 &&
      SoccerService.updateInterval
    ) {
      clearInterval(SoccerService.updateInterval);
      SoccerService.updateInterval = null;
      console.log("Stopped soccer ball physics loop (no active connections)");
    }
  }

  // Method to reset ball (e.g., after goal)
  public static resetBall() {
    this.ballState = {
      x: this.WORLD_BOUNDS.width / 2,
      y: this.WORLD_BOUNDS.height / 2,
      vx: 0,
      vy: 0,
      lastTouchId: null,
      lastTouchTimestamp: 0,
      isMoving: false,
    };
    console.log("Ball reset to center");
  }
}
