// server.js
require("dotenv").config();
const express = require("express");
const twilio = require("twilio");
const http = require("http");
const WebSocket = require("ws");
const fetch = require("node-fetch");

const app = express();
app.use(express.json({ limit: "5mb" }));
app.use(express.urlencoded({ extended: true }));

// Health check
app.get("/health", (req, res) => res.send("OK ✅"));

// 🔍 Test din OpenAI key direkte
app.get("/test-key", async (req, res) => {
  try {
    console.log("🔑 Tester OpenAI API-key mod /models ...");
    const response = await fetch("https://api.openai.com/v1/models", {
      headers: { Authorization: `Bearer ${process.env.OPENAI_API_KEY}` },
    });
    const text = await response.text();
    console.log("📦 Svar fra OpenAI:", text.slice(0, 200) + "...");
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
    "Forbindelsen er oprettet. Du taler nu med AI-assistenten Heino!"
  );
  twiml.pause({ length: 120 });
  res.type("text/xml");
  res.send(twiml.toString());
});

// 🎧 WebSocket: Twilio ↔ OpenAI
const server = http.createServer(app);
const wss = new WebSocket.Server({ server, path: "/media" });

wss.on("connection", (twilioSocket) => {
  console.log("🔊 Twilio stream connected");

  // Opret realtime forbindelse til OpenAI
  console.log("🔌 Forbinder til OpenAI Realtime via gpt-audio ...");
  const openaiSocket = new WebSocket(
    "wss://api.openai.com/v1/realtime?model=gpt-4o-mini-realtime-preview-2024-12-17",
    {
      headers: {
        Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
        "OpenAI-Beta": "realtime=v1",
      },
    }
  );

  let openaiReady = false;
  const audioBuffer = [];

  openaiSocket.on("open", () => {
    console.log("🧠 OpenAI Realtime API connected!");
    openaiReady = true;

    // Start session
    const sessionMsg = {
      type: "session.update",
      session: {
        modalities: ["audio", "text"],
        voice: "alloy",
        instructions: `
          Du er Heino, en sjov og venlig dansk AI-assistent.
          Du taler afslappet og hjælper dem, der ringer til Jens og Kim.
          Stil et par spørgsmål for at forstå, hvorfor de ringer, og svar med lidt humor.
          Svar højt og tydeligt.
        `,
      },
    };
    console.log("📤 Sender session.update → OpenAI");
    openaiSocket.send(JSON.stringify(sessionMsg));

    // Velkomstbesked
    console.log("📤 Beder Heino sige velkomst...");
    openaiSocket.send(
      JSON.stringify({
        type: "response.create",
        response: {
          modalities: ["audio", "text"],
          instructions: "Sig højt: 'Hej, jeg er Heino! Hvad så, hvordan går det?'",
        },
      })
    );

    // Send bufferet data, hvis noget
    if (audioBuffer.length > 0) {
      console.log(`📤 Sender ${audioBuffer.length} bufferede lyd-chunks`);
      audioBuffer.forEach((chunk) => openaiSocket.send(chunk));
      audioBuffer.length = 0;
    }
  });

  openaiSocket.on("error", (err) => {
    console.error("💥 OpenAI socket error:", err.message);
  });

  openaiSocket.on("close", (code, reason) => {
    console.warn("⚠️ OpenAI socket closed:", code, reason.toString());
  });

  // 🔁 Twilio → OpenAI
  twilioSocket.on("message", (msg) => {
    try {
      const text = msg.toString();
      if (!text.startsWith("{")) return;
      const data = JSON.parse(text);

      if (data.event !== "media") {
        console.log("📨 Twilio event:", data.event);
        if (data.event === "stop") {
          console.log("🛑 Stop event modtaget — afslutter commit");
          if (openaiReady) {
            openaiSocket.send(JSON.stringify({ type: "input_audio_buffer.commit" }));
            openaiSocket.send(
              JSON.stringify({
                type: "response.create",
                response: {
                  modalities: ["audio", "text"],
                  instructions: "Afslut samtalen med et venligt dansk farvel.",
                },
              })
            );
          }
        }
        return;
      }

      if (!data.media?.payload) {
        console.warn("⚠️ Modtog media-event uden payload");
        return;
      }

      console.log(`🎧 Modtog lydchunk (${data.media.payload.length} bytes)`);

      const payload = JSON.stringify({
        type: "input_audio_buffer.append",
        audio: data.media.payload, // Twilio sender base64 PCM16
      });

      if (openaiReady) openaiSocket.send(payload);
      else audioBuffer.push(payload);

      // 🔁 auto commit hvert 3. sekund
      if (openaiReady && !twilioSocket.commitTimer) {
        twilioSocket.commitTimer = setInterval(() => {
          console.log("🕑 Commit + response.create trigger");
          openaiSocket.send(JSON.stringify({ type: "input_audio_buffer.commit" }));
          openaiSocket.send(
            JSON.stringify({
              type: "response.create",
              response: {
                modalities: ["audio", "text"],
                instructions: `
                  Du er Heino, en sjov dansk AI-assistent.
                  Reager på det, du hører, med venlige, sjove og naturlige svar.
                `,
              },
            })
          );
        }, 3000);
      }
    } catch (err) {
      console.error("💥 Fejl i Twilio → OpenAI håndtering:", err);
    }
  });

  // 🔁 OpenAI → Twilio
  openaiSocket.on("message", (event) => {
    try {
      const msg = JSON.parse(event.toString());

      if (msg.type === "response.output_audio.delta") {
        console.log("🎙️ Heino sender lyd tilbage!");
        if (twilioSocket.readyState === WebSocket.OPEN) {
          twilioSocket.send(
            JSON.stringify({ event: "media", media: { payload: msg.delta } })
          );
        }
      }

      if (msg.type === "response.output_text.delta") {
        console.log("💬 Heino siger:", msg.delta);
      }

      if (msg.type === "response.completed") {
        console.log("✅ OpenAI response færdig!");
        if (twilioSocket.readyState === WebSocket.OPEN) {
          twilioSocket.send(JSON.stringify({ event: "mark", mark: { name: "done" } }));
        }
      }
    } catch (err) {
      console.error("💥 Fejl i OpenAI → Twilio håndtering:", err);
    }
  });

  twilioSocket.on("close", () => {
    clearInterval(twilioSocket.commitTimer);
    console.log("🔕 Twilio stream closed");
    if (openaiSocket.readyState === WebSocket.OPEN) openaiSocket.close();
  });
});

// 🚀 Start server
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`🚀 Server kører på port ${PORT}`));
