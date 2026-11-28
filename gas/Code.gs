/**
 * 和煎 HÉ JIĀN｜線上訂單 → Google Sheet（Google Apps Script 後端）
 *
 * 功能
 *  - doPost：接收網站結帳送出的訂單，驗證後寫入「訂單」與「訂單明細」工作表
 *  - 金額一律以「商品」工作表的單價在伺服器端重新計算（避免前端被竄改）
 *  - 依日期產生流水號訂單編號：HJ-20261128-0001
 *  - 同一筆訂單重複送出（網路重試、連點）只會建立一次
 *  - 新訂單通知信給店家；可選擇寄確認信給顧客
 *  - setup()：一鍵建立所有工作表、欄位、狀態下拉選單與每日統計
 *
 * 部署步驟請見 gas/README.md
 */

// ===== 可依需求調整的設定 =====
const CONFIG = {
  NOTIFY_EMAIL: '',            // 新訂單通知收件人，留空 = 寄給部署者本人；設為 'none' = 不寄
  SEND_CUSTOMER_EMAIL: true,   // 是否寄訂單確認信給顧客
  SHOP_NAME: '和煎 HÉ JIĀN',
  SHIPPING_FEE: 120,           // 宅配運費
  MAX_QTY: 99,                 // 單品最多數量
  STORES: ['台北旗艦店', '信義概念店', '台中公益店'],
  STATUSES: ['新訂單', '製作中', '可取餐/已出貨', '已完成', '已取消'],
};

const SHEET_ORDERS = '訂單';
const SHEET_ITEMS = '訂單明細';
const SHEET_PRODUCTS = '商品';
const SHEET_DAILY = '每日統計';

const ORDER_HEADERS = ['訂單編號', '建立時間', '狀態', '取餐方式', '門市', '姓名', '手機', 'Email',
  '宅配地址', '備註', '商品摘要', '件數', '商品金額', '運費', '訂單合計', '來源'];
const ITEM_HEADERS = ['訂單編號', '建立時間', '商品ID', '商品名稱', '單價', '數量', '小計'];
const PRODUCT_HEADERS = ['商品ID', '商品名稱', '單價', '上架(TRUE/FALSE)'];

// 與網站 PRODUCTS 相同的初始商品資料（setup 時寫入「商品」工作表，之後改價請直接改工作表）
const SEED_PRODUCTS = [
  ['p1', '經典鮮肉鍋貼', 75], ['p2', '韭香鮮肉鍋貼', 80], ['p3', '椒麻香辣鍋貼', 90],
  ['d1', '高麗菜鮮肉水餃', 80], ['d2', '玉米甜香水餃', 85], ['d3', '紅油抄手', 95],
  ['s1', '酸辣湯', 45], ['s2', '玉米濃湯', 45], ['s3', '古早味紅茶', 30],
  ['a1', '涼拌小黃瓜', 40], ['a2', '香滷豆干', 40], ['a3', '麻香海帶絲', 45],
  ['g1', '招牌招財鍋貼禮盒', 499],
];

const FULFILLMENT = { takeout: '外帶', dinein: '內用', delivery: '宅配' };

// ===== 初始化：在編輯器選 setup 後按「執行」一次 =====
function setup() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  ss.setSpreadsheetTimeZone('Asia/Taipei');

  const orders = getOrCreateSheet_(ss, SHEET_ORDERS, ORDER_HEADERS);
  const statusRule = SpreadsheetApp.newDataValidation()
    .requireValueInList(CONFIG.STATUSES, true).setAllowInvalid(false).build();
  orders.getRange(2, 3, orders.getMaxRows() - 1, 1).setDataValidation(statusRule);
  orders.getRange('B:B').setNumberFormat('yyyy/mm/dd hh:mm');
  orders.getRange('M:O').setNumberFormat('#,##0');

  const items = getOrCreateSheet_(ss, SHEET_ITEMS, ITEM_HEADERS);
  items.getRange('B:B').setNumberFormat('yyyy/mm/dd hh:mm');

  const products = getOrCreateSheet_(ss, SHEET_PRODUCTS, PRODUCT_HEADERS);
  if (products.getLastRow() < 2) {
    products.getRange(2, 1, SEED_PRODUCTS.length, 4)
      .setValues(SEED_PRODUCTS.map(p => [p[0], p[1], p[2], true]));
  }

  const daily = getOrCreateSheet_(ss, SHEET_DAILY, ['說明']);
  daily.clear();
  daily.getRange('A1').setValue('每日營收（自動計算，不含「已取消」）');
  daily.getRange('A3').setFormula(
    "=IFERROR(QUERY({ARRAYFORMULA(IF(訂單!B2:B=\"\",,INT(訂單!B2:B))),訂單!C2:C,訂單!O2:O}," +
    "\"select Col1, count(Col1), sum(Col3) where Col1 is not null and Col2 <> '已取消' " +
    "group by Col1 order by Col1 desc label Col1 '日期', count(Col1) '訂單數', sum(Col3) '營收'\",0),\"尚無訂單\")");
  daily.getRange('A:A').setNumberFormat('yyyy/mm/dd');
  daily.getRange('C:C').setNumberFormat('#,##0');

  const sheet1 = ss.getSheetByName('工作表1') || ss.getSheetByName('Sheet1');
  if (sheet1 && sheet1.getLastRow() === 0 && ss.getSheets().length > 1) ss.deleteSheet(sheet1);

  safeToast_(ss, '初始化完成：已建立訂單、訂單明細、商品、每日統計');
}

