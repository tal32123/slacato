import type { DealListItem } from '@slacato/contracts';

export function formatDealAmount(deal: Pick<DealListItem, 'amount' | 'currency'>): string {
  if (deal.amount === null) return 'Not recorded';
  const options: Intl.NumberFormatOptions = deal.currency === null
    ? { maximumFractionDigits: 0 }
    : { style: 'currency', currency: deal.currency, maximumFractionDigits: 0 };
  return new Intl.NumberFormat('en-US', options).format(deal.amount);
}
