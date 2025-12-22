import { type Request, type Response } from "express";
import { AuthService } from "../../services/auth.service.js";
import { JwtUtil } from "../../_utils/jwt.util.js";

const authService = new AuthService();

export const syncGoogleUser = async (req: Request, res: Response) => {
  try {
    const { email, name } = req.body;

    console.log("EMAIL");
    console.log(email);
    if (!email) {
      return res.status(400).json({ error: "Email is required" });
    }

    const user = await authService.syncGoogleUser(email, name);

    // Generate JWT token
    const token = JwtUtil.sign({
      userId: user.id,
      email: user.email,
      name: user.name || "Player",
    });
    console.log(token);

    return res.status(200).json({
      success: true,
      token,
      user: {
        id: user.id,
        email: user.email,
        name: user.name,
        role: user.role,
        status: user.status,
        level: user.level,
      },
      character: user.character,
    });
  } catch (error) {
    console.error("Auth Controller Error:", error);
    return res.status(500).json({
      success: false,
      error: "Internal Server Error",
    });
  }
};
