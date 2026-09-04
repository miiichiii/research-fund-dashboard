import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const source = await readFile(new URL("../purchase-case-state.js", import.meta.url), "utf8");
const {
  markIpuOrderCaseAsOrdered,
  markPurchaseLineItemCaseAsOrdered,
} = await import(`data:text/javascript;charset=utf-8,${encodeURIComponent(source)}`);

test("markIpuOrderCaseAsOrdered moves every catalogue row in one purchase case", () => {
  const orders = [
    { id: "a4", purchaseId: "PUR-1", label: "A-4", workflowStatus: "ordered", budgetStatus: "committed" },
    { id: "c4", purchaseId: "PUR-1", label: "C-4", workflowStatus: "considering", budgetStatus: "planned" },
    { id: "e4", purchaseId: "PUR-1", label: "E-4", workflowStatus: "considering", budgetStatus: "planned" },
    { id: "other", purchaseId: "PUR-2", label: "別案件", workflowStatus: "considering", budgetStatus: "planned" },
  ];

  const updated = markIpuOrderCaseAsOrdered(orders, "PUR-1");

  assert.equal(updated.filter((order) => order.purchaseId === "PUR-1").length, 3);
  assert.deepEqual(
    updated.filter((order) => order.purchaseId === "PUR-1").map((order) => [order.workflowStatus, order.budgetStatus, order.status]),
    [
      ["ordered", "committed", "発注済み"],
      ["ordered", "committed", "発注済み"],
      ["ordered", "committed", "発注済み"],
    ],
  );
  assert.deepEqual(updated[3], orders[3]);
  assert.equal(orders[1].workflowStatus, "considering", "the source array remains unchanged");
});

test("markPurchaseLineItemCaseAsOrdered preserves the line-item accounting status", () => {
  const items = [
    { purchaseId: "PUR-1", title: "ユニパック", status: "fixed", workflowStatus: "considering" },
    { purchaseId: "PUR-2", title: "別案件", status: "fixed", workflowStatus: "considering" },
  ];

  const updated = markPurchaseLineItemCaseAsOrdered(items, "PUR-1");

  assert.equal(updated[0].workflowStatus, "ordered");
  assert.equal(updated[0].budgetStatus, "committed");
  assert.equal(updated[0].status, "fixed");
  assert.equal(updated[1].workflowStatus, "considering");
});
