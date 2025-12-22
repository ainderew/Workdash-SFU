import { Socket } from "socket.io";
import { JwtUtil, type JwtPayload } from "../_utils/jwt.util.js";

export interface AuthenticatedSocket extends Socket {
  userId: number;
  userEmail: string;
  userName: string;
}

export const socketAuthMiddleware = async (
  socket: Socket,
  next: (err?: Error) => void
) => {
  try {
    // Extract token from handshake auth or query
    const token =
      socket.handshake.auth?.token || socket.handshake.query?.token;

    if (!token || typeof token !== "string") {
      throw new Error("Authentication token missing");
    }

    // Verify JWT
    const payload: JwtPayload = JwtUtil.verify(token);

    // Attach user info to socket
    (socket as AuthenticatedSocket).userId = payload.userId;
    (socket as AuthenticatedSocket).userEmail = payload.email;
    (socket as AuthenticatedSocket).userName = payload.name;

    next();
  } catch (error) {
    console.error("Socket auth failed:", error);
    next(new Error("Authentication failed"));
  }
};
