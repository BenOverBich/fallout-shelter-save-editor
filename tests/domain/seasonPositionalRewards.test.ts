import { describe, it, expect } from 'vitest';
import type { SaveData } from '../../src/domain/model/saveSchema.ts';
import {
  HYDRATED_REWARD_MARK,
  seasonSaveSchema,
  type SeasonSave,
} from '../../src/domain/model/seasonSchema.ts';
import { parseSeasonCatalog } from '../../src/domain/gamedata/seasonCatalog.ts';
import { syntheticRewardId } from '../../src/domain/gamedata/seasonRewardId.ts';
import { parseLossless, stringifyLossless } from '../../src/domain/codec/losslessJson.ts';
import {
  buildFreshNvf,
  buildFreshSeasonSave,
  claimReward,
  defaultSeasonId,
  dehydrateSeasonSave,
  isRewardClaimed,
  loadSeasonSave,
  unclaimReward,
  type RewardResolverData,
  type SeasonWorkspace,
} from '../../src/domain/ops/seasonOps.ts';

// Game v2.7.0 changed spd.dat: a reward entry now stores ONLY its per-save state
// (`claimedList`, `levelRequired`). What the reward is lives in the game's SeasonPassEntry
// assets (-> season-pass.json) and the reward is identified by its position in the track.
// These tests pin the editor's handling of that shape: hydrate on load, edit as usual,
// write the game's own shape back out.

const reward = (id: number, rewardType: string, dataValInt: number, levelRequired: number) => ({
  id,
  isPrestige: false,
  rewardType,
  dataValInt,
  dataValString: 'none',
  icon: `BP_${rewardType}`,
  levelRequired,
});

const catalog = parseSeasonCatalog({
  ncqReward: null,
  seasons: [
    {
      id: 'Orig',
      maxRank: 25,
      startDate: '2026-03-04',
      endDate: '2026-04-13',
      freeRewards: [
        reward(syntheticRewardId('Orig', 'free', 0), 'caps', 300, 2),
        reward(syntheticRewardId('Orig', 'free', 1), 'stimpack', 5, 3),
      ],
      premiumRewards: [reward(syntheticRewardId('Orig', 'premium', 0), 'caps', 1000, 1)],
    },
    {
      // A rerun pointing at the same reward list as its original (v2.7.0: UltraciteFever_27_03).
      id: 'Orig_27_03',
      maxRank: 25,
      startDate: '2027-03-03',
      endDate: '2027-04-12',
      freeRewards: [
        reward(syntheticRewardId('Orig_27_03', 'free', 0), 'caps', 300, 2),
        reward(syntheticRewardId('Orig_27_03', 'free', 1), 'stimpack', 5, 3),
      ],
      premiumRewards: [reward(syntheticRewardId('Orig_27_03', 'premium', 0), 'caps', 1000, 1)],
    },
  ],
});

/** A v2.7.0-shaped spd.dat body, as the game writes it (reward entries are positional). */
const V27_TEXT = JSON.stringify({
  saveTime: 0,
  currentSeason: 'Orig',
  schemaVersion: 2,
  seasonsData: {
    Orig: {
      isPremium: false,
      maxRankAchieved: 25,
      ncqReward: {
        claimedList: [0],
        levelRequired: 0,
        isPrestige: false,
        rewardType: 'quantum',
        dataValInt: 99911,
        dataValString: '[Data]',
        icon: 'NCQ Icon',
      },
      freeRewardsList: [
        { claimedList: [1], levelRequired: 2 },
        { claimedList: [], levelRequired: 3 },
      ],
      premiumRewardsList: [{ claimedList: [], levelRequired: 1 }],
    },
    Orig_27_03: {
      isPremium: false,
      maxRankAchieved: 1,
      freeRewardsList: [
        { claimedList: [1, -1], levelRequired: 2 },
        { claimedList: [], levelRequired: 3 },
      ],
      premiumRewardsList: [{ claimedList: [], levelRequired: 1 }],
    },
    // A season this catalog has never heard of (a game update newer than the editor).
    Future_28_01: {
      freeRewardsList: [{ claimedList: [], levelRequired: 1 }],
      premiumRewardsList: [],
    },
  },
});

