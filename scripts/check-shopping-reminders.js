// ============================================================
// 採購提醒 - 排程腳本
// ------------------------------------------------------------
// 每小時執行一次，檢查所有使用者設定的「採購提醒」：
// - 只設定時間、沒選日期 → 每天到了那個時段，只要採購清單裡還有「還沒買」的品項，就推播提醒
// - 有設定日期 → 只有那一天那個時段會提醒一次，提醒完自動關閉，之後不會再提醒
//
// 跟冰箱到期提醒、市場價格用同一套架構：GitHub Actions排程執行、用firebase-admin寫Firestore，
// 不需要Cloud Functions / Blaze方案，也共用同一組FIREBASE_SERVICE_ACCOUNT密鑰，
// 通知也是共用同一組fcmTokens（使用者只要開過一次通知權限，兩個功能都能收到推播）。
//
// 每小時整點執行時，直接比對「現在的小時」跟「使用者設定時間的小時」是否相同：
// 例如8點那次執行，只要設定時間是8:00~8:59之間任何一分鐘，都會在這次觸發，
// 最多可能提前59分鐘通知（設定8:59的話，8點那次執行就會先提醒）。
// 這是簡單、固定、不依賴任何額外狀態記錄的比對方式——不會因為「上次執行時間」記錄
// 出狀況而變得時有時無，如果要更精準（縮小提前量），需要縮短排程間隔（例如改成每30分鐘執行一次）。
// ============================================================

