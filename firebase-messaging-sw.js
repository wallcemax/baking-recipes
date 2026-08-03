// Firebase Cloud Messaging 背景通知用的 service worker
// 這個檔案要放在 repo 的「根目錄」（跟 index.html 同一層），不能放在子資料夾，
// 不然瀏覽器抓不到、背景通知不會出現
importScripts('https://www.gstatic.com/firebasejs/10.14.1/firebase-app-compat.js');
importScripts('https://www.gstatic.com/firebasejs/10.14.1/firebase-messaging-compat.js');

// 這裡的設定值要跟 index.html 裡的 firebaseConfig 完全一樣
firebase.initializeApp({
    apiKey: "AIzaSyB2srYJRT8FqovYt_vCJh35h69H0W7cBLU",
    authDomain: "recipe-synchronization.firebaseapp.com",
    projectId: "recipe-synchronization",
    storageBucket: "recipe-synchronization.firebasestorage.app",
    messagingSenderId: "559668909743",
    appId: "1:559668909743:web:63dc34572b98839479265a"
});

const messaging = firebase.messaging();

// 這兩個是讓新版本的service worker能夠「立刻」取代舊版本生效的關鍵設定：
// 沒有這兩行的話，瀏覽器會讓新版本卡在「等待中」狀態，要等使用者把所有分頁都關掉才會真的切換，
// 導致上傳新的service worker檔案後，使用者手機可能還跑舊版本一段時間都不會更新，
// 造成「明明檔案換了但行為還是舊的」這種容易誤判的狀況
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (event) => event.waitUntil(clients.claim()));

// 網站沒有開著（在背景）的時候，收到推播會走這裡，負責跳出系統通知。
// 故意讀payload.data（不是payload.notification）——後端故意只送data格式，不帶頂層notification，
// 這樣瀏覽器/系統就不會自動再跳出一次通知，全部都交給這裡統一處理，確保同一則訊息只會顯示一次
messaging.onBackgroundMessage((payload) => {
    const data = payload.data || {};
    const title = data.title || '通知';
    const body = data.body || '';
    // tag由後端指定是「哪一種」通知(例如冰箱到期用fridge-expiry-reminder、採購提醒用shopping-list-reminder)，
    // 同一種類型的通知重複出現時會互相取代成一則，但不同類型的通知不會互相蓋掉對方
    const tag = data.tag || 'default-reminder';
    self.registration.showNotification(title, {
        body,
        icon: '🧊', // 大部分瀏覽器不吃emoji當icon，之後有正式圖示可以換成圖片網址
        tag,
        data: { link: data.link || './' }, // 記住點擊時要開啟的網址
    });
});

// 點通知的時候，把使用者帶回網站
self.addEventListener('notificationclick', (event) => {
    event.notification.close();
    const link = (event.notification.data && event.notification.data.link) || './';
    event.waitUntil(
        clients.matchAll({ type: 'window' }).then((clientList) => {
            for (const client of clientList) {
                if ('focus' in client) return client.focus();
            }
            if (clients.openWindow) return clients.openWindow(link);
        })
    );
});
