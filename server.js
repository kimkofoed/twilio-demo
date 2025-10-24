// server.js
require("dotenv").config();
const express = require("express");
const twilio = require("twilio");
const http = require("http");
const WebSocket = require("ws");
const { Buffer } = require("buffer");
const mulaw = require("mulaw-js"); // ← konvertering mellem PCM16 ↔ μ-law

const app = express();
app.use(express.json({ limit: "5mb" }));
app.use(express.urlencoded({ extended: true }));

// Health check
app.get("/health", (req, res) => res.send("OK"));

// Voice webhook (Twilio → Render)
app.post("/voice", (req, res) => {
  const twiml = new twilio.twiml.VoiceResponse();
  const start = twiml.start();
  start.stream({ url: `wss://${req.headers.host}/media` });

  twiml.say(
    { language: "da-DK", voice: "Polly.Mads" },
    "Forbindelsen er oprettet. Du taler nu med AI-assistenten Heino!"
  );
  twiml.pause({ length: 180 }); // holder linjen åben i 3 min

  res.type("text/xml");
  res.send(twiml.toString());
});

// Media WebSocket: Twilio ↔ OpenAI
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

    // Heinos personlighed + aktiver lydoutput
    openaiSocket.send(
      JSON.stringify({
        type: "session.update",
        session: {
          modalities: ["audio", "text"],
          voice: "alloy",
          input_audio_format: "pcm16",
          output_audio_format: "pcm16", // modtag ukomprimeret lyd
          instructions: `
            Du er Heino, en sjov, venlig dansk AI-assistent.
            Du taler afslappet og hjælper dem, der ringer til Jens og Kim.
            Stil et par spørgsmål for at forstå, hvorfor de ringer, og svar med lidt humor.
          `,
        },
      })
    );

    bufferedAudio.forEach((chunk) => openaiSocket.send(chunk));
    bufferedAudio.length = 0;
  });

  // Twilio → OpenAI
  twilioSocket.on("message", (msg) => {
    const data = JSON.parse(msg.toString());
    if (data.event === "media") {
      // Twilio sender μ-law lyd → send til OpenAI som base64 PCM16
      const mulawAudio = Buffer.from(data.media.payload, "base64");
      const pcm16 = mulaw.decode(mulawAudio);
      const base64Pcm = Buffer.from(pcm16.buffer).toString("base64");

      const payload = JSON.stringify({
        type: "input_audio_buffer.append",
        audio: base64Pcm,
      });

      if (openaiReady) openaiSocket.send(payload);
      else bufferedAudio.push(payload);

      // Commit hvert par sekunder (løbende realtid)
      if (openaiReady && !twilioSocket.commitTimer) {
        twilioSocket.commitTimer = setInterval(() => {
          openaiSocket.send(JSON.stringify({ type: "input_audio_buffer.commit" }));
          openaiSocket.send(JSON.stringify({ type: "response.create" }));
        }, 2500);
      }
    } else if (data.event === "stop") {
      if (openaiReady) {
        openaiSocket.send(JSON.stringify({ type: "input_audio_buffer.commit" }));
        openaiSocket.send(JSON.stringify({ type: "response.create" }));
      }
    }
  });

  // OpenAI → Twilio
  openaiSocket.on("message", (event) => {
    try {
      const msg = JSON.parse(event.toString());

      if (msg.type === "response.output_audio.delta" && msg.delta) {
        // OpenAI sender PCM16 → konverter til μ-law før vi sender til Twilio
        const pcmBuffer = Buffer.from(msg.delta, "base64");
        const pcm16Array = new Int16Array(
          pcmBuffer.buffer,
          pcmBuffer.byteOffset,
          pcmBuffer.length / 2
        );
        const mulawEncoded = mulaw.encode(pcm16Array);
        const base64Mulaw = Buffer.from(mulawEncoded).toString("base64");

        // Send lyd tilbage til Twilio
        if (twilioSocket.readyState === WebSocket.OPEN) {
          twilioSocket.send(
            JSON.stringify({
              event: "media",
              media: { payload: base64Mulaw },
            })
          );
        }
      }

      // Debug: tekst i Render logs
      if (msg.type === "response.output_text.delta") {
        console.log("💬 Heino siger:", msg.delta);
      }

      if (msg.type === "response.completed") {
        if (twilioSocket.readyState === WebSocket.OPEN) {
          twilioSocket.send(
            JSON.stringify({ event: "mark", mark: { name: "done" } })
          );
        }
      }
    } catch (err) {
      console.error("Fejl i OpenAI event:", err);
    }
  });

  // Luk og oprydning
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