const parseV27 = (): SeasonSave => parseLossless(V27_TEXT) as SeasonSave;

const data: RewardResolverData = {
  weaponById: new Map(),
  outfitById: new Map(),
  petById: new Map(),
  uniqueDwellers: {},
};

function workspace(spd: SeasonSave): SeasonWorkspace {
  const save = { vault: { storage: { resources: { Nuka: 100, StimPack: 0 } } } } as SaveData;
  return { save, spd, nvf: { season: { id: 'Orig', type: 0 } }, handles: {} };
}

describe('v2.7.0 positional rewards - load', () => {
  it('a raw v2.7.0 file passes the season schema once hydrated', () => {
    const spd = loadSeasonSave(parseV27(), catalog);
    expect(seasonSaveSchema.safeParse(spd).success).toBe(true);
  });

  it('fills each positional reward from the catalog entry at the same position', () => {
    const spd = loadSeasonSave(parseV27(), catalog);
    const [first, second] = spd.seasonsData!.Orig.freeRewardsList!;
    expect(first).toMatchObject({
      id: syntheticRewardId('Orig', 'free', 0),
      rewardType: 'caps',
      dataValInt: 300,
      icon: 'BP_caps',
      claimedList: [1],
      levelRequired: 2,
    });
    expect(first[HYDRATED_REWARD_MARK]).toBe(true);
    expect(second.rewardType).toBe('stimpack');
    expect(spd.seasonsData!.Orig.premiumRewardsList![0].dataValInt).toBe(1000);
  });

  it('keeps unusual claim indexes the game wrote (-1) untouched', () => {
    const spd = loadSeasonSave(parseV27(), catalog);
    expect(spd.seasonsData!.Orig_27_03.freeRewardsList![0].claimedList).toEqual([1, -1]);
  });

  it('makes rewards of an unknown season inert instead of guessing', () => {
    const spd = loadSeasonSave(parseV27(), catalog);
    const unknown = spd.seasonsData!.Future_28_01.freeRewardsList![0];
    expect(unknown.rewardType).toBe('[Type]');
    expect(unknown.id).toBe(syntheticRewardId('Future_28_01', 'free', 0));
  });

  it('does not trust a catalog entry whose level gate disagrees with the file', () => {
    const raw = parseV27();
    raw.seasonsData!.Orig.freeRewardsList![1].levelRequired = 9; // layout moved on
    const spd = loadSeasonSave(raw, catalog);
    expect(spd.seasonsData!.Orig.freeRewardsList![1].rewardType).toBe('[Type]');
    expect(spd.seasonsData!.Orig.freeRewardsList![0].rewardType).toBe('caps');
  });

  it('still loads without a catalog (every positional reward inert)', () => {
    const spd = loadSeasonSave(parseV27());
    expect(spd.seasonsData!.Orig.freeRewardsList![0].rewardType).toBe('[Type]');
    expect(seasonSaveSchema.safeParse(spd).success).toBe(true);
  });

  it('leaves a pre-v2.7.0 file (rewards carry their own data) exactly as it is', () => {
    const legacy = {
      seasonsData: {
        Orig: {
          freeRewardsList: [
            {
              id: 379731925,
              isPrestige: false,
              rewardType: 'lunchbox',
              dataValInt: 1,
              dataValString: 'regular',
              icon: 'BP_Lunchbox',
              claimedList: [0],
              levelRequired: 2,
            },
          ],
        },
      },
    } as SeasonSave;
    expect(loadSeasonSave(legacy, catalog)).toBe(legacy);
    expect(dehydrateSeasonSave(legacy)).toBe(legacy);
  });
});

