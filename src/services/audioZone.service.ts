import { Socket } from "socket.io";
import type mediasoup from "mediasoup";

interface ZonePlayer {
  socketId: string;
  playerId: number;
  name: string;
  producerIds: string[];
}

interface ZoneChangeData {
  playerId: string;
  fromZone: string | null;
  toZone: string | null;
}

interface SharedState {
  socketZones: Record<string, string | null>;
  zoneRooms: Record<string, Set<string>>;
  userMap: Record<string, { userId: number; name: string }>;
  producers: Record<
    string,
    { producer: mediasoup.types.Producer; transportId: string }
  >;
  socketTransports: Record<string, string[]>;
}

export class AudioZoneService {
  private socket: Socket;
  private socketZones: Record<string, string | null>;
  private zoneRooms: Record<string, Set<string>>;
  private userMap: Record<string, { userId: number; name: string }>;
  private producers: Record<
    string,
    { producer: mediasoup.types.Producer; transportId: string }
  >;
  private socketTransports: Record<string, string[]>;

  constructor(socket: Socket, sharedState: SharedState) {
    this.socket = socket;
    this.socketZones = sharedState.socketZones;
    this.zoneRooms = sharedState.zoneRooms;
    this.userMap = sharedState.userMap;
    this.producers = sharedState.producers;
    this.socketTransports = sharedState.socketTransports;
  }

  public listen(): void {
    this.socket.on("player-zone-changed", (data: ZoneChangeData) => {
      this.handleZoneChange(data);
    });
  }

  private handleZoneChange(data: ZoneChangeData): void {
    const { fromZone, toZone } = data;

    console.log(
      `Player ${this.socket.id} zone change: ${fromZone} -> ${toZone}`,
    );

    if (fromZone) {
      this.leaveZone(fromZone, data.playerId);
    }

    if (toZone) {
      this.joinZone(toZone, data.playerId);
    } else {
      this.socket.emit("zone-players", {
        zone: null,
        players: [],
      });
    }

    this.socketZones[this.socket.id] = toZone;
  }

  private leaveZone(zoneId: string, playerId: string): void {
    this.socket.leave(`zone:${zoneId}`);
    this.zoneRooms[zoneId]?.delete(this.socket.id);

    this.socket.to(`zone:${zoneId}`).emit("player-left-zone", {
      socketId: this.socket.id,
      playerId,
      zone: zoneId,
    });
  }

  private joinZone(zoneId: string, playerId: string): void {
    this.socket.join(`zone:${zoneId}`);

    if (!this.zoneRooms[zoneId]) {
      this.zoneRooms[zoneId] = new Set();
    }
    this.zoneRooms[zoneId].add(this.socket.id);

    const producerIds = this.getAudioProducersForSocket(this.socket.id);
    const user = this.userMap[this.socket.id];

    this.socket.to(`zone:${zoneId}`).emit("player-joined-zone", {
      socketId: this.socket.id,
      playerId,
      zone: zoneId,
      producerIds,
      name: user?.name || "Unknown",
    });

    const playersInZone = this.getPlayersInZone(zoneId);
    this.socket.emit("zone-players", {
      zone: zoneId,
      players: playersInZone,
    });
  }

  private getPlayersInZone(zoneId: string): ZonePlayer[] {
    const socketIds = this.zoneRooms[zoneId] || new Set();
    const players: ZonePlayer[] = [];

    for (const sid of socketIds) {
      if (sid === this.socket.id) continue;

      const user = this.userMap[sid];
      if (!user) continue;

      const producerIds = this.getAudioProducersForSocket(sid);

      players.push({
        socketId: sid,
        playerId: user.userId,
        name: user.name,
        producerIds,
      });
    }

    return players;
  }

  private getAudioProducersForSocket(socketId: string): string[] {
    const transportIds = this.socketTransports[socketId] || [];

    return Object.entries(this.producers)
      .filter(([, data]) => {
        return (
          transportIds.includes(data.transportId) &&
          data.producer.kind === "audio"
        );
      })
      .map(([id]) => id);
  }

  public cleanup(): void {
    const currentZone = this.socketZones[this.socket.id];

    if (currentZone) {
      this.zoneRooms[currentZone]?.delete(this.socket.id);

      this.socket.to(`zone:${currentZone}`).emit("player-left-zone", {
        socketId: this.socket.id,
        zone: currentZone,
      });
    }

    delete this.socketZones[this.socket.id];
  }

  public static getSocketZone(
    socketZones: Record<string, string | null>,
    socketId: string,
  ): string | null {
    return socketZones[socketId] || null;
  }

  public static shouldReceiveAudio(
    socketZones: Record<string, string | null>,
    producerSocketId: string,
    consumerSocketId: string,
  ): boolean {
    const producerZone = socketZones[producerSocketId];
    const consumerZone = socketZones[consumerSocketId];

    return producerZone === consumerZone;
  }

  public static broadcastToZone(
    socket: Socket,
    socketZones: Record<string, string | null>,
    event: string,
    data: object,
  ): void {
    const zone = socketZones[socket.id];

    if (zone) {
      socket.to(`zone:${zone}`).emit(event, data);
    }
  }
}
