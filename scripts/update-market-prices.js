// ============================================================
// 市場價格專區 - 排程腳本
// SCRIPT_VERSION: 2026-07-27-v14 （鴨鵝網址+3/4欄位名稱都猜對了，修正最後一個「鴨蛋」欄位的正確寫法，全部九大類終於都接上了）
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
// 西元日期 -> 西元斜線格式（例如 2024-06-01 -> "2024/06/01"），漁產API實際查詢介面看起來是用這種格式
function toGregSlashDateString(date) {
    const y = date.getFullYear();
    const m = String(date.getMonth() + 1).padStart(2, '0');
    const d = String(date.getDate()).padStart(2, '0');
    return `${y}/${m}/${d}`;
}
// 西元日期 -> 民國斜線格式（例如 2024-06-01 -> "113/06/01"）
function toRocSlashDateString(date) {
    const y = date.getFullYear() - 1911;
    const m = String(date.getMonth() + 1).padStart(2, '0');
    const d = String(date.getDate()).padStart(2, '0');
    return `${y}/${m}/${d}`;
}
// 西元日期 -> 民國短橫線格式（例如 2024-06-01 -> "113-06-01"），漁產文件範例(107-05-01)用的是這種格式
function toRocDashDateString(date) {
    const y = date.getFullYear() - 1911;
    const m = String(date.getMonth() + 1).padStart(2, '0');
    const d = String(date.getDate()).padStart(2, '0');
    return `${y}-${m}-${d}`;
}
// 四種日期格式都準備好，遇到不確定用哪種格式的API（例如漁產）時，會依序嘗試，抓到第一個有資料的格式
const DATE_FORMATTERS = [
    { label: '民國.月.日', fn: toRocDateString },
    { label: '西元/月/日', fn: toGregSlashDateString },
    { label: '民國/月/日', fn: toRocSlashDateString },
    { label: '民國-月-日', fn: toRocDashDateString },
];

function addDays(date, days) {
    const d = new Date(date);
    d.setDate(d.getDate() + days);
    return d;
}
// 安全地把一個陣列的內容全部塞進另一個陣列，不能用 target.push(...source) 這種展開語法——
// 資料量一大（例如幾十萬筆）展開語法會把函式呼叫的參數個數炸過JS引擎的上限，
// 導致「Maximum call stack size exceeded」，改用迴圈逐一塞入就不會有這個問題
function appendAll(target, source) {
    for (let i = 0; i < source.length; i++) target.push(source[i]);
}
// 組合網址用：如果baseUrl本身已經帶了查詢參數（例如白米需要固定帶?UnitId=266），
// 後面要接的參數就要用&開頭，不能又用一次?，不然網址會壞掉
function joinUrl(baseUrl, queryString) {
    return baseUrl.includes('?') ? `${baseUrl}&${queryString}` : `${baseUrl}?${queryString}`;
}

// 從API原始資料的一筆紀錄裡，盡量找出「名稱」「平均價」「交易量」欄位
// （不同資料集/不同版本的政府API欄位命名可能有些微差異，這裡做多重嘗試，比較保險）
function pickField(row, candidates) {
    for (const key of candidates) {
        if (row[key] !== undefined && row[key] !== null && row[key] !== '') return row[key];
    }
    return null;
}
// 「清單型」資料的欄位設定：每一筆都是一筆交易紀錄，有名稱/平均價/交易量可以依名稱分組聚合
// （農產、漁產、羊隻都是這種格式，只是各自欄位命名不太一樣）
const FIELD_CONFIGS = {
    farm: { name: ['作物名稱', 'CropName', 'crop_name'], price: ['平均價', 'Avg_Price', 'AveragePrice', 'average_price'], volume: ['交易量', 'Trans_Quantity', 'TradeVolumn', 'TradeVolume', 'trade_volume'] },
    fish: { name: ['魚貨名稱', 'SeafoodProdName', 'FishName', 'fish_name'], price: ['平均價', 'Avg_Price', 'AveragePrice', 'average_price'], volume: ['交易量', 'Trans_Quantity', 'TradeVolumn', 'TradeVolume', 'trade_volume'] },
    // 羊隻：欄位是使用者提供的官方文件確認過的（productName/avgPrice/quantity），但實際單位是不是元/公斤還沒驗證過，
    // 先當作跟其他類別一樣是元/公斤，如果實際跑出來數字明顯不合理（例如羊肉均價變成幾千元），代表單位判斷錯了要再調整
    sheep: { name: ['productName', 'name'], price: ['avgPrice'], volume: ['quantity'] },
};
function extractRecord(row, type) {
    const cfg = FIELD_CONFIGS[type];
    const name = pickField(row, cfg.name);
    const avgPriceRaw = pickField(row, cfg.price);
    const volumeRaw = pickField(row, cfg.volume);
    const avgPrice = parseFloat(avgPriceRaw);
    const volume = parseFloat(volumeRaw);
    if (!name || isNaN(avgPrice) || avgPrice <= 0) return null;
    // 種類代碼：農產這份資料裡蔬菜/水果/花卉/特產都混在一起，這個代碼是用來區分的關鍵欄位，
    // 但目前還不確定實際代碼數字對應到哪一種類別，先擷取起來，main()裡會印診斷log幫忙確認
    const categoryCode = pickField(row, ['TcType', '種類代碼', 'CategoryCode', 'category_code']);
    return { name: String(name).trim(), avgPrice, volume: isNaN(volume) ? 1 : Math.max(volume, 0.01), categoryCode: categoryCode !== null ? String(categoryCode) : null };
}
// 診斷用：印出「種類代碼」底下各自抓到哪些樣本名稱，方便人工確認代碼對應到蔬菜/水果/花卉/特產哪一種
// 之後確認清楚了，就可以把分類邏輯改成依這個代碼把農產拆成獨立的蔬菜/水果/花卉三個類別
function logCategoryCodeSamples(rows, type, label) {
    if (type !== 'farm') return; // 目前只有農產這份資料需要拆分類別
    const samples = {}; // 代碼 -> Set(名稱)
    rows.forEach(row => {
        const rec = extractRecord(row, type);
        if (!rec || rec.categoryCode === null) return;
        if (!samples[rec.categoryCode]) samples[rec.categoryCode] = new Set();
        if (samples[rec.categoryCode].size < 5) samples[rec.categoryCode].add(rec.name);
    });
    const codes = Object.keys(samples);
    if (!codes.length) {
        console.log(`[${label}] 診斷：這批資料裡沒有找到「種類代碼」欄位，可能欄位名稱又不一樣，之後要再確認`);
        return;
    }
    console.log(`[${label}] 診斷：種類代碼一覽（幫忙確認哪個代碼是蔬菜/水果/花卉/特產）`);
    codes.forEach(code => {
        console.log(`  代碼 ${code}：${Array.from(samples[code]).join('、')}`);
    });
}

