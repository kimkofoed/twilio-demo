const express = require("express");
const twilio = require("twilio");

const app = express();
app.use(express.urlencoded({ extended: false }));

// Dette endpoint håndterer opkald
app.post("/voice", (req, res) => {
  const twiml = new twilio.twiml.VoiceResponse();

  // Simpel dansk hilsen som demo
  twiml.say(
    { language: "da-DK", voice: "Polly.Mads" },
    "Hej! Du har ringet til Jens og Kim! Hvad fanden vil du os?"
  );

  res.type("text/xml");
  res.send(twiml.toString());
});

// Simpelt test-endpoint
app.get("/", (req, res) => {
  res.send("Twilio-demoen kører");
});

// Start serveren
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server kører på port ${PORT}`));
