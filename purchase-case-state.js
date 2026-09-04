export function getPurchaseCaseId(order = {}) {
  return order.caseId || order.purchaseId || order.id || `ipu-order-${order.order || order.itemName || "unknown"}`;
}

export function getLineItemCaseId(item = {}) {
  if (item.caseId || item.purchaseId) return item.caseId || item.purchaseId;
  if (item.order === 180 || String(item.title || "").includes("Bambu Lab PLAマット")) {
    return "PUR-2026-0728-01";
  }
  return `line-item-${item.order || String(item.title || "").trim() || "unknown"}`;
}

/**
 * An IPU purchase can contain several catalogue rows under one purchase ID.
 * Marking it ordered must move every row in that purchase together.
 */
export function markIpuOrderCaseAsOrdered(orders, caseId) {
  return (Array.isArray(orders) ? orders : []).map((order) =>
    getPurchaseCaseId(order) === caseId
      ? {
          ...order,
          workflowStatus: "ordered",
          budgetStatus: "committed",
          archived: false,
          // Keep the legacy fields in sync for older views and imports.
          status: "発注済み",
          statusLabel: "発注済み・納品／検収待ち",
        }
      : order,
  );
}

export function markPurchaseLineItemCaseAsOrdered(items, caseId) {
  return (Array.isArray(items) ? items : []).map((item) =>
    getLineItemCaseId(item) === caseId
      ? {
          ...item,
          workflowStatus: "ordered",
          budgetStatus: "committed",
          archived: false,
        }
      : item,
  );
}
