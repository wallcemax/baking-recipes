// ============================================================
// 採購提醒 - 排程腳本
// ------------------------------------------------------------
// 每小時執行一次，處理兩種提醒：
// 【個人採購提醒】(shoppingReminders集合)
// - 只設定時間、沒選日期 → 每天到了那個時段，只要採購清單裡還有「還沒買」的品項，就推播提醒
// - 有設定日期 → 只有那一天那個時段會提醒一次，提醒完自動關閉，之後不會再提醒
//
// 【家庭採購清單指定品項提醒】(familyShoppingLists集合，新增的部分)
// - 家人在家庭採購清單裡把某個品項指定給某人買、並且設定了提醒時間，時間到了就提醒「被指定的那個人」
// - 一份清單裡可能同時有好幾個品項、指定給不同的人、設定不同的提醒時間，
//   跟【個人採購提醒】那種「一個使用者只有一筆提醒設定」的形狀不一樣，所以用獨立的迴圈處理，
//   不是硬塞進同一個資料結構裡
// - 品項一旦被標記「已購買」就不會再提醒（不用使用者自己記得取消提醒）
//
// 跟冰箱到期提醒、市場價格用同一套架構：GitHub Actions排程執行、用firebase-admin寫Firestore，
// 不需要Cloud Functions / Blaze方案，也共用同一組FIREBASE_SERVICE_ACCOUNT密鑰，
// 通知也是共用同一組fcmTokens（使用者只要開過一次通知權限，所有功能都能收到推播）。
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
// 把某個使用者的所有裝置都推播一次，失效的權杖順便清掉——這段邏輯【個人採購提醒】跟
// 【家庭採購清單指定品項提醒】都會用到，抽出來共用，不用寫兩次
async function sendToUserDevices(uid, title, body, notificationTag) {
    let tokens = [];
    try {
        const tDoc = await db.collection('fcmTokens').doc(uid).get();
        if (tDoc.exists && Array.isArray(tDoc.data().tokens)) tokens = tDoc.data().tokens;
    } catch (err) {
        console.warn(`讀取 ${uid} 的通知權杖失敗：`, err.message);
    }
    if (!tokens.length) return { sentAny: false, reason: 'no-token' };
    let sentAny = false;
    for (const token of tokens) {
        try {
            await sendFcmMessageRaw({
                token,
                webpush: {
                    headers: { Urgency: 'high' },
                    notification: { title, body, tag: notificationTag, requireInteraction: true },
                    fcmOptions: { link: 'https://wallcemax.github.io/baking-recipes/index.html' },
                },
                android: { collapseKey: notificationTag },
            });
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
    return { sentAny, reason: sentAny ? 'ok' : 'all-failed' };
}
// 決定通知裡要顯示發送者的什麼名字：接收方對發送方的自訂稱謂優先，沒設定過才退回
// 發送方自己的暱稱/Google帳號名稱。稱謂只影響接收方自己看到的內容，所以一定是用
// 「接收方」的稱謂表去查，不是用品項當初新增時就固定寫死的addedByName字串——
// 跟Cloudflare Worker那邊(即時通知)用的是同一套邏輯，只是這裡改用firebase-admin的語法，
// 兩邊沒辦法共用同一份程式碼，但邏輯要保持一致
async function resolveDisplayNameForRecipient(recipientUid, senderUid) {
    try {
        const labelsDoc = await db.collection('familyMemberLabels').doc(recipientUid).get();
        const label = labelsDoc.exists && labelsDoc.data()[senderUid];
        if (label) return label;
    } catch (err) { /* 查不到就繼續往下退回預設名字，不要因為這個失敗就整個中斷 */ }
    try {
        const profileDoc = await db.collection('userProfiles').doc(senderUid).get();
        if (profileDoc.exists) {
            const data = profileDoc.data();
            if (data.nickname || data.displayName) return data.nickname || data.displayName;
        }
    } catch (err) { /* 同上，查不到就用最後的預設值 */ }
    return '有人';
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

// ------------------------------------------------------------
// 【個人採購提醒】：跟原本完全一樣，沒有改動
// ------------------------------------------------------------
async function checkPersonalShoppingReminders(currentHour, todayStr, willRainToday) {
    const remindersSnap = await db.collection('shoppingReminders').where('enabled', '==', true).get();
    console.log(`共有 ${remindersSnap.size} 位使用者開啟了個人採購提醒`);

    let notifiedUsers = 0;
    let notifiedDevices = 0;

    for (const doc of remindersSnap.docs) {
        const uid = doc.id;
        const reminder = doc.data();
        const timeStr = reminder.time; // 'HH:MM' 格式
        if (!timeStr) continue;
        const [rH] = timeStr.split(':').map(n => parseInt(n, 10));
        if (isNaN(rH)) continue;

        const isOneTime = !!reminder.date; // 有填日期的話，這是「只提醒一次」的模式
        const isDue = rH === currentHour && (!isOneTime || reminder.date === todayStr);
        if (!isDue) continue;

        // 用Firestore交易「搶」這次發送的資格：交易內部會重新讀一次最新資料，確認還沒發送過
        // 才會標記成已發送，這個讀取+標記是不可分割的單一動作，避免同一則提醒被送兩次
        const reminderRef = db.collection('shoppingReminders').doc(uid);
        let claimed = false;
        try {
            claimed = await db.runTransaction(async (tx) => {
                const freshDoc = await tx.get(reminderRef);
                const freshData = freshDoc.data() || {};
                if (!isOneTime && freshData.lastNotifiedDate === todayStr) return false;
                if (isOneTime && freshData.enabled === false) return false;
                tx.set(reminderRef, isOneTime
                    ? { enabled: false, lastNotifiedDate: todayStr }
                    : { lastNotifiedDate: todayStr }, { merge: true });
                return true;
            });
        } catch (err) {
            console.warn(`搶佔 ${uid} 的個人提醒發送資格失敗，這次先跳過：`, err.message);
            continue;
        }
        if (!claimed) {
            console.log(`使用者 ${uid}：個人提醒時間到了，但這次沒搶到發送資格，跳過`);
            continue;
        }

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
            console.log(`使用者 ${uid}：個人提醒時間到了，但採購清單是空的或已經全部買完，不提醒`);
            continue;
        }

        const title = '🛒 採購提醒';
        const body = willRainToday
            ? '記得帶傘，你的採購清單裡還有東西沒買，記得去採購喔！'
            : '你的採購清單裡還有東西沒買，記得去採購喔！';
        const notificationTag = `shopping-reminder-${uid}-${todayStr}-${currentHour}`;
        const result = await sendToUserDevices(uid, title, body, notificationTag);

        if (result.sentAny) {
            notifiedUsers++;
            notifiedDevices++;
            console.log(`使用者 ${uid}：已推播個人採購提醒${isOneTime ? '（一次性，已自動關閉）' : ''}`);
        } else if (result.reason === 'no-token') {
            console.log(`使用者 ${uid}：時間到了、清單也有東西沒買，但沒有開啟過通知，跳過`);
        } else {
            console.warn(`使用者 ${uid}：已標記成已發送，但實際推播全部失敗——狀態已標記不會重試，之後可從log人工查證`);
        }
    }
    return { notifiedUsers, notifiedDevices };
}

// ------------------------------------------------------------
// 【家庭採購清單指定品項提醒】：新增的部分
// 掃過每一份家庭採購清單(familyShoppingLists集合，一份代表一個家庭群組)，
// 檢查裡面每一個「已經指定給某人、也設定了提醒時間」的品項，時間到了就提醒被指定的那個人
// ------------------------------------------------------------
async function checkFamilyShoppingItemReminders(currentHour, todayStr) {
    const listsSnap = await db.collection('familyShoppingLists').get();
    console.log(`共有 ${listsSnap.size} 份家庭採購清單`);

    let notifiedItems = 0;
    let notifiedDevices = 0;

    for (const listDoc of listsSnap.docs) {
        const familyId = listDoc.id;
        const items = listDoc.data().items || [];

        for (const item of items) {
            if (item.bought) continue; // 已經買了就不用再提醒
            if (!item.assignedToUid || !item.reminderTime) continue; // 沒指定人、或沒設定提醒時間，跳過

            const [rH] = item.reminderTime.split(':').map(n => parseInt(n, 10));
            if (isNaN(rH)) continue;
            const isOneTime = !!item.reminderDate;
            const isDue = rH === currentHour && (!isOneTime || item.reminderDate === todayStr);
            if (!isDue) continue;

            // 品項是存在陣列裡的（不是各自獨立的文件），沒辦法針對單一品項開交易鎖，
            // 改成用交易「整份清單」讀最新資料、在陣列裡找到這個品項、確認今天還沒發送過，
            // 才標記發送並寫回去——一樣是讀取+標記不可分割，避免同一份清單被同時處理兩次
            // 導致同一個品項的提醒被送兩次
            const listRef = db.collection('familyShoppingLists').doc(familyId);
            let claimed = false;
            let itemSnapshot = null;
            try {
                claimed = await db.runTransaction(async (tx) => {
                    const freshDoc = await tx.get(listRef);
                    const freshItems = (freshDoc.exists && freshDoc.data().items) || [];
                    const freshItem = freshItems.find(i => i.id === item.id);
                    if (!freshItem || freshItem.bought) return false; // 交易當下重新確認一次，避免資料在這期間已經變了
                    if (freshItem.reminderLastNotifiedDate === todayStr) return false; // 今天已經發送過了(不管是不是一次性提醒，判斷方式一樣)
                    freshItem.reminderLastNotifiedDate = todayStr;
                    if (isOneTime) { freshItem.reminderTime = null; freshItem.reminderDate = null; } // 一次性提醒發送完自動關閉
                    itemSnapshot = { ...freshItem };
                    tx.set(listRef, { items: freshItems }, { merge: true });
                    return true;
                });
            } catch (err) {
                console.warn(`搶佔家庭清單「${familyId}」品項「${item.name}」的發送資格失敗，這次先跳過：`, err.message);
                continue;
            }
            if (!claimed) {
                console.log(`家庭清單「${familyId}」品項「${item.name}」：時間到了，但這次沒搶到發送資格（可能已購買/已發送過），跳過`);
                continue;
            }

            const title = '🛒 家人請你幫忙買';
            // 用接收方(itemSnapshot.assignedToUid)對新增者(itemSnapshot.addedByUid)設定的稱謂，
            // 不是用品項新增當下就固定寫死的addedByName字串——這樣接收方之後改了稱謂，
            // 舊品項的提醒也會跟著顯示最新設定，不會卡在建立當下的舊名字
            const displayName = itemSnapshot.addedByUid
                ? await resolveDisplayNameForRecipient(itemSnapshot.assignedToUid, itemSnapshot.addedByUid)
                : (itemSnapshot.addedByName || '有人');
            const body = `${displayName}請你買：${itemSnapshot.name}`;
            const notificationTag = `family-shopping-${familyId}-${item.id}-${todayStr}-${currentHour}`;
            const result = await sendToUserDevices(itemSnapshot.assignedToUid, title, body, notificationTag);

            if (result.sentAny) {
                notifiedItems++;
                notifiedDevices++;
                console.log(`家庭清單「${familyId}」品項「${item.name}」：已推播提醒給 ${itemSnapshot.assignedToUid}${isOneTime ? '（一次性，已自動關閉）' : ''}`);
            } else if (result.reason === 'no-token') {
                console.log(`家庭清單「${familyId}」品項「${item.name}」：時間到了，但被指定的人沒有開啟過通知，跳過`);
            } else {
                console.warn(`家庭清單「${familyId}」品項「${item.name}」：已標記成已發送，但實際推播全部失敗——狀態已標記不會重試`);
            }
        }
    }
    return { notifiedItems, notifiedDevices };
}

async function main() {
    const nowTW = getTaiwanNow();
    const todayStr = formatDateStr(nowTW);
    const currentHour = nowTW.getHours();
    console.log(`開始檢查採購提醒...（台灣時間 ${todayStr} ${currentHour}時）`);

    const willRainToday = await fetchWillRainToday();
    console.log(`今天會不會下雨：${willRainToday === null ? '查詢失敗，不附加天氣提示' : (willRainToday ? '會' : '不會')}`);

    const personalResult = await checkPersonalShoppingReminders(currentHour, todayStr, willRainToday);
    const familyResult = await checkFamilyShoppingItemReminders(currentHour, todayStr);

    console.log(`完成！個人提醒：${personalResult.notifiedUsers} 位使用者、${personalResult.notifiedDevices} 則通知。` +
        `家庭指定品項提醒：${familyResult.notifiedItems} 個品項、${familyResult.notifiedDevices} 則通知。`);
}

main().catch(err => {
    console.error('執行失敗：', err);
    process.exit(1);
});
