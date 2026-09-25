// Catalogue copied from the storefront's lib/store.js (bunun_frontend) for the initial import.
// After the first seed, products are managed in the database (admin panel), not here.

export const categories = [
  { name: 'Table Runners', img: 27034205, sizes: ['13 × 72"', '13 × 90"', '13 × 108"'] },
  { name: 'Cushion Covers', img: 11701115, sizes: ['16 × 16"', '18 × 18"', '20 × 20"'] },
  { name: 'Table Mats & Napkins', img: 3217501, sizes: ['Set of 4', 'Set of 6'] },
  { name: 'Bed & Throws', img: 545015, sizes: ['Single', 'Double', 'King'] },
  { name: 'Jute Décor', img: 5371357, sizes: ['Small', 'Medium', 'Large'] },
];

// Price multiplier for each size step, as in the old `sizeUplift` formula.
export const sizeUplift = [0, 0.2, 0.4];

export const products: {
  id: string;
  name: string;
  cat: string;
  price: number;
  was?: number;
  tag?: string;
  img: number;
  desc: string;
}[] = [
  {
    id: 'r1',
    name: 'Nakshi Kantha Table Runner',
    cat: 'Table Runners',
    price: 1850,
    was: 2200,
    tag: 'Best Seller',
    img: 27034205,
    desc: 'Hand-stitched nakshi kantha on soft cotton, made by artisans in Jashore. Traditional running-stitch motifs with a neat bound edge.',
  },
  {
    id: 'r2',
    name: 'Jamdani Motif Runner',
    cat: 'Table Runners',
    price: 2450,
    tag: 'New',
    img: 17240972,
    desc: 'Woven with classic jamdani floral motifs on an ivory base. An elegant choice for dining tables during Eid and festive gatherings.',
  },
  {
    id: 'r3',
    name: 'Braided Jute Table Runner',
    cat: 'Table Runners',
    price: 950,
    img: 6310305,
    desc: 'Natural golden jute, tightly braided for durability. Eco-friendly and easy to wipe clean.',
  },
  {
    id: 'r4',
    name: 'Handloom Cotton Stripe Runner',
    cat: 'Table Runners',
    price: 1250,
    img: 6004129,
    desc: 'Tangail handloom cotton in navy with fine ivory stripes. Machine washable and colour-fast.',
  },
  {
    id: 'c1',
    name: 'Nakshi Kantha Cushion Cover',
    cat: 'Cushion Covers',
    price: 850,
    was: 990,
    tag: 'Best Seller',
    img: 8330673,
    desc: 'Kantha-stitched cushion cover with a hidden zip closure. Insert not included.',
  },
  {
    id: 'c2',
    name: 'Tangail Weave Cushion Cover',
    cat: 'Cushion Covers',
    price: 750,
    img: 14959627,
    desc: 'Soft handloom weave from Tangail in a muted olive tone. Pairs well with neutral sofas.',
  },
  {
    id: 'c3',
    name: 'Jute Blend Cushion Cover',
    cat: 'Cushion Covers',
    price: 650,
    img: 8479733,
    desc: 'Textured jute-cotton blend with a natural finish. Hidden zip, double-stitched seams.',
  },
  {
    id: 'm1',
    name: 'Round Jute Placemats',
    cat: 'Table Mats & Napkins',
    price: 1200,
    tag: 'Best Seller',
    img: 3217501,
    desc: 'Hand-coiled round jute placemats, 15" diameter. Heat resistant and sturdy.',
  },
  {
    id: 'm2',
    name: 'Cotton Napkin Set',
    cat: 'Table Mats & Napkins',
    price: 900,
    img: 8112792,
    desc: 'Pre-washed cotton napkins with hemmed edges, 18 × 18". Gets softer with every wash.',
  },
  {
    id: 'b1',
    name: 'Kantha Stitch Throw',
    cat: 'Bed & Throws',
    price: 3800,
    img: 11701115,
    desc: 'Layered vintage-cotton throw with dense kantha stitching. Lightweight and reversible.',
  },
  {
    id: 'b2',
    name: 'Handloom Bedcover',
    cat: 'Bed & Throws',
    price: 4500,
    was: 5200,
    tag: 'Sale',
    img: 545015,
    desc: 'Handloom cotton bedcover with woven border, includes two matching pillow covers.',
  },
  {
    id: 'j1',
    name: 'Jute Wall Hanging',
    cat: 'Jute Décor',
    price: 1100,
    img: 5371357,
    desc: 'Macramé-style jute wall hanging on a bamboo rod. Handmade in Rangpur.',
  },
  {
    id: 'j2',
    name: 'Seagrass Storage Basket',
    cat: 'Jute Décor',
    price: 1350,
    img: 19526437,
    desc: 'Woven seagrass basket with handles — for throws, toys or laundry.',
  },
];

// Placeholder opening stock for every variant; set real counts in the admin panel.
export const openingStock = 20;
