import { Socket } from "socket.io";
import { GameEventEnums } from "./_enums.js";
import type {
  PlayerState,
  PlayerMovementData,
  PlayerActionData,
} from "./_types.js";
import { CharacterRepository } from "../repositories/character/character.repository.js";
import { SoccerStatsRepository } from "../repositories/soccer-stats/soccer-stats.repository.js";
import type { CharacterUpdateInput } from "@/generated/prisma/models.js";
import type { User } from "../index.js";
import { SoccerService } from "./soccer.service.js";

// In-memory player positions (Shared across all socket instances)
const playerPositions: Map<string, PlayerState> = new Map();

export function getPlayerPositions(): Map<string, PlayerState> {
  return playerPositions;
}

export class GameService {
  private socket: Socket;
  private userId: number;
  private characterRepository: CharacterRepository;
  private soccerStatsRepository: SoccerStatsRepository;
  private lastMovementTime: number = 0;

  // Max 20 updates/sec.
  private readonly MOVEMENT_THROTTLE_MS = 50;

  constructor(socket: Socket, userId: number) {
    this.socket = socket;
    this.userId = userId;
    this.characterRepository = new CharacterRepository();
    this.soccerStatsRepository = new SoccerStatsRepository();
  }

  listenForGameEvents(userMap: Record<string, User>) {
    console.log(
      "GameService: Listening for game events for socket",
      this.socket.id,
    );

    this.socket.on(
      "playerJoin",
      (data: { x: number; y: number; scene?: string }) => {
        this.handlePlayerJoin(data, userMap);
      },
    );

    // NEW: Listen for raw inputs (WASD) for Physics maps
    this.socket.on(
      "playerInput",
      (input: {
        up: boolean;
        down: boolean;
        left: boolean;
        right: boolean;
      }) => {
        this.handlePlayerInput(input);
      },
    );

    // Legacy: Keep this for non-physics maps (like MainMap)
    this.socket.on("playerMovement", (data: PlayerMovementData) => {
      this.handlePlayerMovement(data);
    });

    this.socket.on(GameEventEnums.PLAYER_ACTION, (data: PlayerActionData) => {
      this.handlePlayerAction(data);
    });

    this.socket.on(
      GameEventEnums.PLAYER_UPDATE_CHARACTER,
      async (data: CharacterUpdateInput) => {
        await this.handleCharacterUpdate(data, userMap);
      },
    );

    this.socket.on(
      GameEventEnums.PLAYER_UPDATE_NAME,
      async (data: { name: string }) => {
        await this.handleNameUpdate(data, userMap);
      },
    );

    this.socket.on(
      GameEventEnums.SCENE_CHANGE,
      async (data: { newScene: string; x: number; y: number }) => {
        await this.handleSceneChange(data);
      },
    );

    this.socket.on("disconnect", () => {
      this.handlePlayerDisconnect();
    });
  }

  // ==========================================
  // NEW: HANDLE INPUT FOR PHYSICS (SLIDING)
  // ==========================================
  private handlePlayerInput(input: {
    up: boolean;
    down: boolean;
    left: boolean;
    right: boolean;
  }) {
    const playerState = playerPositions.get(this.socket.id);
    if (!playerState || playerState.currentScene !== "SoccerMap") return;

    // 1. Get Physics State (This is where VX/VY live)
    // Note: You must make `playerPhysics` public static in SoccerService
    // or add a getter method like `SoccerService.getPlayerPhysics(id)`
    const physics = SoccerService["playerPhysics"].get(this.socket.id);

    if (physics) {
      // Apply speed stat multiplier (1 point = 0.1x boost, range 1.0x-2.5x)
      const speedStat = physics.soccerStats?.speed ?? 0;
      let speedMultiplier = 1.0 + speedStat * 0.1;

      // Apply slow skill multiplier if player is slowed
      if (SoccerService.isPlayerSlowed(this.socket.id)) {
        speedMultiplier *= SoccerService.getSlowMultiplier();
      }

      const ACCEL = 1600 * speedMultiplier; // Acceleration Force with stat multiplier
      const MAX_SPEED = 600 * speedMultiplier; // Speed Limit with stat multiplier

      // 2. Apply Force (Add to velocity)
      if (input.up) physics.vy -= ACCEL;
      if (input.down) physics.vy += ACCEL;
      if (input.left) physics.vx -= ACCEL;
      if (input.right) physics.vx += ACCEL;

      // 3. Clamp Velocity (Don't go faster than MAX_SPEED)
      const speed = Math.sqrt(
        physics.vx * physics.vx + physics.vy * physics.vy,
      );
      if (speed > MAX_SPEED) {
        const scale = MAX_SPEED / speed;
        physics.vx *= scale;
        physics.vy *= scale;
      }
    }
  }

