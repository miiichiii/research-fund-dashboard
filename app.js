import { initializeApp } from "https://www.gstatic.com/firebasejs/12.14.0/firebase-app.js";
import {
  browserLocalPersistence,
  getAuth,
  GoogleAuthProvider,
  onAuthStateChanged,
  setPersistence,
  signInWithPopup,
  signOut,
} from "https://www.gstatic.com/firebasejs/12.14.0/firebase-auth.js";
import {
  doc,
  getFirestore,
  onSnapshot,
  serverTimestamp,
  setDoc,
} from "https://www.gstatic.com/firebasejs/12.14.0/firebase-firestore.js";
import { firebaseConfig } from "./firebase-config.js";

const DASHBOARD_COLLECTION = "researchFundDashboards";
const DASHBOARD_ID = "main";

const COLLECTIONS = {
  dashboard: `${DASHBOARD_COLLECTION}/${DASHBOARD_ID}`,
};

const statusLabels = {
  confirmed: "確認済み",
  partial: "一部確認",
  unknown: "未確認",
  rough: "粗枠",
  spent: "記録済み",
  provisional: "仮更新",
  fixed: "先引き",
  check: "要確認",
  later: "後回し",
};

const emptyDashboard = {
  funds: [],
  allocations: [],
  lineItems: [],
  checks: [],
  projects: [],
  ipuOrders: [],
};

const ipuFormFields = [
  { label: "メーカー名", getValue: (order) => order.manufacturer },
  { label: "品名", getValue: (order) => order.itemName },
  { label: "規格・品質", getValue: (order) => order.specification },
  { label: "型番・品番", getValue: (order) => order.catalogNumber },
  { label: "数量", getValue: (order) => order.quantity },
  { label: "単位", getValue: (order) => order.unit },
  { label: "単価（円）", getValue: (order) => formatOptionalInputNumber(order.unitPriceYen) },
  { label: "金額（円）", getValue: (order) => formatOptionalInputNumber(order.totalYen) },
  { label: "主たる使用者", getValue: (order) => order.primaryUser },
  { label: "専用共用別", getValue: (order) => order.sharedUsage },
  { label: "備考", getValue: (order) => order.remarks || order.note },
];

const app = initializeApp(firebaseConfig);
const auth = getAuth(app);
const db = getFirestore(app);
const provider = new GoogleAuthProvider();
provider.setCustomParameters({ prompt: "select_account" });
const canSeedFromLocalFile = ["localhost", "127.0.0.1"].includes(window.location.hostname);

const state = {
  user: null,
  data: { ...emptyDashboard },
  loading: false,
  loaded: false,
  permissionDenied: false,
  error: null,
  updatedAt: null,
  updatedBy: "",
  activeFilter: "all",
  activeFundId: null,
  unsubscribeDashboard: null,
};

const panels = {
  overview: document.getElementById("overviewPanel"),
  funds: document.getElementById("fundsPanel"),
  allocations: document.getElementById("allocationsPanel"),
  items: document.getElementById("itemsPanel"),
  checks: document.getElementById("checksPanel"),
  "ipu-orders": document.getElementById("ipuOrdersPanel"),
};

const elements = {
  loginButton: document.getElementById("loginButton"),
  logoutButton: document.getElementById("logoutButton"),
  seedButton: document.getElementById("seedButton"),
  syncStatus: document.getElementById("syncStatus"),
  userLabel: document.getElementById("userLabel"),
  authGate: document.getElementById("authGate"),
  authGateMessage: document.getElementById("authGateMessage"),
  viewTabs: Array.from(document.querySelectorAll(".view-tab")),
  segments: Array.from(document.querySelectorAll(".segment")),
  summaryGrid: document.getElementById("summaryGrid"),
  priorityList: document.getElementById("priorityList"),
  projectList: document.getElementById("projectList"),
  fundCards: document.getElementById("fundCards"),
  allocationTable: document.getElementById("allocationTable"),
  lineItemTable: document.getElementById("lineItemTable"),
  checkList: document.getElementById("checkList"),
  ipuOrderList: document.getElementById("ipuOrderList"),
  fundDetailDialog: document.getElementById("fundDetailDialog"),
  fundDetailClose: document.getElementById("fundDetailClose"),
  fundDetailCode: document.getElementById("fundDetailCode"),
  fundDetailTitle: document.getElementById("fundDetailTitle"),
  fundDetailMetrics: document.getElementById("fundDetailMetrics"),
  usedItemsCount: document.getElementById("usedItemsCount"),
  usedItemsList: document.getElementById("usedItemsList"),
  plannedItemsCount: document.getElementById("plannedItemsCount"),
  plannedItemsList: document.getElementById("plannedItemsList"),
};

