// SMS texts. Kept short and in English (plain GSM characters), so each fits in one or two
// SMS parts; Bangla text is sent as Unicode, where one part holds only 70 characters.
const taka = (n: number) => 'Tk ' + n.toLocaleString('en-IN');

export function orderPlacedSms(o: { orderNo: string; total: number; trackUrl: string }) {
  return `Bunon: Order ${o.orderNo} received. Total ${taka(o.total)}, Cash on Delivery. We will call to confirm. Track: ${o.trackUrl}`;
}

export function orderConfirmedSms(o: { orderNo: string; trackUrl: string }) {
  return `Bunon: Order ${o.orderNo} is confirmed and will be packed soon. Track: ${o.trackUrl}`;
}

/** `codDue` is the amount to collect on delivery; leave it out for prepaid orders. */
export function orderShippedSms(o: { orderNo: string; codDue?: number; trackUrl: string }) {
  const cash = o.codDue ? ` Please keep ${taka(o.codDue)} ready for the courier.` : '';
  return `Bunon: Order ${o.orderNo} is on its way.${cash} Track: ${o.trackUrl}`;
}

export function orderCancelledSms(o: { orderNo: string; hotline: string }) {
  return `Bunon: Order ${o.orderNo} has been cancelled. Questions? Call ${o.hotline}.`;
}

/** For orders staff took by phone or social media: already confirmed with the customer. */
export function manualOrderSms(o: { orderNo: string; total: number; trackUrl: string }) {
  return `Bunon: Order ${o.orderNo} confirmed. Total ${taka(o.total)}, Cash on Delivery. Track: ${o.trackUrl}`;
}
