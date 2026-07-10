/**
 * 共享食譜 - 食材營養成分查詢後端
 * ------------------------------------------------------------
 * 查詢順序：
 *   1) Firestore 快取（ingredientNutrition/{食材名稱}）→ 有就直接回傳，免費又快
 *   2) 快取沒有 → 呼叫 AI（Anthropic Claude）直接估算該食材每 100 克的營養數據
 *   3) 把結果寫回 Firestore 快取，下次同一食材（不論哪個使用者查）都直接吃快取，
 *      不會再重複呼叫 AI，成本只會發生在「全站第一次遇到這個食材」的那一次
 *
 * 金鑰只存在 Secret Manager（用 `firebase functions:secrets:set` 設定），
 * 前端完全看不到，也不會出現在任何回傳給瀏覽器的內容裡。
 *
 * 部署前置需求：
 *   - Firebase 專案要升級為 Blaze（用量付費）方案，Cloud Functions 才能對外部網域發送請求
 *   - 詳細部署步驟請見同資料夾的 README.md
 */

const { onCall, HttpsError } = require('firebase-functions/v2/https');
const { defineSecret } = require('firebase-functions/params');
const admin = require('firebase-admin');
const fetch = require('node-fetch');

admin.initializeApp();
const db = admin.firestore();

// 在 Secret Manager 裡定義的密鑰名稱，實際值用指令設定，不寫在程式碼裡：
//   firebase functions:secrets:set ANTHROPIC_API_KEY
const ANTHROPIC_API_KEY = defineSecret('ANTHROPIC_API_KEY');

// Firestore 文件 ID 不能包含 "/"，也建議統一去除頭尾空白避免同食材重複建快取
function normalizeName(name) {
  return String(name || '').trim().replace(/\//g, '_').slice(0, 200);
}

// 呼叫 AI 估算食材每 100 克的營養數據
async function askAIForNutrition(name, apiKey) {
  const prompt = `你是食品營養資料庫助手。請估算食材「${name}」（繁體中文，烘焙／料理食譜情境）每 100 克的營養數據。

請只回傳一個 JSON 物件，不要有任何其他文字、不要用 markdown code block，格式如下：
{"kcal": 每100克熱量(數字), "protein": 每100克蛋白質公克數, "fat": 每100克脂肪公克數, "carb": 每100克碳水公克數, "sodium": 每100克鈉毫克數}`;

  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: 'claude-haiku-4-5-20251001', // 部署前請確認這是目前有效的 API model 名稱
      max_tokens: 300,
      messages: [{ role: 'user', content: prompt }],
    }),
  });

  if (!res.ok) throw new Error(`AI 請求失敗：${res.status}`);
  const data = await res.json();
  const text = (data.content || []).map(b => b.text || '').join('').trim();
  const cleaned = text.replace(/```json|```/g, '').trim();
  const parsed = JSON.parse(cleaned);
  return {
    kcal: Number(parsed.kcal) || 0,
    protein: Number(parsed.protein) || 0,
    fat: Number(parsed.fat) || 0,
    carb: Number(parsed.carb) || 0,
    sodium: Number(parsed.sodium) || 0,
  };
}

// ---------- 主要對外函式：前端呼叫這個 ----------
// 前端呼叫方式（Firebase compat SDK）：
//   const fn = firebase.app().functions('asia-east1').httpsCallable('getIngredientNutrition');
//   const result = await fn({ name: '無鹽奶油' });
//   console.log(result.data); // { kcal, protein, fat, carb, sodium, source }
exports.getIngredientNutrition = onCall(
  { secrets: [ANTHROPIC_API_KEY], region: 'asia-east1' },
  async (request) => {
    const rawName = request.data && request.data.name;
    if (!rawName || typeof rawName !== 'string') {
      throw new HttpsError('invalid-argument', '請提供食材名稱 name');
    }
    const docId = normalizeName(rawName);
    if (!docId) throw new HttpsError('invalid-argument', '食材名稱不可為空');

    const cacheRef = db.collection('ingredientNutrition').doc(docId);

    // ① 先查快取
    const cached = await cacheRef.get();
    if (cached.exists) {
      return { ...cached.data(), source: 'cache' };
    }

    // ② 快取沒有 → 問 AI
    let result;
    try {
      result = await askAIForNutrition(rawName, ANTHROPIC_API_KEY.value());
    } catch (err) {
      console.error('AI 估算失敗', err.message);
      throw new HttpsError('internal', '目前無法取得這項食材的營養資料，請稍後再試');
    }

    // ③ 寫入快取，下次同一食材直接吃快取
    const payload = {
      name: rawName,
      ...result,
      source: 'ai_estimated',
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    };
    await cacheRef.set(payload);

    return payload;
  }
);

