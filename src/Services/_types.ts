import type { Character } from "@prisma/client";

export type Message = {
  content: string;
  senderSocketId: string;
  name: string;
  createdAt: Date;
  type?: "text" | "gif" | "image";
  gifUrl?: string;
  imageUrl?: string;
};

export type EmojiData = {
  emoji: string;
  playerId: string;
};

export type PlayerPosition = {
  x: number;
  y: number;
  vx: number;
  vy: number;
};

export type PlayerState = PlayerPosition & {
  id: string;
  userId: number;
  name: string;
  isAttacking: boolean;
  character: Character;
};

export type PlayerJoinData = {
  playerId: string;
  playerState: PlayerState;
};

export type PlayerMovementData = {
  playerId: string;
  x: number;
  y: number;
  vx: number;
  vy: number;
};

export type PlayerActionData = {
  playerId: string;
  action: "attack" | "interact" | "emote";
  targetId?: string;
  metadata?: Record<string, unknown>;
};

export type CharacterUpdateData = {
  bodyId?: number;
  eyesId?: number;
  hairstyleId?: number;
  outfitId?: number;
  itemId?: number | null;
  itemType?: string | null;
};
