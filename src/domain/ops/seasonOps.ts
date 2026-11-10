import type { SaveData, Item } from '../model/saveSchema.ts';
import {
  HYDRATED_REWARD_KEYS,
  HYDRATED_REWARD_MARK,
  type NvfData,
  type SeasonReward,
  type SeasonSave,
} from '../model/seasonSchema.ts';
import type { CatalogReward, Pet, UniqueDwellers } from '../gamedata/schemas.ts';
import type { SeasonCatalog } from '../gamedata/seasonCatalog.ts';
import { syntheticRewardId } from '../gamedata/seasonRewardId.ts';
import { petSpecialName } from '../gamedata/gameData.ts';
import { grantItems, removeStoredItemAt, addPet, type StackableType } from './storageOps.ts';
import {
  resources,
  setResource,
  consumableCounts,
  setConsumableCount,
  CONSUMABLE_CODES,
} from './vaultOps.ts';
import { addSpecialDweller, remove as removeDweller, hasDweller } from './dwellerOps.ts';
import { addRecipes, removeRecipes, recipeKnown } from './recipeOps.ts';

// Pure, immutable SEASON-PASS edit operations. Like the other ops modules these are `(workspace, …args) =>
// SeasonWorkspace` with no mutation - structural sharing keeps untouched subtrees
// (and every `LosslessInt` tick) by reference, so the store records one season edit
// as one cheap combined undo snapshot. A no-op returns the SAME workspace reference.
//
// The headline mechanic is CLAIM: claiming a reward BOTH grants the item into
// the `.sav` working model (delegating to the existing storage/dweller/recipe/vault ops)
// AND sets the `spd.dat` claim flag, within one workspace transition. UNCLAIM reverses
// the exact instance the claim added - using a per-claim REVERSAL HANDLE captured at
// claim time and kept in the editor-only `handles` map (never written to any file).
//
// Claim and level are ORTHOGONAL: claiming never auto-levels; level is
// an explicit setter, and the "Max" actions set it deliberately.
//
// This module needs game data (weapon/outfit/pet/dweller/recipe resolution) for grants;
// it is passed in by the caller (the UI's gameData), mirroring how the other ops take
// already-resolved values rather than fetching. Pure: no React/DOM.

/**
 * The default claim (vault-slot) index. A reward's `claimedList` holds the VAULT SLOT
 * INDEXES that have claimed it (Vault1.sav → 0 … Vault4.sav → 3) - confirmed v2.5.0,
 * where the seasonal vault claims from slot 3 while the rerun season records arrive
 * pre-seeded with the original seasons' slot-0 claims. Claim ops and predicates take
 * the paired vault's index (derive it with {@link claimIndexFromSaveFileName});
 * 0 preserves the pre-2.5.0 single-vault behavior.
 */
export const DEFAULT_CLAIM_INDEX = 0;

/** Derive the claim (vault-slot) index from a `.sav` file name: "Vault4.sav" → 3.
 *  Unrecognized names fall back to {@link DEFAULT_CLAIM_INDEX}. */
export function claimIndexFromSaveFileName(fileName: string | null): number {
  const match = fileName?.match(/vault(\d+)/i);
  const slot = match ? Number(match[1]) - 1 : DEFAULT_CLAIM_INDEX;
  return Number.isInteger(slot) && slot >= 0 ? slot : DEFAULT_CLAIM_INDEX;
}

/** Caps live under `vault.storage.resources.Nuka`, NOT a `Caps` key. */
const CAPS_KEY = 'Nuka';
/** Stimpacks are a vault resource keyed `StimPack`. */
const STIMPACK_KEY = 'StimPack';

/** `lunchbox` reward sub-type (`dataValString`) → consumable code. */
const LUNCHBOX_SUBTYPE_CODES: Record<string, number> = {
  regular: CONSUMABLE_CODES.Lunchbox,
  mrhandy: CONSUMABLE_CODES.MrHandy,
  petcarrier: CONSUMABLE_CODES.PetCarrier,
};

/** Which reward track a reward lives in. */
export type SeasonTrack = 'free' | 'premium';

const REWARD_LIST_KEY = {
  free: 'freeRewardsList',
  premium: 'premiumRewardsList',
} as const;

/**
 * The reversal info captured when a claim grants into the `.sav`, so an unclaim removes
 * the EXACT instance the claim added - never an item the user already owned.
 * Editor-only: lives in the workspace `handles` map, never serialized to any file.
 */
export type ReversalHandle =
  | { kind: 'resource'; key: string; amount: number }
  | { kind: 'consumable'; code: number; amount: number }
  | { kind: 'item'; itemType: StackableType; id: string }
  | { kind: 'pet'; index: number; id: string }
  | { kind: 'dweller'; serializeId: number }
  | { kind: 'recipe'; id: string; added: boolean }
  | { kind: 'none' };

/** Reward key → the reversal handle for the claim the editor made this session. */
export type ReversalHandles = Record<string, ReversalHandle>;

/**
 * The slice of game data the reward resolver needs to grant items (interface-segregated
 * from the full `GameData`, which satisfies it). `weaponById`/`outfitById` are only probed
 * for id existence; `petById`/`uniqueDwellers` supply the full entry the grant ops consume.
 */
export interface RewardResolverData {
  weaponById: ReadonlyMap<string, unknown>;
  outfitById: ReadonlyMap<string, unknown>;
  petById: ReadonlyMap<string, Pet>;
  uniqueDwellers: UniqueDwellers;
}

/**
 * The editor's combined season working state. `save` and `spd`/`nvf` move together so a
 * claim is one atomic transition (and one undo entry in the store). `handles` is the
 * editor-only reversal table - it is never part of an exported file.
 */
