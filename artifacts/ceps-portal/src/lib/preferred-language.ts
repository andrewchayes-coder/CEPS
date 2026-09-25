/** Participant language choices, shared by intake and both profile editors. */
export const PREFERRED_LANGUAGE_OPTIONS = [
  'English', 'Spanish', 'Russian', 'Ukrainian', 'Hmong', 'Vietnamese',
  'Cantonese', 'Mandarin', 'Punjabi', 'Tagalog', 'Arabic', 'Farsi',
  'American Sign Language', 'Other',
] as const;

export function languageChoice(value: string | null | undefined): string {
  if (!value?.trim()) return '';
  return PREFERRED_LANGUAGE_OPTIONS.includes(value as typeof PREFERRED_LANGUAGE_OPTIONS[number]) ? value : 'Other';
}

export function validLanguage(value: string | null | undefined): boolean {
  return !!value?.trim() && value.trim().toLowerCase() !== 'other';
}