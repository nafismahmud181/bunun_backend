// A courier the store can book parcels with. Pathao today; others (Steadfast, RedX) implement the
// same interface later.

export interface Parcel {
  /** Our order number, e.g. BN-2026-000123 (the courier shows it as the merchant order ID). */
  merchantOrderId: string;
  name: string;
  phone: string;
  /** Full address, including area and district; the courier works out its own zone from it. */
  address: string;
  /** Taka to collect on delivery (0 when already paid). */
  codAmount: number;
  weightKg: number;
  itemQuantity: number;
  description: string;
  instruction?: string;
}

export interface Booked {
  consignmentId: string;
  status: string;
  statusLabel: string;
  deliveryFee: number | null;
}

export interface CourierStatus {
  status: string;
  statusLabel: string;
}

/**
 * What a courier status means for the order. "picked_up" and later move the order to shipped;
 * "delivered" and "returned" finish it; "cancelled" frees the order to be booked again.
 */
export type Stage = 'booked' | 'picked_up' | 'delivered' | 'returned' | 'cancelled';

/**
 * - "rejected": the courier refused the request (e.g. an invalid phone); nothing was booked.
 * - "unavailable": no clear answer (network, timeout, 5xx). For a booking, it may or may not exist.
 */
export class CourierError extends Error {
  constructor(
    readonly kind: 'rejected' | 'unavailable',
    message: string,
    readonly fields?: Record<string, string>,
  ) {
    super(message);
  }
}

export interface CourierDriver {
  readonly name: string;
  readonly label: string;
  /** "sandbox" or "live", shown in the admin so nobody mistakes test bookings for real ones. */
  readonly mode: 'sandbox' | 'live';
  book(parcel: Parcel): Promise<Booked>;
  status(consignmentId: string): Promise<CourierStatus>;
  stage(status: string): Stage;
  trackingUrl(consignmentId: string, phone: string): string;
}
