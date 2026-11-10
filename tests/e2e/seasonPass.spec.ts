import { test, expect, type Download } from '@playwright/test';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { decodeSeason, encodeSeason } from '../../src/domain/codec/saveCodec.ts';
import type { SeasonSave } from '../../src/domain/model/seasonSchema.ts';

// Season Pass end-to-end, matching the importExport.spec pattern. Two flows:
//  (a) sandbox baseline → Season tab → "Continue" (catalog) → "Max all seasons" → export
//      offers the vault save AND the season files.
//  (b) upload a SYNTHETIC spd.dat → "Claim unclaimed" → export spd.dat re-encodes the claim.
//  (c) the same with a game v2.7.0-shaped spd.dat (positional rewards, no static data).
// Synthetic fixtures only - never a real personal save.

// Remove the File System Access API so the `.sav` save-in-place picker degrades to a download
// (Playwright can't drive the native picker), making every output a capturable download event.
const KILL_PICKER = () => {
  Object.defineProperty(window, 'showSaveFilePicker', { value: undefined, configurable: true });
};

async function acceptDisclaimer(page: import('@playwright/test').Page): Promise<void> {
  await page.getByRole('button', { name: 'I understand and accept the risks' }).click();
}

test('sandbox → Season tab → Continue → Max all → export offers the save and season files', async ({
  page,
}) => {
  await page.addInitScript(KILL_PICKER);
  await page.goto('/');
  await acceptDisclaimer(page);

  // Start from the bundled new-game vault so a `.sav` is always present for the Season tab.
  await page.getByRole('button', { name: 'Start fresh / sandbox' }).click();
  await expect(page.getByRole('button', { name: 'Export', exact: true })).toBeVisible();

  await page.getByRole('link', { name: 'Season Pass' }).click();

  // Onboarding → build the catalog working model. The button reads "Loading catalog…" until
  // season-pass.json resolves, then becomes "Continue".
  await page.getByRole('button', { name: 'Continue' }).click();

  // Max every season - a single combined edit that flips seasonEdited on.
  await page.getByRole('button', { name: 'Max all seasons' }).click();

  const downloads: Download[] = [];
  page.on('download', (d) => downloads.push(d));

  // Export via the one shared dialog. The Season tab shows its own "Export" button too, so
  // scope the opener to the toolbar (banner) and the confirm to the dialog.
  await page.getByRole('banner').getByRole('button', { name: 'Export', exact: true }).click();
  const dialog = page.getByRole('dialog');
  await expect(dialog.getByText('Your season-pass progress')).toBeVisible(); // season files offered
  await dialog.getByRole('button', { name: 'Export', exact: true }).click();

  // Sandbox has no original to back up, so the three outputs are the vault save + the pair.
  await expect
    .poll(() => downloads.map((d) => d.suggestedFilename()).sort())
    .toEqual(['Vault2.sav', 'nvf.dat', 'spd.dat'].sort());
});

test('upload a synthetic spd.dat → Claim unclaimed → export re-encodes the claim', async ({
  page,
}) => {
  // A minimal, synthetic season file: one season with a single unclaimed free caps reward.
  const spd: SeasonSave = {
    schemaVersion: 2,
    currentSeason: 'Institute',
    currentLevel: 1,
    currentTokens: 0,
    battlepassWindowLastObservedLevel: 1,
    seasonsData: {
      Institute: {
        isPremium: false,
        isPremiumPlus: false,
        maxRankAchieved: 0,
        leaderboardData: { score: 0, claimedRewards: '[[false]]', lastRewardLevelUnlocked: -1 },
        freeRewardsList: [
          {
            id: 1,
            isPrestige: false,
            rewardType: 'caps',
            dataValInt: 500,
            dataValString: 'none',
            icon: 'BP_Caps',
            claimedList: [],
            levelRequired: 1,
          },
        ],
        premiumRewardsList: [],
      },
    },
  };

  const dir = mkdtempSync(join(tmpdir(), 'fsse-season-e2e-'));
  const spdPath = join(dir, 'spd.dat');
  writeFileSync(spdPath, await encodeSeason(spd), 'utf8');

  await page.addInitScript(KILL_PICKER);
  await page.goto('/');
  await acceptDisclaimer(page);

  // A `.sav` must be loaded before the Season tab can grant rewards into it.
  await page.getByRole('button', { name: 'Start fresh / sandbox' }).click();
  await expect(page.getByRole('button', { name: 'Export', exact: true })).toBeVisible();

  await page.getByRole('link', { name: 'Season Pass' }).click();

  // Upload the synthetic spd.dat through the onboarding's hidden .dat input.
  await page.locator('input[accept=".dat"]').setInputFiles(spdPath);

  // Claim everything the free track entitles (premium is locked) - flips seasonEdited on.
  await page.getByRole('button', { name: 'Claim unclaimed' }).click();

  const downloads: Download[] = [];
  page.on('download', (d) => downloads.push(d));

  // Export through the one shared dialog (the inline per-file buttons are gone). The season
  // files default on once a season edit has been made, so confirming emits spd.dat + nvf.dat.
  await page.getByRole('banner').getByRole('button', { name: 'Export', exact: true }).click();
  const dialog = page.getByRole('dialog');
  await expect(dialog.getByText('Your season-pass progress')).toBeVisible();
  await dialog.getByRole('button', { name: 'Export', exact: true }).click();

  await expect.poll(() => downloads.length).toBeGreaterThanOrEqual(1);
  const spdDl = downloads.find((d) => d.suggestedFilename() === 'spd.dat');
  expect(spdDl, 'expected an exported spd.dat download').toBeTruthy();

  const exported = await decodeSeason(readFileSync(await spdDl!.path(), 'utf8'));
  // Claims are per vault slot: the sandbox baseline is Vault2.sav, so the claim index is 1.
  expect(exported.seasonsData!.Institute.freeRewardsList![0].claimedList).toContain(1);
});

