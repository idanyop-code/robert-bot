require('dotenv').config();

const { Client, LocalAuth } = require('whatsapp-web.js');
const qrImage = require('qrcode');
const OpenAI = require('openai');
const path = require('path');
const fs = require('fs');
const { google } = require('googleapis');
const { authenticate } = require('@google-cloud/local-auth');

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

const client = new Client({
  authStrategy: new LocalAuth({ clientId: 'robert' }),
  puppeteer: {
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-accelerated-2d-canvas',
      '--no-first-run',
      '--no-zygote',
      '--single-process',
      '--disable-gpu'
    ],
  },
});

const OWNER_NUMBER = process.env.OWNER_NUMBER || '';
const SCOPES = ['https://www.googleapis.com/auth/calendar'];git

const TOKEN_PATH = path.join(__dirname, 'token.json');
const CREDENTIALS_PATH = path.join(__dirname, 'credentials.json');
const REMINDER_STATE_PATH = path.join(__dirname, 'reminderState.json');
const PENDING_ACTIONS_PATH = path.join(__dirname, 'pendingActions.json');
const CONVERSATION_STATE_PATH = path.join(__dirname, 'conversationState.json');
const TEMP_DIR = path.join(__dirname, 'temp');

if (!fs.existsSync(TEMP_DIR)) {
  fs.mkdirSync(TEMP_DIR, { recursive: true });
}