// 分頁抓取整段時間範圍內的所有交易紀錄（政府API單次最多回傳一定筆數，用$skip分頁抓到底）
async function fetchAllPages(baseUrl, startDate, endDate, dateFormatFn, paramNames) {
    const formatDate = dateFormatFn || toRocDateString;
    const { start: startParam, end: endParam } = paramNames || { start: 'StartDate', end: 'EndDate' };
    const top = 5000;
    let skip = 0;
    const all = [];
    for (let guard = 0; guard < 50; guard++) { // 安全上限，避免萬一API行為異常造成無窮迴圈
        const url = joinUrl(baseUrl, `$top=${top}&$skip=${skip}&${startParam}=${formatDate(startDate)}&${endParam}=${formatDate(endDate)}`);
        console.log(`  抓取第 ${guard + 1} 頁（$skip=${skip}）...`); // 進度訊息：讓執行的人看得到它還在動，不是卡住了
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
        appendAll(all, json);
        console.log(`  這一頁拿到 ${json.length} 筆，累計 ${all.length} 筆`);
        if (json.length < top) break; // 這一頁沒抓滿，代表已經是最後一頁
        skip += top;
        await new Promise(r => setTimeout(r, 300)); // 稍微間隔一下，對政府API客氣一點
    }
    return filterRowsByDateRange(all, startDate, endDate);
}

// 解析各種可能的日期欄位/格式成JS Date物件，供「用戶端二次篩選」這道保護網用
function parseRowDate(row) {
    const raw = pickField(row, ['交易日期', 'TransDate', 'transDate', 'pt_date_day', '日期']);
    if (raw === null) return null;
    const str = String(raw).trim();
    let m;
    // 民國年（2~3位數字）+ . - / 其中一種分隔（例如113.06.01、107-05-01、113/06/01）
    if ((m = str.match(/^(\d{2,3})[.\-\/](\d{1,2})[.\-\/](\d{1,2})$/))) {
        return new Date(parseInt(m[1], 10) + 1911, parseInt(m[2], 10) - 1, parseInt(m[3], 10));
    }
    // 西元年（4位數字）+ . - / 其中一種分隔（例如2024/06/01）
    if ((m = str.match(/^(\d{4})[.\-\/](\d{1,2})[.\-\/](\d{1,2})$/))) {
        return new Date(parseInt(m[1], 10), parseInt(m[2], 10) - 1, parseInt(m[3], 10));
    }
    // 民國年月日黏在一起、沒有分隔符號（例如毛豬的1150727＝民國115年07月27日）
    if ((m = str.match(/^(\d{3})(\d{2})(\d{2})$/))) {
        return new Date(parseInt(m[1], 10) + 1911, parseInt(m[2], 10) - 1, parseInt(m[3], 10));
    }
    return null;
}
// 不管伺服器有沒有真的照StartDate/EndDate篩選，抓回來之後自己再篩一次，
// 確保「近期」「去年同期」這兩批資料真的落在該有的時間範圍內——
// 這是為了修羊隻那個bug：伺服器不管給什麼參數，都把1999~2026年的全部歷史資料整包丟回來，
// 篩選形同虛設，導致「近期」跟「去年同期」變成同一份資料在比較，算出來的漲跌幅完全沒有意義
function filterRowsByDateRange(rows, startDate, endDate) {
    const kept = [];
    const startBound = new Date(startDate.getFullYear(), startDate.getMonth(), startDate.getDate(), 0, 0, 0);
    const endBound = new Date(endDate.getFullYear(), endDate.getMonth(), endDate.getDate(), 23, 59, 59);
    rows.forEach(row => {
        const d = parseRowDate(row);
        if (!d) { kept.push(row); return; } // 解析不出日期的先保留，不要因為看不懂格式就整批丟掉
        if (d >= startBound && d <= endBound) kept.push(row);
    });
    if (kept.length !== rows.length) {
        console.log(`  用戶端二次篩選：伺服器回傳 ${rows.length} 筆，過濾掉範圍外的之後剩 ${kept.length} 筆（代表伺服器沒有真的照日期篩選，這是正常的保護機制在運作）`);
    }
    return kept;
}

