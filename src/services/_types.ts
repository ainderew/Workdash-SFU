import type { Character } from "@prisma/client";

export type LinkMetadata = {
  url: string;
  type: "youtube" | "twitter" | "github" | "generic";
  title?: string;
  description?: string;
  image?: string;
  // YouTube specific
  youtubeId?: string;
  // Twitter specific
  twitterUsername?: string;
  twitterId?: string;
  // GitHub specific
  githubOwner?: string;
  githubRepo?: string;
  githubType?: "repo" | "issue" | "pull";
  githubIssueNumber?: string;
};

export type Message = {
  content: string;
  senderSocketId: string;
  senderSpriteSheet: string | undefined;
  name: string;
  createdAt: Date;
  type?: "text" | "gif" | "image";
  gifUrl?: string;
  imageUrl?: string;
  linkMetadata?: LinkMetadata[];
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
  isAttacking: boolean;
  isKartMode: boolean;
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

export type PollOption = {
  id: string;
  text: string;
  votes: number;
};

export type Poll = {
  id: string;
  question: string;
  options: PollOption[];
  creatorId: string;
  creatorName: string;
  createdAt: Date;
  isActive: boolean;
  allowMultiple: boolean;
  totalVotes: number;
  voters: string[];
};

export type Vote = {
  pollId: string;
  userId: string;
  optionIds: string[];
  timestamp: Date;
};
