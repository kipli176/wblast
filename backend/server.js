import baileysPkg from '@whiskeysockets/baileys';
import express from 'express'
import { WebSocketServer } from 'ws'
import qrcode from 'qrcode'
import fs from 'fs'
import path from 'path' 
import { fileURLToPath } from "url";

const {
  makeWASocket,
  useMultiFileAuthState,
  DisconnectReason,
  Browsers,
  makeInMemoryStore,
  jidNormalizedUser
} = baileysPkg;

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
 
const store = makeInMemoryStore({});
const app = express()
app.use(express.json())

let sock = null
let isConnected = false
let wss = null

// Queue system
let queue = []
let isSending = false
const DEFAULT_DELAY = 5000
const BATCH_LIMIT = 50
const BATCH_COOLDOWN = 10 * 60 * 1000

let sentInCurrentBatch = 0
let batchCooldownActive = false

// Log file
const logFile = path.join(process.cwd(), 'backend/logs.json')

// Contacts cache
let contacts = {}

// === Utility: log persisten ===
function appendLog(entry) {
  let logs = []
  try {
    if (fs.existsSync(logFile)) {
      const content = fs.readFileSync(logFile, 'utf-8')
      if (content.trim().length > 0) {
        logs = JSON.parse(content)
      }
    }
  } catch (err) {
    console.error('Error reading log file, resetting file:', err)
    logs = []
  }
  logs.push(entry)
  fs.writeFileSync(logFile, JSON.stringify(logs, null, 2))
}


// === Personalize pesan dengan nama kontak ===
async function personalizeMessage(jid, message) {
  let name = jidNormalizedUser(jid).split('@')[0]; // default nomor

  try {
    if (store.contacts[jid]?.name) {
      name = store.contacts[jid].name;
    } else if (store.contacts[jid]?.notify) {
      name = store.contacts[jid].notify;
    }
  } catch (err) {
    console.error("Gagal ambil nama WA:", err);
  }

  return message.replace(/\{name\}/g, name);
}



// === Start Baileys ===
async function start() {
  const { state, saveCreds } = await useMultiFileAuthState('./auth_info')

  sock = makeWASocket({
    auth: state,
    printQRInTerminal: true,
    browser: Browsers.ubuntu('BaileysDocker')
  })
  store.bind(sock.ev);

  sock.ev.on('connection.update', async (update) => {
    const { connection, lastDisconnect, qr } = update

    if (qr) {
      const qrDataUrl = await qrcode.toDataURL(qr)
      broadcast({ type: 'qr', qr: qrDataUrl })
    }

    if (connection === 'close') {
      isConnected = false
      broadcast({ type: 'status', status: 'disconnected' })
      const shouldReconnect =
        lastDisconnect?.error?.output?.statusCode !== DisconnectReason.loggedOut
      if (shouldReconnect) start()
    } else if (connection === 'open') {
      isConnected = true
      broadcast({ type: 'status', status: 'connected' })
      console.log('✅ WhatsApp connected!')
      // Ambil kontak
      try {
        contacts = await sock?.store?.contacts || {}
        broadcast({ type: 'contacts', contacts })
      } catch (err) {
        console.error('Gagal ambil kontak:', err)
      }
    }
  })

  sock.ev.on('contacts.update', (updates) => {
    updates.forEach((u) => {
      if (u.id) contacts[u.id] = { id: u.id, name: u.notify || u.name || u.id }
    })
    broadcast({ type: 'contacts', contacts })
  })

  sock.ev.on('creds.update', saveCreds)
}

// === WebSocket broadcast ===
function broadcast(obj) {
  if (wss) {
    const msg = JSON.stringify(obj)
    wss.clients.forEach((client) => {
      if (client.readyState === 1) client.send(msg)
    })
  }
}

// === Delay helper ===
function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