setPersistence(auth, browserLocalPersistence).catch((error) => {
  setSyncStatus(`認証保存エラー: ${error.code}`, "blocked");
});

elements.loginButton.addEventListener("click", async () => {
  try {
    await signInWithPopup(auth, provider);
  } catch (error) {
    if (error.code === "auth/popup-closed-by-user") {
      setSyncStatus("ログインが中断されました", "check");
      return;
    }
    if (["auth/popup-blocked", "auth/cancelled-popup-request"].includes(error.code)) {
      setSyncStatus("ポップアップを許可してください", "check");
      return;
    }
    if (error.code === "auth/unauthorized-domain") {
      setSyncStatus("Firebase認証ドメイン未許可", "blocked");
      return;
    }
    setSyncStatus(`ログインエラー: ${error.code}`, "blocked");
  }
});

elements.logoutButton.addEventListener("click", async () => {
  await signOut(auth);
});

elements.seedButton.addEventListener("click", seedDashboardFromLocalFile);
elements.fundDetailClose.addEventListener("click", closeFundDetail);
elements.fundDetailDialog.addEventListener("click", (event) => {
  if (event.target === elements.fundDetailDialog) closeFundDetail();
});
elements.fundDetailDialog.addEventListener("close", () => {
  state.activeFundId = null;
});

elements.viewTabs.forEach((tab) => {
  tab.addEventListener("click", () => activateView(tab.dataset.view));
});

elements.segments.forEach((segment) => {
  segment.addEventListener("click", () => {
    state.activeFilter = segment.dataset.filter;
    elements.segments.forEach((candidate) => candidate.classList.toggle("is-active", candidate === segment));
    renderLineItems();
  });
});

onAuthStateChanged(auth, (user) => {
  resetDashboardSubscription();
  state.user = user;
  state.error = null;
  state.permissionDenied = false;
  state.data = { ...emptyDashboard };
  state.loaded = false;
  state.loading = Boolean(user);
  state.updatedAt = null;
  state.updatedBy = "";

  if (!user) {
    setSyncStatus("ログイン待ち", "locked");
    render();
    return;
  }

  setSyncStatus("Firestore読み込み中", "provisional");
  render();
  subscribeDashboard();
});

function subscribeDashboard() {
  state.unsubscribeDashboard = onSnapshot(dashboardRef(), (snapshot) => {
    state.loading = false;
    state.permissionDenied = false;
    state.error = null;

    if (!snapshot.exists()) {
      state.data = { ...emptyDashboard };
      state.loaded = false;
      state.updatedAt = null;
      state.updatedBy = "";
      setSyncStatus("Firestore台帳なし", "check");
      render();
      return;
    }

    const payload = snapshot.data();
    state.data = normalizeDashboardData(payload);
    state.loaded = true;
    state.updatedAt = payload.updatedAt || null;
    state.updatedBy = payload.updatedBy || "";
    setSyncStatus("Firestore同期済み", "confirmed");
    render();
  }, (error) => {
    state.loading = false;
    state.loaded = false;
    state.data = { ...emptyDashboard };
    state.error = error;
    state.permissionDenied = error.code === "permission-denied";
    setSyncStatus(state.permissionDenied ? "Firestore権限なし" : `Firestoreエラー: ${error.code}`, "blocked");
    render();
  });
}

