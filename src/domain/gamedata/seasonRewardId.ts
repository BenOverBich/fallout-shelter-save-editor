// Synthetic Season Pass reward ids.
//
// Up to game v2.5.x every reward in `spd.dat` carried its own static data, including a
// numeric `id`. From v2.7.0 the file only stores per-save state (`claimedList`,
// `levelRequired`); the static reward data lives in the game's SeasonPassEntry assets and a
// reward is identified purely by its POSITION in its season's free/premium list.
//
// The editor still wants one stable number per reward (board cell keys, reversal handles),
// so positional rewards get a deterministic id derived from (season, track, index). It is
// unique per season record, so two seasons never share an id - which matches v2.7.0, where
// each season record keeps its own claim state (a rerun sharing the same reward asset list
// as its original does NOT share claims).
//
// Shared by the app (hydrating a v2.7.0 file) and scripts/build-gamedata (the catalog), so
// both sides agree on the id. Erasable-syntax-only TS: imported by plain Node build scripts.

export type SeasonTrackName = 'free' | 'premium';

/** FNV-1a (32-bit) folded into a positive 31-bit integer. */
export function syntheticRewardId(seasonId: string, track: SeasonTrackName, index: number): number {
  const key = `${seasonId}/${track}/${index}`;
  let hash = 0x811c9dc5;
  for (let i = 0; i < key.length; i++) {
    hash ^= key.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0) % 0x7fffffff;
}
