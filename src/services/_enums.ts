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
  PLAYER_ACTION = "playerAction",
  PLAYER_UPDATE_CHARACTER = "updateCharacter",
  PLAYER_UPDATE_NAME = "updateName",
  SCENE_CHANGE = "player:sceneChange",

  // Server -> Client
  PLAYER_JOINED = "game:playerJoined",
  PLAYER_MOVEMENT = "game:playerMovement",
  PLAYER_LEFT = "game:playerLeft",
  RESPONSE_CHARACTER_UPDATED = "characterUpdated",
  GAME_STATE_SYNC = "game:stateSync",

  // Soccer Ball Events - Client -> Server
  BALL_KICK = "ball:kick",
  BALL_DRIBBLE = "ball:dribble",

  // Soccer Ball Events - Server -> Client
  BALL_STATE = "ball:state",
  BALL_KICKED = "ball:kicked",
}

export enum PollEvents {
  CREATE_POLL = "createPoll",
  NEW_POLL = "newPoll",
  SUBMIT_VOTE = "submitVote",
  POLL_UPDATED = "pollUpdated",
  CLOSE_POLL = "closePoll",
  POLL_CLOSED = "pollClosed",
}
