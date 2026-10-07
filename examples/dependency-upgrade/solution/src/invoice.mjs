import { sum } from 'tiny-math';

export function invoiceTotal(lines) {
  return sum(...lines.map((line) => line.qty * line.price));
}