// === Queue processor ===
async function processQueue() {
  if (isSending || queue.length === 0) return
  if (batchCooldownActive) {
    broadcast({ type: 'log', msg: `⏸️ Batch cooldown aktif, tunggu 10 menit...` })
    return
  }

  isSending = true
  const { jid, message, resolve, reject } = queue.shift()

  try {
    const typingDelay = 1000 + Math.floor(Math.random() * 2000)
    await wait(typingDelay)

    const personalized = await personalizeMessage(jid, message)
    await sock.sendMessage(jid, { text: personalized })

    const logEntry = { time: new Date().toISOString(), status: 'success', to: jid, message: personalized }
    appendLog(logEntry)
    broadcast({ type: 'log', msg: `✔️ Sent to ${jid}` })
    resolve(logEntry)
  } catch (err) {
    const logEntry = { time: new Date().toISOString(), status: 'failed', to: jid, error: err.message }
    appendLog(logEntry)
    broadcast({ type: 'log', msg: `❌ Error sending to ${jid}: ${err.message}` })
    reject(logEntry)
  }

  sentInCurrentBatch++
  if (sentInCurrentBatch >= BATCH_LIMIT) {
    sentInCurrentBatch = 0
    batchCooldownActive = true
    broadcast({ type: 'log', msg: `🚦 Batch limit ${BATCH_LIMIT} tercapai, jeda 10 menit.` })
    setTimeout(() => {
      batchCooldownActive = false
      broadcast({ type: 'log', msg: '▶️ Lanjut batch berikutnya.' })
      isSending = false
      processQueue()
    }, BATCH_COOLDOWN)
    return
  }

  const delay = DEFAULT_DELAY + Math.floor(Math.random() * 2000)
  setTimeout(() => {
    isSending = false
    processQueue()
  }, delay)
}

// === API Endpoints ===
app.post('/send-message', async (req, res) => {
  if (!isConnected || !sock) return res.status(503).json({ status: 'failed', error: 'WhatsApp not connected' })
  const { number, message } = req.body
  if (!number || !message) return res.status(400).json({ status: 'failed', error: 'Missing number or message' })
  const jid = number.includes('@s.whatsapp.net') ? number : number + '@s.whatsapp.net'
  const result = new Promise((resolve, reject) => {
    queue.push({ jid, message, resolve, reject })
    processQueue()
  })
  result.then((ok) => res.json(ok)).catch((err) => res.status(500).json(err))
})

app.post('/send-batch', async (req, res) => {
  if (!isConnected || !sock) return res.status(503).json({ status: 'failed', error: 'WhatsApp not connected' })
  const { numbers, message } = req.body
  if (!Array.isArray(numbers) || numbers.length === 0 || !message) {
    return res.status(400).json({ status: 'failed', error: 'Missing numbers or message' })
  }
  numbers.forEach((num) => {
    const jid = num.includes('@s.whatsapp.net') ? num : num + '@s.whatsapp.net'
    queue.push({ jid, message, resolve: () => {}, reject: () => {} })
  })
  processQueue()
  res.json({ status: 'queued', total: numbers.length })
})

app.get('/logs', (req, res) => {
  try {
    if (fs.existsSync(logFile)) {
      const logs = JSON.parse(fs.readFileSync(logFile, 'utf-8'))
      res.json({ status: 'ok', logs })
    } else {
      res.json({ status: 'ok', logs: [] })
    }
  } catch (err) {
    res.status(500).json({ status: 'failed', error: err.message })
  }
})

// API untuk kontak
app.get('/contacts', (req, res) => {
  res.json({ status: 'ok', contacts: store.contacts });
});


// === Start server & WS ===
const server = app.listen(3000, () => console.log('🚀 API ready on http://localhost:3000'))

// Serve frontend folder
app.use(express.static(path.join(__dirname, "../frontend")));
// Default ke wa-blast.html
app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "../frontend/wa-blast.html"));
});

wss = new WebSocketServer({ server })
wss.on('connection', (ws) => {
  ws.send(JSON.stringify({ type: 'status', status: isConnected ? 'connected' : 'disconnected' }))
  ws.send(JSON.stringify({ type: 'contacts', contacts }))
})

start()
