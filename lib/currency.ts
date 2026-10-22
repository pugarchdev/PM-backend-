/**
 * Centralized Currency Formatting Utility for Fern & Foley Projects
 * Standard: Indian Rupee (INR ₹), Locale: en-IN
 */

export interface FormatCurrencyOptions {
  maximumFractionDigits?: number;
  minimumFractionDigits?: number;
}

export const CURRENCY_SYMBOL = '₹';
export const CURRENCY_CODE = 'INR';
export const CURRENCY_LOCALE = 'en-IN';

export const formatCurrency = (
  amount: number | string | null | undefined,
  options?: FormatCurrencyOptions
): string => {
  const numericAmount = typeof amount === 'number' ? amount : Number(amount) || 0;
  return new Intl.NumberFormat(CURRENCY_LOCALE, {
    style: 'currency',
    currency: CURRENCY_CODE,
    maximumFractionDigits: options?.maximumFractionDigits ?? 2,
    ...(options?.minimumFractionDigits !== undefined ? { minimumFractionDigits: options.minimumFractionDigits } : {}),
  }).format(numericAmount);
};
