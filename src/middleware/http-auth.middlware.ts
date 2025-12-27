import type { Request, Response, NextFunction } from "express";
import { JwtUtil, type JwtPayload } from "../_utils/jwt.util.js";

// Extend the standard Express Request to include our user data
export interface AuthenticatedRequest extends Request {
  userId?: number;
  userEmail?: string;
}

export const httpAuthMiddleware = (
  req: Request,
  res: Response,
  next: NextFunction,
) => {
  try {
    const authHeader = req.headers.authorization;

    // Check if header exists and starts with "Bearer "
    if (!authHeader || !authHeader.startsWith("Bearer ")) {
      return res.status(401).json({ error: "Authentication token missing" });
    }

    // Extract token (remove "Bearer " prefix)
    const token = authHeader.split(" ")[1];

    if (!token) {
      throw new Error("Token is missing");
    }

    // Verify JWT
    const payload: JwtPayload = JwtUtil.verify(token);

    // Attach user info to request object
    (req as AuthenticatedRequest).userId = payload.userId;
    (req as AuthenticatedRequest).userEmail = payload.email;

    next();
  } catch (error) {
    console.error("HTTP auth failed:", error);
    return res.status(401).json({ error: "Invalid or expired token" });
  }
};
