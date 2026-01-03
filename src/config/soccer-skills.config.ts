// Soccer Skills Configuration
// Single source of truth for all skill definitions

export type SkillEffectType = 'speed_slow' | 'speed_boost' | 'knockback' | 'stun';

// Effect parameters (discriminated union for type safety)
export type SkillEffectParams =
  | { type: 'speed_slow'; multiplier: number }
  | { type: 'speed_boost'; multiplier: number }
  | { type: 'knockback'; force: number; radius: number }
  | { type: 'stun'; duration: number };

// Base skill configuration
export interface SkillConfig {
  id: string;
  name: string;
  description: string;
  keyBinding: string; // e.g., 'Q', 'E', 'R'
  cooldownMs: number;
  durationMs: number;

  // Server-side effect configuration
  serverEffect: {
    type: SkillEffectType;
    params: SkillEffectParams;
  };

  // Client-side visual configuration
  clientVisuals: {
    enableGrayscale: boolean;
    enableSpeedTrail: boolean;
    trailColor?: number; // Hex color (e.g., 0x00ffff)
    trailInterval?: number; // ms between trail sprites
    trailFadeDuration?: number; // ms for trail fade animation
    sfxKey?: string; // Sound effect key
  };
}

// Skill registry
export const SOCCER_SKILLS: Record<string, SkillConfig> = {
  slowdown: {
    id: 'slowdown',
    name: 'Time Dilation',
    description: 'Slow all other players to 10% speed for 5 seconds',
    keyBinding: 'Q',
    cooldownMs: 30000, // 30 seconds
    durationMs: 5000, // 5 seconds

    serverEffect: {
      type: 'speed_slow',
      params: {
        type: 'speed_slow',
        multiplier: 0.1, // 10% speed
      },
    },

    clientVisuals: {
      enableGrayscale: true,
      enableSpeedTrail: true,
      trailColor: 0x00ffff, // Cyan
      trailInterval: 30,
      trailFadeDuration: 300,
      sfxKey: 'skill_slowdown',
    },
  },

  // Future skills can be added here easily
  // speedBoost: { ... },
};

// Helper to get skill by ID
export function getSkillConfig(skillId: string): SkillConfig | undefined {
  return SOCCER_SKILLS[skillId];
}

// Helper to get all skills as array
export function getAllSkills(): SkillConfig[] {
  return Object.values(SOCCER_SKILLS);
}

// Type guard for speed effect
export function isSpeedEffect(
  effect: SkillEffectParams,
): effect is { type: 'speed_slow' | 'speed_boost'; multiplier: number } {
  return effect.type === 'speed_slow' || effect.type === 'speed_boost';
}
