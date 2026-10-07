import { test } from 'node:test';
import assert from 'node:assert/strict';
import { invoiceTotal } from '../src/invoice.mjs';

test('totals quantity x price', () => {
  assert.equal(invoiceTotal([{ qty: 2, price: 5 }, { qty: 1, price: 3 }]), 13);
});

test('empty invoice is zero', () => {
  assert.equal(invoiceTotal([]), 0);
});
