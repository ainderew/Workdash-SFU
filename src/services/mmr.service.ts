export enum MatchResult {
  WIN = "WIN",
  LOSS = "LOSS",
}

export enum Rank {
  PROSPECT = "Prospect",
  CHALLENGER = "Challenger",
  BREAKER = "Breaker",
  ACE = "Ace",
  DIVINE = "Divine",
  EMPEROR = "Emperor",
}

export interface MmrCalculationResult {
  newMMR: number;
  mmrDelta: number;
  newStreak: number;
  newRank: Rank;
}

export class MmrSystem {
  public static readonly INITIAL_MMR = 400;
  public static readonly BASE_CHANGE = 25;
  public static readonly MVP_BONUS = 5;
  public static readonly FEAT_BONUS = 2;
  public static readonly MAX_FEATS = 3;

  private static readonly THRESHOLDS = [
    { rank: Rank.PROSPECT, min: 0, max: 500 },
    { rank: Rank.CHALLENGER, min: 501, max: 900 },
    { rank: Rank.BREAKER, min: 901, max: 1300 },
    { rank: Rank.ACE, min: 1301, max: 1600 },
    { rank: Rank.DIVINE, min: 1601, max: 1900 },
    { rank: Rank.EMPEROR, min: 1901, max: Infinity },
  ];

  public static getRank(mmr: number): Rank {
    const tier = this.THRESHOLDS.find((t) => mmr >= t.min && mmr <= t.max);
    return tier ? tier.rank : Rank.PROSPECT;
  }

  public static calculateMatchResult(
    currentMMR: number,
    currentStreak: number,
    matchResult: MatchResult,
    isMVP: boolean,
    featCount: number,
  ): MmrCalculationResult {
    let mmrDelta = 0;
    let newStreak = currentStreak;

    if (matchResult === MatchResult.WIN) {
      mmrDelta = this.BASE_CHANGE;
      newStreak++;

      if (newStreak >= 5) {
        mmrDelta += 10;
      } else if (newStreak >= 3) {
        mmrDelta += 5;
      }
    } else {
      mmrDelta = -this.BASE_CHANGE;
      newStreak = 0;
    }

    if (isMVP) {
      mmrDelta += this.MVP_BONUS;
    }

    const cappedFeats = Math.min(featCount, this.MAX_FEATS);
    mmrDelta += cappedFeats * this.FEAT_BONUS;

    const newMMR = Math.max(0, currentMMR + mmrDelta);
    const newRank = this.getRank(newMMR);

    return {
      newMMR,
      mmrDelta,
      newStreak,
      newRank,
    };
  }
}
