import fs from 'node:fs';

const inActions = process.env.GITHUB_ACTIONS === 'true';
const useColor = !process.env.NO_COLOR && (process.stdout.isTTY || inActions || !!process.env.FORCE_COLOR);
const paint = (code) => (text) => (useColor ? `\x1b[${code}m${text}\x1b[0m` : String(text));

export const c = {
  bold: paint('1'),
  dim: paint('2'),
  red: paint('31'),
  green: paint('32'),
  yellow: paint('33'),
  cyan: paint('36'),
};

export const info = (message) => console.log(message);
export const ok = (message) => console.log(`${c.green('✓')} ${message}`);
export const warn = (message) => console.log(`${c.yellow('⚠')} ${message}`);
export const fail = (message) => console.log(`${c.red('✗')} ${message}`);

/** Folds the output in the GitHub Actions log; a plain heading elsewhere. */
export function group(title) {
  console.log(inActions ? `::group::${title}` : `\n${c.bold(title)}`);
}

export function endGroup() {
  if (inActions) console.log('::endgroup::');
}

/** Plain text table. `columns` is a list of [key, heading]. */
export function table(rows, columns) {
  const cell = (value) => (value == null || value === '' ? '-' : String(value));
  const widths = columns.map(([key, heading]) => Math.max(heading.length, ...rows.map((row) => cell(row[key]).length)));
  const line = (cells) => `  ${cells.map((text, i) => text.padEnd(widths[i])).join('   ').trimEnd()}`;
  return [
    line(columns.map(([, heading]) => heading)),
    line(widths.map((width) => '─'.repeat(width))),
    ...rows.map((row) => line(columns.map(([key]) => cell(row[key])))),
  ].join('\n');
}

/** Sets a step output in GitHub Actions. Does nothing elsewhere. */
export function setOutput(name, value) {
  if (process.env.GITHUB_OUTPUT) fs.appendFileSync(process.env.GITHUB_OUTPUT, `${name}=${value}\n`);
}

/** Adds Markdown to the run summary page in GitHub Actions. Does nothing elsewhere. */
export function stepSummary(markdown) {
  if (process.env.GITHUB_STEP_SUMMARY) fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${markdown}\n`);
}

/** First line of an error, short enough to publish in the catalog. */
export function shortError(error, max = 300) {
  const text = String(error?.message ?? error).split('\n').find((line) => line.trim()) ?? 'unknown error';
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}