  // ==========================================
  // EXISTING METHODS
  // ==========================================

  private handlePlayerAction(data: PlayerActionData) {
    const playerState = playerPositions.get(this.socket.id);
    if (!playerState) return;

    if (data.action === "attack") {
      playerState.isAttacking = true;
      playerPositions.set(this.socket.id, playerState);
    }

    this.socket.to(`scene:${playerState.currentScene}`).emit("playerAction", {
      playerId: this.socket.id,
      action: data.action,
    });
  }

  private async handlePlayerJoin(
    data: { x: number; y: number; scene?: string },
    userMap: Record<string, User>,
  ) {
    const user = userMap[this.socket.id];
    if (!user) {
      console.error("User not found in userMap for socket:", this.socket.id);
      return;
    }

    const sceneName = data.scene || "MainMap";

    // Load soccer stats if joining SoccerMap
    let soccerStats: PlayerState["soccerStats"] = null;
    if (sceneName === "SoccerMap") {
      try {
        const stats = await this.soccerStatsRepository.findByUserId(
          this.userId,
        );
        if (stats) {
          soccerStats = {
            speed: stats.speed,
            kickPower: stats.kickPower,
            dribbling: stats.dribbling,
            mmr: stats.mmr,
            winStreak: stats.winStreak,
          };
          console.log(
            `Loaded soccer stats for user ${this.userId}:`,
            soccerStats,
          );
        } else {
          console.log(
            `No soccer stats found for user ${this.userId} - will trigger modal`,
          );
        }
      } catch (error) {
        console.error("Failed to load soccer stats:", error);
      }
    }

    const playerState: PlayerState = {
      id: this.socket.id,
      userId: user.userId,
      name: user.name,
      x: data.x,
      y: data.y,
      vx: 0,
      vy: 0,
      isAttacking: false,
      character: user.character,
      currentScene: sceneName,
      soccerStats: soccerStats,
    };

    playerPositions.set(this.socket.id, playerState);
    this.socket.join(`scene:${sceneName}`);

    // If joining SoccerMap, initialize physics with stats
    if (sceneName === "SoccerMap") {
      SoccerService.updatePlayerPhysicsState(this.socket.id, {
        x: data.x,
        y: data.y,
        vx: 0,
        vy: 0,
        radius: 30,
        soccerStats: soccerStats,
      });
      SoccerService.broadcastInitialPhysicsState(this.socket.id);
    }

    console.log(
      `Player joined: ${user.name} (${this.socket.id}) in ${sceneName}`,
    );

    const playersInScene = Array.from(playerPositions.values()).filter(
      (p) => p.currentScene === sceneName && p.id !== this.socket.id,
    );

    this.socket.emit("currentPlayers", playersInScene);
    this.socket.emit("newPlayer", playerState);
    this.socket.to(`scene:${sceneName}`).emit("newPlayer", playerState);
  }

  private handlePlayerMovement(data: PlayerMovementData) {
    const now = Date.now();
    if (now - this.lastMovementTime < this.MOVEMENT_THROTTLE_MS) return;
    this.lastMovementTime = now;

    const playerState = playerPositions.get(this.socket.id);
    if (!playerState) return;

    if (playerState.currentScene === "SoccerMap") {
      return;
    }

    // Normal logic for non-physics maps
    playerState.x = data.x;
    playerState.y = data.y;
    playerState.vx = data.vx;
    playerState.vy = data.vy;
    if (data.isAttacking !== undefined)
      playerState.isAttacking = data.isAttacking;
    if (data.currentScene && data.currentScene !== playerState.currentScene)
      playerState.currentScene = data.currentScene;

    playerPositions.set(this.socket.id, playerState);

    this.socket.to(`scene:${playerState.currentScene}`).emit("playerMoved", {
      id: this.socket.id,
      ...data,
    });
  }

