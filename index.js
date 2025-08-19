// index.js
const Fastify = require("fastify");
const fastify = Fastify({ logger: true });

fastify.addHook("preHandler", async (request, reply) => {
  reply.header("Access-Control-Allow-Origin", "*");
  reply.header(
    "Access-Control-Allow-Methods",
    "GET, POST, PUT, DELETE, OPTIONS"
  );
  reply.header(
    "Access-Control-Allow-Headers",
    "Origin, X-Requested-With, Content-Type, Accept, Authorization"
  );

  // OPTIONS 요청 처리
  if (request.method === "OPTIONS") {
    reply.status(200).send();
    return;
  }
});

fastify.get("/", async () => ({ ok: true, msg: "DF Recommend MVP" }));

// 기존 /enchants/* 라우트를 쓰지 않을 거면 주석 처리하고,
// 통합 recommend 라우트만 등록하면 됩니다.
fastify.register(require("./routes/recommend"));

fastify
  .listen({ port: process.env.PORT || 3000, host: "0.0.0.0" })
  .then(() => fastify.log.info("Server listening"))
  .catch((err) => {
    fastify.log.error(err);
    process.exit(1);
  });
