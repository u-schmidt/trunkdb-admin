/** Matches a macOS or Linux home folder: `/Users/name` or `/home/name`. */
const homeFolder = /\/(?:Users|home)\/[^/\s]+/g;

/**
 * Replaces the home folder in every path inside `text` with `~`, so the user
 * name in `/Users/name/…` does not show on screen. The rest of the path stays.
 */
export function shortenHome(text: string): string {
  return text.replace(homeFolder, "~");
}
