import { z } from 'zod';
import { Faq, FaqItem, Hero, HomeSections, PageSlug, Promos, SectionKey } from '../lib/content.js';

export { PageSlug };

const HomeSectionList = z.array(z.object({ key: SectionKey, visible: z.boolean() }));

export const PublicContent = z
  .object({
    hero: Hero,
    promos: Promos,
    sections: HomeSectionList.describe('Homepage sections in display order'),
    faq: z.array(FaqItem).describe('Placeholders such as {hotline} are already filled in'),
  })
  .meta({ id: 'StoreContent' });

export const PublicPage = z
  .object({
    slug: PageSlug,
    title: z.string(),
    body: z.string().describe('Markdown subset: ## headings, paragraphs, - lists, **bold**, [links](/path)'),
    updatedAt: z.string().nullable().describe('Null until staff first save the page'),
  })
  .meta({ id: 'StorePage' });

export const PageParam = z.object({ slug: PageSlug });

// ---------- Admin ----------

export const AdminContent = z
  .object({
    hero: Hero,
    promos: Promos,
    homepage_sections: HomeSectionList,
    faq: Faq,
    updatedAt: z.record(z.string(), z.string().nullable()).describe('Per block; null means the default is showing'),
    faqTokens: z.array(z.string()).describe('Placeholders allowed in FAQ answers'),
  })
  .meta({ id: 'AdminContent' });

export const HeroBody = Hero;
export const PromosBody = z.object({ promos: Promos });
export const SectionsBody = z.object({ sections: HomeSections });
export const FaqBody = z.object({ faq: Faq });

export const AdminPageSummary = z
  .object({
    slug: PageSlug,
    title: z.string(),
    updatedAt: z.string().nullable(),
    filledIn: z.boolean().describe('False while the page has headings only'),
  })
  .meta({ id: 'AdminPageSummary' });

export const AdminPage = PublicPage.meta({ id: 'AdminPage' });

export const PageUpdate = z.object({
  title: z.string().trim().min(2).max(100),
  body: z.string().max(30_000),
});

export const UploadedImage = z.object({ url: z.string() }).meta({ id: 'UploadedImage' });

// ---------- Products in homepage sections ----------

export const ProductSectionKey = z.enum(['bestsellers', 'new-arrivals']);

export const SectionProduct = z
  .object({
    id: z.number().int(),
    name: z.string(),
    slug: z.string(),
    image: z.string().nullable(),
    status: z.enum(['draft', 'active', 'archived']).describe('Only active products show on the store'),
  })
  .meta({ id: 'SectionProduct' });

export const SectionProducts = z
  .object({ bestsellers: z.array(SectionProduct), 'new-arrivals': z.array(SectionProduct) })
  .meta({ id: 'SectionProducts' });

export const SectionProductsBody = z.object({
  productIds: z
    .array(z.number().int().positive())
    .max(12)
    .refine((ids) => new Set(ids).size === ids.length, { message: 'Each product can appear once.' })
    .describe('In display order'),
});