export interface SeasonWorkspace {
  /** The `.sav` working model (rewards are granted into this). */
  save: SaveData;
  /** The `spd.dat` working model (claim/level/premium state). */
  spd: SeasonSave;
  /** The `nvf.dat` working model (current-season pointer; kept in sync with `spd`). */
  nvf: NvfData;
  /** Per-claim reversal handles, keyed by {@link rewardKey}. Editor-only - never exported. */
  handles: ReversalHandles;
}

/** Stable key for a reward's reversal handle. */
function rewardKey(seasonId: string, track: SeasonTrack, rewardId: number): string {
  return `${seasonId}#${track}#${rewardId}`;
}

// --- inventory helpers (read-only) ----------------------------------------------

function inventoryItems(save: SaveData): Item[] {
  const items = save.vault?.inventory?.items;
  return Array.isArray(items) ? items : [];
}

// --- structural-sharing writers for spd ------------------------------------------

function withRecord(
  spd: SeasonSave,
  seasonId: string,
  record: NonNullable<SeasonSave['seasonsData']>[string],
): SeasonSave {
  return { ...spd, seasonsData: { ...spd.seasonsData, [seasonId]: record } };
}

/**
 * Set/clear a claim index on EVERY reward carrying this id, across ALL season records.
 * Rerun seasons (v2.5.0) reuse the original seasons' reward ids, and the game keeps
 * same-id rewards' claim state in sync across records (confirmed in a real spd.dat: a
 * claim made in NewVegasA_26_07 also appears in the NewVegasA record). Mirroring the
 * flag matches that invariant so exported files agree with what the game would write.
 * A v2.7.0+ file has no reward ids: its rewards get a synthetic id that is unique per
 * season record (seasonRewardId.ts), so this touches exactly one reward there - matching
 * v2.7.0, where a rerun keeps claim state separate from its original (confirmed in a real
 * v2.7.0 spd.dat: UltraciteFever and UltraciteFever_27_03 share one reward list in the
 * game assets yet carry different claims).
 * Structural sharing: untouched records/lists keep their references; a no-op returns
 * the same `spd`.
 */
function withClaimFlagById(
  spd: SeasonSave,
  rewardId: number,
  claimIndex: number,
  on: boolean,
): SeasonSave {
  const seasonsData = spd.seasonsData;
  if (!seasonsData) return spd;
  let anyChanged = false;
  const nextData: NonNullable<SeasonSave['seasonsData']> = {};
  for (const [seasonId, record] of Object.entries(seasonsData)) {
    let recordChanged = false;
    const apply = (list: SeasonReward[] | undefined): SeasonReward[] | undefined => {
      if (!Array.isArray(list)) return list;
      let listChanged = false;
      const next = list.map((r) => {
        if (r.id !== rewardId || r.claimedList.includes(claimIndex) === on) return r;
        listChanged = true;
        return {
          ...r,
          claimedList: on
            ? [...r.claimedList, claimIndex]
            : r.claimedList.filter((i) => i !== claimIndex),
        };
      });
      if (listChanged) recordChanged = true;
      return listChanged ? next : list;
    };
    const free = apply(record.freeRewardsList);
    const premium = apply(record.premiumRewardsList);
    nextData[seasonId] = recordChanged
      ? {
          ...record,
          ...(free !== undefined ? { freeRewardsList: free } : {}),
          ...(premium !== undefined ? { premiumRewardsList: premium } : {}),
        }
      : record;
    if (recordChanged) anyChanged = true;
  }
  return anyChanged ? { ...spd, seasonsData: nextData } : spd;
}

// --- reward → grant resolution ----------------------------------

interface GrantResult {
  save: SaveData;
  handle: ReversalHandle;
}

/** Resolve a unique/special dweller catalog entry from a reward's full display name. */
function resolveDweller(
  data: RewardResolverData,
  displayName: string,
): { key: string; entry: UniqueDwellers[string] } | null {
  const target = displayName.trim();
  // Prefer an exact "name + lastName" match; fall back to the whole name living in `name`
  // alone (entries like "Ghoul King", "Scribe Valdez", "76 Overseer").
  for (const [key, entry] of Object.entries(data.uniqueDwellers)) {
    if (`${entry.name} ${entry.lastName}`.trim() === target) return { key, entry };
  }
  for (const [key, entry] of Object.entries(data.uniqueDwellers)) {
    if (entry.name.trim() === target) return { key, entry };
  }
  return null;
}

/**
 * Apply a reward's grant to the `.sav` working model and return the new save plus the
 * reversal handle for an exact unclaim. Quantities follow the file verbatim
 * (`cur + dataValInt`) - a zero-quantity reward (e.g. some `lunchbox:mrhandy`) grants
 * nothing but still claims, exactly as the data dictates. Unresolved/inert rewards
 * (the `"[Type]"` placeholder, or an item id absent from game data) grant nothing and
 * carry a `'none'` handle so the claim is a pure flag flip.
 */
