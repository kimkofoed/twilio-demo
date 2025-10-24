// server.js
require("dotenv").config();
const express = require("express");
const twilio = require("twilio");
const http = require("http");
const WebSocket = require("ws");
const { Buffer } = require("buffer");

const app = express();
app.use(express.urlencoded({ extended: false }));
app.use(express.json());

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
  twiml.pause({ length: 60 }); // hold linjen åben

  res.type("text/xml");
  res.send(twiml.toString());
});

// Media WebSocket: Twilio ↔ OpenAI
const server = http.createServer(app);
const wss = new WebSocket.Server({ server, path: "/media" });

wss.on("connection", (twilioSocket) => {
  console.log("🔊 Twilio stream connected");

  // Forbind til OpenAI Realtime API
  const openaiSocket = new WebSocket(
    "wss://api.openai.com/v1/realtime?model=gpt-4o-realtime-preview-2024-10-01",
    {
      headers: {
        Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
        "OpenAI-Beta": "realtime=v1",
      },
    }
  );

  openaiSocket.on("open", () => {
    console.log("🧠 OpenAI Realtime API connected");
    openaiSocket.send(
      JSON.stringify({
        type: "session.update",
        session: {
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
  });

  // Når Twilio sender lyd → send det til OpenAI
  twilioSocket.on("message", (msg) => {
    const data = JSON.parse(msg.toString());
    if (data.event === "media") {
      // Twilio sender base64 mu-law lyd
      const mulawAudio = Buffer.from(data.media.payload, "base64");
      // Send som base64 PCM til OpenAI (OpenAI håndterer formatet via "input_audio_buffer.append")
      openaiSocket.send(
        JSON.stringify({
          type: "input_audio_buffer.append",
          audio: mulawAudio.toString("base64"),
        })
      );
    } else if (data.event === "stop") {
      openaiSocket.send(JSON.stringify({ type: "input_audio_buffer.commit" }));
      openaiSocket.send(JSON.stringify({ type: "response.create" }));
    }
  });

  // Når OpenAI sender svar → send lyd tilbage til Twilio
  openaiSocket.on("message", (event) => {
    try {
      const msg = JSON.parse(event.toString());

      // Når OpenAI sender lydchunks tilbage
      if (msg.type === "response.output_audio.delta" && msg.delta) {
        twilioSocket.send(
          JSON.stringify({
            event: "media",
            media: { payload: msg.delta },
          })
        );
      }

      if (msg.type === "response.completed") {
        twilioSocket.send(JSON.stringify({ event: "mark", mark: { name: "done" } }));
      }

      // Tekst til debugging i Render logs
      if (msg.type === "response.output_text.delta") {
        console.log("💬 Heino siger:", msg.delta);
      }
    } catch (err) {
      console.error("Fejl i OpenAI event:", err);
    }
  });

  // Luk pænt ned
  twilioSocket.on("close", () => {
    console.log("🔕 Twilio stream closed");
    openaiSocket.close();
  });

  openaiSocket.on("close", () => console.log("🧠 OpenAI socket closed"));
  openaiSocket.on("error", (err) => console.error("OpenAI socket error:", err));
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`🚀 Server kører på port ${PORT}`));
