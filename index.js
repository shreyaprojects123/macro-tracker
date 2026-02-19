require('dotenv').config();
const express = require('express');
const twilio = require('twilio');
const Anthropic = require('@anthropic-ai/sdk');
const axios = require('axios');
const cron = require('node-cron');

const app = express();
app.use(express.urlencoded({ extended: false }));
app.use(express.json());

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// In-memory store for meals during the day
// Structure: { 'whatsapp:+1234567890': { date: 'YYYY-MM-DD', meals: [...], pendingEdit: null } }
const userSessions = {};

function getToday() {
  return new Date().toISOString().split('T')[0];
}

function getUserSession(userPhone) {
  const today = getToday();
  if (!userSessions[userPhone] || userSessions[userPhone].date !== today) {
    userSessions[userPhone] = { date: today, meals: [], pendingEdit: null };
  }
  return userSessions[userPhone];
}

function getDailyTotals(meals) {
  return meals.reduce(
    (totals, meal) => ({
      calories: totals.calories + (meal.calories || 0),
      protein: totals.protein + (meal.protein_g || 0),
      carbs: totals.carbs + (meal.carbs_g || 0),
      fat: totals.fat + (meal.fat_g || 0),
      fiber: totals.fiber + (meal.fiber_g || 0),
    }),
    { calories: 0, protein: 0, carbs: 0, fat: 0, fiber: 0 }
  );
}

async function analyzeImage(imageUrl) {
    const response = await axios.get(imageUrl, {
      responseType: 'arraybuffer',
      auth: {
        username: process.env.TWILIO_ACCOUNT_SID,
        password: process.env.TWILIO_AUTH_TOKEN,
      },
      headers: { 'Accept': 'image/*' },
      timeout: 15000,
    });
  
    const base64 = Buffer.from(response.data).toString('base64');
    
    let contentType = response.headers['content-type'] || 'image/jpeg';
    contentType = contentType.split(';')[0].trim();
    const validTypes = ['image/jpeg', 'image/png', 'image/gif', 'image/webp'];
    if (!validTypes.includes(contentType)) contentType = 'image/jpeg';
  
    console.log(`Image downloaded: ${base64.length} bytes, type: ${contentType}`);
  
    const result = await anthropic.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 500,
      messages: [{
        role: 'user',
        content: [
          {
            type: 'image',
            source: { type: 'base64', media_type: contentType, data: base64 },
          },
          {
            type: 'text',
            text: `Analyze this meal photo and return ONLY a valid JSON object:
  {
    "meal": "short meal description",
    "calories": number,
    "protein_g": number,
    "carbs_g": number,
    "fat_g": number,
    "fiber_g": number
  }
  Return ONLY the JSON, no other text.`,
          },
        ],
      }],
    });
  
    const text = result.content[0].text.trim();
    console.log('Claude response:', text);
    const cleaned = text.replace(/```json\n?|\n?```/g, '').trim();
    return JSON.parse(cleaned);
  }

async function appendToGoogleSheet(date, meals) {
  const totals = getDailyTotals(meals);
  const mealNames = meals.map((m) => m.meal).join(', ');

  const payload = {
    date,
    calories: Math.round(totals.calories),
    protein: Math.round(totals.protein),
    carbs: Math.round(totals.carbs),
    fat: Math.round(totals.fat),
    fiber: Math.round(totals.fiber),
    meals: mealNames,
  };

  await axios.post(process.env.GOOGLE_APPS_SCRIPT_URL, payload);
  return payload;
}

function formatMacros(macroData) {
  return `🍽 *${macroData.meal}*
• Calories: ${macroData.calories} kcal
• Protein: ${macroData.protein_g}g
• Carbs: ${macroData.carbs_g}g
• Fat: ${macroData.fat_g}g
• Fiber: ${macroData.fiber_g}g`;
}

function formatTotals(totals) {
  return `📊 *Today's Totals*
• Calories: ${Math.round(totals.calories)} kcal
• Protein: ${Math.round(totals.protein)}g
• Carbs: ${Math.round(totals.carbs)}g
• Fat: ${Math.round(totals.fat)}g
• Fiber: ${Math.round(totals.fiber)}g`;
}

// Parse edit commands like "calories 450" or "protein 32"
function parseEditCommand(text) {
  const lower = text.toLowerCase().trim();
  const patterns = [
    { key: 'calories', regex: /calories?\s+(\d+)/ },
    { key: 'protein_g', regex: /proteins?\s+(\d+)/ },
    { key: 'carbs_g', regex: /carbs?\s+(\d+)/ },
    { key: 'fat_g', regex: /fat\s+(\d+)/ },
    { key: 'fiber_g', regex: /fiber\s+(\d+)/ },
  ];

  const edits = {};
  for (const { key, regex } of patterns) {
    const match = lower.match(regex);
    if (match) edits[key] = parseInt(match[1]);
  }
  return Object.keys(edits).length > 0 ? edits : null;
}

