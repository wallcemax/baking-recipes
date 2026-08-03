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
// 因為排程是「每小時整點跑一次」，這裡只比對「小時」是否相符，不比對分鐘——
// 使用者設定的提醒時間如果是「09:15」，只要排程有跑到09:00這一整個小時的範圍內，
// 都會當作「時間到了」觸發，實際收到通知的時間點可能跟設定的分鐘有一點誤差(最多±1小時)，
// 這是每小時執行一次排程本身就會有的取捨，如果要更精準需要縮短排程間隔。
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

async function main() {
    const nowTW = getTaiwanNow();
    const todayStr = formatDateStr(nowTW);
    const currentHour = nowTW.getHours();
    console.log(`開始檢查採購提醒...（台灣時間 ${todayStr} ${currentHour}時）`);

    const remindersSnap = await db.collection('shoppingReminders').where('enabled', '==', true).get();
    console.log(`共有 ${remindersSnap.size} 位使用者開啟了採購提醒`);

    let notifiedUsers = 0;
    let notifiedDevices = 0;

    for (const doc of remindersSnap.docs) {
        const uid = doc.id;
        const reminder = doc.data();
        const timeStr = reminder.time; // 'HH:MM' 格式
        if (!timeStr) continue;
        const reminderHour = parseInt(timeStr.split(':')[0], 10);
        if (isNaN(reminderHour) || reminderHour !== currentHour) continue; // 還沒到設定的時段，跳過

        const isOneTime = !!reminder.date; // 有填日期的話，這是「只提醒一次」的模式
        if (isOneTime) {
            if (reminder.date !== todayStr) continue; // 不是指定的那一天，跳過
        } else {
            // 每天固定提醒的模式：今天已經提醒過的話跳過，避免同一小時排程萬一跑了兩次就重複發送
            if (reminder.lastNotifiedDate === todayStr) continue;
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
        const body = '你的採購清單裡還有東西沒買，記得去採購喔！';
        let sentAny = false;
        for (const token of tokens) {
            try {
                await messaging.send({
                    token,
                    notification: { title, body },
                    webpush: {
                        notification: { title, body, requireInteraction: true, tag: 'shopping-list-reminder' },
                        fcmOptions: { link: 'https://wallcemax.github.io/baking-recipes/index.html' },
                    },
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
}

main().catch(err => {
    console.error('執行失敗：', err);
    process.exit(1);
});