function grantReward(save: SaveData, reward: SeasonReward, data: RewardResolverData): GrantResult {
  const amount = Math.trunc(reward.dataValInt);
  switch (reward.rewardType) {
    case 'caps': {
      const cur = resources(save)[CAPS_KEY] ?? 0;
      return {
        save: setResource(save, CAPS_KEY, cur + amount),
        handle: { kind: 'resource', key: CAPS_KEY, amount },
      };
    }
    case 'stimpack': {
      const cur = resources(save)[STIMPACK_KEY] ?? 0;
      return {
        save: setResource(save, STIMPACK_KEY, cur + amount),
        handle: { kind: 'resource', key: STIMPACK_KEY, amount },
      };
    }
    case 'lunchbox': {
      const code = LUNCHBOX_SUBTYPE_CODES[reward.dataValString];
      if (code === undefined) return { save, handle: { kind: 'none' } };
      const cur = consumableCounts(save)[code] ?? 0;
      return {
        save: setConsumableCount(save, code, cur + amount),
        handle: { kind: 'consumable', code, amount },
      };
    }
    case 'weapon':
    case 'outfit': {
      const itemType: StackableType = reward.rewardType === 'weapon' ? 'Weapon' : 'Outfit';
      const id = reward.dataValString;
      const known = itemType === 'Weapon' ? data.weaponById.has(id) : data.outfitById.has(id);
      if (!known) return { save, handle: { kind: 'none' } };
      return { save: grantItems(save, itemType, id, 1), handle: { kind: 'item', itemType, id } };
    }
    case 'pet': {
      const id = reward.dataValString;
      const pet = data.petById.get(id);
      if (!pet) return { save, handle: { kind: 'none' } };
      // Grant the best legal roll (a recovery/cheat tool - "max" is the friendly default).
      const next = addPet(save, {
        petId: id,
        uniqueName: petSpecialName(pet),
        bonus: pet.bonus,
        bonusValue: pet.bonusMax,
      });
      // addPet appends, so the new instance is the last inventory entry.
      const index = inventoryItems(next).length - 1;
      return { save: next, handle: { kind: 'pet', index, id } };
    }
    case 'dweller': {
      const resolved = resolveDweller(data, reward.dataValString);
      if (!resolved) return { save, handle: { kind: 'none' } };
      const next = addSpecialDweller(save, resolved.key, resolved.entry);
      // addSpecialDweller bumps `dwellers.id` to the new dweller's serializeId.
      const serializeId = next.dwellers?.id;
      if (typeof serializeId !== 'number') return { save: next, handle: { kind: 'none' } };
      return { save: next, handle: { kind: 'dweller', serializeId } };
    }
    case 'theme': {
      const id = reward.dataValString;
      // Only flag for removal on unclaim if THIS claim actually added the recipe (don't
      // strip a theme the user already owned).
      const added = !recipeKnown(save, id);
      return { save: addRecipes(save, [id]), handle: { kind: 'recipe', id, added } };
    }
    default:
      // Inert placeholder ("[Type]") or any unknown type - claim is a flag flip only.
      return { save, handle: { kind: 'none' } };
  }
}

/** Reverse a captured grant. Pure; clamps resources/consumables at 0; no-op if absent. */
function reverseGrant(save: SaveData, handle: ReversalHandle): SaveData {
  switch (handle.kind) {
    case 'resource': {
      const cur = resources(save)[handle.key] ?? 0;
      return setResource(save, handle.key, cur - handle.amount); // setResource floors at 0
    }
    case 'consumable': {
      const cur = consumableCounts(save)[handle.code] ?? 0;
      return setConsumableCount(save, handle.code, Math.max(0, cur - handle.amount));
    }
    case 'item': {
      const items = inventoryItems(save);
      const idx = items.findIndex((i) => i.type === handle.itemType && i.id === handle.id);
      return idx === -1 ? save : removeStoredItemAt(save, idx);
    }
    case 'pet': {
      const items = inventoryItems(save);
      // Prefer the captured index when it still points at the matching pet; otherwise
      // remove the LAST matching pet (robust if storage shifted since the claim).
      const at = items[handle.index];
      if (at && at.type === 'Pet' && at.id === handle.id) {
        return removeStoredItemAt(save, handle.index);
      }
      for (let i = items.length - 1; i >= 0; i--) {
        if (items[i].type === 'Pet' && items[i].id === handle.id) {
          return removeStoredItemAt(save, i);
        }
      }
      return save;
    }
    case 'dweller':
      return hasDweller(save, handle.serializeId) ? removeDweller(save, handle.serializeId) : save;
    case 'recipe':
      return handle.added ? removeRecipes(save, [handle.id]) : save;
    case 'none':
      return save;
  }
}

// --- locate a reward in the workspace -------------------------------------------

interface RewardLocation {
  reward: SeasonReward;
}

function locateReward(
  spd: SeasonSave,
  seasonId: string,
  track: SeasonTrack,
  rewardId: number,
): RewardLocation | null {
  const record = spd.seasonsData?.[seasonId];
  if (!record) return null;
  const list = record[REWARD_LIST_KEY[track]];
  if (!Array.isArray(list)) return null;
  const reward = list.find((r) => r.id === rewardId);
  return reward ? { reward } : null;
}

/** True if a reward's `claimedList` holds the given vault-slot claim index. */
export function isRewardClaimed(
  reward: SeasonReward,
  claimIndex: number = DEFAULT_CLAIM_INDEX,
): boolean {
  return reward.claimedList.includes(claimIndex);
}

/** The season id under which the Ultracite Mine / Ultracite Weapon Workshop function. */
export const ULTRACITE_SEASON_ID = 'UltraciteFever';

/**
 * True when Ultracite Fever is the ACTIVE season (`spd.currentSeason`). The game only lets the
 * Ultracite Mine produce ultracite and the Ultracite Weapon Workshop craft while this season is
 * running; in any other vault (no season loaded, or a different active season) those rooms are
 * inert. Null spd (no season model loaded) is not active.
 */
export function isUltraciteSeasonActive(spd: SeasonSave | null): boolean {
  const current = spd?.currentSeason;
  if (typeof current !== 'string') return false;
  // Reruns are date-suffixed ("UltraciteFever_27_03") and ship the same ULTRACITE_* feature
  // flags as the original season (SeasonDataSet assets, v2.7.0).
  return current === ULTRACITE_SEASON_ID || current.startsWith(`${ULTRACITE_SEASON_ID}_`);
}

// --- claim / unclaim ---------------------------------------------------

/**
 * Claim a reward: grant the item into the `.sav` and set the `spd.dat` claim flag, in one
 * transition. Captures a reversal handle for an exact unclaim. No-op (same workspace) if
 * the reward is missing or already claimed.
 */
