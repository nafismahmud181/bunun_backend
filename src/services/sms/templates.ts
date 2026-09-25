// SMS texts. Kept short and in English (plain GSM characters), so each fits in one or two
// SMS parts; Bangla text is sent as Unicode, where one part holds only 70 characters.
const taka = (n: number) => 'Tk ' + n.toLocaleString('en-IN');

export function orderPlacedSms(o: { orderNo: string; total: number; trackUrl: string }) {
  return `Bunon: Order ${o.orderNo} received. Total ${taka(o.total)}, Cash on Delivery. We will call to confirm. Track: ${o.trackUrl}`;
}
