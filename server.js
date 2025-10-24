// server.js
require("dotenv").config();
const express = require("express");
const twilio = require("twilio");
const http = require("http");
const WebSocket = require("ws");
const { Buffer } = require("buffer");
const mulaw = require("mulaw-js");
const fetch = require("node-fetch");

const app = express();
app.use(express.json({ limit: "5mb" }));
app.use(express.urlencoded({ extended: true }));

// Health check
app.get("/health", (req, res) => res.send("OK"));

/**
 * 🧪 Test OpenAI-nøgle direkte på Render
 * Gå til: https://<dit-render-navn>.onrender.com/test-key
 */
app.get("/test-key", async (req, res) => {
  try {
    const response = await fetch("https://api.openai.com/v1/models", {
      headers: { Authorization: `Bearer ${process.env.OPENAI_API_KEY}` },
    });
    const text = await response.text();

    if (response.ok) {
      console.log("✅ OpenAI key virker!");
      res.type("application/json").send(text);
    } else {
      console.error("❌ OpenAI key test fejlede:", text);
      res.status(response.status).json({ error: "Key test failed", details: text });
    }
  } catch (err) {
    console.error("Fejl under OpenAI test:", err);
    res.status(500).json({ error: err.message });
  }
});

/**
 * 📞 Twilio webhook → starter Media Stream
 */
app.post("/voice", (req, res) => {
  const twiml = new twilio.twiml.VoiceResponse();
  const start = twiml.start();
  start.stream({ url: `wss://${req.headers.host}/media` });

  twiml.say(
    { language: "da-DK", voice: "Polly.Mads" },
    "Forbindelsen er oprettet. Du taler nu med AI-assistenten Heino!"
  );

  twiml.pause({ length: 120 }); // holder linjen åben i 2 min
  res.type("text/xml");
  res.send(twiml.toString());
});

// WebSocket-server (Twilio ↔ OpenAI)
const server = http.createServer(app);
const wss = new WebSocket.Server({ server, path: "/media" });

wss.on("connection", (twilioSocket) => {
  console.log("🔊 Twilio stream connected");

  const openaiSocket = new WebSocket(
    "wss://api.openai.com/v1/realtime?model=gpt-4o-audio-preview-2024-10-01",
    {
      headers: {
        Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
        "OpenAI-Beta": "realtime=v1",
        "Sec-WebSocket-Protocol": "realtime", // 👈 vigtig header!
      },
    }
  );

  let openaiReady = false;
  const bufferedAudio = [];

  // Når OpenAI-socket åbner
  openaiSocket.on("open", () => {
    console.log("🧠 OpenAI Realtime API connected");
    openaiReady = true;

    // Konfigurer Heino-sessionen
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
            Stil et par spørgsmål for at forstå, hvorfor de ringer, og svar med lidt humor.
          `,
        },
      })
    );

    // Start med en velkomst
    openaiSocket.send(
      JSON.stringify({
        type: "response.create",
        response: {
          modalities: ["audio", "text"],
          instructions: "Sig højt: 'Hej, jeg er Heino. Hvordan går det?' på dansk.",
        },
      })
    );

    bufferedAudio.forEach((chunk) => openaiSocket.send(chunk));
    bufferedAudio.length = 0;
  });

  // ---------- Twilio → OpenAI ----------
  twilioSocket.on("message", (msg) => {
    try {
      const text = msg.toString();
      if (!text.startsWith("{")) return;
      const data = JSON.parse(text);

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
                instructions:
                  "Svar højt og venligt på dansk med lidt humor.",
              },
            })
          );
        }
        return;
      }

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

      if (openaiReady && !twilioSocket.commitTimer) {
        twilioSocket.commitTimer = setInterval(() => {
          console.log("🕑 Commit + Response trigger");
          openaiSocket.send(
            JSON.stringify({ type: "input_audio_buffer.commit" })
          );
          openaiSocket.send(
            JSON.stringify({
              type: "response.create",
              response: {
                modalities: ["audio", "text"],
                instructions: `
                  Du er Heino, en venlig dansk AI-assistent.
                  Du hører hvad der bliver sagt, og svarer højt og tydeligt på dansk.
                  Brug en afslappet og sjov tone. Hvis du ikke hører noget tydeligt, sig: "Jeg hørte dig ikke helt, kan du gentage det?"
                `,
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

      if (
        msg.type === "response.completed" &&
        twilioSocket.readyState === WebSocket.OPEN
      ) {
        twilioSocket.send(
          JSON.stringify({ event: "mark", mark: { name: "done" } })
        );
      }
    } catch (err) {
      console.error("❌ Fejl i OpenAI event:", err);
    }
  });

  // Lukning
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
