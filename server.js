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
 * Bruges af Render (og dig) til at tjekke at serveren kører.
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
  const twiml = new twilio.twiml.VoiceResponse();

  const start = twiml.start();
  // Twilio åbner en stream til vores server
  start.stream({
    url: `wss://${req.headers.host}/media`,
  });

  // fallback — hvis streaming fejler, kan den fx ringe videre til ejer
  twiml.say({ language: "da-DK", voice: "Polly.Mads" }, "Forbindelsen er oprettet. Du taler nu med AI assistenten.");
  twiml.pause({ length: 10 }); // holder linjen åben lidt tid

  res.type("text/xml");
  res.send(twiml.toString());
});

/**
 * WebSocket /media
 * Her modtager vi lyd fra Twilio (som base64-encoded chunks)
 * – lige nu logger vi bare, at der er forbindelse.
 */
const server = http.createServer(app);
const wss = new WebSocket.Server({ server, path: "/media" });

wss.on("connection", (ws) => {
  console.log("🔊 Twilio stream connected");

  ws.on("message", (msg) => {
    // Her kommer realtidslyd-data fra Twilio
    // TODO: senere – send det til OpenAI Realtime API
  });

  ws.on("close", () => console.log("❌ Twilio stream closed"));
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`🚀 Server kører på port ${PORT}`));
