import { UserRepository } from "@/repositories/user/user.repository.js";
import type { UserWithCharacter } from "@/repositories/user/user.repository.js";
import type { User } from "@prisma/client";

export class UserService {
  userRepository: UserRepository;

  constructor(userRepository: UserRepository) {
    this.userRepository = userRepository;
  }

  async getUser(userId: number): Promise<UserWithCharacter | null> {
    return await this.userRepository.findByIdWithCharacter(userId);
  }

  async updateName(userId: number, name: string): Promise<User> {
    if (!name || name.trim().length === 0) {
      throw new Error("Name cannot be empty");
    }

    return await this.userRepository.updateName(userId, name);
  }
}