async function seedDashboardFromLocalFile() {
  if (!state.user) return;

  elements.seedButton.disabled = true;
  setSyncStatus("初期データ投入中", "provisional");

  try {
    const module = await import(`./seed.local.js?v=${Date.now()}`);
    const initialData = module.dashboardData;

    if (!initialData || typeof initialData !== "object") {
      throw new Error("seed.local.js に dashboardData がありません");
    }

    const normalized = normalizeDashboardData(initialData);
    await setDoc(dashboardRef(), {
      ...sanitizeForFirestore(normalized),
      updatedAt: serverTimestamp(),
      updatedBy: state.user.email || state.user.uid,
      source: "local-seed",
    }, { merge: true });

    setSyncStatus("初期データ投入済み", "confirmed");
  } catch (error) {
    if (error.message.includes("Failed to fetch dynamically imported module")) {
      setSyncStatus("seed.local.js がありません", "blocked");
    } else if (error.code) {
      setSyncStatus(`投入エラー: ${error.code}`, "blocked");
    } else {
      setSyncStatus(`投入エラー: ${error.message}`, "blocked");
    }
    render();
  } finally {
    elements.seedButton.disabled = false;
  }
}

function dashboardRef() {
  return doc(db, DASHBOARD_COLLECTION, DASHBOARD_ID);
}

function resetDashboardSubscription() {
  if (state.unsubscribeDashboard) {
    state.unsubscribeDashboard();
    state.unsubscribeDashboard = null;
  }
}

function normalizeDashboardData(payload = {}) {
  return {
    funds: sortByOrder(asArray(payload.funds)),
    allocations: sortByOrder(asArray(payload.allocations)),
    lineItems: sortByOrder(asArray(payload.lineItems)),
    checks: sortByOrder(asArray(payload.checks)),
    projects: sortByOrder(asArray(payload.projects)),
    ipuOrders: sortByOrder(asArray(payload.ipuOrders)),
  };
}

function asArray(value) {
  return Array.isArray(value) ? value.map((entry, index) => ({ order: index + 1, ...entry })) : [];
}

function sortByOrder(items) {
  return items.slice().sort((a, b) => (a.order ?? 9999) - (b.order ?? 9999));
}

function sanitizeForFirestore(value) {
  return JSON.parse(JSON.stringify(value));
}

function render() {
  updateAuthUI();

  if (!state.user || !state.loaded) {
    renderEmptyDashboard();
    return;
  }

  renderSummary();
  renderPriority();
  renderProjects();
  renderFunds();
  renderAllocations();
  renderLineItems();
  renderChecks();
  renderIpuOrders();
}

function updateAuthUI() {
  const signedIn = Boolean(state.user);
  elements.loginButton.hidden = signedIn;
  elements.logoutButton.hidden = !signedIn;
  elements.seedButton.hidden = !canSeedFromLocalFile || !signedIn || state.permissionDenied;
  elements.userLabel.textContent = signedIn
    ? `${state.user.email || state.user.displayName || "Googleユーザー"}${state.updatedAt ? ` / ${formatUpdatedAt(state.updatedAt)}` : ""}`
    : "Googleアカウントで表示";

  elements.authGate.hidden = signedIn && state.loaded && !state.error;
  if (!signedIn) {
    elements.authGateMessage.textContent = "研究費の金額や明細は静的ファイルに置かず、許可されたGoogleアカウントでログインした時だけFirestoreから読み込みます。";
  } else if (state.loading) {
    elements.authGateMessage.textContent = "Firestoreから研究費台帳を読み込んでいます。";
  } else if (state.permissionDenied) {
    elements.authGateMessage.textContent = "ログインはできていますが、このGoogleアカウントには研究費台帳のFirestore権限がありません。Firestore rulesの許可ユーザーを確認してください。";
  } else if (state.error) {
    elements.authGateMessage.textContent = `Firestoreの読み込みでエラーが出ています: ${state.error.code || state.error.message}`;
  } else if (!state.loaded) {
    elements.authGateMessage.textContent = "Firestoreに研究費台帳がまだありません。ローカルの seed.local.js がある場合は、初期データ投入ボタンで作成できます。";
  }
}

function setSyncStatus(label, status) {
  elements.syncStatus.textContent = label;
  elements.syncStatus.dataset.status = status;
}

