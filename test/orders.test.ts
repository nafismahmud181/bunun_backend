import { describe, expect, it } from 'vitest';
import { BdPhone } from '../src/schemas/orders.js';
import { trackUrl } from '../src/services/checkout.js';
import { deliveryFee } from '../src/services/delivery.js';
import { orderPlacedSms } from '../src/services/sms/templates.js';

describe('BdPhone', () => {
  it('accepts the usual ways of writing a Bangladeshi mobile number', () => {
    for (const input of ['01712345678', '+8801712345678', '8801712345678', '017-1234-5678', ' 01712 345678 '])
      expect(BdPhone.parse(input)).toBe('01712345678');
  });

  it('rejects landlines, short numbers and unknown operators', () => {
    for (const input of ['0171234567', '021234567', '01212345678', '1712345678', 'abc'])
      expect(BdPhone.safeParse(input).success).toBe(false);
  });
});

describe('deliveryFee', () => {
  it('charges the zone fee below the free-delivery threshold', () => {
    expect(deliveryFee(2999, 130, 3000)).toBe(130);
    expect(deliveryFee(3000, 130, 3000)).toBe(0);
    expect(deliveryFee(0, 130, 3000)).toBe(0);
  });
});

describe('order SMS', () => {
  it('includes the order number, total and track link in one plain-text message', () => {
    const body = orderPlacedSms({
      orderNo: 'BN-2026-000123',
      total: 2830,
      trackUrl: trackUrl('https://bunon.com.bd/', 'BN-2026-000123'),
    });
    expect(body).toBe(
      'Bunon: Order BN-2026-000123 received. Total Tk 2,830, Cash on Delivery. We will call to confirm. Track: https://bunon.com.bd/track?order=BN-2026-000123',
    );
    expect(body).toMatch(/^[\x20-\x7e]+$/); // GSM-safe, so it isn't sent as Unicode
    expect(body.length).toBeLessThanOrEqual(306); // at most two SMS parts
  });
});