export function claimReward(
  ws: SeasonWorkspace,
  data: RewardResolverData,
  seasonId: string,
  track: SeasonTrack,
  rewardId: number,
  claimIndex: number = DEFAULT_CLAIM_INDEX,
): SeasonWorkspace {
  const loc = locateReward(ws.spd, seasonId, track, rewardId);
  if (!loc || isRewardClaimed(loc.reward, claimIndex)) return ws;

  const { save, handle } = grantReward(ws.save, loc.reward, data);
  return {
    save,
    // The flag is mirrored to every same-id reward (rerun seasons share reward ids with
    // the originals), but the item is granted ONCE - same-id rewards are one logical
    // reward, which is exactly how the game claims them.
    spd: withClaimFlagById(ws.spd, rewardId, claimIndex, true),
    nvf: ws.nvf,
    handles: { ...ws.handles, [rewardKey(seasonId, track, rewardId)]: handle },
  };
}

/**
 * Unclaim a reward: clear the `spd.dat` claim flag and, IF the editor made this claim this
 * session (a stored handle), reverse the exact grant in the `.sav`. A reward that was
 * already claimed on import (no handle - e.g. an uploaded file's game-granted reward) only
 * has its flag cleared, never touching the user's `.sav` items. No-op if not claimed.
 */
export function unclaimReward(
  ws: SeasonWorkspace,
  seasonId: string,
  track: SeasonTrack,
  rewardId: number,
  claimIndex: number = DEFAULT_CLAIM_INDEX,
): SeasonWorkspace {
  const loc = locateReward(ws.spd, seasonId, track, rewardId);
  if (!loc || !isRewardClaimed(loc.reward, claimIndex)) return ws;

  const key = rewardKey(seasonId, track, rewardId);
  const handle = ws.handles[key];
  const save = handle ? reverseGrant(ws.save, handle) : ws.save;
  const handles = { ...ws.handles };
  delete handles[key];
  return {
    save,
    spd: withClaimFlagById(ws.spd, rewardId, claimIndex, false),
    nvf: ws.nvf,
    handles,
  };
}

/** Toggle a reward's claim state (the board-cell click). */
export function toggleReward(
  ws: SeasonWorkspace,
  data: RewardResolverData,
  seasonId: string,
  track: SeasonTrack,
  rewardId: number,
  claimIndex: number = DEFAULT_CLAIM_INDEX,
): SeasonWorkspace {
  const loc = locateReward(ws.spd, seasonId, track, rewardId);
  if (!loc) return ws;
  return isRewardClaimed(loc.reward, claimIndex)
    ? unclaimReward(ws, seasonId, track, rewardId, claimIndex)
    : claimReward(ws, data, seasonId, track, rewardId, claimIndex);
}

// --- batch helpers (one combined undo entry in the store) ------------------------

function rewardIds(spd: SeasonSave, seasonId: string, track: SeasonTrack): number[] {
  const record = spd.seasonsData?.[seasonId];
  const list = record?.[REWARD_LIST_KEY[track]];
  return Array.isArray(list) ? list.map((r) => r.id) : [];
}

/**
 * Claim every currently-unclaimed reward the user is entitled to: the whole free track,
 * plus the premium track only when premium is unlocked (matches the board's grant gate).
 */
export function claimUnclaimed(
  ws: SeasonWorkspace,
  data: RewardResolverData,
  seasonId: string,
  claimIndex: number = DEFAULT_CLAIM_INDEX,
): SeasonWorkspace {
  let next = ws;
  const premiumUnlocked = next.spd.seasonsData?.[seasonId]?.isPremium === true;
  for (const id of rewardIds(next.spd, seasonId, 'free')) {
    next = claimReward(next, data, seasonId, 'free', id, claimIndex);
  }
  if (premiumUnlocked) {
    for (const id of rewardIds(next.spd, seasonId, 'premium')) {
      next = claimReward(next, data, seasonId, 'premium', id, claimIndex);
    }
  }
  return next;
}

/**
 * Claim EVERYTHING in a season: unlock premium + premium-plus, then claim both tracks.
 * (Premium rewards aren't claimable without premium, so "claim all" implies unlocking it.)
 */
export function claimAll(
  ws: SeasonWorkspace,
  data: RewardResolverData,
  seasonId: string,
  claimIndex: number = DEFAULT_CLAIM_INDEX,
): SeasonWorkspace {
  let next = setPremiumPlus(ws, seasonId, true);
  for (const track of ['free', 'premium'] as const) {
    for (const id of rewardIds(next.spd, seasonId, track)) {
      next = claimReward(next, data, seasonId, track, id, claimIndex);
    }
  }
  return next;
}

/** Highest level gate across a season's rewards - its rank cap (25 in shipped seasons). */
function maxRankOf(spd: SeasonSave, seasonId: string): number {
  const record = spd.seasonsData?.[seasonId];
  if (!record) return 0;
  let max = 0;
  for (const listKey of [REWARD_LIST_KEY.free, REWARD_LIST_KEY.premium] as const) {
    for (const reward of record[listKey] ?? []) max = Math.max(max, reward.levelRequired);
  }
  return max;
}

/**
 * Max a season: claim everything, set `maxRankAchieved` to the rank cap, and - when this is
 * the active season - set `currentLevel`/`battlepassWindowLastObservedLevel` to the cap too.
 */
export function maxSeason(
  ws: SeasonWorkspace,
  data: RewardResolverData,
  seasonId: string,
  claimIndex: number = DEFAULT_CLAIM_INDEX,
): SeasonWorkspace {
  const cap = maxRankOf(ws.spd, seasonId);
  let next = claimAll(ws, data, seasonId, claimIndex);
  next = setMaxRank(next, seasonId, cap);
  if (next.spd.currentSeason === seasonId) next = setLevel(next, cap);
  return next;
}

