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
app.get("/health", (req, res) => res.send("OK"));

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

// WebSocket-server til Twilio Media Streams
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

  // Når OpenAI socket er klar
  openaiSocket.on("open", () => {
    console.log("🧠 OpenAI Realtime API connected");
    openaiReady = true;

    // Heinos personlighed + lydformat
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
            Stil et par spørgsmål for at forstå, hvorfor de ringer, og svar med lidt humor.
          `,
        },
      })
    );

    // 👇 Send Heino et start-svar straks for test
    openaiSocket.send(
      JSON.stringify({
        type: "response.create",
        response: {
          modalities: ["audio", "text"],
          instructions: "Sig højt: 'Hej, jeg er Heino, hvordan går det?' på dansk.",
        },
      })
    );

    // Afsend evt. bufferet lyd
    bufferedAudio.forEach((chunk) => openaiSocket.send(chunk));
    bufferedAudio.length = 0;
  });

  // ---------- Twilio → OpenAI ----------
  twilioSocket.on("message", (msg) => {
    let data;
    try {
      const text = msg.toString();
      if (!text.startsWith("{")) return;
      data = JSON.parse(text);
    } catch {
      return;
    }

    if (data.event !== "media") {
      console.log("📨 Twilio event:", data.event);
      if (data.event === "stop" && openaiReady) {
        console.log("🛑 Stop event — sender commit til OpenAI");
        openaiSocket.send(JSON.stringify({ type: "input_audio_buffer.commit" }));
        openaiSocket.send(
          JSON.stringify({
            type: "response.create",
            response: {
              modalities: ["audio", "text"],
              instructions: "Svar højt og venligt på dansk, med lidt humor.",
            },
          })
        );
      }
      return;
    }

    try {
      const payloadStr = data?.media?.payload;
      if (!payloadStr) return;

      const rawAudio = Buffer.from(payloadStr, "base64");
      let pcm16;
      try {
        pcm16 = mulaw.decode(rawAudio);
      } catch {
        pcm16 = rawAudio;
      }

      const base64Pcm = Buffer.from(pcm16.buffer || pcm16).toString("base64");

      const payload = JSON.stringify({
        type: "input_audio_buffer.append",
        audio: base64Pcm,
      });

      if (openaiReady) openaiSocket.send(payload);
      else bufferedAudio.push(payload);

      // 🔁 Commit hver 2,5 sek for løbende respons
      if (openaiReady && !twilioSocket.commitTimer) {
        twilioSocket.commitTimer = setInterval(() => {
          console.log("🕑 Commit + Response trigger");
          openaiSocket.send(JSON.stringify({ type: "input_audio_buffer.commit" }));
          openaiSocket.send(
            JSON.stringify({
              type: "response.create",
              response: {
                modalities: ["audio", "text"],
                instructions: "Svar højt på dansk, med lidt humor.",
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
          console.log("🎙️ Sender lyd fra Heino til Twilio");
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
      console.error("❌ Fejl i OpenAI event:", err);
    }
  });

  // Lukning / oprydning
  twilioSocket.on("close", () => {
    clearInterval(twilioSocket.commitTimer);
    console.log("🔕 Twilio stream closed");
    openaiSocket.close();
  });

  openaiSocket.on("close", () => console.log("🧠 OpenAI socket closed"));
  openaiSocket.on("error", (err) => console.error("OpenAI socket error:", err));
});

// Start server
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`🚀 Server kører på port ${PORT}`));