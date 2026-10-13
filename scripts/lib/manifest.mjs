import fs from 'node:fs';
import path from 'node:path';
import { readJson } from './fsx.mjs';
import { SCHEMA_FILE } from './paths.mjs';

export const MANIFEST_NAME = 'mastre.json';
export const ID_RE = /^[a-z0-9-]+$/;

const KNOWN_FIELDS = new Set([
  '$schema', 'schemaVersion', 'id', 'title', 'description', 'authors', 'version',
  'cover', 'tags', 'controls', 'build', 'output', 'entry', 'multiplayer',
]);

/** A manifest that cannot be used. `problems` lists everything wrong with it, one line each. */
export class ManifestError extends Error {
  constructor(problems) {
    const more = problems.length > 1 ? ` (and ${problems.length - 1} more)` : '';
    super(`${MANIFEST_NAME}: ${problems[0]}${more}`);
    this.name = 'ManifestError';
    this.problems = problems;
  }
}

/** Reads and parses mastre.json without validating it. */
export function readManifestText(text) {
  try {
    return JSON.parse(text.replace(/^﻿/, ''));
  } catch (error) {
    throw new ManifestError([`not valid JSON (${error.message})`]);
  }
}

export function readManifestFile(dir) {
  const file = path.join(dir, MANIFEST_NAME);
  if (!fs.existsSync(file)) throw new ManifestError(['not found at the root of the repo']);
  return readManifestText(fs.readFileSync(file, 'utf8'));
}

/** The id is all the plan step needs; the full check happens right before the build. */
export function peekId(manifest) {
  const id = manifest?.id;
  if (typeof id !== 'string' || !ID_RE.test(id) || id.length > 64) {
    throw new ManifestError(['"id" must be lowercase letters, digits and dashes only']);
  }
  return id;
}

let validator;
async function getValidator() {
  if (!validator) {
    // Loaded on demand so the plan step runs without `npm ci`.
    const module = await import('ajv/dist/2020.js');
    const Ajv = module.default?.default ?? module.default;
    const ajv = new Ajv({ allErrors: true, allowUnionTypes: true, strictTypes: false });
    validator = ajv.compile(readJson(SCHEMA_FILE));
  }
  return validator;
}

function describe(error) {
  const field = error.instancePath.slice(1).replace(/\//g, '.');
  const at = field ? `"${field}" ` : '';
  switch (error.keyword) {
    case 'required':
      return `${field ? `"${field}" is ` : ''}missing the required field "${error.params.missingProperty}"`;
    case 'const':
      return `${at}must be ${JSON.stringify(error.params.allowedValue)}`;
    case 'enum':
      return `${at}must be one of: ${error.params.allowedValues.join(', ')}`;
    case 'type':
      return `${at}must be ${[].concat(error.params.type).join(' or ')}`;
    case 'additionalProperties':
      return `${at}has an unknown field "${error.params.additionalProperty}"`;
    case 'pattern':
      if (field === 'id') return '"id" must be lowercase letters, digits and dashes only';
      if (field === 'multiplayer.server') return '"multiplayer.server" must be null or start with wss:// or https://';
      if (error.schemaPath.includes('relativePath')) {
        return `${at}must be a path relative to the repo root (forward slashes, no leading "/", no "..")`;
      }
      if (field === 'cover') return '"cover" must be a PNG, JPG, WebP, AVIF or GIF image';
      if (field === 'entry') return '"entry" must be an .html file';
      return `${at}has an invalid format`;
    default:
      return `${at}${error.message}`;
  }
}

/**
 * Validates a parsed manifest against the schema and fills in the defaults.
 * Returns { manifest, outputDir, warnings }; throws ManifestError otherwise.
 */
export async function validateManifest(raw) {
  const validate = await getValidator();
  if (!validate(raw)) {
    throw new ManifestError([...new Set(validate.errors.map(describe))]);
  }

  const warnings = Object.keys(raw)
    .filter((key) => !KNOWN_FIELDS.has(key))
    .map((key) => `unknown field "${key}" in ${MANIFEST_NAME} is ignored`);

  const build = raw.build
    ? { install: raw.build.install || null, command: raw.build.command || null, output: raw.build.output }
    : null;
  if (build && raw.output !== undefined && raw.output !== build.output) {
    warnings.push('top-level "output" is ignored because "build.output" is set');
  }

  const manifest = {
    schemaVersion: raw.schemaVersion,
    id: raw.id,
    title: raw.title.trim(),
    description: raw.description.trim(),
    authors: raw.authors.map((name) => name.trim()).filter(Boolean),
    version: raw.version.trim(),
    cover: raw.cover,
    tags: [...new Set((raw.tags ?? []).map((tag) => tag.trim().toLowerCase()).filter(Boolean))],
    controls: raw.controls ?? [],
    build,
    entry: raw.entry,
    multiplayer: { server: raw.multiplayer?.server ?? null },
  };

  return { manifest, outputDir: build ? build.output : (raw.output ?? '.'), warnings };
}

export async function loadManifest(dir) {
  return validateManifest(readManifestFile(dir));
}
