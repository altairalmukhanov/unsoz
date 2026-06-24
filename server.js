const express = require('express');
const cors = require('cors');
const axios = require('axios');
const multer = require('multer');
const FormData = require('form-data');
const path = require('path'); // Модуль для работы с путями файлов

const app = express();
const PORT = 3000;

const upload = multer({ storage: multer.memoryStorage() });

app.use(cors());
app.use(express.json());

// НАСТРОЙКИ КЛЮЧЕЙ И URL АПИ
const ALEM_STT_URL = 'https://llm.alem.ai/v1/audio/transcriptions';
const ALEM_STT_KEY = 'Bearer sk-0_rN9pVa299Ky1tdbjpsog';

const ALEM_CHAT_URL = 'https://llm.alem.ai/v1/chat/completions';
const ALEM_CHAT_KEY = 'Bearer sk-bM-LILv3-3J0k6M-mZCAYA';

const BASEROW_URL = 'https://a1-baserow-altosalto-unsoz.dedicatedapp.alem.ai/api/database/rows/table/2/?user_field_names=true';
const BASEROW_KEY = 'Token T5lCabzxphhS8wl769xfMQRZmuM8VDFq';

// 1. РАЗДАЧА ФРОНТЕНДА (Чтобы работал микрофон по адресу http://localhost:3000)
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'voicegrade-ai.html'));
});

// 2. ИСТОРИЯ ЭКЗАМЕНОВ (Для Baserow)
app.get('/api/history', async (req, res) => {
  const { student_id } = req.query;
  try {
    const response = await axios.get(BASEROW_URL, { headers: { 'Authorization': BASEROW_KEY } });
    const allRows = response.data.results || [];
    const studentRows = allRows.filter(row => String(row.student_id) === String(student_id));
    const results = studentRows.map(row => ({
      topic: row.topic || 'Без темы',
      score: Number(row.score) || 0,
      date: row.date || '—'
    }));
    res.json({ results });
  } catch (error) {
    res.json({ results: [] }); 
  }
});

// 3. РАСПОЗНАВАНИЕ РЕЧИ (STT)
app.post('/api/stt', upload.single('audio'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'Файл не получен бэкендом' });
    
    console.log(`🎵 Получен файл для STT: ${req.file.originalname} (${req.file.size} байт)`);

    const form = new FormData();
    let filename = req.file.originalname || 'audio.webm';
    if (!req.file.originalname && req.file.mimetype) {
      const ext = req.file.mimetype.split('/')[1] || 'webm';
      filename = `audio.${ext}`;
    }

    form.append('file', req.file.buffer, {
      filename: filename,
      contentType: req.file.mimetype || 'application/octet-stream'
    });
    form.append('model', 'speech-to-text-kk');
    form.append('temperature', '0');

    const response = await axios.post(ALEM_STT_URL, form, {
      headers: { 'Authorization': ALEM_STT_KEY, ...form.getHeaders() }
    });

    console.log('✅ Результат STT:', response.data.text);
    res.json({ text: response.data.text || '' });
  } catch (error) {
    console.error('❌ Ошибка STT:', error.response?.data || error.message);
    res.status(500).json({ error: 'Ошибка распознавания звука', details: error.response?.data || error.message });
  }
});

// 4. РАБОТА С ИИ (Генерация вопросов и Анализ)
app.post('/api/chat', async (req, res) => {
  const { mode, topic, history, answers, student_id } = req.body;
  
  console.log(`\n📬 [Бэкенд] Запрос /api/chat. Режим: ${mode}, Тема: ${topic}`);
  
  try {
    let systemPrompt = mode === 'question' 
      ? "Ты устный ИИ-экзаменатор. Задай один короткий вопрос по теме на русском языке." 
      : "Ты экзаменационная комиссия. Оцени ответы. Ответь СТРОГО в формате JSON.";
    
    let userPrompt = mode === 'question'
      ? `Тема: ${topic}. История диалога: ${JSON.stringify(history)}. Задай следующий ОДИН вопрос.`
      : `Проанализируй ответы по теме "${topic}". Диалог: ${JSON.stringify(answers)}. Верни СТРОГО JSON-объект: {"score": 85, "factuality": 80, "completeness": 75, "structure": 90, "language": 85, "strengths": ["текст"], "mistakes": ["текст"], "advice": ["текст"]}`;

    console.log('📡 Отправка запроса в Alem AI (Модель: alemllm)...');
    
    const response = await axios.post(ALEM_CHAT_URL, {
      model: 'alemllm', // Намертво закрепленная рабочая модель
      messages: [{ role: 'system', content: systemPrompt }, { role: 'user', content: userPrompt }],
      temperature: 0.3
    }, {
      headers: { 'Authorization': ALEM_CHAT_KEY, 'Content-Type': 'application/json' }
    });

    console.log('📥 Ответ от Alem AI успешно получен!');

    if (!response.data?.choices?.[0]?.message?.content) {
      console.error('❌ Структура ответа Alem AI нарушена:', JSON.stringify(response.data));
      throw new Error('Alem AI вернул пустой ответ');
    }

    const aiResult = response.data.choices[0].message.content.trim();

    if (mode === 'question') {
      console.log('💬 Сгенерирован вопрос:', aiResult);
      return res.json({ question: aiResult });
    }
    
    if (mode === 'analyze') {
      console.log('📝 Анализ ответов завершен.');
      let parsedAnalysis = null;
      
      const jsonMatch = aiResult.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        try { parsedAnalysis = JSON.parse(jsonMatch[0]); } catch (e) { console.log('⚠️ Ошибка парсинга JSON.'); }
      }
      
      if (!parsedAnalysis) {
        const scoreMatch = aiResult.match(/(?:score|оценка|балл\w*)[^\d]*(\d+)/i);
        parsedAnalysis = {
          score: scoreMatch ? Number(scoreMatch[1]) : 75,
          factuality: "См. подробный текст заключения",
          completeness: "См. подробный текст заключения",
          structure: "См. подробный текст заключения",
          language: "См. подробный текст заключения",
          strengths: ["Анализ обработан в текстовом формате"],
          mistakes: ["Нейросеть не вернула чистый JSON"],
          advice: [aiResult]
        };
      }
      
      try {
        await axios.post(BASEROW_URL, {
          "student_id": String(student_id || "123"),
          "topic": topic || "Экзамен",
          "score": Number(parsedAnalysis.score) || 0,
          "date": new Date().toLocaleDateString('ru-RU', { day: 'numeric', month: 'short', year: 'numeric' })
        }, { headers: { 'Authorization': BASEROW_KEY, 'Content-Type': 'application/json' } });
        console.log('💾 Результаты сохранены в базу Baserow!');
      } catch (e) { 
        console.error('❌ Ошибка отправки в Baserow:', e.response?.data || e.message); 
      }
      
      return res.json(parsedAnalysis);
    }
  } catch (error) {
    console.error('❌ Ошибка Alem Chat:', error.response?.data || error.message);
    res.status(500).json({ 
      error: 'Ошибка работы нейросети', 
      details: error.response?.data || error.message 
    });
  }
});

app.listen(PORT, () => {
  console.log(`\n==================================================`);
  console.log(`🚀 СЕРВЕР ЗАПУЩЕН И ГОТОВ К РАБОТЕ!`);
  console.log(`🔗 Адрес для работы в браузере: http://localhost:${PORT}`);
  console.log(`==================================================\n`);
});