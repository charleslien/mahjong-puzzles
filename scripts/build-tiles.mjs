/**
 * Composite the CC0 tile artwork into self-contained SVGs.
 *
 * Source: https://github.com/FluffyStuff/riichi-mahjong-tiles (CC0 1.0, public
 * domain — no attribution required, credited anyway in the README).
 *
 * The upstream art is split: `Front.svg` is the blank tile body, and each face
 * (`Man1.svg`, `Chun.svg`, …) is a transparent glyph meant to be layered over
 * it. Rendering that in the browser with `<use href="sprite.svg#id">` does not
 * work — Chrome blocks external references in `use` — and inlining a 900KB
 * sprite into the DOM is worse. So each tile is flattened here into one file the
 * UI can drop into an `<img>`.
 *
 * Ids have to be namespaced during the merge: both layers carry Inkscape
 * gradient ids, and identical ids in one document would cross-wire the
 * gradients.
 *
 * Usage:
 *   git clone --depth 1 https://github.com/FluffyStuff/riichi-mahjong-tiles
 *   node scripts/build-tiles.mjs riichi-mahjong-tiles/Regular
 */

import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT_DIR = join(HERE, '..', 'public', 'tiles');

/** mjai tile notation -> upstream filename. */
const FACES = {
  E: 'Ton',
  S: 'Nan',
  W: 'Shaa',
  N: 'Pei',
  P: 'Haku',
  F: 'Hatsu',
  C: 'Chun',
  '5mr': 'Man5-Dora',
  '5pr': 'Pin5-Dora',
  '5sr': 'Sou5-Dora',
};
for (let rank = 1; rank <= 9; rank++) {
  FACES[`${rank}m`] = `Man${rank}`;
  FACES[`${rank}p`] = `Pin${rank}`;
  FACES[`${rank}s`] = `Sou${rank}`;
}

/**
 * Namespace prefixes used by the editor that generated this art. None of them
 * affect rendering.
 *
 * Every trace of them has to go, elements included — not just attributes. The
 * output is loaded through an `<img>`, which parses SVG as strict XML, so a
 * single surviving `<inkscape:path-effect>` or `<sodipodi:guide>` under a root
 * that no longer declares those prefixes is a hard parse error and the image
 * silently renders at zero width.
 *
 * Note that this failure is invisible if you test by injecting the markup as
 * inline HTML: that path is parsed leniently and renders fine.
 */
const EDITOR_PREFIXES = ['inkscape', 'sodipodi', 'osb', 'dc', 'cc', 'rdf'];

/** Strip the editor cruft that makes these files 20x larger than they need to be. */
function stripMetadata(svg) {
  let out = svg
    .replace(/<\?xml[^>]*\?>/g, '')
    .replace(/<!DOCTYPE[^>]*>/gi, '')
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<metadata[\s\S]*?<\/metadata>/g, '');

  for (const prefix of EDITOR_PREFIXES) {
    // Paired elements, then self-closing ones, then attributes.
    out = out
      .replace(new RegExp(`<${prefix}:([\\w-]+)\\b[\\s\\S]*?</${prefix}:\\1>`, 'g'), '')
      .replace(new RegExp(`<${prefix}:[\\w-]+\\b[^>]*/>`, 'g'), '')
      .replace(new RegExp(`\\s${prefix}:[\\w-]+="[^"]*"`, 'g'), '')
      .replace(new RegExp(`\\sxmlns:${prefix}="[^"]*"`, 'g'), '');
  }

  return out;
}

/**
 * Fail loudly rather than shipping a tile that will not render. Catches both a
 * leftover editor prefix and any other undeclared namespace.
 */
function assertRenderable(svg, name) {
  for (const prefix of EDITOR_PREFIXES) {
    if (svg.includes(`${prefix}:`)) {
      throw new Error(`${name}: leftover ${prefix}: reference would break XML parsing`);
    }
  }
  const declared = new Set(['xlink', 'xml']);
  for (const match of svg.matchAll(/<\/?([a-zA-Z][\w-]*):/g)) {
    if (!declared.has(match[1])) {
      throw new Error(`${name}: undeclared namespace prefix "${match[1]}" on an element`);
    }
  }
}

/** Everything inside the root <svg> element. */
function innerContent(svg) {
  const open = svg.match(/<svg[^>]*>/);
  if (!open) throw new Error('no <svg> root found');
  const start = svg.indexOf(open[0]) + open[0].length;
  const end = svg.lastIndexOf('</svg>');
  return svg.slice(start, end);
}

/**
 * Rewrite every id and every reference to it with a prefix, so two layers can
 * share one document without their gradients colliding.
 */
