import { Socket } from "socket.io";
import { GameEventEnums } from "./_enums.js";
import type {
  PlayerState,
  PlayerMovementData,
  PlayerActionData,
} from "./_types.js";
import { CharacterRepository } from "../repositories/character/character.repository.js";
import type { CharacterUpdateInput } from "@/generated/prisma/models.js";
import type { User } from "../index.js";

// In-memory player positions Shared across all socket instances)
const playerPositions: Map<string, PlayerState> = new Map();

export class GameService {
  private socket: Socket;
  private userId: number;
  private characterRepository: CharacterRepository;
  private lastMovementTime: number = 0;

  // Max 20 updates/sec.
  // it's the tickrate of the front end 1000/50 = 20
  private readonly MOVEMENT_THROTTLE_MS = 50;
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

    this.socket.on("playerJoin", (data: { x: number; y: number }) => {
      this.handlePlayerJoin(data, userMap);
    });

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

    // Clean up on disconnect
    this.socket.on("disconnect", () => {
      this.handlePlayerDisconnect();
    });
  }

  private handlePlayerAction(data: PlayerActionData) {
    const playerState = playerPositions.get(this.socket.id);
    if (!playerState) {
      return;
    }

    if (data.action === "attack") {
      playerState.isAttacking = true;
      playerPositions.set(this.socket.id, playerState);
    }

    // Broadcast action to all other players
    this.socket.broadcast.emit("playerAction", {
      playerId: this.socket.id,
      action: data.action,
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

    playerPositions.set(this.socket.id, playerState);

    console.log(
      `Player joined: ${user.name} (${this.socket.id}) at (${data.x}, ${data.y})`,
    );

    // Send current game state to joining player
    const allPlayers = Array.from(playerPositions.values());
    console.log("ALL PLAYER");
    console.log(allPlayers);
    this.socket.emit("currentPlayers", allPlayers);

    // Broadcast to other players
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

  private async handleCharacterUpdate(
    data: CharacterUpdateInput,
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
      this.socket.broadcast.emit(GameEventEnums.RESPONSE_CHARACTER_UPDATED, {
        playerId: this.socket.id,
        character: updatedCharacter,
      });

      // Confirm to sender
      this.socket.emit(GameEventEnums.RESPONSE_CHARACTER_UPDATED, {
        playerId: this.socket.id,
        character: updatedCharacter,
      });
    } catch (error) {
      console.error("Failed to update character:", error);
      this.socket.emit("error", { message: "Failed to update character" });
    }
  }

  private async handleNameUpdate(
    data: { name: string },
    userMap: Record<string, User>,
  ) {
    try {
      const newName = data.name.trim();

      if (!newName) {
        console.error("Name update failed: empty name");
        return;
      }

      // Update in-memory userMap
      const user = userMap[this.socket.id];
      if (user) {
        user.name = newName;
      }

      // Update in-memory player state
      const playerState = playerPositions.get(this.socket.id);
      if (playerState) {
        playerState.name = newName;
        playerPositions.set(this.socket.id, playerState);
      }

      // Broadcast to all other players (not sender)
      this.socket.broadcast.emit("nameUpdated", {
        playerId: this.socket.id,
        name: newName,
      });
    } catch (error) {
      console.error("Failed to handle name update:", error);
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
