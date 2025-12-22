import { Socket } from "socket.io";
import { GameEventEnums } from "./_enums.js";
import type {
  User,
  PlayerState,
  PlayerMovementData,
  PlayerActionData,
  CharacterUpdateData,
} from "./_types.js";
import { CharacterRepository } from "../repositories/character/character.repository.js";

// In-memory player positions (Shared across all socket instances)
const playerPositions: Map<string, PlayerState> = new Map();

export class GameService {
  private socket: Socket;
  private userId: number;
  private characterRepository: CharacterRepository;
  private lastMovementTime: number = 0;
  private readonly MOVEMENT_THROTTLE_MS = 50; // Max 20 updates/sec

  constructor(socket: Socket, userId: number) {
    this.socket = socket;
    this.userId = userId;
    this.characterRepository = new CharacterRepository();
  }

  listenForGameEvents(userMap: Record<string, User>) {
    console.log(
      "GameService: Listening for game events for socket",
      this.socket.id,
    );

    this.socket.onAny((eventName, ...args) => {
      console.log(`[DEBUG] Received event: ${eventName}`);
    });

    // FIX: Listen for string "playerJoin" to match Multiplayer.joinGame()
    this.socket.on("playerJoin", (data: { x: number; y: number }) => {
      console.log("PLAYER HAS JOINED !!!!!");
      this.handlePlayerJoin(data, userMap);
    });

    // FIX: Listen for string "playerMovement"
    this.socket.on("playerMovement", (data: PlayerMovementData) => {
      this.handlePlayerMovement(data);
    });

    // Player Actions (attack, interact, emote)
    this.socket.on(GameEventEnums.PLAYER_ACTION, (data: PlayerActionData) => {
      this.handlePlayerAction(data);
    });

    // Character Customization Update
    this.socket.on(
      GameEventEnums.PLAYER_UPDATE_CHARACTER,
      async (data: CharacterUpdateData) => {
        await this.handleCharacterUpdate(data, userMap);
      },
    );

    // Clean up on disconnect
    this.socket.on("disconnect", () => {
      this.handlePlayerDisconnect();
    });
  }

  private handlePlayerJoin(
    data: { x: number; y: number },
    userMap: Record<string, User>,
  ) {
    const user = userMap[this.socket.id];
    if (!user) {
      console.error("User not found in userMap for socket:", this.socket.id);
      return;
    }

    // Create player state
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
    };

    // Store in memory
    playerPositions.set(this.socket.id, playerState);

    console.log(
      `Player joined: ${user.name} (${this.socket.id}) at (${data.x}, ${data.y})`,
    );

    // Send current game state to joining player
    // FIX: Send "currentPlayers" (Array) to match Multiplayer.ts
    const allPlayers = Array.from(playerPositions.values());
    console.log("ALL PLAYER");
    console.log(allPlayers);
    this.socket.emit("currentPlayers", allPlayers);

    // Broadcast to other players
    // FIX: Send "newPlayer" to match Multiplayer.ts
    this.socket.broadcast.emit("newPlayer", playerState);
  }

  private handlePlayerMovement(data: PlayerMovementData) {
    // Throttle movement updates (max 20/sec to prevent spam)
    const now = Date.now();
    if (now - this.lastMovementTime < this.MOVEMENT_THROTTLE_MS) {
      return; // Ignore rapid updates
    }
    this.lastMovementTime = now;

    const playerState = playerPositions.get(this.socket.id);
    if (!playerState) {
      // If player hasn't joined via playerJoin yet, ignore movement
      return;
    }

    // Update position in memory
    playerState.x = data.x;
    playerState.y = data.y;
    playerState.vx = data.vx;
    playerState.vy = data.vy;
    // Important: Sync attack state if passed
    if (data.isAttacking !== undefined) {
      playerState.isAttacking = data.isAttacking;
    }

    playerPositions.set(this.socket.id, playerState);

    // Broadcast to all other players (not sender)
    // FIX: Send "playerMoved" to match Multiplayer.ts
    this.socket.broadcast.emit("playerMoved", {
      id: this.socket.id,
      ...data,
    });
  }

  private handlePlayerAction(data: PlayerActionData) {
    const playerState = playerPositions.get(this.socket.id);
    if (!playerState) return;

    // Update attacking state if applicable
    if (data.action === "attack") {
      playerState.isAttacking = true;
      playerPositions.set(this.socket.id, playerState);

      // Reset after animation duration (e.g., 500ms)
      setTimeout(() => {
        const state = playerPositions.get(this.socket.id);
        if (state) {
          state.isAttacking = false;
          playerPositions.set(this.socket.id, state);
        }
      }, 500);
    }

    // Broadcast action to all other players
    this.socket.broadcast.emit(GameEventEnums.PLAYER_ACTION_BROADCAST, {
      playerId: this.socket.id,
      action: data.action,
      targetId: data.targetId,
      metadata: data.metadata,
    });

    // Confirm to sender
    this.socket.emit(GameEventEnums.PLAYER_ACTION_BROADCAST, {
      playerId: this.socket.id,
      action: data.action,
      targetId: data.targetId,
      metadata: data.metadata,
    });
  }

  private async handleCharacterUpdate(
    data: CharacterUpdateData,
    userMap: Record<string, User>,
  ) {
    try {
      // Update in database (persisted)
      const updatedCharacter = await this.characterRepository.update(
        this.userId,
        data,
      );

      // Update in-memory userMap
      const user = userMap[this.socket.id];
      if (user) {
        user.character = updatedCharacter;
      }

      // Update in-memory player state
      const playerState = playerPositions.get(this.socket.id);
      if (playerState) {
        playerState.character = updatedCharacter;
        playerPositions.set(this.socket.id, playerState);
      }

      console.log(
        `Character updated for user ${this.userId}:`,
        updatedCharacter,
      );

      // Broadcast to all players (so they see updated sprite)
      this.socket.broadcast.emit(GameEventEnums.CHARACTER_UPDATED, {
        playerId: this.socket.id,
        character: updatedCharacter,
      });

      // Confirm to sender
      this.socket.emit(GameEventEnums.CHARACTER_UPDATED, {
        playerId: this.socket.id,
        character: updatedCharacter,
      });
    } catch (error) {
      console.error("Failed to update character:", error);
      this.socket.emit("error", { message: "Failed to update character" });
    }
  }

  private handlePlayerDisconnect() {
    // Remove from in-memory state
    if (playerPositions.has(this.socket.id)) {
      playerPositions.delete(this.socket.id);
      console.log(`Player disconnected and removed: ${this.socket.id}`);

      // FIX: Broadcast "deletePlayer" to match Multiplayer.ts
      this.socket.broadcast.emit("deletePlayer", { id: this.socket.id });
    }
  }
}
