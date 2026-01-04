// Soccer Skills Configuration
// Single source of truth for all skill definitions

export type SkillEffectType =
  | "speed_slow"
  | "speed_boost"
  | "knockback"
  | "stun"
  | "blink"
  | "metavision"
  | "ninja_step"
  | "lurking_radius"
  | "power_shot";

// Effect parameters (discriminated union for type safety)
export type SkillEffectParams =
  | { type: "speed_slow"; multiplier: number }
  | { type: "speed_boost"; multiplier: number }
  | { type: "knockback"; force: number; radius: number }
  | { type: "stun"; duration: number }
  | { type: "blink"; distance: number; preventWallClip: boolean }
  | { type: "metavision" }
  | { type: "ninja_step" }
  | { type: "lurking_radius"; radius: number; duration: number }
  | {
      type: "power_shot";
      force: number;
      knockbackForce: number;
      ballRetention: number;
      activeWindowMs: number;
    };

export interface SkillConfig {
  id: string;
  name: string;
  description: string;
  keyBinding: string;
  cooldownMs: number;
  durationMs: number;
  serverEffect: {
    type: SkillEffectType;
    params: SkillEffectParams;
  };
  clientVisuals: {
    enableGrayscale: boolean;
    enableSpeedTrail: boolean;
    trailColor?: number;
    trailInterval?: number;
    trailFadeDuration?: number;
    sfxKey?: string;
    iconKey: string;
  };
}

export const SOCCER_SKILLS: Record<string, SkillConfig> = {
  slowdown: {
    id: "slowdown",
    name: "Time Dilation",
    description:
      "Slow all other players to 35% speed for 5 seconds, while the user and the ball remains unaffected by slows",
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
      "Instantly dash a short distance in the direction you are facing. The user dashes 400 units in the direction they are facing",
    keyBinding: "E",
    cooldownMs: 12000, // 12 seconds
    durationMs: 0, // Instant effect, no duration

    serverEffect: {
      type: "blink",
      params: {
        type: "blink",
        distance: 400, // pixels
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
    description:
      "Predict the ball trajectory and bounces. If the ball is stationary kick trajectory is visible",
    keyBinding: "R",
    cooldownMs: 20000,
    durationMs: 8000,
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
      "Toggle: While active the user phases through enemies when not touching the ball. Become solid when near the ball.",
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

  lurking_radius: {
    id: "lurking_radius",
    name: "Lurking Radius",
    description:
      "Activate to create a zone. Press again when ball enters zone to intercept, the player dashes behind the ball in an instant.",
    keyBinding: "F",
    cooldownMs: 20000,
    durationMs: 5000, // 5 seconds to intercept
    serverEffect: {
      type: "lurking_radius",
      params: {
        type: "lurking_radius",
        radius: 500,
        duration: 5000,
      },
    },
    clientVisuals: {
      enableGrayscale: false,
      enableSpeedTrail: false,
      trailColor: 0x800080, // Purple
      sfxKey: "lurking",
      iconKey: "lurking_radius",
    },
  },

  power_shot: {
    id: "power_shot",
    name: "Power Shot",
    description:
      "Auto-aim devastating shot toward opponent goal. This shot is 2x the normal kick power of the user. Gain a 50% kick power buff for 3 seconds after",
    keyBinding: "G",
    cooldownMs: 20000, // 20 seconds
    durationMs: 3000, // 3-second buff duration

    serverEffect: {
      type: "power_shot",
      params: {
        type: "power_shot",
        force: 2000, // 2x normal kick power
        knockbackForce: 300, // Player knockback distance
        ballRetention: 0.8, // 80% velocity after collision
        activeWindowMs: 3000, // 3-second effect window
      },
    },

    clientVisuals: {
      enableGrayscale: false,
      enableSpeedTrail: true,
      trailColor: 0xff6600, // Orange/red
      trailInterval: 15,
      trailFadeDuration: 300,
      sfxKey: "power_shot",
      iconKey: "power_shot",
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
