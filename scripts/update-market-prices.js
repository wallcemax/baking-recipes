// ============================================================
// 市場價格專區 - 排程腳本
// SCRIPT_VERSION: 2026-07-27-v3 （這一版修好了大量資料時push(...array)造成的Maximum call stack size exceeded問題）
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
// 三種日期格式都準備好，遇到不確定用哪種格式的API（例如漁產）時，會依序嘗試，抓到第一個有資料的格式
const DATE_FORMATTERS = [
    { label: '民國.月.日', fn: toRocDateString },
    { label: '西元/月/日', fn: toGregSlashDateString },
    { label: '民國/月/日', fn: toRocSlashDateString },
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
    return { name: String(name).trim(), avgPrice, volume: isNaN(volume) ? 1 : Math.max(volume, 0.01) };
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
async function buildRecommendations(baseUrl, type, label) {
    const today = new Date();
    const { dateFormatFn, paramNames } = await detectQueryFormat(baseUrl, label);

    // 近期：最近14天
    console.log(`[${label}] 開始抓取「近期14天」資料...`);
    const recentRows = await fetchAllPages(baseUrl, addDays(today, -14), today, dateFormatFn, paramNames);
    const recentAgg = aggregateByName(recentRows, type);
    console.log(`[${label}] 近期資料筆數：${recentRows.length}，聚合出 ${Object.keys(recentAgg).length} 種`);

    // 基準：過去1年，同一個時節（月/日 ±15天）
    // （原本設計比對過去2年，但實測發現資料量大、GitHub Actions的機器離台灣遠，跨國抓取要花不少時間，
    // 先縮減成只比對去年同期，資料量減半，也已經足夠當「跟去年這時候比是不是特別便宜」的參考基準）
    const baselineRows = [];
    for (const yearsAgo of [1]) {
        console.log(`[${label}] 開始抓取「${yearsAgo}年前同期」資料...`);
        const centerDate = new Date(today);
        centerDate.setFullYear(centerDate.getFullYear() - yearsAgo);
        const rangeStart = addDays(centerDate, -15);
        const rangeEnd = addDays(centerDate, 15);
        const rows = await fetchAllPages(baseUrl, rangeStart, rangeEnd, dateFormatFn, paramNames);
        appendAll(baselineRows, rows);
        console.log(`[${label}] ${yearsAgo}年前同期資料筆數：${rows.length}`);
    }
    const baselineAgg = aggregateByName(baselineRows, type);

    // 比對兩邊都有資料的食材，算漲跌幅（正值代表變便宜了、負值代表變貴了）
    // 這裡不篩選漲跌方向，把「所有比對得出結果的食材」都留著，讓使用者可以搜尋任何一種食材、不只是變便宜的
    const all = [];
    Object.keys(recentAgg).forEach(name => {
        const recent = recentAgg[name];
        const baseline = baselineAgg[name];
        if (!baseline) return;
        // 樣本數太少的不採用，避免單一極端交易造成誤判
        if (recent.sampleCount < 3 || baseline.sampleCount < 3) return;
        if (baseline.avgPrice <= 0) return;
        const dropPct = ((baseline.avgPrice - recent.avgPrice) / baseline.avgPrice) * 100;
        all.push({
            name,
            recentPrice: Math.round(recent.avgPrice * 100) / 100,
            baselinePrice: Math.round(baseline.avgPrice * 100) / 100,
            dropPct: Math.round(dropPct * 10) / 10,
        });
    });

    // 推薦清單：只取真的變便宜的（跌幅>0），依跌幅由大到小排序，取前50名，給主畫面的排行榜用
    const recommended = all
        .filter(d => d.dropPct > 0)
        .sort((a, b) => b.dropPct - a.dropPct)
        .slice(0, 50);

    return { all, recommended };
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

async function buildColumnRecommendations(baseUrl, columns, label) {
    const today = new Date();
    const { dateFormatFn, paramNames } = await detectQueryFormat(baseUrl, label);

    console.log(`[${label}] 開始抓取「近期14天」資料...`);
    const recentRows = await fetchAllPages(baseUrl, addDays(today, -14), today, dateFormatFn, paramNames);
    const recentAgg = aggregateByColumns(recentRows, columns);
    console.log(`[${label}] 近期資料筆數：${recentRows.length}`);

    const baselineRows = [];
    for (const yearsAgo of [1]) {
        console.log(`[${label}] 開始抓取「${yearsAgo}年前同期」資料...`);
        const centerDate = new Date(today);
        centerDate.setFullYear(centerDate.getFullYear() - yearsAgo);
        const rangeStart = addDays(centerDate, -15);
        const rangeEnd = addDays(centerDate, 15);
        const rows = await fetchAllPages(baseUrl, rangeStart, rangeEnd, dateFormatFn, paramNames);
        appendAll(baselineRows, rows);
        console.log(`[${label}] ${yearsAgo}年前同期資料筆數：${rows.length}`);
    }
    const baselineAgg = aggregateByColumns(baselineRows, columns);

    const all = [];
    Object.keys(recentAgg).forEach(name => {
        const recent = recentAgg[name];
        const baseline = baselineAgg[name];
        if (!baseline) return;
        if (recent.sampleCount < 3 || baseline.sampleCount < 3) return;
        if (baseline.avgPrice <= 0) return;
        const dropPct = ((baseline.avgPrice - recent.avgPrice) / baseline.avgPrice) * 100;
        all.push({
            name,
            recentPrice: Math.round(recent.avgPrice * 100) / 100,
            baselinePrice: Math.round(baseline.avgPrice * 100) / 100,
            dropPct: Math.round(dropPct * 10) / 10,
        });
    });
    const recommended = all.filter(d => d.dropPct > 0).sort((a, b) => b.dropPct - a.dropPct).slice(0, 50);
    return { all, recommended };
}

// 毛豬：欄位名稱已由使用者提供的官方文件確認過
const PIG_COLUMNS = [
    { field: 'SpecPig_AvgPrice', name: '毛豬(規格豬)', unit: 'kg' },
];
// 家禽白肉雞/雞蛋：欄位名稱已確認，單位是元/台斤
const CHICKEN_EGG_COLUMNS = [
    { field: 'TaijinPrice_2.0kgup', name: '白肉雞(2.0kg以上)', unit: 'taijin' },
    { field: 'TaijinPrice_1.75kg_1.95kg', name: '白肉雞(1.75-1.95kg)', unit: 'taijin' },
    { field: 'Store_KP_TaijinPrice', name: '白肉雞(門市價高屏)', unit: 'taijin' },
    { field: 'egg_Price', name: '雞蛋(大盤運輸價)', unit: 'taijin' },
    { field: 'egg_Producer_Price', name: '雞蛋(產地價)', unit: 'taijin' },
];
// 家禽肉鵝/番鴨/鴨蛋：欄位名稱已確認，單位是元/台斤
const GOOSE_DUCK_COLUMNS = [
    { field: 'Goose_WR_TaijinPrice', name: '肉鵝(白羅曼)', unit: 'taijin' },
    { field: 'Duck_M_TaijinPrice', name: '鴨(正番鴨公)', unit: 'taijin' },
    { field: 'Duck_75D_TaijinPrice', name: '鴨(土番鴨75天)', unit: 'taijin' },
    { field: 'Duckegg_TNN_TaijinPrice', name: '鴨蛋(新蛋台南)', unit: 'taijin' },
];
// 白米：零售價格資料，單位本來就是元/公斤，不用像台斤那樣轉換；
// 實際的英文欄位名稱沒有查到官方文件確認，所以每個米種放好幾種常見命名當候選，用pickField去試
const RICE_COLUMNS = [
    { field: ['JaptRetailPrice', 'Japt_RetailPrice', 'RetailPrice_Japt', 'JaptPrice'], name: '白米(稉種)', unit: 'kg' },
    { field: ['TsaitRetailPrice', 'Tsait_RetailPrice', 'RetailPrice_Tsait', 'TsaitPrice'], name: '白米(硬秈)', unit: 'kg' },
    { field: ['SangtRetailPrice', 'Sangt_RetailPrice', 'RetailPrice_Sangt', 'SangtPrice'], name: '白米(軟秈)', unit: 'kg' },
    { field: ['GlutltRetailPrice', 'Glutlt_RetailPrice', 'RetailPrice_Glutlt', 'GlutltPrice'], name: '白米(圓糯)', unit: 'kg' },
    { field: ['GlutrtRetailPrice', 'Glutrt_RetailPrice', 'RetailPrice_Glutrt', 'GlutrtPrice'], name: '白米(長糯)', unit: 'kg' },
];

// ---- 4. 執行並寫入 Firestore ----
async function main() {
    console.log('開始更新市場價格推薦...(SCRIPT_VERSION: 2026-07-27-v3)');

    const veg = await buildRecommendations(
        'https://data.moa.gov.tw/Service/OpenData/FromM/FarmTransData.aspx',
        'farm',
        '農產'
    );
    const fish = await buildRecommendations(
        'https://data.moa.gov.tw/Service/OpenData/FromM/AquaticTransData.aspx',
        'fish',
        '漁產'
    );

    // 這四個是新加的類別，網址除了毛豬以外都是照官方API命名慣例推測的，還沒100%確認過，
    // 所以每個都包一層try/catch——就算某一個網址猜錯了整個抓不到資料，也不會讓其他類別/整支腳本跟著失敗，
    // 只會在log印警告、Firestore裡那個類別存空陣列，之後確認正確網址再回頭修就好
    const emptyResult = { all: [], recommended: [] };
    async function safeBuild(fn, label) {
        try {
            return await fn();
        } catch (err) {
            console.warn(`[${label}] 這個類別執行失敗，本次先跳過：`, err.message);
            return emptyResult;
        }
    }
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
        'https://data.moa.gov.tw/Service/OpenData/FromM/PoultryTransData.aspx',
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

    console.log(`完成！農產推薦 ${veg.recommended.length} 項（全部 ${veg.all.length} 項），漁產推薦 ${fish.recommended.length} 項（全部 ${fish.all.length} 項）`);
    console.log(`毛豬 ${pig.all.length} 項，雞肉雞蛋 ${chickenEgg.all.length} 項，鴨鵝 ${gooseDuck.all.length} 項，羊隻 ${sheep.all.length} 項，白米 ${rice.all.length} 項`);
}

main().catch(err => {
    console.error('執行失敗：', err);
    process.exit(1);
});
