import { applyCors } from "../lib/cors.js";

export default function handler(req, res) {
  // 1. HARD CORS GUARD
  if (applyCors(req, res)) return;

  res.status(200).json({
    status: "ok",
    service: "NILA API",
    version: "2.0",
    timestamp: new Date().toISOString()
  });
}
