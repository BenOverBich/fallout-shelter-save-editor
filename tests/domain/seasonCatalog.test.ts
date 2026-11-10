// @vitest-environment node
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parseSeasonCatalog } from '../../src/domain/gamedata/seasonCatalog.ts';
import { REWARD_TYPES } from '../../src/domain/model/seasonSchema.ts';
import { syntheticRewardId } from '../../src/domain/gamedata/seasonRewardId.ts';

// Validates the committed public/gamedata/season-pass.json against the schema. It ships
// in the repo (not gitignored), so this runs in CI without the game export.
function load(name: string): unknown {
  return JSON.parse(
    readFileSync(resolve(process.cwd(), 'public/gamedata', `${name}.json`), 'utf8'),
  );
}

const catalog = parseSeasonCatalog(load('season-pass'));

describe('season-pass catalog artifact', () => {
  it('contains all 9 shipped seasons with the correct reward counts', () => {
    expect(catalog.seasons).toHaveLength(9);
    // Chronological by start date - the order the game lists them in spd.dat (v2.7.0).
    expect(catalog.seasonIds).toEqual([
      'NewVegasA',
      'NewVegasB',
      'UltraciteFever',
      'Enclave',
      'Institute',
      // Rerun seasons: date-suffixed replays of the original cycle.
      'NewVegasA_26_07',
      'NewVegasB_26_09',
      'Enclave_26_10',
      'UltraciteFever_27_03',
    ]);
    // Reruns that have been reworked fill every free level 1-20 with caps rewards; the
    // original seasons carry 12, and so does UltraciteFever_27_03, which (v2.7.0) still
    // points at the original UltraciteFever reward list.
    const twentyFree = new Set(['NewVegasA_26_07', 'NewVegasB_26_09', 'Enclave_26_10']);
    for (const season of catalog.seasons) {
      expect(season.freeRewards).toHaveLength(twentyFree.has(season.id) ? 20 : 12);
      expect(season.premiumRewards).toHaveLength(25);
      expect(season.maxRank).toBe(25);
      // Last 5 premium ranks are prestige rewards.
      expect(season.premiumRewards.filter((r) => r.isPrestige)).toHaveLength(5);
      expect(season.startDate).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(season.endDate).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(season.tokenRequirements).toHaveLength(25);
    }
  });

  it('indexes seasons by id and matches the meta count', () => {
    expect(catalog.seasonById.get('Institute')?.maxRank).toBe(25);
    expect(catalog.seasonById.has('NewVegasA')).toBe(true);
    expect(catalog.seasonById.has('Enclave_26_10')).toBe(true);
    const meta = load('meta') as { counts: Record<string, number>; gameVersion: string };
    expect(meta.counts.seasons).toBe(9);
    expect(meta.gameVersion).toBe('2.7.0');
  });

  it('has no ncqReward template (v2.7.0 has no asset for the old inert placeholder)', () => {
    expect(catalog.ncqReward).toBeNull();
  });

  it('gives every reward the positional synthetic id, unique across the whole catalog', () => {
    // v2.7.0 has no reward ids; the catalog id must be the one the app derives when it
    // hydrates a positional reward, and no two seasons may share one (a rerun sharing its
    // original's reward list keeps separate claim state in the game).
    const seen = new Set<number>();
    for (const season of catalog.seasons) {
      for (const track of ['free', 'premium'] as const) {
        const list = track === 'free' ? season.freeRewards : season.premiumRewards;
        list.forEach((reward, index) => {
          expect(reward.id).toBe(syntheticRewardId(season.id, track, index));
          expect(seen.has(reward.id)).toBe(false);
          seen.add(reward.id);
        });
      }
    }
  });

  it('every catalog reward is a known grantable type and carries no claim state', () => {
    const grantable = new Set<string>(REWARD_TYPES);
    for (const season of catalog.seasons) {
      for (const reward of [...season.freeRewards, ...season.premiumRewards]) {
        expect(grantable.has(reward.rewardType)).toBe(true);
        expect(reward).not.toHaveProperty('claimedList');
        expect(reward.dataValString.length).toBeGreaterThan(0);
      }
    }
  });
});
