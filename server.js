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
  twiml.pause({ length: 120 }); // holder linjen åben i 2 minutter
  res.type("text/xml").send(twiml.toString());
});

const server = http.createServer(app);
const wss = new WebSocket.Server({ server, path: "/media" });

wss.on("connection", (twilioSocket) => {
  console.log("🔊 Twilio stream connected");

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

    // Start Heino-sessionen
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
            Stil spørgsmål og svar med humor på dansk.
          `,
        },
      })
    );

    bufferedAudio.forEach((chunk) => openaiSocket.send(chunk));
    bufferedAudio.length = 0;
  });

  // ---------- Twilio → OpenAI ----------
  twilioSocket.on("message", (msg) => {
    try {
      const data = JSON.parse(msg.toString());

      // Vi ignorerer events uden gyldig lydpayload
      if (data.event !== "media" || !data.media || typeof data.media.payload !== "string") {
        return;
      }

      // Konverter μ-law fra Twilio → PCM16 → base64
      const mulawAudio = Buffer.from(data.media.payload, "base64");
      const pcm16 = mulaw.decode(mulawAudio);
      const base64Pcm = Buffer.from(pcm16.buffer).toString("base64");

      const payload = JSON.stringify({
        type: "input_audio_buffer.append",
        audio: base64Pcm,
      });

      if (openaiReady) openaiSocket.send(payload);
      else bufferedAudio.push(payload);

      // Commit og bed om svar løbende
      if (openaiReady && !twilioSocket.commitTimer) {
        twilioSocket.commitTimer = setInterval(() => {
          openaiSocket.send(JSON.stringify({ type: "input_audio_buffer.commit" }));
          openaiSocket.send(
            JSON.stringify({
              type: "response.create",
              response: {
                modalities: ["audio", "text"],
                instructions:
                  "Svar højt med dansk tale, ikke kun tekst. Brug en venlig og sjov tone.",
              },
            })
          );
        }, 2500);
      }
    } catch (err) {
      console.error("Fejl i Twilio data:", err);
    }
  });

  // ---------- OpenAI → Twilio ----------
  openaiSocket.on("message", (event) => {
    try {
      const msg = JSON.parse(event.toString());

      if (msg.type === "response.output_audio.delta") {
        if (!msg.delta || typeof msg.delta !== "string") {
          // spring tomme events over
          return;
        }

        if (twilioSocket.readyState === WebSocket.OPEN) {
          twilioSocket.send(
            JSON.stringify({
              event: "media",
              media: { payload: msg.delta },
            })
          );
        }
      }

      if (msg.type === "response.output_text.delta") {
        console.log("💬 Heino siger:", msg.delta);
      }

      if (msg.type === "response.completed" && twilioSocket.readyState === WebSocket.OPEN) {
        twilioSocket.send(JSON.stringify({ event: "mark", mark: { name: "done" } }));
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
