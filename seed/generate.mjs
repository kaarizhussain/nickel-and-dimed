// Reconstructs two years of Pop In! Play Space & Café vendor spend.
//
// PROVENANCE -- this matters, read it before quoting any number:
//   Real, from the operator's memory: the vendor list, the per-party unit costs
//   (balloons $38 base, pizza $31 base, decor $30-40), party volume (2-5 per
//   weekend), cafe restock (~$50 biweekly), cleaning (~$50/mo), toys ($100-150
//   every few months), and which vendors rose -- balloons after the helium
//   shortage, pizza twice, coffee beans on tariffs.
//   Modeled here: exact dates, exact amounts, and the size of each increase.
//   Vendor names are anonymized.
//
// So: the shape is real, the digits are reconstructed. That is the honest claim,
// and it is a much better one than invented data.
//
//   node seed/generate.mjs > seed/popin-2023-2025.csv

// Deterministic RNG so the seed file is reproducible from this script.
let s = 20260908;
const rnd = () => ((s = (s * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
const between = (lo, hi) => lo + rnd() * (hi - lo);
const pick = (a) => a[Math.floor(rnd() * a.length)];

// Real exports spell the same vendor several ways. This is what the extractor
// has to collapse.
const VENDORS = {
  balloons: ['Party Time Balloons', 'Party Time Balloons LLC', 'PARTY TIME BALLOONS', 'Party Time Balloon Co.'],
  pizza:    ["Tony's Pizza", 'Tonys Pizza', "TONY'S PIZZA CO", "Tony's Pizza Co."],
  decor:    ['Theme Party Decor', 'Theme Party Decor Co', 'THEME PARTY DECOR CO.'],
  coffee:   ['Roast House Coffee', 'Roast House Coffee Co.', 'ROAST HOUSE COFFEE'],
  cleaning: ['CleanCo Supply', 'CleanCo Supply Inc', 'CLEANCO SUPPLY'],
  toys:     ['Playworks Toys', 'Playworks Toys LLC'],
};

// Unit-cost floors by month index (0 = Jan 2023, through Dec 2025). Extras ride
// on top of the base, which is why invoices sit above it rather than on it.
const balloonBase = (m) => (m < 9 ? 38 : m === 9 ? 44 : 47); // helium shortage, Oct 2023
const pizzaBase   = (m) => (m < 6 ? 31 : m < 14 ? 34 : 37);  // two raises: Jul 2023, Mar 2024
const coffeeBase  = (m) => (m < 31 ? 46 : 58);               // bean tariffs, Aug 2025

// Three date formats and two money formats, mixed, the way a real export is.
const fmtDate = (y, mo, d) =>
  pick([
    `${String(mo).padStart(2, '0')}/${String(d).padStart(2, '0')}/${y}`,
    `${mo}/${d}/${String(y).slice(2)}`,
    `${y}-${String(mo).padStart(2, '0')}-${String(d).padStart(2, '0')}`,
  ]);
const fmtAmt = (n) => {
  const v = n.toFixed(2);
  return rnd() < 0.45 ? `"$${Number(v).toLocaleString('en-US', { minimumFractionDigits: 2 })}"` : v;
};

const rows = [];
const add = (y, mo, d, vendor, desc, amt) =>
  rows.push([fmtDate(y, mo, d), vendor, desc, fmtAmt(amt)].join(','));

for (let m = 0; m < 36; m++) {
  const y = 2023 + Math.floor(m / 12);
  const mo = (m % 12) + 1;
  const dim = new Date(y, mo, 0).getDate();

  // 2-5 parties a weekend, ~4 weekends -- call it 10 a month
  const parties = Math.round(between(8, 13));
  for (let p = 0; p < parties; p++) {
    const d = Math.min(dim, Math.max(1, Math.round(between(1, dim))));
    add(y, mo, d, pick(VENDORS.balloons), 'balloon arch + centerpieces', balloonBase(m) + between(0, 9));
    add(y, mo, d, pick(VENDORS.pizza), 'party pizza package', pizzaBase(m) + between(0, 7));
    add(y, mo, d, pick(VENDORS.decor), 'themed decor set', between(30, 40));
  }

  // cafe restock, roughly every two weeks
  for (const d of [Math.round(between(2, 8)), Math.round(between(16, 22))]) {
    add(y, mo, d, pick(VENDORS.coffee), 'coffee beans + snacks', coffeeBase(m) + between(0, 8));
  }

  // cleaning supplies, monthly
  add(y, mo, Math.round(between(24, 28)), pick(VENDORS.cleaning), 'cleaning supplies', between(47, 53));

  // new toys every few months
  if (m % 3 === 1) {
    add(y, mo, Math.round(between(10, 20)), pick(VENDORS.toys), 'new play equipment', between(100, 150));
  }

  // the junk a real export carries
  if (m % 6 === 3) rows.push(`,,MONTH TOTAL,${fmtAmt(between(1400, 1900))}`);
}

console.log('Date,Vendor,Description,Amount');
console.log(rows.join('\n'));
