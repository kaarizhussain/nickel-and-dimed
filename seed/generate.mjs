// Reconstructs three years of Pop In! Play Space & Café vendor spend, itemized.
//
// PROVENANCE -- read this before quoting any number:
//
//   REAL, from operating the business: the vendor list, the per-unit costs
//   (balloon arch $38, pizza $31, decor kit ~$32, coffee ~$46/bag), party volume
//   (2-5 a weekend), cafe restock (~biweekly), cleaning (~monthly), toys (every
//   few months), and which vendors raised prices -- balloons after the helium
//   shortage, pizza twice, coffee beans on tariffs.
//
//   MODELLED HERE: exact dates, exact amounts, exact quantities, and the size of
//   each increase. The original records were no longer accessible.
//
//   Vendor names are anonymized.
//
// So the shape is real and the digits are a synthetic reconstruction. This is not
// a Pop In! financial record and should not be read as one.
//
// ---------------------------------------------------------------------------
// WHY IT IS ITEMIZED
//
// An invoice total moves for two unrelated reasons and only one is a price rise:
// order size (2 pizzas -> 3) and unit price ($31 -> $34). Theme Party Decor
// exists in this data specifically to be the trap: its unit price never moves a
// cent across three years while its order size trends upward, so its invoice
// totals climb steeply. A detector reading invoice averages calls that a price
// increase. It is not one.
// ---------------------------------------------------------------------------
//
//   node seed/generate.mjs > seed/popin-2023-2025.csv

// Deterministic RNG so the seed file is reproducible from this script.
let s = 20260908;
const rnd = () => ((s = (s * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
const between = (lo, hi) => lo + rnd() * (hi - lo);
const pick = (a) => a[Math.floor(rnd() * a.length)];
const jitter = (v, pct) => v * (1 + between(-pct, pct));

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

// Item names drift in spelling too -- norm() collapses them so a product keeps one
// price history instead of splitting into three.
const ITEMS = {
  arch:    ['balloon arch', 'Balloon Arch', 'BALLOON ARCH'],
  centre:  ['centerpiece', 'Centerpiece'],
  pizza:   ['party pizza', 'Party Pizza', 'PARTY PIZZA'],
  kit:     ['themed decor kit', 'Themed Decor Kit'],
  beans:   ['whole bean 5lb', 'Whole Bean 5lb'],
  snacks:  ['snack pack', 'Snack Pack'],
  cleaner: ['cleaning supplies'],
  toy:     ['play equipment', 'Play Equipment'],
};

// ---- unit prices by month index (0 = Jan 2023, through Dec 2025) ----
// These are the ONLY things that step. Everything else that moves is quantity.
const archPrice   = (m) => (m < 9 ? 38 : m === 9 ? 44 : 47);   // helium shortage, Oct 2023
const pizzaPrice  = (m) => (m < 6 ? 31 : m < 14 ? 34 : 37);    // two raises: Jul 2023, Mar 2024
const beanPrice   = (m) => (m < 31 ? 46 : 58);                 // bean tariffs, Aug 2025

// THE TRAP. Rock steady for three years. Only the order size grows.
const kitPrice    = () => 32;
const kitQty      = (m) => Math.round(between(1, 2) + m * 0.09);  // ~1.5 -> ~4.7

// Flat controls.
const centrePrice = () => 6.5;
const snackPrice  = () => 12;
const cleanPrice  = () => 50;

// Three date formats and two money formats, mixed, the way a real export is.
const fmtDate = (y, mo, d) =>
  pick([
    `${String(mo).padStart(2, '0')}/${String(d).padStart(2, '0')}/${y}`,
    `${mo}/${d}/${String(y).slice(2)}`,
    `${y}-${String(mo).padStart(2, '0')}-${String(d).padStart(2, '0')}`,
  ]);
const money = (n) => {
  const v = n.toFixed(2);
  return rnd() < 0.4 ? `"$${Number(v).toLocaleString('en-US', { minimumFractionDigits: 2 })}"` : v;
};

const rows = [];
const line = (y, mo, d, vendor, item, qty, unit) =>
  rows.push([fmtDate(y, mo, d), vendor, item, qty, money(unit), money(qty * unit)].join(','));

for (let m = 0; m < 36; m++) {
  const y = 2023 + Math.floor(m / 12);
  const mo = (m % 12) + 1;
  const dim = new Date(y, mo, 0).getDate();

  // 2-5 parties a weekend, ~4 weekends -- call it 10 a month
  const parties = Math.round(between(8, 13));
  for (let p = 0; p < parties; p++) {
    const d = Math.min(dim, Math.max(1, Math.round(between(1, dim))));
    const bal = pick(VENDORS.balloons);

    // one arch per party, plus a varying number of centerpieces: order size moves,
    // arch price steps only at the helium shortage
    line(y, mo, d, bal, pick(ITEMS.arch), 1, archPrice(m));
    line(y, mo, d, bal, pick(ITEMS.centre), Math.round(between(2, 7)), centrePrice());

    // pizza count varies per party; unit price steps twice
    line(y, mo, d, pick(VENDORS.pizza), pick(ITEMS.pizza), Math.round(between(2, 5)), pizzaPrice(m));

    // THE TRAP: price pinned at $32, quantity climbing all three years
    line(y, mo, d, pick(VENDORS.decor), pick(ITEMS.kit), kitQty(m), kitPrice());
  }

  // cafe restock, roughly every two weeks
  for (const d of [Math.round(between(2, 8)), Math.round(between(16, 22))]) {
    const cof = pick(VENDORS.coffee);
    line(y, mo, d, cof, pick(ITEMS.beans), Math.round(between(1, 3)), jitter(beanPrice(m), 0.03));
    line(y, mo, d, cof, pick(ITEMS.snacks), Math.round(between(1, 4)), snackPrice());
  }

  // cleaning supplies, monthly, one line, flat
  line(y, mo, Math.round(between(24, 28)), pick(VENDORS.cleaning), pick(ITEMS.cleaner), 1,
       jitter(cleanPrice(), 0.05));

  // new toys every few months -- sparse on purpose, below the observation floor
  if (m % 3 === 1) {
    line(y, mo, Math.round(between(10, 20)), pick(VENDORS.toys), pick(ITEMS.toy),
         Math.round(between(1, 3)), between(45, 60));
  }

  // the junk a real export carries
  if (m % 6 === 3) rows.push(`,,MONTH TOTAL,,,${money(between(1400, 1900))}`);
}

console.log('Date,Vendor,Item,Qty,Unit Price,Line Total');
console.log(rows.join('\n'));
