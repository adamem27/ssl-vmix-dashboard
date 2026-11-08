export const TEAM_SLOTS = [
  { key: 'background_1', label: 'Background type 1' },
  { key: 'background_2', label: 'Background type 2' },
  { key: 'emblem_dark', label: 'Emblem dark' },
  { key: 'emblem_light', label: 'Emblem light' },
  { key: 'flag_small', label: 'Flag small' },
  { key: 'flag_big', label: 'Flag big' },
  { key: 'lowerthird_photo', label: 'Lowerthird photo' },
  { key: 'lowerthird_anthem', label: 'Lowerthird anthem' },
  { key: 'sponsor_1', label: 'Sponsor logo 1' },
  { key: 'sponsor_2', label: 'Sponsor logo 2' },
  { key: 'sponsor_3', label: 'Sponsor logo 3' },
  { key: 'sponsor_4', label: 'Sponsor logo 4' },
  { key: 'sponsor_5', label: 'Sponsor logo 5' },
] as const;

export const SAILOR_SLOTS = [{ key: 'photo', label: 'Photo' }] as const;

export const PERSON_SLOTS = [{ key: 'photo', label: 'Photo' }] as const;

export type OwnerType = 'team' | 'sailor' | 'person';

export function slotsFor(owner: OwnerType) {
  return owner === 'team' ? TEAM_SLOTS : owner === 'sailor' ? SAILOR_SLOTS : PERSON_SLOTS;
}

/** Team graphics are PNG only (transparency). Photos may also be JPEG. */
export function allowedKinds(owner: OwnerType): ImageKind[] {
  return owner === 'team' ? ['png'] : ['png', 'jpeg'];
}

export type ImageKind = 'png' | 'jpeg';

/** Uploads to these slots are redrawn to one standard size (see logo.ts). */
export const isSponsorSlot = (owner: OwnerType, slot: string) => owner === 'team' && /^sponsor_\d+$/.test(slot);