function renderEmptyDashboard() {
  const message = state.user
    ? "Firestoreの研究費データを読み込み中、または未作成です。"
    : "Googleログイン後に研究費データを表示します。";

  elements.summaryGrid.replaceChildren(renderEmptyState(message));
  elements.priorityList.replaceChildren();
  elements.projectList.replaceChildren();
  elements.fundCards.replaceChildren(renderEmptyState(message));
  elements.allocationTable.replaceChildren(renderTable(
    ["配分枠", "資金枠", "プロジェクト", "区分", "枠/目安", "記録済み", "状態", "次に確認"],
    [],
  ));
  elements.lineItemTable.replaceChildren(renderTable(
    ["状態", "支出項目", "資金枠", "配分枠", "プロジェクト", "金額", "日付", "次に確認"],
    [],
  ));
  elements.checkList.replaceChildren(renderEmptyState(message));
  elements.ipuOrderList.replaceChildren(renderEmptyState(message));
}

function renderEmptyState(message) {
  const empty = document.createElement("div");
  empty.className = "empty-state";
  empty.textContent = message;
  return empty;
}

function formatYen(value) {
  if (!Number.isFinite(value)) return "未確認";
  return new Intl.NumberFormat("ja-JP", {
    style: "currency",
    currency: "JPY",
    maximumFractionDigits: 0,
  }).format(value);
}

function formatUpdatedAt(value) {
  const date = typeof value?.toDate === "function" ? value.toDate() : null;
  if (!date) return "更新時刻未取得";
  return new Intl.DateTimeFormat("ja-JP", {
    dateStyle: "short",
    timeStyle: "short",
  }).format(date);
}

function funds() {
  return (state.data.funds || []).filter((fund) => fund.archived !== true);
}

function allocations() {
  return state.data.allocations || [];
}

function lineItems() {
  return state.data.lineItems || [];
}

function checks() {
  return state.data.checks || [];
}

function projects() {
  return state.data.projects || [];
}

function ipuOrders() {
  return state.data.ipuOrders || [];
}

function renderIpuOrders() {
  const orders = ipuOrders();
  if (!orders.length) {
    elements.ipuOrderList.replaceChildren(renderEmptyState("IPUで注文する品目はまだ登録されていません。"));
    return;
  }

  const renderedOrders = orders.map((order) => {
    const card = document.createElement("article");
    card.className = "ipu-order-card";

    const head = document.createElement("div");
    head.className = "ipu-order-head";
    const titleWrap = document.createElement("div");
    const id = document.createElement("p");
    id.className = "kicker";
    id.textContent = order.purchaseId || "IPU購入候補";
    const title = document.createElement("h3");
    title.textContent = order.label || order.itemName || "品名未確認";
    titleWrap.append(id, title);
    head.append(titleWrap, statusBadge(order.statusLabel || "申請準備", order.status || "check"));

    const quickCopy = renderCopyField(
      "申請画面へそのまま貼り付け",
      buildIpuFormCopyText(order),
      { buttonText: "11項目コピー", className: "copy-field--bundle" },
    );

    const formFields = document.createElement("div");
    formFields.className = "form-copy-list";
    getIpuFormEntries(order).forEach(([label, value]) => formFields.append(renderFormCopyField(label, value)));

    card.append(head, quickCopy, formFields);

    const referenceFields = [
      ["業者名", order.vendor],
      ["見積番号", order.quoteNumber],
      ["見積有効期限", order.quoteValidUntil],
    ].filter(([, value]) => hasCopyValue(value));

    if (referenceFields.length) {
      const referenceSection = document.createElement("section");
      referenceSection.className = "ipu-reference-section";
      const referenceLabel = document.createElement("p");
      referenceLabel.className = "mini-label";
      referenceLabel.textContent = "確認用";
      const referenceGrid = document.createElement("div");
      referenceGrid.className = "copy-field-grid copy-field-grid--meta";
      referenceFields.forEach(([label, value]) => referenceGrid.append(renderCopyField(label, value)));
      referenceSection.append(referenceLabel, referenceGrid);
      card.append(referenceSection);
    }

    if (order.note && order.remarks && order.note !== order.remarks) {
      const note = document.createElement("p");
      note.className = "ipu-order-note";
      note.textContent = order.note;
      card.append(note);
    }
    return card;
  });

  if (orders.length > 1) {
    elements.ipuOrderList.replaceChildren(renderIpuBulkCopyPanel(orders), ...renderedOrders);
    return;
  }

  elements.ipuOrderList.replaceChildren(...renderedOrders);
}

