/**
 * Eager recent-session avatars are useful on desktop/server builds, where the
 * thumbnail batch loader can warm the list before scrolling. Capacitor keeps
 * them lazy by default because the hidden mobile sidebar is mounted at startup,
 * so eager avatars would otherwise add image decode pressure before it is used.
 */
export function shouldEagerLoadRecentSessionThumbnails(
  capacitor: boolean,
  preloadEnabled: boolean | undefined,
): boolean {
  return !capacitor || preloadEnabled === true;
}