function namespaceIds(content, prefix) {
  const ids = new Set();
  for (const match of content.matchAll(/\sid="([^"]+)"/g)) ids.add(match[1]);

  let out = content;
  for (const id of ids) {
    const escaped = id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    out = out
      .replace(new RegExp(`\\sid="${escaped}"`, 'g'), ` id="${prefix}${id}"`)
      .replace(new RegExp(`url\\(#${escaped}\\)`, 'g'), `url(#${prefix}${id})`)
      .replace(new RegExp(`(xlink:href|href)="#${escaped}"`, 'g'), `$1="#${prefix}${id}"`);
  }
  return out;
}

function collapseWhitespace(svg) {
  return svg
    .replace(/>\s+</g, '><')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

/**
 * Upstream `Haku.svg` is genuinely empty, which is authentic — the white dragon
 * is a blank tile — but on screen it is indistinguishable from an empty slot or
 * a loading failure. Most published sets draw it with a frame for exactly this
 * reason, so one is added here. A deliberate deviation from the source art.
 */
const HAKU_FRAME =
  '<rect x="44" y="60" width="212" height="280" rx="10" fill="none" ' +
  'stroke="#2f4f7d" stroke-width="13" opacity="0.9"/>' +
  '<rect x="66" y="82" width="168" height="236" rx="6" fill="none" ' +
  'stroke="#2f4f7d" stroke-width="5" opacity="0.6"/>';

/**
 * The upstream tile back is a flat colour field. At small sizes that reads as a
 * solid block rather than a tile, so a bevel edge is added to give it a rim.
 */
const BACK_EDGE =
  '<rect x="8" y="8" width="284" height="384" rx="22" fill="none" ' +
  'stroke="rgba(255,255,255,0.30)" stroke-width="10"/>' +
  '<rect x="20" y="20" width="260" height="360" rx="16" fill="none" ' +
  'stroke="rgba(0,0,0,0.20)" stroke-width="6"/>';

function composite(frontInner, faceInner, label, extra = '') {
  const body = [
    namespaceIds(frontInner, 'f-'),
    faceInner === null ? '' : namespaceIds(faceInner, 'g-'),
    extra,
  ].join('');

  return collapseWhitespace(
    `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" ` +
      `viewBox="0 0 300 400" width="300" height="400" role="img" aria-label="${label}">` +
      body +
      `</svg>\n`,
  );
}

function main() {
  const sourceDir = process.argv[2];
  if (!sourceDir) {
    process.stderr.write(
      'usage: node scripts/build-tiles.mjs <path to riichi-mahjong-tiles/Regular>\n',
    );
    process.exit(1);
  }

  const available = new Set(readdirSync(sourceDir));
  const read = (name) => {
    if (!available.has(`${name}.svg`)) throw new Error(`missing source tile: ${name}.svg`);
    return innerContent(stripMetadata(readFileSync(join(sourceDir, `${name}.svg`), 'utf8')));
  };

  const frontInner = read('Front');
  mkdirSync(OUT_DIR, { recursive: true });

  let written = 0;
  let bytes = 0;
  for (const [tile, sourceName] of Object.entries(FACES)) {
    const svg = composite(frontInner, read(sourceName), tile, tile === 'P' ? HAKU_FRAME : '');
    assertRenderable(svg, `${tile}.svg`);
    writeFileSync(join(OUT_DIR, `${tile}.svg`), svg);
    written += 1;
    bytes += svg.length;
  }

  // Face-down tiles, for opponents' concealed hands during replay.
  const back = collapseWhitespace(
    `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" ` +
      `viewBox="0 0 300 400" width="300" height="400" role="img" aria-label="face-down tile">` +
      namespaceIds(read('Back'), 'b-') +
      BACK_EDGE +
      `</svg>\n`,
  );
  assertRenderable(back, 'back.svg');
  writeFileSync(join(OUT_DIR, 'back.svg'), back);
  written += 1;
  bytes += back.length;

  // No blank-front tile is emitted on purpose: it would be indistinguishable
  // from the white dragon. Empty slots are drawn in CSS instead.

  writeFileSync(
    join(OUT_DIR, 'LICENSE.txt'),
    [
      'Tile artwork from https://github.com/FluffyStuff/riichi-mahjong-tiles',
      '',
      'Released under Creative Commons Zero 1.0 (public domain dedication):',
      'https://creativecommons.org/publicdomain/zero/1.0/',
      '',
      'No attribution is required. Credited anyway.',
      '',
      'These files are composites: the upstream blank tile front (Front.svg) with',
      'each face glyph flattened onto it, generated by scripts/build-tiles.mjs.',
      '',
    ].join('\n'),
  );

  process.stdout.write(
    `wrote ${written} tile SVGs to ${OUT_DIR} (${(bytes / 1024).toFixed(0)} KB total)\n`,
  );
}

main();
