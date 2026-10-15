/**
 * Address of the updater (updater/ in this repo, a Cloudflare Worker) that the
 * hidden update panel talks to. Empty: the panel does not exist.
 * VITE_MASTRE_UPDATER_URL overrides it for a local build, to test against a stand-in.
 */
export const UPDATER_URL: string = import.meta.env.VITE_MASTRE_UPDATER_URL ?? '';