function formatOptionalInputNumber(value) {
  if (typeof value === "number" && Number.isFinite(value)) {
    return String(Math.trunc(value));
  }
  if (typeof value === "string") {
    const normalized = value
      .trim()
      .replace(/[０-９]/g, (digit) => String.fromCharCode(digit.charCodeAt(0) - 0xfee0))
      .replace(/,/g, "");
    return /^\d+$/.test(normalized) ? normalized : "";
  }
  return "";
}

function hasCopyValue(value) {
  return value === 0 || (typeof value === "string" ? value.trim() : Boolean(value));
}

function getIpuFormEntries(order) {
  return ipuFormFields.map((field) => [field.label, field.getValue(order)]);
}

function buildIpuFormCopyText(order) {
  return getIpuFormEntries(order)
    .map(([, value]) => formatCopyValue(value))
    .join("\n");
}

function buildIpuBulkCopyText(orders) {
  return orders
    .map((order) => getIpuFormEntries(order).map(([, value]) => formatCopyValue(value)).join("\t"))
    .join("\n");
}

function formatCopyValue(rawValue) {
  if (rawValue === 0) return "0";
  if (typeof rawValue === "string") {
    const trimmed = rawValue.trim();
    return trimmed || "要確認";
  }
  return rawValue ? String(rawValue) : "要確認";
}

function renderFormCopyField(label, rawValue) {
  const value = formatCopyValue(rawValue);
  const row = document.createElement("div");
  row.className = "form-copy-row";
  const name = document.createElement("span");
  name.className = "form-copy-label";
  name.textContent = label;
  const output = document.createElement("pre");
  output.className = "form-copy-value";
  output.textContent = value;
  const button = document.createElement("button");
  button.className = "copy-button";
  button.type = "button";
  attachCopyBehavior(button, value, { defaultText: "コピー", selectionTarget: output });
  row.append(name, output, button);
  return row;
}

function renderCopyField(label, rawValue, options = {}) {
  const { buttonText = "コピー", className = "" } = options;
  const value = formatCopyValue(rawValue);
  const field = document.createElement("div");
  field.className = "copy-field";
  if (className) {
    field.classList.add(className);
  }
  const fieldHead = document.createElement("div");
  fieldHead.className = "copy-field-head";
  const name = document.createElement("span");
  name.className = "copy-field-label";
  name.textContent = label;
  const button = document.createElement("button");
  button.className = "copy-button";
  button.type = "button";
  const output = document.createElement("pre");
  output.textContent = value;
  attachCopyBehavior(button, value, { defaultText: buttonText, selectionTarget: output });
  fieldHead.append(name, button);
  field.append(fieldHead, output);
  return field;
}

function renderIpuBulkCopyPanel(orders) {
  const panel = document.createElement("section");
  panel.className = "ipu-bulk-copy";

  const head = document.createElement("div");
  head.className = "ipu-bulk-copy-head";

  const textWrap = document.createElement("div");
  const kicker = document.createElement("p");
  kicker.className = "kicker";
  kicker.textContent = "Quick paste";
  const title = document.createElement("h3");
  title.textContent = `${orders.length}件をまとめて貼り付け`;
  textWrap.append(kicker, title);

  const button = document.createElement("button");
  button.className = "copy-button";
  button.type = "button";
  attachCopyBehavior(button, buildIpuBulkCopyText(orders), { defaultText: `${orders.length}件コピー` });
  head.append(textWrap, button);

  const note = document.createElement("p");
  note.className = "ipu-bulk-copy-note";
  note.textContent = "1行が1件、列は申請画面と同じ順です。左上セルから貼り付けると、複数件をまとめて入れられます。";

  panel.append(head, note);
  return panel;
}

function attachCopyBehavior(button, value, options = {}) {
  const { defaultText = "コピー", selectionTarget = null } = options;
  button.textContent = defaultText;
  button.disabled = value === "要確認";
  button.addEventListener("click", async () => {
    try {
      await navigator.clipboard.writeText(value);
      button.textContent = "コピー済み";
      window.setTimeout(() => { button.textContent = defaultText; }, 1400);
    } catch {
      if (selectionTarget) {
        button.textContent = "選択してコピー";
        const selection = window.getSelection();
        const range = document.createRange();
        range.selectNodeContents(selectionTarget);
        selection.removeAllRanges();
        selection.addRange(range);
        return;
      }
      const fallback = document.createElement("textarea");
      fallback.value = value;
      fallback.setAttribute("readonly", "");
      fallback.style.position = "fixed";
      fallback.style.opacity = "0";
      document.body.append(fallback);
      fallback.select();
      const copied = document.execCommand("copy");
      fallback.remove();
      button.textContent = copied ? "コピー済み" : "コピー失敗";
      if (copied) {
        window.setTimeout(() => { button.textContent = defaultText; }, 1400);
      }
    }
  });
}