test('upload a game v2.7.0 spd.dat → rewards resolve from the catalog → export keeps the v2.7.0 shape', async ({
  page,
}) => {
  // From v2.7.0 the file stores only claim state per reward; what the reward IS comes from
  // the catalog, by position. Synthetic file shaped like the game's own, for a real catalog
  // season (Enclave_26_10: free[0] is 300 caps at rank 1).
  const spd = {
    schemaVersion: 2,
    currentSeason: 'Enclave_26_10',
    currentLevel: 1,
    currentTokens: 0,
    battlepassWindowLastObservedLevel: 1,
    seasonsData: {
      Enclave_26_10: {
        isPremium: false,
        isPremiumPlus: false,
        maxRankAchieved: 1,
        freeRewardsList: [
          { claimedList: [], levelRequired: 1 },
          { claimedList: [], levelRequired: 2 },
        ],
        premiumRewardsList: [{ claimedList: [], levelRequired: 1 }],
      },
    },
  } as unknown as SeasonSave;

  const dir = mkdtempSync(join(tmpdir(), 'fsse-season-v27-e2e-'));
  const spdPath = join(dir, 'spd.dat');
  writeFileSync(spdPath, await encodeSeason(spd), 'utf8');

  await page.addInitScript(KILL_PICKER);
  await page.goto('/');
  await acceptDisclaimer(page);
  await page.getByRole('button', { name: 'Start fresh / sandbox' }).click();
  await expect(page.getByRole('button', { name: 'Export', exact: true })).toBeVisible();
  await page.getByRole('link', { name: 'Season Pass' }).click();
  await page.locator('input[accept=".dat"]').setInputFiles(spdPath);

  await page.getByRole('button', { name: 'Claim unclaimed' }).click();

  const downloads: Download[] = [];
  page.on('download', (d) => downloads.push(d));
  await page.getByRole('banner').getByRole('button', { name: 'Export', exact: true }).click();
  const dialog = page.getByRole('dialog');
  await expect(dialog.getByText('Your season-pass progress')).toBeVisible();
  await dialog.getByRole('button', { name: 'Export', exact: true }).click();

  await expect.poll(() => downloads.length).toBeGreaterThanOrEqual(1);
  const spdDl = downloads.find((d) => d.suggestedFilename() === 'spd.dat');
  expect(spdDl, 'expected an exported spd.dat download').toBeTruthy();

  const exported = await decodeSeason(readFileSync(await spdDl!.path(), 'utf8'));
  const record = exported.seasonsData!.Enclave_26_10;
  // The free track is claimed for the sandbox vault (Vault2 → slot 1); premium stays locked.
  // No catalog-filled field or editor marker may reach the file.
  expect(record.freeRewardsList).toEqual([
    { claimedList: [1], levelRequired: 1 },
    { claimedList: [1], levelRequired: 2 },
  ]);
  expect(record.premiumRewardsList).toEqual([{ claimedList: [], levelRequired: 1 }]);
});