// Main WhatsApp webhook
app.post('/webhook', async (req, res) => {
  const twiml = new twilio.twiml.MessagingResponse();
  const from = req.body.From;
  const body = (req.body.Body || '').trim();
  const numMedia = parseInt(req.body.NumMedia || '0');
  const session = getUserSession(from);

  try {
    // --- Handle image ---
    if (numMedia > 0) {
      const mediaUrl = req.body.MediaUrl0;
      twiml.message('🔍 Analyzing your meal...');
      res.type('text/xml').send(twiml.toString());

      try {
        const macros = await analyzeImage(mediaUrl);
        session.pendingEdit = macros;

        const msg = `${formatMacros(macros)}\n\nReply *OK* to confirm, or correct values (e.g. "protein 35" or "calories 420").`;
        await sendWhatsApp(from, msg);
    } catch (err) {
        console.error('Image analysis error FULL:', err.message);
        console.error('Stack:', err.stack);
        await sendWhatsApp(from, `❌ Error: ${err.message}`);
      }
      return;
    }

    // --- Handle text commands ---
    const lower = body.toLowerCase();

    // Confirm pending meal
    if ((lower === 'ok' || lower === 'yes' || lower === 'confirm') && session.pendingEdit) {
      session.meals.push(session.pendingEdit);
      const totals = getDailyTotals(session.meals);
      const confirmed = session.pendingEdit;
      session.pendingEdit = null;
      twiml.message(`✅ *${confirmed.meal}* logged!\n\n${formatTotals(totals)}\n\nSend more meal photos or type *log today* to save to your sheet.`);
    }

    // Edit pending meal
    else if (session.pendingEdit && parseEditCommand(body)) {
      const edits = parseEditCommand(body);
      session.pendingEdit = { ...session.pendingEdit, ...edits };
      twiml.message(`Updated! Here's the corrected entry:\n\n${formatMacros(session.pendingEdit)}\n\nReply *OK* to confirm or keep editing.`);
    }

    // Show today's running total
    else if (lower === 'today' || lower === 'totals' || lower === 'status') {
      if (session.meals.length === 0) {
        twiml.message("No meals logged today yet. Send a photo to get started!");
      } else {
        const totals = getDailyTotals(session.meals);
        const mealList = session.meals.map((m, i) => `${i + 1}. ${m.meal}`).join('\n');
        twiml.message(`${formatTotals(totals)}\n\n*Meals logged:*\n${mealList}`);
      }
    }

    // Manually trigger save to Google Sheet
    else if (lower === 'log today' || lower === 'save' || lower === 'done') {
      if (session.meals.length === 0) {
        twiml.message("No meals logged today yet!");
      } else {
        try {
          const saved = await appendToGoogleSheet(session.date, session.meals);
          twiml.message(`✅ Saved to Google Sheet!\n\n*${saved.date}*\n• Calories: ${saved.calories} kcal\n• Protein: ${saved.protein}g\n• Carbs: ${saved.carbs}g\n• Fat: ${saved.fat}g\n• Fiber: ${saved.fiber}g\n\nMeals: ${saved.meals}`);
        } catch (err) {
          console.error('Sheet error:', err);
          twiml.message('❌ Could not save to Google Sheet. Check your Apps Script URL in .env');
        }
      }
    }

    // Help
    else if (lower === 'help') {
      twiml.message(`*Macro Tracker Commands:*\n\n📸 Send a photo → analyze meal\n*OK* → confirm a meal\n*protein 35* → edit a value\n*today* → see running totals\n*log today* → save to Google Sheet\n*help* → show this message`);
    }

    else {
      twiml.message('Send a meal photo to log macros, or type *help* for commands.');
    }

  } catch (err) {
    console.error('Webhook error:', err);
    twiml.message('Something went wrong. Please try again.');
  }

  res.type('text/xml').send(twiml.toString());
});

// Helper to send a message outside the webhook response cycle
async function sendWhatsApp(to, body) {
  const client = twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);
  await client.messages.create({
    from: `whatsapp:${process.env.TWILIO_PHONE_NUMBER}`,
    to,
    body,
  });
}

// Auto-save to sheet at midnight every day
cron.schedule('0 0 * * *', async () => {
  console.log('Running midnight auto-save...');
  for (const [phone, session] of Object.entries(userSessions)) {
    if (session.meals.length > 0) {
      try {
        await appendToGoogleSheet(session.date, session.meals);
        await sendWhatsApp(phone, `🌙 Midnight auto-save complete!\n\n${formatTotals(getDailyTotals(session.meals))}`);
        console.log(`Saved data for ${phone}`);
      } catch (err) {
        console.error(`Failed to save for ${phone}:`, err);
      }
    }
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Macro tracker running on port ${PORT}`));