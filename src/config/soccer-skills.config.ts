// Soccer Skills Configuration
// Single source of truth for all skill definitions

export type SkillEffectType =
  | "speed_slow"
  | "speed_boost"
  | "knockback"
  | "stun"
  | "blink"
  | "metavision"
  | "ninja_step";

// Effect parameters (discriminated union for type safety)
export type SkillEffectParams =
  | { type: "speed_slow"; multiplier: number }
  | { type: "speed_boost"; multiplier: number }
  | { type: "knockback"; force: number; radius: number }
  | { type: "stun"; duration: number }
  | { type: "blink"; distance: number; preventWallClip: boolean }
  | { type: "metavision" }
  | { type: "ninja_step" };

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
    iconKey: string; // Icon filename without extension
  };
}

// Skill registry
export const SOCCER_SKILLS: Record<string, SkillConfig> = {
  slowdown: {
    id: "slowdown",
    name: "Time Dilation",
    description: "Slow all other players to 10% speed for 5 seconds",
    keyBinding: "Q",
    cooldownMs: 30000, // 30 seconds
    durationMs: 5000, // 5 seconds

    serverEffect: {
      type: "speed_slow",
      params: {
        type: "speed_slow",
        multiplier: 0.35,
      },
    },

    clientVisuals: {
      enableGrayscale: true,
      enableSpeedTrail: true,
      trailColor: 0x00ffff, // Cyan
      trailInterval: 30,
      trailFadeDuration: 300,
      sfxKey: "time_dilation",
      iconKey: "time_dilation",
    },
  },

  blink: {
    id: "blink",
    name: "Swift Step",
    description:
      "Instantly dash a short distance in the direction you are facing",
    keyBinding: "E",
    cooldownMs: 12000, // 12 seconds
    durationMs: 0, // Instant effect, no duration

    serverEffect: {
      type: "blink",
      params: {
        type: "blink",
        distance: 300, // pixels
        preventWallClip: true,
      },
    },

    clientVisuals: {
      enableGrayscale: false,
      enableSpeedTrail: true,
      trailColor: 0x00ffff, // Purple
      trailInterval: 15,
      trailFadeDuration: 500,
      sfxKey: "blink",
      iconKey: "blink",
    },
  },

  metavision: {
    id: "metavision",
    name: "Metavision",
    description: "Predict the ball trajectory and bounces",
    keyBinding: "R",
    cooldownMs: 15000,
    durationMs: 5000,
    serverEffect: { type: "metavision", params: { type: "metavision" } },
    clientVisuals: {
      enableGrayscale: false,
      enableSpeedTrail: false,
      trailColor: 0x00ffff,
      sfxKey: "soccer_skill_activation",
      iconKey: "metavision",
    },
  },

  ninja_step: {
    id: "ninja_step",
    name: "Shadow Step",
    description:
      "Passive: Phase through enemies when not touching the ball. Become solid when near the ball.",
    keyBinding: "T",
    cooldownMs: 0,
    durationMs: 0,
    serverEffect: { type: "ninja_step", params: { type: "ninja_step" } },
    clientVisuals: {
      enableGrayscale: false,
      enableSpeedTrail: false,
      sfxKey: "shadow",
      iconKey: "shadow",
    },
  },
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
): effect is { type: "speed_slow" | "speed_boost"; multiplier: number } {
  return effect.type === "speed_slow" || effect.type === "speed_boost";
}
