require('dotenv').config();
const express = require('express');
const sqlite3 = require('sqlite3').verbose();
const cors = require('cors');
const axios = require('axios');
const app = express();
const PORT = process.env.PORT || 3000; // 本地開發用 3000，Render 會自動提供 PORT

app.listen(PORT, () => {
  console.log(`Server is running on port ${PORT}`);
});
const dbPath = './itineraries.db';

app.use(cors());
app.use(express.json({ type: 'application/json', charset: 'utf-8' }));

const db = new sqlite3.Database(dbPath, (err) => {
  if (err) {
    console.error('資料庫連線失敗:', err.message);
  } else {
    console.log('已連接到 itineraries.db');
  }
});

app.post('/ask', async (req, res) => {
  try {
    const {
      city = '大阪',
      month,
      minTemp = 10,
      maxTemp = 20,
      minRating = 4.0,
      preferences = [],
      budget = 5000,
      departureDate,
    } = req.body;

    if (!month || month < 1 || month > 12) {
      return res.status(400).json({ error: '請提供有效月份 (1-12)' });
    }

    const apiKey = process.env.OPENROUTER_API_KEY;
    if (!apiKey) {
      return res.status(500).json({ error: '伺服器缺少 OpenRouter API Key 配置' });
    }

    // 移除 cruise_facts JOIN，簡化查詢
    let query = `
      SELECT DISTINCT
        i.itinerary_name,
        i.url,
        i.rating,
        i.review_count,
        i.participant_count,
        i.min_price_ntd,
        l.city,
        l.country,
        w.average_temperature,
        w.precipitation_mm
      FROM itineraries i
      JOIN locations l ON i.location_id = l.location_id
      JOIN weather w ON l.location_id = w.location_id
      WHERE l.city = ?
        AND w.month = ?
        AND w.average_temperature BETWEEN ? AND ?
        AND i.rating >= ?
        AND i.min_price_ntd <= ?
    `;
    const params = [city, month, minTemp, maxTemp, minRating, budget];

    db.all(query, params, async (err, rows) => {
      if (err) {
        console.error('查詢錯誤:', err.message);
        return res.status(500).json({ error: '資料庫查詢失敗' });
      }

      if (!rows.length) {
        return res.status(404).json({ message: '此區間無推薦行程' });
      }

      const prompt = `
        使用者希望在 ${city} 的 ${month} 月旅遊，偏好：${preferences.join(', ') || '無特定偏好'}。
        以下是符合條件的行程：
        ${rows
          .map(
            (row, index) =>
              `${index + 1}. ${row.itinerary_name} (評分: ${row.rating}, 價格: NT$${row.min_price_ntd}, 氣溫: ${row.average_temperature}°C)`,
          )
          .join('\n')}
        請根據偏好推薦最適合的行程，並簡要說明原因（50-100 字）。
      `;

      try {
        const aiResponse = await axios.post(
          'https://openrouter.ai/api/v1/chat/completions',
          {
            model: 'gpt-3.5-turbo',
            messages: [{ role: 'user', content: prompt }],
            max_tokens: 150,
          },
          {
            headers: {
              Authorization: `Bearer ${apiKey}`,
              'Content-Type': 'application/json',
            },
          },
        );

        const aiRecommendation = aiResponse.data.choices[0].message.content.trim();

        res.json({
          status: 'success',
          data: rows,
          aiRecommendation,
        });
      } catch (aiError) {
        console.error('AI 推薦失敗:', aiError.message);
        res.json({
          status: 'partial_success',
          data: rows,
          aiRecommendation: '無法生成 AI 推薦，請稍後重試',
        });
      }
    });
  } catch (error) {
    console.error('伺服器錯誤:', error.message);
    res.status(500).json({ error: '伺服器內部錯誤' });
  }
});

app.post('/export', async (req, res) => {
  try {
    const {
      city = '大阪',
      month,
      minTemp = 10,
      maxTemp = 20,
      minRating = 4.0,
      budget = 5000,
    } = req.body;

    if (!month || month < 1 || month > 12) {
      return res.status(400).json({ error: '請提供有效月份 (1-12)' });
    }

    // 移除 cruise_facts JOIN
    const query = `
      SELECT DISTINCT
        i.itinerary_name,
        i.url,
        i.rating,
        i.review_count,
        i.participant_count,
        i.min_price_ntd,
        l.city,
        l.country,
        w.average_temperature,
        w.precipitation_mm
      FROM itineraries i
      JOIN locations l ON i.location_id = l.location_id
      JOIN weather w ON l.location_id = w.location_id
      WHERE l.city = ?
        AND w.month = ?
        AND w.average_temperature BETWEEN ? AND ?
        AND i.rating >= ?
        AND i.min_price_ntd <= ?
    `;
    const params = [city, month, minTemp, maxTemp, minRating, budget];

    db.all(query, params, (err, rows) => {
      if (err) {
        console.error('查詢錯誤:', err.message);
        return res.status(500).json({ error: '資料庫查詢失敗' });
      }

      if (!rows.length) {
        return res.status(404).json({ message: '此區間無推薦行程' });
      }

      const headers = ['行程名稱', '網址', '評分', '評論數', '參與人數', '最低價格(NT$)', '城市', '國家', '平均氣溫(°C)', '降水量(mm)'];
      const csvRows = rows.map(row =>
        `"${row.itinerary_name}","${row.url}","${row.rating}","${row.review_count}","${row.participant_count}","${row.min_price_ntd}","${row.city}","${row.country}","${row.average_temperature}","${row.precipitation_mm}"`
      );
      const csv = [headers.join(','), ...csvRows].join('\n');

      res.header('Content-Type', 'text/csv; charset=utf-8');
      res.header('Content-Disposition', 'attachment; filename=itineraries.csv');
      res.send('\uFEFF' + csv);
    });
  } catch (error) {
    console.error('匯出錯誤:', error.message);
    res.status(500).json({ error: '伺服器內部錯誤' });
  }
});

app.get('/cities', (req, res) => {
  db.all('SELECT DISTINCT city, country FROM locations', (err, rows) => {
    if (err) {
      console.error('查詢城市失敗:', err.message);
      return res.status(500).json({ error: '查詢城市失敗' });
    }
    res.json({
      status: 'success',
      data: rows,
    });
  });
});

app.get('/health', (req, res) => {
  db.get('SELECT 1', (err) => {
    if (err) {
      console.error('資料庫健康檢查失敗:', err.message);
      return res.status(500).json({ status: 'error', message: '資料庫連線失敗' });
    }
    res.json({ status: 'ok', "message": '伺服器與資料庫正常' });
  });
});

process.on('SIGTERM', () => {
  console.log('關閉資料庫連線');
  db.close();
  process.exit(0);
});