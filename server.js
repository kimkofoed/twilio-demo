// server.js — Heino på Gemini Live ⚡️
require("dotenv").config();
const express = require("express");
const twilio = require("twilio");
const http = require("http");
const WebSocket = require("ws");

const app = express();
app.use(express.json({ limit: "5mb" }));
app.use(express.urlencoded({ extended: true }));

// Health check
app.get("/health", (req, res) => res.send("✅ Server kører — Heino (Gemini Live) er klar!"));

// 🔍 Test din Gemini API key
app.get("/test-key", async (req, res) => {
  try {
    const response = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models?key=${process.env.GEMINI_API_KEY}`
    );
    const text = await response.text();
    console.log("📦 Gemini /models svar:", text.slice(0, 300) + "...");
    res.status(response.status).type("application/json").send(text);
  } catch (err) {
    console.error("💥 Fejl under test-key:", err);
    res.status(500).json({ error: err.message });
  }
});

/**
 * 📞 Twilio webhook → starter stream
 */
app.post("/voice", (req, res) => {
  console.log("📞 Voice webhook modtaget!");
  const twiml = new twilio.twiml.VoiceResponse();
  const start = twiml.start();
  start.stream({ url: `wss://${req.headers.host}/media` });

  twiml.say(
    { language: "da-DK", voice: "Polly.Mads" },
    "Forbindelsen er oprettet. Du taler nu med AI-assistenten Heino — drevet af Gemini!"
  );
  twiml.pause({ length: 120 });
  res.type("text/xml");
  res.send(twiml.toString());
});

// 🎧 WebSocket: Twilio ↔ Gemini
const server = http.createServer(app);
const wss = new WebSocket.Server({ server, path: "/media" });

wss.on("connection", (twilioSocket) => {
  console.log("🔊 Twilio stream connected");

  // 🔌 Forbind til Gemini Live
const GEMINI_WS_URL =
  "wss://generativelanguage.googleapis.com/v1alpha/models/gemini-2.5-flash:streamGenerateContent?alt=ws&key=" +
  process.env.GEMINI_API_KEY;


  console.log("🔌 Forbinder til Gemini Live API...");
  const geminiSocket = new WebSocket(GEMINI_WS_URL);

  let geminiReady = false;
  const audioBuffer = [];

  geminiSocket.on("open", () => {
    console.log("🧠 Gemini Live connected!");
    geminiReady = true;

    // 🔧 Start session med dansk stemme
    const setupMsg = {
      setup: {
        model: "models/gemini-2.5-flash-live",
        voiceConfig: { voiceName: "da-DK-Wavenet-A" },
        inputConfig: { encoding: "MULAW", sampleRateHertz: 8000 },
        outputConfig: { encoding: "MULAW", sampleRateHertz: 8000 },
      },
    };
    geminiSocket.send(JSON.stringify(setupMsg));

    // 💬 Velkomst
    geminiSocket.send(
      JSON.stringify({
        data: { text: "Hej, jeg er Heino på Gemini! Hvad så, hvordan går det?" },
      })
    );

    if (audioBuffer.length > 0) {
      console.log(`📤 Sender ${audioBuffer.length} bufferede lydchunks`);
      audioBuffer.forEach((chunk) => geminiSocket.send(chunk));
      audioBuffer.length = 0;
    }
  });

  geminiSocket.on("message", (event) => {
    const msgStr = event.toString();
    console.log("📩 RAW fra Gemini:", msgStr.slice(0, 200));

    try {
      const msg = JSON.parse(msgStr);

      // Gemini sender audio-data som base64
      if (msg?.data?.audio) {
        if (twilioSocket.readyState === WebSocket.OPEN) {
          twilioSocket.send(
            JSON.stringify({ event: "media", media: { payload: msg.data.audio } })
          );
          console.log("🎙️ Heino sender lyd tilbage til Twilio");
        }
      }

      if (msg?.data?.text) {
        console.log("💬 Heino siger:", msg.data.text);
      }
    } catch {
      // Ikke alle beskeder er JSON (nogle heartbeat-pings)
    }
  });

  geminiSocket.on("close", (code, reason) => {
    console.warn("⚠️ Gemini socket closed:", code, reason.toString());
  });

  geminiSocket.on("error", (err) => {
    console.error("💥 Gemini socket error:", err.message);
  });

  // 🔁 Twilio → Gemini
  twilioSocket.on("message", (msg) => {
    try {
      const text = msg.toString();
      if (!text.startsWith("{")) return;
      const data = JSON.parse(text);

      if (data.event !== "media") {
        console.log("📨 Twilio event:", data.event);
        if (data.event === "stop") {
          console.log("🛑 Stop event modtaget — afslutter session");
          if (geminiReady) {
            geminiSocket.send(
              JSON.stringify({ data: { text: "Tak for snakken, ha’ en god dag!" } })
            );
          }
        }
        return;
      }

      if (!data.media?.payload) return;
      const payload = JSON.stringify({
        data: { audio: data.media.payload },
      });

      if (geminiReady) geminiSocket.send(payload);
      else audioBuffer.push(payload);
    } catch (err) {
      console.error("💥 Fejl i Twilio → Gemini håndtering:", err);
    }
  });

  twilioSocket.on("close", () => {
    console.log("🔕 Twilio stream closed");
    if (geminiSocket.readyState === WebSocket.OPEN) geminiSocket.close();
  });
});

// 🚀 Start server
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`🚀 Heino (Gemini Live) kører på port ${PORT}`));