import { add } from 'tiny-math';

export function invoiceTotal(lines) {
  return lines.reduce((total, line) => add(total, line.qty * line.price), 0);
}
