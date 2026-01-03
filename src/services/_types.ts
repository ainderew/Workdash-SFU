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
  clientId: string;
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

export type SoccerStats = {
  speed: number;
  kickPower: number;
  dribbling: number;
};

export type PlayerState = PlayerPosition & {
  id: string;
  userId: number;
  name: string;
  isAttacking: boolean;
  character: Character;
  currentScene: string; // Track which scene/map player is in
  soccerStats?: SoccerStats | null; // Optional soccer stats for SoccerMap
  team?: "red" | "blue" | null; // Soccer team assignment
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
  currentScene?: string; // Optional scene identifier for tracking
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

// Soccer ball types
export type BallState = {
  x: number;
  y: number;
  vx: number;
  vy: number;
  lastTouchId: string | null;
  lastTouchTimestamp: number;
  isMoving: boolean;
};

export type BallKickData = {
  playerId: string;
  kickPower: number;
  angle: number;
};

export type BallDribbleData = {
  playerId: string;
  playerX: number;
  playerY: number;
  playerVx: number;
  playerVy: number;
};