/** Max every season present in the workspace (one combined undo entry in the store). */
export function maxAllSeasons(
  ws: SeasonWorkspace,
  data: RewardResolverData,
  claimIndex: number = DEFAULT_CLAIM_INDEX,
): SeasonWorkspace {
  let next = ws;
  for (const seasonId of Object.keys(next.spd.seasonsData ?? {})) {
    next = maxSeason(next, data, seasonId, claimIndex);
  }
  return next;
}

// --- "already spent" predicates ----------------------------------------------------
// The quick-action buttons disable on these: once a batch action can't add anything the
// button is spent, and clicking it again would only confuse (nothing visibly happens).

/** True when a season's track list is fully claimed (empty lists count as claimed). */
function trackClaimed(
  spd: SeasonSave,
  seasonId: string,
  track: SeasonTrack,
  claimIndex: number,
): boolean {
  const record = spd.seasonsData?.[seasonId];
  return (record?.[REWARD_LIST_KEY[track]] ?? []).every((r) => isRewardClaimed(r, claimIndex));
}

/**
 * True when everything {@link claimUnclaimed} is entitled to claim is already claimed:
 * the whole free track, plus the premium track when premium is unlocked.
 */
export function isEntitledClaimed(
  spd: SeasonSave,
  seasonId: string,
  claimIndex: number = DEFAULT_CLAIM_INDEX,
): boolean {
  const premiumUnlocked = spd.seasonsData?.[seasonId]?.isPremium === true;
  return (
    trackClaimed(spd, seasonId, 'free', claimIndex) &&
    (!premiumUnlocked || trackClaimed(spd, seasonId, 'premium', claimIndex))
  );
}

/**
 * True when {@link claimAll} would change nothing: both tracks fully claimed and the
 * premium + plus unlocks it performs are already in place.
 */
export function isSeasonFullyClaimed(
  spd: SeasonSave,
  seasonId: string,
  claimIndex: number = DEFAULT_CLAIM_INDEX,
): boolean {
  const record = spd.seasonsData?.[seasonId];
  return (
    record?.isPremium === true &&
    record.isPremiumPlus === true &&
    trackClaimed(spd, seasonId, 'free', claimIndex) &&
    trackClaimed(spd, seasonId, 'premium', claimIndex)
  );
}

/**
 * True when {@link maxSeason} has nothing left to add: fully claimed, `maxRankAchieved`
 * at (or past) the rank cap, and - for the active season - `currentLevel` there too.
 */
export function isSeasonMaxed(
  spd: SeasonSave,
  seasonId: string,
  claimIndex: number = DEFAULT_CLAIM_INDEX,
): boolean {
  if (!isSeasonFullyClaimed(spd, seasonId, claimIndex)) return false;
  const cap = maxRankOf(spd, seasonId);
  const record = spd.seasonsData?.[seasonId];
  if ((record?.maxRankAchieved ?? 0) < cap) return false;
  return spd.currentSeason !== seasonId || (spd.currentLevel ?? 0) >= cap;
}

/** True when every season in the workspace is maxed ({@link maxAllSeasons} is spent). */
export function areAllSeasonsMaxed(
  spd: SeasonSave,
  claimIndex: number = DEFAULT_CLAIM_INDEX,
): boolean {
  return Object.keys(spd.seasonsData ?? {}).every((id) => isSeasonMaxed(spd, id, claimIndex));
}

// --- status setters --------------------------------------------------------------

/** Set the active-season level (`currentLevel`), keeping `battlepassWindowLastObservedLevel`
 *  in lock-step. Floors at 0; the UI clamps to the rank cap unless out-of-range is allowed. */
export function setLevel(ws: SeasonWorkspace, level: number): SeasonWorkspace {
  const value = Math.max(0, Math.trunc(level));
  if (ws.spd.currentLevel === value && ws.spd.battlepassWindowLastObservedLevel === value) {
    return ws;
  }
  return {
    ...ws,
    spd: { ...ws.spd, currentLevel: value, battlepassWindowLastObservedLevel: value },
  };
}

/** Set the active-season token count (`currentTokens`). Floors at 0. */
export function setTokens(ws: SeasonWorkspace, tokens: number): SeasonWorkspace {
  const value = Math.max(0, Math.trunc(tokens));
  if (ws.spd.currentTokens === value) return ws;
  return { ...ws, spd: { ...ws.spd, currentTokens: value } };
}

/** Set a season's `maxRankAchieved`. Floors at 0. */
export function setMaxRank(ws: SeasonWorkspace, seasonId: string, rank: number): SeasonWorkspace {
  const record = ws.spd.seasonsData?.[seasonId];
  if (!record) return ws;
  const value = Math.max(0, Math.trunc(rank));
  if (record.maxRankAchieved === value) return ws;
  return { ...ws, spd: withRecord(ws.spd, seasonId, { ...record, maxRankAchieved: value }) };
}

/**
 * Keep `spd.purchaseHistory.SeasonPassLunchboxClaims` in sync with a season's premium
 * flags. This list is the game's record of PURCHASED passes: on vault load the game
 * compares it against the `.sav`'s own claims and delivers the season's goodie-box
 * lunchbox to any vault that hasn't received it yet (Vault.GrantEligibleSeasonalLunchboxes,
 * verified v2.4.1). Recording the purchase here is what makes the game grant the box.
 * When both flags are off the entry is removed (nothing purchased).
 */
function syncPurchaseHistory(
  spd: SeasonSave,
  seasonId: string,
  premium: boolean,
  premiumPlus: boolean,
): SeasonSave {
  const list = spd.purchaseHistory?.SeasonPassLunchboxClaims ?? [];
  const existing = list.find((e) => e.ID === seasonId);
  const wantEntry = premium || premiumPlus;
  if (!wantEntry && !existing) return spd;
  if (existing && existing.Premium === premium && (existing.PremiumPlus ?? false) === premiumPlus) {
    return spd;
  }
  const next = wantEntry
    ? existing
      ? list.map((e) =>
          e.ID === seasonId ? { ...e, Premium: premium, PremiumPlus: premiumPlus } : e,
        )
      : [...list, { ID: seasonId, Premium: premium, PremiumPlus: premiumPlus }]
    : list.filter((e) => e.ID !== seasonId);
  return {
    ...spd,
    purchaseHistory: { ...spd.purchaseHistory, SeasonPassLunchboxClaims: next },
  };
}

