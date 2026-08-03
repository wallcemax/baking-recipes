// ============================================================
// 冰箱到期提醒 - 排程腳本
// ------------------------------------------------------------
// 每天檢查所有冰箱裡「有效期限剩3天內（含當天、含已過期）」的食材，
// 推播通知給這個冰箱的所有成員（家庭冰箱會通知全部成員，不只是建立者）。
// 沒有填有效期限的食材不會被檢查，直接忽略。
//
// 跟市場價格那支腳本用同一套架構：GitHub Actions排程執行、用firebase-admin寫Firestore，
// 不需要Cloud Functions / Blaze方案，也共用同一組FIREBASE_SERVICE_ACCOUNT密鑰。
//
// 注意：推播的部分「故意不用」admin.messaging().send()——這是Firebase官方SDK長年存在、
// 目前還沒開放設定選項的已知問題：SDK內部的HTTP連線層遇到逾時/連線中斷，會「自動重試一次」，
// 而且完全不會讓我們的程式碼知道發生了重試。如果第一次請求其實已經成功送達裝置、只是回應
// 因為網路狀況delay了，SDK還是會重送第二次，導致使用者收到兩則一模一樣的通知，我們自己的
// 程式碼完全看不出破綻（log只會顯示「呼叫了一次」）。改成自己直接呼叫FCM的REST API，
// 用單純的fetch()送出去，不做任何自動重試，就能徹底避開這個問題
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
const credential = admin.credential.cert(serviceAccount);
admin.initializeApp({ credential });
const db = admin.firestore();

// 自己拿存取權杖、自己直接呼叫FCM REST API，不透過admin.messaging()，避開SDK內建的自動重試
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

// 算「還剩幾天到期」，負數代表已經過期
function daysUntil(expiryDateStr) {
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const exp = new Date(expiryDateStr + 'T00:00:00');
    if (isNaN(exp.getTime())) return null;
    return Math.round((exp - today) / 86400000);
}

async function main() {
    console.log('開始檢查冰箱食材到期狀況...');
    const fridgesSnap = await db.collection('fridges').get();
    console.log(`共有 ${fridgesSnap.size} 個冰箱要檢查`);

    let notifiedDevices = 0;
    let fridgesWithExpiring = 0;

    for (const doc of fridgesSnap.docs) {
        const data = doc.data();
        const items = data.items || [];
        // members欄位是家庭冰箱才有；個人冰箱沒有這個欄位的話，通知對象就是冰箱ID本人（因為個人冰箱ID=uid）
        const members = (data.members && data.members.length) ? data.members : [doc.id];

        // 只挑「有填有效期限、剩3天內（含已過期）」的食材，沒填期限的一律忽略、不檢查
        const soonExpiring = items.filter(item => {
            if (!item.expiryDate) return false;
            const d = daysUntil(item.expiryDate);
            return d !== null && d <= 3;
        });
        if (!soonExpiring.length) continue;
        fridgesWithExpiring++;

        // 收集這個冰箱所有成員、所有裝置的推播權杖（記住每個權杖是哪個uid的，等一下要清理失效權杖用）
        const tokenOwners = []; // [{ uid, token }]
        for (const uid of members) {
            try {
                const tDoc = await db.collection('fcmTokens').doc(uid).get();
                if (tDoc.exists && Array.isArray(tDoc.data().tokens)) {
                    tDoc.data().tokens.forEach(token => tokenOwners.push({ uid, token }));
                }
            } catch (err) {
                console.warn(`讀取 ${uid} 的通知權杖失敗：`, err.message);
            }
        }
        if (!tokenOwners.length) {
            console.log(`冰箱 ${doc.id}：有 ${soonExpiring.length} 項快到期，但沒有任何成員開啟過通知，跳過`);
            continue;
        }

        const names = soonExpiring.map(i => i.name).join('、');
        const title = '🧊 冰箱食材快到期了';
        const body = `${names} 快到期了，記得盡快使用`;
        // tag加上冰箱ID+今天日期，確保「今天這一次檢查」不管實際被送達幾次，
        // 瀏覽器看到的tag都完全一樣，能正確合併顯示成一則，避免SDK底層網路重試造成重複顯示
        const todayForTag = new Date().toISOString().slice(0, 10);
        const notificationTag = `fridge-expiry-${doc.id}-${todayForTag}`;

        for (const { uid, token } of tokenOwners) {
            try {
                await sendFcmMessageRaw({
                    token,
                    // 用webpush.notification：這是Firebase官方建議的標準做法，瀏覽器/SDK看到這個設定
                    // 會「自動」顯示通知，不需要（也不應該）在service worker裡再手動呼叫一次showNotification()
                    webpush: {
                        headers: { Urgency: 'high' },
                        notification: { title, body, tag: notificationTag, requireInteraction: true },
                        fcmOptions: { link: 'https://wallcemax.github.io/baking-recipes/index.html' },
                    },
                    // collapseKey：如果FCM本身在傳輸過程中因為其他原因把同一則訊息送達了不只一次，
                    // 有相同collapseKey的訊息，系統只會保留最新一則在通知列，不會顯示成兩則分開的通知
                    android: { collapseKey: notificationTag },
                });
                notifiedDevices++;
            } catch (err) {
                // UNREGISTERED / INVALID_ARGUMENT 這類錯誤代表權杖確定已經失效了（換裝置、清快取、解除授權…），
                // 順手把它從使用者的權杖清單裡移除，不然會一直堆積在那裡、每次都重複噴一樣的警告
                console.warn(`推播到某個裝置失敗（權杖可能已失效）：`, err.message);
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
        console.log(`冰箱 ${doc.id}：${soonExpiring.length} 項快到期（${names}），通知了 ${tokenOwners.length} 個裝置`);
    }

    console.log(`完成！共 ${fridgesWithExpiring} 個冰箱有食材快到期，總共發送了 ${notifiedDevices} 則通知`);
}

main().catch(err => {
    console.error('執行失敗：', err);
    process.exit(1);
});
