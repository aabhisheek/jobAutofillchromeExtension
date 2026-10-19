// Entry point. `node server/index.js` starts the sign-in backend.
//
// Reads everything from the environment (see config.js), so the same command
// runs locally and on a host.

const http = require("node:http");
const { loadConfig } = require("./config.js");
const { createApp } = require("./app.js");

const config = loadConfig();
const server = http.createServer(createApp({ config }));

server.listen(config.port, config.host, () => {
  console.log(`[cloud] sign-in server listening on http://${config.host}:${config.port}`);
  console.log(`[cloud] verifying Google tokens for client ${config.googleClientId}`);
});
