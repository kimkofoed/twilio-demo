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

// ---------- Twilio webhook ----------
app.post("/voice", (req, res) => {
  const twiml = new twilio.twiml.VoiceResponse();

  const start = twiml.start();
  start.stream({
    url: `wss://${req.headers.host}/media`,
    track: "inbound_track",
    name: "heino_stream",
    parameters: {
      codec: "audio/x-wav", // 👈 lad Twilio sende rå PCM (ikke mulaw)
      samplingRate: "8000",
    },
  });

  twiml.say(
    { language: "da-DK", voice: "Polly.Mads" },
    "Forbindelsen er oprettet. Du taler nu med AI-assistenten Heino!"
  );

  // holder linjen åben i 2 minutter
  twiml.pause({ length: 120 });

  res.type("text/xml");
  res.send(twiml.toString());
});

// ---------- WebSocket Twilio ↔ OpenAI ----------
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

    openaiSocket.send(
      JSON.stringify({
        type: "session.update",
        session: {
          modalities: ["audio", "text"],
          voice: "alloy",
          input_audio_format: "pcm16",
          output_audio_format: "mulaw",
          instructions: `
            Du er Heino, en sjov og venlig dansk AI-assistent.
            Du taler afslappet og hjælper dem, der ringer til Jens og Kim.
            Stil et par spørgsmål for at forstå dem og svar med lidt humor.
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
      if (!text.startsWith("{")) return;
      data = JSON.parse(text);
    } catch {
      return;
    }

    if (data.event !== "media") {
      console.log("📨 Twilio event:", data.event);
      return;
    }

    try {
      const payloadStr = data?.media?.payload;
      if (!payloadStr) return;

      const rawAudio = Buffer.from(payloadStr, "base64");
      console.log("🎧 Twilio payload:", rawAudio.length, "bytes");

      // prøv først at decode som μ-law, ellers brug rå PCM
      let pcm16;
      try {
        pcm16 = mulaw.decode(rawAudio);
        if (!pcm16 || !pcm16.buffer) throw new Error("not mulaw");
      } catch {
        pcm16 = rawAudio; // behandle som PCM16 direkte
      }

      const base64Pcm = Buffer.from(pcm16.buffer || pcm16).toString("base64");

      const payload = JSON.stringify({
        type: "input_audio_buffer.append",
        audio: base64Pcm,
      });

      if (openaiReady) openaiSocket.send(payload);
      else bufferedAudio.push(payload);

      if (openaiReady && !twilioSocket.commitTimer) {
        twilioSocket.commitTimer = setInterval(() => {
          openaiSocket.send(JSON.stringify({ type: "input_audio_buffer.commit" }));
          openaiSocket.send(
            JSON.stringify({
              type: "response.create",
              response: {
                modalities: ["audio", "text"],
                instructions: "Svar højt på dansk med lyd, ikke kun tekst.",
              },
            })
          );
        }, 2500);
      }
    } catch (err) {
      console.error("❌ Fejl i Twilio lydbehandling:", err);
    }
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
            instructions: "Svar højt på dansk, med lidt humor.",
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
      if (!pcm16 || !pcm16.buffer) throw new Error("not mulaw");
    } catch {
      pcm16 = rawAudio; // PCM16 direkte
    }

    const base64Pcm = Buffer.from(pcm16.buffer || pcm16).toString("base64");

    const payload = JSON.stringify({
      type: "input_audio_buffer.append",
      audio: base64Pcm,
    });

    if (openaiReady) openaiSocket.send(payload);
    else bufferedAudio.push(payload);

    // 🔁 Commit regelmæssigt hvert 2,5 sek.
    if (openaiReady && !twilioSocket.commitTimer) {
      twilioSocket.commitTimer = setInterval(() => {
        console.log("🕑 Commit + Response trigger");
        openaiSocket.send(JSON.stringify({ type: "input_audio_buffer.commit" }));
        openaiSocket.send(
          JSON.stringify({
            type: "response.create",
            response: {
              modalities: ["audio", "text"],
              instructions: "Svar højt og venligt på dansk.",
            },
          })
        );
      }, 2500);
    }
  } catch (err) {
    console.error("❌ Fejl i Twilio lydbehandling:", err);
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

// ---------- Server ----------
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`🚀 Server kører på port ${PORT}`));