function fundById(id) {
  return funds().find((fund) => fund.id === id);
}

function allocationById(id) {
  return allocations().find((allocation) => allocation.id === id);
}

function renderSummary() {
  const personal = fundById("personal2201");
  const project = fundById("project2202");
  const takeda = fundById("takeda7023");
  const membershipReserve = lineItems()
    .filter((item) => item.status === "fixed")
    .reduce((sum, item) => sum + (item.amountYen || 0), 0);
  const unknownFunds = funds().filter((fund) => ["unknown", "rough"].includes(fund.status)).length;

  const cards = [
    {
      label: "2201 個人枠",
      value: formatYen(personal?.remainingYen),
      body: "教育研究費。学会費を先に引いてから購入候補を判断する。",
      tone: "green",
      fundId: "personal2201",
    },
    {
      label: "2201 差引後目安",
      value: Number.isFinite(personal?.remainingYen) ? formatYen(personal.remainingYen - membershipReserve) : "未確認",
      body: `学会費 ${formatYen(membershipReserve)} を全て未払いと仮定した残り。`,
      tone: "blue",
      fundId: "personal2201",
    },
    {
      label: "2202 プロジェクト枠",
      value: formatYen(project?.remainingYen),
      body: "Natto_MASHを含むプロジェクト研究費の財布。このメイン台帳で配分を決める。",
      tone: "gold",
      fundId: "project2202",
    },
    {
      label: "武田財団",
      value: formatYen(takeda?.remainingYen),
      body: "奨学寄付金。記録済み明細と一部仮更新まで確認済み。",
      tone: "green",
      fundId: "takeda7023",
    },
    {
      label: "Natto_MASH",
      value: "メイン管理",
      body: "別ボードに分けず、この台帳内のプロジェクト区分として管理する。",
      tone: "pink",
    },
    {
      label: "未確認の資金枠",
      value: `${unknownFunds}件`,
      body: "科研費25H00958、AMED/橋渡しの扱いを確認する。",
      tone: "red",
    },
  ];

  elements.summaryGrid.replaceChildren(...cards.map(renderSummaryCard));
}

function renderSummaryCard(card) {
  const article = document.createElement(card.fundId ? "button" : "article");
  article.className = "summary-card";
  article.dataset.tone = card.tone;
  if (card.fundId) {
    article.type = "button";
    article.classList.add("is-clickable");
    article.setAttribute("aria-label", `${card.label}の使用済み・使用予定項目を表示`);
    article.addEventListener("click", () => openFundDetail(card.fundId));
  }

  const label = document.createElement("span");
  label.className = "card-label";
  label.textContent = card.label;

  const value = document.createElement("strong");
  value.textContent = card.value;

  const body = document.createElement("p");
  body.textContent = card.body;

  article.append(label, value, body);
  return article;
}

function renderPriority() {
  const highPriorityChecks = checks()
    .filter((check) => check.priority === "high")
    .map((check) => check.detail);
  const fallback = [
    "学会費3件の支払い済み/未払いと、2201から払えるかを確認する。",
    "2201の支出期限を確認して、個人枠で今買うものを決める。",
    "2202のメンバー/使途制限を確認して、メイン台帳上でNatto_MASH関連へ配分する。",
  ];
  const steps = highPriorityChecks.length ? highPriorityChecks : fallback;

  elements.priorityList.replaceChildren(...steps.map((step) => {
    const item = document.createElement("li");
    item.textContent = step;
    return item;
  }));
}

