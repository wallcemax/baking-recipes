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

// 注意：這裡故意「不再」自己寫onBackgroundMessage去手動呼叫showNotification()，
// 也不再自己寫notificationclick去處理點擊開啟連結——後端傳送訊息時已經改用webpush.notification
// 這個標準格式，加上fcmOptions.link，Firebase官方的messaging-compat SDK看到這兩個設定，
// 會「自動」負責顯示通知、也會自動處理點擊後開啟指定連結，不需要（也不應該）自己再寫一次，
// 之前顯示錯誤內容的問題，很可能就是因為自己手動處理跟SDK自動處理互相干擾造成的
