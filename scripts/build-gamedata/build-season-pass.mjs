// season-pass.json - the static Season Pass reward catalog.
//
// Two jobs in the app:
//   1. "Continue without a file": a fresh, fully-editable `spd.dat` working model is built
//      purely from this catalog (no user file).
//   2. Hydrating a v2.7.0+ `spd.dat`: from game v2.7.0 the file only stores per-save state
//      for each reward (`claimedList`, `levelRequired`); what the reward IS (type, item,
//      quantity, icon) comes from this catalog, matched by position in the track.
//
// Source (game v2.7.0+): the per-season ScriptableObjects in the AssetRipper export -
//
//   Season_<id>.asset              - m_id, m_startDateString, m_endDateString, m_seasonDataSet {guid}
//   SeasonDataSet_<name>.asset     - m_SeasonPassRewards {guid}, m_tokenRequirements {guid},
//                                    m_passPurchaseRewardsDefID
//   SeasonPassRewards_<name>.asset - m_freeRewards / m_premiumRewards: ordered {guid} lists
//   SeasonPassEntry_<...>.asset    - one reward: m_levelRequired, m_icon, m_isPrestige,
//                                    m_rewardType, m_data_ValueStr, m_data_ValueInt
//   SeasonPassTokenRequirements_<name>.asset - m_data (hex-encoded LE int32 array)
//   SeasonPassPurchaseRewards_<defID>.asset  - m_basePassTokens, m_premiumPassTokens
//
// Before v2.7.0 the rewards were copied out of a reference `spd.dat` at the repo root
// (the save file itself carried the static reward data + a numeric id per reward). That
// file is no longer needed: v2.7.0 saves do not contain the data, the assets do.
//
// Reward ids: v2.7.0 has no reward ids at all (rewards are positional), so each catalog
// reward gets a deterministic synthetic id from (season, track, index) - see
// src/domain/gamedata/seasonRewardId.ts, shared with the app so both sides agree.
import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { PATHS, readSource, writeOutput } from './lib/io.mjs';
import { syntheticRewardId } from '../../src/domain/gamedata/seasonRewardId.ts';

/** Read a single-line YAML scalar (`m_foo: bar`) from a ScriptableObject asset. */
function assetField(text, field) {
  return text.match(new RegExp(`^\\s*${field}:[ \\t]*(.*?)[ \\t]*$`, 'm'))?.[1] ?? null;
}

/** Read the guid out of an inline asset reference (`m_foo: {fileID: …, guid: …, type: 2}`). */
function assetRefGuid(text, field) {
  return text.match(new RegExp(`^\\s*${field}:\\s*\\{[^}]*guid:\\s*([0-9a-f]+)`, 'm'))?.[1] ?? null;
}

/**
 * Read an ordered list of asset references:
 *
 *   m_foo:
 *   - {fileID: 11400000, guid: abc…, type: 2}
 *   - {fileID: 11400000, guid: def…, type: 2}
 *
 * Returns the guids in file order (`m_foo: []` and a missing field both give []).
 */
function assetRefList(text, field) {
  const lines = text.split(/\r?\n/);
  const start = lines.findIndex((l) => new RegExp(`^\\s*${field}:\\s*$`).test(l));
  if (start === -1) return [];
  const out = [];
  for (let i = start + 1; i < lines.length; i++) {
    const m = lines[i].match(/^\s*-\s*\{[^}]*guid:\s*([0-9a-f]+)/);
    if (!m) break;
    out.push(m[1]);
  }
  return out;
}

/** Decode Unity's hex-encoded little-endian int32 array serialization. */
function decodeInt32Array(hex) {
  const out = [];
  for (let i = 0; i + 8 <= hex.length; i += 8) {
    const le = hex.slice(i, i + 8);
    out.push(parseInt(le.slice(6, 8) + le.slice(4, 6) + le.slice(2, 4) + le.slice(0, 2), 16));
  }
  return out;
}

/** Map asset guid -> asset path for MonoBehaviour files matching a filename prefix. */
function guidIndex(prefix) {
  const out = new Map();
  for (const f of readdirSync(PATHS.monoBehaviourDir)) {
    if (!f.startsWith(prefix) || !f.endsWith('.asset.meta')) continue;
    const guid = assetField(readSource(join(PATHS.monoBehaviourDir, f)), 'guid');
    if (guid) out.set(guid, join(PATHS.monoBehaviourDir, f.slice(0, -'.meta'.length)));
  }
  return out;
}

/** One SeasonPassEntry asset -> a catalog reward (the id is attached by the caller). */
function parseEntry(path) {
  const text = readSource(path);
  const num = (field) => {
    const raw = assetField(text, field);
    const n = Number(raw);
    if (raw === null || raw === '' || !Number.isFinite(n))
      throw new Error(`Season reward entry has no numeric ${field}:\n  ${path}`);
    return n;
  };
  const rewardType = assetField(text, 'm_rewardType');
  if (!rewardType) throw new Error(`Season reward entry has no m_rewardType:\n  ${path}`);
  return {
    isPrestige: num('m_isPrestige') === 1,
    rewardType,
    dataValInt: num('m_data_ValueInt'),
    dataValString: assetField(text, 'm_data_ValueStr') ?? '',
    icon: assetField(text, 'm_icon') ?? '',
    levelRequired: num('m_levelRequired'),
  };
}

