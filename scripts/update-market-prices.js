// ============================================================
// 市場價格專區 - 排程腳本
// ------------------------------------------------------------
// 這支腳本會：
//   1. 向農業部「農產品交易行情」「漁產品交易行情」開放資料 API 抓取：
//      - 最近14天（近期）的交易資料
//      - 過去2年、同一個時節（月/日 ±15天）的交易資料（當作季節性基準價）
//   2. 依名稱把同一種食材的交易紀錄平均起來，算出「近期均價」vs「基準均價」
//   3. 算出跌幅百分比，排序，取跌幅最大的前N名
//   4. 把結果寫進 Firestore 的 marketPriceRecommendations/latest 文件
//
// 這支腳本設計成由 GitHub Actions 排程執行（見同資料夾下的 workflow 設定），
// 不需要 Firebase Cloud Functions / Blaze 方案。
//
// 執行方式（本地測試用）：
//   FIREBASE_SERVICE_ACCOUNT='<整包service account json字串>' node scripts/update-market-prices.js
// ============================================================

const admin = require('firebase-admin');

// ---- 1. 初始化 Firebase Admin ----
// GitHub Actions 會把服務帳戶金鑰(JSON)整包放在環境變數 FIREBASE_SERVICE_ACCOUNT 裡（存成GitHub Secret）
const serviceAccountRaw = process.env.FIREBASE_SERVICE_ACCOUNT;
if (!serviceAccountRaw) {
    console.error('缺少環境變數 FIREBASE_SERVICE_ACCOUNT，無法連線 Firestore');
    process.exit(1);
}
let serviceAccount;
try {
    serviceAccount = JSON.parse(serviceAccountRaw);
} catch (err) {
    console.error('FIREBASE_SERVICE_ACCOUNT 不是合法的 JSON：', err.message);
    process.exit(1);
}
admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
const db = admin.firestore();

// ---- 2. 共用工具函式 ----

// 西元日期 -> 民國日期字串（政府API規定的格式，例如 2024-06-01 -> "113.06.01"）
function toRocDateString(date) {
    const y = date.getFullYear() - 1911;
    const m = String(date.getMonth() + 1).padStart(2, '0');
    const d = String(date.getDate()).padStart(2, '0');
    return `${y}.${m}.${d}`;
}

function addDays(date, days) {
    const d = new Date(date);
    d.setDate(d.getDate() + days);
    return d;
}

// 從API原始資料的一筆紀錄裡，盡量找出「名稱」「平均價」「交易量」欄位
// （不同資料集/不同版本的政府API欄位命名可能有些微差異，這裡做多重嘗試，比較保險）
function pickField(row, candidates) {
    for (const key of candidates) {
        if (row[key] !== undefined && row[key] !== null && row[key] !== '') return row[key];
    }
    return null;
}
function extractRecord(row, type) {
    const name = pickField(row, type === 'farm'
        ? ['作物名稱', 'CropName', 'crop_name']
        : ['魚貨名稱', 'FishName', 'fish_name']);
    const avgPriceRaw = pickField(row, ['平均價', 'AveragePrice', 'average_price']);
    const volumeRaw = pickField(row, ['交易量', 'TradeVolumn', 'TradeVolume', 'trade_volume']);
    const avgPrice = parseFloat(avgPriceRaw);
    const volume = parseFloat(volumeRaw);
    if (!name || isNaN(avgPrice) || avgPrice <= 0) return null;
    return { name: String(name).trim(), avgPrice, volume: isNaN(volume) ? 1 : Math.max(volume, 0.01) };
}

// 分頁抓取整段時間範圍內的所有交易紀錄（政府API單次最多回傳一定筆數，用$skip分頁抓到底）
async function fetchAllPages(baseUrl, startDate, endDate) {
    const top = 5000;
    let skip = 0;
    const all = [];
    for (let guard = 0; guard < 50; guard++) { // 安全上限，避免萬一API行為異常造成無窮迴圈
        const url = `${baseUrl}?$top=${top}&$skip=${skip}&StartDate=${toRocDateString(startDate)}&EndDate=${toRocDateString(endDate)}`;
        let res;
        try {
            res = await fetch(url, { headers: { 'Accept': 'application/json' } });
        } catch (err) {
            console.warn(`抓取失敗（略過）：${url}`, err.message);
            break;
        }
        if (!res.ok) {
            console.warn(`API回應非200（略過）：${url} status=${res.status}`);
            break;
        }
        let json;
        try {
            json = await res.json();
        } catch (err) {
            console.warn(`回應不是合法JSON（略過）：${url}`, err.message);
            break;
        }
        if (!Array.isArray(json) || json.length === 0) break;
        all.push(...json);
        if (json.length < top) break; // 這一頁沒抓滿，代表已經是最後一頁
        skip += top;
        await new Promise(r => setTimeout(r, 300)); // 稍微間隔一下，對政府API客氣一點
    }
    return all;
}