/**
 * Toggle a season's premium track. Turning premium OFF also clears premium-plus (plus
 * without premium is an invalid state). The purchase-history record moves with the flags
 * so the game's on-load goodie-box grant matches the ownership state (see
 * {@link syncPurchaseHistory}).
 */
export function setPremium(ws: SeasonWorkspace, seasonId: string, on: boolean): SeasonWorkspace {
  const record = ws.spd.seasonsData?.[seasonId];
  if (!record) return ws;
  const nextPlus = on ? (record.isPremiumPlus ?? false) : false;
  if (record.isPremium === on && (record.isPremiumPlus ?? false) === nextPlus) return ws;
  const spd = withRecord(ws.spd, seasonId, { ...record, isPremium: on, isPremiumPlus: nextPlus });
  return { ...ws, spd: syncPurchaseHistory(spd, seasonId, on, nextPlus) };
}

/**
 * Toggle a season's premium-plus track. Turning plus ON also unlocks premium (plus implies
 * premium ownership). Purchase history follows the flags (see {@link syncPurchaseHistory}).
 */
export function setPremiumPlus(
  ws: SeasonWorkspace,
  seasonId: string,
  on: boolean,
): SeasonWorkspace {
  const record = ws.spd.seasonsData?.[seasonId];
  if (!record) return ws;
  const nextPremium = on ? true : (record.isPremium ?? false);
  if ((record.isPremiumPlus ?? false) === on && (record.isPremium ?? false) === nextPremium) {
    return ws;
  }
  const spd = withRecord(ws.spd, seasonId, {
    ...record,
    isPremiumPlus: on,
    isPremium: nextPremium,
  });
  return { ...ws, spd: syncPurchaseHistory(spd, seasonId, nextPremium, on) };
}

/**
 * Apply the in-game pass-purchase token grant (ShopWindow → SeasonPassTokenManager,
 * verified v2.4.1): add `amount` tokens to the ACTIVE season, then convert tokens to
 * levels exactly like the game - while the current level's cost (`tokenRequirements`
 * indexed by CURRENT level) is met, consume it and level up. Premium Plus grants 25
 * tokens in every shipped season, walking a fresh pass from level 1 to rank 5 ("instantly
 * skips the first levels"); the base Premium purchase grants 0. `maxRankAchieved` rises
 * with the new level. No-op for a non-active season (level/tokens are top-level
 * active-season fields, and the game only sells the active season's pass) or when
 * already at the rank cap (the game's AddTokens gate).
 */
export function grantPassTokens(
  ws: SeasonWorkspace,
  seasonId: string,
  amount: number,
  tokenRequirements: readonly number[],
): SeasonWorkspace {
  const grant = Math.trunc(amount);
  if (ws.spd.currentSeason !== seasonId || grant <= 0 || tokenRequirements.length === 0) return ws;
  const cap = tokenRequirements.length;
  let level = ws.spd.currentLevel ?? 1;
  if (level >= cap) return ws; // at max reward level the game ignores added tokens
  let tokens = (ws.spd.currentTokens ?? 0) + grant;
  const costOf = (lvl: number): number =>
    tokenRequirements[Math.min(Math.max(lvl, 0), cap - 1)] ?? 0;
  while (costOf(level) > 0 && tokens >= costOf(level) && level < cap) {
    tokens -= costOf(level);
    level++;
  }
  let next: SeasonWorkspace = {
    ...ws,
    spd: {
      ...ws.spd,
      currentLevel: level,
      currentTokens: tokens,
      battlepassWindowLastObservedLevel: level,
    },
  };
  const record = next.spd.seasonsData?.[seasonId];
  if (record && (record.maxRankAchieved ?? 0) < level) {
    next = {
      ...next,
      spd: withRecord(next.spd, seasonId, { ...record, maxRankAchieved: level }),
    };
  }
  return next;
}

/**
 * Switch the active season: point `spd.currentSeason` and `nvf.season.id` at `seasonId`
 * (they must stay in sync). `nvf.season.type` is preserved
 * (the per-season type enum is not carried in `spd.dat`/the catalog).
 */
export function switchSeason(ws: SeasonWorkspace, seasonId: string): SeasonWorkspace {
  const idInSync = ws.spd.currentSeason === seasonId && ws.nvf.season?.id === seasonId;
  if (idInSync) return ws;
  return {
    ...ws,
    spd: { ...ws.spd, currentSeason: seasonId },
    nvf: { ...ws.nvf, season: { ...ws.nvf.season, id: seasonId } },
  };
}

// --- fresh model construction ("Continue without a file") -------------

/**
 * A reward laid out by the catalog: the per-save fields first (the only ones a v2.7.0 file
 * stores), then the catalog's static data, tagged as hydrated so the export writes the
 * game's own v2.7.0 shape (see {@link dehydrateSeasonSave}).
 */
function freshReward(reward: CatalogReward): SeasonReward {
  const { levelRequired, ...staticData } = reward;
  return { claimedList: [], levelRequired, ...staticData, [HYDRATED_REWARD_MARK]: true };
}

/** "YYYY-MM-DD" → local-midnight epoch ms (the game compares season dates in local time). */
function localDateMs(date: string | undefined): number | null {
  const m = date?.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  return m ? new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])).getTime() : null;
}