describe('v2.7.0 positional rewards - export', () => {
  it('an untouched file round-trips byte-identical', () => {
    const spd = loadSeasonSave(parseV27(), catalog);
    expect(stringifyLossless(dehydrateSeasonSave(spd))).toBe(V27_TEXT);
  });

  it('writes only the claim change after an edit - never the catalog fields', () => {
    const ws = workspace(loadSeasonSave(parseV27(), catalog));
    const id = syntheticRewardId('Orig', 'free', 1);
    const claimed = claimReward(ws, data, 'Orig', 'free', id, 1);
    const out = JSON.parse(stringifyLossless(dehydrateSeasonSave(claimed.spd)));
    const expected = JSON.parse(V27_TEXT);
    expected.seasonsData.Orig.freeRewardsList[1].claimedList = [1];
    expect(out).toEqual(expected);
    expect(Object.keys(out.seasonsData.Orig.freeRewardsList[1])).toEqual([
      'claimedList',
      'levelRequired',
    ]);
  });
});

describe('v2.7.0 positional rewards - claims', () => {
  it('claiming grants the catalog reward and flags only that season record', () => {
    const ws = workspace(loadSeasonSave(parseV27(), catalog));
    const id = syntheticRewardId('Orig', 'free', 1);
    const next = claimReward(ws, data, 'Orig', 'free', id, 1);
    expect(next.save.vault?.storage?.resources?.StimPack).toBe(5);
    expect(isRewardClaimed(next.spd.seasonsData!.Orig.freeRewardsList![1], 1)).toBe(true);
    // The rerun shares the original's reward list in the game assets but NOT its claims.
    expect(isRewardClaimed(next.spd.seasonsData!.Orig_27_03.freeRewardsList![1], 1)).toBe(false);
    expect(next.spd.seasonsData!.Orig_27_03).toBe(ws.spd.seasonsData!.Orig_27_03);
  });

  it('unclaiming an editor-made claim reverses the grant', () => {
    const ws = workspace(loadSeasonSave(parseV27(), catalog));
    const id = syntheticRewardId('Orig', 'premium', 0);
    const claimed = claimReward(ws, data, 'Orig', 'premium', id, 1);
    expect(claimed.save.vault?.storage?.resources?.Nuka).toBe(1100);
    const back = unclaimReward(claimed, 'Orig', 'premium', id, 1);
    expect(back.save.vault?.storage?.resources?.Nuka).toBe(100);
    expect(stringifyLossless(dehydrateSeasonSave(back.spd))).toBe(V27_TEXT);
  });
});

describe('fresh model from a v2.7.0 catalog', () => {
  const at = (y: number, m: number, d: number) => new Date(y, m - 1, d, 12).getTime();

  it('picks the season whose window contains today, not a future one', () => {
    expect(defaultSeasonId(catalog, at(2026, 3, 20))).toBe('Orig');
    expect(defaultSeasonId(catalog, at(2026, 4, 13))).toBe('Orig'); // end date is inclusive
    expect(defaultSeasonId(catalog, at(2027, 3, 10))).toBe('Orig_27_03');
  });

  it('between seasons, falls back to the most recent one that has started', () => {
    expect(defaultSeasonId(catalog, at(2026, 11, 10))).toBe('Orig');
  });

  it('before every season (or with no dates), falls back to the last catalog season', () => {
    expect(defaultSeasonId(catalog, at(2025, 1, 1))).toBe('Orig_27_03');
  });

  it('exports in the v2.7.0 on-disk shape', () => {
    const now = at(2026, 3, 20);
    const spd = buildFreshSeasonSave(catalog, now);
    expect(spd.currentSeason).toBe('Orig');
    expect(buildFreshNvf(catalog, now).season?.id).toBe('Orig');
    expect(spd.seasonsData!.Orig.freeRewardsList![0].rewardType).toBe('caps');
    expect(spd.seasonsData!.Orig).not.toHaveProperty('ncqReward');
    const out = dehydrateSeasonSave(spd);
    expect(out.seasonsData!.Orig.freeRewardsList).toEqual([
      { claimedList: [], levelRequired: 2 },
      { claimedList: [], levelRequired: 3 },
    ]);
  });
});
