// ============================================================
// 冰箱到期提醒 - 排程腳本
// ------------------------------------------------------------
// 每天檢查所有冰箱裡「有效期限剩3天內（含當天、含已過期）」的食材，
// 推播通知給這個冰箱的所有成員（家庭冰箱會通知全部成員，不只是建立者）。
// 沒有填有效期限的食材不會被檢查，直接忽略。
//
// 跟市場價格那支腳本用同一套架構：GitHub Actions排程執行、用firebase-admin寫Firestore，
// 不需要Cloud Functions / Blaze方案，也共用同一組FIREBASE_SERVICE_ACCOUNT密鑰。
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

        for (const { uid, token } of tokenOwners) {
            try {
                await messaging.send({
                    token,
                    notification: { title, body },
                    webpush: {
                        notification: { title, body, requireInteraction: true },
                        fcmOptions: { link: 'https://wallcemax.github.io/baking-recipes/index.html' },
                    },
                });
                notifiedDevices++;
            } catch (err) {
                // NotRegistered / InvalidArgument 這類錯誤代表權杖確定已經失效了（換裝置、清快取、解除授權…），
                // 順手把它從使用者的權杖清單裡移除，不然會一直堆積在那裡、每次都重複噴一樣的警告
                console.warn(`推播到某個裝置失敗（權杖可能已失效）：`, err.message);
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
        console.log(`冰箱 ${doc.id}：${soonExpiring.length} 項快到期（${names}），通知了 ${tokenOwners.length} 個裝置`);
    }

    console.log(`完成！共 ${fridgesWithExpiring} 個冰箱有食材快到期，總共發送了 ${notifiedDevices} 則通知`);
}

main().catch(err => {
    console.error('執行失敗：', err);
    process.exit(1);
});
