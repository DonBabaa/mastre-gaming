import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** Root of the hub repo. */
export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

const fromEnv = (name, fallback) => (process.env[name] ? path.resolve(process.env[name]) : fallback);

/** Working folder of the pipeline. Git-ignored. The env overrides exist for the tests. */
export const CACHE = fromEnv('MASTRE_CACHE_DIR', path.join(ROOT, '.mastre-cache'));
/** The finished site. */
export const DIST = fromEnv('MASTRE_DIST_DIR', path.join(ROOT, 'dist'));

/** Everything a build job hands over to the step that assembles the site. */
export const OUT = path.join(CACHE, 'out');
/** One folder per game id: the last successful build. This is what CI caches. */
export const SLOTS = path.join(OUT, 'games');
/** One file per registry entry: what happened to it in this run. */
export const RESULTS = path.join(OUT, 'results');
/** Where game sources are cloned and built. */
export const SOURCES = path.join(CACHE, 'src');
/** A build is assembled here and only moved into SLOTS once it is complete. */
export const STAGING = path.join(CACHE, 'staging');
export const PLAN_FILE = path.join(CACHE, 'plan.json');

export const SCHEMA_FILE = path.join(ROOT, 'schema', 'mastre.schema.json');
export const EXAMPLES = path.join(ROOT, 'examples');
