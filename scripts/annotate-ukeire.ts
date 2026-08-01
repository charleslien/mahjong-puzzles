/**
 * Annotate mined candidates with tile-efficiency data.
 *
 * Stage between mine.py and verify.py. Reads candidates as JSONL, adds the
 * ukeire baseline for each position, and writes them back out.
 *
 * This is a TypeScript stage in an otherwise Python pipeline for one reason: the
 * shanten and ukeire implementations live here, are covered by a brute-force
 * reference test, and are validated against the shipped bank. Porting them to
 * Python to keep the pipeline monolingual would mean maintaining a second
 * implementation of the subtlest code in the project and hoping the two never
 * drift. Shelling out to the tested one is the cheaper guarantee.
 *
 * It also attaches each action's display label, so tile naming stays with
 * `tileLabel`. Generating labels on the Python side is what previously produced
 * "discard s" — honour tiles are single letters, and a naive lowercasing
 * destroyed them.
 *
 * Usage:
 *   npm run annotate:ukeire -- --input candidates.jsonl --output annotated.jsonl
 */

import { once } from 'node:events';
import { createReadStream, createWriteStream } from 'node:fs';
import { createInterface } from 'node:readline';

import { analyzePosition } from '../src/lib/analyzePosition';
import { tileLabel } from '../src/lib/tiles';
import type { Position } from '../src/types/puzzle';

interface Candidate {
  position: Position;
  kind?: string;
  calledTile?: string;
  [key: string]: unknown;
}

interface ActionAnnotation {
  label: string;
  tile: string;
  shantenAfter: number;
  ukeire: number;
}

function argValue(flag: string): string | undefined {
  const index = process.argv.indexOf(flag);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

async function main(): Promise<number> {
  const inputPath = argValue('--input');
  const outputPath = argValue('--output');
  if (!inputPath || !outputPath) {
    process.stderr.write('usage: --input <candidates.jsonl> --output <annotated.jsonl>\n');
    return 2;
  }

  const lines = createInterface({
    input: createReadStream(inputPath, 'utf8'),
    crlfDelay: Infinity,
  });

  /**
   * Written as it goes rather than joined at the end.
   *
   * A dense mining pass hands this stage six figures of candidates, and holding
   * every annotated record in an array meant ~180 MB of strings and one
   * `join` — a run that dies there loses half an hour and writes nothing. It
   * also means a run in progress can be watched.
   */
  const output = createWriteStream(outputPath, 'utf8');
  const write = async (text: string): Promise<void> => {
    if (!output.write(text)) await once(output, 'drain');
  };

  let read = 0;
  let annotated = 0;
  let skipped = 0;

  /** Loud enough to see movement on a long run, quiet enough on a short one. */
  const PROGRESS_EVERY = 10000;

  for await (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    read += 1;
    if (read % PROGRESS_EVERY === 0) {
      process.stderr.write(`  ${read} read, ${annotated} annotated\n`);
    }

    const candidate = JSON.parse(trimmed) as Candidate;

    // A call is judged at an opponent's discard, where the seat holds thirteen
    // tiles: there is no discard to analyse yet. It still needs tile names, so
    // the follow-up discard in "Call pon, then discard 3 circles" reads properly
    // rather than as "3p".
    if (candidate.kind === 'call') {
      const names: Record<string, string> = {};
      const tiles = [...candidate.position.hand, candidate.calledTile as string].filter(Boolean);
      for (const tile of tiles) names[tile] = tileLabel(tile as never);
      await write(JSON.stringify({ ...candidate, tileLabels: names }) + '\n');
      annotated += 1;
      continue;
    }

    const analysis = analyzePosition(candidate.position);
    if (!analysis) {
      // Complete or far-from-tenpai hands are not discard problems. Dropped
      // here rather than carried forward with empty annotations, which would
      // make every downstream efficiency comparison vacuously true.
      skipped += 1;
      continue;
    }

    const { options, bestShanten, bestUkeire, resolveHandTile } = analysis;

    // One entry per tile the hand actually holds, not per tile *index*.
    // Acceptance is computed over 34 indices, which merges a red five with its
    // plain twin — but discarding the red one gives away a dora, and akochan
    // prices the two differently. Collapsing them meant that in every hand
    // holding both copies, one of the two plays was silently missing.
    const held = new Set(candidate.position.hand);
    const perAction: Record<string, ActionAnnotation> = {};
    for (const option of options) {
      const canonical = resolveHandTile(option.tile);
      const variants = [canonical, `${canonical}r`, canonical.replace(/r$/, '')].filter(
        (tile, index, all) => held.has(tile as never) && all.indexOf(tile) === index,
      );
      for (const tile of variants.length ? variants : [canonical]) {
        perAction[`discard:${tile}`] = {
          // Shanten and acceptance are properties of the tile *index*, so both
          // copies share them; only the expected value differs.
          label: `Discard ${tileLabel(tile as never)}`,
          tile,
          shantenAfter: option.shantenAfter,
          ukeire: option.ukeire,
        };
      }
    }

    // What pure efficiency would play: best shanten, and nothing accepts more.
    const ukeireBest = options
      .filter((option) => option.shantenAfter === bestShanten && option.ukeire === bestUkeire)
      .map((option) => `discard:${resolveHandTile(option.tile)}`);

    await write(
      JSON.stringify({
        ...candidate,
        bestShanten,
        currentShanten: analysis.currentShanten,
        ukeireBest,
        ukeireActions: perAction,
      }) + '\n',
    );
    annotated += 1;
  }

  output.end();
  await once(output, 'close');
  process.stderr.write(
    `annotated ${annotated} of ${read} candidates (${skipped} not discard problems) -> ${outputPath}\n`,
  );
  return 0;
}

main().then(
  (code) => process.exit(code),
  (error) => {
    process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
    process.exit(1);
  },
);
