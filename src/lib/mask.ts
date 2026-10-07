/** "01712345678" → "017•••••678": enough to tell numbers apart, not enough to call. */
export const maskPhone = (phone: string) =>
  phone.length > 6 ? `${phone.slice(0, 3)}${'•'.repeat(phone.length - 6)}${phone.slice(-3)}` : '•'.repeat(phone.length);