// ===== 網站健康檢查：瀏覽器打開 Web App 網址會看到 {"ok":true} =====
function doGet() {
  return json_({ ok: true, service: CONFIG.SHOP_NAME + ' order api' });
}

// ===== 接收訂單 =====
function doPost(e) {
  try {
    const body = JSON.parse((e && e.postData && e.postData.contents) || '{}');
    if (body.website) return json_({ ok: true, orderNo: 'HJ-IGNORED' }); // 防機器人陷阱欄位

    const order = validate_(body);

    // 同一張單重送（連點或網路重試）→ 直接回傳先前的結果
    const cache = CacheService.getScriptCache();
    const dupKey = 'req_' + order.requestId;
    const cached = cache.get(dupKey);
    if (cached) return json_(JSON.parse(cached));

    const lock = LockService.getScriptLock();
    lock.waitLock(20000);
    let result;
    try {
      const again = cache.get(dupKey);
      if (again) return json_(JSON.parse(again));
      result = saveOrder_(order);
      cache.put(dupKey, JSON.stringify(result), 21600);
    } finally {
      lock.releaseLock();
    }

    notify_(order, result);
    return json_(result);
  } catch (err) {
    const msg = err && err.userMessage ? err.userMessage : '系統忙碌中，請稍後再試';
    if (!(err && err.userMessage)) console.error(err && err.stack || err);
    return json_({ ok: false, error: msg });
  }
}

// ===== 驗證與金額重算 =====
function validate_(b) {
  const fail = m => { const x = new Error(m); x.userMessage = m; throw x; };
  const str = (v, max) => String(v == null ? '' : v).trim().slice(0, max);

  const fulfillment = str(b.fulfillment, 20);
  if (!FULFILLMENT[fulfillment]) fail('取餐方式不正確');

  const name = str(b.name, 60);
  if (name.length < 2) fail('請填寫姓名');
  const phone = str(b.phone, 20).replace(/[\s\-()]/g, '');
  if (!/^\+?\d{8,15}$/.test(phone)) fail('手機格式不正確');
  const email = str(b.email, 120);
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) fail('Email 格式不正確');

  let store = '', address = '';
  if (fulfillment === 'delivery') {
    address = str(b.address, 180);
    if (address.length < 6) fail('請填寫完整宅配地址');
  } else {
    store = str(b.store, 30);
    if (CONFIG.STORES.indexOf(store) === -1) fail('門市不正確');
  }

  const catalog = loadProducts_();
  if (!Array.isArray(b.items) || !b.items.length) fail('購物車是空的');
  const merged = {};
  b.items.forEach(it => {
    const id = str(it && it.id, 20);
    const qty = Number(it && it.qty);
    if (!catalog[id]) fail('商品已下架或不存在，請重新整理頁面');
    if (!Number.isInteger(qty) || qty < 1 || qty > CONFIG.MAX_QTY) fail('商品數量不正確');
    merged[id] = Math.min(CONFIG.MAX_QTY, (merged[id] || 0) + qty);
  });
  const lines = Object.keys(merged).map(id => ({
    id, name: catalog[id].name, price: catalog[id].price, qty: merged[id],
    subtotal: catalog[id].price * merged[id],
  }));
  const subtotal = lines.reduce((s, l) => s + l.subtotal, 0);
  const shipping = fulfillment === 'delivery' ? CONFIG.SHIPPING_FEE : 0;

  return {
    requestId: str(b.requestId, 64) || Utilities.getUuid(),
    fulfillment, store, address, name, phone, email,
    note: str(b.note, 120),
    source: str(b.source, 40) || 'web',
    lines, subtotal, shipping, total: subtotal + shipping,
    count: lines.reduce((s, l) => s + l.qty, 0),
  };
}

function loadProducts_() {
  const sh = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(SHEET_PRODUCTS);
  const rows = sh ? sh.getDataRange().getValues().slice(1) : SEED_PRODUCTS.map(p => [p[0], p[1], p[2], true]);
  const map = {};
  rows.forEach(r => {
    const id = String(r[0]).trim();
    const price = Number(r[2]);
    const active = r[3] === true || String(r[3]).toUpperCase() === 'TRUE';
    if (id && active && price > 0) map[id] = { name: String(r[1]), price };
  });
  return map;
}

