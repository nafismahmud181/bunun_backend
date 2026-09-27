import { z } from 'zod';
import { Image } from './catalogue.js';
import { BdPhone } from './orders.js';

export const PublicReview = z
  .object({
    id: z.number().int(),
    name: z.string(),
    city: z.string().nullable(),
    rating: z.number().int().min(1).max(5),
    body: z.string(),
    images: z.array(z.string()).describe('Photo URLs (…-1200.webp; swap the suffix for 400 or 800)'),
    createdAt: z.string(),
  })
  .meta({ id: 'PublicReview' });

export const RatingSummary = z
  .object({
    average: z.number().nullable(),
    count: z.number().int(),
    breakdown: z.record(z.enum(['1', '2', '3', '4', '5']), z.number().int()).describe('Approved reviews per star'),
  })
  .meta({ id: 'RatingSummary' });

export const ProductReviews = z
  .object({
    summary: RatingSummary,
    items: z.array(PublicReview),
    total: z.number().int(),
    page: z.number().int(),
    limit: z.number().int(),
  })
  .meta({ id: 'ProductReviews' });

export const ProductReviewsQuery = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(50).default(10),
});

export const FeaturedReviews = z
  .object({
    average: z.number().nullable().describe('Across every approved review in the store'),
    count: z.number().int(),
    items: z.array(PublicReview.extend({ product: z.object({ slug: z.string(), name: z.string() }) })),
  })
  .meta({ id: 'FeaturedReviews' });

export const FeaturedQuery = z.object({ limit: z.coerce.number().int().min(1).max(12).default(6) });

export const ReviewLookupBody = z.object({
  orderNo: z.string().trim().toUpperCase().max(30),
  phone: BdPhone,
});

export const ReviewableOrder = z
  .object({
    orderNo: z.string(),
    suggestedName: z.string().describe('e.g. "Rahima B." — shoppers can change it'),
    items: z.array(
      z.object({
        slug: z.string(),
        name: z.string(),
        label: z.string(),
        image: Image.nullable(),
        reviewed: z.boolean(),
      }),
    ),
  })
  .meta({ id: 'ReviewableOrder' });

/** The text fields of a review submission (sent as multipart/form-data with up to 3 "photo" files). */
export const ReviewFields = ReviewLookupBody.extend({
  slug: z.string().max(200),
  rating: z.coerce.number().int().min(1).max(5),
  name: z.string().trim().min(2).max(40),
  body: z.string().trim().min(10, 'Please write at least a sentence.').max(2000),
});

export const ReviewSubmitted = z
  .object({ id: z.number().int(), status: z.literal('pending') })
  .meta({ id: 'ReviewSubmitted' });

export const MAX_REVIEW_PHOTOS = 3;