  private async handleCharacterUpdate(
    data: CharacterUpdateInput,
    userMap: Record<string, User>,
  ) {
    try {
      const updatedCharacter = await this.characterRepository.update(
        this.userId,
        data,
      );
      const user = userMap[this.socket.id];
      if (user) user.character = updatedCharacter;

      const playerState = playerPositions.get(this.socket.id);
      if (playerState) {
        playerState.character = updatedCharacter;
        playerPositions.set(this.socket.id, playerState);
      }

      this.socket.broadcast.emit(GameEventEnums.RESPONSE_CHARACTER_UPDATED, {
        playerId: this.socket.id,
        character: updatedCharacter,
      });
      this.socket.emit(GameEventEnums.RESPONSE_CHARACTER_UPDATED, {
        playerId: this.socket.id,
        character: updatedCharacter,
      });
    } catch (error) {
      console.error("Failed to update character:", error);
    }
  }

  private async handleNameUpdate(
    data: { name: string },
    userMap: Record<string, User>,
  ) {
    try {
      const newName = data.name.trim();
      if (!newName) return;

      const user = userMap[this.socket.id];
      if (user) user.name = newName;

      const playerState = playerPositions.get(this.socket.id);
      if (playerState) {
        playerState.name = newName;
        playerPositions.set(this.socket.id, playerState);
      }

      this.socket.broadcast.emit("nameUpdated", {
        playerId: this.socket.id,
        name: newName,
      });
    } catch (error) {
      console.error("Failed to handle name update:", error);
    }
  }

  private async handleSceneChange(data: {
    newScene: string;
    x: number;
    y: number;
  }) {
    const player = playerPositions.get(this.socket.id);
    if (!player) return;

    const oldScene = player.currentScene;
    const newScene = data.newScene;

    this.socket.leave(`scene:${oldScene}`);
    this.socket.to(`scene:${oldScene}`).emit("deletePlayer", {
      id: this.socket.id,
    });

    if (oldScene === "SoccerMap") {
      SoccerService.removePlayerPhysics(this.socket.id);
    }

    player.currentScene = newScene;
    player.x = data.x;
    player.y = data.y;

    if (newScene === "SoccerMap") {
      try {
        const stats = await this.soccerStatsRepository.findByUserId(
          this.userId,
        );
        if (stats) {
          player.soccerStats = {
            speed: stats.speed,
            kickPower: stats.kickPower,
            dribbling: stats.dribbling,
            mmr: stats.mmr,
            winStreak: stats.winStreak,
          };
        }
      } catch (error) {
        console.error("Failed to load soccer stats on scene change:", error);
      }

      SoccerService.updatePlayerPhysicsState(this.socket.id, {
        x: data.x,
        y: data.y,
        vx: 0,
        vy: 0,
        radius: 30,
        soccerStats: player.soccerStats ?? null,
      });
    }

    playerPositions.set(this.socket.id, player);

    this.socket.join(`scene:${newScene}`);

    const playersInScene = Array.from(playerPositions.values()).filter(
      (p) => p.currentScene === newScene && p.id !== this.socket.id,
    );

    this.socket.emit("currentPlayers", playersInScene);
    this.socket.to(`scene:${newScene}`).emit("newPlayer", player);
  }

  private handlePlayerDisconnect() {
    const player = playerPositions.get(this.socket.id);
    if (player) {
      const sceneName = player.currentScene;
      playerPositions.delete(this.socket.id);

      if (sceneName === "SoccerMap") {
        SoccerService.removePlayerPhysics(this.socket.id);
      }

      this.socket.to(`scene:${sceneName}`).emit("deletePlayer", {
        id: this.socket.id,
      });
    }
  }
}