function renderProjects() {
  elements.projectList.replaceChildren(...projects().map((project) => {
    const card = document.createElement("article");
    card.className = "project-card";

    const meta = document.createElement("span");
    meta.className = "status-pill";
    meta.textContent = project.kind;

    const title = document.createElement("h4");
    title.textContent = project.name;

    const note = document.createElement("p");
    note.textContent = project.note;

    card.append(meta, title, note);
    if (project.url) {
      const link = document.createElement("a");
      link.href = project.url;
      link.target = "_blank";
      link.rel = "noopener";
      link.className = "inline-link";
      link.textContent = "参考リンクを開く";
      card.append(link);
    }
    return card;
  }));
}

function renderFunds() {
  elements.fundCards.replaceChildren(...funds().map((fund) => {
    const card = document.createElement("button");
    card.className = "fund-card";
    card.type = "button";
    card.dataset.status = fund.status;
    card.setAttribute("aria-label", `${fund.name}の使用済み・使用予定項目を表示`);
    card.addEventListener("click", () => openFundDetail(fund.id));

    const head = document.createElement("div");
    head.className = "fund-head";

    const titleWrap = document.createElement("div");
    const label = document.createElement("p");
    label.className = "card-label";
    label.textContent = `${fund.code} / ${fund.category}`;
    const title = document.createElement("h3");
    title.textContent = fund.name;
    titleWrap.append(label, title);

    const status = statusBadge(statusLabels[fund.status] || fund.status, fund.status);
    head.append(titleWrap, status);

    const metrics = document.createElement("div");
    metrics.className = "metric-grid";
    [
      ["総額", formatYen(fund.totalYen)],
      ["本執行", formatYen(fund.executedYen)],
      ["仮更新", formatYen(fund.provisionalYen)],
      ["実質残額", formatYen(fund.remainingYen)],
    ].forEach(([name, value]) => metrics.append(renderMetric(name, value)));

    const note = document.createElement("p");
    note.className = "muted";
    note.textContent = fund.note;

    const source = document.createElement("span");
    source.className = "mini-label";
    source.textContent = `${fund.confidence} / 詳細を見る`;

    card.append(head, metrics, note, source);
    return card;
  }));
}

function openFundDetail(fundId) {
  const fund = fundById(fundId);
  if (!fund) return;

  state.activeFundId = fundId;
  const relatedItems = lineItems().filter((item) => item.fundId === fundId);
  const usedItems = relatedItems.filter((item) => ["spent", "provisional"].includes(item.status));
  const plannedItems = relatedItems.filter((item) => !["spent", "provisional"].includes(item.status));

  elements.fundDetailCode.textContent = `${fund.code} / ${fund.category}`;
  elements.fundDetailTitle.textContent = fund.name;
  elements.fundDetailMetrics.replaceChildren(
    renderMetric("総額", formatYen(fund.totalYen)),
    renderMetric("本執行", formatYen(fund.executedYen)),
    renderMetric("仮更新", formatYen(fund.provisionalYen)),
    renderMetric("実質残額", formatYen(fund.remainingYen)),
  );
  elements.usedItemsCount.textContent = `${usedItems.length}件`;
  elements.plannedItemsCount.textContent = `${plannedItems.length}件`;
  elements.usedItemsList.replaceChildren(...renderFundDetailItems(usedItems, "使用済み項目はまだありません。"));
  elements.plannedItemsList.replaceChildren(...renderFundDetailItems(plannedItems, "使用予定の項目はまだありません。"));

  if (!elements.fundDetailDialog.open) elements.fundDetailDialog.showModal();
}

function closeFundDetail() {
  if (elements.fundDetailDialog.open) elements.fundDetailDialog.close();
}

function renderFundDetailItems(items, emptyMessage) {
  if (!items.length) return [renderEmptyState(emptyMessage)];
  return items.map((item) => {
    const article = document.createElement("article");
    article.className = "detail-item";

    const head = document.createElement("div");
    head.className = "detail-item-head";
    const title = document.createElement("h4");
    title.textContent = item.title;
    head.append(title, statusBadge(statusLabels[item.status] || item.status, item.status));

    const amount = document.createElement("strong");
    amount.className = "detail-item-amount";
    amount.textContent = formatYen(item.amountYen);

    const meta = document.createElement("p");
    meta.className = "detail-item-meta";
    const allocation = allocationById(item.allocationId)?.title;
    meta.textContent = [item.project, allocation, item.date].filter(Boolean).join(" / ");

    const next = document.createElement("p");
    next.className = "muted";
    next.textContent = item.next;

    article.append(head, amount, meta, next);
    return article;
  });
}

