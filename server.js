// server.js
require("dotenv").config();
const express = require("express");
const twilio = require("twilio");
const http = require("http");
const WebSocket = require("ws");
const { Buffer } = require("buffer");
const mulaw = require("mulaw-js");

const app = express();
app.use(express.json({ limit: "5mb" }));
app.use(express.urlencoded({ extended: true }));

// Health check
app.get("/health", (_, res) => res.send("OK"));

// Twilio webhook → starter Media Stream
app.post("/voice", (req, res) => {
  const twiml = new twilio.twiml.VoiceResponse();
  const start = twiml.start();
  start.stream({ url: `wss://${req.headers.host}/media` });

  twiml.say(
    { language: "da-DK", voice: "Polly.Mads" },
    "Forbindelsen er oprettet. Du taler nu med AI-assistenten Heino!"
  );

  // holder linjen åben i 2 minutter
  twiml.pause({ length: 120 });

  res.type("text/xml");
  res.send(twiml.toString());
});

const server = http.createServer(app);
const wss = new WebSocket.Server({ server, path: "/media" });

wss.on("connection", (twilioSocket) => {
  console.log("🔊 Twilio stream connected");

  // Opret forbindelse til OpenAI Realtime
  const openaiSocket = new WebSocket(
    "wss://api.openai.com/v1/realtime?model=gpt-4o-realtime-preview-2024-10-01",
    {
      headers: {
        Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
        "OpenAI-Beta": "realtime=v1",
      },
    }
  );

  let openaiReady = false;
  const bufferedAudio = [];

  openaiSocket.on("open", () => {
    console.log("🧠 OpenAI Realtime API connected");
    openaiReady = true;

    openaiSocket.send(
      JSON.stringify({
        type: "session.update",
        session: {
          modalities: ["audio", "text"],
          voice: "alloy",
          input_audio_format: "pcm16",
          output_audio_format: "mulaw",
          instructions: `
            Du er Heino, en sjov, venlig dansk AI-assistent.
            Du taler afslappet og hjælper dem, der ringer til Jens og Kim.
            Stil spørgsmål og svar med lidt humor.
            Tal tydeligt på dansk.
          `,
        },
      })
    );

    bufferedAudio.forEach((chunk) => openaiSocket.send(chunk));
    bufferedAudio.length = 0;
  });

  // ---------- Twilio → OpenAI ----------
  twilioSocket.on("message", (msg) => {
    let data;
    try {
      const text = msg.toString();
      if (!text.startsWith("{")) return; // ignorer binære frames
      data = JSON.parse(text);
    } catch {
      return; // ignorer uforståelige frames
    }

    if (data.event !== "media") {
      console.log("📨 Twilio event:", data.event);
      return;
    }

    // Ekstra sikkerhed mod tom payload
    try {
      const payloadStr = data?.media?.payload;
      if (typeof payloadStr !== "string" || !payloadStr.trim()) {
        console.warn("⚠️ Ingen gyldig payload fra Twilio – springer frame over");
        return;
      }

      let mulawAudio;
      try {
        mulawAudio = Buffer.from(payloadStr, "base64");
      } catch (err) {
        console.warn("⚠️ Kunne ikke dekode base64 fra Twilio:", err);
        return;
      }

      const pcm16 = mulaw.decode(mulawAudio);
      if (!pcm16 || !pcm16.buffer) {
        console.warn("⚠️ Decode gav ingen gyldig PCM-data");
        return;
      }

      const base64Pcm = Buffer.from(pcm16.buffer).toString("base64");
      const payload = JSON.stringify({
        type: "input_audio_buffer.append",
        audio: base64Pcm,
      });

      if (openaiReady) openaiSocket.send(payload);
      else bufferedAudio.push(payload);

      // commit lyd hvert 2,5 sek
      if (openaiReady && !twilioSocket.commitTimer) {
        twilioSocket.commitTimer = setInterval(() => {
          openaiSocket.send(JSON.stringify({ type: "input_audio_buffer.commit" }));
          openaiSocket.send(
            JSON.stringify({
              type: "response.create",
              response: {
                modalities: ["audio", "text"],
                instructions: "Svar højt med dansk stemme, ikke kun tekst.",
              },
            })
          );
        }, 2500);
      }
    } catch (err) {
      console.error("❌ Fejl i Twilio lydbehandling:", err);
    }
  });

  // ---------- OpenAI → Twilio ----------
  openaiSocket.on("message", (event) => {
    try {
      const msg = JSON.parse(event.toString());

      if (msg.type === "response.output_audio.delta" && msg.delta) {
        if (twilioSocket.readyState === WebSocket.OPEN) {
          twilioSocket.send(
            JSON.stringify({ event: "media", media: { payload: msg.delta } })
          );
        }
      }

      if (msg.type === "response.output_text.delta") {
        console.log("💬 Heino siger:", msg.delta);
      }

      if (msg.type === "response.completed" && twilioSocket.readyState === WebSocket.OPEN) {
        twilioSocket.send(JSON.stringify({ event: "mark", mark: { name: "done" } }));
      }

      if (msg.type === "response.completed" && !msg.response?.output_audio) {
        console.warn("⚠️ Heino svarede uden lyd — tjek output_audio_format og modalities");
      }
    } catch (err) {
      console.error("Fejl i OpenAI event:", err);
    }
  });

  // ---------- Oprydning ----------
  twilioSocket.on("close", () => {
    clearInterval(twilioSocket.commitTimer);
    console.log("🔕 Twilio stream closed");
    openaiSocket.close();
  });

  openaiSocket.on("close", () => console.log("🧠 OpenAI socket closed"));
  openaiSocket.on("error", (err) => console.error("OpenAI socket error:", err));
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`🚀 Server kører på port ${PORT}`));
