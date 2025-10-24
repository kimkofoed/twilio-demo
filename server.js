// server.js
require("dotenv").config();
const express = require("express");
const twilio = require("twilio");
const http = require("http");
const WebSocket = require("ws");

const app = express();
app.use(express.urlencoded({ extended: false }));
app.use(express.json());

/**
 * GET /health
 * Bruges af Render og dig selv til at tjekke, at serveren kører.
 */
app.get("/health", (req, res) => {
  res.send("OK");
});

/**
 * POST /voice
 * Twilio kalder dette endpoint, når nogen ringer til dit nummer.
 * Vi svarer med TwiML, som starter en realtime-lydstream (Media Stream)
 * til vores egen WebSocket-server.
 */
app.post("/voice", (req, res) => {
  try {
    const twiml = new twilio.twiml.VoiceResponse();

    // Twilio starter en stream til vores WebSocket-server
    const start = twiml.start();
    start.stream({
      url: `wss://${req.headers.host}/media`,
    });

    // Simpel velkomstbesked, så vi kan høre, at forbindelsen virker
    twiml.say(
      { language: "da-DK", voice: "Polly.Mads" },
      "Forbindelsen er oprettet. Du taler nu med AI-assistenten Heino!"
    );

    // Hold linjen åben lidt, så Twilio ikke lukker for hurtigt
    twiml.pause({ length: 10 });

    res.type("text/xml");
    res.send(twiml.toString());
  } catch (error) {
    console.error("Fejl i /voice route:", error);
    res.status(500).send("Internal Server Error");
  }
});

/**
 * WebSocket /media
 * Her modtager vi lyd fra Twilio og sender den videre til OpenAI Realtime API.
 */
const server = http.createServer(app);
const wss = new WebSocket.Server({ server, path: "/media" });

wss.on("connection", async (twilioSocket) => {
  console.log("🔊 Twilio stream connected");

  // Forbindelse til OpenAI Realtime API
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

    const agentPrompt = `
      Du er Heino, en venlig dansk AI-assistent.
      Du taler roligt og hjælper dem, der ringer til Jens og Kim.
      Stil et par korte, venlige spørgsmål for at forstå hvorfor de ringer.
      Når samtalen slutter, lav et kort resumé.
    `;

    const initMessage = {
      type: "session.update",
      session: { instructions: agentPrompt },
    };

    openaiSocket.send(JSON.stringify(initMessage));
  });

  // Når Twilio sender lyd
  twilioSocket.on("message", (msg) => {
    // TODO: Her skal lyd videresendes til OpenAI (senere)
    // lige nu logger vi bare, at der er aktivitet
    console.log("🎧 Modtog lyd fra Twilio");
  });

  // Når OpenAI sender svar
  openaiSocket.on("message", (data) => {
    try {
      const event = JSON.parse(data.toString());
      if (event.type === "response.output_text.delta") {
        console.log("💬 Heino siger:", event.delta);
      }
    } catch (err) {
      console.error("Fejl i OpenAI-event:", err);
    }
  });

  // Luk forbindelser pænt
  twilioSocket.on("close", () => {
    console.log("🔕 Twilio stream closed");
    openaiSocket.close();
  });

  openaiSocket.on("close", () => console.log("🧠 OpenAI socket closed"));
  openaiSocket.on("error", (err) =>
    console.error("OpenAI socket error:", err)
  );
});

// Start serveren
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`🚀 Server kører på port ${PORT}`));
