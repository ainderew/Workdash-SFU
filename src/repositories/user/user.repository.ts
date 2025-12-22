import { prisma } from "@/prisma";
import type { User, Character } from "@prisma/client";
import type { GoogleUserData } from "./_types";

export type UserWithCharacter = User & {
  character: Character | null;
};

export class UserRepository {
  async upsertGoogleUser(data: GoogleUserData): Promise<User> {
    return await prisma.user.upsert({
      where: {
        email: data.email,
      },
      update: {
        name: data.name,
        status: "ONLINE",
        lastLoginAt: new Date(),
      },
      create: {
        email: data.email,
        name: data.name,
        passwordHash: data.passwordHash,
        role: "MEMBER",
        status: "ONLINE",
      },
    });
  }

  async findByEmail(email: string): Promise<User | null> {
    return await prisma.user.findUnique({
      where: { email },
    });
  }

  async findByIdWithCharacter(userId: number): Promise<UserWithCharacter | null> {
    return await prisma.user.findUnique({
      where: { id: userId },
      include: { character: true },
    });
  }
}