// 把一段時間範圍內的原始交易紀錄，依名稱聚合成「加權平均價」
// （用交易量當權重，交易量大的市場/日期影響力比較大，比單純算術平均更貼近真實行情）
function aggregateByName(rows, type) {
    const totals = {}; // name -> { priceVolumeSum, volumeSum, count }
    rows.forEach(row => {
        const rec = extractRecord(row, type);
        if (!rec) return;
        if (!totals[rec.name]) totals[rec.name] = { priceVolumeSum: 0, volumeSum: 0, count: 0 };
        totals[rec.name].priceVolumeSum += rec.avgPrice * rec.volume;
        totals[rec.name].volumeSum += rec.volume;
        totals[rec.name].count += 1;
    });
    const result = {};
    Object.entries(totals).forEach(([name, t]) => {
        if (t.volumeSum <= 0) return;
        result[name] = { avgPrice: t.priceVolumeSum / t.volumeSum, sampleCount: t.count };
    });
    return result;
}

// ---- 3. 主流程：抓「近期」跟「歷史同期基準」兩段資料，算跌幅排行 ----
async function buildRecommendations(baseUrl, type, label) {
    const today = new Date();

    // 近期：最近14天
    const recentRows = await fetchAllPages(baseUrl, addDays(today, -14), today);
    const recentAgg = aggregateByName(recentRows, type);
    console.log(`[${label}] 近期資料筆數：${recentRows.length}，聚合出 ${Object.keys(recentAgg).length} 種`);

    // 基準：過去2年，同一個時節（月/日 ±15天）
    const baselineRows = [];
    for (const yearsAgo of [1, 2]) {
        const centerDate = new Date(today);
        centerDate.setFullYear(centerDate.getFullYear() - yearsAgo);
        const rangeStart = addDays(centerDate, -15);
        const rangeEnd = addDays(centerDate, 15);
        const rows = await fetchAllPages(baseUrl, rangeStart, rangeEnd);
        baselineRows.push(...rows);
        console.log(`[${label}] ${yearsAgo}年前同期資料筆數：${rows.length}`);
    }
    const baselineAgg = aggregateByName(baselineRows, type);

    // 比對兩邊都有資料的食材，算跌幅（正值代表變便宜了）
    const drops = [];
    Object.keys(recentAgg).forEach(name => {
        const recent = recentAgg[name];
        const baseline = baselineAgg[name];
        if (!baseline) return;
        // 樣本數太少的不採用，避免單一極端交易造成誤判
        if (recent.sampleCount < 3 || baseline.sampleCount < 3) return;
        if (baseline.avgPrice <= 0) return;
        const dropPct = ((baseline.avgPrice - recent.avgPrice) / baseline.avgPrice) * 100;
        drops.push({
            name,
            recentPrice: Math.round(recent.avgPrice * 100) / 100,
            baselinePrice: Math.round(baseline.avgPrice * 100) / 100,
            dropPct: Math.round(dropPct * 10) / 10,
        });
    });

    // 只取真的變便宜的（跌幅>0），依跌幅由大到小排序，取前20名
    return drops
        .filter(d => d.dropPct > 0)
        .sort((a, b) => b.dropPct - a.dropPct)
        .slice(0, 20);
}

// ---- 4. 執行並寫入 Firestore ----
async function main() {
    console.log('開始更新市場價格推薦...');

    const vegetables = await buildRecommendations(
        'https://data.moa.gov.tw/Service/OpenData/FromM/FarmTransData.aspx',
        'farm',
        '蔬果'
    );
    const fish = await buildRecommendations(
        'https://data.moa.gov.tw/Service/OpenData/FromM/AquaticTransData.aspx',
        'fish',
        '漁產'
    );

    await db.collection('marketPriceRecommendations').doc('latest').set({
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
        vegetables,
        fish,
    });

    console.log(`完成！蔬果推薦 ${vegetables.length} 項，漁產推薦 ${fish.length} 項`);
}

main().catch(err => {
    console.error('執行失敗：', err);
    process.exit(1);
});
