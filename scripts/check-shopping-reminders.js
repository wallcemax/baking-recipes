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
// 因為排程是「每小時整點跑一次」，比對邏輯不是單純看「現在是不是設定的那個整點」，
// 而是記錄「上次成功執行的時間點」，檢查「上次~這次執行」這段窗口內有沒有任何提醒該觸發——
// 這樣即使某次排程被GitHub Actions延遲、甚至整次被跳過（官方文件提到系統負載高時可能發生），
// 下一次執行還是會抓到窗口內錯過的提醒，不會真的整個漏掉。實際收到通知的時間點跟設定的分鐘
// 之間可能有最多接近1小時的提前量（例如設定8:45，可能在8:00那次執行就先觸發了），
// 這是每小時執行一次排程本身的取捨，如果要更精準需要縮短排程間隔。
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
admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
const db = admin.firestore();
const messaging = admin.messaging();

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

// 記錄「上次成功執行的時間點」，存在一個固定的系統狀態文件裡，跟個別使用者的提醒設定分開存
async function getLastRunTime(nowTW) {
    try {
        const doc = await db.collection('systemState').doc('shoppingReminderScheduler').get();
        if (doc.exists && doc.data().lastRunAt) {
            return doc.data().lastRunAt.toDate();
        }
    } catch (err) {
        console.warn('讀取上次執行時間失敗，改用預設值', err.message);
    }
    // 從來沒執行過(第一次跑)，預設當作「65分鐘前」就好，涵蓋一般每小時排程的正常間隔，
    // 不要抓太久以前，不然萬一系統很久沒跑，會一次補發一堆已經過期很久的提醒
    return new Date(nowTW.getTime() - 65 * 60 * 1000);
}
async function saveLastRunTime(nowTW) {
    try {
        await db.collection('systemState').doc('shoppingReminderScheduler')
            .set({ lastRunAt: admin.firestore.Timestamp.fromDate(nowTW) }, { merge: true });
    } catch (err) {
        console.warn('儲存這次執行時間失敗（不影響這次的推播結果，只是下次的比對窗口可能不準）', err.message);
    }
}

async function main() {
    const nowTW = getTaiwanNow();
    const todayStr = formatDateStr(nowTW);
    console.log(`開始檢查採購提醒...（台灣時間 ${todayStr} ${nowTW.getHours()}:${String(nowTW.getMinutes()).padStart(2, '0')}）`);

    // 抓「上次執行時間」，跟現在時間中間這一段就是這次要檢查的窗口——
    // 不管中間排程有沒有被GitHub延遲、甚至整次被跳過，只要提醒的時間點落在這個窗口內，這次都會補上，
    // 不會因為某一次排程沒準時觸發就整個漏掉那個使用者設定的提醒
    let lastRunTW = await getLastRunTime(nowTW);
    // 保險機制：如果窗口異常地長（例如腳本壞掉很久沒執行、或是第一次手動測試時剛好抓到很舊的時間），
    // 最多只往回看24小時，避免一次把好幾天份的「過期提醒」全部補發出去，造成使用者被連環轟炸通知
    const maxLookbackMs = 24 * 60 * 60 * 1000;
    if (nowTW.getTime() - lastRunTW.getTime() > maxLookbackMs) {
        console.log('距離上次執行超過24小時，把檢查窗口限制在24小時內，避免一次補發太多天的舊提醒');
        lastRunTW = new Date(nowTW.getTime() - maxLookbackMs);
    }
    console.log(`這次檢查窗口：${lastRunTW.toLocaleString('zh-TW')} ~ ${nowTW.toLocaleString('zh-TW')}`);

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
        // 算出「這個提醒應該觸發的實際時間點」：一次性的話就是指定日期那天的那個時間；
        // 每天固定提醒的話，用「今天」的那個時間點（如果落在檢查窗口內就是要觸發的那一次）
        const targetDateStr = isOneTime ? reminder.date : todayStr;
        const [ty, tm, td] = targetDateStr.split('-').map(n => parseInt(n, 10));
        const scheduledAt = new Date(ty, tm - 1, td, rH, rM, 0, 0);

        // 核心判斷：這個提醒該觸發的時間點，有沒有落在「上次執行~現在」這段窗口內
        // （用(lastRunTW, nowTW]這種「左開右閉」的區間，避免窗口交界的那一分鐘被算兩次或漏掉）
        const isDue = scheduledAt.getTime() > lastRunTW.getTime() && scheduledAt.getTime() <= nowTW.getTime();
        if (!isDue) continue;

        if (!isOneTime && reminder.lastNotifiedDate === todayStr) continue; // 保險：避免同一天重複發送

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
        const body = '你的採購清單裡還有東西沒買，記得去採購喔！';
        let sentAny = false;
        for (const token of tokens) {
            try {
                await messaging.send({
                    token,
                    // 改用webpush.notification讓Firebase官方SDK自動顯示，不再自己手動處理顯示邏輯
                    webpush: {
                        headers: { Urgency: 'high' },
                        notification: { title, body, tag: 'shopping-list-reminder', requireInteraction: true },
                        fcmOptions: { link: 'https://wallcemax.github.io/baking-recipes/index.html' },
                    },
                    android: { collapseKey: 'shopping-list-reminder' },
                });
                notifiedDevices++;
                sentAny = true;
            } catch (err) {
                console.warn(`推播到 ${uid} 的某個裝置失敗（權杖可能已失效）：`, err.message);
                if (err.code === 'messaging/registration-token-not-registered' || (err.errorInfo && err.errorInfo.code === 'messaging/invalid-argument')) {
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
            // 更新這次提醒的狀態：一次性提醒(有設定日期)提醒完直接關閉整個提醒功能；
            // 每天固定提醒的話，只記錄「今天提醒過了」，避免同一天重複發送，明天會自動恢復正常繼續提醒
            const updateData = isOneTime
                ? { enabled: false, lastNotifiedDate: todayStr }
                : { lastNotifiedDate: todayStr };
            try {
                await db.collection('shoppingReminders').doc(uid).set(updateData, { merge: true });
            } catch (err) {
                console.warn(`更新 ${uid} 的提醒狀態失敗：`, err.message);
            }
            console.log(`使用者 ${uid}：已推播採購提醒${isOneTime ? '（一次性，已自動關閉）' : ''}`);
        }
    }

    console.log(`完成！共提醒了 ${notifiedUsers} 位使用者，總共發送了 ${notifiedDevices} 則通知`);
    // 不管這次有沒有真的發送通知，都要記錄這次執行的時間點，下次執行才能接著這個時間點往後檢查窗口
    await saveLastRunTime(nowTW);
}

main().catch(err => {
    console.error('執行失敗：', err);
    process.exit(1);
});
