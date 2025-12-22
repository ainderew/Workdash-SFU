export enum EventEnums {
  SEND_MESSAGE = "sendMessage",
  NEW_MESSAGE = "newMessage",
}

export enum ReactionEventEnums {
  SEND_REACTION = "send_reaction",
  NEW_REACTION = "new_reaction",
}

export enum GameEventEnums {
  // Client -> Server
  PLAYER_JOIN = "game:playerJoin",
  PLAYER_MOVE = "game:playerMove",
  PLAYER_ACTION = "game:playerAction",
  PLAYER_UPDATE_CHARACTER = "game:updateCharacter",

  // Server -> Client
  PLAYER_JOINED = "game:playerJoined",
  PLAYER_MOVEMENT = "game:playerMovement",
  PLAYER_LEFT = "game:playerLeft",
  PLAYER_ACTION_BROADCAST = "game:playerAction",
  CHARACTER_UPDATED = "game:characterUpdated",
  GAME_STATE_SYNC = "game:stateSync",
}
