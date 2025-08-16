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

if (
  !DEEPGRAM_API_KEY ||
  !TWILIO_ACCOUNT_SID ||
  !TWILIO_AUTH_TOKEN ||
  !TWILIO_PHONE_NUMBER
) {
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

  if (!number) {
    return reply.code(400).send({ error: "Phone number is required" });
  }

  try {
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

fastify.register(async instance => {
  instance.get("/outbound-media-stream", { websocket: true }, (ws, req) => {
    console.info("Twilio connected to media stream");

    let streamSid = null;
    let customParameters = {};
    let deepgramWs = null;
    let keepAliveInterval = null;

    const closeDeepgram = () => {
      if (deepgramWs) {
        deepgramWs.close();
        deepgramWs = null;
      }
      if (keepAliveInterval) {
        clearInterval(keepAliveInterval);
        keepAliveInterval = null;
      }
    };

    const openDeepgram = () => {
      deepgramWs = new WebSocket("wss://agent.deepgram.com/v1/agent/converse", {
        headers: { Authorization: `Token ${DEEPGRAM_API_KEY}` },
      });

      deepgramWs.on("open", () => {
        console.log("[Deepgram] Connected");

        const userPrompt = customParameters.prompt?.trim() || "You are a helpful assistant.";

        // --- FIXED SETTINGS MESSAGE BASED ON LATEST DEEPGRAM DOCS ---
        const settings = {
          type: "Settings",
          audio: {
            input: { encoding: "base64", sample_rate: 8000 },
            output: { encoding: "base64", sample_rate: 8000 },
          },
          agent: {
            language: "en-US",
            // The `listen` object requires a `provider` object.
            listen: {
              provider: {
                type: "deepgram",
                model: "nova-2",
              },
            },
            // The `think` and `speak` models can be direct properties when using
            // Deepgram's internal LLM and TTS models.
            think: {
              model: "gpt-4",
              prompt: userPrompt,
            },
            speak: {
              model: "aura-2-thalia-en"
            }
          },
        };

        deepgramWs.send(JSON.stringify(settings));

        if (typeof customParameters.first_message === "string" && customParameters.first_message.trim()) {
          deepgramWs.send(
            JSON.stringify({
              type: "Utterance",
              text: customParameters.first_message.trim(),
            })
          );
        }

        keepAliveInterval = setInterval(() => {
          deepgramWs.send(JSON.stringify({ type: "KeepAlive" }));
        }, 20000);
      });

      deepgramWs.on("message", data => {
        try {
          const msg = JSON.parse(data);

          switch (msg.type) {
            case "Utterance":
              console.log("[Deepgram] Conversation Text:", msg.text);
              break;
            case "AgentAudio":
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
            case "AgentThinking":
              console.log("[Deepgram] Thinking...");
              break;
            case "Error":
              console.error("[Deepgram] Error:", msg.message || msg.description || "No error message provided");
              ws.close();
              closeDeepgram();
              break;
          }
        } catch (err) {
          console.error("[Deepgram] Invalid JSON:", err);
        }
      });

      deepgramWs.on("error", err => {
        console.error("[Deepgram] WebSocket error:", err);
        ws.close();
        closeDeepgram();
      });

      deepgramWs.on("close", () => {
        console.log("[Deepgram] Disconnected");
        clearInterval(keepAliveInterval);
      });
    };

    ws.on("error", err => {
      console.error("[Twilio] WebSocket error:", err);
      closeDeepgram();
    });

    ws.on("message", message => {
      try {
        const msg = JSON.parse(message);

        if (msg.event === "start") {
          streamSid = msg.start.streamSid;
          customParameters = msg.start.customParameters || {};
          console.log("Stream started:", streamSid, customParameters);
          openDeepgram();
        } else if (msg.event === "media") {
          if (deepgramWs && deepgramWs.readyState === WebSocket.OPEN) {
            deepgramWs.send(
              JSON.stringify({
                type: "Audio",
                audio: { payload: msg.media.payload },
              })
            );
          }
        } else if (msg.event === "stop") {
          console.log("Stream stopped:", streamSid);
          closeDeepgram();
        }
      } catch (err) {
        console.error("Error processing Twilio msg:", err);
      }
    });

    ws.on("close", () => {
      console.log("Twilio WS closed");
      closeDeepgram();
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