function renderMetric(name, value) {
  const metric = document.createElement("div");
  metric.className = "metric";
  const label = document.createElement("span");
  label.textContent = name;
  const strong = document.createElement("strong");
  strong.textContent = value;
  metric.append(label, strong);
  return metric;
}

function renderAllocations() {
  const rows = allocations().map((allocation) => [
    allocation.title,
    fundById(allocation.fundId)?.name || "-",
    allocation.project,
    allocation.category,
    formatYen(allocation.plannedYen),
    formatYen(allocation.usedYen),
    statusLabels[allocation.status] || allocation.status,
    allocation.next,
  ]);
  elements.allocationTable.replaceChildren(renderTable(
    ["配分枠", "資金枠", "プロジェクト", "区分", "枠/目安", "記録済み", "状態", "次に確認"],
    rows,
  ));
}

function renderLineItems() {
  const visible = lineItems().filter((item) => {
    if (state.activeFilter === "all") return true;
    if (state.activeFilter === "natto") return item.project === "Natto_MASH";
    if (state.activeFilter === "fixed") return item.status === "fixed";
    if (state.activeFilter === "spent") return ["spent", "provisional"].includes(item.status);
    return item.status === state.activeFilter;
  });

  const rows = visible.map((item) => [
    statusBadge(statusLabels[item.status] || item.status, item.status),
    item.title,
    fundById(item.fundId)?.name || "-",
    allocationById(item.allocationId)?.title || "-",
    item.project,
    formatYen(item.amountYen),
    item.date,
    item.next,
  ]);
  elements.lineItemTable.replaceChildren(renderTable(
    ["状態", "支出項目", "資金枠", "配分枠", "プロジェクト", "金額", "日付", "次に確認"],
    rows,
  ));
}

function renderChecks() {
  elements.checkList.replaceChildren(...checks().map((check) => {
    const card = document.createElement("article");
    card.className = "check-card";
    card.dataset.priority = check.priority;

    const meta = document.createElement("div");
    meta.className = "item-meta";
    meta.append(statusBadge(priorityLabel(check.priority), check.priority), textSpan(check.owner, "mini-label"));

    const title = document.createElement("h3");
    title.textContent = check.title;

    const detail = document.createElement("p");
    detail.textContent = check.detail;

    card.append(meta, title, detail);
    return card;
  }));
}

function renderTable(headers, rows) {
  const wrap = document.createElement("div");
  wrap.className = "table-wrap";
  const table = document.createElement("table");

  const thead = document.createElement("thead");
  const headRow = document.createElement("tr");
  headers.forEach((header) => {
    const cell = document.createElement("th");
    cell.textContent = header;
    headRow.append(cell);
  });
  thead.append(headRow);

  const tbody = document.createElement("tbody");
  if (!rows.length) {
    const tr = document.createElement("tr");
    const td = document.createElement("td");
    td.colSpan = headers.length;
    td.textContent = "表示できるデータがありません。";
    tr.append(td);
    tbody.append(tr);
  } else {
    rows.forEach((row) => {
      const tr = document.createElement("tr");
      row.forEach((value) => {
        const td = document.createElement("td");
        if (value instanceof Node) {
          td.append(value);
        } else {
          td.textContent = value;
        }
        tr.append(td);
      });
      tbody.append(tr);
    });
  }

  table.append(thead, tbody);
  wrap.append(table);
  return wrap;
}

function statusBadge(label, status) {
  const badge = document.createElement("span");
  badge.className = "status-pill";
  badge.dataset.status = status;
  badge.textContent = label;
  return badge;
}

function textSpan(value, className) {
  const span = document.createElement("span");
  span.className = className;
  span.textContent = value;
  return span;
}

function priorityLabel(priority) {
  if (priority === "high") return "高";
  if (priority === "medium") return "中";
  return "低";
}

function activateView(view) {
  Object.entries(panels).forEach(([key, panel]) => {
    panel.hidden = key !== view;
  });
  elements.viewTabs.forEach((tab) => {
    const active = tab.dataset.view === view;
    tab.classList.toggle("is-active", active);
    tab.setAttribute("aria-selected", String(active));
  });
}

render();
