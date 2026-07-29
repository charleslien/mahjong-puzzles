import { describe, expect, it } from 'vitest';
import { chiitoitsuShanten, kokushiShanten, shanten, standardShanten } from './shanten';
import { parseHand, toCounts } from './tiles';

const counts = (hand: string): number[] => toCounts(parseHand(hand));

describe('parseHand', () => {
  it('parses suits and honors', () => {
    expect(parseHand('123m')).toEqual(['1m', '2m', '3m']);
    expect(parseHand('11z')).toEqual(['E', 'E']);
    expect(parseHand('1234567z')).toEqual(['E', 'S', 'W', 'N', 'P', 'F', 'C']);
  });

  it('canonicalises red fives', () => {
    expect(parseHand('05m')).toEqual(['5mr', '5m']);
  });

  it('rejects trailing digits', () => {
    expect(() => parseHand('123')).toThrow();
  });
});

describe('standardShanten', () => {
  it('reports -1 for a complete hand', () => {
    // 123m 456m 789m 123p + 1p1p
    expect(standardShanten(counts('123456789m12311p'))).toBe(-1);
  });

  it('reports 0 for tanki tenpai', () => {
    // 123m 456m 789m 123p waiting to pair the lone 1p
    expect(standardShanten(counts('123456789m1231p'))).toBe(0);
  });

  it('reports 0 when one partial run completes the hand', () => {
    // 123m 456m 789m + 12p + 11s: drawing 3p wins
    expect(standardShanten(counts('123456789m12p11s'))).toBe(0);
  });

  it('reports 1 for two melds, two partials and a head', () => {
    expect(standardShanten(counts('123456m12p459s11z'))).toBe(1);
  });

  it('reports 2 for one meld, three partials and a head', () => {
    expect(standardShanten(counts('123m124578p11s35z'))).toBe(2);
  });

  it('applies the no-head correction for five pairless blocks', () => {
    // 12m 45m 78m 12p 45p and three isolated honors: five proto-runs but no
    // pair, so one block must be broken down to grow a head.
    expect(standardShanten(counts('124578m1245p135z'))).toBe(4);
  });

  it('accounts for called melds', () => {
    // Two melds called, concealed part is 123m 45p 11s (7 tiles).
    expect(standardShanten(counts('123m45p11s'), 2)).toBe(0);
  });
});

describe('chiitoitsuShanten', () => {
  it('reports 0 with six pairs and a spare kind', () => {
    expect(chiitoitsuShanten(counts('1199m1199p1199s1z'))).toBe(0);
  });

  it('reports -1 with seven pairs', () => {
    expect(chiitoitsuShanten(counts('1199m1199p1199s11z'))).toBe(-1);
  });

  it('penalises hands short of seven distinct kinds', () => {
    // Six pairs (the 666p triplet counts as one, with a dead third copy) but
    // only six kinds, so a seventh kind still has to be drawn: 6 - 6 + 1 = 1
    expect(chiitoitsuShanten(counts('1122334455m666p'))).toBe(1);
  });
});

describe('kokushiShanten', () => {
  it('reports 0 for the thirteen-way wait', () => {
    expect(kokushiShanten(counts('19m19p19s1234567z'))).toBe(0);
  });

  it('reports -1 for a complete hand', () => {
    expect(kokushiShanten(counts('19m19p19s12345677z'))).toBe(-1);
  });

  it('ignores simples', () => {
    expect(kokushiShanten(counts('19m19p19s123456z'))).toBe(1);
  });
});

describe('shanten', () => {
  it('prefers the chiitoitsu reading when it is better', () => {
    // Standard form is hopeless here; seven pairs is tenpai.
    expect(shanten(counts('1199m1199p1199s1z'))).toBe(0);
    expect(standardShanten(counts('1199m1199p1199s1z'))).toBeGreaterThan(0);
  });

  it('prefers the kokushi reading when it is better', () => {
    expect(shanten(counts('19m19p19s1234567z'))).toBe(0);
  });

  it('ignores exotic forms once a meld is called', () => {
    // The same tiles, but with a meld called the seven-pairs reading is gone.
    const hand = counts('1199m1199s1z');
    expect(shanten(hand, 1)).toBe(standardShanten(hand, 1));
  });
});