// ===== 寫入工作表 =====
function saveOrder_(o) {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const orders = ss.getSheetByName(SHEET_ORDERS);
  const items = ss.getSheetByName(SHEET_ITEMS);
  if (!orders || !items) { const x = new Error('no sheet'); x.userMessage = '訂單系統尚未初始化（請先執行 setup）'; throw x; }

  const now = new Date();
  const orderNo = nextOrderNo_(now);
  const summary = o.lines.map(l => l.name + ' x' + l.qty).join('、');

  orders.appendRow([orderNo, now, CONFIG.STATUSES[0], FULFILLMENT[o.fulfillment], o.store,
    safe_(o.name), "'" + o.phone, safe_(o.email), safe_(o.address), safe_(o.note), summary, o.count,
    o.subtotal, o.shipping, o.total, safe_(o.source)]);
  items.getRange(items.getLastRow() + 1, 1, o.lines.length, ITEM_HEADERS.length)
    .setValues(o.lines.map(l => [orderNo, now, l.id, l.name, l.price, l.qty, l.subtotal]));

  return { ok: true, orderNo, subtotal: o.subtotal, shipping: o.shipping, total: o.total, count: o.count };
}

function nextOrderNo_(now) {
  const day = Utilities.formatDate(now, 'Asia/Taipei', 'yyyyMMdd');
  const props = PropertiesService.getScriptProperties();
  const key = 'seq_' + day;
  const seq = Number(props.getProperty(key) || 0) + 1;
  props.setProperty(key, String(seq));
  return 'HJ-' + day + '-' + ('000' + seq).slice(-4);
}

// ===== 通知信 =====
function notify_(o, r) {
  const lines = o.lines.map(l => `・${l.name} × ${l.qty}　NT$ ${l.subtotal}`).join('\n');
  const where = o.fulfillment === 'delivery' ? `宅配：${o.address}` : `${FULFILLMENT[o.fulfillment]}｜${o.store}`;
  const detail = `訂單編號：${r.orderNo}\n${where}\n姓名：${o.name}\n手機：${o.phone}\nEmail：${o.email}\n` +
    (o.note ? `備註：${o.note}\n` : '') +
    `\n${lines}\n\n商品金額：NT$ ${o.subtotal}\n運費：NT$ ${o.shipping}\n訂單合計：NT$ ${o.total}`;

  try {
    if (CONFIG.NOTIFY_EMAIL !== 'none') {
      const to = CONFIG.NOTIFY_EMAIL || Session.getEffectiveUser().getEmail();
      if (to) MailApp.sendEmail(to, `【新訂單】${r.orderNo}｜${o.name}｜NT$ ${o.total}`,
        detail + '\n\n開啟試算表：' + SpreadsheetApp.getActiveSpreadsheet().getUrl());
    }
    if (CONFIG.SEND_CUSTOMER_EMAIL) {
      MailApp.sendEmail(o.email, `【${CONFIG.SHOP_NAME}】訂單確認 ${r.orderNo}`,
        `${o.name} 您好，感謝您的訂購！我們已收到以下訂單：\n\n${detail}\n\n如需修改或取消，請直接回覆此信。`,
        { name: CONFIG.SHOP_NAME });
    }
  } catch (err) {
    console.warn('寄信失敗（訂單已成功寫入）：' + err); // 寄信失敗不影響訂單
  }
}

// ===== 小工具 =====
function getOrCreateSheet_(ss, name, headers) {
  const sh = ss.getSheetByName(name) || ss.insertSheet(name);
  if (sh.getLastRow() === 0) {
    sh.getRange(1, 1, 1, headers.length).setValues([headers])
      .setFontWeight('bold').setBackground('#533528').setFontColor('#ffffff');
    sh.setFrozenRows(1);
  }
  return sh;
}

// 避免使用者輸入 =、+、-、@ 開頭被試算表當成公式執行
function safe_(v) {
  const s = String(v == null ? '' : v);
  return /^[=+\-@]/.test(s) ? "'" + s : s;
}

function json_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}

function safeToast_(ss, msg) {
  try { ss.toast(msg, CONFIG.SHOP_NAME, 6); } catch (e) { console.log(msg); }
}

// ===== 手動測試：在編輯器選 testOrder 執行，會新增一筆測試訂單 =====
function testOrder() {
  const res = doPost({ postData: { contents: JSON.stringify({
    requestId: 'test-' + Date.now(), fulfillment: 'takeout', store: '台北旗艦店',
    name: '測試顧客', phone: '0912345678', email: Session.getEffectiveUser().getEmail() || 'test@example.com',
    note: '這是測試訂單', items: [{ id: 'p1', qty: 2 }, { id: 's1', qty: 1 }], source: 'test',
  }) } });
  console.log(res.getContent());
}