const admin = require('firebase-admin');

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
// 注意：推播的部分「故意不用」admin.messaging().send()——這是Firebase官方SDK長年存在、
// 目前還沒開放設定選項的已知問題：SDK內部的HTTP連線層遇到逾時/連線中斷，會「自動重試一次」，
// 而且完全不會讓我們的程式碼知道發生了重試。如果第一次請求其實已經成功送達裝置、只是回應
// 因為網路狀況delay了，SDK還是會重送第二次，導致使用者收到兩則一模一樣的通知，我們自己的
// 程式碼完全看不出破綻（log只會顯示「呼叫了一次」）。改成自己直接呼叫FCM的REST API，
// 用單純的fetch()送出去，不做任何自動重試，就能徹底避開這個問題
const credential = admin.credential.cert(serviceAccount);
admin.initializeApp({ credential });
const db = admin.firestore();
async function getFcmAccessToken() {
    const tokenInfo = await credential.getAccessToken();
    return tokenInfo.access_token;
}
async function sendFcmMessageRaw(message) {
    const accessToken = await getFcmAccessToken();
    const url = `https://fcm.googleapis.com/v1/projects/${serviceAccount.project_id}/messages:send`;
    const res = await fetch(url, {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${accessToken}`, 'Content-Type': 'application/json; UTF-8' },
        body: JSON.stringify({ message }),
        // 這裡只送這一次請求，不做任何自動重試，失敗就是失敗，不會偷偷重送造成重複通知
    });
    if (!res.ok) {
        const errBody = await res.text();
        let errStatus = '';
        try { errStatus = JSON.parse(errBody).error?.status || ''; } catch { /* 解析失敗就當作空字串 */ }
        const err = new Error(`FCM回應錯誤 ${res.status}: ${errBody}`);
        err.fcmStatus = errStatus; // 例如 'UNREGISTERED'、'INVALID_ARGUMENT'，判斷權杖是否失效用
        throw err;
    }
    return res.json();
}

// 取得現在的台灣時間（伺服器可能跑在UTC時區，這裡手動校正+8小時，不依賴伺服器本身的時區設定）
function getTaiwanNow() {
    const now = new Date();
    const utcMs = now.getTime() + now.getTimezoneOffset() * 60000;
    return new Date(utcMs + 8 * 60 * 60 * 1000);
}
// 把Date格式化成YYYY-MM-DD，方便跟reminder.date、lastNotifiedDate這些存成字串的日期比對
function formatDateStr(d) {
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    return `${y}-${m}-${day}`;
}

// 查詢台灣（預設台北）今天接下來會不會下雨，一次執行只查一次（不分使用者），
// 查詢失敗的話回傳null，呼叫端要當作「沒有天氣資訊可用」處理，不能讓天氣查詢失敗影響到
// 採購提醒本身的正常發送
async function fetchWillRainToday() {
    const apiKey = process.env.WEATHERAPI_KEY;
    if (!apiKey) {
        console.log('沒有設定WEATHERAPI_KEY，跳過天氣查詢，通知文字維持原本樣子');
        return null;
    }
    try {
        const res = await fetch(`https://api.weatherapi.com/v1/forecast.json?key=${apiKey}&q=25.0330,121.5654&days=1&lang=zh_tw`);
        if (!res.ok) return null;
        const data = await res.json();
        const conditionText = (data.current && data.current.condition && data.current.condition.text) || '';
        if (conditionText.includes('雨')) return true;
        const hours = (data.forecast && data.forecast.forecastday && data.forecast.forecastday[0] && data.forecast.forecastday[0].hour) || [];
        const nowEpoch = Math.floor(Date.now() / 1000);
        const upcomingHours = hours.filter(h => h.time_epoch >= nowEpoch).slice(0, 12);
        return upcomingHours.some(h => (h.chance_of_rain || 0) >= 50);
    } catch (err) {
        console.warn('查詢天氣失敗，通知文字維持原本樣子', err.message);
        return null;
    }
}

async function main() {
    const nowTW = getTaiwanNow();
    const todayStr = formatDateStr(nowTW);
    const currentHour = nowTW.getHours();
    console.log(`開始檢查採購提醒...（台灣時間 ${todayStr} ${currentHour}時）`);

    const willRainToday = await fetchWillRainToday();
    console.log(`今天會不會下雨：${willRainToday === null ? '查詢失敗，不附加天氣提示' : (willRainToday ? '會' : '不會')}`);

    const remindersSnap = await db.collection('shoppingReminders').where('enabled', '==', true).get();
    console.log(`共有 ${remindersSnap.size} 位使用者開啟了採購提醒`);

    let notifiedUsers = 0;
    let notifiedDevices = 0;

    for (const doc of remindersSnap.docs) {
        const uid = doc.id;
        const reminder = doc.data();
        const timeStr = reminder.time; // 'HH:MM' 格式
        if (!timeStr) continue;
        const [rH, rM] = timeStr.split(':').map(n => parseInt(n, 10));
        if (isNaN(rH) || isNaN(rM)) continue;

        const isOneTime = !!reminder.date; // 有填日期的話，這是「只提醒一次」的模式

        // 核心判斷：簡單、固定的整點比對——不依賴「上次執行時間」這種容易出狀況的狀態記錄。
        // 例如現在執行是「8點」，只要提醒設定的「小時」是8（不管分鐘是8:00還是8:59），
        // 都會在這次「8點執行」時觸發，最多可能提前59分鐘通知（設定8:59的話會在8點就先提醒）。
        // 一次性提醒還要另外比對日期是不是就是今天
        const isDue = rH === currentHour && (!isOneTime || reminder.date === todayStr);
        if (!isDue) continue;

        // 用Firestore交易「搶」這次發送的資格：交易內部會重新讀一次最新資料，確認還沒發送過
        // 才會標記成已發送，這個讀取+標記是不可分割的單一動作。就算剛好有兩個執行同時跑到這裡
        // （例如排程自動觸發跟手動觸發時間點重疊），也只有其中一個能真的搶到資格往下發送通知，
        // 另一個會在交易裡發現「已經被標記過了」而自動放棄，從根本上避免同一則提醒被送兩次
        const reminderRef = db.collection('shoppingReminders').doc(uid);
        let claimed = false;
        try {
            claimed = await db.runTransaction(async (tx) => {
                const freshDoc = await tx.get(reminderRef);
                const freshData = freshDoc.data() || {};
                if (!isOneTime && freshData.lastNotifiedDate === todayStr) return false; // 今天已經被(可能是另一次執行)標記發送過了
                if (isOneTime && freshData.enabled === false) return false; // 一次性提醒已經被標記關閉了，代表已經發送過
                tx.set(reminderRef, isOneTime
                    ? { enabled: false, lastNotifiedDate: todayStr }
                    : { lastNotifiedDate: todayStr }, { merge: true });
                return true;
            });
        } catch (err) {
            console.warn(`搶佔 ${uid} 的發送資格失敗，這次先跳過：`, err.message);
            continue;
        }
        if (!claimed) {
            console.log(`使用者 ${uid}：時間到了，但這次沒搶到發送資格（可能已經被另一次執行搶先發送過），跳過`);
            continue;
        }

        // 檢查這個使用者的採購清單，是不是「還有東西沒買」——已經買完的品項不算，全部買完的話沒必要提醒
        let hasUnpurchasedItems = false;
        try {
            const listDoc = await db.collection('userShoppingLists').doc(uid).get();
            if (listDoc.exists) {
                const data = listDoc.data();
                const items = data.items || [];
                const purchased = data.purchased || {};
                hasUnpurchasedItems = items.some(item => !purchased[item.key || item.name]);
            }
        } catch (err) {
            console.warn(`讀取 ${uid} 的採購清單失敗：`, err.message);
            continue;
        }
        if (!hasUnpurchasedItems) {
            console.log(`使用者 ${uid}：時間到了，但採購清單是空的或已經全部買完，不提醒`);
            continue;
        }

        // 取得這個使用者的推播權杖（跟冰箱到期提醒共用同一個集合）
        let tokens = [];
        try {
            const tDoc = await db.collection('fcmTokens').doc(uid).get();
            if (tDoc.exists && Array.isArray(tDoc.data().tokens)) tokens = tDoc.data().tokens;
        } catch (err) {
            console.warn(`讀取 ${uid} 的通知權杖失敗：`, err.message);
        }
        if (!tokens.length) {
            console.log(`使用者 ${uid}：時間到了、清單也有東西沒買，但沒有開啟過通知，跳過`);
            continue;
        }

        const title = '🛒 採購提醒';
        const body = willRainToday
            ? '記得帶傘，你的採購清單裡還有東西沒買，記得去採購喔！'
            : '你的採購清單裡還有東西沒買，記得去採購喔！';
        // tag加上使用者ID+這次觸發的確切時間點，確保「同一次提醒事件」不管實際被送達幾次，
        // 瀏覽器看到的tag都完全一樣，能正確辨識成同一則、自動合併顯示成一個通知，
        // 不會因為底層SDK網路重試等原因造成的重複送達，讓使用者收到兩則
        const notificationTag = `shopping-reminder-${uid}-${todayStr}-${currentHour}`;
        let sentAny = false;
        for (const token of tokens) {
            try {
                await sendFcmMessageRaw({
                    token,
                    // 用webpush.notification讓Firebase官方SDK自動顯示，不再自己手動處理顯示邏輯
                    webpush: {
                        headers: { Urgency: 'high' },
                        notification: { title, body, tag: notificationTag, requireInteraction: true },
                        fcmOptions: { link: 'https://wallcemax.github.io/baking-recipes/index.html' },
                    },
                    android: { collapseKey: notificationTag },
                });
                notifiedDevices++;
                sentAny = true;
            } catch (err) {
                console.warn(`推播到 ${uid} 的某個裝置失敗（權杖可能已失效）：`, err.message);
                if (err.fcmStatus === 'UNREGISTERED' || err.fcmStatus === 'INVALID_ARGUMENT') {
                    try {
                        await db.collection('fcmTokens').doc(uid).update({
                            tokens: admin.firestore.FieldValue.arrayRemove(token),
                        });
                        console.log(`已清除 ${uid} 的一個失效權杖`);
                    } catch (cleanupErr) {
                        console.warn('清除失效權杖失敗：', cleanupErr.message);
                    }
                }
            }
        }

        if (sentAny) {
            notifiedUsers++;
            // 發送狀態已經在前面的交易裡提前標記過了(搶佔發送資格的同時就順便標記)，這裡不用再更新一次，
            // 只需要記錄log方便之後查閱執行紀錄
            console.log(`使用者 ${uid}：已推播採購提醒${isOneTime ? '（一次性，已自動關閉）' : ''}`);
        } else {
            console.warn(`使用者 ${uid}：已經搶到發送資格、也標記成已發送，但實際上全部裝置都推播失敗了——
狀態已經被標記，不會重試，比較保守的處理方式是避免無限重試造成其他問題，之後可以從log裡人工查證`);
        }
    }

    console.log(`完成！共提醒了 ${notifiedUsers} 位使用者，總共發送了 ${notifiedDevices} 則通知`);
}

main().catch(err => {
    console.error('執行失敗：', err);
    process.exit(1);
});
