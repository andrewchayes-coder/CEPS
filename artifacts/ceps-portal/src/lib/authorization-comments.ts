/** Keep complete comments in records; only dropdown subtitles are shortened. */
export function authorizationCommentSubtitle(comment?: string | null): string | undefined {
  if (!comment) return undefined;
  const characters = Array.from(comment);
  return characters.length > 60 ? `${characters.slice(0, 59).join('')}…` : comment;
}
