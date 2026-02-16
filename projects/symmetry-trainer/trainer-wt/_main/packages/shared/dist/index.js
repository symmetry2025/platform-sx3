"use strict";

Object.defineProperty(exports, "__esModule", { value: true });

const { z } = require("zod");

// -----------------------------
// Common DTOs used by trainer
// -----------------------------

const IsoDateTimeString = z.string().min(1);

// Achievements
const AchievementBaseDtoSchema = z.object({
  id: z.string().min(1),
  title: z.string().min(1),
  description: z.string().min(1),
  iconKey: z.string().min(1),
  unlockedAt: z.string().min(1).nullable(),
});

const AchievementCounterItemDtoSchema = AchievementBaseDtoSchema.extend({
  kind: z.literal("counter"),
  total: z.number().int().nonnegative(),
  progress: z.number().int().nonnegative(),
});

const AchievementBooleanItemDtoSchema = AchievementBaseDtoSchema.extend({
  kind: z.literal("boolean"),
  total: z.number().int().nonnegative(),
  progress: z.number().int().nonnegative(),
});

const AchievementItemDtoSchema = z.union([AchievementCounterItemDtoSchema, AchievementBooleanItemDtoSchema]);

const AchievementsResponseDtoSchema = z.object({
  achievements: z.array(AchievementItemDtoSchema),
});

// Challenge
const ChallengeTodayResponseDtoSchema = z.object({
  today: z.object({
    title: z.string().min(1),
    description: z.string().min(1),
    rewardCrystals: z.number().int().nonnegative(),
    progress: z.number().nonnegative(),
    total: z.number().int().positive(),
    timeLimitLabel: z.string(),
    difficultyLabel: z.string(),
    startHref: z.string().min(1),
  }),
  streak: z.object({
    streakDays: z.number().int().nonnegative(),
    nextMilestoneDays: z.number().int().positive(),
    milestoneRewardCrystals: z.number().int().nonnegative(),
  }),
});

// Stats
const StatsSummaryDtoSchema = z.object({
  totalProblems: z.number().int().nonnegative(),
  totalCorrect: z.number().int().nonnegative(),
  totalMistakes: z.number().int().nonnegative(),
  totalTimeSec: z.number().int().nonnegative(),
  sessionsCount: z.number().int().nonnegative(),
  perfectSessionsCount: z.number().int().nonnegative(),
  raceWinsCount: z.number().int().nonnegative(),
  accuracyPct: z.number().nonnegative(),
  week: z.array(
    z.object({
      date: z.string().min(1), // YYYY-MM-DD
      label: z.string().min(1),
      successSessions: z.number().int().nonnegative(),
    }),
  ),
});

// Progress recording
const TrainerRecordProgressRequestDtoSchema = z
  .object({
    trainerId: z.string().min(1),
    kind: z.enum(["column", "mental", "drill", "arithmetic"]),
    level: z.string().min(1),
    attemptId: z.string().min(1).optional(),
  })
  .passthrough();

const NewlyUnlockedAchievementDtoSchema = z.object({
  id: z.string().min(1),
  title: z.string().min(1),
  description: z.string().min(1),
  iconKey: z.string().min(1),
  unlockedAt: IsoDateTimeString,
});

const TrainerRecordProgressResponseDtoSchema = z.object({
  trainerId: z.string().min(1),
  progress: z.unknown().nullable().optional(),
  duplicate: z.boolean().optional(),
  newlyUnlockedAchievements: z.array(NewlyUnlockedAchievementDtoSchema).default([]),
});

// Exports (keep names stable for existing imports)
exports.AchievementsResponseDtoSchema = AchievementsResponseDtoSchema;
exports.ChallengeTodayResponseDtoSchema = ChallengeTodayResponseDtoSchema;
exports.StatsSummaryDtoSchema = StatsSummaryDtoSchema;
exports.TrainerRecordProgressRequestDtoSchema = TrainerRecordProgressRequestDtoSchema;
exports.TrainerRecordProgressResponseDtoSchema = TrainerRecordProgressResponseDtoSchema;
// Types are TS-only, but some code imports type names — they are erased at runtime.
// Export schema anyway to keep runtime surface small.
exports.NewlyUnlockedAchievementDtoSchema = NewlyUnlockedAchievementDtoSchema;

