import { UserRepository, type UserWithCharacter } from "../repositories/user/user.repository.js";
import { CharacterRepository } from "../repositories/character/character.repository.js";
import { v4 as uuidv4 } from "uuid";

export class AuthService {
  private userRepository: UserRepository;
  private characterRepository: CharacterRepository;

  constructor() {
    this.userRepository = new UserRepository();
    this.characterRepository = new CharacterRepository();
  }

  async syncGoogleUser(email: string, name: string): Promise<UserWithCharacter> {
    const dummyPassword = `GOOGLE_AUTH_${uuidv4()}`;

    const user = await this.userRepository.upsertGoogleUser({
      email,
      name,
      passwordHash: dummyPassword,
    });

    let character = await this.characterRepository.findByUserId(user.id);

    if (!character) {
      character = await this.characterRepository.create(
        user.id,
        user.name || "Player",
        "ADULT"
      );
    }

    return {
      ...user,
      character,
    };
  }
}