function loadJson(filePath, fallback) {
  try {
    if (!fs.existsSync(filePath)) return fallback;
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (err) {
    console.log(`שגיאה בקריאת ${path.basename(filePath)}:`, err.message);
    return fallback;
  }
}

function saveJson(filePath, data) {
  try {
    fs.writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf8');
  } catch (err) {
    console.log(`שגיאה בשמירת ${path.basename(filePath)}:`, err.message);
  }
}

function sanitizeText(text) {
  return (text || '').replace(/\s+/g, ' ').trim();
}

function formatDateYMD(date) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

function addDays(baseDate, days) {
  const d = new Date(baseDate);
  d.setDate(d.getDate() + days);
  return d;
}

function addMinutes(date, minutes) {
  return new Date(date.getTime() + minutes * 60000);
}

function createLocalDateTime(dateStr, timeStr) {
  return new Date(`${dateStr}T${timeStr}:00`);
}

function startOfDay(date = new Date()) {
  const d = new Date(date);
  d.setHours(0, 0, 0, 0);
  return d;
}

function endOfDay(date = new Date()) {
  const d = new Date(date);
  d.setHours(23, 59, 59, 999);
  return d;
}

function formatTime(dateTime) {
  return new Date(dateTime).toLocaleTimeString('he-IL', {
    hour: '2-digit',
    minute: '2-digit'
  });
}

function formatDate(dateTime) {
  return new Date(dateTime).toLocaleDateString('he-IL');
}

function getHebrewWeekday(dateLike) {
  const days = ['יום ראשון', 'יום שני', 'יום שלישי', 'יום רביעי', 'יום חמישי', 'יום שישי', 'שבת'];
  return days[new Date(dateLike).getDay()];
}

function getTimeContextExamples() {
  return `
כללי פירוש זמן:
- "היום בבוקר" = היום ב 09:00 אם לא נאמר זמן מדויק
- "היום בצהריים" = היום ב 13:00 אם לא נאמר זמן מדויק
- "היום אחר הצהריים" = היום ב 16:00 אם לא נאמר זמן מדויק
- "היום בערב" = היום ב 20:00 אם לא נאמר זמן מדויק
- "מחר בבוקר" = מחר ב 09:00 אם לא נאמר זמן מדויק
- "מחר בצהריים" = מחר ב 13:00 אם לא נאמר זמן מדויק
- "מחר אחר הצהריים" = מחר ב 16:00 אם לא נאמר זמן מדויק
- "מחר בערב" = מחר ב 20:00 אם לא נאמר זמן מדויק
- "עוד שעה" = עכשיו ועוד שעה
- "עוד שעתיים" = עכשיו ועוד שעתיים
- "עוד חצי שעה" = עכשיו ועוד 30 דקות
- "עוד 20 דקות" = עכשיו ועוד 20 דקות
- "ב 4" = 16:00 אלא אם ההקשר מאוד ברור לבוקר
- "ב 8 בערב" = 20:00
- "ב 8 בבוקר" = 08:00
- "חמישי" או "ביום חמישי" = יום חמישי הקרוב
- "חמישי הבא" או "ביום חמישי הבא" = יום חמישי של השבוע הבא
- "ראשון" = יום ראשון הקרוב
- "שבוע הבא" בלי יום מדויק = כל היום ביום שני של השבוע הבא
- אם אין זמן בכלל ואין רמז לחלק ביום, allDay = true
- אם יש זמן אבל אין משך, durationMinutes = 60
- אם זה נשמע כמו תור או פגישה, עדיף allDay = false כשיש רמז זמן כלשהו
`;
}

let reminderState = loadJson(REMINDER_STATE_PATH, {
  dailySummarySentFor: '',
  remindersSent: {}
});

let pendingActions = loadJson(PENDING_ACTIONS_PATH, {
  byChat: {}
});

let conversationState = loadJson(CONVERSATION_STATE_PATH, {
  byChat: {}
});

function setChatActive(chatId, minutes = 10) {
  const expiresAt = new Date(Date.now() + minutes * 60 * 1000).toISOString();
  conversationState.byChat[chatId] = { expiresAt };
  saveJson(CONVERSATION_STATE_PATH, conversationState);
}

function isChatActive(chatId) {
  const state = conversationState.byChat[chatId];
  if (!state || !state.expiresAt) return false;
  return new Date(state.expiresAt) > new Date();
}

function clearChatActive(chatId) {
  delete conversationState.byChat[chatId];
  saveJson(CONVERSATION_STATE_PATH, conversationState);
}

const qrcode = require('qrcode-terminal');

client.on('qr', (qr) => {
    console.log('SCAN QR HERE');
    qrcode.generate(qr, { small: true });
});



client.on('ready', () => {
  console.log('רוברט מחובר 😈');
  startReminderLoop();
});

async function loadSavedCredentialsIfExist() {
  try {
    if (!fs.existsSync(TOKEN_PATH)) return null;
    const content = fs.readFileSync(TOKEN_PATH, 'utf8');
    const credentials = JSON.parse(content);
    return google.auth.fromJSON(credentials);
  } catch (err) {
    console.log('לא הצלחתי לקרוא token.json:', err.message);
    return null;
  }
}

async function saveCredentials(clientAuth) {
  const content = fs.readFileSync(CREDENTIALS_PATH, 'utf8');
  const keys = JSON.parse(content);
  const key = keys.installed || keys.web;

  const payload = JSON.stringify({
    type: 'authorized_user',
    client_id: key.client_id,
    client_secret: key.client_secret,
    refresh_token: clientAuth.credentials.refresh_token,
  });

  fs.writeFileSync(TOKEN_PATH, payload);
}

async function authorizeGoogle() {
  let auth = await loadSavedCredentialsIfExist();
  if (auth) return auth;

  auth = await authenticate({
    scopes: SCOPES,
    keyfilePath: CREDENTIALS_PATH,
  });

  if (auth.credentials) {
    await saveCredentials(auth);
  }

  return auth;
}

async function getCalendarClient() {
  const auth = await authorizeGoogle();
  return google.calendar({ version: 'v3', auth });
}

async function listEventsBetween(timeMin, timeMax) {
  const calendar = await getCalendarClient();

  const res = await calendar.events.list({
    calendarId: 'primary',
    timeMin: timeMin.toISOString(),
    timeMax: timeMax.toISOString(),
    singleEvents: true,
    orderBy: 'startTime',
  });

  return res.data.items || [];
}

async function getTodayEvents() {
  return listEventsBetween(startOfDay(new Date()), endOfDay(new Date()));
}

async function getTomorrowEvents() {
  const tomorrow = addDays(new Date(), 1);
  return listEventsBetween(startOfDay(tomorrow), endOfDay(tomorrow));
}

async function getWeekEvents() {
  const now = new Date();
  const end = addDays(now, 7);
  return listEventsBetween(now, end);
}

async function getNextEvent() {
  const now = new Date();
  const end = addDays(now, 30);
  const events = await listEventsBetween(now, end);
  return events.length ? events[0] : null;
}

function formatEventLine(event) {
  const title = event.summary || 'אירוע בלי שם';

  if (event.start?.dateTime) {
    const date = formatDate(event.start.dateTime);
    const time = formatTime(event.start.dateTime);
    return `• ${date} ${time} | ${title}`;
  }

  if (event.start?.date) {
    return `• ${event.start.date} | כל היום | ${title}`;
  }

  return `• ${title}`;
}

function formatEventsList(events, emptyText, headerText) {
  if (!events.length) return emptyText;

  let text = `${headerText}\n\n`;
  for (const event of events) {
    text += `${formatEventLine(event)}\n`;
  }

  return text.trim();
}

function formatTodayEvents(events) {
  return formatEventsList(
    events,
    'אין לך שום דבר ביומן להיום 😎',
    'זה מה שיש לך היום:'
  );
}

function formatTomorrowEvents(events) {
  return formatEventsList(
    events,
    'אין לך שום דבר ביומן למחר 😎',
    'זה מה שיש לך מחר:'
  );
}

function formatWeekEvents(events) {
  if (!events.length) {
    return 'אין לך שום דבר ביומן לשבוע הקרוב 😎';
  }

  const grouped = {};

  for (const event of events) {
    let key = '';
    let label = '';

    if (event.start?.dateTime) {
      const dt = new Date(event.start.dateTime);
      key = formatDateYMD(dt);
      label = `${getHebrewWeekday(dt)} ${dt.toLocaleDateString('he-IL')}`;
    } else if (event.start?.date) {
      const dt = new Date(`${event.start.date}T00:00:00`);
      key = event.start.date;
      label = `${getHebrewWeekday(dt)} ${dt.toLocaleDateString('he-IL')}`;
    } else {
      continue;
    }

    if (!grouped[key]) {
      grouped[key] = {
        label,
        items: []
      };
    }

    const title = event.summary || 'אירוע בלי שם';

    if (event.start?.dateTime) {
      grouped[key].items.push(`• ${formatTime(event.start.dateTime)} | ${title}`);
    } else {
      grouped[key].items.push(`• כל היום | ${title}`);
    }
  }

  const sortedKeys = Object.keys(grouped).sort();

  let text = 'זה מה שיש לך בשבוע הקרוב:\n\n';

  for (const key of sortedKeys) {
    text += `${grouped[key].label}\n`;
    text += `${grouped[key].items.join('\n')}\n\n`;
  }

  return text.trim();
}

function formatNextEvent(event) {
  if (!event) {
    return 'אין לך כרגע פגישה קרובה ביומן 😎';
  }

  const title = event.summary || 'אירוע בלי שם';

  if (event.start?.dateTime) {
    const date = formatDate(event.start.dateTime);
    const time = formatTime(event.start.dateTime);
    return `הפגישה הבאה שלך היא:\n• ${date} ${time} | ${title}`;
  }

  if (event.start?.date) {
    return `האירוע הבא שלך הוא:\n• ${event.start.date} | כל היום | ${title}`;
  }

  return `האירוע הבא שלך הוא:\n• ${title}`;
}

function formatSingleReminder(event, minutesBefore) {
  const title = event.summary || 'אירוע בלי שם';
  let timeText = 'בקרוב';

  if (event.start?.dateTime) {
    timeText = formatTime(event.start.dateTime);
  }

  if (minutesBefore === 20) {
    return `תזכורת ⏰ עוד 20 דקות יש לך: ${title} ב ${timeText}`;
  }

  if (minutesBefore === 5) {
    return `תזכורת ⏰ עוד 5 דקות יש לך: ${title} ב ${timeText}`;
  }

  return `תזכורת ⏰ יש לך: ${title} ב ${timeText}`;
}

function getEventStartDate(event) {
  if (!event.start || !event.start.dateTime) return null;
  return new Date(event.start.dateTime);
}

function getTodayKey() {
  return formatDateYMD(new Date());
}

function getReminderKey(event, type) {
  const start = event.start?.dateTime || event.start?.date || 'no-date';
  const id = event.id || event.iCalUID || event.summary || 'no-id';
  return `${id}__${start}__${type}`;
}

async function sendWhatsAppMessage(text) {
  if (!OWNER_NUMBER) {
    console.log('חסר OWNER_NUMBER ב .env');
    return;
  }

  await client.sendMessage(OWNER_NUMBER, text);
}

async function maybeSendDailySummary() {
  const now = new Date();
  const hour = now.getHours();
  const minute = now.getMinutes();
  const todayKey = getTodayKey();

  if (hour === 8 && minute < 5 && reminderState.dailySummarySentFor !== todayKey) {
    const events = await getTodayEvents();
    const text = events.length
      ? formatEventsList(events, '', 'בוקר טוב ☀️ זה מה שיש לך היום:')
      : 'בוקר טוב ☀️ אין לך שום דבר ביומן להיום';

    await sendWhatsAppMessage(text);

    reminderState.dailySummarySentFor = todayKey;
    saveJson(REMINDER_STATE_PATH, reminderState);

    console.log('נשלח סיכום בוקר');
  }
}

async function maybeSendEventReminders() {
  const events = await getTodayEvents();
  const now = new Date();

  for (const event of events) {
    const startDate = getEventStartDate(event);
    if (!startDate) continue;

    const diffMs = startDate.getTime() - now.getTime();
    const diffMinutes = Math.round(diffMs / 60000);

    const key20 = getReminderKey(event, '20min');
    const key5 = getReminderKey(event, '5min');

    if (diffMinutes <= 20 && diffMinutes >= 19 && !reminderState.remindersSent[key20]) {
      await sendWhatsAppMessage(formatSingleReminder(event, 20));
      reminderState.remindersSent[key20] = true;
      saveJson(REMINDER_STATE_PATH, reminderState);
      console.log('נשלחה תזכורת 20 דקות לפני');
    }

    if (diffMinutes <= 5 && diffMinutes >= 4 && !reminderState.remindersSent[key5]) {
      await sendWhatsAppMessage(formatSingleReminder(event, 5));
      reminderState.remindersSent[key5] = true;
      saveJson(REMINDER_STATE_PATH, reminderState);
      console.log('נשלחה תזכורת 5 דקות לפני');
    }
  }
}

async function reminderTick() {
  try {
    await maybeSendDailySummary();
    await maybeSendEventReminders();
  } catch (err) {
    console.log('שגיאה בלולאת תזכורות:', err.message);
  }
}

function startReminderLoop() {
  reminderTick();
  setInterval(reminderTick, 60 * 1000);
}

async function getSenderName(msg) {
  try {
    const contact = await msg.getContact();
    return contact.pushname || contact.name || 'מישהו';
  } catch {
    return 'מישהו';
  }
}

async function generateReply(senderName, text) {
  const response = await openai.chat.completions.create({
    model: 'gpt-4o-mini',
    messages: [
      {
        role: 'system',
        content: `
אתה רוברט.
אתה עוזר אישי בוואטסאפ.
אתה מדבר בעברית טבעית, קצרה, נעימה וחכמה.
אתה לא רשמי מדי.
אם מישהו פונה אליך לשיחת חולין, תענה טבעי וקצר.
`
      },
      {
        role: 'user',
        content: `${senderName}: ${text}`
      }
    ]
  });

  return response.choices[0].message.content;
}

function isVoiceMessage(msg) {
  const body = (msg.body || '').trim();
  if (msg.type === 'ptt' || msg.type === 'audio') return true;
  if (msg.hasMedia && (body === '[voice message]' || body === '')) return true;
  return false;
}

function getExtensionFromMime(mimeType) {
  if (!mimeType) return 'ogg';
  if (mimeType.includes('ogg')) return 'ogg';
  if (mimeType.includes('mpeg')) return 'mp3';
  if (mimeType.includes('mp4')) return 'mp4';
  if (mimeType.includes('wav')) return 'wav';
  return 'ogg';
}

async function transcribeAudioFile(filePath) {
  const transcription = await openai.audio.transcriptions.create({
    file: fs.createReadStream(filePath),
    model: 'gpt-4o-mini-transcribe'
  });

  return transcription.text || '';
}

async function extractCalendarItemsFromTranscript(transcript) {
  const now = new Date();
  const today = formatDateYMD(now);
  const tomorrow = formatDateYMD(addDays(now, 1));
  const nowIso = now.toISOString();

  const response = await openai.chat.completions.create({
    model: 'gpt-4o-mini',
    response_format: { type: 'json_object' },
    messages: [
      {
        role: 'system',
        content: `
אתה עוזר אישי שמוציא פריטים להכנסה ליומן מתוך תמלול בעברית.

היום הוא: ${today}
מחר הוא: ${tomorrow}
עכשיו הוא: ${nowIso}
אזור זמן: Asia/Jerusalem

תחזיר רק JSON תקין במבנה הבא:
{
  "summary": "סיכום קצר",
  "items": [
    {
      "title": "שם האירוע",
      "date": "YYYY-MM-DD",
      "allDay": true,
      "startTime": "",
      "durationMinutes": 60,
      "originalTimeText": ""
    }
  ]
}

${getTimeContextExamples()}

חוקים:
1. כל הפריטים צריכים להיות מוכנים להכנסה ליומן.
2. אם יש זמן ברור או רמז זמן ברור, allDay יהיה false.
3. אם אין זמן בכלל ואין רמז לחלק ביום, allDay יהיה true.
4. אם לא נאמר תאריך, תשתמש בתאריך של היום.
5. אל תמציא פריטים שלא נאמרו.
6. אם אין פריטים, תחזיר items ריק.
7. אם כתוב "עוד שעה", "עוד שעתיים", "עוד 20 דקות" וכן הלאה, תחשב בפועל זמן מדויק.
8. אם כתוב רק "ב 4", תעדיף 16:00.
9. אם מדובר בפגישה, שיחה, תור, פגישה עם, זום, ישיבה, פגישה טלפונית, עדיף durationMinutes = 60 אלא אם יש רמז אחר.
`
      },
      {
        role: 'user',
        content: `תמלול:\n${transcript}`
      }
    ]
  });

  const content = response.choices[0].message.content || '{}';

  try {
    return JSON.parse(content);
  } catch {
    return {
      summary: 'לא הצלחתי לנתח את ההודעה',
      items: []
    };
  }
}

async function parseTextToCalendarItems(userText) {
  const now = new Date();
  const today = formatDateYMD(now);
  const tomorrow = formatDateYMD(addDays(now, 1));
  const nowIso = now.toISOString();

  const response = await openai.chat.completions.create({
    model: 'gpt-4o-mini',
    response_format: { type: 'json_object' },
    messages: [
      {
        role: 'system',
        content: `
אתה עוזר אישי שמנתח טקסט חופשי בעברית והופך אותו לאירועים ביומן.

היום הוא: ${today}
מחר הוא: ${tomorrow}
עכשיו הוא: ${nowIso}
אזור זמן: Asia/Jerusalem

תחזיר רק JSON תקין במבנה הבא:
{
  "isCalendarRequest": true,
  "items": [
    {
      "title": "שם האירוע",
      "date": "YYYY-MM-DD",
      "allDay": true,
      "startTime": "",
      "durationMinutes": 60,
      "originalTimeText": ""
    }
  ]
}

${getTimeContextExamples()}

חוקים:
1. אם זו לא בקשה ברורה להוסיף אירוע ליומן, תחזיר isCalendarRequest false ו items ריק.
2. אם יש זמן ברור או רמז זמן ברור, allDay יהיה false.
3. אם אין זמן בכלל ואין רמז לחלק ביום, allDay יהיה true.
4. אם לא נאמר תאריך, תשתמש בתאריך של היום.
5. אל תמציא פריטים שלא נאמרו.
6. "ב 4" עדיף לפרש כ 16:00.
7. "עוד שעה", "עוד שעתיים", "עוד 20 דקות" צריך להפוך לזמן אמיתי.
8. "חמישי" הוא הקרוב. "חמישי הבא" הוא של השבוע הבא.
9. אם זה נשמע כמו פגישה, שיחה, תור, ישיבה, זום, durationMinutes = 60 כברירת מחדל.
`
      },
      {
        role: 'user',
        content: userText
      }
    ]
  });

  const content = response.choices[0].message.content || '{}';

  try {
    return JSON.parse(content);
  } catch {
    return {
      isCalendarRequest: false,
      items: []
    };
  }
}

async function parseAvailabilityIntent(userText) {
  const now = new Date();
  const today = formatDateYMD(now);
  const tomorrow = formatDateYMD(addDays(now, 1));
  const nowIso = now.toISOString();

  const response = await openai.chat.completions.create({
    model: 'gpt-4o-mini',
    response_format: { type: 'json_object' },
    messages: [
      {
        role: 'system',
        content: `
אתה מנתח בקשת זמינות ביומן בעברית.

היום הוא: ${today}
מחר הוא: ${tomorrow}
עכשיו הוא: ${nowIso}
אזור זמן: Asia/Jerusalem

תחזיר רק JSON תקין במבנה הבא:
{
  "isAvailabilityRequest": true,
  "mode": "find_free_slots או block_time",
  "date": "YYYY-MM-DD",
  "partOfDay": "morning או afternoon או evening או any",
  "durationMinutes": 60,
  "title": "שם האירוע אם צריך ליצור חסימה, אחרת מחרוזת ריקה"
}

${getTimeContextExamples()}

חוקים:
1. אם הבקשה היא לבדוק זמינות, חלון פנוי, זמן פנוי, מתי אפשר, מתי אני פנוי, תמצא לי חלון זמן פנוי, יש לי חור, mode = find_free_slots
2. אם הבקשה היא ליצור חסימה ביומן כמו תפנה לי שעה, תחסום לי זמן, תשמור לי זמן, mode = block_time
3. אם לא מדובר בבקשת זמינות, תחזיר isAvailabilityRequest false
4. אם לא נאמר תאריך, תשתמש בהיום
5. אם נאמר מחר, תשתמש במחר
6. אם נאמר בוקר = morning, צהריים או אחר הצהריים = afternoon, ערב = evening
7. אם לא נאמר חלק ביום = any
8. אם נאמר חצי שעה = 30, שעה = 60, שעתיים = 120
9. אם מדובר ב block_time ואין כותרת ברורה, תייצר title קצר
10. אם מישהו כותב "תמצא לי חלון זמן פנוי מחר" זו בקשת find_free_slots
`
      },
      {
        role: 'user',
        content: userText
      }
    ]
  });

  const content = response.choices[0].message.content || '{}';

  try {
    return JSON.parse(content);
  } catch {
    return {
      isAvailabilityRequest: false,
      mode: '',
      date: '',
      partOfDay: 'any',
      durationMinutes: 60,
      title: ''
    };
  }
}

function formatParsedItemsReply(transcript, parsed) {
  let text = `שמעתי אותך 🤙\n"${transcript}"\n\n`;

  if (!parsed.items || parsed.items.length === 0) {
    text += 'לא זיהיתי מזה משהו ברור להכניס ליומן.\nנסה להקליט שוב קצת יותר מסודר.';
    return text;
  }

  text += 'זה מה שהבנתי להכניס ליומן:\n\n';

  parsed.items.forEach((item, index) => {
    if (item.allDay) {
      text += `${index + 1}. 📅 ${item.title} | כל היום | ${item.date}\n`;
    } else {
      text += `${index + 1}. ⏰ ${item.title} | ${item.date} ${item.startTime}\n`;
    }
  });

  text += '\nאם זה נראה נכון, תכתוב לי: כן תכניס';
  return text.trim();
}

function formatParsedTextItemsReply(originalText, parsed) {
  let text = `הבנתי אותך ככה 👌\n"${originalText}"\n\n`;

  if (!parsed.items || parsed.items.length === 0) {
    text += 'לא זיהיתי פה אירוע ברור להכניס ליומן.';
    return text;
  }

  text += 'זה מה שאני מתכנן להכניס ליומן:\n\n';

  parsed.items.forEach((item, index) => {
    if (item.allDay) {
      text += `${index + 1}. 📅 ${item.title} | כל היום | ${item.date}\n`;
    } else {
      text += `${index + 1}. ⏰ ${item.title} | ${item.date} ${item.startTime}\n`;
    }
  });

  text += '\nאם זה נראה נכון, תכתוב לי: כן תכניס';
  return text.trim();
}

function storePendingItems(chatId, parsed, sourceType, originalText) {
  pendingActions.byChat[chatId] = {
    parsed,
    sourceType,
    originalText,
    createdAt: new Date().toISOString()
  };

  saveJson(PENDING_ACTIONS_PATH, pendingActions);
}

function getPendingItems(chatId) {
  return pendingActions.byChat[chatId] || null;
}

function clearPendingItems(chatId) {
  delete pendingActions.byChat[chatId];
  saveJson(PENDING_ACTIONS_PATH, pendingActions);
}

async function insertItemsToCalendar(items) {
  const calendar = await getCalendarClient();
  const results = [];

  for (const item of items) {
    if (!item.title || !item.date) continue;

    const event = {
      summary: item.title
    };

    if (item.allDay) {
      const startDate = item.date;
      const endDate = formatDateYMD(addDays(new Date(`${item.date}T00:00:00`), 1));

      event.start = { date: startDate };
      event.end = { date: endDate };
    } else {
      const start = createLocalDateTime(item.date, item.startTime || '09:00');
      const duration = Number(item.durationMinutes || 60);
      const end = addMinutes(start, duration);

      event.start = {
        dateTime: start.toISOString(),
        timeZone: 'Asia/Jerusalem'
      };

      event.end = {
        dateTime: end.toISOString(),
        timeZone: 'Asia/Jerusalem'
      };
    }

    const created = await calendar.events.insert({
      calendarId: 'primary',
      requestBody: event
    });

    results.push(created.data);
  }

  return results;
}

function formatCreatedEventsReply(createdEvents) {
  if (!createdEvents.length) {
    return 'לא הצלחתי להכניס שום דבר ליומן 😕';
  }

  let text = 'סגרתי לך את זה ביומן ✅\n\n';

  createdEvents.forEach((event, index) => {
    let when = 'כל היום';

    if (event.start?.dateTime) {
      const dt = new Date(event.start.dateTime);
      const date = dt.toLocaleDateString('he-IL');
      const time = dt.toLocaleTimeString('he-IL', { hour: '2-digit', minute: '2-digit' });
      when = `${date} ${time}`;
    } else if (event.start?.date) {
      when = event.start.date;
    }

    text += `${index + 1}. ${event.summary || 'אירוע בלי שם'} | ${when}\n`;
  });

  return text.trim();
}

function isPositiveInsertCommand(text) {
  const t = sanitizeText(text).toLowerCase();
  return (
    t === 'כן תכניס' ||
    t === 'תכניס' ||
    t === 'כן' ||
    t === 'יאללה תכניס'
  );
}

function looksLikeTextCalendarRequest(text) {
  const t = sanitizeText(text).toLowerCase();

  return (
    t.includes('תוסיף לי') ||
    t.includes('תכניס לי') ||
    t.includes('תקבע לי') ||
    t.includes('קבע לי') ||
    t.includes('תיצור לי') ||
    t.includes('ביומן') ||
    t.includes('פגישה') ||
    t.includes('פגישה עם') ||
    t.includes('אירוע') ||
    t.includes('תור') ||
    t.includes('מחר ב') ||
    t.includes('היום ב') ||
    t.includes('בשעה ') ||
    t.includes('מחר בבוקר') ||
    t.includes('מחר בערב') ||
    t.includes('היום בערב') ||
    t.includes('עוד שעה') ||
    t.includes('עוד שעתיים') ||
    t.includes('חמישי') ||
    t.includes('ראשון') ||
    t.includes('שני') ||
    t.includes('שלישי') ||
    t.includes('רביעי')
  );
}

function looksLikeAvailabilityRequest(text) {
  const t = sanitizeText(text).toLowerCase();

  return (
    t.includes('מתי אני פנוי') ||
    t.includes('מתי אני פנויה') ||
    t.includes('יש לי זמן פנוי') ||
    t.includes('יש לי חלון פנוי') ||
    t.includes('חלון פנוי') ||
    t.includes('חלון זמן פנוי') ||
    t.includes('תמצא לי חלון') ||
    t.includes('תמצא לי זמן') ||
    t.includes('תמצא לי זמן פנוי') ||
    t.includes('תמצא לי חלון פנוי') ||
    t.includes('חור פנוי') ||
    t.includes('יש לי חור') ||
    t.includes('אפשר פגישה') ||
    t.includes('מתי אפשר') ||
    t.includes('אני פנוי מחר') ||
    t.includes('אני פנוי היום') ||
    t.includes('תפנה לי') ||
    t.includes('תחסום לי') ||
    t.includes('תשמור לי זמן') ||
    t.includes('בלוק עבודה') ||
    t.includes('בלוק זמן')
  );
}

function getRangeForPartOfDay(dateObj, partOfDay) {
  const start = new Date(dateObj);
  const end = new Date(dateObj);

  if (partOfDay === 'morning') {
    start.setHours(8, 0, 0, 0);
    end.setHours(12, 0, 0, 0);
    return { start, end };
  }

  if (partOfDay === 'afternoon') {
    start.setHours(12, 0, 0, 0);
    end.setHours(18, 0, 0, 0);
    return { start, end };
  }

  if (partOfDay === 'evening') {
    start.setHours(18, 0, 0, 0);
    end.setHours(22, 0, 0, 0);
    return { start, end };
  }

  start.setHours(8, 0, 0, 0);
  end.setHours(22, 0, 0, 0);
  return { start, end };
}

function buildBusyIntervals(events, rangeStart, rangeEnd) {
  const intervals = [];

  for (const event of events) {
    if (!event.start?.dateTime || !event.end?.dateTime) continue;

    const start = new Date(event.start.dateTime);
    const end = new Date(event.end.dateTime);

    if (end <= rangeStart || start >= rangeEnd) continue;

    intervals.push({
      start: start < rangeStart ? new Date(rangeStart) : start,
      end: end > rangeEnd ? new Date(rangeEnd) : end
    });
  }

  intervals.sort((a, b) => a.start - b.start);

  const merged = [];
  for (const interval of intervals) {
    if (!merged.length) {
      merged.push(interval);
      continue;
    }

    const last = merged[merged.length - 1];
    if (interval.start <= last.end) {
      if (interval.end > last.end) {
        last.end = interval.end;
      }
    } else {
      merged.push(interval);
    }
  }

  return merged;
}

function findFreeSlots(events, dateObj, durationMinutes, partOfDay = 'any') {
  const { start: rangeStart, end: rangeEnd } = getRangeForPartOfDay(dateObj, partOfDay);
  const busy = buildBusyIntervals(events, rangeStart, rangeEnd);

  const freeSlots = [];
  let cursor = new Date(rangeStart);

  for (const interval of busy) {
    const diffMinutes = Math.floor((interval.start - cursor) / 60000);
    if (diffMinutes >= durationMinutes) {
      freeSlots.push({
        start: new Date(cursor),
        end: new Date(interval.start)
      });
    }

    if (interval.end > cursor) {
      cursor = new Date(interval.end);
    }
  }

  const tailDiff = Math.floor((rangeEnd - cursor) / 60000);
  if (tailDiff >= durationMinutes) {
    freeSlots.push({
      start: new Date(cursor),
      end: new Date(rangeEnd)
    });
  }

  return freeSlots;
}

function formatFreeSlots(dateObj, partOfDay, durationMinutes, slots) {
  const dayLabel = `${getHebrewWeekday(dateObj)} ${new Date(dateObj).toLocaleDateString('he-IL')}`;

  let partLabel = 'במהלך היום';
  if (partOfDay === 'morning') partLabel = 'בבוקר';
  if (partOfDay === 'afternoon') partLabel = 'אחר הצהריים';
  if (partOfDay === 'evening') partLabel = 'בערב';

  if (!slots.length) {
    return `לא מצאתי לך חלון פנוי של ${durationMinutes} דקות ${partLabel} ב ${dayLabel}`;
  }

  let text = `מצאתי לך חלונות פנויים ${partLabel} ב ${dayLabel}:\n\n`;

  slots.slice(0, 5).forEach((slot, index) => {
    text += `${index + 1}. ${formatTime(slot.start)} עד ${formatTime(slot.end)}\n`;
  });

  return text.trim();
}

function formatBlockedTimeReply(item) {
  if (item.allDay) {
    return `שמרתי לך ביומן זמן ל "${item.title}" בתאריך ${item.date} לכל היום.\nאם זה נראה נכון, תכתוב: כן תכניס`;
  }

  return `מצאתי לך זמן ל "${item.title}" ב ${item.date} בשעה ${item.startTime}.\nאם זה נראה נכון, תכתוב: כן תכניס`;
}

async function handleAvailabilityRequest(msg, text) {
  const parsed = await parseAvailabilityIntent(text);

  if (!parsed.isAvailabilityRequest) {
    return false;
  }

  const targetDate = parsed.date ? new Date(`${parsed.date}T00:00:00`) : new Date();
  const partOfDay = parsed.partOfDay || 'any';
  const durationMinutes = Number(parsed.durationMinutes || 60);

  const events = await listEventsBetween(startOfDay(targetDate), endOfDay(targetDate));

  if (parsed.mode === 'find_free_slots') {
    const slots = findFreeSlots(events, targetDate, durationMinutes, partOfDay);
    await msg.reply(formatFreeSlots(targetDate, partOfDay, durationMinutes, slots));
    return true;
  }

  if (parsed.mode === 'block_time') {
    const slots = findFreeSlots(events, targetDate, durationMinutes, partOfDay);

    if (!slots.length) {
      await msg.reply('לא מצאתי חלון פנוי מתאים לחסימה הזאת 😕');
      return true;
    }

    const firstSlot = slots[0];
    const item = {
      title: parsed.title || 'בלוק זמן',
      date: formatDateYMD(firstSlot.start),
      allDay: false,
      startTime: formatTime(firstSlot.start),
      durationMinutes
    };

    const pending = {
      items: [item]
    };

    storePendingItems(msg.from, pending, 'availability_block', text);
    await msg.reply(formatBlockedTimeReply(item));
    return true;
  }

  return false;
}

async function handleVoiceMessage(msg) {
  let tempFilePath = '';

  try {
    const media = await msg.downloadMedia();

    if (!media || !media.data) {
      await msg.reply('לא הצלחתי להוריד את ההודעה הקולית 😕');
      return;
    }

    const ext = getExtensionFromMime(media.mimetype);
    const fileName = `voice_${Date.now()}.${ext}`;
    tempFilePath = path.join(TEMP_DIR, fileName);

    fs.writeFileSync(tempFilePath, Buffer.from(media.data, 'base64'));

    await msg.reply('שמעתי אותך, נותן לזה שניה 🤙');

    const transcript = await transcribeAudioFile(tempFilePath);

    if (!transcript.trim()) {
      await msg.reply('לא הצלחתי להבין משהו ברור מההקלטה 🤷‍♂️');
      return;
    }

    const parsed = await extractCalendarItemsFromTranscript(transcript);
    storePendingItems(msg.from, parsed, 'voice', transcript);

    const reply = formatParsedItemsReply(transcript, parsed);
    await msg.reply(reply);
  } catch (err) {
    console.log('שגיאה בהודעה קולית:', err.message);
    await msg.reply('נפלתי על ההודעה הקולית הזאת 😅 נסה שוב');
  } finally {
    if (tempFilePath && fs.existsSync(tempFilePath)) {
      try {
        fs.unlinkSync(tempFilePath);
      } catch {}
    }
  }
}

client.on('message', async msg => {
  try {
    const text = sanitizeText(msg.body || '');
    const senderName = await getSenderName(msg);

    console.log(senderName + ':', msg.type, '|', text);

    if (msg.fromMe) return;

    if (isVoiceMessage(msg)) {
      setChatActive(msg.from);
      await handleVoiceMessage(msg);
      return;
    }

    if (!text) return;

    if (isPositiveInsertCommand(text)) {
      const pending = getPendingItems(msg.from);

      if (!pending || !pending.parsed || !pending.parsed.items || pending.parsed.items.length === 0) {
        await msg.reply('אין לי כרגע משהו מוכן להכניס ליומן 🤷‍♂️');
        return;
      }

      await msg.reply('סוגר לך את זה ביומן, שניה 🤙');

      const createdEvents = await insertItemsToCalendar(pending.parsed.items);
      clearPendingItems(msg.from);

      await msg.reply(formatCreatedEventsReply(createdEvents));
      return;
    }

    if (text.includes('מה יש לי היום')) {
      setChatActive(msg.from);
      const events = await getTodayEvents();
      await msg.reply(formatTodayEvents(events));
      return;
    }

    if (text.includes('מה יש לי מחר')) {
      setChatActive(msg.from);
      const events = await getTomorrowEvents();
      await msg.reply(formatTomorrowEvents(events));
      return;
    }

    if (text.includes('מה הפגישה הבאה שלי') || text.includes('מה האירוע הבא שלי')) {
      setChatActive(msg.from);
      const event = await getNextEvent();
      await msg.reply(formatNextEvent(event));
      return;
    }

    if (text.includes('מה יש לי השבוע')) {
      setChatActive(msg.from);
      const events = await getWeekEvents();
      await msg.reply(formatWeekEvents(events));
      return;
    }

    if (looksLikeAvailabilityRequest(text)) {
      setChatActive(msg.from);
      const handled = await handleAvailabilityRequest(msg, text);
      if (handled) return;
    }

    if (looksLikeTextCalendarRequest(text)) {
      setChatActive(msg.from);
      const parsed = await parseTextToCalendarItems(text);

      if (parsed.isCalendarRequest && parsed.items && parsed.items.length > 0) {
        storePendingItems(msg.from, parsed, 'text', text);
        await msg.reply(formatParsedTextItemsReply(text, parsed));
        return;
      }
    }

    if (text.includes('רוברט') || text.toLowerCase().includes('robert')) {
      setChatActive(msg.from);
      const reply = await generateReply(senderName, text);
      await msg.reply(reply);
      return;
    }

    if (isChatActive(msg.from)) {
      const lower = text.toLowerCase();

      if (
        lower.includes('שלום') ||
        lower.includes('היי') ||
        lower.includes('מה קורה') ||
        lower.includes('מה שלומך')
      ) {
        const reply = await generateReply(senderName, text);
        await msg.reply(reply);
        return;
      }

      if (looksLikeAvailabilityRequest(text)) {
        const handled = await handleAvailabilityRequest(msg, text);
        if (handled) return;
      }

      if (looksLikeTextCalendarRequest(text)) {
        const parsed = await parseTextToCalendarItems(text);

        if (parsed.isCalendarRequest && parsed.items && parsed.items.length > 0) {
          storePendingItems(msg.from, parsed, 'text', text);
          await msg.reply(formatParsedTextItemsReply(text, parsed));
          return;
        }
      }
    }
  } catch (err) {
    console.log('שגיאה:', err.message);
  }
});

client.initialize();