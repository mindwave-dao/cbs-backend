import { applyCors } from "../lib/cors.js";

export default function handler(req, res) {
  if (applyCors(req, res)) return;

  res.status(200).json({
    status: "ok",
    service: "NILA API",
    version: "2.0",
    timestamp: new Date().toISOString()
  });
}