/**
 * The season a fresh model should treat as active at `nowMs`: the one whose scheduled
 * window contains now, else the most recent one that has already started, else the last
 * catalog season (catalogs without dates). The catalog can list seasons that have not
 * started yet (v2.7.0 ships UltraciteFever_27_03 months ahead), so "last" alone is wrong.
 */
export function defaultSeasonId(catalog: SeasonCatalog, nowMs: number = Date.now()): string {
  let started: string | null = null;
  for (const entry of catalog.seasons) {
    const start = localDateMs(entry.startDate);
    if (start === null || start > nowMs) continue;
    started = entry.id; // catalog order is chronological
    const end = localDateMs(entry.endDate);
    if (end !== null && nowMs < end + 86_400_000) return entry.id;
  }
  return started ?? catalog.seasonIds[catalog.seasonIds.length - 1] ?? '';
}

/** The empty 4×5 leaderboard claim grid, stringified the way the game stores it. */
const EMPTY_LEADERBOARD_GRID = JSON.stringify(
  Array.from({ length: 4 }, () => Array.from({ length: 5 }, () => false)),
);

/**
 * Build a fresh, fully-editable `spd.dat` working model from the static catalog (nothing
 * claimed, level 1, no premium). The active season defaults to the most recent catalog
 * season. Reward ids/codes are taken verbatim from the catalog - never regenerated.
 */
export function buildFreshSeasonSave(
  catalog: SeasonCatalog,
  nowMs: number = Date.now(),
): SeasonSave {
  const currentSeason = defaultSeasonId(catalog, nowMs);
  const seasonsData: NonNullable<SeasonSave['seasonsData']> = {};
  for (const entry of catalog.seasons) {
    seasonsData[entry.id] = {
      isPremium: false,
      isPremiumPlus: false,
      isFirstLogin: true,
      hasBeenWarnedAboutSeasonEnd: false,
      leaderboardData: {
        score: 0,
        claimedRewards: EMPTY_LEADERBOARD_GRID,
        lastRewardLevelUnlocked: -1,
      },
      maxRankAchieved: 0,
      // Pre-v2.7.0 catalogs carry the inert ncqReward placeholder; v2.7.0 has none.
      ...(catalog.ncqReward ? { ncqReward: { ...catalog.ncqReward, claimedList: [] } } : {}),
      freeRewardsList: entry.freeRewards.map(freshReward),
      premiumRewardsList: entry.premiumRewards.map(freshReward),
    };
  }
  return {
    schemaVersion: 2,
    currentSeason,
    currentLevel: 1,
    currentTokens: 0,
    battlepassWindowLastObservedLevel: 1,
    saveTime: 0,
    seasonStartSplashLastDisplayTime: 0,
    lastPremiumUpsellTime: 0,
    debugTimeOffset: 0,
    purchaseHistory: { SeasonPassLunchboxClaims: [] },
    seasonsData,
  };
}

/** Build a fresh `nvf.dat` pointer for the catalog's default active season. */
export function buildFreshNvf(catalog: SeasonCatalog, nowMs: number = Date.now()): NvfData {
  return { season: { id: defaultSeasonId(catalog, nowMs), type: 0 } };
}

/** Static data for a positional reward the catalog cannot describe (unknown season, or a
 *  layout that no longer lines up): inert, so a claim is a pure flag flip. */
const UNKNOWN_REWARD_DATA = {
  isPrestige: false,
  rewardType: '[Type]',
  dataValInt: 0,
  dataValString: '[Data]',
  icon: '[Icon]',
} as const;

/**
 * Fill in a v2.7.0 positional reward (file shape: `claimedList` + `levelRequired` only)
 * from the catalog entry at the same (season, track, index). The file's own keys stay
 * first and untouched; the catalog fields and the editor-only mark are appended, so
 * {@link dehydrateSeasonSave} can restore the exact on-disk shape. A catalog entry is only
 * trusted when its level gate matches the file's - a mismatch means the game's reward
 * layout moved on from this catalog, and guessing would grant the wrong item.
 */
function hydrateReward(
  reward: SeasonReward,
  catalog: SeasonCatalog | null,
  seasonId: string,
  track: SeasonTrack,
  index: number,
): SeasonReward {
  const entry = catalog?.seasonById.get(seasonId);
  const candidate = (track === 'free' ? entry?.freeRewards : entry?.premiumRewards)?.[index];
  const match = candidate && candidate.levelRequired === reward.levelRequired ? candidate : null;
  return {
    ...reward,
    id: match?.id ?? syntheticRewardId(seasonId, track, index),
    isPrestige: match?.isPrestige ?? UNKNOWN_REWARD_DATA.isPrestige,
    rewardType: match?.rewardType ?? UNKNOWN_REWARD_DATA.rewardType,
    dataValInt: match?.dataValInt ?? UNKNOWN_REWARD_DATA.dataValInt,
    dataValString: match?.dataValString ?? UNKNOWN_REWARD_DATA.dataValString,
    icon: match?.icon ?? UNKNOWN_REWARD_DATA.icon,
    [HYDRATED_REWARD_MARK]: true,
  };
}

/** True for a reward in the v2.7.0 on-disk shape (no static data in the file). */
function isPositionalReward(reward: SeasonReward): boolean {
  return typeof (reward as { rewardType?: unknown }).rewardType !== 'string';
}

/**
 * Normalize an uploaded `spd.dat` into a working model:
 *   - defensively guarantee every reward carries a `claimedList` array so the board never
 *     reads `undefined`;
 *   - hydrate v2.7.0 positional rewards from the catalog (see {@link hydrateReward}), so
 *     ops and UI see the same reward shape for every game version.
 * Pass-through for the rest (the loose schema already preserves unknown keys for
 * round-trip). Pre-v2.7.0 files, whose rewards carry their own data, are left as they are.
 */
