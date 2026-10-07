import { z } from 'zod';
import type { Db } from './prisma.js';

// Editable storefront content (Phase 5b). Each block is validated here; a block nobody has
// edited yet comes from CONTENT_DEFAULTS, which match the storefront as it was built.

/** A link inside the store ("/shop?cat=…") or to another https site. */
export const Href = z
  .string()
  .trim()
  .max(300)
  // "//x" and "/\x" are links to another site, not store paths.
  .refine((s) => /^\/(?![/\\])/.test(s) || /^https:\/\/[^\s]+$/.test(s), {
    message: 'Use a store path such as /shop or a full https:// address.',
  });

const ImageUrl = z
  .string()
  .trim()
  .max(500)
  .refine((s) => /^https:\/\/[^\s]+$/.test(s), { message: 'Use an uploaded image or an https:// image address.' });

const Button = z.object({ label: z.string().trim().min(1).max(40), href: Href });

export const Hero = z
  .object({
    eyebrow: z.string().trim().max(60).describe('Small line above the headline'),
    title: z.string().trim().min(1).max(120).describe('Headline; wrap words in *stars* to highlight them'),
    text: z.string().trim().max(300),
    primary: Button,
    secondary: Button.nullable(),
    countdownEnds: z.iso
      .datetime({ offset: true })
      .nullable()
      .describe('When the sale ends; the countdown is hidden when empty or past'),
  })
  .meta({ id: 'HeroContent' });

export const Promo = z
  .object({
    tag: z.string().trim().max(30).describe('Label on the tile, e.g. "Up to 25% Off"'),
    tagStyle: z.enum(['gold', 'red']),
    title: z.string().trim().min(1).max(60),
    text: z.string().trim().max(160),
    buttonLabel: z.string().trim().min(1).max(30),
    href: Href,
    imageUrl: ImageUrl,
  })
  .meta({ id: 'PromoTile' });
export const Promos = z.array(Promo).max(4);

export const SECTION_KEYS = [
  'hero',
  'trust',
  'categories',
  'bestsellers',
  'promos',
  'new-arrivals',
  'budget',
  'story',
  'reviews',
  'faq',
  'newsletter',
] as const;
export const SectionKey = z.enum(SECTION_KEYS).meta({ id: 'HomeSectionKey' });

/** Every section exactly once, in display order, each shown or hidden. */
export const HomeSections = z
  .array(z.object({ key: SectionKey, visible: z.boolean() }))
  .refine((list) => list.length === SECTION_KEYS.length && new Set(list.map((s) => s.key)).size === list.length, {
    message: 'List every homepage section exactly once.',
  });

export const FaqItem = z
  .object({
    q: z.string().trim().min(3).max(200),
    a: z.string().trim().min(1).max(1000),
  })
  .meta({ id: 'FaqItem' });
export const Faq = z.array(FaqItem).max(30);

export const CONTENT_DEFAULTS = {
  hero: {
    eyebrow: 'Festive Sale · Limited Time',
    title: 'Up to *25% off* handcrafted runners, kantha & jute',
    text: 'Dress your home for the season with pieces made by artisans in Jashore, Tangail and Rangpur.',
    primary: { label: 'Shop the Sale', href: '/shop' },
    secondary: { label: 'Table Runners', href: '/shop?cat=table-runners' },
    countdownEnds: '2026-10-21T23:59:59+06:00',
  },
  promos: [
    {
      tag: 'Up to 25% Off',
      tagStyle: 'red',
      title: 'Eid Festive Collection',
      text: 'Jamdani runners and kantha linens to welcome guests in style.',
      buttonLabel: 'Shop Festive',
      href: '/shop?cat=table-runners',
      imageUrl: 'https://images.pexels.com/photos/17240972/pexels-photo-17240972.jpeg?auto=compress&cs=tinysrgb&w=1200',
    },
    {
      tag: 'Buy 2, Get 1 Free',
      tagStyle: 'gold',
      title: 'Cushion Cover Combo',
      text: 'Mix and match any three cushion covers — refresh your sofa for less.',
      buttonLabel: 'Shop Cushions',
      href: '/shop?cat=cushion-covers',
      imageUrl: 'https://images.pexels.com/photos/8479733/pexels-photo-8479733.jpeg?auto=compress&cs=tinysrgb&w=1200',
    },
  ],
  homepage_sections: SECTION_KEYS.map((key) => ({ key, visible: true })),
  faq: [
    {
      q: 'Do you offer Cash on Delivery?',
      a: 'Yes. Cash on Delivery is available in all 64 districts. You can also pay in advance with bKash, Nagad or card.',
    },
    {
      q: 'How long does delivery take?',
      a: 'Inside Dhaka city 1–2 working days, outside Dhaka 3–5 working days. You will receive SMS updates once your order is dispatched.',
    },
    {
      q: 'What are the delivery charges?',
      a: '{delivery_fees} Delivery is free on orders above {free_delivery}.',
    },
    {
      q: 'Can I return or exchange a product?',
      a: 'Yes, you can exchange within 7 days if the product is unused and in original packaging. Contact our hotline on {hotline} to arrange a pickup.',
    },
    {
      q: 'Are the products really handmade?',
      a: 'Every item is handmade by artisan groups in Bangladesh, so small variations in colour and stitching are natural and part of its character.',
    },
  ],
} satisfies {
  hero: z.input<typeof Hero>;
  promos: z.input<typeof Promos>;
  homepage_sections: z.input<typeof HomeSections>;
  faq: z.input<typeof Faq>;
};

