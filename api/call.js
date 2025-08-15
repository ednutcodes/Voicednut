const Fastify = require("fastify");
const WebSocket = require("ws");
const dotenv = require("dotenv");
const fastifyFormBody = require("@fastify/formbody");
const fastifyWs = require("@fastify/websocket");
const Twilio = require("twilio");

dotenv.config();

const {
  DEEPGRAM_API_KEY,
  TWILIO_ACCOUNT_SID,
  TWILIO_AUTH_TOKEN,
  TWILIO_PHONE_NUMBER,
} = process.env;

if (!DEEPGRAM_API_KEY || !TWILIO_ACCOUNT_SID || !TWILIO_AUTH_TOKEN || !TWILIO_PHONE_NUMBER) {
  console.error("Missing required environment variables");
  throw new Error("Missing required environment variables");
}

const fastify = Fastify({ logger: true });
fastify.register(fastifyFormBody);
fastify.register(fastifyWs);

const twilioClient = new Twilio(TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN);
const PORT = process.env.PORT || 8000;

fastify.get("/", async (_, reply) => reply.send({ message: "Server is running" }));

fastify.post("/outbound-call", async (request, reply) => {
  const { number, prompt, first_message } = request.body;

  if (!number) return reply.code(400).send({ error: "Phone number is required" });

  try {
    // Twilio API: https://www.twilio.com/docs/voice/api/call-resource#make-an-outbound-call
    const call = await twilioClient.calls.create({
      from: TWILIO_PHONE_NUMBER,
      to: number,
      url: `https://${request.headers.host}/outbound-call-twiml?prompt=${encodeURIComponent(
        prompt || ""
      )}&first_message=${encodeURIComponent(first_message || "")}`,
    });

    reply.send({ success: true, message: "Call initiated", callSid: call.sid });
  } catch (err) {
    console.error("Error initiating outbound call:", err);
    reply.code(500).send({ success: false, error: "Failed to initiate call" });
  }
});

fastify.all("/outbound-call-twiml", async (req, reply) => {
  const prompt = req.query.prompt || "";
  const first_message = req.query.first_message || "";

  // Twilio expects valid TwiML
  const twiml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Connect>
    <Stream url="wss://${req.headers.host}/outbound-media-stream">
      <Parameter name="prompt" value="${prompt}" />
      <Parameter name="first_message" value="${first_message}" />
    </Stream>
  </Connect>
</Response>`;

  reply.type("text/xml").send(twiml);
});

// Deepgram Voice Agent API: https://developers.deepgram.com/docs/voice-agent-api
fastify.register(async instance => {
  instance.get("/outbound-media-stream", { websocket: true }, (ws, req) => {
    console.info("Twilio connected to media stream");

    let streamSid = null;
    let customParameters = {};
    let deepgramWs = null;
    let keepAliveInterval = null;

    const openDeepgram = async () => {
      deepgramWs = new WebSocket("wss://agent.deepgram.com/v1/agent/converse", {
        headers: { Authorization: `Token ${DEEPGRAM_API_KEY}` },
      });

      deepgramWs.on("open", () => {
        console.log("[Deepgram] Connected");

        // Only use prompt for instructions, fallback to default if missing
        let instructions = "You are a helpful assistant.";
        if (typeof customParameters.prompt === "string" && customParameters.prompt.trim()) {
          instructions = customParameters.prompt.trim();
        }

        const settings = {
          type: "Settings",
          audio: {
            input: { encoding: "base64", sample_rate: 8000 },
            output: { encoding: "base64", sample_rate: 8000 },
          },
          agent: {
            instructions,
            listen_model: "nova",
            think_model: "gpt-4",
            speak_model: "aura"
          },
        };

        deepgramWs.send(JSON.stringify(settings));

        keepAliveInterval = setInterval(() => {
          deepgramWs.send(JSON.stringify({ type: "KeepAlive" }));
        }, 20000);
      });

      deepgramWs.on("message", data => {
        let msg;
        try {
          msg = JSON.parse(data);
        } catch (err) {
          console.error("[Deepgram] Invalid JSON:", err);
          return;
        }

        switch (msg.type) {
          case "AgentStartedSpeaking":
          case "AgentAudioDone":
            if (msg.audio?.payload) {
              ws.send(
                JSON.stringify({
                  event: "media",
                  streamSid,
                  media: { payload: msg.audio.payload },
                })
              );
            }
            break;
          case "ConversationText":
            console.log("[Deepgram] Text:", msg.text);
            break;
          case "AgentThinking":
            console.log("[Deepgram] Thinking...");
            break;
          case "Error":
            // Improved error logging
            console.error("[Deepgram] Error object:", msg);
            console.error("[Deepgram] Error:", msg.message || msg.description || "No error message provided");
            break;
        }
      });

      deepgramWs.on("error", err => {
        console.error("[Deepgram] WebSocket error:", err);
      });

      deepgramWs.on("close", () => {
        console.log("[Deepgram] Disconnected");
        clearInterval(keepAliveInterval);
      });
    };

    openDeepgram();

    ws.on("error", console.error);

    ws.on("message", message => {
      try {
        const msg = JSON.parse(message);

        if (msg.event === "start") {
          streamSid = msg.start.streamSid;
          customParameters = msg.start.customParameters || {};
          console.log("Stream started:", streamSid, customParameters);
        } else if (msg.event === "media") {
          if (deepgramWs && deepgramWs.readyState === WebSocket.OPEN) {
            deepgramWs.send(
              JSON.stringify({
                type: "Speak",
                audio: { payload: msg.media.payload },
              })
            );
          }
        } else if (msg.event === "stop") {
          console.log("Stream stopped:", streamSid);
          if (deepgramWs) deepgramWs.close();
        }
      } catch (err) {
        console.error("Error processing Twilio msg:", err);
      }
    });

    ws.on("close", () => {
      console.log("Twilio WS closed");
      if (deepgramWs) deepgramWs.close();
    });
  });
});

fastify.listen({ port: PORT, host: "0.0.0.0" }, err => {
  if (err) {
    console.error(err);
    process.exit(1);
  }
  console.log(`Listening on port ${PORT}`);
});
