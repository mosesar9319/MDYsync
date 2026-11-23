import test from 'node:test';
import assert from 'node:assert/strict';
import { CYCLE, CYCLE_LENGTH, dafYomiOn, dafYomiOfDay, dayNumber, masechtaDays } from '../../shared/daf-yomi.mjs';

// The Daf Yomi schedule (shared/daf-yomi.mjs), checked against the published
// calendar (Sefaria's, looked up for these dates).

const on = (y, m, d) => { const daf = dafYomiOn(y, m, d); return `${daf.masechta.name} ${daf.daf}`; };

test('a cycle is 2,711 dapim', () => {
  assert.equal(CYCLE_LENGTH, 2711);
  assert.equal(CYCLE.length, 40);
});

test('the 14th cycle, from its first daf to its last', () => {
  assert.equal(on(2020, 1, 5), 'Berakhot 2');
  assert.equal(on(2021, 3, 22), 'Pesachim 121');
  assert.equal(on(2021, 3, 23), 'Shekalim 2');           // the Yerushalmi's, between Pesachim and Yoma
  assert.equal(on(2026, 11, 23), 'Arakhin 6');
  assert.equal(on(2027, 2, 20), 'Meilah 2');
  assert.equal(on(2027, 6, 7), 'Niddah 73');
  assert.equal(dafYomiOn(2027, 6, 7).lastOfCycle, true);
  assert.equal(dafYomiOn(2027, 6, 7).cycle, 14);
});

test('Kinnim, Tamid and Middos carry on Meilah\'s page numbers', () => {
  assert.equal(on(2027, 3, 12), 'Meilah 22');
  assert.equal(on(2027, 3, 13), 'Kinnim 23');
  assert.equal(on(2027, 3, 15), 'Kinnim 25');
  assert.equal(on(2027, 3, 16), 'Tamid 26');
  assert.equal(on(2027, 3, 23), 'Tamid 33');
  assert.equal(on(2027, 3, 24), 'Middot 34');
  assert.equal(on(2027, 3, 27), 'Middot 37');
  assert.equal(on(2027, 3, 28), 'Niddah 2');
});

test('the 15th cycle begins the day after', () => {
  const first = dafYomiOn(2027, 6, 8);
  assert.equal(`${first.masechta.name} ${first.daf}`, 'Berakhot 2');
  assert.equal(first.cycle, 15);
  assert.equal(first.first, true);
});

test('a masechta\'s first and last days, and what the site has pages for', () => {
  const day = dayNumber(2026, 11, 23);
  const daf = dafYomiOfDay(day);
  assert.equal(daf.masechta.display, 'Eruchin');
  assert.equal(daf.masechta.slug, 'eruchin');
  assert.equal(daf.masechta.onSite, true);
  const span = masechtaDays(day, daf.masechtaIndex);
  assert.equal(dafYomiOfDay(span.first).daf, 2);
  assert.equal(dafYomiOfDay(span.first).first, true);
  assert.equal(dafYomiOfDay(span.last).daf, 34);
  assert.equal(dafYomiOfDay(span.last).last, true);
  assert.equal(dafYomiOfDay(span.last + 1).masechta.name, 'Temurah');
  assert.equal(dafYomiOn(2021, 3, 23).masechta.onSite, false);
  assert.equal(dafYomiOn(2020, 1, 4), null);            // before the 14th cycle
});