export type ContentKey = keyof typeof CONTENT_DEFAULTS;
export const CONTENT_SCHEMAS = { hero: Hero, promos: Promos, homepage_sections: HomeSections, faq: Faq } as const;
export type Content = { [K in ContentKey]: z.infer<(typeof CONTENT_SCHEMAS)[K]> };

/**
 * Every content block, with defaults for blocks nobody has saved. A stored value that no longer
 * passes validation (after a schema change) falls back to the default instead of breaking the site.
 */
export async function getContent(
  db: Pick<Db, 'contentBlock'>,
): Promise<Content & { updatedAt: Record<string, string | null> }> {
  const rows = await db.contentBlock.findMany();
  const out = { updatedAt: {} } as Content & { updatedAt: Record<string, string | null> };
  for (const key of Object.keys(CONTENT_DEFAULTS) as ContentKey[]) {
    const row = rows.find((r) => r.key === key);
    const parsed = row ? CONTENT_SCHEMAS[key].safeParse(row.value) : null;
    (out as Record<string, unknown>)[key] = parsed?.success
      ? parsed.data
      : CONTENT_SCHEMAS[key].parse(CONTENT_DEFAULTS[key]);
    out.updatedAt[key] = parsed?.success ? row!.updatedAt.toISOString() : null;
  }
  return out;
}

/** Placeholders staff can use in FAQ answers, filled in from the live settings. */
export const FAQ_TOKENS = ['{hotline}', '{free_delivery}', '{delivery_fees}'] as const;

export function fillFaqTokens(
  text: string,
  s: { hotline: string; freeDeliveryThreshold: number; zones: { name: string; fee: number }[] },
) {
  const taka = (n: number) => `৳${n.toLocaleString('en-US')}`;
  const lowerFirst = (t: string) => t.charAt(0).toLowerCase() + t.slice(1);
  const fees = s.zones.map((z) => `${taka(z.fee)} ${lowerFirst(z.name.replace(/ City$/, ''))}`).join(' and ') + '.';
  return text
    .replaceAll('{hotline}', s.hotline)
    .replaceAll('{free_delivery}', taka(s.freeDeliveryThreshold))
    .replaceAll('{delivery_fees}', fees);
}

// ---------- Pages ----------

export const PAGE_SLUGS = ['about', 'privacy', 'terms', 'refund-policy'] as const;
export const PageSlug = z.enum(PAGE_SLUGS);

const outline = (...headings: string[]) => headings.map((h) => `## ${h}`).join('\n\n');

/** Starting structure for each page: headings only, for the owner to fill in (see ROADMAP Phase 2). */
export const PAGE_DEFAULTS: Record<(typeof PAGE_SLUGS)[number], { title: string; body: string }> = {
  about: {
    title: 'About Bunon',
    body: outline('Our story', 'Our artisans', 'Business details', 'Contact us'),
  },
  privacy: {
    title: 'Privacy Policy',
    body: outline(
      'Information we collect',
      'How we use your information',
      'Who we share it with',
      'Cookies and similar technologies',
      'How long we keep your information',
      'Your choices and rights',
      'Contact us',
    ),
  },
  terms: {
    title: 'Terms and Conditions',
    body: outline(
      'About these terms',
      'Orders and confirmation',
      'Prices and payment',
      'Delivery',
      'Product colours and handmade variation',
      'Cancellations',
      'Limitation of liability',
      'Governing law',
      'Contact us',
    ),
  },
  'refund-policy': {
    title: 'Refund and Return Policy',
    body: outline(
      'Exchanges',
      'Returns',
      'Items that cannot be returned',
      'Damaged or wrong items',
      'Refunds',
      'How to start a return or exchange',
    ),
  },
};