export function buildSeasonPass() {
  if (!existsSync(PATHS.monoBehaviourDir)) readSource(PATHS.monoBehaviourDir); // throws the standard message

  const dataSetByGuid = guidIndex('SeasonDataSet_');
  const tokenReqByGuid = guidIndex('SeasonPassTokenRequirements_');
  const rewardsByGuid = guidIndex('SeasonPassRewards_');
  const entryByGuid = guidIndex('SeasonPassEntry_');

  // Pass-purchase token grants, keyed by the def id in the asset name (the datasets
  // reference them by m_passPurchaseRewardsDefID string, not by guid). Verified
  // v2.4.1-v2.7.0: 0 on the base (Premium) purchase, 25 on Premium Plus - which levels a
  // fresh pass straight to rank 5 against the token table.
  const passTokensByDefId = new Map();
  for (const f of readdirSync(PATHS.monoBehaviourDir)) {
    const m = f.match(/^SeasonPassPurchaseRewards_(\w+)\.asset$/);
    if (!m) continue;
    const text = readSource(join(PATHS.monoBehaviourDir, f));
    passTokensByDefId.set(m[1], {
      basePassTokens: Number(assetField(text, 'm_basePassTokens') ?? 0),
      premiumPassTokens: Number(assetField(text, 'm_premiumPassTokens') ?? 0),
    });
  }

  const seasons = [];
  for (const f of readdirSync(PATHS.monoBehaviourDir)) {
    if (!/^Season_\w+\.asset$/.test(f)) continue;
    const seasonPath = join(PATHS.monoBehaviourDir, f);
    const season = readSource(seasonPath);
    const id = assetField(season, 'm_id');
    if (!id) continue;

    const dataSetPath = dataSetByGuid.get(assetRefGuid(season, 'm_seasonDataSet'));
    if (!dataSetPath)
      throw new Error(`Season ${id} references no SeasonDataSet asset:\n  ${seasonPath}`);
    const dataSet = readSource(dataSetPath);

    // Token costs are indexed by CURRENT level (SeasonPassTokenManager, clamped) - so
    // [0,3,5,6,6,10,…] means level 1→2 costs 3 tokens, 2→3 costs 5, and so on.
    const tokenReqPath = tokenReqByGuid.get(assetRefGuid(dataSet, 'm_tokenRequirements'));
    const tokenRequirements = tokenReqPath
      ? decodeInt32Array(assetField(readSource(tokenReqPath), 'm_data') ?? '')
      : [];
    const passTokens = passTokensByDefId.get(assetField(dataSet, 'm_passPurchaseRewardsDefID')) ?? {
      basePassTokens: 0,
      premiumPassTokens: 0,
    };

    // Rerun seasons may point at the ORIGINAL season's reward list (v2.7.0:
    // UltraciteFever_27_03 shares UltraciteFever's) - the list is resolved per season, and
    // each season still gets its own ids because the id is derived from the season id.
    const rewardsPath = rewardsByGuid.get(assetRefGuid(dataSet, 'm_SeasonPassRewards'));
    if (!rewardsPath)
      throw new Error(`Season ${id} references no SeasonPassRewards asset:\n  ${dataSetPath}`);
    const rewardsText = readSource(rewardsPath);
    const track = (field, trackName) =>
      assetRefList(rewardsText, field).map((guid, index) => {
        const entryPath = entryByGuid.get(guid);
        if (!entryPath)
          throw new Error(
            `Season ${id} ${trackName}[${index}] references an unknown entry ${guid}`,
          );
        return { id: syntheticRewardId(id, trackName, index), ...parseEntry(entryPath) };
      });
    const freeRewards = track('m_freeRewards', 'free');
    const premiumRewards = track('m_premiumRewards', 'premium');
    if (freeRewards.length === 0 || premiumRewards.length === 0)
      throw new Error(
        `Season ${id} parsed an empty reward track - the asset layout changed:\n  ${rewardsPath}`,
      );

    // The season's rank cap is the highest level gate across both tracks (premium runs
    // 1..25 in every shipped season; prestige rewards are the last 5 premium ranks).
    const maxRank = [...freeRewards, ...premiumRewards].reduce(
      (m, r) => Math.max(m, r.levelRequired),
      0,
    );
    const startDate = assetField(season, 'm_startDateString') || undefined;
    const endDate = assetField(season, 'm_endDateString') || undefined;
    seasons.push({
      id,
      maxRank,
      tokenRequirements,
      ...passTokens,
      ...(startDate !== undefined ? { startDate } : {}),
      // End dates are compared by the game against local DateTime.Now (+ the spd.dat
      // debugTimeOffset); the Season tab's "skip past end of season" needs them.
      ...(endDate !== undefined ? { endDate } : {}),
      freeRewards,
      premiumRewards,
    });
  }

  // Chronological - the order the game itself lists them in spd.dat's seasonsData.
  seasons.sort(
    (a, b) => (a.startDate ?? '').localeCompare(b.startDate ?? '') || a.id.localeCompare(b.id),
  );

  // `ncqReward` was an inert per-season placeholder in pre-v2.7.0 files. The v2.7.0 game
  // no longer writes it for new seasons and there is no asset for it, so the catalog
  // carries none; files that still have one round-trip it untouched.
  return { ncqReward: null, seasons };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  writeOutput('season-pass.json', buildSeasonPass());
}