export function loadSeasonSave(spd: SeasonSave, catalog: SeasonCatalog | null = null): SeasonSave {
  const seasonsData = spd.seasonsData;
  if (!seasonsData) return spd;
  let changed = false;
  const nextData: NonNullable<SeasonSave['seasonsData']> = {};
  for (const [seasonId, record] of Object.entries(seasonsData)) {
    let recordChanged = false;
    const fix = (
      list: SeasonReward[] | undefined,
      track: SeasonTrack,
    ): SeasonReward[] | undefined => {
      if (!Array.isArray(list)) return list;
      let listChanged = false;
      const next = list.map((r, index) => {
        const withClaims = Array.isArray(r.claimedList) ? r : { ...r, claimedList: [] };
        const fixed = isPositionalReward(withClaims)
          ? hydrateReward(withClaims, catalog, seasonId, track, index)
          : withClaims;
        if (fixed !== r) listChanged = true;
        return fixed;
      });
      if (listChanged) recordChanged = true;
      return listChanged ? next : list;
    };
    const free = fix(record.freeRewardsList, 'free');
    const premium = fix(record.premiumRewardsList, 'premium');
    if (recordChanged) {
      changed = true;
      nextData[seasonId] = { ...record, freeRewardsList: free, premiumRewardsList: premium };
    } else {
      nextData[seasonId] = record;
    }
  }
  return changed ? { ...spd, seasonsData: nextData } : spd;
}

/**
 * The on-disk form of the working model: every hydrated reward (v2.7.0 positional, or
 * laid out fresh from the catalog) drops the catalog-filled static fields and the
 * editor-only mark again, leaving exactly the keys the v2.7.0 game writes (`claimedList`,
 * `levelRequired`, plus anything unknown the file carried). Rewards that came from a
 * pre-v2.7.0 file are not marked and keep their own data. Returns the same `spd` when
 * nothing is hydrated.
 */
export function dehydrateSeasonSave(spd: SeasonSave): SeasonSave {
  const seasonsData = spd.seasonsData;
  if (!seasonsData) return spd;
  const stripped = new Set<string>([...HYDRATED_REWARD_KEYS, HYDRATED_REWARD_MARK]);
  let changed = false;
  const nextData: NonNullable<SeasonSave['seasonsData']> = {};
  for (const [seasonId, record] of Object.entries(seasonsData)) {
    let recordChanged = false;
    const strip = (list: SeasonReward[] | undefined): SeasonReward[] | undefined => {
      if (!Array.isArray(list)) return list;
      let listChanged = false;
      const next = list.map((r) => {
        if (r[HYDRATED_REWARD_MARK] !== true) return r;
        listChanged = true;
        return Object.fromEntries(
          Object.entries(r).filter(([key]) => !stripped.has(key)),
        ) as SeasonReward;
      });
      if (listChanged) recordChanged = true;
      return listChanged ? next : list;
    };
    const free = strip(record.freeRewardsList);
    const premium = strip(record.premiumRewardsList);
    if (recordChanged) {
      changed = true;
      nextData[seasonId] = {
        ...record,
        ...(free !== undefined ? { freeRewardsList: free } : {}),
        ...(premium !== undefined ? { premiumRewardsList: premium } : {}),
      };
    } else {
      nextData[seasonId] = record;
    }
  }
  return changed ? { ...spd, seasonsData: nextData } : spd;
}

// --- Season clock (the game's own debug time offset) ------------------------------

/** .NET ticks in one day. */
const TICKS_PER_DAY = 86_400 * 10_000_000;

/**
 * Advance the season clock by `days` (`spd.debugTimeOffset`, .NET ticks the game adds
 * to "now" for ALL season timing - weekly unlocks, event windows, season end). Mirrors
 * the game's own AddGlobalTimeOffsetDays: += days worth of ticks + 1. A realistic
 * offset stays far inside Number.MAX_SAFE_INTEGER, so plain number math is exact;
 * a hand-edited out-of-range value (parsed as LosslessInt fails the schema's number
 * type) is replaced wholesale via the ?? 0 fallback.
 */
export function advanceSeasonClock(ws: SeasonWorkspace, days: number): SeasonWorkspace {
  const d = Math.trunc(days);
  if (!Number.isFinite(d) || d <= 0) return ws;
  const current = typeof ws.spd.debugTimeOffset === 'number' ? ws.spd.debugTimeOffset : 0;
  return { ...ws, spd: { ...ws.spd, debugTimeOffset: current + d * TICKS_PER_DAY + 1 } };
}

/** Reset the season clock to real time (`debugTimeOffset = 0`). */
export function resetSeasonClock(ws: SeasonWorkspace): SeasonWorkspace {
  if ((ws.spd.debugTimeOffset ?? 0) === 0) return ws;
  return { ...ws, spd: { ...ws.spd, debugTimeOffset: 0 } };
}

/**
 * Jump the season clock past the active season's end - the game's own
 * SkipToEndOfCurrentSeason cheat: offset = endDate - now + 1 tick. The caller
 * computes both tick values (catalog endDate / Date.now via taskLookup.ticksFromUnixMs)
 * so the op stays pure. No-op when the season already ended (offset would be <= 0).
 */
export function skipToSeasonEnd(
  ws: SeasonWorkspace,
  endDateTicks: bigint,
  nowTicks: bigint,
): SeasonWorkspace {
  const offset = endDateTicks - nowTicks + 1n;
  if (offset <= 0n) return ws;
  const value = Number(offset);
  if (!Number.isSafeInteger(value)) return ws; // > ~28 years out - malformed input
  if (ws.spd.debugTimeOffset === value) return ws;
  return { ...ws, spd: { ...ws.spd, debugTimeOffset: value } };
}

/** Current season-clock offset in whole days (0 = real time). */
export function seasonClockOffsetDays(spd: SeasonSave): number {
  const offset = typeof spd.debugTimeOffset === 'number' ? spd.debugTimeOffset : 0;
  return Math.floor(offset / TICKS_PER_DAY);
}