// 把一段時間範圍內的原始交易紀錄，依名稱聚合成「加權平均價」
// （用交易量當權重，交易量大的市場/日期影響力比較大，比單純算術平均更貼近真實行情）
function aggregateByName(rows, type, categoryFilter) {
    const totals = {}; // name -> { priceVolumeSum, volumeSum, count }
    rows.forEach(row => {
        const rec = extractRecord(row, type);
        if (!rec) return;
        if (categoryFilter && rec.categoryCode !== categoryFilter) return; // 只挑出指定類別代碼的資料（例如只要蔬菜N04）
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

// 用一個很短的測試區間（最近3天），依序試每一種日期格式，找出這個API實際吃哪一種格式
// 政府API有些用StartDate/EndDate，有些（例如漁產）用Start_time/End_time，這裡兩種都準備
const PARAM_NAME_OPTIONS = [
    { start: 'StartDate', end: 'EndDate' },
    { start: 'Start_time', end: 'End_time' },
];

// 用一個很短的測試區間（最近3天），依序嘗試「參數名稱 x 日期格式」的各種組合，找出這個API實際吃哪一種
async function detectQueryFormat(baseUrl, label) {
    const today = new Date();
    for (const paramNames of PARAM_NAME_OPTIONS) {
        for (const { label: fmtLabel, fn } of DATE_FORMATTERS) {
            const url = joinUrl(baseUrl, `$top=5&$skip=0&${paramNames.start}=${fn(addDays(today, -3))}&${paramNames.end}=${fn(today)}`);
            try {
                const res = await fetch(url, { headers: { 'Accept': 'application/json' } });
                if (res.ok) {
                    const json = await res.json();
                    if (Array.isArray(json) && json.length > 0) {
                        console.log(`[${label}] 偵測到可用的組合：參數名稱=${paramNames.start}/${paramNames.end}，日期格式=${fmtLabel}`);
                        return { dateFormatFn: fn, paramNames };
                    }
                }
            } catch (err) {
                // 這個組合試失敗了，繼續試下一個
            }
        }
    }
    console.warn(`[${label}] 所有參數名稱/日期格式組合都試過，最近3天都抓不到資料，先用預設組合繼續嘗試`);
    return { dateFormatFn: toRocDateString, paramNames: PARAM_NAME_OPTIONS[0] };
}

// ---- 3. 主流程：抓「近期」跟「歷史同期基準」兩段資料，算跌幅排行 ----
// 「近期14天」這種資料每天都在變，必須每天重抓；但「1年前/2年前/3年前同期±15天」
// 這種歷史資料本質上是「已經發生過的事」，不會每天改變，沒必要每天都重新跟政府API要一次
// （尤其現在改成一次抓3年份，如果每天都重抓，跑的時間會變成原本的3倍，不划算）。
// 這裡改成把「聚合後的結果」（不是原始逐筆資料，聚合後體積小很多）存進Firestore當快取，
// 只有快取超過25天沒更新，才會真的重新呼叫政府API抓資料，平常每天執行只會抓「近期」這一段
const BASELINE_CACHE_MAX_AGE_DAYS = 25;
// 把一批rows依照交易日期切成3個小週(各約10天)，各自聚合成一個基準點，
// 不用多打API——反正±15天的資料本來就已經抓回來了，只是切開分別算而不是整段混在一起算一個平均，
// 這樣3年×3小週=9個基準點，比原本3年×1個點的樣本數多很多，也才能算出「歷史3年最低點」這種資訊
function splitIntoSubWindowPoints(rows, centerDate, type, columns) {
    const buckets = [[], [], []]; // 依照離中心日期的天數分成3個小週：-15~-6, -5~+5, +6~+15
    rows.forEach(row => {
        const d = parseRowDate(row);
        if (!d) return;
        const diffDays = Math.round((d - centerDate) / (1000 * 60 * 60 * 24));
        if (diffDays < -15 || diffDays > 15) return;
        const bucketIdx = diffDays <= -6 ? 0 : (diffDays >= 6 ? 2 : 1);
        buckets[bucketIdx].push(row);
    });
    return buckets.map(bucketRows => type ? aggregateByName(bucketRows, type, null) : aggregateByColumns(bucketRows, columns));
}
// ---- 3. 主流程：抓「近期」跟「歷史同期基準」兩段資料，算跌幅排行 ----
// 「近期14天」這種資料每天都在變，必須每天重抓；但「1年前/2年前/3年前同期」這種歷史資料
// 本質上是「已經發生過的事」，不會每天改變，沒必要每天都重新跟政府API要一次。這裡改成把
// 「聚合後的結果」（不是原始逐筆資料，聚合後體積小很多）存進Firestore當快取，只有快取超過
// 25天沒更新，才會真的重新呼叫政府API抓資料，平常每天執行只會抓「近期」這一段
async function getBaselineAggByYear(cacheKey, baseUrl, label, type, dateFormatFn, paramNames, columns) {
    const cacheRef = db.collection('marketPriceBaselineCache').doc(cacheKey);
    try {
        const cacheDoc = await cacheRef.get();
        if (cacheDoc.exists) {
            const cached = cacheDoc.data();
            const computedAt = cached.computedAt && cached.computedAt.toDate ? cached.computedAt.toDate() : null;
            const ageDays = computedAt ? (Date.now() - computedAt.getTime()) / (1000 * 60 * 60 * 24) : Infinity;
            if (ageDays < BASELINE_CACHE_MAX_AGE_DAYS && Array.isArray(cached.subWindowPointsByYear)) {
                console.log(`[${label}] 歷史基準資料使用快取（${Math.round(ageDays)}天前算的，還沒過期，不重新呼叫政府API）`);
                return cached.subWindowPointsByYear;
            }
            console.log(`[${label}] 歷史基準快取已經過期（${Math.round(ageDays)}天前算的，超過${BASELINE_CACHE_MAX_AGE_DAYS}天），重新抓取`);
        } else {
            console.log(`[${label}] 沒有歷史基準快取，第一次抓取`);
        }
    } catch (err) {
        console.warn(`[${label}] 讀取歷史基準快取失敗，改為重新抓取`, err.message);
    }

    const today = new Date();
    const subWindowPointsByYear = [];
    for (const yearsAgo of [1, 2, 3]) {
        console.log(`[${label}] 開始抓取「${yearsAgo}年前同期」資料...`);
        const centerDate = new Date(today);
        centerDate.setFullYear(centerDate.getFullYear() - yearsAgo);
        const rangeStart = addDays(centerDate, -15);
        const rangeEnd = addDays(centerDate, 15);
        const rows = await fetchAllPages(baseUrl, rangeStart, rangeEnd, dateFormatFn, paramNames);
        console.log(`[${label}] ${yearsAgo}年前同期資料筆數：${rows.length}`);
        if (type) logDateRangeSanity(rows, type, label, `${yearsAgo}年前同期應該要是${yearsAgo}年前±15天`);
        // 切成3個小週各自聚合，一年3個基準點，3年總共9個基準點
        const points = splitIntoSubWindowPoints(rows, centerDate, type, columns);
        subWindowPointsByYear.push({ yearsAgo, points });
    }
    try {
        await cacheRef.set({ computedAt: admin.firestore.FieldValue.serverTimestamp(), subWindowPointsByYear });
        console.log(`[${label}] 歷史基準資料已更新快取`);
    } catch (err) {
        console.warn(`[${label}] 寫入歷史基準快取失敗（不影響這次執行結果，只是下次還是要重抓）`, err.message);
    }
    return subWindowPointsByYear;
}

async function fetchRecentAndBaselineRows(baseUrl, label, type, columns) {
    const today = new Date();
    const { dateFormatFn, paramNames } = await detectQueryFormat(baseUrl, label);

    console.log(`[${label}] 開始抓取「近期14天」資料...`);
    const recentRows = await fetchAllPages(baseUrl, addDays(today, -14), today, dateFormatFn, paramNames);
    console.log(`[${label}] 近期資料筆數：${recentRows.length}`);
    if (type) logDateRangeSanity(recentRows, type, label, '近期應該要是最近14天');

    const subWindowPointsByYear = await getBaselineAggByYear(`${label}_${type || 'col'}`, baseUrl, label, type, dateFormatFn, paramNames, columns);
    return { recentRows, subWindowPointsByYear };
}

// 取中位數：把一組數字由小到大排序，取正中間那一個（偶數個的話取中間兩個的平均）
function median(numbers) {
    const sorted = [...numbers].sort((a, b) => a - b);
    const mid = Math.floor(sorted.length / 2);
    return sorted.length % 2 !== 0 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}
// 去頭去尾平均：排序後拿掉最大值跟最小值（通常就是異常年份造成的暴漲或暴跌），
// 剩下的取平均，比單純中位數更能兼顧「用到大部分樣本」又「不被單一極端值拖累」的效果。
// 樣本數太少（少於5個點）的話去頭去尾意義不大，改用中位數
function trimmedMean(numbers) {
    if (numbers.length < 5) return median(numbers);
    const sorted = [...numbers].sort((a, b) => a - b);
    const trimmed = sorted.slice(1, -1); // 拿掉一個最大、一個最小
    return trimmed.reduce((a, b) => a + b, 0) / trimmed.length;
}

// 判斷真便宜/假便宜的容錯係數：3年內物價本來就會有3%~5%左右的自然通膨，
// 用1.05這個容錯範圍，避免因為差個幾毛錢就把「真的很便宜」的食材漏掉
const VALUE_TOLERANCE = 1.05;
const FAKE_CHEAP_SPIKE_THRESHOLD = 1.3; // 去年同期均價只要比基準價高30%以上，就視為「去年異常暴漲」
const FAKE_CHEAP_RATIO_THRESHOLD = 0.95; // 今年價格要「跟基準價差不多、甚至更高」才算是「看起來便宜其實只是假象」
const GREAT_VALUE_RATIO_THRESHOLD = 0.85; // 今年比基準價低15%以上，才夠格叫「真便宜」

// 把「近期rows」跟「9個歷史基準點（3年×3小週）」整理成 { all, recommended }，可以指定type（farm/fish/sheep）跟類別代碼篩選
function buildRecommendationsFromRows(recentRows, subWindowPointsByYear, type, categoryFilter) {
    const recentAgg = aggregateByName(recentRows, type, categoryFilter);

    // 完整清單以「近期」為主——只要現在有在交易，搜尋就要找得到，不能因為過去同期沒有對應資料就整個消失
    const all = [];
    Object.keys(recentAgg).forEach(name => {
        const recent = recentAgg[name];
        if (recent.sampleCount < 1) return;

        // 收集這個食材在9個歷史基準點裡，每個點各自的平均價（樣本數不足<3筆的點不算進去）
        const allPoints = []; // 全部9點（用來算Base_Price、歷史最低點）
        const lastYearPoints = []; // 只有「1年前」那3個點（用來算Last_Year_Spike，判斷去年是不是異常）
        subWindowPointsByYear.forEach(({ yearsAgo, points }) => {
            points.forEach(agg => {
                const baseline = agg && agg[name];
                if (!baseline || baseline.sampleCount < 3 || baseline.avgPrice <= 0) return;
                allPoints.push(baseline.avgPrice);
                if (yearsAgo === 1) lastYearPoints.push(baseline.avgPrice);
            });
        });

        // 至少要有5個基準點（滿分9點，允許缺一些）才採用比較，樣本太少的話比較結果不可靠，寧可不提供
        const hasValidBaseline = recent.sampleCount >= 3 && allPoints.length >= 5;
        let basePrice = null, historicalMin = null, priceRatio = null, lastYearSpike = null;
        let isGreatValue = false, isFakeCheap = false;
        if (hasValidBaseline) {
            basePrice = trimmedMean(allPoints);
            historicalMin = Math.min(...allPoints);
            priceRatio = recent.avgPrice / basePrice;
            lastYearSpike = lastYearPoints.length > 0 ? (lastYearPoints.reduce((a, b) => a + b, 0) / lastYearPoints.length) / basePrice : null;
            // 真便宜：現在價格比基準價低15%以上，而且逼近或低於歷史9點裡的最低點（容許5%的通膨誤差）
            isGreatValue = priceRatio < GREAT_VALUE_RATIO_THRESHOLD && recent.avgPrice <= historicalMin * VALUE_TOLERANCE;
            // 假便宜：看起來沒有比基準價低多少（甚至更高），但去年同期均價比基準價高出30%以上——
            // 代表去年是異常暴漲的年份，今年只是「恢復正常」，不是真的撿到便宜
            isFakeCheap = priceRatio >= FAKE_CHEAP_RATIO_THRESHOLD && lastYearSpike !== null && lastYearSpike >= FAKE_CHEAP_SPIKE_THRESHOLD;
        }
        const item = {
            name,
            recentPrice: Math.round(recent.avgPrice * 100) / 100,
            baselinePrice: basePrice !== null ? Math.round(basePrice * 100) / 100 : null,
            dropPct: basePrice !== null ? Math.round(((basePrice - recent.avgPrice) / basePrice) * 1000) / 10 : null,
            baselinePointsUsed: allPoints.length, // 這次比較實際採用了幾個基準點(滿分9)，方便之後除錯確認
            isGreatValue,
            isFakeCheap,
        };
        all.push(item);
    });

    const recommended = all
        .filter(d => d.dropPct > 0)
        .sort((a, b) => b.dropPct - a.dropPct)
        .slice(0, 50);
    return { all, recommended };
}

async function buildRecommendations(baseUrl, type, label) {
    const { recentRows, subWindowPointsByYear } = await fetchRecentAndBaselineRows(baseUrl, label, type);
    logCategoryCodeSamples(recentRows, type, label);
    return buildRecommendationsFromRows(recentRows, subWindowPointsByYear, type, null);
}

// 農產專用：只抓一次資料，但依種類代碼拆成蔬菜(N04)/水果(N05)/花卉(N06)三個獨立分類
// （代碼是實際跑過診斷log、由人工確認過的，不是猜的）
const FARM_CATEGORY_CODES = {
    vegetables: 'N04',
    fruits: 'N05',
    flowers: 'N06',
};
async function buildFarmCategorizedRecommendations(baseUrl, label) {
    const { recentRows, subWindowPointsByYear } = await fetchRecentAndBaselineRows(baseUrl, label, 'farm');
    const result = {};
    for (const [key, code] of Object.entries(FARM_CATEGORY_CODES)) {
        result[key] = buildRecommendationsFromRows(recentRows, subWindowPointsByYear, 'farm', code);
        console.log(`[${label}] ${key}（代碼${code}）：全部 ${result[key].all.length} 項，推薦 ${result[key].recommended.length} 項`);
    }
    return result;
}

// ---- 型態B：固定欄位快照（毛豬、家禽白肉雞/雞蛋、鴨鵝都是這種格式）----
// 這種資料不是「一堆交易紀錄依名稱分組」，而是每一列代表「某一天」，裡面好幾個欄位各自是不同品項當天的價格，
// 例如同一列裡就有「白肉雞2.0kg以上」跟「雞蛋產地價」兩個不同東西，直接把每個欄位當一個獨立品項來平均
function aggregateByColumns(rows, columns) {
    const totals = {}; // 品項名稱 -> { sum, count }
    columns.forEach(col => { totals[col.name] = { sum: 0, count: 0 }; });
    rows.forEach(row => {
        columns.forEach(col => {
            const candidates = Array.isArray(col.field) ? col.field : [col.field];
            const raw = pickField(row, candidates);
            const val = parseFloat(raw);
            if (isNaN(val) || val <= 0) return;
            // 台斤報價要換算成公斤（÷0.6），才能跟其他類別的單位一致
            const priceInKg = col.unit === 'taijin' ? val / 0.6 : val;
            totals[col.name].sum += priceInKg;
            totals[col.name].count += 1;
        });
    });
    const result = {};
    Object.entries(totals).forEach(([name, t]) => {
        if (t.count <= 0) return;
        result[name] = { avgPrice: t.sum / t.count, sampleCount: t.count };
    });
    return result;
}

// 診斷用：印出第一筆資料實際的JSON欄位名稱，跟我們設定的columns候選名稱做對照，
// 方便一眼看出是不是欄位名稱猜錯了（用在毛豬/雞蛋雞肉/鴨鵝/白米這種聚合出0筆的類別）
function logRawFieldNames(rows, columns, label) {
    if (!rows.length) {
        console.log(`[${label}] 診斷：完全沒有資料可以看欄位名稱`);
        return;
    }
    console.log(`[${label}] 診斷：第一筆資料實際的JSON欄位名稱＝${JSON.stringify(Object.keys(rows[0]))}`);
    console.log(`[${label}] 診斷：第一筆資料完整內容＝${JSON.stringify(rows[0])}`);
    console.log(`[${label}] 診斷：我們設定要找的欄位候選＝${JSON.stringify(columns.map(c => c.field))}`);
}
// 診斷用：印出這批資料實際涵蓋的日期範圍（最早～最晚的交易日期），
// 用來檢查「近期14天」「去年同期±15天」這種日期篩選是不是真的有生效，
// 如果印出來的範圍跟預期差很多（例如涵蓋了好幾年），代表日期篩選沒有真的作用
function logDateRangeSanity(rows, type, label, expectedDesc) {
    if (!rows.length) return;
    const dateFieldCandidates = ['交易日期', 'TransDate', 'transDate', 'pt_date_day', '日期'];
    const dateField = dateFieldCandidates.find(f => rows[0][f] !== undefined);
    if (!dateField) {
        console.log(`[${label}] 診斷：找不到日期欄位可以檢查範圍`);
        return;
    }
    const dates = rows.map(r => r[dateField]).filter(d => d !== undefined && d !== null).sort();
    console.log(`[${label}] 診斷（${expectedDesc}）：實際涵蓋日期範圍＝${dates[0]} ～ ${dates[dates.length - 1]}（共${dates.length}筆有日期）`);
}

async function buildColumnRecommendations(baseUrl, columns, label) {
    console.log(`[${label}] 開始抓取「近期14天」資料...`);
    const { dateFormatFn, paramNames } = await detectQueryFormat(baseUrl, label);
    const today = new Date();
    const recentRows = await fetchAllPages(baseUrl, addDays(today, -14), today, dateFormatFn, paramNames);
    const recentAgg = aggregateByColumns(recentRows, columns);
    console.log(`[${label}] 近期資料筆數：${recentRows.length}`);
    logRawFieldNames(recentRows, columns, label);

    // 跟農產/漁產共用同一套「9個歷史基準點(3年×3小週)」+ 快取機制，type傳null代表用aggregateByColumns聚合
    const subWindowPointsByYear = await getBaselineAggByYear(`${label}_col`, baseUrl, label, null, dateFormatFn, paramNames, columns);

    const all = [];
    Object.keys(recentAgg).forEach(name => {
        const recent = recentAgg[name];
        if (recent.sampleCount < 1) return;
        const allPoints = [];
        const lastYearPoints = [];
        subWindowPointsByYear.forEach(({ yearsAgo, points }) => {
            points.forEach(agg => {
                const baseline = agg && agg[name];
                if (!baseline || baseline.sampleCount < 3 || baseline.avgPrice <= 0) return;
                allPoints.push(baseline.avgPrice);
                if (yearsAgo === 1) lastYearPoints.push(baseline.avgPrice);
            });
        });
        const hasValidBaseline = recent.sampleCount >= 3 && allPoints.length >= 5;
        let basePrice = null, historicalMin = null, priceRatio = null, lastYearSpike = null;
        let isGreatValue = false, isFakeCheap = false;
        if (hasValidBaseline) {
            basePrice = trimmedMean(allPoints);
            historicalMin = Math.min(...allPoints);
            priceRatio = recent.avgPrice / basePrice;
            lastYearSpike = lastYearPoints.length > 0 ? (lastYearPoints.reduce((a, b) => a + b, 0) / lastYearPoints.length) / basePrice : null;
            isGreatValue = priceRatio < GREAT_VALUE_RATIO_THRESHOLD && recent.avgPrice <= historicalMin * VALUE_TOLERANCE;
            isFakeCheap = priceRatio >= FAKE_CHEAP_RATIO_THRESHOLD && lastYearSpike !== null && lastYearSpike >= FAKE_CHEAP_SPIKE_THRESHOLD;
        }
        all.push({
            name,
            recentPrice: Math.round(recent.avgPrice * 100) / 100,
            baselinePrice: basePrice !== null ? Math.round(basePrice * 100) / 100 : null,
            dropPct: basePrice !== null ? Math.round(((basePrice - recent.avgPrice) / basePrice) * 1000) / 10 : null,
            baselinePointsUsed: allPoints.length,
            isGreatValue,
            isFakeCheap,
        });
    });
    const recommended = all.filter(d => d.dropPct > 0).sort((a, b) => b.dropPct - a.dropPct).slice(0, 50);
    return { all, recommended };
}

// 毛豬：實際欄位名稱從診斷log確認過了，是純中文命名，單位已經是元/公斤不用換算
const PIG_COLUMNS = [
    { field: '規格豬-平均價格', name: '毛豬(規格豬)', unit: 'kg' },
];
// 家禽白肉雞/雞蛋：實際欄位名稱從診斷log確認過了，是純中文命名，單位是元/台斤；
// 「雞蛋大盤運輸價」這個欄位實際上不存在（回傳的資料裡只有「雞蛋(產地)」），拿掉
const CHICKEN_EGG_COLUMNS = [
    { field: '白肉雞(2.0Kg以上)', name: '白肉雞(2.0kg以上)', unit: 'taijin' },
    { field: '白肉雞(1.75-1.95Kg)', name: '白肉雞(1.75-1.95kg)', unit: 'taijin' },
    { field: '白肉雞(門市價高屏)', name: '白肉雞(門市價高屏)', unit: 'taijin' },
    { field: '雞蛋(產地)', name: '雞蛋(產地價)', unit: 'taijin' },
];
// 家禽肉鵝/番鴨/鴨蛋：舊網址猜錯過一次、新版REST API不帶金鑰也抓不到，這次改用使用者查到、有封存記錄佐證的網址；
// 欄位名稱比照雞肉雞蛋的規律（實測發現是純中文命名，不是文件上寫的英文），先猜可能的中文寫法當候選，
// 猜錯也沒關係，log的診斷會印出真正的欄位名稱，之後再對照修正
const GOOSE_DUCK_COLUMNS = [
    { field: ['肉鵝(白羅曼)', 'Goose_WR_TaijinPrice'], name: '肉鵝(白羅曼)', unit: 'taijin' },
    { field: ['正番鴨(公)', 'Duck_M_TaijinPrice'], name: '鴨(正番鴨公)', unit: 'taijin' },
    { field: ['土番鴨(75天)', 'Duck_75D_TaijinPrice'], name: '鴨(土番鴨75天)', unit: 'taijin' },
    { field: ['鴨蛋(新蛋)(台南)', '鴨蛋(新蛋台南)', 'Duckegg_TNN_TaijinPrice'], name: '鴨蛋(新蛋台南)', unit: 'taijin' },
];
// 白米：實際欄位名稱從診斷log確認過了，pt_1xxx是零售價(元/公斤)，直接可用不用換算
const RICE_COLUMNS = [
    { field: 'pt_1japt', name: '白米(稉種)', unit: 'kg' },
    { field: 'pt_1tsait', name: '白米(硬秈)', unit: 'kg' },
    { field: 'pt_1sangt', name: '白米(軟秈)', unit: 'kg' },
    { field: 'pt_1glutrt', name: '白米(圓糯)', unit: 'kg' },
    { field: 'pt_1glutlt', name: '白米(長糯)', unit: 'kg' },
];

// ---- 4. 執行並寫入 Firestore ----
async function main() {
    console.log('開始更新市場價格推薦...(SCRIPT_VERSION: 2026-07-27-v14)');

    const emptyResult = { all: [], recommended: [] };
    async function safeBuild(fn, label) {
        try {
            return await fn();
        } catch (err) {
            console.warn(`[${label}] 這個類別執行失敗，本次先跳過：`, err.message);
            return emptyResult;
        }
    }

    // 農產：一次抓資料，依種類代碼拆成蔬菜(N04)/水果(N05)/花卉(N06)三個獨立分類
    const farmCategorized = await safeBuild(() => buildFarmCategorizedRecommendations(
        'https://data.moa.gov.tw/Service/OpenData/FromM/FarmTransData.aspx',
        '農產'
    ), '農產');
    const veg = farmCategorized.vegetables || emptyResult;
    const fruit = farmCategorized.fruits || emptyResult;
    const flower = farmCategorized.flowers || emptyResult;

    const fish = await safeBuild(() => buildRecommendations(
        'https://data.moa.gov.tw/Service/OpenData/FromM/AquaticTransData.aspx',
        'fish',
        '漁產'
    ), '漁產');

    // 這幾個是新加的類別，網址除了毛豬以外都是照官方API命名慣例推測的，還沒100%確認過，
    // 所以每個都包一層try/catch——就算某一個網址猜錯了整個抓不到資料，也不會讓其他類別/整支腳本跟著失敗，
    // 只會在log印警告、Firestore裡那個類別存空陣列，之後確認正確網址再回頭修就好
    const pig = await safeBuild(() => buildColumnRecommendations(
        'https://data.moa.gov.tw/Service/OpenData/FromM/AnimalTransData.aspx',
        PIG_COLUMNS,
        '毛豬'
    ), '毛豬');
    const chickenEgg = await safeBuild(() => buildColumnRecommendations(
        'https://data.moa.gov.tw/Service/OpenData/FromM/PoultryTransData.aspx',
        CHICKEN_EGG_COLUMNS,
        '雞肉雞蛋'
    ), '雞肉雞蛋');
    const gooseDuck = await safeBuild(() => buildColumnRecommendations(
        'https://data.moa.gov.tw/Service/OpenData/FromM/PoultryTransGooseDuckData.aspx',
        GOOSE_DUCK_COLUMNS,
        '鴨鵝'
    ), '鴨鵝');
    const sheep = await safeBuild(() => buildRecommendations(
        'https://data.moa.gov.tw/Service/OpenData/FromM/SheepTransData.aspx',
        'sheep',
        '羊隻'
    ), '羊隻');
    // 白米：網址已確認（要帶UnitId=266這個固定參數）
    const rice = await safeBuild(() => buildColumnRecommendations(
        'https://data.moa.gov.tw/Service/OpenData/FromM/RicepriceData.aspx?UnitId=266',
        RICE_COLUMNS,
        '白米'
    ), '白米');

    await db.collection('marketPriceRecommendations').doc('latest').set({
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
        vegetables: veg.recommended,
        vegetablesAll: veg.all, // 完整清單（不限跌幅方向），給「搜尋特定農產品」功能用
        fruits: fruit.recommended,
        fruitsAll: fruit.all,
        flowers: flower.recommended,
        flowersAll: flower.all,
        fish: fish.recommended,
        fishAll: fish.all,
        pig: pig.recommended,
        pigAll: pig.all,
        chickenEgg: chickenEgg.recommended,
        chickenEggAll: chickenEgg.all,
        gooseDuck: gooseDuck.recommended,
        gooseDuckAll: gooseDuck.all,
        sheep: sheep.recommended,
        sheepAll: sheep.all,
        rice: rice.recommended,
        riceAll: rice.all,
    });

    console.log(`完成！蔬菜推薦 ${veg.recommended.length} 項（全部 ${veg.all.length} 項），水果推薦 ${fruit.recommended.length} 項（全部 ${fruit.all.length} 項），花卉推薦 ${flower.recommended.length} 項（全部 ${flower.all.length} 項），漁產推薦 ${fish.recommended.length} 項（全部 ${fish.all.length} 項）`);
    console.log(`毛豬 ${pig.all.length} 項，雞肉雞蛋 ${chickenEgg.all.length} 項，鴨鵝 ${gooseDuck.all.length} 項，羊隻 ${sheep.all.length} 項，白米 ${rice.all.length} 項`);
}

main().catch(err => {
    console.error('執行失敗：', err);
    process.exit(1);
});
