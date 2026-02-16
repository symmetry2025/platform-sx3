import type { z } from 'zod';

export type AchievementItemDto =
  | {
      id: string;
      title: string;
      description: string;
      iconKey: string;
      kind: 'counter';
      total: number;
      progress: number;
      unlockedAt: string | null;
    }
  | {
      id: string;
      title: string;
      description: string;
      iconKey: string;
      kind: 'boolean';
      total: number;
      progress: number;
      unlockedAt: string | null;
    };

export type AchievementsResponseDto = {
  achievements: AchievementItemDto[];
};

export type ChallengeTodayResponseDto = {
  today: {
    title: string;
    description: string;
    rewardCrystals: number;
    progress: number;
    total: number;
    timeLimitLabel: string;
    difficultyLabel: string;
    startHref: string;
  };
  streak: {
    streakDays: number;
    nextMilestoneDays: number;
    milestoneRewardCrystals: number;
  };
};

export type StatsSummaryDto = {
  totalProblems: number;
  totalCorrect: number;
  totalMistakes: number;
  totalTimeSec: number;
  sessionsCount: number;
  perfectSessionsCount: number;
  raceWinsCount: number;
  accuracyPct: number;
  week: Array<{
    date: string;
    label: string;
    successSessions: number;
  }>;
};

export type NewlyUnlockedAchievementDto = {
  id: string;
  title: string;
  description: string;
  iconKey: string;
  unlockedAt: string;
};

export type TrainerRecordProgressRequestDto = {
  trainerId: string;
  kind: 'column' | 'mental' | 'drill' | 'arithmetic';
  level: string;
  attemptId?: string;
  // plus kind-specific fields (passthrough on runtime schema)
  [k: string]: unknown;
};

export type TrainerRecordProgressResponseDto = {
  trainerId: string;
  progress?: unknown | null;
  duplicate?: boolean;
  newlyUnlockedAchievements: NewlyUnlockedAchievementDto[];
};

export declare const AchievementsResponseDtoSchema: z.ZodType<AchievementsResponseDto>;
export declare const ChallengeTodayResponseDtoSchema: z.ZodType<ChallengeTodayResponseDto>;
export declare const StatsSummaryDtoSchema: z.ZodType<StatsSummaryDto>;
export declare const TrainerRecordProgressRequestDtoSchema: z.ZodType<TrainerRecordProgressRequestDto>;
export declare const TrainerRecordProgressResponseDtoSchema: z.ZodType<TrainerRecordProgressResponseDto>;
export declare const NewlyUnlockedAchievementDtoSchema: z.ZodType<NewlyUnlockedAchievementDto>;

